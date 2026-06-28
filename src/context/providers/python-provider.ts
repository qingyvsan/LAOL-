import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { PythonToolCache } from "../python-cache";
import type { ContextProvider } from "../provider";
import type { Task, ContextHint, ProviderDelta } from "../../data/models";
import type { ContextProviderConfig } from "../../data/models";

/**
 * Python diagnostics provider.
 *
 * Runs ruff (linter) and mypy (type checker) in the worktree before the
 * agent starts. Filters output to only include issues in target files.
 * On deactivate, re-runs and computes a before/after delta.
 *
 * Results are cached by git tree hash under .multiagent/cache/python/ so
 * that agents sharing the same base commit avoid duplicate ruff+mypy runs.
 *
 * Gracefully degrades: if ruff is not installed, only mypy is run.
 * If neither is installed, returns an "unavailable" hint.
 */
export class PythonProvider implements ContextProvider {
  readonly name = "python";
  readonly description =
    "Runs ruff + mypy and injects lint/type errors for target files";

  private config: ContextProviderConfig;
  private repoRoot: string;

  /** Set by activate() so deactivate() can compute an accurate delta. */
  private lastRuffViolations = 0;
  private lastMypyErrors = 0;

  constructor(config: ContextProviderConfig, repoRoot?: string) {
    this.config = config;
    this.repoRoot = repoRoot ?? "";
  }

  applies(task: Task): boolean {
    if (task.metadata?.read_only) return false;
    // Relevant if any target file is Python, or if no files specified (project-wide)
    if (task.target_files.length === 0) return true;
    return task.target_files.some((f) => /\.py$/.test(f));
  }

  async activate(
    worktreePath: string,
    task: Task
  ): Promise<ContextHint[]> {
    // Check which tools are available
    const hasRuff = this.toolExists(worktreePath, "ruff");
    const hasMypy = this.toolExists(worktreePath, "mypy");

    if (!hasRuff && !hasMypy) {
      return [
        {
          source: this.name,
          priority: "low",
          title: "Python: No tools available",
          content:
            "[PYTHON] Neither ruff nor mypy found. Install them for Python diagnostics:\n  pip install ruff mypy",
          timestamp: Date.now(),
        },
      ];
    }

    // Try the shared cache first (avoids duplicate ruff+mypy when agents
    // share the same base commit).
    const cache = this.getCache(worktreePath);
    if (cache) {
      const treeHash = cache.getTreeHash(worktreePath);
      if (treeHash) {
        const cached = cache.get(treeHash);
        if (cached) {
          // Cache hit — rebuild hints from cached data.
          this.lastRuffViolations = cached.ruffCount;
          this.lastMypyErrors = cached.mypyCount;
          return this.buildHintsFromCache(cached, task.target_files);
        }
      }
    }

    // Cache miss — run tools and store the result.
    const ruffViolations: string[] = [];
    const mypyErrors: string[] = [];
    let ruffCount = 0;
    let mypyCount = 0;

    // Run ruff (linter) on full project, then filter to target files
    if (hasRuff) {
      const result = this.runRuffFull(worktreePath, task);
      ruffViolations.push(...result.lines);
      ruffCount = result.lines.filter((l) => l.trim().length > 0).length;
    }

    // Run mypy (type checker) on full project, then filter to target files
    if (hasMypy) {
      const result = this.runMypyFull(worktreePath, task);
      mypyErrors.push(...result.errors);
      mypyCount = result.count;
    }

    // Store in cache so other agents benefit
    if (cache) {
      const treeHash = cache.getTreeHash(worktreePath);
      if (treeHash) {
        cache.set(treeHash, {
          hasRuff,
          ruffViolations,
          ruffCount,
          hasMypy,
          mypyErrors,
          mypyCount,
        });
      }
    }

    this.lastRuffViolations = ruffCount;
    this.lastMypyErrors = mypyCount;

    return this.buildHints(
      ruffViolations, ruffCount,
      mypyErrors, mypyCount,
      task.target_files
    );
  }

  async deactivate(
    worktreePath: string,
    task: Task,
    _preState: unknown
  ): Promise<{ hints: ContextHint[]; delta: ProviderDelta | null }> {
    const preRuff = this.lastRuffViolations;
    const preMypy = this.lastMypyErrors;

    let postRuffViolations = 0;
    let postMypyErrors = 0;

    // Re-run ruff (full project, filter to target files)
    if (this.toolExists(worktreePath, "ruff")) {
      const result = this.runRuffFull(worktreePath, task);
      postRuffViolations = result.lines.filter((l) => l.trim().length > 0).length;
    }

    // Re-run mypy (full project, filter to target files)
    if (this.toolExists(worktreePath, "mypy")) {
      const result = this.runMypyFull(worktreePath, task);
      postMypyErrors = result.count;
    }

    // Update stored counts (in case deactivate is called again)
    this.lastRuffViolations = postRuffViolations;
    this.lastMypyErrors = postMypyErrors;

    const totalBefore = preRuff + preMypy;
    const totalAfter = postRuffViolations + postMypyErrors;

    const delta: ProviderDelta = {
      source: this.name,
      before: { errors: preMypy, warnings: preRuff },
      after: { errors: postMypyErrors, warnings: postRuffViolations },
      fixed: totalBefore > totalAfter ? [`Fixed ${totalBefore - totalAfter} issue(s)`] : [],
      introduced: totalAfter > totalBefore ? [`${totalAfter - totalBefore} new issue(s)`] : [],
    };

    return {
      hints: [
        {
          source: this.name,
          priority: totalAfter > 0 ? "medium" : "low",
          title: `Python post: ${postRuffViolations} ruff, ${postMypyErrors} mypy`,
          content: `[PYTHON POST] ruff: ${preRuff}→${postRuffViolations}, mypy: ${preMypy}→${postMypyErrors}.`,
          timestamp: Date.now(),
        },
      ],
      delta,
    };
  }

  // ---- ruff (full project, filtered output) ----

  private runRuffFull(
    worktreePath: string,
    task: Task
  ): { lines: string[] } {
    try {
      const stdout = execSync("ruff check . --output-format concise", {
        cwd: worktreePath,
        stdio: "pipe",
        timeout: this.config.timeout_seconds * 1000,
        encoding: "utf-8",
      }).trim();

      const allLines = stdout
        .split("\n")
        .filter((line) => line.trim().length > 0);

      // Filter to target files
      const targetFiles =
        task.target_files.length > 0
          ? task.target_files.filter((f) => /\.py$/.test(f))
          : null;
      const relevant = targetFiles
        ? allLines.filter((line) =>
            targetFiles.some((f) => line.startsWith(f) || line.includes(f))
          )
        : allLines;

      return { lines: relevant };
    } catch (err: unknown) {
      // ruff exits non-zero on violations
      const stdout =
        (err as { stdout?: Buffer })?.stdout?.toString("utf-8")?.trim() ?? "";
      const allLines = stdout
        .split("\n")
        .filter((line) => line.trim().length > 0);

      const targetFiles =
        task.target_files.length > 0
          ? task.target_files.filter((f) => /\.py$/.test(f))
          : null;
      const relevant = targetFiles
        ? allLines.filter((line) =>
            targetFiles.some((f) => line.startsWith(f) || line.includes(f))
          )
        : allLines;

      return { lines: relevant };
    }
  }

  // ---- mypy (full project, filtered output) ----

  private runMypyFull(
    worktreePath: string,
    task: Task
  ): { errors: string[]; count: number } {
    try {
      execSync("mypy . --pretty false", {
        cwd: worktreePath,
        stdio: "pipe",
        timeout: this.config.timeout_seconds * 1000,
        encoding: "utf-8",
      });
      return { errors: [], count: 0 };
    } catch (err: unknown) {
      const stdout =
        (err as { stdout?: Buffer })?.stdout?.toString("utf-8") ?? "";
      const stderr =
        (err as { stderr?: Buffer })?.stderr?.toString("utf-8") ?? "";
      const combined = stdout + "\n" + stderr;

      const allErrors = combined
        .split("\n")
        .filter((line) => line.includes(": error:"));

      // Filter to target files
      const targetFiles =
        task.target_files.length > 0
          ? task.target_files.filter((f) => /\.py$/.test(f))
          : null;
      const relevant = targetFiles
        ? allErrors.filter((line) =>
            targetFiles.some((f) => line.startsWith(f) || line.includes(f))
          )
        : allErrors;

      return { errors: relevant, count: relevant.length };
    }
  }

  // ---- hint builders ----

  /**
   * Build hints from cached data (cache hit path).
   * Re-filters to current target files since different tasks may target
   * different files within the same tree hash.
   */
  private buildHintsFromCache(
    cached: { ruffViolations: string[]; mypyErrors: string[] },
    targetFiles: string[]
  ): ContextHint[] {
    const hints: ContextHint[] = [];

    // Filter cached ruff violations to current target files
    const pyTargets = targetFiles.length > 0
      ? targetFiles.filter((f) => /\.py$/.test(f))
      : null;
    const ruffRelevant = pyTargets
      ? cached.ruffViolations.filter((line) =>
          pyTargets.some((f) => line.startsWith(f) || line.includes(f))
        )
      : cached.ruffViolations;
    const ruffCount = ruffRelevant.length;

    hints.push({
      source: this.name,
      priority: ruffCount > 0 ? "medium" : "low",
      title: `Ruff: ${ruffCount} violation(s)`,
      content:
        ruffCount === 0
          ? "[PYTHON RUFF] No lint violations."
          : `[PYTHON RUFF] ${ruffCount} violation(s):\n${ruffRelevant.slice(0, 10).join("\n")}`,
      timestamp: Date.now(),
    });

    // Filter cached mypy errors to current target files
    const mypyRelevant = pyTargets
      ? cached.mypyErrors.filter((line) =>
          pyTargets.some((f) => line.startsWith(f) || line.includes(f))
        )
      : cached.mypyErrors;
    const mypyCount = mypyRelevant.length;

    hints.push({
      source: this.name,
      priority: mypyCount > 0 ? "high" : "medium",
      title: `Mypy: ${mypyCount} type error(s) in target files`,
      content:
        mypyCount === 0
          ? "[PYTHON MYPY] No type errors in target files."
          : `[PYTHON MYPY] ${mypyCount} type error(s) in target files:\n${mypyRelevant.slice(0, 15).join("\n")}`,
      timestamp: Date.now(),
    });

    return hints;
  }

  /**
   * Build hints from fresh tool output (cache miss path).
   */
  private buildHints(
    ruffViolations: string[],
    ruffCount: number,
    mypyErrors: string[],
    mypyCount: number,
    _targetFiles: string[]
  ): ContextHint[] {
    const hints: ContextHint[] = [];

    hints.push({
      source: this.name,
      priority: ruffCount > 0 ? "medium" : "low",
      title: `Ruff: ${ruffCount} violation(s)`,
      content:
        ruffCount === 0
          ? "[PYTHON RUFF] No lint violations."
          : `[PYTHON RUFF] ${ruffCount} violation(s):\n${ruffViolations.slice(0, 10).join("\n")}`,
      timestamp: Date.now(),
    });

    hints.push({
      source: this.name,
      priority: mypyCount > 0 ? "high" : "medium",
      title: `Mypy: ${mypyCount} type error(s) in target files`,
      content:
        mypyCount === 0
          ? "[PYTHON MYPY] No type errors in target files."
          : `[PYTHON MYPY] ${mypyCount} type error(s) in target files:\n${mypyErrors.slice(0, 15).join("\n")}`,
      timestamp: Date.now(),
    });

    return hints;
  }

  // ---- helpers ----

  private getCache(worktreePath: string): PythonToolCache | null {
    const root = this.repoRoot || this.resolveRepoRoot(worktreePath);
    if (!root) return null;
    return new PythonToolCache(root);
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

  private toolExists(_worktreePath: string, tool: string): boolean {
    try {
      execSync(`${tool} --version`, {
        stdio: "pipe",
        timeout: 5000,
      });
      return true;
    } catch {
      // Check if installed via pip (python -m)
      try {
        execSync(`python -m ${tool} --version`, {
          stdio: "pipe",
          timeout: 5000,
        });
        return true;
      } catch {
        return false;
      }
    }
  }
}
