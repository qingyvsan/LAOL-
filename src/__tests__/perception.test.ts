import { describe, it, expect, beforeEach, vi } from "vitest";
import * as path from "node:path";

// ---- Mutable mock state (hoisted so vi.mock factories can access) ----

const {
  chokidarWatchOn,
  chokidarWatchClose,
} = vi.hoisted(() => ({
  chokidarWatchOn: vi.fn<(event: string, cb: (...args: any[]) => void) => any>()
    .mockReturnValue(undefined),
  chokidarWatchClose: vi.fn<() => Promise<void>>()
    .mockResolvedValue(undefined),
}));

// ---- Module-level mocks ----

vi.mock("chokidar", () => ({
  watch: vi.fn(() => ({
    on: chokidarWatchOn,
    close: chokidarWatchClose,
  })),
  FSWatcher: class MockFSWatcher {},
}));

import { Perception } from "../agent/perception";

describe("Perception", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---- Construction ----

  it("stores repoRoot, taskId, and targetFiles on construction", () => {
    const p = new Perception("/tmp/repo", "task-123", ["src/a.ts", "src/b.ts"]);
    // Constructor succeeded — verify via start() which uses these values
    expect(p).toBeInstanceOf(Perception);
  });

  // ---- start() ----

  it("start() creates a chokidar watcher on the .multiagent/locks/ directory", async () => {
    const { watch } = await import("chokidar");
    const p = new Perception("/tmp/repo", "task-abc", ["src/module/file.ts"]);
    p.start();

    expect(watch).toHaveBeenCalledWith(
      path.join("/tmp/repo", ".multiagent", "locks"),
      expect.objectContaining({
        persistent: true,
        ignoreInitial: true,
      })
    );
  });

  it("start() does not create a second watcher if already started", async () => {
    const { watch } = await import("chokidar");
    const p = new Perception("/tmp/repo", "task-abc", ["src/app.ts"]);
    p.start();
    p.start();
    expect(watch).toHaveBeenCalledTimes(1);
  });

  it("start() registers an 'add' handler for lock file events", async () => {
    const p = new Perception("/tmp/repo", "task-abc", ["src/app/index.ts"]);
    p.start();

    expect(chokidarWatchOn).toHaveBeenCalledWith("add", expect.any(Function));
  });

  it("start() registers an 'error' handler", async () => {
    const p = new Perception("/tmp/repo", "task-abc", []);
    p.start();

    expect(chokidarWatchOn).toHaveBeenCalledWith("error", expect.any(Function));
  });

  // ---- Lock detection ----

  it("logs warning when another agent locks a file in the same module directory", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const p = new Perception("/tmp/repo", "task-abc", [
      "src/auth/login.ts",
      "src/auth/register.ts",
    ]);
    p.start();

    // Get the 'add' callback and simulate a lock file appearing
    const addCall = chokidarWatchOn.mock.calls.find((c: any[]) => c[0] === "add");
    expect(addCall).toBeDefined();
    const addHandler = addCall![1] as (lockPath: string) => void;

    // Simulate a lock file for another file in src/auth/
    const lockPath = path.join("/tmp/repo", ".multiagent", "locks", "src#auth#logout.ts.lock");
    addHandler(lockPath);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Another agent is now modifying")
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("src/auth/logout.ts")
    );

    warnSpy.mockRestore();
  });

  it("does not log warning when lock belongs to the agent's own target file", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const p = new Perception("/tmp/repo", "task-abc", [
      "src/auth/login.ts",
    ]);
    p.start();

    const addCall = chokidarWatchOn.mock.calls.find((c: any[]) => c[0] === "add");
    const addHandler = addCall![1] as (lockPath: string) => void;

    // Lock for a file that IS the agent's target file — no warning
    const lockPath = path.join("/tmp/repo", ".multiagent", "locks", "src#auth#login.ts.lock");
    addHandler(lockPath);

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("does not log warning when lock is in a different module directory", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const p = new Perception("/tmp/repo", "task-abc", [
      "src/auth/login.ts",
    ]);
    p.start();

    const addCall = chokidarWatchOn.mock.calls.find((c: any[]) => c[0] === "add");
    const addHandler = addCall![1] as (lockPath: string) => void;

    // Lock for a file in a completely different module directory
    const lockPath = path.join("/tmp/repo", ".multiagent", "locks", "src#utils#helpers.ts.lock");
    addHandler(lockPath);

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("logs chokidar errors to console.error", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const p = new Perception("/tmp/repo", "task-abc", []);
    p.start();

    const errorCall = chokidarWatchOn.mock.calls.find((c: any[]) => c[0] === "error");
    expect(errorCall).toBeDefined();
    const errorHandler = errorCall![1] as (err: Error) => void;

    errorHandler(new Error("Watch failed"));

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[perception] Watch error: Watch failed")
    );

    errorSpy.mockRestore();
  });

  // ---- stop() ----

  it("stop() closes the chokidar watcher", async () => {
    const p = new Perception("/tmp/repo", "task-abc", ["src/app.ts"]);
    p.start();

    await p.stop();

    expect(chokidarWatchClose).toHaveBeenCalled();
  });

  it("stop() is a no-op if not started", async () => {
    const p = new Perception("/tmp/repo", "task-abc", ["src/app.ts"]);
    await p.stop();
    // should not throw
    expect(chokidarWatchClose).not.toHaveBeenCalled();
  });

  it("stop() sets watcher to null so start() can be called again", async () => {
    const { watch } = await import("chokidar");
    const p = new Perception("/tmp/repo", "task-abc", ["src/app.ts"]);
    p.start();
    expect(watch).toHaveBeenCalledTimes(1);

    await p.stop();

    // Start again — should create a new watcher
    p.start();
    expect(watch).toHaveBeenCalledTimes(2);
  });
});
