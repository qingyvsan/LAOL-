import { execSync } from "node:child_process";

/**
 * Adaptive Checkpoint — fetches upstream changes and rebases,
 * but only when necessary (not on every LLM call).
 *
 * Strategy:
 * - Minimum interval between fetches: config.checkpoint_min_interval_ms (default 30s)
 * - Force-refresh on merge_completed event (via resetLastFetch())
 * - If no upstream changes → skip rebase entirely
 * - If rebase conflicts → block task, notify user
 */

export class Checkpoint {
  private worktreePath: string;
  private taskId: string;
  private baseBranch: string;

  // State
  private lastFetchTime = 0;
  private lastUpstreamHead: string | null = null;
  private minFetchIntervalMs: number;

  constructor(
    worktreePath: string,
    taskId: string,
    baseBranch = "main",
    minFetchIntervalMs = 30_000
  ) {
    this.worktreePath = worktreePath;
    this.taskId = taskId;
    this.baseBranch = baseBranch;
    this.minFetchIntervalMs = minFetchIntervalMs;

    // Start with a "just fetched" timestamp so the first checkAndRebase()
    // call is deferred. Fresh worktrees are already at the latest commit;
    // the pre-commit rebase will catch any upstream changes that land
    // during the session. This avoids a redundant git fetch on session start.
    this.lastFetchTime = Date.now();
  }

  /**
   * Run a checkpoint before an LLM call.
   * Returns true if the codebase was updated (context refresh needed).
   * Returns false if no changes or skipped.
   * Throws RebaseConflictError if rebase fails.
   */
  checkAndRebase(): CheckpointResult {
    const now = Date.now();

    // Skip if we haven't waited the minimum interval
    if (now - this.lastFetchTime < this.minFetchIntervalMs) {
      return { updated: false, skipped: true };
    }

    // Fetch upstream
    try {
      execSync(`git fetch origin ${this.baseBranch}`, {
        cwd: this.worktreePath,
        stdio: "pipe",
        timeout: 15_000,
      });
    } catch (err) {
      // Fetch failed (network issue?) — try again next time
      console.warn(`[checkpoint] Fetch failed: ${err}`);
      return { updated: false, skipped: true };
    }

    this.lastFetchTime = now;

    // Get the upstream HEAD
    let remoteHead: string;
    try {
      remoteHead = execSync(`git rev-parse origin/${this.baseBranch}`, {
        cwd: this.worktreePath,
        stdio: "pipe",
        timeout: 5000,
      })
        .toString()
        .trim();
    } catch {
      // Can't resolve remote — use local
      remoteHead = execSync(`git rev-parse ${this.baseBranch}`, {
        cwd: this.worktreePath,
        stdio: "pipe",
        timeout: 5000,
      })
        .toString()
        .trim();
    }

    // If same as last known HEAD → no changes upstream
    if (remoteHead === this.lastUpstreamHead) {
      return { updated: false, skipped: false };
    }

    this.lastUpstreamHead = remoteHead;

    // Count how far behind we are
    let behindCount = 0;
    try {
      const result = execSync(
        `git rev-list --count HEAD..origin/${this.baseBranch}`,
        { cwd: this.worktreePath, stdio: "pipe", timeout: 5000 }
      )
        .toString()
        .trim();

      behindCount = parseInt(result, 10) || 0;
    } catch {
      // Can't determine — be safe, assume behind
      behindCount = 1;
    }

    if (behindCount === 0) {
      return { updated: false, skipped: false };
    }

    console.log(
      `[checkpoint] Task ${this.taskId.slice(0, 8)}: ${behindCount} commits behind — rebasing`
    );

    // Attempt rebase
    try {
      execSync(`git rebase origin/${this.baseBranch}`, {
        cwd: this.worktreePath,
        stdio: "pipe",
        timeout: 30_000,
      });

      return {
        updated: true,
        skipped: false,
        behindCount,
        message: `Codebase updated with ${behindCount} upstream commit(s).`,
      };
    } catch (err) {
      // Rebase conflict!
      // Abort the rebase to get back to a clean state
      try {
        execSync("git rebase --abort", {
          cwd: this.worktreePath,
          stdio: "pipe",
          timeout: 5000,
        });
      } catch {
        // Already aborted or not in rebase state
      }

      throw new RebaseConflictError(
        `Task ${this.taskId}: rebase conflict with origin/${this.baseBranch}. ` +
        `Human intervention required.`
      );
    }
  }

  /**
   * Force the next checkAndRebase() call to fetch, regardless of interval.
   * Called when the socket receives a "merge_completed" event.
   */
  forceNextFetch(): void {
    this.lastFetchTime = 0;
  }

  /**
   * Check if upstream has changes (lightweight — just fetches and compares).
   */
  hasUpstreamChanges(): boolean {
    try {
      execSync(`git fetch origin ${this.baseBranch}`, {
        cwd: this.worktreePath,
        stdio: "pipe",
        timeout: 15_000,
      });

      const remoteHead = execSync(`git rev-parse origin/${this.baseBranch}`, {
        cwd: this.worktreePath,
        stdio: "pipe",
        timeout: 5000,
      })
        .toString()
        .trim();

      return remoteHead !== this.lastUpstreamHead;
    } catch {
      return false;
    }
  }
}

// ---- Result and Error types ----

export interface CheckpointResult {
  updated: boolean;
  skipped: boolean;
  behindCount?: number;
  message?: string;
}

export class RebaseConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RebaseConflictError";
  }
}
