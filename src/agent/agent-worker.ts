import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { TaskStore } from "../task/task-store";
import { LockManager } from "../lock/lock-manager";
import { LeaseManager } from "../lock/lease-manager";
import { WorktreePool } from "../worktree/pool";
import { Heartbeat } from "./heartbeat";
import { Checkpoint, RebaseConflictError } from "./checkpoint";
import { SocketClient } from "../events/socket-client";
import { RegistryManager } from "../registry/registry-manager";
import { KnowledgeStore } from "../knowledge/knowledge-store";
import { ContextManager } from "../context/manager";
import { CodebaseIndexer } from "../codebase/indexer";
import { loadConfig } from "../config";
import type { Task, LaolConfig } from "../data/models";

/**
 * Error thrown when an interactive terminal session times out.
 * Distinct from general failures — caught by failTask() to mark the
 * task as "stuck" (recoverable) instead of "failed" (terminal).
 */
export class InteractiveTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InteractiveTimeoutError";
  }
}

/**
 * Agent Worker — manages the full lifecycle of a single task execution.
 *
 * Sequence:
 *   1. Load task
 *   2. Start heartbeat
 *   3. Start perception watcher
 *   4. Acquire worktree from pool
 *   5. Check for semantic warnings → inject into context
 *   6. Execute work loop (checkpoint → perceive → LLM call → repeat)
 *   7. Commit changes
 *   8. Push branch
 *   9. Release locks
 *   10. Release worktree
 *   11. Update task status
 *   12. Stop heartbeat
 *   13. Notify scheduler
 *
 * The agent worker sets up the environment and manages state transitions.
 * The actual LLM interaction happens via external CLI (Claude Code).
 */

export class AgentWorker {
  private repoRoot: string;
  private agentId: string;
  private config: LaolConfig;

  // Dependencies
  private taskStore: TaskStore;
  private lockManager: LockManager;
  private leaseManager: LeaseManager;
  private worktreePool: WorktreePool;
  private socketClient: SocketClient;
  private registryManager: RegistryManager;
  private knowledgeStore: KnowledgeStore;
  private contextManager: ContextManager;

  // Per-task state
  private currentTask: Task | null = null;
  private heartbeat: Heartbeat;
  private checkpoint: Checkpoint | null = null;
  private interactiveTimeout = false;

  // Getter for heartbeat to access current lock files
  private activeLockFiles: string[] = [];

  constructor(
    repoRoot: string,
    agentId: string,
    taskStore: TaskStore,
    lockManager: LockManager,
    leaseManager: LeaseManager,
    worktreePool: WorktreePool,
    socketClient: SocketClient,
    registryManager: RegistryManager,
    knowledgeStore: KnowledgeStore
  ) {
    this.repoRoot = repoRoot;
    this.agentId = agentId;
    this.config = loadConfig(repoRoot);

    this.taskStore = taskStore;
    this.lockManager = lockManager;
    this.leaseManager = leaseManager;
    this.worktreePool = worktreePool;
    this.socketClient = socketClient;
    this.registryManager = registryManager;
    this.knowledgeStore = knowledgeStore;
    this.contextManager = new ContextManager(repoRoot, this.config);

    this.heartbeat = new Heartbeat(lockManager, leaseManager, agentId);
  }

  /**
   * Execute a task assigned to this agent.
   *
   * This method sets up the full environment, then the actual AI work
   * happens in the provided executor callback (which spawns Claude Code
   * or another LLM tool).
   *
   * @param task - The task to execute
   * @param executor - Callback that performs the actual AI work.
   *   Receives the worktree path and returns stdout for report saving.
   * @param discoveryExecutor - Optional callback for file discovery when
   *   target_files is empty. Returns discovered file paths.
   */
  async executeTask(
    task: Task,
    executor: (worktreePath: string, task: Task, contextHints: string[]) => Promise<{ stdout: string }>,
    discoveryExecutor?: (worktreePath: string, task: Task) => Promise<string[]>
  ): Promise<void> {
    this.currentTask = task;
    const taskId = task.id;

    try {
      // 1. Validate task state
      if (task.status !== "in_progress") {
        throw new Error(`Task ${taskId} is not in_progress (current: ${task.status})`);
      }

      // 2. Acquire worktree (inherit predecessor's branch if dependency exists)
      const baseBranch = this.resolveBaseBranch(task);
      console.log(`[agent ${this.agentId}] Acquiring worktree for task ${taskId.slice(0, 8)} (base: ${baseBranch})...`);
      const handle = this.worktreePool.acquire(taskId, baseBranch);

      // 3. Setup checkpoint
      this.checkpoint = new Checkpoint(
        handle.path,
        taskId,
        "main",
        this.config.agent.checkpoint_min_interval_ms
      );

      // 4. Read-only path — analysis/report tasks that don't modify files
      if (task.metadata?.read_only) {
        await this.executeReadOnlyTask(task, handle.path, executor);
        return;
      }

      // 6. Discovery phase — if target_files is empty, discover files first
      if (task.target_files.length === 0 && discoveryExecutor) {
        console.log(`[agent ${this.agentId}] Entering discovery phase for task ${taskId.slice(0, 8)}...`);
        const discoveredFiles = await discoveryExecutor(handle.path, task);

        if (discoveredFiles.length === 0) {
          // Read-only task: the exploration itself was the work.
          // No files need modification — mark done immediately.
          console.log(`[agent ${this.agentId}] Read-only task — no files to modify.`);
          this.completeReadOnlyTask(taskId, handle.path);
          return;
        }

        console.log(`[agent ${this.agentId}] Discovered ${discoveredFiles.length} files: ${discoveredFiles.join(", ")}`);

        // Request locks for discovered files
        const grantedFiles = await this.socketClient.requestLocksAsync(taskId, discoveredFiles);
        console.log(`[agent ${this.agentId}] Locks granted for: ${grantedFiles.join(", ")}`);

        this.activeLockFiles = grantedFiles;
        // Update task with discovered files
        task = { ...task, target_files: grantedFiles };
      } else if (task.target_files.length === 0) {
        // No target files and no discovery executor — read-only by definition
        console.log(`[agent ${this.agentId}] Read-only task (no target files, no discovery) — completing.`);
        this.completeReadOnlyTask(taskId, handle.path);
        return;
      } else {
        this.activeLockFiles = task.target_files.map((f) => f); // copy
      }

      // 7. Start heartbeat (now that we have locks)
      this.heartbeat.start(() => this.activeLockFiles);

      // 8. Collect context hints from live providers
      const contextHints: string[] = [];

      const { hints: liveHints, preStates } = await this.contextManager.collectPreHints(
        task,
        handle.path
      );
      contextHints.push(...liveHints.map((h) => ContextManager.formatHint(h)));

      // 10. Pre-work checkpoint (structural — rebase before editing)
      try {
        const result = this.checkpoint.checkAndRebase();
        if (result.updated && result.message) {
          contextHints.push(`[CHECKPOINT] ${result.message}`);
        }
      } catch (err) {
        if (err instanceof RebaseConflictError) {
          this.failTask(taskId, err.message);
          return;
        }
        throw err;
      }

      // 10b. Predecessor context — what the dependency task did (structural)
      const predecessorHint = this.buildPredecessorHint(task);
      if (predecessorHint) {
        contextHints.push(predecessorHint);
      }

      // 11. Execute the actual AI work
      console.log(`[agent ${this.agentId}] Starting work on task ${taskId.slice(0, 8)}`);
      await executor(handle.path, task, contextHints);

      // 11b. Collect post-task deltas from live providers
      const { deltas } = await this.contextManager.collectPostHints(
        task,
        handle.path,
        preStates
      );
      // Write deltas to knowledge store for other agents
      if (deltas.length > 0) {
        this.knowledgeStore.save({
          task_id: taskId,
          agent_id: this.agentId,
          description: `Post-task provider deltas for task ${taskId.slice(0, 8)}`,
          summary: `Provider deltas: ${deltas
            .map((d) => `${d.source}(errors: ${d.before.errors}→${d.after.errors})`)
            .join(", ")}`,
          files: this.activeLockFiles,
          created_at: Date.now(),
        });
      }

      // 12. Commit changes
      this.commitChanges(handle.path, task);

      // 12b. Re-index modified files so the shared symbol index stays fresh
      if (this.config.codebase_indexer?.auto_index) {
        try {
          const indexer = new CodebaseIndexer(this.repoRoot);
          indexer.reindexFiles(this.activeLockFiles, handle.path);
        } catch (err) {
          // Non-fatal: index rebuild failure must not block task completion
          console.warn(
            `[agent ${this.agentId}] Index rebuild warning: ${err}`
          );
        }
      }

      // 13. Push branch
      this.pushBranch(handle.path, task);

      // 14. Update registry for modified files
      for (const file of this.activeLockFiles) {
        this.registryManager.updateEntry(
          file,
          this.agentId,
          path.join(handle.path, file)
        );
      }

      // 15. Complete task
      this.completeTask(taskId);

    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[agent ${this.agentId}] Task ${taskId.slice(0, 8)} failed: ${reason}`);
      this.failTask(taskId, reason, err);
    } finally {
      // Cleanup regardless of outcome
      this.cleanup(taskId);
    }
  }

  /**
   * Expand the set of locked files during execution (dynamic lock expansion).
   * Called when the agent discovers it needs additional files mid-task.
   */
  async expandLocks(files: string[]): Promise<string[]> {
    if (!this.currentTask) {
      throw new Error("No active task");
    }

    // Filter out already-held files
    const newFiles = files.filter((f) => !this.activeLockFiles.includes(f));
    if (newFiles.length === 0) return [];

    const grantedFiles = await this.socketClient.requestLocksAsync(
      this.currentTask.id,
      newFiles
    );

    this.activeLockFiles.push(...grantedFiles);
    return grantedFiles;
  }

  // ---- Lifecycle ----

  private commitChanges(worktreePath: string, task: Task): void {
    try {
      execSync("git add -A", {
        cwd: worktreePath,
        stdio: "pipe",
        timeout: 10_000,
      });

      // Check if there's anything to commit
      const status = execSync("git status --porcelain", {
        cwd: worktreePath,
        stdio: "pipe",
        timeout: 5000,
      }).toString().trim();

      if (!status) {
        console.log(`[agent ${this.agentId}] No changes to commit`);
        return;
      }

      // Pipe commit message via stdin to avoid shell injection
      // from task descriptions containing quotes, backticks, or $().
      execSync(`git commit -F -`, {
        cwd: worktreePath,
        stdio: "pipe",
        timeout: 10_000,
        input: `Task: ${task.description.slice(0, 72)}`,
      });

      console.log(`[agent ${this.agentId}] Changes committed`);
    } catch (err) {
      console.warn(`[agent ${this.agentId}] Commit warning: ${err}`);
    }
  }

  private pushBranch(worktreePath: string, task: Task): void {
    try {
      const branch = `agent/${task.id}`;
      execSync(`git push origin ${branch}`, {
        cwd: worktreePath,
        stdio: "pipe",
        timeout: 30_000,
      });
      console.log(`[agent ${this.agentId}] Branch pushed: ${branch}`);
    } catch (err) {
      console.warn(`[agent ${this.agentId}] Push warning (will merge locally): ${err}`);
    }
  }

  private completeTask(taskId: string): void {
    // Release locks
    for (const file of this.activeLockFiles) {
      this.lockManager.release(file);
    }

    // Update task status
    this.taskStore.updateTask(taskId, () => ({
      status: "done",
      updated_at: Date.now(),
    }));

    // Notify scheduler
    this.socketClient.notifyTaskDone(taskId);
    console.log(`[agent ${this.agentId}] Task ${taskId.slice(0, 8)} DONE`);
  }

  /**
   * Execute a read-only analysis/report task.
   *
   * Skips locks, heartbeat, perception, commit, push, and registry update.
   * Saves Claude Code stdout to .multiagent/reports/{taskId}.md for later
   * retrieval by the user via `laol task show <id>`.
   */
  private async executeReadOnlyTask(
    task: Task,
    worktreePath: string,
    executor: (worktreePath: string, task: Task, contextHints: string[]) => Promise<{ stdout: string }>
  ): Promise<void> {
    const taskId = task.id;

    console.log(`[agent ${this.agentId}] Read-only task ${taskId.slice(0, 8)} — analysis/report mode`);

    // Collect context hints from live providers
    const contextHints: string[] = [
      "[MODE] This is a READ-ONLY analysis task. Do NOT modify any files. " +
      "Explore the codebase, analyze, and report your findings. " +
      "Your entire response will be saved and shown to the user as a report.",
    ];

    const { hints: liveHints } = await this.contextManager.collectPreHints(
      task,
      worktreePath
    );
    contextHints.push(...liveHints.map((h) => ContextManager.formatHint(h)));

    // Pre-work checkpoint (rebase to get latest code for analysis)
    try {
      const result = this.checkpoint!.checkAndRebase();
      if (result.updated && result.message) {
        contextHints.push(`[CHECKPOINT] ${result.message}`);
      }
    } catch (err) {
      if (err instanceof RebaseConflictError) {
        this.failTask(taskId, err.message);
        return;
      }
      throw err;
    }

    // Predecessor context — what the dependency task did
    const predecessorHint = this.buildPredecessorHint(task);
    if (predecessorHint) {
      contextHints.push(predecessorHint);
    }

    // Execute the AI analysis
    console.log(`[agent ${this.agentId}] Starting read-only analysis for task ${taskId.slice(0, 8)}`);
    const { stdout } = await executor(worktreePath, task, contextHints);

    // Save the report
    this.saveReport(taskId, stdout);

    // Complete with read_only metadata
    this.taskStore.updateTask(taskId, () => ({
      status: "done",
      updated_at: Date.now(),
      metadata: { read_only: true },
    }));

    this.socketClient.notifyTaskDone(taskId);
    console.log(`[agent ${this.agentId}] Task ${taskId.slice(0, 8)} DONE (read-only)`);
  }

  /**
   * Save Claude Code stdout as a markdown report.
   */
  private saveReport(taskId: string, stdout: string): void {
    const reportsDir = path.join(this.repoRoot, ".multiagent", "reports");
    if (!fs.existsSync(reportsDir)) {
      fs.mkdirSync(reportsDir, { recursive: true });
    }
    const reportPath = path.join(reportsDir, `${taskId}.md`);
    fs.writeFileSync(reportPath, stdout, "utf-8");
    console.log(`[agent ${this.agentId}] Report saved: .multiagent/reports/${taskId}.md`);
  }

  /**
   * Complete a read-only task that requires no file modifications.
   * The discovery/exploration phase was the work itself.
   */
  private completeReadOnlyTask(taskId: string, worktreePath: string): void {
    // No locks to release, no changes to commit.
    // Just update task status and notify the scheduler.

    this.taskStore.updateTask(taskId, () => ({
      status: "done",
      updated_at: Date.now(),
      metadata: { read_only: true },
    }));

    this.socketClient.notifyTaskDone(taskId);
    console.log(`[agent ${this.agentId}] Task ${taskId.slice(0, 8)} DONE (read-only)`);
  }

  private failTask(taskId: string, reason: string, error?: unknown): void {
    // Interactive timeout: mark as stuck instead of failed so the user can resume.
    // Keep locks and worktree intact — changes are preserved in the agent branch.
    if (error instanceof InteractiveTimeoutError) {
      this.interactiveTimeout = true;

      // Mark as stuck with worktree info for recovery
      this.taskStore.updateTask(taskId, () => ({
        status: "stuck",
        metadata: {
          failure_reason: reason,
          _interactive_timeout: true,
          _worktree_branch: `agent/${taskId}`,
          _agent_id: this.agentId,
        },
      }));

      // Notify scheduler (task is stuck, not failed — dependency cascade is blocked)
      this.socketClient.notifyTaskFailed(taskId, `Interactive timeout: ${reason}`);
      return;
    }

    // Release locks
    for (const file of this.activeLockFiles) {
      this.lockManager.release(file);
    }

    // Update task status
    this.taskStore.updateTask(taskId, () => ({
      status: "failed",
      metadata: { failure_reason: reason },
    }));

    // Notify scheduler
    this.socketClient.notifyTaskFailed(taskId, reason);
  }

  private cleanup(taskId: string): void {
    // Stop heartbeat
    this.heartbeat.stop();

    // For interactive timeout: keep the worktree so the user can resume.
    // The worktree branch has the in-progress changes; releasing it would
    // reset them and lose work.
    if (this.interactiveTimeout) {
      console.log(
        `[agent ${this.agentId}] Interactive session timed out — ` +
        `preserving worktree and locks for recovery.`
      );
      this.interactiveTimeout = false;
      this.activeLockFiles = [];
      this.currentTask = null;
      this.checkpoint = null;
      return;
    }

    // Release worktree
    this.worktreePool.release(taskId);

    this.activeLockFiles = [];
    this.currentTask = null;
    this.checkpoint = null;
  }

  // ---- Dependency chain support ----

  /**
   * Resolve the base branch for a task's worktree.
   *
   * If the task has a dependency, use the predecessor's agent branch so
   * the new worktree inherits all prior code changes. Falls back to main
   * if the predecessor's branch doesn't exist (e.g. read-only task, push
   * failure, or branch not yet replicated).
   */
  private resolveBaseBranch(task: Task): string {
    if (!task.dependency) return "main";

    const branch = `agent/${task.dependency}`;

    // Check remote first (agent pushes to origin on completion)
    try {
      execSync(`git rev-parse --verify origin/${branch}`, {
        cwd: this.repoRoot,
        stdio: "pipe",
        timeout: 5000,
      });
      return branch;
    } catch { /* not on remote */ }

    // Check local (same-agent continuation, branch may not be pushed yet)
    try {
      execSync(`git rev-parse --verify ${branch}`, {
        cwd: this.repoRoot,
        stdio: "pipe",
        timeout: 5000,
      });
      return branch;
    } catch { /* not local either */ }

    console.log(`[agent ${this.agentId}] Predecessor branch ${branch} not found, falling back to main`);
    return "main";
  }

  /**
   * Build a [PREDECESSOR] context hint describing the dependency task.
   *
   * Injects the predecessor's description, modified files, and summary
   * so the agent understands why the code is already in its current state.
   */
  private buildPredecessorHint(task: Task): string | null {
    if (!task.dependency) return null;

    const depTask = this.taskStore.getTask(task.dependency);
    if (!depTask) return null;

    const depKnowledge = this.knowledgeStore
      .loadAll()
      .filter((k) => k.task_id === task.dependency);

    const lines: string[] = [];
    lines.push(`[PREDECESSOR] This task continues from Task ${task.dependency.slice(0, 8)}`);
    lines.push(`  Description: ${depTask.description}`);
    lines.push(`  Files: ${depTask.target_files.join(", ") || "(none)"}`);
    lines.push(`  Status:  ${depTask.status}`);
    lines.push(`  Your worktree already contains all code changes from the predecessor.`);
    lines.push(`  Build on top of it — do NOT re-implement or revert existing changes.`);

    if (depKnowledge.length > 0 && depKnowledge[0].summary) {
      lines.push(`  Summary: ${depKnowledge[0].summary.slice(0, 300)}`);
    }

    return lines.join("\n");
  }
}
