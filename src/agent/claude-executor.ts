import { spawn, execSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import type { Task, LaolConfig } from "../data/models";

const WIN32 = process.platform === "win32";

/**
 * Resolve the Claude Code binary to its actual executable path.
 *
 * On Windows, `claude` is a .cmd/.bat wrapper. We resolve the extension
 * explicitly so spawn() can find the executable.
 *
 * The prompt itself is piped via stdin rather than passed as a -p argument,
 * which avoids any risk of Windows command-line escaping corrupting
 * backslash sequences in file paths.
 */
function resolveClaudeBinary(binaryPath: string): string {
  if (!WIN32) return binaryPath;

  // Try .cmd first (most common on Windows), then .bat, then raw
  for (const ext of [".cmd", ".bat", ""]) {
    const candidate = binaryPath + ext;
    try {
      execSync(`where "${candidate}"`, { stdio: "pipe", timeout: 5000 });
      return candidate;
    } catch {
      // try next
    }
  }
  // Fallback: return as-is and let the spawn error handler surface the issue
  return binaryPath;
}

/**
 * Quote a single argument for a cmd.exe command string.
 * Wraps in double-quotes if it contains spaces or double-quote characters.
 */
function quoteCmdArg(arg: string): string {
  if (/[\s"]/.test(arg)) {
    return `"${arg.replace(/"/g, '\\"')}"`;
  }
  return arg;
}

/**
 * Spawn the Claude binary as a child process.
 *
 * On Windows with Node.js v22+, .cmd/.bat files cannot be spawned directly
 * via spawn() — they fail with EINVAL. We work around this by launching
 * cmd.exe /d /s /c with the full command string, which Node.js itself uses
 * internally for .cmd resolution in older versions.
 *
 * The prompt is piped via stdin rather than passed as a -p argument,
 * which avoids any risk of Windows command-line escaping corrupting
 * backslash sequences in file paths.
 */
function spawnBinary(
  binary: string,
  args: string[],
  options: SpawnOptions
): ChildProcess {
  if (!WIN32) {
    return spawn(binary, args, options);
  }

  // Build a command string and launch via cmd.exe.
  // Individual args that contain spaces or quotes are wrapped in
  // double-quotes to survive cmd.exe parsing.
  const parts = [quoteCmdArg(binary), ...args.map(quoteCmdArg)];
  const cmdStr = parts.join(" ");

  return spawn("cmd.exe", ["/d", "/s", "/c", cmdStr], options);
}

/**
 * Kill a process and its entire subtree.
 *
 * On Windows, POSIX signals do not exist — child.kill("SIGTERM") is
 * equivalent to a forced kill and does NOT kill children of the process.
 * Since spawnBinary launches cmd.exe (which spawns the actual Claude
 * process), we must use taskkill /T to clean up the whole tree.
 *
 * On Unix, SIGTERM followed by SIGKILL works as expected for process
 * trees that share a process group.
 */
function killProcessTree(pid: number | undefined, signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): boolean {
  if (pid === undefined) return false;

  if (WIN32) {
    // /T = tree kill, /F = force
    try {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: "pipe", timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  // Unix: send signal to the process group
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

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
 * Result of interactive context preparation.
 */
export interface InteractiveContext {
  claudeMdPath: string;
  content: string;
}

/**
 * ClaudeCodeExecutor — spawns `claude` in the agent's isolated worktree.
 *
 * The prompt is piped via stdin (not the -p flag) to avoid Windows
 * command-line escaping of backslash sequences in file paths.
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

  private resolvedBinary: string;

  constructor(claudeConfig: LaolConfig["claude_executor"]) {
    this.binaryPath = claudeConfig.binary_path;
    this.resolvedBinary = resolveClaudeBinary(this.binaryPath);
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
  ): Promise<{ files: string[]; output: string; durationMs: number }> {
    const startTime = Date.now();
    const discoveryPrompt = this.buildDiscoveryPrompt(worktreePath, task);

    const child = spawnBinary(this.resolvedBinary, [
      "--output-format", "text",
      "--allowedTools", "Read, Glob, Grep",
      "--effort", "low",
      "--dangerously-skip-permissions",
    ], {
      cwd: worktreePath,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Pipe prompt via stdin to avoid Windows command-line escaping issues
    child.stdin!.write(discoveryPrompt);
    child.stdin!.end();

    return new Promise((resolve) => {
      let stdout = "";
      const timer = setTimeout(() => {
        killProcessTree(child.pid);
        resolve({ files: [], output: stdout, durationMs: Date.now() - startTime });
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
          resolve({ files: [], output: stdout, durationMs });
          return;
        }

        // Parse JSON file list from Claude's output
        const files = this.parseFileList(stdout);
        resolve({ files, output: stdout, durationMs });
      });

      child.on("error", () => {
        clearTimeout(timer);
        resolve({ files: [], output: stdout, durationMs: Date.now() - startTime });
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
    onOutput?: (chunk: string) => void,
    readOnly = false
  ): Promise<ClaudeExecutionResult> {
    const startTime = Date.now();
    const prompt = this.buildPrompt(worktreePath, task, contextHints, readOnly);
    const args = this.buildArgs(readOnly);

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

      const child: ChildProcess = spawnBinary(this.resolvedBinary, args, {
        cwd: worktreePath,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });

      // Pipe prompt via stdin to avoid Windows command-line escaping issues
      child.stdin!.write(prompt);
      child.stdin!.end();

      const timer = setTimeout(() => {
        timedOut = true;
        if (!settled) {
          settled = true;
          killProcessTree(child.pid, "SIGTERM");
          // Give it 5 seconds to gracefully exit, then force kill
          setTimeout(() => {
            if (child.exitCode === null) {
              killProcessTree(child.pid, "SIGKILL");
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

  /**
   * Read package.json scripts from the worktree.
   * Shared by buildPrompt() and buildClaudeMdPrompt().
   */
  private getPackageScripts(worktreePath: string): Record<string, string> | null {
    const pkgJsonPath = path.join(worktreePath, "package.json");
    if (!fs.existsSync(pkgJsonPath)) return null;
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
      return pkg.scripts || null;
    } catch {
      return null;
    }
  }

  private buildPrompt(
    worktreePath: string,
    task: Task,
    contextHints: string[],
    readOnly = false
  ): string {
    const lines: string[] = [];

    if (readOnly) {
      lines.push("You are an AI analysis agent in the LAOL multi-agent collaboration system.");
      lines.push("You are working in an isolated git worktree. This is a READ-ONLY task —");
      lines.push("you must NOT modify any files. Your entire response will be saved as a");
      lines.push("report and shown directly to the user.");
    } else {
      lines.push("You are an AI coding agent in the LAOL multi-agent collaboration system.");
      lines.push("You are working in an isolated git worktree. Your changes will be");
      lines.push("committed and merged automatically after you finish.");
    }
    lines.push("");
    lines.push("## Task");
    lines.push(task.description);
    lines.push("");

    if (task.target_files.length > 0) {
      if (readOnly) {
        lines.push("## Target Files (for analysis)");
      } else {
        lines.push("## Target Files");
        lines.push("Focus your changes on these files:");
      }
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
    if (readOnly) {
      lines.push("1. Read and explore the relevant files to understand the code");
      lines.push("2. Analyze based on the task description");
      lines.push("3. Report your findings clearly and comprehensively");
      lines.push("4. Do NOT modify any files — this is a read-only analysis");
      lines.push("5. Structure your response as a clear, well-organized report");
      lines.push("   since it will be shown directly to the user");
    } else {
      lines.push("1. Read the target files to understand the current code");
      lines.push("2. Implement the changes described in the Task section");
      lines.push("3. Verify your changes compile and are correct");
      lines.push("4. Keep changes minimal and focused — only modify what the task requires");
    }
    lines.push("");

    // If there are test commands in the project, hint at running them
    if (!readOnly) {
      const scripts = this.getPackageScripts(worktreePath);
      if (scripts?.test) {
        lines.push("Run tests to verify your changes:");
        lines.push("  npm test");
        lines.push("");
      }
      if (scripts?.build) {
        lines.push("Verify the build passes:");
        lines.push("  npm run build");
        lines.push("");
      }
    }

    return lines.join("\n");
  }

  // ---- CLI argument building ----

  private buildArgs(readOnly = false): string[] {
    const args: string[] = [];

    // Prompt is piped via stdin (not passed as -p argument) to avoid
    // Windows command-line escaping of backslash sequences in paths.
    // Claude Code reads stdin when it detects a non-TTY input.

    // Output format — text is simpler to capture
    args.push("--output-format", "text");

    // Restrict tools: read-only tasks only get exploration tools
    if (readOnly) {
      args.push("--allowedTools", "Read, Glob, Grep");
    } else if (this.allowedTools.length > 0) {
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

  // ---- Interactive mode helpers ----

  /**
   * Write CLAUDE.md into the worktree for an interactive session.
   * Claude Code automatically reads CLAUDE.md on startup, so the agent
   * receives its task context without needing a piped stdin prompt.
   *
   * @returns Path to the written file and its content
   */
  prepareInteractiveContext(
    worktreePath: string,
    task: Task,
    contextHints: string[],
    readOnly = false
  ): InteractiveContext {
    const claudeMdPath = path.join(worktreePath, "CLAUDE.md");
    const content = this.buildClaudeMdPrompt(worktreePath, task, contextHints, readOnly);
    fs.writeFileSync(claudeMdPath, content, "utf-8");
    return { claudeMdPath, content };
  }

  /**
   * Build CLAUDE.md content for the interactive session.
   * Similar to buildPrompt() but formatted as a permanent CLAUDE.md
   * file instead of a one-shot stdin prompt.
   */
  buildClaudeMdPrompt(
    worktreePath: string,
    task: Task,
    contextHints: string[],
    readOnly = false
  ): string {
    const lines: string[] = [];

    // Header
    lines.push("# LAOL Agent Task");
    lines.push("");

    // Role
    lines.push("## Role");
    if (readOnly) {
      lines.push(
        "You are an AI analysis agent in the LAOL multi-agent collaboration system."
      );
      lines.push(
        "This is a **READ-ONLY** task — you must NOT modify any files."
      );
      lines.push(
        "Your entire response will be saved as a report and shown to the user."
      );
    } else {
      lines.push(
        "You are an AI coding agent in the LAOL multi-agent collaboration system."
      );
      lines.push(
        `You are working in an isolated git worktree on branch \`agent/${task.id}\`.`
      );
      lines.push(
        "Your changes will be committed and merged automatically after you finish."
      );
    }
    lines.push("");

    // Task description
    lines.push("## Task");
    lines.push(task.description);
    lines.push("");

    // Target files
    if (task.target_files.length > 0) {
      lines.push(readOnly ? "## Target Files (for analysis)" : "## Target Files");
      if (!readOnly) lines.push("Focus your changes on these files:");
      for (const f of task.target_files) {
        lines.push(`- \`${f}\``);
      }
      lines.push("");
    } else {
      lines.push("## Exploration First");
      lines.push(
        "No target files were pre-specified. You must first explore the"
      );
      lines.push(
        "codebase to determine which files need to be modified, then proceed"
      );
      lines.push("with the implementation.");
      lines.push("");
    }

    // Context hints
    if (contextHints.length > 0) {
      lines.push("## Context & Warnings");
      for (const hint of contextHints) {
        lines.push(`- ${hint}`);
      }
      lines.push("");
    }

    // Instructions
    lines.push("## Instructions");
    if (readOnly) {
      lines.push("1. Read and explore the relevant files to understand the code");
      lines.push("2. Analyze based on the task description");
      lines.push("3. Report your findings clearly and comprehensively as markdown");
      lines.push("4. **Do NOT modify any files** — this is a read-only analysis");
      lines.push("5. When you are done, type `/exit` or press Ctrl+D to finish");
    } else {
      lines.push("1. Read the target files to understand the current code");
      lines.push("2. Implement the changes described in the Task section");
      lines.push("3. Verify your changes compile and are correct — run build and tests");
      lines.push("4. Keep changes minimal and focused — only modify what the task requires");
      lines.push("5. When you are done, type `/exit` or press Ctrl+D to finish");
    }
    lines.push("");

    // Test/build hints
    if (!readOnly) {
      const scripts = this.getPackageScripts(worktreePath);
      if (scripts && (scripts.test || scripts.build || scripts.lint)) {
        lines.push("## Available Commands");
        lines.push("```");
        if (scripts.test) lines.push(`npm test      — ${scripts.test}`);
        if (scripts.build) lines.push(`npm run build — ${scripts.build}`);
        if (scripts.lint) lines.push(`npm run lint  — ${scripts.lint}`);
        lines.push("```");
        lines.push("");
      }
    }

    return lines.join("\n");
  }

  // ---- Helpers ----

  private binaryExists(): boolean {
    try {
      // Use the same spawn path as execution (spawnBinary) to ensure
      // the binary is found and invocable. On Windows this goes through
      // cmd.exe, matching the actual execution path.
      const child = spawnBinary(this.resolvedBinary, ["--version"], {
        stdio: "pipe",
        timeout: 5000,
      });
      // Synchronous check: kill immediately after verifying it starts
      const ok = child.pid !== undefined;
      killProcessTree(child.pid);
      return ok;
    } catch {
      return false;
    }
  }
}
