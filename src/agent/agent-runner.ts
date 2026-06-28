import { SocketClient } from "../events/socket-client";
import { AgentWorker, InteractiveTimeoutError } from "./agent-worker";
import { ClaudeCodeExecutor } from "./claude-executor";
import { InteractiveTerminalOpener } from "./interactive-executor";
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
 *
 * Supports two execution modes:
 *   - "piped" (default): Spawns Claude Code as a child process with stdin pipe.
 *     Used for automated/headless execution.
 *   - "interactive": Opens a new terminal window running Claude Code in full
 *     interactive mode. The user works directly in the terminal. The agent
 *     waits for the user to exit (detected via sentinel file).
 */

export class AgentRunner {
  private repoRoot: string;
  private agentId: string;
  private port: number;
  private host: string;
  private config: LaolConfig;
  private mode: "piped" | "interactive";

  private socketClient: SocketClient | null = null;
  private taskStore: TaskStore;
  private lockManager: LockManager;
  private leaseManager: LeaseManager;
  private worktreePool: WorktreePool;
  private registryManager: RegistryManager;
  private knowledgeStore: KnowledgeStore;
  private claudeExecutor: ClaudeCodeExecutor;
  private interactiveOpener: InteractiveTerminalOpener | null = null;

  private running = false;
  private currentTask: Task | null = null;
  private agentWorker: AgentWorker | null = null;

  // Standalone mode
  private standalone: boolean;
  private standaloneDescription: string | null;
  private standaloneTargetFiles: string[];
  private coordinatePort?: number;
  private coordinationClient: SocketClient | null = null;

  constructor(repoRoot: string, agentId: string, port: number, host = "127.0.0.1", mode?: "piped" | "interactive", standaloneOpts?: {
    standalone?: boolean;
    description?: string;
    targetFiles?: string[];
    coordinatePort?: number;
  }) {
    this.repoRoot = repoRoot;
    this.agentId = agentId;
    this.port = port;
    this.host = host;
    this.config = loadConfig(repoRoot);
    this.mode = mode ?? this.config.agent.mode ?? "piped";

    this.standalone = standaloneOpts?.standalone ?? false;
    this.standaloneDescription = standaloneOpts?.description ?? null;
    this.standaloneTargetFiles = standaloneOpts?.targetFiles ?? [];
    this.coordinatePort = standaloneOpts?.coordinatePort;

    // In standalone mode with --coordinate, create a coordination client
    if (this.standalone && this.coordinatePort) {
      this.coordinationClient = new SocketClient(agentId, this.coordinatePort, "127.0.0.1");
    }

    // Initialize dependencies
    this.taskStore = new TaskStore(repoRoot);
    this.lockManager = new LockManager(repoRoot);
    this.leaseManager = new LeaseManager(this.lockManager);
    this.worktreePool = new WorktreePool(
      repoRoot,
      this.standalone ? 1 : (this.config.agent.worktree_pool_size ?? this.config.scheduler.pool_size)
    );
    this.registryManager = new RegistryManager(repoRoot);
    this.knowledgeStore = new KnowledgeStore(repoRoot);
    this.claudeExecutor = new ClaudeCodeExecutor(this.config.claude_executor);

    // Only connect to scheduler in non-standalone mode
    if (!this.standalone) {
      this.socketClient = new SocketClient(agentId, port, host);
    }

    if (this.mode === "interactive") {
      this.interactiveOpener = new InteractiveTerminalOpener(
        repoRoot, agentId, this.config
      );
    }
  }

  /**
   * Start the agent — connect to scheduler and begin processing tasks.
   */
  async start(): Promise<void> {
    this.running = true;

    // Standalone mode (default): execute session immediately, skip scheduler
    if (this.standalone) {
      await this.executeSession();
      return;
    }

    // In non-standalone mode, socketClient is guaranteed non-null
    const sc = this.socketClient!;

    // Initialize worktree pool
    this.worktreePool.initialize();

    // Wire up socket events
    sc.on("connected", () => {
      console.log(`[runner] Connected to scheduler at ${this.host}:${this.port}`);
    });

    sc.on("disconnected", () => {
      if (this.running) {
        console.log("[runner] Disconnected from scheduler — reconnecting...");
      }
    });

    sc.on("task_assigned", async (msg: SocketMessage) => {
      // Guard: if already handling a task, reject the assignment.
      // The scheduler tracks agent busy state and should not send this,
      // but reconnection edge cases can trigger it.
      if (this.currentTask) {
        console.log(
          `[runner] Already handling task ${this.currentTask.id.slice(0, 8)} — rejecting task_assigned for ${(msg.task_id as string)?.slice(0, 8) ?? "unknown"}`
        );
        return;
      }
      await this.handleTaskAssigned(msg);
    });

    sc.on("task_resume", async (msg: SocketMessage) => {
      // Guard: if already handling a task (e.g. in the middle of an
      // interactive session), don't start another. The scheduler will
      // resend task_resume after the next heartbeat if the task is
      // still in_progress and unassigned.
      if (this.currentTask) {
        console.log(
          `[runner] Already handling task ${this.currentTask.id.slice(0, 8)} — ignoring task_resume for ${(msg.task_id as string)?.slice(0, 8) ?? "unknown"}`
        );
        return;
      }
      await this.handleTaskAssigned(msg);
    });

    sc.on("lock_released", (msg: SocketMessage) => {
      const file = msg.file as string;
      if (file) {
        console.log(`[runner] Lock released: ${file}`);
      }
    });

    sc.on("ping", () => {
      // Respond to scheduler's ping by sending a heartbeat
      sc.sendHeartbeat(
        this.lockManager.listLocks({ holder: this.agentId }).map((l) => l.file)
      );
    });

    sc.on("merge_completed", (msg: SocketMessage) => {
      console.log(`[runner] Merge completed for task ${msg.task_id}`);
    });

    sc.on("lock_granted", (msg: SocketMessage) => {
      const files = msg.files as string[] ?? [];
      console.log(`[runner] Locks granted: ${files.join(", ")}`);
    });

    sc.on("lock_denied", (msg: SocketMessage) => {
      const files = msg.files as string[] ?? [];
      const reason = msg.reason as string ?? "unknown";
      console.log(`[runner] Locks denied for ${files.join(", ")}: ${reason}`);
    });

    sc.on("shutdown", () => {
      this.handleShutdown();
    });

    // Connect to scheduler
    await sc.connect();
  }

  /**
   * Stop the agent gracefully.
   */
  async stop(): Promise<void> {
    this.running = false;
    if (this.socketClient) {
      this.socketClient.disconnect();
    }
    if (this.coordinationClient) {
      this.coordinationClient.disconnect();
    }

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

    // In standalone mode, clean up worktree pool
    if (this.standalone) {
      this.worktreePool.shutdown();
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
    this.socketClient?.disconnect();

    console.log(`[runner] Agent "${this.agentId}" shut down.`);
    process.exit(0);
  }

  // ---- Session (standalone) ----

  /**
   * Execute a standalone session — no scheduler, persistent Claude Code.
   *
   * 1. Creates a minimal session task (persisted as a log record)
   * 2. Initializes worktree pool and acquires a worktree
   * 3. Opens Claude Code (interactive terminal or piped)
   * 4. After exit: commits changes, cleans up, exits process
   */
  private async executeSession(): Promise<void> {
    const description = this.standaloneDescription ?? "Interactive session";

    // 1. Create a minimal session task (log record, not a work assignment)
    const task = this.taskStore.createTask({
      description,
      target_files: this.standaloneTargetFiles,
    });

    this.taskStore.updateTask(task.id, () => ({
      status: "in_progress",
      assigned_agent: this.agentId,
    }));

    const currentTask = this.taskStore.getTask(task.id)!;

    console.log(chalk.bold(`\nLAOL Agent: ${this.agentId}`));
    console.log(`  Session:      ${currentTask.id.slice(0, 8)}`);
    console.log(`  Repo:         ${this.repoRoot}`);
    console.log(`  Mode:         ${this.mode}`);
    if (this.standaloneDescription) {
      console.log(`  Description:  ${currentTask.description}`);
    }
    console.log("");

    if (this.mode === "interactive") {
      console.log(chalk.dim("  A new terminal window will open with Claude Code."));
      console.log(chalk.dim("  Work conversationally. Type /exit when done.\n"));
    }

    // 2. Initialize worktree pool (single worktree for session)
    this.worktreePool.initialize();

    // 2b. Connect to scheduler for lock/file coordination (if --coordinate)
    if (this.coordinationClient) {
      try {
        await this.coordinationClient.connect();
        console.log(chalk.dim(`  Coordinating via scheduler at port ${this.coordinatePort}`));
      } catch (err) {
        console.warn(chalk.yellow(`  Warning: Could not connect to scheduler for coordination: ${err}`));
        this.coordinationClient = null;
      }
    }

    // 3. Build knowledge context (if available)
    const knowledgeHints = this.knowledgeStore.findRelevant(
      currentTask.target_files,
      currentTask.description,
      3
    );
    const knowledgeContext = knowledgeHints.length > 0
      ? this.knowledgeStore.formatContext(knowledgeHints)
      : null;

    // 4. Create AgentWorker with coordinationClient (if coordinating) or null
    let discoveryOutput = "";
    this.agentWorker = new AgentWorker(
      this.repoRoot,
      this.agentId,
      this.taskStore,
      this.lockManager,
      this.leaseManager,
      this.worktreePool,
      this.coordinationClient, // socketClient — for lock/file coordination
      this.registryManager,
      this.knowledgeStore
    );

    this.currentTask = currentTask;

    try {
      await this.agentWorker.executeTask(
        currentTask,
        this.mode === "interactive"
          ? this.createInteractiveExecutor(knowledgeContext)
          : this.createPipedExecutor(knowledgeContext),
        this.createPipedDiscoveryExecutor(
          (output) => { discoveryOutput = output; }
        )
      );

      // Save discovery output as knowledge
      if (discoveryOutput) {
        const updatedTask = this.taskStore.getTask(currentTask.id);
        if (updatedTask && (updatedTask.target_files.length === 0 || updatedTask.metadata?.read_only)) {
          this.knowledgeStore.save({
            task_id: currentTask.id,
            agent_id: this.agentId,
            description: currentTask.description,
            summary: discoveryOutput.slice(0, 500),
            files: [],
            created_at: Date.now(),
          });
        }
      }

      console.log(chalk.green(`\nSession completed.`));
      console.log(chalk.dim(`Session ID: ${currentTask.id.slice(0, 8)}`));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`\nSession failed: ${reason}`));
    } finally {
      // Disconnect coordination client
      if (this.coordinationClient) {
        this.coordinationClient.disconnect();
      }

      this.currentTask = null;
      this.agentWorker = null;
      this.worktreePool.shutdown();
      process.exit(0);
    }
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
      // Set currentTask inside try so a synchronous throw in the block
      // above doesn't permanently block the agent from accepting new tasks.
      this.currentTask = task;

      await this.agentWorker.executeTask(
        task,
        // Main executor — piped or interactive based on mode
        this.mode === "interactive"
          ? this.createInteractiveExecutor(knowledgeContext)
          : this.createPipedExecutor(knowledgeContext),
        // Discovery executor — always piped (fast automated exploration)
        this.createPipedDiscoveryExecutor(
          (output) => { discoveryOutput = output; }
        )
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

  // ---- Executor callbacks ----

  /**
   * Piped executor — spawns Claude Code as a child process with stdin pipe.
   * Used when mode is "piped" (default).
   */
  private createPipedExecutor(knowledgeContext: string | null) {
    return async (worktreePath: string, _task: Task, contextHints: string[]) => {
      const isReadOnly = _task.metadata?.read_only === true;

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

      const modeLabel = isReadOnly ? "Analysis (read-only)" : "Starting Work";
      console.log(chalk.cyan(`\n=== Agent ${modeLabel} ===`));
      console.log(chalk.cyan(`Worktree: ${worktreePath}`));
      console.log(chalk.cyan(`Task:     ${_task.description}`));
      console.log(chalk.cyan(`Files:    ${filesStr}\n`));

      // Execute Claude Code in the isolated worktree
      const result = await this.claudeExecutor.execute(
        worktreePath,
        _task,
        contextHints,
        (chunk) => process.stdout.write(chalk.dim(chunk)),
        isReadOnly
      );

      console.log(chalk.dim(`\n[claude] Duration: ${(result.durationMs / 1000).toFixed(1)}s`));
      console.log(chalk.dim(`[claude] Exit code: ${result.exitCode}`));

      // Save knowledge for future agents (skip for read-only — full output saved as report)
      if (!isReadOnly) {
        this.knowledgeStore.save({
          task_id: _task.id,
          agent_id: this.agentId,
          description: _task.description,
          summary: result.stdout.slice(0, 500) || _task.description,
          files: _task.target_files,
          created_at: Date.now(),
        });
      }

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

      if (isReadOnly) {
        console.log(chalk.blue(`[claude] Analysis completed`));
      } else {
        console.log(chalk.green(`[claude] Task completed successfully`));
      }

      return {
        stdout: result.stdout,
        summary: isReadOnly
          ? `Analyzed: ${_task.description.slice(0, 200)}`
          : result.stdout.slice(0, 500) || _task.description,
      };
    };
  }

  /**
   * Interactive executor — opens a new terminal window running Claude Code
   * in full interactive mode. The user works directly in the terminal.
   * Used when mode is "interactive".
   */
  private createInteractiveExecutor(knowledgeContext: string | null) {
    return async (worktreePath: string, _task: Task, contextHints: string[]) => {
      const isReadOnly = _task.metadata?.read_only === true;

      // Prepend knowledge context
      if (knowledgeContext) {
        contextHints.unshift(`[KNOWLEDGE] ${knowledgeContext}`);
      }

      // Print context hints to agent log
      for (const hint of contextHints) {
        console.log(`[context] ${hint}`);
      }

      const filesStr = _task.target_files.length > 0
        ? _task.target_files.join(", ")
        : "(auto-discovered)";

      const modeLabel = isReadOnly ? "Analysis (read-only)" : "Starting Work";
      console.log(chalk.cyan(`\n=== Opening Interactive Terminal ===`));
      console.log(chalk.cyan(`Worktree: ${worktreePath}`));
      console.log(chalk.cyan(`Task:     ${_task.description}`));
      console.log(chalk.cyan(`File(s):  ${filesStr}`));
      console.log("");
      console.log(chalk.bold(`A new terminal window will open with Claude Code.`));
      console.log(chalk.dim(`Do your work there. Type /exit or press Ctrl+D when done.`));
      console.log(chalk.dim(`Closing the window directly may lose your work.\n`));

      if (!this.interactiveOpener) {
        throw new Error(
          "Interactive mode requested but InteractiveTerminalOpener is not initialized"
        );
      }

      // Open interactive session and wait for the user to exit.
      // runInteractiveSession() handles CLAUDE.md creation internally.
      const result = await this.interactiveOpener.runInteractiveSession(
        worktreePath,
        _task,
        contextHints,
        isReadOnly
      );

      console.log(chalk.dim(`\n[interactive] Duration: ${(result.durationMs / 1000).toFixed(1)}s`));

      if (!result.sentinelRemoved) {
        // User may still be working; task will be marked as stuck by agent-worker.
        // Use InteractiveTimeoutError so failTask() can distinguish timeout from
        // other failures and preserve the worktree for recovery.
        throw new InteractiveTimeoutError(
          `Interactive session timed out after ${this.config.agent.interactive?.terminal_timeout_seconds ?? 7200}s — ` +
          `user may still be working. Task marked as stuck (can be resumed).`
        );
      }

      // Save knowledge for future agents
      if (!isReadOnly) {
        const knowledgeSummary = `Completed in ${(result.durationMs / 1000).toFixed(1)}s: ${_task.description.slice(0, 300)}`;
        this.knowledgeStore.save({
          task_id: _task.id,
          agent_id: this.agentId,
          description: _task.description,
          summary: knowledgeSummary,
          files: _task.target_files,
          created_at: Date.now(),
        });
      }

      if (isReadOnly) {
        console.log(chalk.blue(`[interactive] Analysis session completed`));
      } else {
        console.log(chalk.green(`[interactive] Task session completed`));
      }

      const duration = `${(result.durationMs / 1000).toFixed(1)}s`;
      return {
        stdout: `Interactive session completed in ${duration}`,
        summary: isReadOnly
          ? `Analyzed: ${_task.description.slice(0, 200)}`
          : `Completed in ${duration}: ${_task.description.slice(0, 300)}`,
      };
    };
  }

  /**
   * Piped discovery executor — spawns Claude Code to discover target files.
   * Always uses piped mode (fast automated exploration), regardless of agent mode.
   */
  private createPipedDiscoveryExecutor(onOutput: (output: string) => void) {
    return async (worktreePath: string, _task: Task) => {
      console.log(chalk.yellow(`[discovery] Exploring codebase to determine target files...`));
      const discovery = await this.claudeExecutor.executeDiscovery(
        worktreePath,
        _task,
        (chunk) => process.stdout.write(chalk.dim(`[discovery] ${chunk}`))
      );
      console.log(chalk.yellow(`[discovery] Found ${discovery.files.length} files in ${(discovery.durationMs / 1000).toFixed(1)}s`));
      onOutput(discovery.output);
      return discovery.files;
    };
  }
}
