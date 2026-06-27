import * as path from "node:path";
import { watch, FSWatcher } from "chokidar";

/**
 * Perception — the agent's "eyes and ears" on the rest of the system.
 *
 * Watches the .multiagent/locks/ directory for real-time lock acquisition
 * by other agents. When another agent acquires a lock in the same module
 * directory as this agent's target files, it logs a warning.
 *
 * This is an optional component — GitProvider.agentActivity() provides
 * equivalent point-in-time information via the ContextManager pipeline.
 * Use Perception when real-time lock notifications are desired.
 */

export class Perception {
  private repoRoot: string;
  private taskId: string;
  private targetFiles: string[];
  private watcher: FSWatcher | null = null;

  constructor(
    repoRoot: string,
    taskId: string,
    targetFiles: string[]
  ) {
    this.repoRoot = repoRoot;
    this.taskId = taskId;
    this.targetFiles = targetFiles;
  }

  /**
   * Start watching the locks/ directory for relevant changes.
   * Logs a console warning when another agent acquires a lock
   * in the same module directory as our target files.
   */
  start(): FSWatcher {
    if (this.watcher) return this.watcher;

    const locksDir = path.join(this.repoRoot, ".multiagent", "locks");

    this.watcher = watch(locksDir, {
      ignored: /(^|[\/\\])\../,
      persistent: true,
      ignoreInitial: true,
    });

    // Get the set of module directories our target files are in
    const ourModules = new Set(
      this.targetFiles.map((f) => path.dirname(f))
    );

    this.watcher.on("add", (lockPath: string) => {
      const lockName = path.basename(lockPath, ".lock");
      // Desanitize: "src#auth.ts" → "src/auth.ts"
      const filePath = lockName.replace(/#/g, "/");

      // Check if this lock is for a file in one of our modules
      const lockModule = path.dirname(filePath);

      if (ourModules.has(lockModule) && !this.targetFiles.includes(filePath)) {
        console.warn(
          `[perception] Another agent is now modifying "${filePath}" ` +
          `in your module directory "${lockModule}". Watch for conflicts.`
        );
      }
    });

    this.watcher.on("error", (err: Error) => {
      console.error(`[perception] Watch error: ${err.message}`);
    });

    return this.watcher;
  }

  /**
   * Stop watching.
   */
  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }
}
