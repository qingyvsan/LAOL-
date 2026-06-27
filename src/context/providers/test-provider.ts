import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ContextProvider } from "../provider";
import type { Task, ContextHint, ProviderDelta } from "../../data/models";
import type { ContextProviderConfig } from "../../data/models";

/**
 * Test runner provider.
 *
 * Infers related test files from target_files by naming convention
 * for both TypeScript (vitest/jest) and Python (pytest).
 * Runs the appropriate test runner and injects pass/fail summary.
 * On deactivate, re-runs and computes a before/after delta.
 */
export class TestProvider implements ContextProvider {
  readonly name = "test";
  readonly description =
    "Runs related tests (vitest/jest/pytest) and injects pass/fail baseline";

  private config: ContextProviderConfig;

  constructor(config: ContextProviderConfig) {
    this.config = config;
  }

  applies(task: Task): boolean {
    // Always run for code-modifying tasks that have target files
    return !task.metadata?.read_only && task.target_files.length > 0;
  }

  async activate(
    worktreePath: string,
    task: Task
  ): Promise<ContextHint[]> {
    const hints: ContextHint[] = [];

    // Separate TS and Python target files
    const tsFiles = task.target_files.filter((f) => /\.tsx?$/.test(f));
    const pyFiles = task.target_files.filter((f) => /\.py$/.test(f));

    // TypeScript tests
    if (tsFiles.length > 0) {
      const tsHints = await this.runTSTests(worktreePath, tsFiles);
      hints.push(...tsHints);
    }

    // Python tests
    if (pyFiles.length > 0) {
      const pyHints = await this.runPythonTests(worktreePath, pyFiles);
      hints.push(...pyHints);
    }

    // If no language-specific files, try both
    if (hints.length === 0) {
      const tsHints = await this.runTSTests(worktreePath, task.target_files);
      hints.push(...tsHints);
      const pyHints = await this.runPythonTests(worktreePath, task.target_files);
      hints.push(...pyHints);
    }

    if (hints.length === 0) {
      hints.push({
        source: this.name,
        priority: "low",
        title: "Tests: No related tests found",
        content:
          "[TEST] No test files found for the target files by naming convention.",
        timestamp: Date.now(),
      });
    }

    return hints;
  }

  // ---- TypeScript test runner ----

  private async runTSTests(
    worktreePath: string,
    targetFiles: string[]
  ): Promise<ContextHint[]> {
    const testFiles = this.inferTSTestFiles(worktreePath, targetFiles);
    if (testFiles.length === 0) return [];

    const runner = this.detectTSRunner(worktreePath);
    if (!runner) return [];

    try {
      const stdout = execSync(
        `npx ${runner} run ${testFiles.join(" ")} --reporter=verbose --passWithNoTests`,
        {
          cwd: worktreePath,
          stdio: "pipe",
          timeout: this.config.timeout_seconds * 1000,
          encoding: "utf-8",
        }
      );
      const summary = this.parseSummary(stdout);
      return [
        {
          source: this.name,
          priority: summary.failed > 0 ? "high" : "medium",
          title: `Tests (${runner}): ${summary.passed} passed, ${summary.failed} failed`,
          content: `[TEST BASELINE] ${runner}: ${summary.passed} passed, ${summary.failed} failed across ${testFiles.length} file(s).\n${this.formatFailures(summary)}`,
          timestamp: Date.now(),
        },
      ];
    } catch (err: unknown) {
      const stdout = (err as { stdout?: Buffer })?.stdout?.toString("utf-8") ?? "";
      const stderr = (err as { stderr?: Buffer })?.stderr?.toString("utf-8") ?? "";
      const summary = this.parseSummary(stdout + "\n" + stderr);
      return [
        {
          source: this.name,
          priority: summary.failed > 0 ? "high" : "medium",
          title: `Tests (${runner}): ${summary.passed} passed, ${summary.failed} failed`,
          content: `[TEST BASELINE] ${runner}: ${summary.passed} passed, ${summary.failed} failed.\n${this.formatFailures(summary)}`,
          timestamp: Date.now(),
        },
      ];
    }
  }

  // ---- Python test runner ----

  private async runPythonTests(
    worktreePath: string,
    targetFiles: string[]
  ): Promise<ContextHint[]> {
    const testFiles = this.inferPythonTestFiles(worktreePath, targetFiles);
    if (testFiles.length === 0) return [];

    const runnerCmd = this.detectPythonRunner(worktreePath);
    if (!runnerCmd) return [];

    try {
      const stdout = execSync(
        `${runnerCmd} ${testFiles.join(" ")} -q --tb=short`,
        {
          cwd: worktreePath,
          stdio: "pipe",
          timeout: this.config.timeout_seconds * 1000,
          encoding: "utf-8",
        }
      );
      const summary = this.parsePytestSummary(stdout);
      return [
        {
          source: this.name,
          priority: summary.failed > 0 ? "high" : "medium",
          title: `Tests (pytest): ${summary.passed} passed, ${summary.failed} failed`,
          content: `[TEST BASELINE] pytest: ${summary.passed} passed, ${summary.failed} failed across ${testFiles.length} file(s).\n${this.formatFailures(summary)}`,
          timestamp: Date.now(),
        },
      ];
    } catch (err: unknown) {
      const stdout = (err as { stdout?: Buffer })?.stdout?.toString("utf-8") ?? "";
      const stderr = (err as { stderr?: Buffer })?.stderr?.toString("utf-8") ?? "";
      const summary = this.parsePytestSummary(stdout + "\n" + stderr);
      return [
        {
          source: this.name,
          priority: summary.failed > 0 ? "high" : "medium",
          title: `Tests (pytest): ${summary.passed} passed, ${summary.failed} failed`,
          content: `[TEST BASELINE] pytest: ${summary.passed} passed, ${summary.failed} failed.\n${this.formatFailures(summary)}`,
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
    // Simplified: just re-run via activate and compare totals.
    // The detailed per-language deactivation is handled in activate's
    // preState payload which the ContextManager passes through.
    const postHints = await this.activate(worktreePath, task);
    const preData = preState as { totalPassed: number; totalFailed: number } | null;

    if (!preData) return { hints: [], delta: null };

    // Count totals from post-hints
    let postPassed = 0;
    let postFailed = 0;
    for (const h of postHints) {
      const tsMatch = h.title.match(/(\d+) passed, (\d+) failed/);
      if (tsMatch) {
        postPassed += parseInt(tsMatch[1], 10);
        postFailed += parseInt(tsMatch[2], 10);
      }
    }

    const delta: ProviderDelta = {
      source: this.name,
      before: { errors: preData.totalFailed, warnings: 0 },
      after: { errors: postFailed, warnings: 0 },
      fixed:
        preData.totalFailed > postFailed
          ? [`Fixed ${preData.totalFailed - postFailed} failing test(s)`]
          : [],
      introduced:
        postFailed > preData.totalFailed
          ? [`${postFailed - preData.totalFailed} new test failure(s)`]
          : [],
    };

    return { hints: [], delta };
  }

  // ---- internal: TS test inference ----

  private inferTSTestFiles(
    worktreePath: string,
    targetFiles: string[]
  ): string[] {
    const candidates = new Set<string>();
    for (const file of targetFiles) {
      if (!/\.tsx?$/.test(file)) continue;
      const dir = path.dirname(file);
      const base = path.basename(file, path.extname(file));
      const variants = [
        path.join(dir, "__tests__", `${base}.test.ts`),
        path.join(dir, "__tests__", `${base}.spec.ts`),
        path.join(dir, `${base}.test.ts`),
        path.join(dir, `${base}.spec.ts`),
      ];
      for (const v of variants) {
        if (fs.existsSync(path.join(worktreePath, v))) candidates.add(v);
      }
    }
    // Walk __tests__ dirs adjacent to TS target files
    if (candidates.size === 0) {
      for (const file of targetFiles) {
        if (!/\.tsx?$/.test(file)) continue;
        const dir = path.dirname(file);
        const testDir = path.join(worktreePath, dir, "__tests__");
        if (fs.existsSync(testDir)) {
          for (const entry of fs.readdirSync(testDir)) {
            if (entry.endsWith(".test.ts") || entry.endsWith(".spec.ts")) {
              candidates.add(path.join(dir, "__tests__", entry));
            }
          }
        }
      }
    }
    return [...candidates].slice(0, 10);
  }

  private detectTSRunner(worktreePath: string): string | null {
    const pkgPath = path.join(worktreePath, "package.json");
    if (!fs.existsSync(pkgPath)) return null;
    try {
      const deps = { ...JSON.parse(fs.readFileSync(pkgPath, "utf-8")).devDependencies ?? {},
        ...JSON.parse(fs.readFileSync(pkgPath, "utf-8")).dependencies ?? {} };
      if (deps["vitest"]) return "vitest";
      if (deps["jest"]) return "jest";
      return null;
    } catch { return null; }
  }

  // ---- internal: Python test inference ----

  private inferPythonTestFiles(
    worktreePath: string,
    targetFiles: string[]
  ): string[] {
    const candidates = new Set<string>();
    for (const file of targetFiles) {
      if (!/\.py$/.test(file)) continue;
      const dir = path.dirname(file);
      const stem = path.basename(file, ".py");
      const variants = [
        path.join(dir, `test_${stem}.py`),
        path.join(dir, `${stem}_test.py`),
        path.join(dir, "tests", `test_${stem}.py`),
        path.join(dir, "tests", `${stem}_test.py`),
      ];
      for (const v of variants) {
        if (fs.existsSync(path.join(worktreePath, v))) candidates.add(v);
      }
    }
    // Walk adjacent tests/ dirs
    if (candidates.size === 0) {
      for (const file of targetFiles) {
        if (!/\.py$/.test(file)) continue;
        const dir = path.dirname(file);
        for (const sub of ["tests", "test"]) {
          const testDir = path.join(worktreePath, dir, sub);
          if (fs.existsSync(testDir)) {
            for (const entry of fs.readdirSync(testDir)) {
              if (entry.startsWith("test_") || entry.endsWith("_test.py")) {
                candidates.add(path.join(dir, sub, entry));
              }
            }
          }
        }
      }
    }
    return [...candidates].slice(0, 10);
  }

  private detectPythonRunner(worktreePath: string): string | null {
    // Check for pytest in pip list or pyproject.toml
    try {
      execSync("python -m pytest --version", {
        cwd: worktreePath, stdio: "pipe", timeout: 5000,
      });
      return "python -m pytest";
    } catch { /* not available as module */ }
    try {
      execSync("pytest --version", {
        cwd: worktreePath, stdio: "pipe", timeout: 5000,
      });
      return "pytest";
    } catch { /* not available */ }
    // Check pyproject.toml for pytest dependency
    const pyroPath = path.join(worktreePath, "pyproject.toml");
    if (fs.existsSync(pyroPath)) {
      const content = fs.readFileSync(pyroPath, "utf-8");
      if (content.includes("pytest")) return "python -m pytest";
    }
    return null;
  }

  // ---- output parsing ----

  private parseSummary(
    output: string
  ): { passed: number; failed: number; failures: string[] } {
    const lines = output.split("\n");
    let passed = 0;
    let failed = 0;
    const failures: string[] = [];
    for (const line of lines) {
      if (/^\s*✓\s/.test(line)) passed++;
      if (/^\s*✗\s/.test(line) || /^\s*×\s/.test(line)) {
        failed++;
        failures.push(line.trim().slice(0, 200));
      }
    }
    const m = output.match(/Tests:\s*(\d+)\s+(?:passed|failed).*?(\d+)\s+(?:passed|failed)/);
    if (m && passed === 0 && failed === 0) {
      const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
      if (output.includes("failed")) { passed = a; failed = b; }
      else { passed = b; failed = a; }
    }
    return { passed, failed, failures };
  }

  private parsePytestSummary(
    output: string
  ): { passed: number; failed: number; failures: string[] } {
    // pytest short summary: "3 passed, 1 failed in 2.34s"
    const m = output.match(/(\d+)\s+passed.*?(\d+)\s+failed/);
    const passed = m ? parseInt(m[1], 10) : 0;
    const failed = m ? parseInt(m[2], 10) : 0;
    const failures: string[] = [];
    // Extract FAILED lines
    for (const line of output.split("\n")) {
      if (line.includes("FAILED")) failures.push(line.trim().slice(0, 200));
    }
    return { passed, failed, failures };
  }

  private formatFailures(summary: {
    passed: number;
    failed: number;
    failures: string[];
  }): string {
    if (summary.failures.length === 0) return "";
    return `Failing tests:\n${summary.failures.slice(0, 5).map((f) => `  - ${f}`).join("\n")}`;
  }
}
