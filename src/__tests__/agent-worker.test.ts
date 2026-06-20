import { describe, it, expect, beforeEach, vi } from "vitest";
import { v4 as uuidv4 } from "uuid";
import type { Task, LaolConfig } from "../data/models";

// ---- Mutable mock state (hoisted so vi.mock factories can access) ----

const {
  perceptionCheckWarnings,
  perceptionGetContextSummary,
  checkpointCheckAndRebase,
  heartbeatStart,
  heartbeatStop,
  execSyncMock,
} = vi.hoisted(() => ({
  perceptionCheckWarnings: vi.fn<() => string | null>().mockReturnValue(null),
  perceptionGetContextSummary: vi.fn<() => string>().mockReturnValue(""),
  checkpointCheckAndRebase: vi.fn().mockReturnValue({ updated: false, skipped: false }),
  heartbeatStart: vi.fn(),
  heartbeatStop: vi.fn(),
  execSyncMock: vi.fn(),
}));

// ---- Module-level mocks (before imports) ----

vi.mock("node:child_process", () => ({
  execSync: execSyncMock,
}));

vi.mock("../agent/heartbeat", () => ({
  Heartbeat: vi.fn().mockImplementation(() => ({
    start: heartbeatStart,
    stop: heartbeatStop,
    setOnRenew: vi.fn(),
    setOnError: vi.fn(),
  })),
}));

vi.mock("../agent/checkpoint", () => ({
  Checkpoint: vi.fn().mockImplementation(() => ({
    checkAndRebase: checkpointCheckAndRebase,
    forceNextFetch: vi.fn(),
  })),
  RebaseConflictError: class RebaseConflictError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = "RebaseConflictError";
    }
  },
}));

vi.mock("../agent/perception", () => ({
  Perception: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    setOnWarning: vi.fn(),
    checkWarnings: perceptionCheckWarnings,
    getContextSummary: perceptionGetContextSummary,
  })),
}));

vi.mock("../config", () => ({
  loadConfig: vi.fn().mockReturnValue({
    scheduler: { port: 9123, pool_size: 4 },
    merge_checks: [],
    merge_driver: "ai-merge",
    merge_driver_config: {
      same_function_strategy: "always_llm",
      cache_size: 100,
      cache_ttl: 300,
      quorum_enabled: false,
    },
    llm: { provider: "claude", api_key_env: "ANTHROPIC_API_KEY", model: "claude-sonnet-4-6" },
    agent: {
      heartbeat_interval_ms: 25000,
      checkpoint_min_interval_ms: 30000,
      perception_check_interval_ms: 15000,
    },
    locks: { initial_ttl_ms: 60000, stable_ttl_ms: 180000, stable_threshold: 2, probe_timeout_ms: 45000 },
    claude_executor: {
      binary_path: "claude",
      timeout_seconds: 300,
      max_budget_usd: 5,
      allowed_tools: ["Read", "Write", "Edit"],
      effort: "high",
      skip_permissions: true,
    },
  } as LaolConfig),
}));

import { AgentWorker } from "../agent/agent-worker";
import { RebaseConflictError } from "../agent/checkpoint";

const tid = () => uuidv4();

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: tid(),
    status: "in_progress",
    description: "Test task",
    target_files: ["src/a.ts", "src/b.ts"],
    assigned_agent: "agent-test",
    created_at: Date.now(),
    updated_at: Date.now(),
    dependency: null,
    metadata: {},
    version: 1,
    ...overrides,
  };
}

function makeMocks() {
  return {
    taskStore: {
      updateTask: vi.fn().mockReturnValue({}),
      getTask: vi.fn(),
    },
    lockManager: {
      release: vi.fn().mockReturnValue(true),
      getLock: vi.fn(),
      listLocks: vi.fn().mockReturnValue([]),
    },
    leaseManager: {
      renewLease: vi.fn(),
      getHeartbeatInterval: vi.fn().mockReturnValue(25000),
      INITIAL_HEARTBEAT_MS: 15000,
    },
    worktreePool: {
      acquire: vi.fn().mockReturnValue({
        path: "/tmp/worktree/test",
        branch: "agent/test-branch",
      }),
      release: vi.fn(),
    },
    knowledgeStore: {
      save: vi.fn(),
      findRelevant: vi.fn().mockReturnValue([]),
      formatContext: vi.fn().mockReturnValue(null),
      loadAll: vi.fn().mockReturnValue([]),
    },
    socketClient: {
      notifyTaskDone: vi.fn(),
      notifyTaskFailed: vi.fn(),
    },
    registryManager: {
      updateEntry: vi.fn(),
    },
  };
}

/**
 * AgentWorker Lifecycle Tests
 *
 * Tests the full task execution lifecycle with mocked dependencies.
 * Uses module-level mock factories with mutable state for per-test overrides.
 */
describe("AgentWorker — lifecycle", () => {
  let mocks: ReturnType<typeof makeMocks>;
  let worker: AgentWorker;

  beforeEach(() => {
    vi.clearAllMocks();

    // Reset mutable mock state to defaults
    perceptionCheckWarnings.mockReturnValue(null);
    perceptionGetContextSummary.mockReturnValue("");
    checkpointCheckAndRebase.mockReturnValue({ updated: false, skipped: false });

    // Default execSync: return an object with toString() for git commands
    execSyncMock.mockImplementation((_cmd: string) => {
      return { toString: () => "" };
    });

    mocks = makeMocks();

    worker = new AgentWorker(
      "/tmp/repo",
      "agent-test",
      mocks.taskStore as any,
      mocks.lockManager as any,
      mocks.leaseManager as any,
      mocks.worktreePool as any,
      mocks.socketClient as any,
      mocks.registryManager as any,
      mocks.knowledgeStore as any
    );
  });

  // ---- Success path ----

  it("completes task successfully: executor → commit → done notification", async () => {
    const task = makeTask();
    const executor = vi.fn().mockResolvedValue(undefined);

    await worker.executeTask(task, executor);

    // Executor was called with worktree path, task, and context hints
    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor).toHaveBeenCalledWith(
      "/tmp/worktree/test",
      task,
      expect.any(Array)
    );

    // Task marked as done
    expect(mocks.taskStore.updateTask).toHaveBeenCalledWith(
      task.id,
      expect.any(Function)
    );

    // Scheduler notified
    expect(mocks.socketClient.notifyTaskDone).toHaveBeenCalledWith(task.id);

    // Locks released for all target files
    expect(mocks.lockManager.release).toHaveBeenCalledWith("src/a.ts");
    expect(mocks.lockManager.release).toHaveBeenCalledWith("src/b.ts");
    expect(mocks.lockManager.release).toHaveBeenCalledTimes(2);

    // Worktree released
    expect(mocks.worktreePool.release).toHaveBeenCalledWith(task.id);
  });

  it("acquires worktree before executor runs", async () => {
    const task = makeTask();
    await worker.executeTask(task, vi.fn().mockResolvedValue(undefined));
    expect(mocks.worktreePool.acquire).toHaveBeenCalledWith(task.id);
  });

  it("commits and pushes changes on success", async () => {
    const task = makeTask();

    // Mock git status to show changes
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd === "git status --porcelain") return { toString: () => "M src/a.ts" };
      return { toString: () => "" };
    });

    await worker.executeTask(task, vi.fn().mockResolvedValue(undefined));

    // git add -A should be called
    const addCalls = execSyncMock.mock.calls.filter((c: any[]) => c[0] === "git add -A");
    expect(addCalls.length).toBeGreaterThanOrEqual(1);

    // git commit should be called
    const commitCalls = execSyncMock.mock.calls.filter((c: any[]) =>
      (c[0] as string).startsWith("git commit")
    );
    expect(commitCalls.length).toBeGreaterThanOrEqual(1);

    // git push should be called
    const pushCalls = execSyncMock.mock.calls.filter((c: any[]) =>
      (c[0] as string).startsWith("git push")
    );
    expect(pushCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("updates registry for each target file on success", async () => {
    const task = makeTask();
    await worker.executeTask(task, vi.fn().mockResolvedValue(undefined));

    expect(mocks.registryManager.updateEntry).toHaveBeenCalledWith(
      "src/a.ts", "agent-test", expect.any(String)
    );
    expect(mocks.registryManager.updateEntry).toHaveBeenCalledWith(
      "src/b.ts", "agent-test", expect.any(String)
    );
  });

  // ---- Executor failure ----

  it("marks task as failed and notifies scheduler when executor throws", async () => {
    const task = makeTask();
    await worker.executeTask(task, vi.fn().mockRejectedValue(new Error("compilation failed")));

    expect(mocks.taskStore.updateTask).toHaveBeenCalledWith(task.id, expect.any(Function));
    expect(mocks.socketClient.notifyTaskFailed).toHaveBeenCalledWith(task.id, "compilation failed");
    expect(mocks.socketClient.notifyTaskDone).not.toHaveBeenCalled();
  });

  it("releases locks even when executor fails", async () => {
    const task = makeTask();
    await worker.executeTask(task, vi.fn().mockRejectedValue(new Error("boom")));

    expect(mocks.lockManager.release).toHaveBeenCalledWith("src/a.ts");
    expect(mocks.lockManager.release).toHaveBeenCalledWith("src/b.ts");
  });

  it("releases worktree even when executor fails", async () => {
    const task = makeTask();
    await worker.executeTask(task, vi.fn().mockRejectedValue(new Error("boom")));
    expect(mocks.worktreePool.release).toHaveBeenCalledWith(task.id);
  });

  // ---- Rebase conflict ----

  it("fails task with blocked_by_rebase status on rebase conflict", async () => {
    const task = makeTask();
    checkpointCheckAndRebase.mockImplementation(() => {
      throw new RebaseConflictError("Rebase conflict in src/a.ts");
    });

    const executor = vi.fn();
    await worker.executeTask(task, executor);

    // Executor should NOT have been called (rebase conflict before execution)
    expect(executor).not.toHaveBeenCalled();

    // Scheduler notified with the rebase conflict reason
    expect(mocks.socketClient.notifyTaskFailed).toHaveBeenCalledWith(
      task.id,
      expect.stringContaining("Rebase conflict")
    );
  });

  // ---- Perception warnings ----

  it("collects perception warnings and passes them to executor as context hints", async () => {
    const task = makeTask();
    perceptionCheckWarnings.mockReturnValue("Warning: shared module modified!");
    perceptionGetContextSummary.mockReturnValue("[Context] Active locks: src/utils.ts by agent-2");

    let capturedHints: string[] = [];
    const executor = vi.fn().mockImplementation((_path, _task, hints: string[]) => {
      capturedHints = hints;
      return Promise.resolve();
    });

    await worker.executeTask(task, executor);

    expect(capturedHints.some((h) => h.includes("Warning: shared module modified!"))).toBe(true);
    expect(capturedHints.some((h) => h.includes("Active locks"))).toBe(true);
  });

  it("does not include warning hint when no warnings", async () => {
    const task = makeTask();
    // Default mocks return null / empty

    let capturedHints: string[] = [];
    const executor = vi.fn().mockImplementation((_path, _task, hints: string[]) => {
      capturedHints = hints;
      return Promise.resolve();
    });

    await worker.executeTask(task, executor);

    const hasWarnings = capturedHints.some((h) =>
      h.includes("SEMANTIC WARNINGS") || h.includes("Active locks")
    );
    expect(hasWarnings).toBe(false);
  });

  // ---- Task state validation ----

  it("throws when task status is not in_progress", async () => {
    const task = makeTask({ status: "pending" });
    const executor = vi.fn();

    await worker.executeTask(task, executor);

    expect(executor).not.toHaveBeenCalled();
    expect(mocks.taskStore.updateTask).toHaveBeenCalledWith(task.id, expect.any(Function));
  });

  it("notifies scheduler on task state validation failure", async () => {
    const task = makeTask({ status: "done" });
    await worker.executeTask(task, vi.fn());

    expect(mocks.socketClient.notifyTaskFailed).toHaveBeenCalledWith(
      task.id,
      expect.stringContaining("not in_progress")
    );
  });

  // ---- Cleanup in finally block ----

  it("stops heartbeat and releases worktree on success", async () => {
    const task = makeTask();
    await worker.executeTask(task, vi.fn().mockResolvedValue(undefined));

    // Heartbeat stop should be called during cleanup
    expect(heartbeatStop).toHaveBeenCalled();
    // Worktree released
    expect(mocks.worktreePool.release).toHaveBeenCalledWith(task.id);
  });

  it("stops heartbeat and releases worktree on failure", async () => {
    const task = makeTask();
    await worker.executeTask(task, vi.fn().mockRejectedValue(new Error("fail")));

    expect(heartbeatStop).toHaveBeenCalled();
    expect(mocks.worktreePool.release).toHaveBeenCalledWith(task.id);
  });
});
