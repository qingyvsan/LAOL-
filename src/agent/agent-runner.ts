import { SocketClient } from "../events/socket-client";
import { AgentWorker } from "./agent-worker";
import { ClaudeCodeExecutor } from "./claude-executor";
import { TaskStore } from "../task/task-store";
import { LockManager } from "../lock/lock-manager";
import { LeaseManager } from "../lock/lease-manager";
import { WorktreePool } from "../worktree/pool";
import { RegistryManager } from "../registry/registry-manager";
import { KnowledgeStore } from "../knowledge/knowledge-store";
import { loadConfig } from "../config";
import chalk from "chalk";
import type { Task, LaolConfig } from "../data/models";
import type { SocketMessage } from "../events/socket-server";

/**
 * Agent Runner — CLI-facing wrapper that connects an agent to the scheduler.
 *
 * Lifecycle:
 *   1. Connect to scheduler via TCP socket
 *   2. Register as an agent
 *   3. Wait for task_assigned messages
 *   4. Execute each task via AgentWorker
 *   5. Send task_done / task_failed back to scheduler
 *   6. Wait for next task
 */

export class AgentRunner {
  private repoRoot: string;
  private agentId: string;
  private port: number;
  private host: string;
  private config: LaolConfig;

  private socketClient: SocketClient;
  private taskStore: TaskStore;
  private lockManager: LockManager;
  private leaseManager: LeaseManager;
  private worktreePool: WorktreePool;
  private registryManager: RegistryManager;
  private knowledgeStore: KnowledgeStore;
  private claudeExecutor: ClaudeCodeExecutor;

  private running = false;
  private currentTask: Task | null = null;
  private agentWorker: AgentWorker | null = null;

  constructor(repoRoot: string, agentId: string, port: number, host = "127.0.0.1") {
    this.repoRoot = repoRoot;
    this.agentId = agentId;
    this.port = port;
    this.host = host;
    this.config = loadConfig(repoRoot);

    // Initialize dependencies
    this.taskStore = new TaskStore(repoRoot);
    this.lockManager = new LockManager(repoRoot);
    this.leaseManager = new LeaseManager(this.lockManager);
    this.worktreePool = new WorktreePool(repoRoot, this.config.scheduler.pool_size);
    this.registryManager = new RegistryManager(repoRoot);
    this.knowledgeStore = new KnowledgeStore(repoRoot);
    this.claudeExecutor = new ClaudeCodeExecutor(this.config.claude_executor);
    this.socketClient = new SocketClient(agentId, port, host);
  }

  /**
   * Start the agent — connect to scheduler and begin processing tasks.
   */
  async start(): Promise<void> {
    this.running = true;

    // Initialize worktree pool
    this.worktreePool.initialize();

    // Wire up socket events
    this.socketClient.on("connected", () => {
      console.log(`[runner] Connected to scheduler at ${this.host}:${this.port}`);
    });

    this.socketClient.on("disconnected", () => {
      if (this.running) {
        console.log("[runner] Disconnected from scheduler — reconnecting...");
      }
    });

    this.socketClient.on("task_assigned", async (msg: SocketMessage) => {
      await this.handleTaskAssigned(msg);
    });

    this.socketClient.on("task_resume", async (msg: SocketMessage) => {
      await this.handleTaskAssigned(msg);
    });

    this.socketClient.on("lock_released", (msg: SocketMessage) => {
      const file = msg.file as string;
      if (file) {
        console.log(`[runner] Lock released: ${file}`);
      }
    });

    this.socketClient.on("ping", () => {
      // Respond to scheduler's ping by sending a heartbeat
      this.socketClient.sendHeartbeat(
        this.lockManager.listLocks({ holder: this.agentId }).map((l) => l.file)
      );
    });

    this.socketClient.on("merge_completed", (msg: SocketMessage) => {
      console.log(`[runner] Merge completed for task ${msg.task_id}`);
    });

    this.socketClient.on("lock_granted", (msg: SocketMessage) => {
      const files = msg.files as string[] ?? [];
      console.log(`[runner] Locks granted: ${files.join(", ")}`);
    });

    this.socketClient.on("lock_denied", (msg: SocketMessage) => {
      const files = msg.files as string[] ?? [];
      const reason = msg.reason as string ?? "unknown";
      console.log(`[runner] Locks denied for ${files.join(", ")}: ${reason}`);
    });

    this.socketClient.on("shutdown", () => {
      this.handleShutdown();
    });

    // Connect to scheduler
    await this.socketClient.connect();
  }

  /**
   * Stop the agent gracefully.
   */
  async stop(): Promise<void> {
    this.running = false;
    this.socketClient.disconnect();

    // Release any locks still held
    this.lockManager.releaseAllForAgent(this.agentId);

    // Clean up current task if any
    if (this.currentTask) {
      this.taskStore.updateTask(this.currentTask.id, () => ({
        status: "pending",
        assigned_agent: null,
        metadata: { agent_stopped_at: Date.now() },
      }));
    }
  }

  /**
   * Handle a shutdown signal from the scheduler.
   * Mark the current task as pending, release locks, clean worktrees, and exit.
   */
  private async handleShutdown(): Promise<void> {
    console.log(`[runner] Shutdown received — stopping agent "${this.agentId}" gracefully...`);

    this.running = false;

    // Mark current task as pending (so it can be picked up later)
    if (this.currentTask) {
      this.taskStore.updateTask(this.currentTask.id, () => ({
        status: "pending",
        assigned_agent: null,
        metadata: { agent_stopped_at: Date.now() },
      }));
    }

    // Release all held locks
    this.lockManager.releaseAllForAgent(this.agentId);

    // Clean up and remove all worktree directories
    this.worktreePool.shutdown();

    // Disconnect from scheduler
    this.socketClient.disconnect();

    console.log(`[runner] Agent "${this.agentId}" shut down.`);
    process.exit(0);
  }

  // ---- Task handling ----

  private async handleTaskAssigned(msg: SocketMessage): Promise<void> {
    const taskId = msg.task_id as string;
    if (!taskId) return;

    const task = this.taskStore.getTask(taskId);
    if (!task || task.status !== "in_progress") {
      console.log(`[runner] Task ${taskId.slice(0, 8)} is not in_progress — skipping`);
      return;
    }

    this.currentTask = task;

    console.log(`\n${"=".repeat(60)}`);
    console.log(`[runner] Assigned task: ${taskId.slice(0, 8)}`);
    console.log(`  Description: ${task.description}`);
    console.log(`  Files:       ${task.target_files.join(", ")}`);
    console.log(`${"=".repeat(60)}\n`);

    // Query shared knowledge for context hints
    const knowledgeHints = this.knowledgeStore.findRelevant(
      task.target_files,
      task.description,
      3
    );
    const knowledgeContext = this.knowledgeStore.formatContext(knowledgeHints);

    // Capture discovery output for knowledge sharing
    let discoveryOutput = "";

    // Create agent worker for this task
    this.agentWorker = new AgentWorker(
      this.repoRoot,
      this.agentId,
      this.taskStore,
      this.lockManager,
      this.leaseManager,
      this.worktreePool,
      this.socketClient,
      this.registryManager,
      this.knowledgeStore
    );

    try {
      await this.agentWorker.executeTask(
        task,
        // Main executor: spawn Claude Code for the actual work
        async (worktreePath, _task, contextHints) => {
          // Print context hints
          if (knowledgeContext) {
            console.log(chalk.magenta(`[knowledge] ${knowledgeContext}`));
            contextHints.unshift(knowledgeContext);
          }
          for (const hint of contextHints) {
            console.log(`[context] ${hint}`);
          }

          const filesStr = _task.target_files.length > 0
            ? _task.target_files.join(", ")
            : "(auto-discovered)";

          console.log(chalk.cyan(`\n=== Agent Starting Work ===`));
          console.log(chalk.cyan(`Worktree: ${worktreePath}`));
          console.log(chalk.cyan(`Task:     ${_task.description}`));
          console.log(chalk.cyan(`Files:    ${filesStr}\n`));

          // Execute Claude Code in the isolated worktree
          const result = await this.claudeExecutor.execute(
            worktreePath,
            _task,
            contextHints,
            (chunk) => process.stdout.write(chalk.dim(chunk))
          );

          console.log(chalk.dim(`\n[claude] Duration: ${(result.durationMs / 1000).toFixed(1)}s`));
          console.log(chalk.dim(`[claude] Exit code: ${result.exitCode}`));

          // Save knowledge for future agents
          this.knowledgeStore.save({
            task_id: _task.id,
            agent_id: this.agentId,
            description: _task.description,
            summary: result.stdout.slice(0, 500) || _task.description,
            files: _task.target_files,
            created_at: Date.now(),
          });

          if (!result.success) {
            if (result.timedOut) {
              throw new Error(
                `Claude Code timed out after ${this.config.claude_executor.timeout_seconds}s`
              );
            }
            throw new Error(
              `Claude Code exited with code ${result.exitCode}: ${result.stderr.slice(0, 500)}`
            );
          }

          console.log(chalk.green(`[claude] Task completed successfully`));
        },
        // Discovery executor: spawn Claude Code to discover target files
        async (worktreePath, _task) => {
          console.log(chalk.yellow(`[discovery] Exploring codebase to determine target files...`));
          const discovery = await this.claudeExecutor.executeDiscovery(
            worktreePath,
            _task,
            (chunk) => process.stdout.write(chalk.dim(`[discovery] ${chunk}`))
          );
          console.log(chalk.yellow(`[discovery] Found ${discovery.files.length} files in ${(discovery.durationMs / 1000).toFixed(1)}s`));
          discoveryOutput = discovery.output;
          return discovery.files;
        }
      );

      // If it was a read-only task (no target files after execution),
      // save the discovery output as shared knowledge.
      if (discoveryOutput) {
        const updatedTask = this.taskStore.getTask(taskId);
        if (updatedTask && (updatedTask.target_files.length === 0 || updatedTask.metadata?.read_only)) {
          this.knowledgeStore.save({
            task_id: task.id,
            agent_id: this.agentId,
            description: task.description,
            summary: discoveryOutput.slice(0, 500),
            files: [],
            created_at: Date.now(),
          });
        }
      }
    } catch (err) {
      console.error(`[runner] Task failed: ${err}`);
    }

    this.currentTask = null;
    this.agentWorker = null;
  }
}
