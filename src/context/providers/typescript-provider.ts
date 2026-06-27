import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ContextProvider } from "../provider";
import type { Task, ContextHint, ProviderDelta } from "../../data/models";
import type { ContextProviderConfig } from "../../data/models";

/**
 * TypeScript diagnostics provider.
 *
 * Runs `tsc --noEmit` in the worktree before the agent starts. Filters
 * output to only include errors in the task's target files. On deactivate,
 * re-runs tsc and computes a before/after delta.
 */
export class TypeScriptProvider implements ContextProvider {
  readonly name = "typescript";
  readonly description =
    "Runs tsc --noEmit and injects type errors for target files";

  private config: ContextProviderConfig;

  constructor(config: ContextProviderConfig) {
    this.config = config;
  }

  applies(task: Task): boolean {
    // Only relevant if the task touches TypeScript files
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

    try {
      const stdout = execSync("npx tsc --noEmit --pretty false", {
        cwd: worktreePath,
        stdio: "pipe",
        timeout: this.config.timeout_seconds * 1000,
        encoding: "utf-8",
      });

      // tsc exits 0 → no errors
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
      return this.parseErrors(err, task);
    }
  }

  async deactivate(
    worktreePath: string,
    task: Task,
    preState: unknown
  ): Promise<{ hints: ContextHint[]; delta: ProviderDelta | null }> {
    const tsconfigPath = path.join(worktreePath, "tsconfig.json");
    if (!fs.existsSync(tsconfigPath)) {
      return { hints: [], delta: null };
    }

    const preErrorCount = (preState as { errorCount: number } | null)
      ?.errorCount ?? 0;

    try {
      execSync("npx tsc --noEmit --pretty false", {
        cwd: worktreePath,
        stdio: "pipe",
        timeout: this.config.timeout_seconds * 1000,
        encoding: "utf-8",
      });

      // No errors now
      const delta: ProviderDelta = {
        source: this.name,
        before: { errors: preErrorCount, warnings: 0 },
        after: { errors: 0, warnings: 0 },
        fixed:
          preErrorCount > 0
            ? [`Fixed ${preErrorCount} type error(s)`]
            : [],
        introduced: [],
      };

      return {
        hints: [
          {
            source: this.name,
            priority: "medium",
            title: `TypeScript: ${preErrorCount > 0 ? `Fixed ${preErrorCount} error(s)` : "Still clean"}`,
            content: preErrorCount > 0
              ? `[TYPESCRIPT POST] All ${preErrorCount} pre-existing type error(s) resolved.`
              : "[TYPESCRIPT POST] Type checking still passes.",
            timestamp: Date.now(),
          },
        ],
        delta,
      };
    } catch (err) {
      const postErrors = this.countErrors(err);
      const delta: ProviderDelta = {
        source: this.name,
        before: { errors: preErrorCount, warnings: 0 },
        after: { errors: postErrors, warnings: 0 },
        fixed: [],
        introduced:
          postErrors > preErrorCount
            ? [`${postErrors - preErrorCount} new type error(s)`]
            : [],
      };

      return {
        hints: [
          {
            source: this.name,
            priority: "high",
            title: `TypeScript: ${postErrors} type error(s) remaining`,
            content: `[TYPESCRIPT POST] ${postErrors} type error(s). Delta: ${preErrorCount} → ${postErrors}.`,
            timestamp: Date.now(),
          },
        ],
        delta,
      };
    }
  }

  // ---- internal ----

  private parseErrors(err: unknown, task: Task): ContextHint[] {
    const stdout = this.errStdout(err);
    const allErrors = stdout
      .split("\n")
      .filter((line) => line.includes(": error TS"));

    // Filter to target files only
    const targetFiles = task.target_files.length > 0
      ? task.target_files
      : null;
    const relevant = targetFiles
      ? allErrors.filter((line) =>
          targetFiles.some((f) => line.startsWith(f) || line.includes(f))
        )
      : allErrors;

    const errorCount = relevant.length;
    const totalCount = allErrors.length;
    const trimmed = relevant.slice(0, 15); // cap at 15 errors in the prompt

    const content =
      errorCount === 0
        ? `[TYPESCRIPT] No type errors in target files (${totalCount} error(s) in other files).`
        : `[TYPESCRIPT DIAGNOSTICS] ${errorCount} type error(s) in target files (${totalCount} total in project):\n${trimmed.join("\n")}`;

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

  private countErrors(err: unknown): number {
    return this.errStdout(err)
      .split("\n")
      .filter((line) => line.includes(": error TS")).length;
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
