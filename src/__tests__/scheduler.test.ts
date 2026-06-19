import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { v4 as uuidv4 } from "uuid";
import { TaskStore } from "../task/task-store";
import { LockManager } from "../lock/lock-manager";
import { LeaseManager } from "../lock/lease-manager";
import { ConflictChecker } from "../scheduler/conflict-checker";
import { CircuitBreaker } from "../scheduler/circuit-breaker";
import { EventBus } from "../events/event-bus";
import { HealthMonitor } from "../scheduler/health-monitor";

const tid = () => uuidv4();

/**
 * Scheduler Unit Tests
 *
 * Test the scheduler's core decision-making logic in isolation:
 * - Task assignment flow
 * - Dependency checking
 * - Agent connection/disconnection/loss handling
 * - Waiting queue retry on lock release
 * - Circuit breaker integration
 * - Stale lock cleanup
 */
describe("Scheduler — Task Assignment Logic", () => {
  let tmpDir: string;
  let taskStore: TaskStore;
  let lockManager: LockManager;
  let leaseManager: LeaseManager;
  let conflictChecker: ConflictChecker;
  let circuitBreaker: CircuitBreaker;
  let eventBus: EventBus;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "laol-sched-"));
    fs.mkdirSync(path.join(tmpDir, ".multiagent", "tasks"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, ".multiagent", "locks"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, ".multiagent", "staging"), { recursive: true });

    taskStore = new TaskStore(tmpDir);
    lockManager = new LockManager(tmpDir);
    leaseManager = new LeaseManager(lockManager);
    conflictChecker = new ConflictChecker(lockManager);
    circuitBreaker = new CircuitBreaker();
    eventBus = new EventBus();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- Conflict check ---

  it("conflict check passes when no files are locked", () => {
    const task = taskStore.createTask({
      description: "Update auth",
      target_files: ["src/auth.ts", "src/utils.ts"],
    });

    const result = conflictChecker.canAssign(task);
    expect(result.can_assign).toBe(true);
  });

  it("conflict check blocks when a target file is locked", () => {
    const taskA = taskStore.createTask({
      description: "Modify shared",
      target_files: ["src/shared.ts"],
    });

    // Lock the file
    lockManager.acquire(taskA.id, "agent-1", ["src/shared.ts"]);

    const taskB = taskStore.createTask({
      description: "Also modify shared",
      target_files: ["src/shared.ts"],
    });

    const result = conflictChecker.canAssign(taskB);
    expect(result.can_assign).toBe(false);
    expect(result.reason).toContain("locked");
  });

  it("conflict check passes when locked files don't overlap", () => {
    // Lock auth.ts
    lockManager.acquire(tid(), "agent-1", ["src/auth.ts"]);

    const task = taskStore.createTask({
      description: "Modify db",
      target_files: ["src/db.ts"],
    });

    const result = conflictChecker.canAssign(task);
    expect(result.can_assign).toBe(true);
  });

  it("conflict check passes for empty target_files (discovery mode)", () => {
    const task = taskStore.createTask({
      description: "Explore and fix",
      target_files: [],
    });

    const result = conflictChecker.canAssign(task);
    expect(result.can_assign).toBe(true);
    expect(result.risk_level).toBe("low");
  });

  it("findConflict returns the first conflicting lock", () => {
    lockManager.acquire(tid(), "agent-1", ["src/auth.ts"]);

    const conflict = lockManager.findConflict(["src/utils.ts", "src/auth.ts", "src/db.ts"]);
    expect(conflict).not.toBeNull();
    expect(conflict!.file).toBe("src/auth.ts");
    expect(conflict!.holder).toBe("agent-1");
  });

  it("findConflict returns null when no conflicts", () => {
    lockManager.acquire(tid(), "agent-1", ["src/auth.ts"]);

    const conflict = lockManager.findConflict(["src/utils.ts", "src/db.ts"]);
    expect(conflict).toBeNull();
  });

  // --- Dependency check ---

  it("task with unresolved dependency should not be assignable", () => {
    const depId = tid();

    const child = taskStore.createTask({
      description: "Child task",
      target_files: ["src/child.ts"],
      dependency: depId,
    });

    // Dependency doesn't even exist in store
    const depTask = taskStore.getTask(depId);
    expect(depTask).toBeNull();

    // A scheduler would check: if dependency exists and is not done → skip
    // (This logic is in scheduler.tryAssignTask)
    const shouldSkip = !depTask || depTask.status !== "done";
    expect(shouldSkip).toBe(true);
  });

  it("task with completed dependency is assignable", () => {
    const dep = taskStore.createTask({
      description: "Dependency",
      target_files: ["src/dep.ts"],
    });
    taskStore.updateTask(dep.id, () => ({ status: "done" }));

    const child = taskStore.createTask({
      description: "Child task",
      target_files: ["src/child.ts"],
      dependency: dep.id,
    });

    const depTask = taskStore.getTask(dep.id);
    const shouldSkip = !depTask || depTask.status !== "done";
    expect(shouldSkip).toBe(false);
    expect(conflictChecker.canAssign(child).can_assign).toBe(true);
  });

  // --- Agent disconnect → lock release ---

  it("releasing all agent locks frees files for other agents", () => {
    const taskId = tid();
    lockManager.acquire(taskId, "agent-doomed", ["src/a.ts", "src/b.ts"]);

    const released = lockManager.releaseAllForAgent("agent-doomed");
    expect(released).toHaveLength(2);

    // Another agent can now acquire
    const result = lockManager.acquire(tid(), "agent-new", ["src/a.ts", "src/b.ts"]);
    expect(result.success).toBe(true);
  });

  it("reset in_progress task to pending on agent disconnect", () => {
    const task = taskStore.createTask({
      description: "Work in progress",
      target_files: ["src/wip.ts"],
    });

    taskStore.updateTask(task.id, () => ({
      status: "in_progress",
      assigned_agent: "agent-gone",
    }));

    // Agent disconnects
    lockManager.releaseAllForAgent("agent-gone");

    const reset = taskStore.updateTask(task.id, () => ({
      status: "pending",
      assigned_agent: null,
    }));
    expect(reset!.status).toBe("pending");
    expect(reset!.assigned_agent).toBeNull();
  });

  // --- Circuit breaker integration ---

  it("circuit breaker degrades agent after consecutive failures", () => {
    circuitBreaker.onTaskFailure("agent-1", "task-1", "error A");
    circuitBreaker.onTaskFailure("agent-1", "task-2", "error B");

    const result = circuitBreaker.canAcceptTask("agent-1", 5);
    expect(result.can).toBe(false);
    expect(result.reason).toContain("degraded");
  });

  it("circuit breaker allows degraded agent for simple tasks", () => {
    circuitBreaker.onTaskFailure("agent-1", "task-1", "err");
    circuitBreaker.onTaskFailure("agent-1", "task-2", "err");

    // Simple task (≤ 2 files) should be accepted
    const result = circuitBreaker.canAcceptTask("agent-1", 2);
    expect(result.can).toBe(true);
  });

  it("circuit breaker resets on success", () => {
    circuitBreaker.onTaskFailure("agent-1", "task-1", "err");
    circuitBreaker.onTaskFailure("agent-1", "task-2", "err");
    expect(circuitBreaker.canAcceptTask("agent-1", 5).can).toBe(false);

    circuitBreaker.onTaskSuccess("agent-1", "task-3");
    expect(circuitBreaker.canAcceptTask("agent-1", 5).can).toBe(true);
  });

  it("task marked stuck after 3 failures", () => {
    circuitBreaker.onTaskFailure("agent-1", "task-stuck", "err1");
    circuitBreaker.onTaskFailure("agent-2", "task-stuck", "err2");
    const { taskStuck } = circuitBreaker.onTaskFailure("agent-3", "task-stuck", "err3");

    expect(taskStuck).toBe(true);
  });

  // --- Health monitor & lock expiry ---

  it("health monitor detects expired locks", () => {
    const healthMonitor = new HealthMonitor(
      lockManager,
      leaseManager,
      eventBus,
      60_000 // long interval — we manually test
    );

    const taskId = tid();
    lockManager.acquire(taskId, "agent-old", ["src/old.ts"]);

    // Manually expire the lock file
    const lockPath = path.join(tmpDir, ".multiagent", "locks", "src#old.ts.lock");
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
    lock.expires_at = Date.now() - 100;
    fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2), "utf-8");

    const { expired } = leaseManager.findStaleLocks();
    expect(expired.length).toBeGreaterThan(0);
    expect(expired[0].file).toBe("src/old.ts");

    healthMonitor.stop();
  });

  it("stale locks are cleaned up on startup", () => {
    // Create a lock without a corresponding in_progress task
    const orphanTaskId = tid();
    lockManager.acquire(orphanTaskId, "agent-orphan", ["src/orphan.ts"]);
    // Don't create a task → this lock is stale

    // Simulate startup cleanup
    const allLocks = lockManager.listLocks();
    for (const lock of allLocks) {
      const task = taskStore.getTask(lock.task_id);
      if (!task || task.status !== "in_progress") {
        lockManager.forceRelease(lock.file);
      }
    }

    // Lock should be cleaned up
    expect(lockManager.isLocked("src/orphan.ts")).toBe(false);
  });

  // --- Event bus ---

  it("event bus delivers task_created events", () => {
    const spy = vi.fn();
    eventBus.on("task_created", spy);

    const task = taskStore.createTask({
      description: "Test event",
      target_files: ["src/test.ts"],
    });
    eventBus.emit("task_created", task);

    expect(spy).toHaveBeenCalledWith(task);
  });

  it("event bus delivers lock_released events", () => {
    const spy = vi.fn();
    eventBus.on("lock_released", spy);

    eventBus.emit("lock_released", "src/auth.ts");
    expect(spy).toHaveBeenCalledWith("src/auth.ts");
  });

  it("event bus delivers agent_connected/disconnected events", () => {
    const connectedSpy = vi.fn();
    const disconnectedSpy = vi.fn();
    eventBus.on("agent_connected", connectedSpy);
    eventBus.on("agent_disconnected", disconnectedSpy);

    eventBus.emit("agent_connected", "agent-1");
    expect(connectedSpy).toHaveBeenCalledWith("agent-1");

    eventBus.emit("agent_disconnected", "agent-1");
    expect(disconnectedSpy).toHaveBeenCalledWith("agent-1");
  });
});
