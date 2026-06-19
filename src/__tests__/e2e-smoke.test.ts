import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import { v4 as uuidv4 } from "uuid";
import { TaskStore } from "../task/task-store";
import { LockManager } from "../lock/lock-manager";
import { LeaseManager } from "../lock/lease-manager";
import { ConflictChecker } from "../scheduler/conflict-checker";
import { AgentWorker } from "../agent/agent-worker";
import { EventBus } from "../events/event-bus";
import type { Task } from "../data/models";

const SHELL = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "/bin/sh";
const tid = () => uuidv4();

/**
 * End-to-End Smoke Tests
 *
 * Full pipeline verification in a real git repository with
 * programmatic orchestration (no TCP layer). Verifies the
 * task state machine, lock acquisition/release, and conflict
 * detection work together correctly.
 */
describe("E2E Smoke — full pipeline", () => {
  let repoDir: string;
  let taskStore: TaskStore;
  let lockManager: LockManager;
  let leaseManager: LeaseManager;
  let conflictChecker: ConflictChecker;
  let eventBus: EventBus;

  beforeEach(() => {
    // Create a real git repo with source files
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "laol-e2e-"));
    execSync("git init --initial-branch=main", { cwd: repoDir, stdio: "pipe", timeout: 10_000, shell: SHELL });
    execSync('git config user.email "e2e@test.com"', { cwd: repoDir, stdio: "pipe", timeout: 5000, shell: SHELL });
    execSync('git config user.name "E2E Test"', { cwd: repoDir, stdio: "pipe", timeout: 5000, shell: SHELL });

    // Create initial source files
    fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "src", "auth.ts"), 'export function login() { return "old"; }\n', "utf-8");
    fs.writeFileSync(path.join(repoDir, "src", "db.ts"), 'export function connect() { return null; }\n', "utf-8");
    fs.writeFileSync(path.join(repoDir, "src", "utils.ts"), 'export const version = "1.0";\n', "utf-8");
    fs.writeFileSync(path.join(repoDir, "README.md"), "# Test Repo\n", "utf-8");

    execSync("git add -A", { cwd: repoDir, stdio: "pipe", timeout: 5000, shell: SHELL });
    execSync('git commit -m "initial"', { cwd: repoDir, stdio: "pipe", timeout: 5000, shell: SHELL });

    // Create .multiagent/ directories
    for (const sub of ["tasks", "locks", "staging", "wal", "warnings", "worktrees"]) {
      fs.mkdirSync(path.join(repoDir, ".multiagent", sub), { recursive: true });
    }
    fs.writeFileSync(
      path.join(repoDir, ".multiagent", "config.json"),
      JSON.stringify({
        scheduler: { port: 9123, pool_size: 4 },
        agent: { heartbeat_interval_ms: 25000, checkpoint_min_interval_ms: 30000, perception_check_interval_ms: 15000 },
        locks: { initial_ttl_ms: 60000, stable_ttl_ms: 180000, stable_threshold: 2, probe_timeout_ms: 45000 },
        claude_executor: { binary_path: "claude", timeout_seconds: 300, max_budget_usd: 5, allowed_tools: ["Read"], effort: "high", skip_permissions: true },
        merge_checks: [],
        merge_driver: "ai-merge",
        merge_driver_config: { same_function_strategy: "always_llm", cache_size: 100, cache_ttl: 300, quorum_enabled: false },
        llm: { provider: "claude", api_key_env: "KEY", model: "claude-sonnet-4-6" },
      } as any, null, 2),
      "utf-8"
    );

    taskStore = new TaskStore(repoDir);
    lockManager = new LockManager(repoDir);
    leaseManager = new LeaseManager(lockManager, {
      initialTtlMs: 60000,
      stableTtlMs: 180000,
      stableThreshold: 2,
      probeTimeoutMs: 45000,
    });
    conflictChecker = new ConflictChecker(lockManager);
    eventBus = new EventBus();
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  // ---- Helpers ----

  function makeMockSocketClient() {
    return {
      notifyTaskDone: vi.fn(),
      notifyTaskFailed: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
      sendHeartbeat: vi.fn(),
      isConnected: true,
      on: vi.fn(),
      off: vi.fn(),
    };
  }

  function makeMockWorktreePool() {
    return {
      acquire: vi.fn().mockReturnValue({ path: repoDir, branch: "agent/test" }),
      release: vi.fn(),
      initialize: vi.fn(),
      stats: vi.fn().mockReturnValue({ total: 1, available: 0, inUse: 1 }),
      getWorktree: vi.fn().mockReturnValue(repoDir),
      shutdown: vi.fn(),
    };
  }

  function makeMockRegistry() {
    return { updateEntry: vi.fn() };
  }

  function makeTask(files: string[], description: string): Task {
    return taskStore.createTask({ description, target_files: files });
  }

  // ---- Tests ----

  it("single task: pending → in_progress → done (full pipeline)", async () => {
    const task = makeTask(["src/auth.ts"], "Update login function");

    // Verify initial state
    expect(task.status).toBe("pending");

    // Conflict check — should pass
    const conflictResult = conflictChecker.canAssign(task);
    expect(conflictResult.can_assign).toBe(true);

    // Acquire locks
    const lockResult = lockManager.acquire(task.id, "agent-1", task.target_files);
    expect(lockResult.success).toBe(true);

    // Transition task to in_progress
    taskStore.updateTask(task.id, () => ({
      status: "in_progress",
      assigned_agent: "agent-1",
    }));
    const inProgress = taskStore.getTask(task.id);
    expect(inProgress!.status).toBe("in_progress");

    // Create AgentWorker with mock executor that modifies the target file
    const socketClient = makeMockSocketClient();
    const worktreePool = makeMockWorktreePool();
    const registry = makeMockRegistry();

    const worker = new AgentWorker(
      repoDir, "agent-1",
      taskStore, lockManager, leaseManager,
      worktreePool as any, socketClient as any, registry as any
    );

    // Executor: modify the file (simulating AI work)
    const executor = vi.fn().mockImplementation(async (worktreePath: string) => {
      const filePath = path.join(worktreePath, "src", "auth.ts");
      fs.writeFileSync(filePath, 'export function login() { return "new"; }\n', "utf-8");
    });

    await worker.executeTask(inProgress!, executor);

    // Verify final state
    const finalTask = taskStore.getTask(task.id);
    expect(finalTask!.status).toBe("done");

    // Verify file was actually modified
    const fileContent = fs.readFileSync(path.join(repoDir, "src", "auth.ts"), "utf-8");
    expect(fileContent).toContain('return "new"');

    // Locks should be released
    expect(lockManager.isLocked("src/auth.ts")).toBe(false);

    // Scheduler should be notified
    expect(socketClient.notifyTaskDone).toHaveBeenCalledWith(task.id);
  });

  it("two non-conflicting tasks can both acquire locks", () => {
    const taskA = makeTask(["src/auth.ts"], "Update auth");
    const taskB = makeTask(["src/db.ts"], "Update db");

    // Both should pass conflict check
    expect(conflictChecker.canAssign(taskA).can_assign).toBe(true);
    expect(conflictChecker.canAssign(taskB).can_assign).toBe(true);

    // Both can acquire locks
    const lockA = lockManager.acquire(taskA.id, "agent-1", taskA.target_files);
    expect(lockA.success).toBe(true);

    const lockB = lockManager.acquire(taskB.id, "agent-2", taskB.target_files);
    expect(lockB.success).toBe(true);

    // Each lock is independent
    expect(lockManager.isLocked("src/auth.ts")).toBe(true);
    expect(lockManager.isLocked("src/db.ts")).toBe(true);
    expect(lockManager.findConflict(["src/auth.ts"])).not.toBeNull();
    expect(lockManager.findConflict(["src/db.ts"])).not.toBeNull();
  });

  it("conflicting tasks: second task blocked until first releases", () => {
    const taskA = makeTask(["src/auth.ts"], "Update auth");
    const taskB = makeTask(["src/auth.ts"], "Also modify auth");

    // Task A acquires lock
    const lockA = lockManager.acquire(taskA.id, "agent-1", taskA.target_files);
    expect(lockA.success).toBe(true);

    // Task B should be blocked by conflict check
    const conflictB = conflictChecker.canAssign(taskB);
    expect(conflictB.can_assign).toBe(false);
    expect(conflictB.reason).toContain("locked");

    // Task B cannot acquire locks
    const lockB = lockManager.acquire(taskB.id, "agent-2", taskB.target_files);
    expect(lockB.success).toBe(false);

    // Task A releases
    lockManager.releaseAllForAgent("agent-1");
    expect(lockManager.isLocked("src/auth.ts")).toBe(false);

    // Now Task B can acquire
    const lockB2 = lockManager.acquire(taskB.id, "agent-2", taskB.target_files);
    expect(lockB2.success).toBe(true);
  });

  it("task lifecycle: created → assigned → lock → execute → done", async () => {
    // 1. Create task
    const task = makeTask(["src/utils.ts"], "Update version to 2.0");
    expect(task.status).toBe("pending");

    // 2. Conflict check
    const check = conflictChecker.canAssign(task);
    expect(check.can_assign).toBe(true);

    // 3. Acquire locks
    const acquired = lockManager.acquire(task.id, "agent-1", task.target_files);
    expect(acquired.success).toBe(true);

    // 4. Assign to agent (transition to in_progress)
    taskStore.updateTask(task.id, () => ({
      status: "in_progress",
      assigned_agent: "agent-1",
    }));
    expect(taskStore.getTask(task.id)!.status).toBe("in_progress");

    // 5. Create worker and execute
    const worker = new AgentWorker(
      repoDir, "agent-1",
      taskStore, lockManager, leaseManager,
      makeMockWorktreePool() as any,
      makeMockSocketClient() as any,
      makeMockRegistry() as any
    );

    const updated = taskStore.getTask(task.id);
    await worker.executeTask(updated!, vi.fn().mockResolvedValue(undefined));

    // 6. Verify done
    expect(taskStore.getTask(task.id)!.status).toBe("done");
  });

  it("failed task: executor throws → task failed → lock released → other tasks unblocked", async () => {
    // Task A: will fail
    const taskA = makeTask(["src/auth.ts"], "Task that will fail");

    lockManager.acquire(taskA.id, "agent-1", taskA.target_files);
    taskStore.updateTask(taskA.id, () => ({
      status: "in_progress",
      assigned_agent: "agent-1",
    }));

    const socketClient = makeMockSocketClient();
    const worker = new AgentWorker(
      repoDir, "agent-1",
      taskStore, lockManager, leaseManager,
      makeMockWorktreePool() as any, socketClient as any, makeMockRegistry() as any
    );

    // Executor throws
    await worker.executeTask(
      taskStore.getTask(taskA.id)!,
      vi.fn().mockRejectedValue(new Error("TypeError in auth.ts"))
    );

    // Task marked as failed
    const failedTask = taskStore.getTask(taskA.id);
    expect(failedTask!.status).toBe("failed");

    // Scheduler notified of failure
    expect(socketClient.notifyTaskFailed).toHaveBeenCalledWith(
      taskA.id,
      expect.stringContaining("TypeError")
    );

    // Locks released — other tasks can now acquire
    expect(lockManager.isLocked("src/auth.ts")).toBe(false);

    // Task B: can now use the previously locked file
    const taskB = makeTask(["src/auth.ts"], "Fix the auth bug");
    const lockB = lockManager.acquire(taskB.id, "agent-2", taskB.target_files);
    expect(lockB.success).toBe(true);
  });

  it("dependency task: child waits until parent is done", () => {
    // Create parent task
    const parent = makeTask(["src/auth.ts"], "Parent: update auth module");
    taskStore.updateTask(parent.id, () => ({ status: "done" }));

    // Create child task with dependency
    const child = taskStore.createTask({
      description: "Child: depends on auth update",
      target_files: ["src/auth.ts", "src/utils.ts"],
      dependency: parent.id,
    });

    // A scheduler would check: is dependency done?
    const depTask = taskStore.getTask(parent.id);
    const canAssign = depTask && depTask.status === "done" &&
      conflictChecker.canAssign(child).can_assign;

    expect(canAssign).toBe(true);
  });

  it("orphan dependency blocks task assignment", () => {
    const nonExistentId = tid();

    const child = taskStore.createTask({
      description: "Orphan child task",
      target_files: ["src/db.ts"],
      dependency: nonExistentId,
    });

    // Dependency doesn't exist → should be skipped
    const depTask = taskStore.getTask(nonExistentId);
    const shouldSkip = !depTask || depTask.status !== "done";
    expect(shouldSkip).toBe(true);
  });

  // --- Discovery mode (empty target_files) ---

  it("discovery mode: task with empty target_files → discovery → lock → execute → done", () => {
    // Create task without pre-declared files
    const task = taskStore.createTask({
      description: "Discover which files need auth refactoring",
      target_files: [],
    });

    expect(task.target_files).toEqual([]);

    // Conflict check passes
    const check = conflictChecker.canAssign(task);
    expect(check.can_assign).toBe(true);

    // Mark in_progress (scheduler assigns without locks)
    const assigned = taskStore.updateTask(task.id, () => ({
      status: "in_progress",
      assigned_agent: "agent-1",
    }));
    expect(assigned).not.toBeNull();

    // Agent discovers files and acquires locks
    const discoveredFiles = ["src/auth.ts", "src/auth.test.ts", "src/utils.ts"];
    const lockResult = lockManager.acquire(task.id, "agent-1", discoveredFiles);
    expect(lockResult.success).toBe(true);

    // Execute work (simulated)
    expect(lockManager.isLocked("src/auth.ts")).toBe(true);
    expect(lockManager.isLocked("src/auth.test.ts")).toBe(true);
    expect(lockManager.isLocked("src/utils.ts")).toBe(true);

    // Release and complete
    for (const f of discoveredFiles) {
      lockManager.release(f);
    }

    const done = taskStore.updateTask(task.id, () => ({
      status: "done",
      target_files: discoveredFiles,
      updated_at: Date.now(),
    }));
    expect(done).not.toBeNull();
    expect(done!.status).toBe("done");
    expect(done!.target_files).toEqual(discoveredFiles);
  });

  it("discovery mode: two agents discover different files — no conflict", () => {
    const taskA = taskStore.createTask({ description: "Fix A", target_files: [] });
    const taskB = taskStore.createTask({ description: "Fix B", target_files: [] });

    // Both tasks can be assigned
    taskStore.updateTask(taskA.id, () => ({ status: "in_progress", assigned_agent: "agent-1" }));
    taskStore.updateTask(taskB.id, () => ({ status: "in_progress", assigned_agent: "agent-2" }));

    // Agent 1 discovers and locks files in module A
    const lockA = lockManager.acquire(taskA.id, "agent-1", ["src/moduleA/x.ts"]);
    expect(lockA.success).toBe(true);

    // Agent 2 discovers and locks files in module B — no conflict
    const lockB = lockManager.acquire(taskB.id, "agent-2", ["src/moduleB/y.ts"]);
    expect(lockB.success).toBe(true);

    // Cleanup
    lockManager.release("src/moduleA/x.ts");
    lockManager.release("src/moduleB/y.ts");
  });

  it("discovery mode: agent discovers file already locked by other → denied", () => {
    const taskA = taskStore.createTask({ description: "Fix A", target_files: ["src/shared.ts"] });
    const taskB = taskStore.createTask({ description: "Fix B", target_files: [] });

    // Task A locks shared file immediately
    lockManager.acquire(taskA.id, "agent-1", ["src/shared.ts"]);

    // Task B is assigned
    taskStore.updateTask(taskB.id, () => ({ status: "in_progress", assigned_agent: "agent-2" }));

    // Agent 2 discovers shared.ts — should be denied
    const conflictB = lockManager.acquire(taskB.id, "agent-2", ["src/shared.ts"]);
    expect(conflictB.success).toBe(false);
    expect(conflictB.reason).toContain("already locked");

    // But can lock non-conflicting files
    const okB = lockManager.acquire(taskB.id, "agent-2", ["src/other.ts"]);
    expect(okB.success).toBe(true);

    // Cleanup
    lockManager.release("src/shared.ts");
    lockManager.release("src/other.ts");
  });
});
