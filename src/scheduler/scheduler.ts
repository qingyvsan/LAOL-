import * as path from "node:path";
import * as fs from "node:fs";
import { execSync } from "node:child_process";
import { EventBus } from "../events/event-bus";
import { TaskStore } from "../task/task-store";
import { TaskWatcher } from "../task/task-watcher";
import { LockManager } from "../lock/lock-manager";
import { LeaseManager } from "../lock/lease-manager";
import { ConflictChecker } from "./conflict-checker";
import { SymbolResolver } from "../lock/symbol-resolver";
import { HealthMonitor } from "./health-monitor";
import { CircuitBreaker } from "./circuit-breaker";
import { SocketServer } from "../events/socket-server";
import { WalManager } from "../wal/wal-manager";
import { MergeDriver } from "../merge/merge-driver";
import { ClaudeLLMProvider } from "../merge/claude-llm-provider";
import { ChangeJournal } from "../journal/change-journal";
import { loadConfig } from "../config";
import type { Task, Lock, LaolConfig, WaitingLockRequest } from "../data/models";

/**
 * Scheduler — the event-driven central orchestrator.
 *
 * Lifecycle:
 *   1. Recover from WAL (crash recovery)
 *   2. Load configuration
 *   3. Start file watchers (tasks/, locks/)
 *   4. Start TCP socket server (agent communication)
 *   5. Scan existing pending tasks
 *   6. Enter event loop
 *
 * All task assignment is event-driven — no polling.
 */

export class Scheduler {
  private repoRoot: string;
  private config: LaolConfig;

  // Core modules
  private eventBus: EventBus;
  private taskStore: TaskStore;
  private taskWatcher: TaskWatcher;
  private lockManager: LockManager;
  private leaseManager: LeaseManager;
  private conflictChecker: ConflictChecker;
  private healthMonitor: HealthMonitor;
  private circuitBreaker: CircuitBreaker;
  private socketServer: SocketServer;
  private walManager: WalManager;
  private changeJournal: ChangeJournal;

  // Agent tracking: agentId → { currentTask, connectedAt, heldLocks }
  private agents = new Map<string, AgentInfo>();

  // File-waiting mapping: file → set of task IDs waiting for it
  private waitingTasks = new Map<string, Set<string>>();

  // Per-agent lock tracking: agentId → Set<file> (dynamic, grows during execution)
  private agentLocks = new Map<string, Set<string>>();

  // Runtime lock waiting queue: file → list of waiting requests
  private waitingLockRequests = new Map<string, WaitingLockRequest[]>();

  // Dirty file tracking: file → { agentId, worktree, committedAt }
  // When an agent modifies a file and releases the lock, it's marked "dirty".
  // The next agent that requests this file gets the latest version propagated.
  private dirtyFiles = new Map<string, { agentId: string; worktree: string; committedAt: number }>();

  // Agent worktree mapping: agentId → worktree path
  // Standalone agents report their worktree path so the scheduler can coordinate
  // file propagation between worktrees.
  private agentWorktrees = new Map<string, string>();

  // Wait-for graph for deadlock detection: agentId → set of agent IDs it's waiting for
  private waitForGraph = new Map<string, Set<string>>();

  // Per-request timeout timers for lock waiting
  private lockWaitingTimers = new Map<string, NodeJS.Timeout>();

  // Interval timer for refreshing waiting agents
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor(repoRoot: string) {
    this.repoRoot = repoRoot;
    this.config = loadConfig(repoRoot);

    // Initialize all modules
    this.eventBus = new EventBus();
    this.taskStore = new TaskStore(repoRoot);
    this.taskWatcher = new TaskWatcher(repoRoot, this.taskStore, this.eventBus);
    this.lockManager = new LockManager(repoRoot);
    this.leaseManager = new LeaseManager(this.lockManager, {
      initialTtlMs: this.config.locks.initial_ttl_ms,
      stableTtlMs: this.config.locks.stable_ttl_ms,
      stableThreshold: this.config.locks.stable_threshold,
      probeTimeoutMs: this.config.locks.probe_timeout_ms,
    });
    this.conflictChecker = new ConflictChecker(this.lockManager);

    // Enable symbol-level locking (P2)
    const symbolResolver = new SymbolResolver();
    this.conflictChecker.setSymbolResolver(symbolResolver);

    this.healthMonitor = new HealthMonitor(
      this.lockManager,
      this.leaseManager,
      this.eventBus,
      15_000
    );
    this.circuitBreaker = new CircuitBreaker();
    this.socketServer = new SocketServer(this.config.scheduler.port);
    this.walManager = new WalManager(repoRoot);
    this.changeJournal = new ChangeJournal(repoRoot);
  }

  // ---- Lifecycle ----

  /**
   * Start the scheduler.
   * 1. Recover from WAL
   * 2. Start TCP server
   * 3. Start watchers
   * 4. Wire up event handlers
   * 5. Start health monitor
   * 6. Scan for existing pending tasks
   */
  async start(): Promise<void> {
    // 1. WAL recovery
    const pending = this.walManager.recover();
    if (pending.length > 0) {
      console.log(`[scheduler] Recovering ${pending.length} uncommitted WAL entries...`);
      this.reconcileWalEntries(pending);
    }

    // 1b. Load ChangeJournal (replay NDJSON)
    this.changeJournal.load();

    // 2. Start TCP server
    const port = await this.socketServer.start();
    console.log(`[scheduler] Listening on 127.0.0.1:${port}`);

    // 3. Wire health monitor ping → actual socket ping
    this.healthMonitor.setOnPingRequest((agentId: string) => {
      this.socketServer.pingAgent(agentId);
    });

    // 4. Wire up socket server events
    this.socketServer.on("agent_connected", (agentId: string) => {
      this.handleAgentConnected(agentId);
    });

    this.socketServer.on("agent_disconnected", (agentId: string) => {
      this.handleAgentDisconnected(agentId);
    });

    this.socketServer.on("heartbeat_received", (agentId: string, _locks: string[]) => {
      this.healthMonitor.recordPingResponse(agentId);
      // Update agent's last heartbeat time
      const info = this.agents.get(agentId);
      if (info) {
        info.lastHeartbeat = Date.now();
      }
    });

    this.socketServer.on("task_completed", (agentId: string, taskId: string, summary?: string) => {
      this.handleTaskCompleted(agentId, taskId, summary);
    });

    this.socketServer.on("task_failed", (agentId: string, taskId: string, reason: string) => {
      this.handleTaskFailed(agentId, taskId, reason);
    });

    this.socketServer.on("lock_request", (agentId: string, taskId: string, files: string[], skipPropagation?: boolean) => {
      this.handleLockRequest(agentId, taskId, files, skipPropagation);
    });

    this.socketServer.on("file_modified", (agentId: string, files: string[], worktree: string) => {
      this.handleFileModified(agentId, files, worktree);
    });

    this.socketServer.on("change_query", (agentId: string, reqId: string, qtype: string, files?: string[], since?: number) => {
      const results = this.changeJournal.query({
        type: qtype as "file" | "index" | "knowledge" | "merge" | "all",
        files: files ?? [],
        since,
        limit: 100,
      });
      this.socketServer.sendChangeResult(agentId, reqId, results);
    });

    this.socketServer.on("shutdown_requested", () => {
      this.handleShutdown();
    });

    // 4. Wire up internal event bus
    this.eventBus.on("task_created", (task: Task) => {
      this.tryAssignTask(task);
    });

    this.eventBus.on("lock_released", (file: string) => {
      this.retryWaitingTasks(file);
    });

    this.eventBus.on("lock_expired", (file: string) => {
      this.retryWaitingTasks(file);
    });

    this.eventBus.on("heartbeat_lost", (agentId: string) => {
      this.handleAgentLost(agentId);
    });

    this.eventBus.on("task_completed", (task: Task) => {
      // Fire-and-forget: merge runs async, does not block the scheduler
      this.handleMergeRequired(task).catch((err) => {
        console.error(`[scheduler] Unhandled merge error: ${err}`);
      });
    });

    // 5. Start task watcher
    this.taskWatcher.start();
    console.log("[scheduler] Task watcher started");

    // 6. Start health monitor
    this.healthMonitor.start();
    console.log("[scheduler] Health monitor started");

    // 7. Start lock-waiting refresh timer (prevents agent timeout while queued)
    this.refreshTimer = setInterval(() => this.refreshWaitingAgents(), 30_000);

    // 8. Scan for existing pending tasks
    const existingPending = this.taskWatcher.scanExisting();
    console.log(`[scheduler] Found ${existingPending.length} pending tasks`);

    // 8. Clean up stale locks (from previous crashed scheduler)
    this.cleanupStaleLocks();

    console.log("[scheduler] Ready.");
  }

  /**
   * Stop the scheduler gracefully.
   */
  async stop(): Promise<void> {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    // Clear all waiting lock timers
    for (const [, timer] of this.lockWaitingTimers) {
      clearTimeout(timer);
    }
    this.lockWaitingTimers.clear();
    this.healthMonitor.stop();
    await this.taskWatcher.stop();
    await this.socketServer.stop();
    this.walManager.checkpoint();
    this.walManager.close();
    console.log("[scheduler] Stopped.");
  }

  // ---- Task Assignment ----

  /**
   * Try to assign a task to an idle agent.
   */
  private tryAssignTask(task: Task): void {
    // Only handle pending tasks
    if (task.status !== "pending") return;

    // Check dependency
    if (task.dependency) {
      const depTask = this.taskStore.getTask(task.dependency);
      if (!depTask || depTask.status !== "done") {
        const reason = !depTask
          ? `Dependency task ${task.dependency.slice(0, 8)} not found`
          : depTask.status === "failed" || depTask.status === "stuck"
            ? `Dependency task ${task.dependency.slice(0, 8)} is ${depTask.status}`
            : `Waiting for dependency task ${task.dependency.slice(0, 8)} (status: ${depTask.status})`;
        this.writeBlockedMetadata(task, reason);
        return;
      }
      // Dependency resolved — clear any previous blocked metadata
      if (task.metadata?.blocked_reason) {
        this.taskStore.updateTask(task.id, (t) => ({
          metadata: { ...t.metadata, blocked_reason: undefined },
        }));
      }
    }

    // 1. Conflict check
    const conflictResult = this.conflictChecker.canAssign(task);
    if (!conflictResult.can_assign) {
      // Track what files this task is waiting for
      for (const file of task.target_files) {
        this.addWaitingTask(file, task.id);
      }

      this.writeBlockedMetadata(task, conflictResult.reason ?? "Lock conflict detected");

      // If semantic warning, update task metadata
      if (conflictResult.warnings) {
        this.taskStore.updateTask(task.id, () => ({
          metadata: {
            ...task.metadata,
            semantic_warning: conflictResult.warnings,
            risk_level: conflictResult.risk_level,
          },
        }));
      }

      return;
    }

    // 2. Find an idle agent
    const idleAgent = this.findIdleAgent();
    if (!idleAgent) {
      this.writeBlockedMetadata(task, "No idle agent available");
      return;
    }

    // 3. Check circuit breaker
    const complexity = task.target_files.length;
    const breakerResult = this.circuitBreaker.canAcceptTask(idleAgent, complexity);
    if (!breakerResult.can) {
      this.writeBlockedMetadata(task, breakerResult.reason ?? "Circuit breaker blocked assignment");
      return;
    }

    // 4. Acquire locks + update task state (WAL-protected for crash recovery)
    let updated: Task | null = null;
    let locks: string[] = [];

    try {
      this.walManager.write({ op: "assign", task: task.id, agent: idleAgent, files: task.target_files });

      // Acquire locks (atomic two-phase commit) — skip if no target files
      if (task.target_files.length > 0) {
        const acquireResult = this.lockManager.acquire(task.id, idleAgent, task.target_files, this.leaseManager.INITIAL_TTL_MS);
        if (!acquireResult.success) {
          this.walManager.write({ op: "fail", task: task.id, reason: acquireResult.reason ?? "Lock conflict" });
          // Lock conflict — track waiting and leave pending
          for (const file of task.target_files) {
            this.addWaitingTask(file, task.id);
          }
          return;
        }
        locks = acquireResult.locks?.map((l) => l.file) ?? [];
        this.agentLocks.set(idleAgent, new Set(locks));
      } else {
        this.agentLocks.set(idleAgent, new Set());
      }

      // Update task state
      updated = this.taskStore.updateTask(task.id, (t) => ({
        status: "in_progress",
        assigned_agent: idleAgent,
        metadata: {
          ...t.metadata,
          risk_level: conflictResult.risk_level ?? "low",
          warnings: conflictResult.warnings ?? [],
        },
      }));

      if (!updated) {
        this.walManager.write({ op: "fail", task: task.id, reason: "Version conflict on task update" });
        // Version conflict — rollback locks
        for (const file of locks) {
          this.lockManager.release(file);
        }
        this.agentLocks.delete(idleAgent);
        return;
      }

      this.walManager.write({ op: "commit", task: task.id });
    } catch (err) {
      this.walManager.write({ op: "fail", task: task.id, reason: err instanceof Error ? err.message : String(err) });
      for (const file of locks) {
        this.lockManager.release(file);
      }
      this.agentLocks.delete(idleAgent);
      return;
    }

    // 6. Mark agent as busy
    const agentInfo = this.agents.get(idleAgent);
    if (agentInfo) {
      agentInfo.currentTask = task.id;
    }

    // 7. Emit assigned event
    this.eventBus.emit("task_assigned", updated, idleAgent);

    // 8. Notify agent via socket
    this.socketServer.sendToAgent(idleAgent, {
      type: "task_assigned",
      task_id: task.id,
      description: task.description,
      target_files: task.target_files,
      locks,
    });

    // 9. Write warning file if semantic warnings exist
    if (conflictResult.warnings && conflictResult.warnings.length > 0) {
      this.writeWarningFile(task.id, conflictResult.warnings);
    }

    console.log(`[scheduler] Task ${task.id.slice(0, 8)} assigned to ${idleAgent}`);
  }

  /**
   * Retry assigning tasks that were waiting for a specific file.
   */
  private retryWaitingTasks(file: string): void {
    const waiting = this.waitingTasks.get(file);
    if (!waiting || waiting.size === 0) return;

    // Copy and clear — tasks will be re-added if they still can't proceed
    const taskIds = Array.from(waiting);
    this.waitingTasks.delete(file);

    for (const taskId of taskIds) {
      // Remove from other file wait lists
      this.removeWaitingTask(taskId);

      const task = this.taskStore.getTask(taskId);
      if (task && task.status === "pending") {
        this.tryAssignTask(task);
      }
    }
  }

  // ---- Agent Management ----

  private handleAgentConnected(agentId: string): void {
    this.agents.set(agentId, {
      agentId,
      currentTask: null,
      connectedAt: Date.now(),
      lastHeartbeat: Date.now(),
    });

    this.eventBus.emit("agent_connected", agentId);
    console.log(`[scheduler] Agent "${agentId}" connected`);

    // Check if this agent should be working on something
    // (e.g. reconnecting after a network blip)
    const inProgressTask = this.taskStore
      .listTasks({ status: "in_progress", assigned_agent: agentId })
      .find(() => true);

    if (inProgressTask) {
      // Agent reconnected — let it resume
      this.socketServer.sendToAgent(agentId, {
        type: "task_resume",
        task_id: inProgressTask.id,
        description: inProgressTask.description,
        target_files: inProgressTask.target_files,
      });
    }
  }

  private handleAgentDisconnected(agentId: string): void {
    const info = this.agents.get(agentId);
    this.agents.delete(agentId);
    this.circuitBreaker.removeAgent(agentId);

    this.eventBus.emit("agent_disconnected", agentId);
    console.log(`[scheduler] Agent "${agentId}" disconnected`);

    // Clean up waiting lock requests and wait-for edges
    this.cleanupWaitingAgent(agentId);
    this.clearWaitForEdges(agentId);

    // Release any locks held by this agent
    const released = this.lockManager.releaseAllForAgent(agentId);
    for (const file of released) {
      this.eventBus.emit("lock_released", file);
      this.retryWaitingLockRequests(file);
    }

    // If the agent had an in-progress task, reset it to pending
    if (info?.currentTask) {
      this.taskStore.updateTask(info.currentTask, () => ({
        status: "pending",
        assigned_agent: null,
        metadata: { disconnected_at: Date.now() },
      }));
    }
  }

  private handleAgentLost(agentId: string): void {
    // Heartbeat lost — force release and reset
    console.log(`[scheduler] Agent "${agentId}" lost (heartbeat timeout)`);

    const info = this.agents.get(agentId);
    this.agents.delete(agentId);
    this.circuitBreaker.removeAgent(agentId);

    // Clean up waiting lock requests and wait-for edges
    this.cleanupWaitingAgent(agentId);
    this.clearWaitForEdges(agentId);

    // Release all locks
    const released = this.lockManager.releaseAllForAgent(agentId);
    for (const file of released) {
      this.eventBus.emit("lock_released", file);
      this.retryWaitingLockRequests(file);
    }

    // Reset its current task
    if (info?.currentTask) {
      this.taskStore.updateTask(info.currentTask, () => ({
        status: "pending",
        assigned_agent: null,
        metadata: { agent_lost_at: Date.now() },
      }));
    }
  }

  /**
   * Handle a file_modified message from an agent.
   * The agent reports files it has finished modifying (committed locally).
   * These files are marked "dirty" so the next agent requesting them
   * receives the latest version via file propagation.
   */
  private handleFileModified(agentId: string, files: string[], worktree: string): void {
    // Track the agent's worktree path
    if (worktree) {
      this.agentWorktrees.set(agentId, worktree);
    }

    // Release locks on the reported files
    const heldLocks = this.agentLocks.get(agentId);
    if (heldLocks) {
      for (const file of files) {
        heldLocks.delete(file);
        this.lockManager.release(file);
        this.eventBus.emit("lock_released", file);
      }
    }

    // Mark files as dirty with propagation info
    for (const file of files) {
      this.dirtyFiles.set(file, {
        agentId,
        worktree: worktree || this.agentWorktrees.get(agentId) || "",
        committedAt: Date.now(),
      });
    }

    console.log(
      `[scheduler] Agent "${agentId}" modified ${files.length} file(s): ${files.join(", ")}`
    );

    // Record to ChangeJournal (pull model — agents query on demand)
    // One "file" entry per modified file; index updates are recorded
    // separately when the CodebaseIndexer actually rebuilds the index.
    for (const file of files) {
      this.changeJournal.recordFileChange(file, agentId, worktree);
    }

    // Retry any waiting lock requests for these files
    for (const file of files) {
      this.retryWaitingLockRequests(file);
    }
  }

  // ---- Task Lifecycle ----

  private handleTaskCompleted(agentId: string, taskId: string, summary?: string): void {
    const task = this.taskStore.getTask(taskId);
    if (!task) return;

    // Release all locks (from agent's tracked set, since files may be dynamic)
    const heldLocks = this.agentLocks.get(agentId);
    if (heldLocks) {
      for (const file of heldLocks) {
        this.lockManager.release(file);
        this.eventBus.emit("lock_released", file);
        this.retryWaitingLockRequests(file);
      }
      this.agentLocks.delete(agentId);
    }

    // Clean up wait-for edges for the completed agent
    this.clearWaitForEdges(agentId);

    // Update task with the full file set discovered during execution
    this.taskStore.updateTask(taskId, () => ({
      status: "done",
      target_files: heldLocks ? [...heldLocks] : task.target_files,
      updated_at: Date.now(),
    }));

    // Circuit breaker: success
    this.circuitBreaker.onTaskSuccess(agentId, taskId);

    // Free agent
    const info = this.agents.get(agentId);
    if (info) {
      info.currentTask = null;
    }

    this.eventBus.emit("task_completed", task);
    console.log(`[scheduler] Task ${taskId.slice(0, 8)} completed by ${agentId}`);

    // Record knowledge update to ChangeJournal for future queries
    this.changeJournal.recordKnowledgeUpdate(taskId, agentId, summary || task.description);

    // Push knowledge_updated only to agents currently executing a task
    // (they benefit from real-time knowledge; idle agents query the journal
    // on their next task start).
    const busyAgents = Array.from(this.agents.values())
      .filter((a) => a.currentTask !== null && a.agentId !== agentId)
      .map((a) => a.agentId);
    if (busyAgents.length > 0) {
      this.socketServer.sendToAgents(busyAgents, {
        type: "knowledge_updated",
        task_id: taskId,
        agent_id: agentId,
        summary: summary || task.description,
      });
    }

    // Try to assign next pending task
    this.assignNextPending();
  }

  private handleTaskFailed(agentId: string, taskId: string, reason: string): void {
    const task = this.taskStore.getTask(taskId);
    if (!task) return;

    // Release all locks (from agent's tracked set)
    const heldLocks = this.agentLocks.get(agentId);
    if (heldLocks) {
      for (const file of heldLocks) {
        this.lockManager.release(file);
        this.eventBus.emit("lock_released", file);
        this.retryWaitingLockRequests(file);
      }
      this.agentLocks.delete(agentId);
    }

    // Clean up wait-for edges for the failed agent
    this.clearWaitForEdges(agentId);

    // Circuit breaker: failure
    const { agentState, taskStuck } = this.circuitBreaker.onTaskFailure(
      agentId,
      taskId,
      reason
    );

    const newStatus = taskStuck ? "stuck" : "failed";

    this.taskStore.updateTask(taskId, () => ({
      status: newStatus,
      target_files: heldLocks ? [...heldLocks] : task.target_files,
      metadata: { failure_reason: reason, retry_count: (task.metadata?.retry_count as number ?? 0) + 1 },
    }));

    // Free agent
    const info = this.agents.get(agentId);
    if (info) {
      info.currentTask = null;
    }

    this.eventBus.emit("task_failed", task, reason);
    console.log(`[scheduler] Task ${taskId.slice(0, 8)} failed by ${agentId}: ${reason}`);

    if (taskStuck) {
      console.log(`[scheduler] Task ${taskId.slice(0, 8)} is STUCK — human intervention required`);
    }

    // If agent is quarantined, try to assign next task to other agents
    if (agentState !== "quarantined") {
      this.assignNextPending();
    }

    // Cascade failure to dependent tasks
    this.cascadeDependencyFailure(taskId, `dependency "${taskId.slice(0, 8)}" failed: ${reason}`);
  }

  /**
   * Recursively fail all tasks that depend on a failed task.
   */
  private cascadeDependencyFailure(failedTaskId: string, reason: string): void {
    const dependents = this.taskStore.findDependents(failedTaskId);
    for (const dep of dependents) {
      if (dep.status === "pending") {
        this.taskStore.updateTask(dep.id, () => ({
          status: "failed",
          metadata: { failure_reason: reason },
        }));
        console.log(`[scheduler] Task ${dep.id.slice(0, 8)} failed (dependency cascade)`);
        this.eventBus.emit("task_failed", dep, reason);
        // Recursively cascade
        this.cascadeDependencyFailure(dep.id, `dependency "${dep.id.slice(0, 8)}" failed: upstream dependency failed`);
      }
    }
  }

  /**
   * Handle merge required — run the 3-level merge pipeline (auto → AST → LLM)
   * when an agent completes a task and has pushed its branch.
   *
   * Uses a temporary worktree to avoid polluting the main repo's working directory.
   */
  private async handleMergeRequired(task: Task): Promise<void> {
    const branch = `agent/${task.id}`;
    const mergeDir = path.join(this.repoRoot, ".multiagent", "merges", task.id);

    this.eventBus.emit("merge_required", task.id, branch);

    try {
      // Verify the agent branch exists (remote or local)
      try {
        execSync(`git rev-parse --verify origin/${branch}`, {
          cwd: this.repoRoot, stdio: "pipe", timeout: 5000,
        });
      } catch {
        try {
          execSync(`git rev-parse --verify ${branch}`, {
            cwd: this.repoRoot, stdio: "pipe", timeout: 5000,
          });
        } catch {
          console.log(`[scheduler] Merge skipped: branch "${branch}" not found`);
          return;
        }
      }

      // Create a temporary worktree for the merge
      fs.mkdirSync(mergeDir, { recursive: true });
      try {
        execSync(`git worktree add --no-checkout "${mergeDir}" main`, {
          cwd: this.repoRoot, stdio: "pipe", timeout: 10_000,
        });
      } catch {
        // Worktree may already exist — try to reuse it
        try {
          execSync(`git checkout main`, { cwd: mergeDir, stdio: "pipe", timeout: 10_000 });
          execSync(`git pull origin main`, { cwd: mergeDir, stdio: "pipe", timeout: 15_000 });
        } catch {
          // Continue with whatever state exists
        }
      }

      // Build LLM provider from config
      const llmProvider = new ClaudeLLMProvider({
        model: this.config.llm.model,
        timeoutMs: 60_000,
        binaryPath: this.config.claude_executor.binary_path,
      });

      let quorumProvider: ClaudeLLMProvider | undefined;
      if (this.config.merge_driver_config.quorum_enabled && this.config.llm.secondary_model) {
        quorumProvider = new ClaudeLLMProvider({
          model: this.config.llm.secondary_model,
          timeoutMs: 60_000,
          binaryPath: this.config.claude_executor.binary_path,
        });
      }

      const driver = new MergeDriver({
        worktreePath: mergeDir,
        llmProvider,
        quorumProvider,
        mergeChecks: this.config.merge_checks,
      });

      console.log(`[scheduler] Starting merge: ${branch} → main`);
      const result = await driver.merge("main", branch);

      // Log resolution details
      if (result.resolutions.length > 0) {
        for (const r of result.resolutions) {
          const status = r.resolved ? "resolved" : "unresolved";
          console.log(`[scheduler]   ${r.file}#${r.blockIndex} [${r.method}] — ${status}`);
        }
      }

      // Push if successful
      if (result.success) {
        try {
          execSync("git push origin main", {
            cwd: mergeDir, stdio: "pipe", timeout: 15_000,
          });
          console.log(`[scheduler] Merge completed and pushed: ${branch} → main`);
        } catch (pushErr) {
          console.error(`[scheduler] Merge push failed: ${pushErr}`);
        }
        // Record merge to ChangeJournal — main branch has new merged code
        this.changeJournal.recordMergeCompleted(task.id, task.target_files);
      } else {
        console.warn(`[scheduler] Merge incomplete: ${result.error ?? "validation failed"}`);
      }

      // Notify agents that merge is done (so they can rebase)
      this.socketServer.broadcast({
        type: "merge_completed",
        task_id: task.id,
        method: result.method,
        success: result.success,
      });

      if (result.success) {
        this.eventBus.emit("merge_completed", task.id);
      } else {
        this.eventBus.emit("merge_rejected", task.id, result.error ?? "merge failed");
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] Merge error for task ${task.id.slice(0, 8)}: ${reason}`);
      this.eventBus.emit("merge_rejected", task.id, reason);
    } finally {
      // Clean up the temporary merge worktree
      try {
        execSync(`git worktree remove --force "${mergeDir}"`, {
          cwd: this.repoRoot, stdio: "pipe", timeout: 10_000,
        });
      } catch {
        // Manual cleanup fallback
        try {
          fs.rmSync(mergeDir, { recursive: true, force: true });
          execSync("git worktree prune", {
            cwd: this.repoRoot, stdio: "pipe", timeout: 5000,
          });
        } catch { /* best effort */ }
      }
    }
  }

  /**
   * Handle a lock_request from an agent: run conflict check + acquire locks
   * for the requested files, then respond with lock_granted, lock_waiting, or lock_denied.
   *
   * When a lock is held by another agent, the request is queued (lock_waiting)
   * instead of rejected immediately. Deadlock detection runs before queuing.
   */
  private handleLockRequest(agentId: string, taskId: string, files: string[], skipPropagation = false): void {
    // Deduplicate and check which files the agent already has locked
    const currentLocks = this.agentLocks.get(agentId) ?? new Set();
    const newFiles = files.filter((f) => !currentLocks.has(f));

    if (newFiles.length === 0) {
      // All files already locked — grant immediately.
      // Check dirty files for propagation (unless skipPropagation is set
      // for post-hoc lock expansion, where the agent already has local changes).
      if (!skipPropagation) {
        for (const file of files) {
          const dirty = this.dirtyFiles.get(file);
          if (dirty && dirty.agentId !== agentId && dirty.worktree) {
            this.socketServer.sendFilePropagate(
              agentId, file, dirty.worktree, dirty.agentId
            );
            this.dirtyFiles.delete(file);
          }
        }
      } else {
        // Post-hoc lock expansion: clear dirty flags without propagating
        // (agent already has its own modifications)
        for (const file of files) {
          this.dirtyFiles.delete(file);
        }
      }
      this.socketServer.sendLockGranted(agentId, taskId, files);
      return;
    }

    // Check if this task is already waiting for any of the requested files (dedup)
    const alreadyWaiting = this.isTaskWaitingForAnyFile(taskId, newFiles);
    if (alreadyWaiting.size > 0) {
      this.socketServer.sendLockWaiting(agentId, taskId, [...alreadyWaiting],
        `Still waiting for locks on: ${[...alreadyWaiting].join(", ")}`);
      return;
    }

    // Check conflicts for the new files
    const directConflict = this.lockManager.findConflict(newFiles);
    if (directConflict) {
      const conflictHolder = directConflict.holder;
      const conflictFile = directConflict.file;

      // Enqueue the request for each conflicting file
      this.enqueueWaitingLockRequest(conflictFile, {
        taskId, agentId, files: newFiles, requestedAt: Date.now(),
      });

      // Add edge to wait-for graph
      this.addWaitForEdge(agentId, conflictHolder);

      // Deadlock detection (if enabled)
      if (this.config.locks.deadlock_detection_enabled) {
        const cycle = this.detectDeadlockCycle(agentId);
        if (cycle) {
          // Deadlock detected — break by denying the youngest agent in the cycle
          this.resolveDeadlock(cycle, taskId);
          return;
        }
      }

      // No deadlock — tell agent to wait
      this.socketServer.sendLockWaiting(agentId, taskId, newFiles,
        `File "${conflictFile}" is locked by agent "${conflictHolder}". Queued for retry.`);

      // Set a global timeout for this waiting request
      const timeoutMs = this.config.locks.lock_waiting_timeout_ms;
      const timerKey = `${taskId}:${agentId}`;
      const timer = setTimeout(() => {
        this.cleanupWaitingRequest(taskId, agentId);
        this.socketServer.sendLockDenied(agentId, taskId, newFiles,
          `Lock waiting timed out after ${Math.round(timeoutMs / 1000)}s`);
      }, timeoutMs);
      this.lockWaitingTimers.set(timerKey, timer);

      return;
    }

    // No conflict — acquire locks atomically (WAL-protected)
    try {
      this.walManager.write({ op: "acquire_lock", task: taskId, agent: agentId, files: newFiles });

      const acquireResult = this.lockManager.acquire(taskId, agentId, newFiles, this.leaseManager.INITIAL_TTL_MS);
      if (!acquireResult.success) {
        this.walManager.write({ op: "fail", task: taskId, reason: acquireResult.reason ?? "Lock acquisition failed" });
        this.socketServer.sendLockDenied(agentId, taskId, newFiles, acquireResult.reason ?? "Lock acquisition failed");
        return;
      }

      this.walManager.write({ op: "commit", task: taskId });

      // Track new locks
      const acquiredFiles = acquireResult.locks?.map((l) => l.file) ?? [];
      for (const file of acquiredFiles) {
        currentLocks.add(file);
      }
      this.agentLocks.set(agentId, currentLocks);

      // Check dirty files — if any file was modified by another agent,
      // tell the requesting agent to propagate the latest version.
      // Skip when skipPropagation is set (post-hoc lock expansion —
      // the agent already has its own local modifications).
      if (!skipPropagation) {
        for (const file of files) {
          const dirty = this.dirtyFiles.get(file);
          if (dirty && dirty.agentId !== agentId && dirty.worktree) {
            this.socketServer.sendFilePropagate(
              agentId, file, dirty.worktree, dirty.agentId
            );
            console.log(
              `[scheduler] File "${file}" propagated from agent "${dirty.agentId}" to agent "${agentId}"`
            );
            this.dirtyFiles.delete(file);
          }
        }
      } else {
        // Post-hoc lock expansion: clear dirty flags without propagating
        for (const file of files) {
          this.dirtyFiles.delete(file);
        }
      }

      // Grant the locks
      this.socketServer.sendLockGranted(agentId, taskId, files);
      console.log(`[scheduler] Lock request granted for agent ${agentId}: ${files.join(", ")}`);
    } catch (err) {
      this.walManager.write({ op: "fail", task: taskId, reason: err instanceof Error ? err.message : String(err) });
      this.socketServer.sendLockDenied(agentId, taskId, newFiles, "Internal error during lock acquisition");
    }
  }

  /**
   * Handle a shutdown request — broadcast to all agents, wait for cleanup,
   * then stop all services and exit.
   */
  private async handleShutdown(): Promise<void> {
    console.log("[scheduler] Shutdown requested — notifying all agents...");

    // Notify all connected agents to shut down
    this.socketServer.broadcast({ type: "shutdown" });

    // Give agents time to clean up and disconnect
    await new Promise((r) => setTimeout(r, 2000));

    // Clean up worktree directories left by agents
    this.cleanupWorktrees();

    // Graceful stop
    await this.stop();

    console.log("[scheduler] All services stopped. Exiting.");
    process.exit(0);
  }

  /**
   * Remove all worktree directories from disk and prune git metadata.
   */
  private cleanupWorktrees(): void {
    const worktreesDir = path.join(this.repoRoot, ".multiagent", "worktrees");
    if (fs.existsSync(worktreesDir)) {
      try {
        fs.rmSync(worktreesDir, { recursive: true, force: true });
        console.log("[scheduler] Worktree directories cleaned up.");
      } catch {
        console.log("[scheduler] Warning: could not fully clean worktree directories.");
      }
    }

    // Prune git's internal worktree registry so removed directories
    // don't cause "missing but already registered" errors on restart.
    try {
      execSync("git worktree prune", {
        cwd: this.repoRoot,
        stdio: "pipe",
        timeout: 5000,
      });
    } catch {
      // best effort
    }
  }

  // ---- Lock Waiting Queue & Deadlock Detection ----

  /** Enqueue a waiting lock request for a specific file. */
  private enqueueWaitingLockRequest(file: string, req: WaitingLockRequest): void {
    if (!this.waitingLockRequests.has(file)) {
      this.waitingLockRequests.set(file, []);
    }
    this.waitingLockRequests.get(file)!.push(req);
  }

  /** Add an edge to the wait-for graph: waiter → holder. */
  private addWaitForEdge(waiter: string, holder: string): void {
    if (!this.waitForGraph.has(waiter)) {
      this.waitForGraph.set(waiter, new Set());
    }
    this.waitForGraph.get(waiter)!.add(holder);
  }

  /** Check if a task is already waiting for any of the given files. */
  private isTaskWaitingForAnyFile(taskId: string, files: string[]): Set<string> {
    const result = new Set<string>();
    for (const file of files) {
      const queue = this.waitingLockRequests.get(file);
      if (queue) {
        for (const req of queue) {
          if (req.taskId === taskId) {
            result.add(file);
          }
        }
      }
    }
    return result;
  }

  /**
   * Retry waiting lock requests for a file that was just released.
   * Called when locks are released in handleTaskCompleted/handleTaskFailed.
   */
  private retryWaitingLockRequests(file: string): void {
    const queue = this.waitingLockRequests.get(file);
    if (!queue || queue.length === 0) return;

    // Copy and clear — requests will be re-added if they still can't proceed
    const requests = [...queue];
    this.waitingLockRequests.delete(file);

    for (const req of requests) {
      // Check if the agent is still connected
      if (!this.agents.has(req.agentId)) {
        this.clearWaitForEdges(req.agentId);
        continue;
      }

      // Re-check conflicts (another agent may have grabbed the lock)
      const conflict = this.lockManager.findConflict(req.files);
      if (conflict) {
        // Still blocked — re-enqueue for the new conflicting file
        this.enqueueWaitingLockRequest(conflict.file, req);
        continue;
      }

      // Locks are now free — acquire and grant
      this.clearWaitForEdges(req.agentId);
      const timerKey = `${req.taskId}:${req.agentId}`;
      const timer = this.lockWaitingTimers.get(timerKey);
      if (timer) {
        clearTimeout(timer);
        this.lockWaitingTimers.delete(timerKey);
      }
      this.handleLockRequest(req.agentId, req.taskId, req.files);
    }
  }

  /**
   * DFS cycle detection on the wait-for graph.
   * Returns the cycle path (array of agent IDs), or null if no cycle.
   */
  private detectDeadlockCycle(startAgent: string): string[] | null {
    const visited = new Set<string>();
    const path: string[] = [];

    const dfs = (agent: string): boolean => {
      if (path.includes(agent)) {
        // Cycle found — include the repeated agent to show the loop
        path.push(agent);
        return true;
      }
      if (visited.has(agent)) return false;

      visited.add(agent);
      path.push(agent);

      const waitFor = this.waitForGraph.get(agent);
      if (waitFor) {
        for (const target of waitFor) {
          if (dfs(target)) return true;
        }
      }

      path.pop();
      return false;
    };

    return dfs(startAgent) ? path : null;
  }

  /**
   * Resolve a deadlock: pick the agent with the latest request in the cycle
   * and deny its lock request. Cleans up edges for all agents in the cycle.
   */
  private resolveDeadlock(cycle: string[], originatingTaskId: string): void {
    // Find the youngest request (most recent) in the cycle
    let youngestAgent = cycle[0];
    let latestTime = 0;

    for (const agentId of cycle) {
      for (const [, queue] of this.waitingLockRequests) {
        for (const req of queue) {
          if (req.agentId === agentId && req.requestedAt > latestTime) {
            latestTime = req.requestedAt;
            youngestAgent = agentId;
          }
        }
      }
    }

    console.log(`[scheduler] Deadlock detected in cycle: ${cycle.join(" → ")}. Breaking at ${youngestAgent}.`);

    // Deny the youngest agent's lock request (the one that created the cycle)
    this.socketServer.sendLockDenied(youngestAgent, originatingTaskId, [],
      `Deadlock detected: your lock request would create a circular wait. Retry the task.`);

    // Clean up all agents in the cycle
    for (const agentId of cycle) {
      this.cleanupWaitingAgent(agentId);
      this.clearWaitForEdges(agentId);
    }
  }

  /** Remove all waiting lock requests for a given agent. */
  private cleanupWaitingAgent(agentId: string): void {
    for (const [file, queue] of this.waitingLockRequests) {
      const filtered = queue.filter((r) => r.agentId !== agentId);
      if (filtered.length === 0) {
        this.waitingLockRequests.delete(file);
      } else {
        this.waitingLockRequests.set(file, filtered);
      }
    }
    // Clear related timers
    for (const [key, timer] of this.lockWaitingTimers) {
      if (key.endsWith(`:${agentId}`)) {
        clearTimeout(timer);
        this.lockWaitingTimers.delete(key);
      }
    }
  }

  /** Clean up a specific waiting request by task and agent. */
  private cleanupWaitingRequest(taskId: string, agentId: string): void {
    for (const [file, queue] of this.waitingLockRequests) {
      const filtered = queue.filter((r) => !(r.taskId === taskId && r.agentId === agentId));
      if (filtered.length === 0) {
        this.waitingLockRequests.delete(file);
      } else {
        this.waitingLockRequests.set(file, filtered);
      }
    }
    const timerKey = `${taskId}:${agentId}`;
    const timer = this.lockWaitingTimers.get(timerKey);
    if (timer) {
      clearTimeout(timer);
      this.lockWaitingTimers.delete(timerKey);
    }
    this.clearWaitForEdges(agentId);
  }

  /** Remove wait-for edges for an agent (both outgoing and incoming). */
  private clearWaitForEdges(agentId: string): void {
    this.waitForGraph.delete(agentId);
    for (const [, targets] of this.waitForGraph) {
      targets.delete(agentId);
    }
  }

  /**
   * Periodically re-send lock_waiting to agents still in the queue
   * to prevent their requestLocksAsync timeout from firing.
   */
  private refreshWaitingAgents(): void {
    for (const [file, queue] of this.waitingLockRequests) {
      for (const req of queue) {
        const lock = this.lockManager.getLock(file);
        if (lock) {
          this.socketServer.sendLockWaiting(req.agentId, req.taskId, req.files,
            `Still waiting for "${file}" (held by ${lock.holder})...`);
        }
      }
    }
  }

  // ---- Helpers ----

  private findIdleAgent(): string | null {
    for (const [id, info] of this.agents) {
      if (!info.currentTask) return id;
    }
    return null;
  }

  private assignNextPending(): void {
    const pending = this.taskStore.listTasks({ status: "pending" });
    for (const task of pending) {
      const conflictResult = this.conflictChecker.canAssign(task);
      if (conflictResult.can_assign) {
        this.tryAssignTask(task);
        break; // assign one at a time
      }
    }
  }

  /**
   * Write a blocked_reason into task metadata so users can see
   * why a task is stuck in pending. Only writes if the reason changed.
   */
  private writeBlockedMetadata(task: Task, reason: string): void {
    if (task.metadata?.blocked_reason === reason) return; // avoid write churn
    this.taskStore.updateTask(task.id, () => ({
      metadata: { ...task.metadata, blocked_reason: reason, blocked_at: Date.now() },
    }));
  }

  private addWaitingTask(file: string, taskId: string): void {
    if (!this.waitingTasks.has(file)) {
      this.waitingTasks.set(file, new Set());
    }
    this.waitingTasks.get(file)!.add(taskId);
  }

  private removeWaitingTask(taskId: string): void {
    for (const [, tasks] of this.waitingTasks) {
      tasks.delete(taskId);
    }
  }

  private writeWarningFile(taskId: string, warnings: string[]): void {
    const warningsDir = path.join(this.repoRoot, ".multiagent", "warnings");
    if (!fs.existsSync(warningsDir)) {
      fs.mkdirSync(warningsDir, { recursive: true });
    }

    const content = warnings.map((w) => `- ${w}`).join("\n");
    fs.writeFileSync(
      path.join(warningsDir, `${taskId}.md`),
      `# Semantic Warnings for Task ${taskId}\n\n${content}\n`,
      "utf-8"
    );
  }

  private cleanupStaleLocks(): void {
    // On startup, any lock files that exist without a corresponding
    // in_progress task are stale and should be cleaned up
    const allLocks = this.lockManager.listLocks();
    for (const lock of allLocks) {
      const task = this.taskStore.getTask(lock.task_id);
      if (!task || task.status !== "in_progress") {
        console.log(`[scheduler] Cleaning up stale lock: ${lock.file}`);
        this.lockManager.forceRelease(lock.file);
      }
    }
  }

  private reconcileWalEntries(records: import("../data/models").WalRecord[]): void {
    for (const rec of records) {
      switch (rec.op) {
        case "assign": {
          if (rec.task && !this.taskStore.getTask(rec.task)) {
            // Task was assigned but JSON didn't persist — rollback
          }
          break;
        }
        case "acquire_lock": {
          if (rec.file && !this.lockManager.isLocked(rec.file) && rec.holder) {
            // Lock WAL says acquired but file doesn't exist — recreate
            const lock: Lock = {
              file: rec.file,
              holder: rec.holder,
              task_id: (rec.task ?? ""),
              expires_at: (rec.expires as number) ?? Date.now() + 60000,
              phase: "initial",
              last_heartbeat: Date.now(),
              renew_count: 0,
              created_at: Date.now(),
            };
            // Directly write the lock file
            const lockPath = path.join(this.repoRoot, ".multiagent", "locks",
              `${rec.file.replace(/[/\\]/g, "#")}.lock`);
            fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2), "utf-8");
          }
          break;
        }
        case "release_lock": {
          if (rec.file && this.lockManager.isLocked(rec.file)) {
            this.lockManager.forceRelease(rec.file);
          }
          break;
        }
      }
    }
  }

  // ---- Accessors (for CLI status command) ----

  getEventBus(): EventBus {
    return this.eventBus;
  }

  getTaskStore(): TaskStore {
    return this.taskStore;
  }

  getLockManager(): LockManager {
    return this.lockManager;
  }

  getCircuitBreaker(): CircuitBreaker {
    return this.circuitBreaker;
  }

  getAgentCount(): number {
    return this.agents.size;
  }
}

// ---- Agent info ----

interface AgentInfo {
  agentId: string;
  currentTask: string | null;
  connectedAt: number;
  lastHeartbeat: number;
}
