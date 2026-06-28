import { execSync } from "node:child_process";
import * as path from "node:path";
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
 * Gracefully degrades: if ruff is not installed, only mypy is run.
 * If neither is installed, returns an "unavailable" hint.
 */
export class PythonProvider implements ContextProvider {
  readonly name = "python";
  readonly description =
    "Runs ruff + mypy and injects lint/type errors for target files";

  private config: ContextProviderConfig;

  constructor(config: ContextProviderConfig, _repoRoot?: string) {
    this.config = config;
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
    const hints: ContextHint[] = [];

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

    // Run ruff (linter)
    if (hasRuff) {
      const ruffHints = this.runRuff(worktreePath, task);
      hints.push(...ruffHints);
    }

    // Run mypy (type checker)
    if (hasMypy) {
      const mypyHints = this.runMypy(worktreePath, task);
      hints.push(...mypyHints);
    }

    return hints;
  }

  async deactivate(
    worktreePath: string,
    task: Task,
    preState: unknown
  ): Promise<{ hints: ContextHint[]; delta: ProviderDelta | null }> {
    const pre = preState as {
      ruffViolations: number;
      mypyErrors: number;
    } | null;
    if (!pre) return { hints: [], delta: null };

    let postRuffViolations = 0;
    let postMypyErrors = 0;

    // Re-run ruff
    if (this.toolExists(worktreePath, "ruff")) {
      try {
        const files =
          task.target_files.length > 0
            ? task.target_files.filter((f) => /\.py$/.test(f))
            : ["."];
        if (files.length > 0) {
          const stdout = execSync(
            `ruff check ${files.join(" ")} --output-format concise`,
            {
              cwd: worktreePath,
              stdio: "pipe",
              timeout: this.config.timeout_seconds * 1000,
              encoding: "utf-8",
            }
          ).trim();
          postRuffViolations = stdout
            .split("\n")
            .filter((line) => line.trim().length > 0).length;
        }
      } catch (err: unknown) {
        const stdout =
          (err as { stdout?: Buffer })?.stdout?.toString("utf-8")?.trim() ?? "";
        postRuffViolations = stdout
          .split("\n")
          .filter((line) => line.trim().length > 0).length;
      }
    }

    // Re-run mypy
    if (this.toolExists(worktreePath, "mypy")) {
      try {
        execSync("mypy . --pretty false", {
          cwd: worktreePath,
          stdio: "pipe",
          timeout: this.config.timeout_seconds * 1000,
          encoding: "utf-8",
        });
        postMypyErrors = 0;
      } catch (err: unknown) {
        postMypyErrors = this.countMypyErrors(err);
      }
    }

    const totalBefore = pre.ruffViolations + pre.mypyErrors;
    const totalAfter = postRuffViolations + postMypyErrors;

    const delta: ProviderDelta = {
      source: this.name,
      before: { errors: pre.mypyErrors, warnings: pre.ruffViolations },
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
          content: `[PYTHON POST] ruff: ${pre.ruffViolations}→${postRuffViolations}, mypy: ${pre.mypyErrors}→${postMypyErrors}.`,
          timestamp: Date.now(),
        },
      ],
      delta,
    };
  }

  // ---- ruff ----

  private runRuff(worktreePath: string, task: Task): ContextHint[] {
    const files =
      task.target_files.length > 0
        ? task.target_files.filter((f) => /\.py$/.test(f))
        : ["."];
    if (files.length === 0) return [];

    try {
      const stdout = execSync(
        `ruff check ${files.join(" ")} --output-format concise`,
        {
          cwd: worktreePath,
          stdio: "pipe",
          timeout: this.config.timeout_seconds * 1000,
          encoding: "utf-8",
        }
      ).trim();

      const violations = stdout
        .split("\n")
        .filter((line) => line.trim().length > 0);

      return [
        {
          source: this.name,
          priority: violations.length > 0 ? "medium" : "low",
          title: `Ruff: ${violations.length} violation(s)`,
          content:
            violations.length === 0
              ? "[PYTHON RUFF] No lint violations."
              : `[PYTHON RUFF] ${violations.length} violation(s):\n${violations.slice(0, 10).join("\n")}`,
          timestamp: Date.now(),
        },
      ];
    } catch (err: unknown) {
      // ruff exits non-zero on violations
      const stdout =
        (err as { stdout?: Buffer })?.stdout?.toString("utf-8")?.trim() ?? "";
      const violations = stdout
        .split("\n")
        .filter((line) => line.trim().length > 0);

      return [
        {
          source: this.name,
          priority: violations.length > 0 ? "medium" : "low",
          title: `Ruff: ${violations.length} violation(s)`,
          content:
            violations.length === 0
              ? "[PYTHON RUFF] No lint violations."
              : `[PYTHON RUFF] ${violations.length} violation(s):\n${violations.slice(0, 10).join("\n")}`,
          timestamp: Date.now(),
        },
      ];
    }
  }

  // ---- mypy ----

  private runMypy(worktreePath: string, task: Task): ContextHint[] {
    try {
      execSync("mypy . --pretty false", {
        cwd: worktreePath,
        stdio: "pipe",
        timeout: this.config.timeout_seconds * 1000,
        encoding: "utf-8",
      });

      return [
        {
          source: this.name,
          priority: "medium",
          title: "Mypy: No type errors",
          content: "[PYTHON MYPY] Type checking passed.",
          timestamp: Date.now(),
        },
      ];
    } catch (err: unknown) {
      return this.parseMypyErrors(err, task);
    }
  }

  private parseMypyErrors(err: unknown, task: Task): ContextHint[] {
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
      task.target_files.length > 0 ? task.target_files : null;
    const relevant = targetFiles
      ? allErrors.filter((line) =>
          targetFiles.some((f) => line.startsWith(f) || line.includes(f))
        )
      : allErrors;

    const errorCount = relevant.length;
    const totalCount = allErrors.length;
    const trimmed = relevant.slice(0, 15);

    return [
      {
        source: this.name,
        priority: errorCount > 0 ? "high" : "medium",
        title: `Mypy: ${errorCount} type error(s) in target files`,
        content:
          errorCount === 0
            ? `[PYTHON MYPY] No type errors in target files (${totalCount} in other files).`
            : `[PYTHON MYPY] ${errorCount} type error(s) in target files (${totalCount} total):\n${trimmed.join("\n")}`,
        timestamp: Date.now(),
      },
    ];
  }

  private countMypyErrors(err: unknown): number {
    const stdout =
      (err as { stdout?: Buffer })?.stdout?.toString("utf-8") ?? "";
    const stderr =
      (err as { stderr?: Buffer })?.stderr?.toString("utf-8") ?? "";
    return (stdout + "\n" + stderr)
      .split("\n")
      .filter((line) => line.includes(": error:")).length;
  }

  // ---- helpers ----

  private toolExists(worktreePath: string, tool: string): boolean {
    try {
      execSync(`${tool} --version`, {
        cwd: worktreePath,
        stdio: "pipe",
        timeout: 5000,
      });
      return true;
    } catch {
      // Check if installed via pip (python -m)
      try {
        execSync(`python -m ${tool} --version`, {
          cwd: worktreePath,
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
