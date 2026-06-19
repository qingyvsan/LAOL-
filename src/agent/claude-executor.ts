import { spawn, execSync, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import type { Task, LaolConfig } from "../data/models";

const SHELL = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "/bin/sh";

/**
 * Result of a Claude Code execution.
 */
export interface ClaudeExecutionResult {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

/**
 * ClaudeCodeExecutor — spawns `claude -p` in the agent's isolated worktree.
 *
 * Builds a structured prompt from the task context, sets the appropriate
 * CLI flags for non-interactive automated execution, and captures output.
 *
 * Usage:
 *   const executor = new ClaudeCodeExecutor(config.claude_executor);
 *   const result = await executor.execute(worktreePath, task, hints);
 *   if (!result.success) throw new Error(result.stderr);
 */
export class ClaudeCodeExecutor {
  private binaryPath: string;
  private timeoutSeconds: number;
  private maxBudgetUsd: number;
  private allowedTools: string[];
  private effort: string;
  private skipPermissions: boolean;

  constructor(claudeConfig: LaolConfig["claude_executor"]) {
    this.binaryPath = claudeConfig.binary_path;
    this.timeoutSeconds = claudeConfig.timeout_seconds;
    this.maxBudgetUsd = claudeConfig.max_budget_usd;
    this.allowedTools = claudeConfig.allowed_tools;
    this.effort = claudeConfig.effort;
    this.skipPermissions = claudeConfig.skip_permissions;
  }

  /**
   * Execute Claude Code in discovery mode: read-only exploration to determine
   * which files need to be modified. Returns a list of file paths (parsed from
   * Claude's JSON output).
   *
   * @param worktreePath - Absolute path to the isolated git worktree
   * @param task - The task to discover files for
   * @param onOutput - Optional callback for real-time stdout streaming
   */
  async executeDiscovery(
    worktreePath: string,
    task: Task,
    onOutput?: (chunk: string) => void
  ): Promise<{ files: string[]; durationMs: number }> {
    const startTime = Date.now();
    const discoveryPrompt = this.buildDiscoveryPrompt(worktreePath, task);

    const child = spawn(this.binaryPath, [
      "-p", discoveryPrompt,
      "--output-format", "text",
      "--allowedTools", "Read, Glob, Grep",
      "--effort", "low",
      "--dangerously-skip-permissions",
    ], {
      cwd: worktreePath,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });

    return new Promise((resolve) => {
      let stdout = "";
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        resolve({ files: [], durationMs: Date.now() - startTime });
      }, 60000); // 60s timeout for discovery

      child.stdout?.on("data", (data: Buffer) => {
        const chunk = data.toString();
        stdout += chunk;
        onOutput?.(chunk);
      });

      child.on("close", (code: number | null) => {
        clearTimeout(timer);
        const durationMs = Date.now() - startTime;

        if (code !== 0) {
          resolve({ files: [], durationMs });
          return;
        }

        // Parse JSON file list from Claude's output
        const files = this.parseFileList(stdout);
        resolve({ files, durationMs });
      });

      child.on("error", () => {
        clearTimeout(timer);
        resolve({ files: [], durationMs: Date.now() - startTime });
      });
    });
  }

  /**
   * Execute Claude Code in the given worktree to perform the task.
   *
   * @param worktreePath - Absolute path to the isolated git worktree
   * @param task - The task to execute
   * @param contextHints - Semantic warnings, checkpoint messages, etc.
   * @param onOutput - Optional callback for real-time stdout streaming
   */
  async execute(
    worktreePath: string,
    task: Task,
    contextHints: string[],
    onOutput?: (chunk: string) => void
  ): Promise<ClaudeExecutionResult> {
    const startTime = Date.now();
    const prompt = this.buildPrompt(worktreePath, task, contextHints);
    const args = this.buildArgs(prompt);

    // Verify binary exists (fail fast with clear message)
    if (!this.binaryExists()) {
      return {
        success: false,
        exitCode: null,
        stdout: "",
        stderr: `Claude Code binary not found: "${this.binaryPath}". Install it or set claude_executor.binary_path in .multiagent/config.json`,
        timedOut: false,
        durationMs: Date.now() - startTime,
      };
    }

    // Verify worktree exists
    if (!fs.existsSync(worktreePath)) {
      return {
        success: false,
        exitCode: null,
        stdout: "",
        stderr: `Worktree path does not exist: ${worktreePath}`,
        timedOut: false,
        durationMs: Date.now() - startTime,
      };
    }

    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;

      const child: ChildProcess = spawn(this.binaryPath, args, {
        cwd: worktreePath,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
        // On Windows, shell: true helps find .cmd/.bat executables
        shell: process.platform === "win32",
      });

      const timer = setTimeout(() => {
        timedOut = true;
        if (!settled) {
          settled = true;
          child.kill("SIGTERM");
          // Give it 5 seconds to gracefully exit, then force kill
          setTimeout(() => {
            if (child.exitCode === null) {
              child.kill("SIGKILL");
            }
          }, 5000);
        }
      }, this.timeoutSeconds * 1000);

      child.stdout?.on("data", (data: Buffer) => {
        const chunk = data.toString();
        stdout += chunk;
        onOutput?.(chunk);
      });

      child.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      child.on("error", (err: NodeJS.ErrnoException) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({
            success: false,
            exitCode: null,
            stdout,
            stderr: err.code === "ENOENT"
              ? `Failed to spawn "${this.binaryPath}": command not found`
              : `Spawn error: ${err.message}`,
            timedOut: false,
            durationMs: Date.now() - startTime,
          });
        }
      });

      child.on("close", (code: number | null) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);

          const success = !timedOut && code === 0;

          resolve({
            success,
            exitCode: code,
            stdout,
            stderr: timedOut
              ? `Execution timed out after ${this.timeoutSeconds}s`
              : stderr,
            timedOut,
            durationMs: Date.now() - startTime,
          });
        }
      });
    });
  }

  // ---- Discovery prompt ----

  private buildDiscoveryPrompt(worktreePath: string, task: Task): string {
    const lines: string[] = [];

    lines.push("You are a code exploration assistant. Your ONLY job is to determine");
    lines.push("which files need to be modified to complete the task below.");
    lines.push("");
    lines.push("## Task");
    lines.push(task.description);
    lines.push("");
    lines.push("## Instructions");
    lines.push("1. Use Read and Glob tools to explore the codebase structure");
    lines.push("2. Identify ALL files that would need to be modified to complete the task");
    lines.push("3. Output ONLY a JSON array of relative file paths, nothing else");
    lines.push("");
    lines.push("Example output format:");
    lines.push('["src/auth.ts", "src/auth.test.ts", "src/types.ts"]');
    lines.push("");
    lines.push("IMPORTANT: Output ONLY the JSON array. No other text, no markdown, no explanation.");

    return lines.join("\n");
  }

  /**
   * Parse a JSON file list from Claude's output, handling various formats.
   */
  private parseFileList(output: string): string[] {
    // Try to extract a JSON array from the output (handles markdown code blocks etc.)
    const arrayMatch = output.match(/\[[\s\S]*?\]/);
    if (!arrayMatch) return [];

    try {
      const parsed = JSON.parse(arrayMatch[0]);
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is string => typeof item === "string" && item.length > 0);
      }
    } catch {
      // Fallback: try to extract individual lines that look like file paths
      const lines = output.split("\n")
        .map((l) => l.trim())
        .filter((l) => l.match(/^["']?[\w./-]+\.(ts|tsx|js|jsx|json|css|scss)["']?$/));
      return lines.map((l) => l.replace(/^["']|["']$/g, ""));
    }

    return [];
  }

  // ---- Prompt building ----

  private buildPrompt(
    worktreePath: string,
    task: Task,
    contextHints: string[]
  ): string {
    const lines: string[] = [];

    lines.push("You are an AI coding agent in the LAOL multi-agent collaboration system.");
    lines.push("You are working in an isolated git worktree. Your changes will be");
    lines.push("committed and merged automatically after you finish.");
    lines.push("");
    lines.push("## Task");
    lines.push(task.description);
    lines.push("");

    if (task.target_files.length > 0) {
      lines.push("## Target Files");
      lines.push("Focus your changes on these files:");
      for (const f of task.target_files) {
        lines.push(`- ${f}`);
      }
      lines.push("");
    } else {
      lines.push("## Exploration First");
      lines.push("No target files were pre-specified. You must first explore the");
      lines.push("codebase to determine which files need to be modified, then proceed");
      lines.push("with the implementation.");
      lines.push("");
    }

    if (contextHints.length > 0) {
      lines.push("## Context & Warnings");
      for (const hint of contextHints) {
        lines.push(hint);
      }
      lines.push("");
    }

    lines.push("## Instructions");
    lines.push("1. Read the target files to understand the current code");
    lines.push("2. Implement the changes described in the Task section");
    lines.push("3. Verify your changes compile and are correct");
    lines.push("4. Keep changes minimal and focused — only modify what the task requires");
    lines.push("");

    // If there are test commands in the project, hint at running them
    const pkgJsonPath = path.join(worktreePath, "package.json");
    if (fs.existsSync(pkgJsonPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
        if (pkg.scripts?.test) {
          lines.push("Run tests to verify your changes:");
          lines.push(`  npm test`);
          lines.push("");
        }
        if (pkg.scripts?.build) {
          lines.push("Verify the build passes:");
          lines.push(`  npm run build`);
          lines.push("");
        }
      } catch {
        // ignore — package.json may be malformed
      }
    }

    return lines.join("\n");
  }

  // ---- CLI argument building ----

  private buildArgs(prompt: string): string[] {
    const args: string[] = [];

    // Non-interactive print mode
    args.push("-p", prompt);

    // Output format — text is simpler to capture
    args.push("--output-format", "text");

    // Restrict tools to safe code-editing set
    if (this.allowedTools.length > 0) {
      args.push("--allowedTools", this.allowedTools.join(", "));
    }

    // Effort level
    args.push("--effort", this.effort);

    // Budget limit
    args.push(`--max-budget-usd`, String(this.maxBudgetUsd));

    // Skip permission prompts (the worktree is sandboxed)
    if (this.skipPermissions) {
      args.push("--dangerously-skip-permissions");
    }

    return args;
  }

  // ---- Helpers ----

  private binaryExists(): boolean {
    try {
      execSync(`"${this.binaryPath}" --version`, {
        stdio: "pipe",
        timeout: 5000,
        shell: SHELL,
      });
      return true;
    } catch {
      return false;
    }
  }
}
