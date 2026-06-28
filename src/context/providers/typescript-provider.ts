import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { TscCache } from "../tsc-cache";
import type { ContextProvider } from "../provider";
import type { Task, ContextHint, ProviderDelta } from "../../data/models";
import type { ContextProviderConfig } from "../../data/models";

/**
 * TypeScript diagnostics provider.
 *
 * Runs `tsc --noEmit` in the worktree before the agent starts. Filters
 * output to only include errors in the task's target files. On deactivate,
 * re-runs tsc and computes a before/after delta.
 *
 * Uses a shared cache keyed by git tree hash so that multiple agents
 * working from the same base commit avoid duplicate tsc runs.
 */
export class TypeScriptProvider implements ContextProvider {
  readonly name = "typescript";
  readonly description =
    "Runs tsc --noEmit and injects type errors for target files";

  private config: ContextProviderConfig;
  private repoRoot: string;

  /** Set by activate() so deactivate() can compute an accurate delta. */
  private lastErrorCount = 0;

  constructor(config: ContextProviderConfig, repoRoot?: string) {
    this.config = config;
    this.repoRoot = repoRoot ?? "";
  }

  applies(task: Task): boolean {
    if (task.metadata?.read_only) return false;
    if (task.target_files.length === 0) return true;
    return task.target_files.some((f) => /\.tsx?$/.test(f));
  }

  async activate(
    worktreePath: string,
    task: Task
  ): Promise<ContextHint[]> {
    const tsconfigPath = path.join(worktreePath, "tsconfig.json");
    if (!fs.existsSync(tsconfigPath)) {
      return [this.unavailable("No tsconfig.json found in project")];
    }

    // Try the shared cache first (avoids duplicate tsc when agents share
    // the same base commit).
    const cache = this.getCache(worktreePath);
    if (cache) {
      const treeHash = cache.getTreeHash(worktreePath);
      if (treeHash) {
        const cached = cache.get(treeHash);
        if (cached) {
          this.lastErrorCount = this.countTargetErrors(
            cached.allErrors,
            task.target_files
          );
          return this.buildHints(
            cached.allErrors,
            task.target_files,
            cached.totalErrorCount
          );
        }
      }
    }

    // Cache miss — run tsc and store the result.
    try {
      execSync("npx tsc --noEmit --pretty false", {
        cwd: worktreePath,
        stdio: "pipe",
        timeout: this.config.timeout_seconds * 1000,
        encoding: "utf-8",
      });

      // tsc exited 0 → no errors
      if (cache) {
        const treeHash = cache.getTreeHash(worktreePath);
        if (treeHash) {
          cache.set(treeHash, { errorCount: 0, allErrors: [], totalErrorCount: 0 });
        }
      }
      this.lastErrorCount = 0;
      return [
        {
          source: this.name,
          priority: "medium",
          title: "TypeScript: No type errors in target files",
          content:
            "[TYPESCRIPT] Type checking passed — no type errors in the project.",
          timestamp: Date.now(),
        },
      ];
    } catch (err) {
      const allErrors = this.parseAllErrors(err);
      const totalCount = allErrors.length;

      // Store in cache so other agents benefit
      if (cache) {
        const treeHash = cache.getTreeHash(worktreePath);
        if (treeHash) {
          cache.set(treeHash, {
            errorCount: totalCount,
            allErrors,
            totalErrorCount: totalCount,
          });
        }
      }

      this.lastErrorCount = this.countTargetErrors(allErrors, task.target_files);
      return this.buildHints(allErrors, task.target_files, totalCount);
    }
  }

  async deactivate(
    worktreePath: string,
    task: Task,
    _preState: unknown
  ): Promise<{ hints: ContextHint[]; delta: ProviderDelta | null }> {
    const tsconfigPath = path.join(worktreePath, "tsconfig.json");
    if (!fs.existsSync(tsconfigPath)) {
      return { hints: [], delta: null };
    }

    const preErrorCount = this.lastErrorCount;

    // Post-task tsc: the worktree has been modified, so the tree hash
    // will differ from any cached entry. Still check the cache in case
    // no files changed (e.g. read-only task).
    const cache = this.getCache(worktreePath);
    if (cache) {
      const treeHash = cache.getTreeHash(worktreePath);
      if (treeHash) {
        const cached = cache.get(treeHash);
        if (cached) {
          const postErrors = this.countTargetErrors(cached.allErrors, task.target_files);
          return this.buildDelta(preErrorCount, postErrors);
        }
      }
    }

    try {
      execSync("npx tsc --noEmit --pretty false", {
        cwd: worktreePath,
        stdio: "pipe",
        timeout: this.config.timeout_seconds * 1000,
        encoding: "utf-8",
      });

      // No errors now
      return this.buildDelta(preErrorCount, 0);
    } catch (err) {
      const allErrors = this.parseAllErrors(err);
      const postErrors = this.countTargetErrors(allErrors, task.target_files);

      // Store post-task result (new tree hash with agent changes)
      if (cache) {
        const treeHash = cache.getTreeHash(worktreePath);
        if (treeHash) {
          cache.set(treeHash, {
            errorCount: allErrors.length,
            allErrors,
            totalErrorCount: allErrors.length,
          });
        }
      }

      return this.buildDelta(preErrorCount, postErrors);
    }
  }

  // ---- internal ----

  /**
   * Get or create the TscCache. Resolves repo root from the worktree path
   * if not provided at construction time.
   */
  private getCache(worktreePath: string): TscCache | null {
    const root = this.repoRoot || this.resolveRepoRoot(worktreePath);
    if (!root) return null;
    return new TscCache(root);
  }

  /**
   * Walk up from worktreePath to find .multiagent/.
   */
  private resolveRepoRoot(worktreePath: string): string | null {
    let dir = path.resolve(worktreePath);
    while (true) {
      if (fs.existsSync(path.join(dir, ".multiagent"))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }

  private parseAllErrors(err: unknown): Array<{ file: string; line: number; code: number; message: string }> {
    const stdout = this.errStdout(err);
    const errors: Array<{ file: string; line: number; code: number; message: string }> = [];
    for (const line of stdout.split("\n")) {
      if (!line.includes(": error TS")) continue;
      const match = line.match(/^(.+?)\((\d+),\d+\):\s+error\s+TS(\d+):\s+(.+)$/);
      if (match) {
        errors.push({
          file: match[1],
          line: parseInt(match[2], 10),
          code: parseInt(match[3], 10),
          message: match[4],
        });
      } else {
        // Fallback: store the raw line
        errors.push({ file: "", line: 0, code: 0, message: line.trim() });
      }
    }
    return errors;
  }

  private countTargetErrors(
    allErrors: Array<{ file: string; line: number; code: number; message: string }>,
    targetFiles: string[]
  ): number {
    if (targetFiles.length === 0) return allErrors.length;
    return allErrors.filter((e) =>
      targetFiles.some((f) => e.file === f || e.file.startsWith(f + "/") || e.file.includes(f))
    ).length;
  }

  private buildHints(
    allErrors: Array<{ file: string; line: number; code: number; message: string }>,
    targetFiles: string[],
    totalCount: number
  ): ContextHint[] {
    const relevant = targetFiles.length > 0
      ? allErrors.filter((e) =>
          targetFiles.some((f) => e.file === f || e.file.startsWith(f + "/") || e.file.includes(f))
        )
      : allErrors;

    const errorCount = relevant.length;
    const trimmed = relevant.slice(0, 15);

    const content =
      errorCount === 0
        ? `[TYPESCRIPT] No type errors in target files (${totalCount} error(s) in other files).`
        : `[TYPESCRIPT DIAGNOSTICS] ${errorCount} type error(s) in target files (${totalCount} total in project):\n${trimmed.map((e) => `${e.file}(${e.line}): error TS${e.code}: ${e.message}`).join("\n")}`;

    return [
      {
        source: this.name,
        priority: errorCount > 0 ? "high" : "medium",
        title: `TypeScript: ${errorCount} error(s) in target files`,
        content,
        timestamp: Date.now(),
      },
    ];
  }

  private buildDelta(
    preErrorCount: number,
    postErrors: number
  ): { hints: ContextHint[]; delta: ProviderDelta } {
    const delta: ProviderDelta = {
      source: this.name,
      before: { errors: preErrorCount, warnings: 0 },
      after: { errors: postErrors, warnings: 0 },
      fixed:
        preErrorCount > postErrors
          ? [`Fixed ${preErrorCount - postErrors} type error(s)`]
          : [],
      introduced:
        postErrors > preErrorCount
          ? [`${postErrors - preErrorCount} new type error(s)`]
          : [],
    };

    return {
      hints: [
        {
          source: this.name,
          priority: "medium",
          title: `TypeScript: ${preErrorCount > postErrors ? `Fixed ${preErrorCount - postErrors} error(s)` : postErrors > preErrorCount ? `${postErrors} error(s) remaining` : "Still clean"}`,
          content: preErrorCount > postErrors
            ? `[TYPESCRIPT POST] All ${preErrorCount} pre-existing type error(s) resolved (${postErrors} remaining in other files).`
            : postErrors > preErrorCount
            ? `[TYPESCRIPT POST] ${postErrors} type error(s). Delta: ${preErrorCount} → ${postErrors}.`
            : "[TYPESCRIPT POST] Type checking still passes.",
          timestamp: Date.now(),
        },
      ],
      delta,
    };
  }

  private errStdout(err: unknown): string {
    return (
      (err as { stdout?: Buffer })?.stdout?.toString("utf-8") ??
      (err as { stderr?: Buffer })?.stderr?.toString("utf-8") ??
      ""
    );
  }

  private unavailable(reason: string): ContextHint {
    return {
      source: this.name,
      priority: "low",
      title: "TypeScript: Unavailable",
      content: `[TYPESCRIPT] Not available: ${reason}`,
      timestamp: Date.now(),
    };
  }
}
