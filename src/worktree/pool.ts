import * as path from "node:path";
import * as fs from "node:fs";
import { execSync } from "node:child_process";

/**
 * WorktreePool — pre-created git worktrees for fast task isolation.
 *
 * On init: create pool_size worktrees with --no-checkout (cheap to create).
 * On acquire: checkout -f to target branch (fast, files already local).
 * On release: reset --hard + clean -fd → return to pool.
 *
 * Without pool: git worktree add per task = 5-15s.
 * With pool: git checkout -f per task = 1-3s.
 */

export interface WorktreeHandle {
  path: string;
  branch: string;
}

export class WorktreePool {
  private repoRoot: string;
  private poolDir: string;
  private poolSize: number;

  private available: string[] = [];
  private inUse = new Map<string, string>(); // taskId → worktree path
  private initialized = false;

  constructor(repoRoot: string, poolSize = 4) {
    this.repoRoot = repoRoot;
    this.poolDir = path.join(repoRoot, ".multiagent", "worktrees");
    this.poolSize = poolSize;
  }

  /**
   * Initialize the pool — create all worktrees upfront.
   * Must be called after .multiagent/ exists and repo is a git repo.
   */
  initialize(): void {
    if (this.initialized) return;

    // Prune stale git worktree metadata first — if a previous shutdown
    // removed directories without pruning, or if the process crashed,
    // git still has the paths registered and will reject `git worktree add`
    // with "missing but already registered worktree".
    try {
      execSync("git worktree prune", {
        cwd: this.repoRoot,
        stdio: "pipe",
        timeout: 5000,
      });
    } catch { /* best effort */ }

    // Ensure pool directory exists
    if (!fs.existsSync(this.poolDir)) {
      fs.mkdirSync(this.poolDir, { recursive: true });
    }

    // Check for existing worktrees (from previous runs)
    const existing = fs.readdirSync(this.poolDir).filter((d) => {
      const p = path.join(this.poolDir, d);
      return fs.statSync(p).isDirectory();
    });

    // Add existing worktrees to pool (they need cleanup first)
    for (const dir of existing) {
      const wtPath = path.join(this.poolDir, dir);
      this.cleanWorktree(wtPath);
      this.available.push(wtPath);
    }

    // Create additional worktrees if needed
    const needed = this.poolSize - this.available.length;
    for (let i = 0; i < needed; i++) {
      const wtPath = path.join(this.poolDir, `pool_${existing.length + i}`);
      try {
        this.createWorktree(wtPath);
        this.available.push(wtPath);
      } catch (err) {
        console.error(`[pool] Failed to create worktree ${wtPath}: ${err}`);
      }
    }

    this.initialized = true;
    console.log(`[pool] Initialized with ${this.available.length} worktrees`);
  }

  /**
   * Acquire a worktree for a task.
   * Checks out the target branch and returns the worktree path.
   */
  acquire(taskId: string, baseBranch = "main"): WorktreeHandle {
    if (!this.initialized) {
      this.initialize();
    }

    let wtPath: string;

    if (this.available.length > 0) {
      wtPath = this.available.pop()!;
    } else {
      // Dynamic expansion — create a new worktree on demand
      wtPath = path.join(this.poolDir, `pool_${this.poolSize++}`);
      try {
        this.createWorktree(wtPath);
      } catch (err) {
        console.error(`[pool] Failed to dynamically create worktree: ${err}`);
        throw err;
      }
    }

    const branch = `agent/${taskId}`;

    try {
      // Fetch latest
      execSync(`git fetch origin ${baseBranch}`, {
        cwd: wtPath,
        stdio: "pipe",
        timeout: 30_000,
      });
    } catch {
      // Fetch may fail if the branch doesn't exist remotely — use local
    }

    // Checkout the base branch and create a new agent branch
    try {
      execSync(`git checkout -f origin/${baseBranch}`, {
        cwd: wtPath,
        stdio: "pipe",
        timeout: 15_000,
      });
    } catch {
      // Try local branch as fallback
      execSync(`git checkout -f ${baseBranch}`, {
        cwd: wtPath,
        stdio: "pipe",
        timeout: 15_000,
      });
    }

    execSync(`git checkout -b ${branch}`, {
      cwd: wtPath,
      stdio: "pipe",
      timeout: 10_000,
    });

    this.inUse.set(taskId, wtPath);
    return { path: wtPath, branch };
  }

  /**
   * Release a worktree back to the pool.
   * Resets all changes and cleans untracked files.
   */
  release(taskId: string): void {
    const wtPath = this.inUse.get(taskId);
    if (!wtPath) {
      console.warn(`[pool] No worktree found for task ${taskId}`);
      return;
    }

    this.cleanWorktree(wtPath);
    this.inUse.delete(taskId);
    this.available.push(wtPath);
  }

  /**
   * Get the worktree path for a task, if it has one.
   */
  getWorktree(taskId: string): string | null {
    return this.inUse.get(taskId) ?? null;
  }

  /**
   * Pool statistics.
   */
  stats(): { available: number; inUse: number; total: number } {
    return {
      available: this.available.length,
      inUse: this.inUse.size,
      total: this.available.length + this.inUse.size,
    };
  }

  /**
   * Shutdown the pool — clean and remove all worktrees, then prune git metadata.
   */
  shutdown(): void {
    // Clean all worktrees
    for (const wtPath of this.available) {
      try {
        this.cleanWorktree(wtPath);
        fs.rmSync(wtPath, { recursive: true, force: true });
      } catch { /* best effort */ }
    }

    for (const [, wtPath] of this.inUse) {
      try {
        this.cleanWorktree(wtPath);
        fs.rmSync(wtPath, { recursive: true, force: true });
      } catch { /* best effort */ }
    }

    // Prune git's worktree registry so removed directories don't cause
    // "missing but already registered" errors on next initialize().
    try {
      execSync("git worktree prune", {
        cwd: this.repoRoot,
        stdio: "pipe",
        timeout: 5000,
      });
    } catch { /* best effort */ }

    this.available = [];
    this.inUse.clear();
    this.initialized = false;
  }

  // ---- Internal ----

  private createWorktree(wtPath: string): void {
    execSync(`git worktree add --no-checkout "${wtPath}" HEAD`, {
      cwd: this.repoRoot,
      stdio: "pipe",
      timeout: 30_000,
    });
  }

  private cleanWorktree(wtPath: string): void {
    try {
      // Detach HEAD (ignore errors — the worktree may already be detached)
      try {
        execSync(`git checkout --detach HEAD`, {
          cwd: wtPath,
          stdio: "pipe",
          timeout: 10_000,
        });
      } catch {
        // Already detached or no commits yet — fine
      }

      execSync(`git reset --hard HEAD`, {
        cwd: wtPath,
        stdio: "pipe",
        timeout: 10_000,
      });

      execSync(`git clean -fd`, {
        cwd: wtPath,
        stdio: "pipe",
        timeout: 10_000,
      });
    } catch {
      // Best-effort cleanup
    }
  }
}
