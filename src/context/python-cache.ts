import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

/**
 * Cached result of ruff + mypy runs on a worktree.
 * Keyed by git tree hash so agents sharing the same base commit
 * avoid duplicate tool invocations.
 */
export interface CachedPythonResult {
  treeHash: string;
  /** Whether ruff was available when this cache entry was created. */
  hasRuff: boolean;
  /** Raw ruff violation lines (concise format). */
  ruffViolations: string[];
  ruffCount: number;
  /** Whether mypy was available when this cache entry was created. */
  hasMypy: boolean;
  /** Mypy error lines (filtered to those containing ": error:"). */
  mypyErrors: string[];
  mypyCount: number;
  timestamp: number;
}

/**
 * Shared Python tool cache keyed by git tree hash.
 *
 * When two agents work from the same base commit, their worktrees have
 * identical source code. This cache prevents each agent from running
 * duplicate `ruff check .` and `mypy .` on identical file trees.
 *
 * Cache entries are stored as JSON files under .multiagent/cache/python/.
 */
export class PythonToolCache {
  private cacheDir: string;

  constructor(repoRoot: string) {
    this.cacheDir = path.join(repoRoot, ".multiagent", "cache", "python");
  }

  /**
   * Get the git tree hash for the worktree's HEAD.
   * Returns null if the worktree has no commits or git is unavailable.
   */
  getTreeHash(worktreePath: string): string | null {
    try {
      return execSync("git rev-parse HEAD^{tree}", {
        cwd: worktreePath,
        stdio: "pipe",
        timeout: 5000,
        encoding: "utf-8",
      }).trim();
    } catch {
      return null;
    }
  }

  /**
   * Look up a cached Python tool result by tree hash.
   * Returns null on cache miss or if the cache entry is corrupt.
   */
  get(treeHash: string): CachedPythonResult | null {
    const filePath = this.cacheFilePath(treeHash);
    if (!fs.existsSync(filePath)) return null;

    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const entry = JSON.parse(raw) as CachedPythonResult;
      if (entry.treeHash === treeHash && entry.timestamp > 0) {
        return entry;
      }
    } catch {
      // Corrupt cache entry — delete it
      try { fs.unlinkSync(filePath); } catch { /* best effort */ }
    }
    return null;
  }

  /**
   * Store Python tool results in the cache.
   */
  set(
    treeHash: string,
    result: Omit<CachedPythonResult, "treeHash" | "timestamp">
  ): void {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }

    const entry: CachedPythonResult = {
      ...result,
      treeHash,
      timestamp: Date.now(),
    };

    fs.writeFileSync(
      this.cacheFilePath(treeHash),
      JSON.stringify(entry, null, 2),
      "utf-8"
    );
  }

  // ---- internal ----

  private cacheFilePath(treeHash: string): string {
    return path.join(this.cacheDir, `${treeHash}.json`);
  }
}
