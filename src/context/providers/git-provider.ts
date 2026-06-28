import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ContextProvider } from "../provider";
import type { Task, ContextHint } from "../../data/models";
import type { ContextProviderConfig } from "../../data/models";

/**
 * Git context provider.
 *
 * Absorbs most of what Perception.checkWarnings() and
 * Perception.getContextSummary() previously provided, plus adds
 * git blame and recent change information.
 *
 * Provides:
 *  - Recent commits touching target files (since 1 hour ago)
 *  - Git blame for key lines in target files
 *  - Active agent activity in the same module directories
 */
export class GitProvider implements ContextProvider {
  readonly name = "git";
  readonly description =
    "Injects git blame, recent changes, and agent activity context";

  private config: ContextProviderConfig;

  constructor(config: ContextProviderConfig, _repoRoot?: string) {
    this.config = config;
  }

  applies(_task: Task): boolean {
    // Git context is always relevant — it costs almost nothing
    return true;
  }

  async activate(
    worktreePath: string,
    task: Task
  ): Promise<ContextHint[]> {
    const hints: ContextHint[] = [];

    // 1. Recent changes in target files (replaces Perception warnings)
    if (task.target_files.length > 0) {
      const recentHint = this.recentChanges(worktreePath, task);
      if (recentHint) hints.push(recentHint);
    }

    // 2. Agent activity in same module directories (replaces Perception context summary)
    const activityHint = this.agentActivity(worktreePath, task);
    if (activityHint) hints.push(activityHint);

    // 3. Git blame for target files (new capability)
    if (task.target_files.length > 0) {
      const blameHint = this.gitBlame(worktreePath, task);
      if (blameHint) hints.push(blameHint);
    }

    return hints;
  }

  // ---- internal ----

  /**
   * Show recent commits touching the target files.
   */
  private recentChanges(
    worktreePath: string,
    task: Task
  ): ContextHint | null {
    try {
      const output = execSync(
        `git log --oneline --since="1 hour ago" -- ${task.target_files.join(" ")}`,
        {
          cwd: worktreePath,
          stdio: "pipe",
          timeout: this.config.timeout_seconds * 1000,
          encoding: "utf-8",
        }
      ).trim();

      if (!output) return null;

      const lines = output.split("\n").slice(0, 10);
      return {
        source: this.name,
        priority: "medium",
        title: `Git: ${lines.length} recent commit(s) touching target files`,
        content: `[GIT RECENT] Commits in the last hour touching target files:\n${lines.join("\n")}`,
        timestamp: Date.now(),
      };
    } catch {
      return null;
    }
  }

  /**
   * Show git blame for the first 10 lines of the first target file.
   * Capped at 500 characters to minimize token waste.
   */
  private gitBlame(
    worktreePath: string,
    task: Task
  ): ContextHint | null {
    try {
      const file = task.target_files[0];
      const absPath = path.join(worktreePath, file);
      if (!fs.existsSync(absPath)) return null;

      const blame = execSync(
        `git blame -w --date=short ${file} 2>/dev/null | head -10`,
        {
          cwd: worktreePath,
          stdio: "pipe",
          timeout: 5000,
          encoding: "utf-8",
        }
      ).trim();

      if (!blame) return null;

      const content = `[GIT BLAME] ${file}:\n${blame}`;
      return {
        source: this.name,
        priority: "low",
        title: `Git blame for ${file}`,
        content: content.slice(0, 500),
        timestamp: Date.now(),
      };
    } catch {
      return null;
    }
  }

  /**
   * Detect other agents' activity in the same module directories.
   * Replaces Perception.getContextSummary().
   *
   * Reads lock files from .multiagent/locks/ to find active agents
   * working in directories that overlap with this task's target files.
   */
  private agentActivity(
    worktreePath: string,
    task: Task
  ): ContextHint | null {
    const locksDir = path.join(worktreePath, ".multiagent", "locks");
    if (!fs.existsSync(locksDir)) return null;

    try {
      const lockFiles = fs.readdirSync(locksDir).filter((f) => f.endsWith(".lock"));
      if (lockFiles.length === 0) return null;

      // Extract module directories from target files
      const targetDirs = new Set(
        task.target_files.map((f) => path.dirname(f))
      );

      // Check which locks are in overlapping directories
      const relevant: string[] = [];
      for (const lockFile of lockFiles) {
        const lockPath = lockFile.replace(/#/g, "/"); // reverse sanitization
        const lockDir = path.dirname(lockPath);
        if (targetDirs.has(lockDir) || this.isParentDir(lockDir, targetDirs)) {
          const content = fs.readFileSync(
            path.join(locksDir, lockFile),
            "utf-8"
          );
          try {
            const lock = JSON.parse(content);
            if (lock.holder && lock.holder !== task.assigned_agent) {
              relevant.push(
                `  - Agent ${lock.holder.slice(0, 8)} holds lock on ${lockPath}`
              );
            }
          } catch {
            // corrupt lock file, skip
          }
        }
      }

      if (relevant.length === 0) return null;

      return {
        source: this.name,
        priority: "medium",
        title: `Git: ${relevant.length} active agent(s) in same modules`,
        content: `[AGENT ACTIVITY] Other agents active in overlapping directories:\n${relevant.join("\n")}`,
        timestamp: Date.now(),
      };
    } catch {
      return null;
    }
  }

  private isParentDir(
    dir: string,
    targetDirs: Set<string>
  ): boolean {
    for (const td of targetDirs) {
      if (td.startsWith(dir + "/") || dir.startsWith(td + "/")) return true;
    }
    return false;
  }
}
