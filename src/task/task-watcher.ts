import * as path from "node:path";
import { watch, FSWatcher } from "chokidar";
import { EventBus } from "../events/event-bus";
import { TaskStore } from "./task-store";
import type { Task } from "../data/models";

/**
 * Task Watcher — monitors tasks/ directory with chokidar.
 *
 * When task JSON files are created, changed, or removed,
 * the watcher reads/validates the file and emits typed events
 * via the EventBus, enabling the scheduler to be fully event-driven.
 */

export class TaskWatcher {
  private watcher: FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private taskStore: TaskStore;
  private eventBus: EventBus;
  private tasksDir: string;

  constructor(repoRoot: string, taskStore: TaskStore, eventBus: EventBus) {
    this.tasksDir = path.join(repoRoot, ".multiagent", "tasks");
    this.taskStore = taskStore;
    this.eventBus = eventBus;
  }

  /**
   * Start watching the tasks/ directory.
   * Returns the chokidar watcher instance for lifecycle management.
   */
  start(): FSWatcher {
    if (this.watcher) {
      return this.watcher;
    }

    this.watcher = watch(this.tasksDir, {
      // Only ignore files whose basename starts with "." (dotfiles / temp files).
      // IMPORTANT: the old regex /(^|[\/\\])\../ also matched directories like
      // ".multiagent" (the "\.m" after "\" in the path), causing chokidar to
      // silently ignore the entire tasks/ directory. Using a function avoids this.
      ignored: (testPath: string) => path.basename(testPath).startsWith("."),
      persistent: true,
      ignoreInitial: true, // don't fire for existing files on start
      awaitWriteFinish: {
        stabilityThreshold: 200, // wait for writes to settle
        pollInterval: 50,
      },
    });

    // Safety-net fallback: periodically rescan for pending tasks.
    // On Windows/NTFS, chokidar may occasionally miss atomic-rename events,
    // and atomicWrite (tmp → renameSync) can be invisible on some file systems.
    // A cheap directory listing every few seconds guarantees no task is missed.
    this.pollTimer = setInterval(() => {
      const pending = this.taskStore.listTasks({ status: "pending" });
      for (const task of pending) {
        this.eventBus.emit("task_created", task);
      }
    }, 5000);

    // ---- Event handlers ----

    this.watcher.on("add", (filePath: string) => {
      if (!filePath.endsWith(".json")) return;

      const task = this.taskStore.getTask(this.extractId(filePath));
      if (task) {
        this.eventBus.emit("task_created", task);
      }
    });

    this.watcher.on("change", (filePath: string) => {
      if (!filePath.endsWith(".json")) return;

      const task = this.taskStore.getTask(this.extractId(filePath));
      if (!task) return;

      // Determine what changed and emit appropriate events
      switch (task.status) {
        case "in_progress":
          if (task.assigned_agent) {
            this.eventBus.emit("task_assigned", task, task.assigned_agent);
          }
          break;
        case "done":
          this.eventBus.emit("task_completed", task);
          break;
        case "failed":
        case "stuck":
          this.eventBus.emit("task_failed", task, task.metadata?.failure_reason as string ?? "unknown");
          break;
        // pending or blocked: no special event beyond creation
      }
    });

    this.watcher.on("unlink", (filePath: string) => {
      // A task file was removed externally — could log or handle here
      if (!filePath.endsWith(".json")) return;
      // Not emitting an event since tasks shouldn't be deleted mid-lifecycle
    });

    this.watcher.on("error", (err: Error) => {
      console.error(`[task-watcher] Watch error: ${err.message}`);
    });

    return this.watcher;
  }

  /**
   * Stop watching.
   */
  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  /**
   * Scan all existing tasks and emit task_created for each pending task.
   * Called on scheduler startup to process tasks that arrived while offline.
   */
  scanExisting(): Task[] {
    const pending = this.taskStore.listTasks({ status: "pending" });
    for (const task of pending) {
      this.eventBus.emit("task_created", task);
    }
    return pending;
  }

  // ---- Helpers ----

  /**
   * Extract the task ID from a task file path.
   * "tasks/task_{uuid}.json" → "{uuid}"
   */
  private extractId(filePath: string): string {
    const basename = path.basename(filePath, ".json"); // "task_{uuid}"
    return basename.replace(/^task_/, ""); // "{uuid}"
  }
}
