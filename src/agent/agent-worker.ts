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
import { propagateFile } from "./file-propagator";
import { notifyKnowledgeUpdated } from "./notification-writer";
import { ChangeJournalClient } from "../journal/change-journal-client";
import { loadConfig } from "../config";
import type { Task, LaolConfig, ContextHint } from "../data/models";

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
  private socketClient: SocketClient | null;
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

  // Socket event handlers (for coordination mode — cleaned up in cleanup())
  private socketHandlers: Map<string, (msg: import("../events/socket-server").SocketMessage) => void> = new Map();

  constructor(
    repoRoot: string,
    agentId: string,
    taskStore: TaskStore,
    lockManager: LockManager,
    leaseManager: LeaseManager,
    worktreePool: WorktreePool,
    socketClient: SocketClient | null,
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
    executor: (worktreePath: string, task: Task, contextHints: string[]) => Promise<{ stdout: string; summary?: string }>,
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

      // 2b. Set up socket event listeners (coordination mode)
      if (this.socketClient) {
        // file_propagate — copy latest file version from another agent's worktree
        const onFilePropagate = (msg: import("../events/socket-server").SocketMessage) => {
          const file = msg.file as string;
          const sourceWorktree = msg.source_worktree as string;
          if (file && sourceWorktree) {
            const ok = propagateFile(sourceWorktree, handle.path, file);
            if (ok) {
              console.log(`[agent ${this.agentId}] Propagated file: ${file}`);
            }
          }
        };
        this.socketClient.on("file_propagate", onFilePropagate);
        this.socketHandlers.set("file_propagate", onFilePropagate);

        // knowledge_updated — another agent shared new knowledge (push — global value)
        const onKnowledgeUpdated = (msg: import("../events/socket-server").SocketMessage) => {
          const sourceAgent = msg.agent_id as string;
          const summary = msg.summary as string;
          if (sourceAgent && sourceAgent !== this.agentId && summary) {
            notifyKnowledgeUpdated(handle.path, sourceAgent, summary);
            console.log(`[agent ${this.agentId}] Knowledge updated: ${sourceAgent}`);
          }
        };
        this.socketClient.on("knowledge_updated", onKnowledgeUpdated);
        this.socketHandlers.set("knowledge_updated", onKnowledgeUpdated);
      }

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
      // Skip discovery in standalone mode with no target files — the user
      // wants an open-ended interactive session.
      if (task.target_files.length === 0 && discoveryExecutor) {
        console.log(`[agent ${this.agentId}] Entering discovery phase for task ${taskId.slice(0, 8)}...`);
        const discoveredFiles = await discoveryExecutor(handle.path, task);

        if (discoveredFiles.length === 0) {
          // No files discovered. In standalone mode without a socket client,
          // proceed to the main executor so the user gets an open-ended
          // interactive session. In scheduled mode, complete as read-only.
          if (!this.socketClient) {
            console.log(`[agent ${this.agentId}] No files discovered — opening open-ended session.`);
            this.activeLockFiles = [];
            // fall through to main executor below
          } else {
            console.log(`[agent ${this.agentId}] Read-only task — no files to modify.`);
            this.completeReadOnlyTask(taskId, handle.path);
            return;
          }
        } else {
          console.log(`[agent ${this.agentId}] Discovered ${discoveredFiles.length} files: ${discoveredFiles.join(", ")}`);
          // Request locks for discovered files (or grant all in standalone mode)
          const grantedFiles = this.socketClient
            ? await this.socketClient.requestLocksAsync(taskId, discoveredFiles)
            : discoveredFiles;
          console.log(`[agent ${this.agentId}] Locks granted for: ${grantedFiles.join(", ")}`);

          this.activeLockFiles = grantedFiles;
          // Update task with discovered files
          task = { ...task, target_files: grantedFiles };
        }
      } else if (task.target_files.length === 0) {
        // No target files and no discovery executor.
        // In standalone mode, proceed to open-ended session.
        if (!this.socketClient) {
          console.log(`[agent ${this.agentId}] No target files — opening open-ended session.`);
          this.activeLockFiles = [];
          // fall through to main executor below
        } else {
          console.log(`[agent ${this.agentId}] Read-only task (no target files, no discovery) — completing.`);
          this.completeReadOnlyTask(taskId, handle.path);
          return;
        }
      } else {
        this.activeLockFiles = task.target_files.map((f) => f); // copy
      }

      // 7. Start heartbeat (now that we have locks) — only when connected to scheduler
      if (this.socketClient) {
        this.heartbeat.start(() => this.activeLockFiles);
      }

      // 7b. Query ChangeJournal for recent changes relevant to target files
      if (this.socketClient) {
        try {
          const journalClient = new ChangeJournalClient(this.socketClient);
          const journalEntries = await journalClient.queryJournal(task.target_files);
          journalClient.writeLocalJournal(handle.path, journalEntries);
          console.log(
            `[agent ${this.agentId}] Journal queried: ${journalEntries.length} entries`
          );
        } catch (err) {
          // Non-fatal — journal query failure must not block task execution
          console.warn(`[agent ${this.agentId}] Journal query warning: ${err}`);
        }
      }

      // 8. Collect context hints from live providers
      const contextHints: string[] = [];

      const { hints: liveHints, preStates } = await this.contextManager.collectPreHints(
        task,
        handle.path
      );
      const criticalHints = this.prepareDiagnostics(handle.path, liveHints);
      contextHints.push(...criticalHints);

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
      const execResult = await executor(handle.path, task, contextHints);

      // 11b. Post-execution lock validation — detect files modified without locks
      const modifiedFiles = this.getModifiedFiles(handle.path);
      const unownedFiles = modifiedFiles.filter((f) => !this.activeLockFiles.includes(f));

      if (unownedFiles.length > 0) {
        console.log(
          `[agent ${this.agentId}] Detected ${unownedFiles.length} modified files without locks: ${unownedFiles.join(", ")}`
        );

        try {
          const granted = await this.expandLocks(unownedFiles);
          const denied = unownedFiles.filter((f) => !granted.includes(f));

          if (denied.length > 0) {
            // Revert changes to files we couldn't lock
            for (const file of denied) {
              this.revertFile(handle.path, file);
            }

            const warning =
              `[WARNING] Modified files could not be locked (held by other agents). ` +
              `Changes were REVERTED: ${denied.join(", ")}. ` +
              `Create a follow-up task targeting these files if changes are needed.`;
            console.warn(`[agent ${this.agentId}] ${warning}`);

            // Store warning in task metadata for the user to see
            this.taskStore.updateTask(taskId, (t) => ({
              metadata: {
                ...t.metadata,
                reverted_files: denied,
                reverted_files_warning: warning,
              },
            }));
          }
        } catch (err) {
          // expandLocks failed entirely — revert all unowned changes
          console.warn(
            `[agent ${this.agentId}] Lock expansion failed: ${err}. Reverting all unowned changes.`
          );
          for (const file of unownedFiles) {
            this.revertFile(handle.path, file);
          }
        }
      }

      // 11c. Collect post-task deltas from live providers
      const { deltas } = await this.contextManager.collectPostHints(
        task,
        handle.path,
        preStates
      );
      // Write deltas to knowledge store for other agents
      if (deltas.length > 0) {
        this.knowledgeStore.saveDelta({
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

      // 12. Pre-commit rebase — ensure worktree is up to date with origin/main
      const conflictFiles = this.preCommitRebase(handle.path);
      if (conflictFiles.length > 0) {
        const msg =
          `Pre-commit rebase conflict: another agent modified ${conflictFiles.join(", ")} ` +
          `while this task was running. The changes cannot be cleanly applied. ` +
          `Create a new task targeting these files with the updated base.`;
        this.failTask(taskId, msg);
        return;
      }

      // 13. Commit changes
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

      // 13b. Report modified files to scheduler (fine-grained lock release).
      // Must be AFTER commit+push so the propagated version is final.
      if (this.socketClient && modifiedFiles.length > 0) {
        this.socketClient.notifyFilesModified(modifiedFiles, handle.path);
        console.log(
          `[agent ${this.agentId}] Reported ${modifiedFiles.length} modified file(s) to scheduler`
        );
      }

      // 14. Update registry for modified files
      for (const file of this.activeLockFiles) {
        this.registryManager.updateEntry(
          file,
          this.agentId,
          path.join(handle.path, file)
        );
      }

      // 15. Complete task
      this.completeTask(taskId, execResult?.summary);

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

    const grantedFiles = this.socketClient
      ? await this.socketClient.requestLocksAsync(this.currentTask.id, newFiles, { skipPropagation: true })
      : newFiles;

    this.activeLockFiles.push(...grantedFiles);
    return grantedFiles;
  }

  // ---- Lifecycle ----

  /**
   * Get the list of files modified by the executor in the worktree.
   * Uses git diff to detect changes from HEAD.
   */
  private getModifiedFiles(worktreePath: string): string[] {
    try {
      const output = execSync("git diff --name-only HEAD", {
        cwd: worktreePath,
        stdio: "pipe",
        timeout: 5000,
      }).toString().trim();

      if (!output) return [];
      return output.split("\n").filter((f) => f.length > 0);
    } catch (err) {
      console.warn(`[agent ${this.agentId}] Failed to detect modified files: ${err}`);
      return [];
    }
  }

  /**
   * Revert changes to a specific file in the worktree.
   */
  private revertFile(worktreePath: string, file: string): void {
    try {
      execSync(`git checkout -- "${file}"`, {
        cwd: worktreePath,
        stdio: "pipe",
        timeout: 5000,
      });
      console.log(`[agent ${this.agentId}] Reverted un-lockable file: ${file}`);
    } catch (err) {
      console.warn(`[agent ${this.agentId}] Failed to revert "${file}": ${err}`);
    }
  }

  /**
   * Get files that conflicted during a rebase attempt.
   */
  private getRebaseConflictFiles(worktreePath: string): string[] {
    try {
      const output = execSync("git diff --name-only --diff-filter=U", {
        cwd: worktreePath,
        stdio: "pipe",
        timeout: 5000,
      }).toString().trim();
      return output ? output.split("\n") : ["<unknown conflict files>"];
    } catch {
      return ["<unknown conflict files>"];
    }
  }

  /**
   * Pre-commit rebase: stash changes, fetch latest main, rebase, pop stash.
   * Returns an array of conflicted file paths, or empty if successful.
   */
  private preCommitRebase(worktreePath: string): string[] {
    let hadStash = false;
    try {
      // 1. Stash any uncommitted changes
      const stashOutput = execSync('git stash push -m "laol-pre-commit-rebase"', {
        cwd: worktreePath,
        stdio: "pipe",
        timeout: 5000,
      }).toString().trim();

      hadStash = !stashOutput.includes("No local changes to save");

      // 2. Fetch latest
      execSync("git fetch origin main", {
        cwd: worktreePath,
        stdio: "pipe",
        timeout: 15_000,
      });

      // 3. Check if behind origin/main
      let behindCount = 0;
      try {
        const result = execSync("git rev-list --count HEAD..origin/main", {
          cwd: worktreePath,
          stdio: "pipe",
          timeout: 5000,
        }).toString().trim();
        behindCount = parseInt(result, 10) || 0;
      } catch {
        behindCount = 0;
      }

      if (behindCount === 0) {
        // Not behind — restore stash if we had one
        if (hadStash) {
          execSync("git stash pop", { cwd: worktreePath, stdio: "pipe", timeout: 5000 });
        }
        return [];
      }

      console.log(`[agent ${this.agentId}] Pre-commit: ${behindCount} commits behind — rebasing...`);

      // 4. Rebase
      try {
        execSync("git rebase origin/main", {
          cwd: worktreePath,
          stdio: "pipe",
          timeout: 30_000,
        });
      } catch {
        // Rebase conflict — abort and return conflicted files
        execSync("git rebase --abort", {
          cwd: worktreePath,
          stdio: "pipe",
          timeout: 5000,
        });

        const conflictFiles = this.getRebaseConflictFiles(worktreePath);

        // Restore stash
        if (hadStash) {
          try {
            execSync("git stash pop", { cwd: worktreePath, stdio: "pipe", timeout: 5000 });
          } catch { /* stash pop may also conflict — best effort */ }
        }

        return conflictFiles;
      }

      // 5. Pop stash
      if (hadStash) {
        try {
          execSync("git stash pop", {
            cwd: worktreePath,
            stdio: "pipe",
            timeout: 10_000,
          });
        } catch {
          // Stash pop conflict with rebased code
          const diffFiles = execSync("git diff --name-only --diff-filter=U", {
            cwd: worktreePath,
            stdio: "pipe",
            timeout: 5000,
          }).toString().trim();
          return diffFiles ? diffFiles.split("\n") : ["<stash-pop conflict>"];
        }
      }

      return [];
    } catch (err) {
      console.warn(`[agent ${this.agentId}] Pre-commit rebase error: ${err}`);
      // Restore stashed changes so commitChanges() can still commit them
      if (hadStash) {
        try {
          execSync("git stash pop", { cwd: worktreePath, stdio: "pipe", timeout: 5000 });
        } catch {
          // stash pop may conflict — best effort
        }
      }
      return [];
    }
  }

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

  private completeTask(taskId: string, summary?: string): void {
    // Release locks
    for (const file of this.activeLockFiles) {
      this.lockManager.release(file);
    }

    // Update task status
    this.taskStore.updateTask(taskId, () => ({
      status: "done",
      updated_at: Date.now(),
    }));

    // Notify scheduler (with knowledge summary so other agents benefit)
    this.socketClient?.notifyTaskDone(taskId, summary);
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
    const criticalHints = this.prepareDiagnostics(worktreePath, liveHints);
    contextHints.push(...criticalHints);

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

    this.socketClient?.notifyTaskDone(taskId, `Read-only analysis: ${task.description.slice(0, 200)}`);
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

    this.socketClient?.notifyTaskDone(taskId, `Exploration completed: no files to modify`);
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
      this.socketClient?.notifyTaskFailed(taskId, `Interactive timeout: ${reason}`);
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
    this.socketClient?.notifyTaskFailed(taskId, reason);
  }

  private cleanup(taskId: string): void {
    // Remove all socket event listeners
    if (this.socketClient && typeof this.socketClient.off === "function") {
      for (const [event, handler] of this.socketHandlers) {
        this.socketClient.off(event, handler);
      }
      this.socketHandlers.clear();
    }

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

    const depKnowledge = this.knowledgeStore.getByTaskId(task.dependency);

    const lines: string[] = [];
    lines.push(`[PREDECESSOR] This task continues from Task ${task.dependency.slice(0, 8)}`);
    lines.push(`  Description: ${depTask.description}`);
    lines.push(`  Files: ${depTask.target_files.join(", ") || "(none)"}`);
    lines.push(`  Status:  ${depTask.status}`);
    lines.push(`  Your worktree already contains all code changes from the predecessor.`);
    lines.push(`  Build on top of it — do NOT re-implement or revert existing changes.`);

    if (depKnowledge?.summary) {
      lines.push(`  Summary: ${depKnowledge.summary.slice(0, 300)}`);
    }

    return lines.join("\n");
  }

  /**
   * Write ALL provider hints to `.multiagent/diagnostics.md` and return
   * only the critical ones (tsc, eslint, test) for inline prompt injection.
   *
   * Git and Codebase hints overlap with the ChangeJournal (which already
   * tells the agent what files changed). Moving them to a file saves
   * ~350 tokens per task while keeping them available on demand.
   */
  private prepareDiagnostics(
    worktreePath: string,
    liveHints: ContextHint[]
  ): string[] {
    const diagnosticsDir = path.join(worktreePath, ".multiagent");
    if (!fs.existsSync(diagnosticsDir)) {
      fs.mkdirSync(diagnosticsDir, { recursive: true });
    }

    // Write ALL hints to diagnostics.md (for on-demand reading)
    const lines: string[] = [];
    lines.push("# Pre-flight Diagnostics");
    lines.push("");
    lines.push("Generated before task execution. Critical issues from tsc, eslint,");
    lines.push("and test are also included in the prompt. Git and codebase info is");
    lines.push("available here on demand.");
    lines.push("");

    const formatted = liveHints.map((h) => ContextManager.formatHint(h));
    for (const hint of formatted) {
      lines.push(`- ${hint.replace(/\n/g, "\n  ")}`);
    }

    fs.writeFileSync(
      path.join(diagnosticsDir, "diagnostics.md"),
      lines.join("\n"),
      "utf-8"
    );

    // Return only critical hints for inline injection (tsc, eslint, test)
    const criticalSources = new Set(["typescript", "eslint", "test"]);
    return liveHints
      .filter((h) => criticalSources.has(h.source))
      .map((h) => ContextManager.formatHint(h));
  }
}
