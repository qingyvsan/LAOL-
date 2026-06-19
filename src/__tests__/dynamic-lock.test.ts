import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { v4 as uuidv4 } from "uuid";
import { TaskStore } from "../task/task-store";
import { LockManager } from "../lock/lock-manager";
import { ConflictChecker } from "../scheduler/conflict-checker";
import type { Task } from "../data/models";

const tid = () => uuidv4();

/**
 * Dynamic Lock Tests
 *
 * Verify the new "discovery + dynamic lock expansion" workflow:
 * - Tasks with empty target_files can be created
 * - ConflictChecker returns can_assign: true for empty target_files
 * - LockManager.acquire rejects empty file list (guard)
 * - Task can be created and go through lifecycle without pre-declared files
 * - Multi-step lock acquisition works (acquire some, then more)
 */
describe("Dynamic Lock — Empty target_files support", () => {
  let tmpDir: string;
  let taskStore: TaskStore;
  let lockManager: LockManager;
  let conflictChecker: ConflictChecker;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "laol-dynlock-"));
    fs.mkdirSync(path.join(tmpDir, ".multiagent", "tasks"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, ".multiagent", "locks"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, ".multiagent", "staging"), { recursive: true });

    taskStore = new TaskStore(tmpDir);
    lockManager = new LockManager(tmpDir);
    conflictChecker = new ConflictChecker(lockManager);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- Task creation with empty target_files ---

  it("creates a task with empty target_files", () => {
    const task = taskStore.createTask({
      description: "Fix all TypeScript errors",
      target_files: [],
    });

    expect(task.target_files).toEqual([]);
    expect(task.status).toBe("pending");
  });

  it("round-trips a task with empty target_files through JSON", () => {
    const task = taskStore.createTask({
      description: "Refactor module",
      target_files: [],
    });

    const reloaded = taskStore.getTask(task.id);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.target_files).toEqual([]);
  });

  // --- Conflict checker with empty target_files ---

  it("conflict checker allows assignment when target_files is empty", () => {
    const task = taskStore.createTask({
      description: "Explore and fix",
      target_files: [],
    });

    const result = conflictChecker.canAssign(task);
    expect(result.can_assign).toBe(true);
    expect(result.risk_level).toBe("low");
  });

  it("conflict checker allows assignment for empty files even when other locks exist", () => {
    // Lock a file
    lockManager.acquire(tid(), "agent-other", ["src/existing.ts"]);

    const task = taskStore.createTask({
      description: "Explore and fix",
      target_files: [],
    });

    const result = conflictChecker.canAssign(task);
    // Empty target_files should pass even when other locks exist
    expect(result.can_assign).toBe(true);
  });

  // --- LockManager handles empty files ---

  it("lock manager rejects acquire with empty file list", () => {
    const result = lockManager.acquire(tid(), "agent-1", []);
    expect(result.success).toBe(false);
    expect(result.reason).toContain("No target files");
  });

  // --- Incremental lock acquisition ---

  it("can acquire locks incrementally (step 1 then step 2)", () => {
    const taskId = tid();
    const agentId = "agent-1";

    // Step 1: Acquire initial locks
    const r1 = lockManager.acquire(taskId, agentId, ["src/auth.ts"]);
    expect(r1.success).toBe(true);
    expect(r1.locks).toHaveLength(1);

    // Step 2: Acquire additional locks (same task, same agent)
    const r2 = lockManager.acquire(taskId, agentId, ["src/utils.ts"]);
    expect(r2.success).toBe(true);
    expect(r2.locks).toHaveLength(1);

    // Both files should be locked
    expect(lockManager.isLocked("src/auth.ts")).toBe(true);
    expect(lockManager.isLocked("src/utils.ts")).toBe(true);
  });

  it("incremental lock acquisition fails if file already locked by another agent", () => {
    const taskId = tid();

    // Agent A locks auth.ts
    const r1 = lockManager.acquire(tid(), "agent-a", ["src/auth.ts"]);
    expect(r1.success).toBe(true);

    // Agent B tries to lock auth.ts (should fail)
    const r2 = lockManager.acquire(taskId, "agent-b", ["src/auth.ts"]);
    expect(r2.success).toBe(false);
    expect(r2.reason).toContain("already locked");
  });

  // --- Task lifecycle with empty → filled target_files ---

  it("task goes through lifecycle: empty files → discovery → filled files", () => {
    // Create task without files
    const task = taskStore.createTask({
      description: "Discover and fix",
      target_files: [],
    });

    expect(task.target_files).toEqual([]);

    // Conflict check passes
    const check = conflictChecker.canAssign(task);
    expect(check.can_assign).toBe(true);

    // Assign to agent (no locks needed for empty files)
    const updated = taskStore.updateTask(task.id, () => ({
      status: "in_progress",
      assigned_agent: "agent-1",
    }));
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("in_progress");

    // Simulate discovery: acquire locks for discovered files
    const acquireResult = lockManager.acquire(task.id, "agent-1", ["src/module.ts", "src/module.test.ts"]);
    expect(acquireResult.success).toBe(true);

    // Complete with discovered files
    const completed = taskStore.updateTask(task.id, () => ({
      status: "done",
      target_files: ["src/module.ts", "src/module.test.ts"],
      updated_at: Date.now(),
    }));
    expect(completed).not.toBeNull();
    expect(completed!.status).toBe("done");
    expect(completed!.target_files).toEqual(["src/module.ts", "src/module.test.ts"]);

    // Locks released
    lockManager.release("src/module.ts");
    lockManager.release("src/module.test.ts");
    expect(lockManager.isLocked("src/module.ts")).toBe(false);
    expect(lockManager.isLocked("src/module.test.ts")).toBe(false);
  });

  // --- Concurrent discovery tasks don't block each other ---

  it("two empty-file tasks can both be assigned without blocking each other", () => {
    const taskA = taskStore.createTask({ description: "Fix A", target_files: [] });
    const taskB = taskStore.createTask({ description: "Fix B", target_files: [] });

    // Both should pass conflict check
    expect(conflictChecker.canAssign(taskA).can_assign).toBe(true);
    expect(conflictChecker.canAssign(taskB).can_assign).toBe(true);

    // Both can be assigned
    const updatedA = taskStore.updateTask(taskA.id, () => ({
      status: "in_progress",
      assigned_agent: "agent-1",
    }));
    const updatedB = taskStore.updateTask(taskB.id, () => ({
      status: "in_progress",
      assigned_agent: "agent-2",
    }));
    expect(updatedA).not.toBeNull();
    expect(updatedB).not.toBeNull();

    // Agent A discovers file X, Agent B discovers file Y — no conflict
    lockManager.acquire(taskA.id, "agent-1", ["src/x.ts"]);
    lockManager.acquire(taskB.id, "agent-2", ["src/y.ts"]);
    expect(lockManager.isLocked("src/x.ts")).toBe(true);
    expect(lockManager.isLocked("src/y.ts")).toBe(true);

    // Cleanup
    lockManager.release("src/x.ts");
    lockManager.release("src/y.ts");
  });

  it("discovered file conflict prevents second agent from locking same file", () => {
    const taskA = taskStore.createTask({ description: "Fix A", target_files: [] });
    const taskB = taskStore.createTask({ description: "Fix B", target_files: [] });

    // Agent 1 discovers and locks src/shared.ts
    const r1 = lockManager.acquire(taskA.id, "agent-1", ["src/shared.ts"]);
    expect(r1.success).toBe(true);

    // Agent 2 also discovers src/shared.ts — lock should fail
    const r2 = lockManager.acquire(taskB.id, "agent-2", ["src/shared.ts"]);
    expect(r2.success).toBe(false);
    expect(r2.reason).toContain("already locked");

    lockManager.release("src/shared.ts");
  });
});
