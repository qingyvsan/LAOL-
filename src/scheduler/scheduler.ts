import * as path from "node:path";
import * as fs from "node:fs";
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
import { loadConfig } from "../config";
import type { Task, Lock, LaolConfig } from "../data/models";

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

  // Agent tracking: agentId → { currentTask, connectedAt, heldLocks }
  private agents = new Map<string, AgentInfo>();

  // File-waiting mapping: file → set of task IDs waiting for it
  private waitingTasks = new Map<string, Set<string>>();

  // Per-agent lock tracking: agentId → Set<file> (dynamic, grows during execution)
  private agentLocks = new Map<string, Set<string>>();

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

    // 2. Start TCP server
    const port = await this.socketServer.start();
    console.log(`[scheduler] Listening on 127.0.0.1:${port}`);

    // 3. Wire up socket server events
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

    this.socketServer.on("task_completed", (agentId: string, taskId: string) => {
      this.handleTaskCompleted(agentId, taskId);
    });

    this.socketServer.on("task_failed", (agentId: string, taskId: string, reason: string) => {
      this.handleTaskFailed(agentId, taskId, reason);
    });

    this.socketServer.on("lock_request", (agentId: string, taskId: string, files: string[]) => {
      this.handleLockRequest(agentId, taskId, files);
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
      this.handleMergeRequired(task);
    });

    // 5. Start task watcher
    this.taskWatcher.start();
    console.log("[scheduler] Task watcher started");

    // 6. Start health monitor
    this.healthMonitor.start();
    console.log("[scheduler] Health monitor started");

    // 7. Scan for existing pending tasks
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
        // Dependency not resolved — leave pending
        return;
      }
    }

    // 1. Conflict check
    const conflictResult = this.conflictChecker.canAssign(task);
    if (!conflictResult.can_assign) {
      // Track what files this task is waiting for
      for (const file of task.target_files) {
        this.addWaitingTask(file, task.id);
      }

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
      // No idle agents — task stays pending, will be picked up when agent frees up
      return;
    }

    // 3. Check circuit breaker
    const complexity = task.target_files.length;
    const breakerResult = this.circuitBreaker.canAcceptTask(idleAgent, complexity);
    if (!breakerResult.can) {
      // This specific agent can't take it — try another or leave pending
      return;
    }

    // 4. Acquire locks (atomic two-phase commit) — skip if no target files
    let locks: string[] = [];
    if (task.target_files.length > 0) {
      const acquireResult = this.lockManager.acquire(task.id, idleAgent, task.target_files);
      if (!acquireResult.success) {
        // Lock conflict — track waiting and leave pending
        for (const file of task.target_files) {
          this.addWaitingTask(file, task.id);
        }
        return;
      }
      locks = acquireResult.locks?.map((l) => l.file) ?? [];
      // Track locks per agent
      this.agentLocks.set(idleAgent, new Set(locks));
    } else {
      // No files to lock — agent will discover and request locks dynamically
      this.agentLocks.set(idleAgent, new Set());
    }

    // 5. Update task state
    const updated = this.taskStore.updateTask(task.id, (t) => ({
      status: "in_progress",
      assigned_agent: idleAgent,
      metadata: {
        ...t.metadata,
        risk_level: conflictResult.risk_level ?? "low",
        warnings: conflictResult.warnings ?? [],
      },
    }));

    if (!updated) {
      // Version conflict — rollback locks
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

    // Release any locks held by this agent
    const released = this.lockManager.releaseAllForAgent(agentId);
    for (const file of released) {
      this.eventBus.emit("lock_released", file);
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

    // Release all locks
    const released = this.lockManager.releaseAllForAgent(agentId);
    for (const file of released) {
      this.eventBus.emit("lock_released", file);
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

  // ---- Task Lifecycle ----

  private handleTaskCompleted(agentId: string, taskId: string): void {
    const task = this.taskStore.getTask(taskId);
    if (!task) return;

    // Release all locks (from agent's tracked set, since files may be dynamic)
    const heldLocks = this.agentLocks.get(agentId);
    if (heldLocks) {
      for (const file of heldLocks) {
        this.lockManager.release(file);
        this.eventBus.emit("lock_released", file);
      }
      this.agentLocks.delete(agentId);
    }

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
      }
      this.agentLocks.delete(agentId);
    }

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
  }

  private handleMergeRequired(task: Task): void {
    // Merge will be handled by the merge driver (Phase 7)
    // For now, just emit the event
    this.eventBus.emit("merge_required", task.id, `agent/${task.id}`);
  }

  /**
   * Handle a lock_request from an agent: run conflict check + acquire locks
   * for the requested files, then respond with lock_granted or lock_denied.
   */
  private handleLockRequest(agentId: string, taskId: string, files: string[]): void {
    // Deduplicate and check which files the agent already has locked
    const currentLocks = this.agentLocks.get(agentId) ?? new Set();
    const newFiles = files.filter((f) => !currentLocks.has(f));

    if (newFiles.length === 0) {
      // All files already locked — grant immediately
      this.socketServer.sendLockGranted(agentId, taskId, files);
      return;
    }

    // Check conflicts for the new files
    const directConflict = this.lockManager.findConflict(newFiles);
    if (directConflict) {
      this.socketServer.sendLockDenied(
        agentId,
        taskId,
        [directConflict.file],
        `File "${directConflict.file}" is locked by agent "${directConflict.holder}"`
      );
      return;
    }

    // Acquire locks atomically
    const acquireResult = this.lockManager.acquire(taskId, agentId, newFiles);
    if (!acquireResult.success) {
      this.socketServer.sendLockDenied(agentId, taskId, newFiles, acquireResult.reason ?? "Lock acquisition failed");
      return;
    }

    // Track new locks
    const acquiredFiles = acquireResult.locks?.map((l) => l.file) ?? [];
    for (const file of acquiredFiles) {
      currentLocks.add(file);
    }
    this.agentLocks.set(agentId, currentLocks);

    // Grant the locks
    this.socketServer.sendLockGranted(agentId, taskId, files);
    console.log(`[scheduler] Lock request granted for agent ${agentId}: ${files.join(", ")}`);
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
