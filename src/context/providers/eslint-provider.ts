import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ContextProvider } from "../provider";
import type { Task, ContextHint, ProviderDelta } from "../../data/models";
import type { ContextProviderConfig } from "../../data/models";

/**
 * ESLint diagnostics provider.
 *
 * Runs eslint on the task's target files. Filters output to violations
 * only. On deactivate, re-runs and computes a delta.
 */
export class ESLintProvider implements ContextProvider {
  readonly name = "eslint";
  readonly description =
    "Runs eslint on target files and injects lint violations";

  private config: ContextProviderConfig;

  constructor(config: ContextProviderConfig) {
    this.config = config;
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
    const hasConfig =
      fs.existsSync(path.join(worktreePath, ".eslintrc.json")) ||
      fs.existsSync(path.join(worktreePath, ".eslintrc.js")) ||
      fs.existsSync(path.join(worktreePath, ".eslintrc.cjs")) ||
      fs.existsSync(path.join(worktreePath, "eslint.config.js")) ||
      fs.existsSync(path.join(worktreePath, "eslint.config.mjs"));

    if (!hasConfig) {
      return [
        {
          source: this.name,
          priority: "low",
          title: "ESLint: No config found",
          content: "[ESLINT] Not available: no ESLint config file found.",
          timestamp: Date.now(),
        },
      ];
    }

    // Only lint the target files, not the whole project
    const tsFiles =
      task.target_files.length > 0
        ? task.target_files.filter((f) => /\.tsx?$/.test(f))
        : ["src/"];
    if (tsFiles.length === 0) {
      return [
        {
          source: this.name,
          priority: "low",
          title: "ESLint: No TS files to lint",
          content: "[ESLINT] No TypeScript files in target.",
          timestamp: Date.now(),
        },
      ];
    }

    try {
      // eslint --format compact for concise machine-readable output
      const stdout = execSync(
        `npx eslint ${tsFiles.join(" ")} --format compact`,
        {
          cwd: worktreePath,
          stdio: "pipe",
          timeout: this.config.timeout_seconds * 1000,
          encoding: "utf-8",
        }
      ).trim();

      const lines = stdout
        .split("\n")
        .filter((line) => line.trim().length > 0);
      const violationCount = lines.length;

      const trimmed = lines.slice(0, 10); // cap at 10 violations

      return [
        {
          source: this.name,
          priority: violationCount > 0 ? "medium" : "low",
          title: `ESLint: ${violationCount} violation(s)`,
          content:
            violationCount === 0
              ? "[ESLINT] No lint violations in target files."
              : `[ESLINT] ${violationCount} violation(s) in target files:\n${trimmed.join("\n")}`,
          timestamp: Date.now(),
        },
      ];
    } catch (err: unknown) {
      // eslint exits non-zero when there are violations
      const stdout =
        (err as { stdout?: Buffer })?.stdout?.toString("utf-8")?.trim() ?? "";
      const lines = stdout
        .split("\n")
        .filter((line) => line.trim().length > 0);
      const violationCount = lines.length;
      const trimmed = lines.slice(0, 10);

      return [
        {
          source: this.name,
          priority: violationCount > 0 ? "medium" : "low",
          title: `ESLint: ${violationCount} violation(s)`,
          content:
            violationCount === 0
              ? "[ESLINT] No lint violations in target files."
              : `[ESLINT] ${violationCount} violation(s) in target files:\n${trimmed.join("\n")}`,
          timestamp: Date.now(),
        },
      ];
    }
  }

  async deactivate(
    worktreePath: string,
    task: Task,
    preState: unknown
  ): Promise<{ hints: ContextHint[]; delta: ProviderDelta | null }> {
    const preViolations =
      (preState as { violationCount: number } | null)?.violationCount ?? 0;

    // Re-run lint (same logic as activate but minimal)
    const tsFiles =
      task.target_files.length > 0
        ? task.target_files.filter((f) => /\.tsx?$/.test(f))
        : [];
    if (tsFiles.length === 0)
      return { hints: [], delta: null };

    try {
      const stdout = execSync(
        `npx eslint ${tsFiles.join(" ")} --format compact`,
        {
          cwd: worktreePath,
          stdio: "pipe",
          timeout: this.config.timeout_seconds * 1000,
          encoding: "utf-8",
        }
      ).trim();
      const postViolations = stdout
        .split("\n")
        .filter((line) => line.trim().length > 0).length;

      const delta: ProviderDelta = {
        source: this.name,
        before: { errors: preViolations, warnings: 0 },
        after: { errors: postViolations, warnings: 0 },
        fixed:
          preViolations > postViolations
            ? [`Fixed ${preViolations - postViolations} violation(s)`]
            : [],
        introduced:
          postViolations > preViolations
            ? [`${postViolations - preViolations} new violation(s)`]
            : [],
      };

      return {
        hints: [
          {
            source: this.name,
            priority: "low",
            title: `ESLint post: ${postViolations} violation(s)`,
            content: `[ESLINT POST] ${postViolations} violation(s). Delta: ${preViolations} → ${postViolations}.`,
            timestamp: Date.now(),
          },
        ],
        delta,
      };
    } catch (err: unknown) {
      const stdout =
        (err as { stdout?: Buffer })?.stdout?.toString("utf-8")?.trim() ?? "";
      const postViolations = stdout
        .split("\n")
        .filter((line) => line.trim().length > 0).length;

      const delta: ProviderDelta = {
        source: this.name,
        before: { errors: preViolations, warnings: 0 },
        after: { errors: postViolations, warnings: 0 },
        fixed: [],
        introduced:
          postViolations > preViolations
            ? [`${postViolations - preViolations} new violation(s)`]
            : [],
      };

      return {
        hints: [
          {
            source: this.name,
            priority: "low",
            title: `ESLint post: ${postViolations} violation(s)`,
            content: `[ESLINT POST] ${postViolations} violation(s).`,
            timestamp: Date.now(),
          },
        ],
        delta,
      };
    }
  }
}
