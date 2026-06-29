import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import type { Task, LaolConfig, InteractiveResult } from "../data/models";

const WIN32 = process.platform === "win32";
const DARWIN = process.platform === "darwin";

// ---- Helpers ----

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check whether a graphical display is available.
 * Returns false in headless/SSH environments — interactive mode requires a GUI.
 */
function hasGraphicalDisplay(): boolean {
  if (WIN32) return true; // Windows console is always graphical
  if (DARWIN) return true; // macOS always has WindowServer
  // Linux: check for X11 or Wayland
  return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

/**
 * Escape a path for use in a shell script (single-quote wrapping with escaping).
 */
function shellEscape(str: string): string {
  // Replace ' with '\'' and wrap in single quotes
  return `'${str.replace(/'/g, "'\\''")}'`;
}

/**
 * InteractiveTerminalOpener — opens a new terminal window running Claude Code
 * in full interactive mode, then waits for the user to finish.
 *
 * The agent writes CLAUDE.md into the worktree before opening the terminal
 * so Claude Code picks up the task context automatically on startup.
 *
 * Completion is detected via a sentinel file: a wrapper script deletes the
 * sentinel after Claude Code exits. The agent polls for the sentinel's
 * disappearance.
 */
export class InteractiveTerminalOpener {
  private binaryPath: string;
  private sessionDir: string;
  private timeoutSeconds: number;
  private pollIntervalMs: number;
  private terminalCmd?: string;
  private repoRoot: string;
  private agentId: string;

  constructor(repoRoot: string, agentId: string, config: LaolConfig) {
    this.repoRoot = repoRoot;
    this.agentId = agentId;
    this.binaryPath = config.claude_executor.binary_path;

    const ic = config.agent.interactive;
    this.timeoutSeconds = ic?.terminal_timeout_seconds ?? 7200;
    this.pollIntervalMs = ic?.poll_interval_ms ?? 2000;
    this.sessionDir = path.join(
      repoRoot,
      ".multiagent",
      ic?.session_dir ?? "sessions"
    );
    this.terminalCmd = ic?.terminal_cmd;

    // Clean up orphaned sentinel files from crashed previous sessions.
    // Stale sentinels (older than 2x timeout) are removed at startup.
    this.cleanOrphanedSentinels();
  }

  // ---- Public API ----

  /**
   * Open an interactive Claude Code session in a new terminal window.
   *
   * 1. Writes CLAUDE.md with task context into the worktree
   * 2. Creates a sentinel file and wrapper script
   * 3. Launches a new terminal window running Claude Code interactively
   * 4. Polls until the sentinel file is removed (user exited Claude)
   * 5. Cleans up wrapper script and sentinel
   *
   * @returns InteractiveResult with outcome and duration
   */
  async runInteractiveSession(
    worktreePath: string,
    task: Task,
    contextHints: string[],
    readOnly = false
  ): Promise<InteractiveResult> {
    const startTime = Date.now();

    // 0. Pre-flight: check that a graphical display is available
    if (!hasGraphicalDisplay()) {
      return {
        exitCode: null,
        sentinelRemoved: false,
        durationMs: Date.now() - startTime,
      };
    }

    // 0b. Pre-flight: check that the binary exists
    if (!this.binaryExists()) {
      throw new Error(
        `Claude Code binary not found: "${this.binaryPath}". ` +
        `Install it or set claude_executor.binary_path in .multiagent/config.json`
      );
    }

    // 0c. Pre-flight: verify worktree exists
    if (!fs.existsSync(worktreePath)) {
      throw new Error(`Worktree path does not exist: ${worktreePath}`);
    }

    // 1. Write CLAUDE.md into the worktree (Claude Code reads it on startup)
    this.writeClaudeMd(worktreePath, task, contextHints, readOnly);

    // 2. Create session directory and sentinel file
    if (!fs.existsSync(this.sessionDir)) {
      fs.mkdirSync(this.sessionDir, { recursive: true });
    }
    const sentinelPath = path.join(
      this.sessionDir,
      `${this.agentId}_${task.id}.active`
    );
    fs.writeFileSync(sentinelPath, `${Date.now()}\n`, "utf-8");

    // 3. Write wrapper script
    const wrapperPath = this.writeWrapperScript(
      worktreePath,
      sentinelPath,
      task
    );

    // 4. Launch terminal
    console.log(
      `[interactive] Opening terminal for task ${task.id.slice(0, 8)}...`
    );
    console.log(`[interactive] Worktree: ${worktreePath}`);
    console.log(`[interactive] Sentinel: ${sentinelPath}`);

    const childProc = this.spawnTerminal(wrapperPath, worktreePath);

    // 5. Wait for sentinel removal (polling) or child process close
    const sentinelResult = await this.waitForSentinel(
      sentinelPath,
      childProc ?? undefined
    );

    const durationMs = Date.now() - startTime;

    // 6. Cleanup
    try {
      if (fs.existsSync(sentinelPath)) {
        fs.unlinkSync(sentinelPath);
      }
      if (fs.existsSync(wrapperPath)) {
        fs.unlinkSync(wrapperPath);
      }
      // Remove CLAUDE.md so the repo/worktree stays clean
      const claudeMdPath = path.join(worktreePath, "CLAUDE.md");
      if (fs.existsSync(claudeMdPath)) {
        fs.unlinkSync(claudeMdPath);
      }
    } catch {
      // best-effort cleanup
    }

    // 7. Ensure child process is reaped
    if (childProc && childProc.exitCode === null) {
      try {
        childProc.kill();
      } catch {
        // already exited
      }
    }

    return {
      exitCode: childProc?.exitCode ?? null,
      sentinelRemoved: sentinelResult,
      durationMs,
    };
  }

  /**
   * Write a CLAUDE.md file into the worktree root with the task context.
   * Claude Code automatically reads CLAUDE.md from the working directory
   * on startup, making this the ideal delivery mechanism for task instructions.
   */
  writeClaudeMd(
    worktreePath: string,
    task: Task,
    contextHints: string[],
    readOnly = false
  ): void {
    const claudeMdPath = path.join(worktreePath, "CLAUDE.md");
    const content = this.buildClaudeMd(task, contextHints, readOnly);
    fs.writeFileSync(claudeMdPath, content, "utf-8");
  }

  // ---- Private: CLAUDE.md content ----

  /**
   * Build a compact CLAUDE.md for interactive sessions.
   *
   * In interactive mode there is NO stdin prompt — Claude Code reads CLAUDE.md
   * on startup. Must include the task description and target files.
   *
   * Context provider output (tsc, eslint, tests, etc.) is written to
   * `.multiagent/diagnostics.md` — kept separate to avoid bloating CLAUDE.md,
   * but still available when Claude needs diagnostic information.
   */
  private buildClaudeMd(
    task: Task,
    _contextHints: string[],
    readOnly = false
  ): string {
    const lines: string[] = [];

    lines.push("# LAOL Agent Session");
    lines.push("");

    // Role
    if (readOnly) {
      lines.push("You are a read-only analysis agent in LAOL. Do NOT modify any files.");
    } else {
      lines.push("You are a coding agent in LAOL, working on branch `agent/" + task.id + "`.");
      lines.push("Your changes will be committed and merged automatically.");
    }
    lines.push("");

    // Task description
    lines.push("## Task");
    lines.push(task.description);
    lines.push("");

    // Target files
    if (task.target_files.length > 0) {
      lines.push(readOnly ? "## Files to Analyze" : "## Target Files");
      for (const f of task.target_files) {
        lines.push(`- \`${f}\``);
      }
      lines.push("");
    }

    // Coordination pointers
    lines.push("## Coordination");
    lines.push("- **Diagnostics (tsc, lint, tests)**: `.multiagent/diagnostics.md`");
    lines.push("- **File changes / merges**: `.multiagent/journal/latest-changes.md`");
    lines.push("- **Knowledge / learnings**: `.multiagent/notifications.md`");
    lines.push("");

    // Brief instructions
    if (readOnly) {
      lines.push("Analyze the files above and report your findings. Do NOT modify any files.");
    } else {
      lines.push("Implement the task. Run build/tests to verify. Type `/exit` when done.");
    }

    return lines.join("\n");
  }

  // ---- Private: Wrapper script ----

  private writeWrapperScript(
    worktreePath: string,
    sentinelPath: string,
    task: Task
  ): string {
    if (WIN32) {
      return this.writeWindowsWrapper(worktreePath, sentinelPath, task);
    }
    return this.writeUnixWrapper(worktreePath, sentinelPath, task);
  }

  private writeWindowsWrapper(
    worktreePath: string,
    sentinelPath: string,
    _task: Task
  ): string {
    const wrapperPath = path.join(
      this.sessionDir,
      `laol_session_${this.agentId}.bat`
    );

    // Log file for debugging terminal issues — written to %TEMP%
    const logPath = path.join(
      process.env.TEMP ?? this.sessionDir,
      `laol_session_${this.agentId}.log`
    );

    const lines: string[] = [];
    lines.push("@echo off");
    lines.push("setlocal enabledelayedexpansion");
    lines.push("title LAOL Agent - " + _task.description.slice(0, 50));
    lines.push("cls");
    lines.push("echo ========================================");
    lines.push("echo  LAOL Interactive Agent Session");
    lines.push("echo ========================================");
    lines.push("echo.");
    lines.push("echo  Worktree: " + worktreePath);
    lines.push("echo  Task:     " + _task.description.slice(0, 60));
    lines.push("echo.");
    lines.push("echo  Claude Code will start in this terminal.");
    lines.push(
      "echo  Complete the task, then type /exit or press Ctrl+D."
    );
    lines.push("echo  Closing this window directly may lose your work.");
    lines.push("echo ========================================");
    lines.push("echo.");
    // Log start
    lines.push(
      `echo [%date% %time%] LAOL session started >> "${logPath}"`
    );
    // Verify claude is available before trying to run it
    lines.push("where /q " + this.binaryPath + " >nul 2>nul");
    lines.push("if %ERRORLEVEL% neq 0 (");
    lines.push("  echo [ERROR] Claude Code CLI not found: " + this.binaryPath);
    lines.push("  echo.");
    lines.push("  echo Install it with: npm install -g @anthropic-ai/claude-code");
    lines.push("  echo.");
    lines.push(
      `  echo [%date% %time%] ERROR: ${this.binaryPath} not found >> "${logPath}"`
    );
    lines.push("  pause");
    lines.push("  exit /b 1");
    lines.push(")");
    lines.push(
      `echo [%date% %time%] ${this.binaryPath} found in PATH, launching... >> "${logPath}"`
    );
    // Push working directory, then run Claude
    lines.push("pushd " + worktreePath);
    lines.push(
      `echo [%date% %time%] CWD: %cd% >> "${logPath}"`
    );
    lines.push(
      `echo [%date% %time%] Running: ${this.binaryPath} >> "${logPath}"`
    );
    lines.push(this.binaryPath);
    lines.push(
      `echo [%date% %time%] ${this.binaryPath} exited with code %%ERRORLEVEL%% >> "${logPath}"`
    );
    // After Claude exits, delete sentinel.
    // Use double-quote escaping for Windows (cmd.exe does not understand single quotes).
    lines.push(`del /f /q "${sentinelPath}"`);
    lines.push(
      `echo [%date% %time%] Sentinel deleted >> "${logPath}"`
    );
    lines.push("popd");
    lines.push("echo.");
    lines.push("echo [LAOL] Session ended.");
    // Keep window open so user can see output, even on error
    lines.push("pause");
    lines.push("exit");

    fs.writeFileSync(wrapperPath, lines.join("\r\n"), "utf-8");
    return wrapperPath;
  }

  private writeUnixWrapper(
    worktreePath: string,
    sentinelPath: string,
    _task: Task
  ): string {
    const wrapperPath = path.join(
      this.sessionDir,
      `laol_session_${this.agentId}.sh`
    );

    const lines: string[] = [];
    lines.push("#!/bin/bash");
    lines.push("clear");
    lines.push('echo "========================================"');
    lines.push('echo " LAOL Interactive Agent Session"');
    lines.push('echo "========================================"');
    lines.push('echo ""');
    lines.push('echo " Worktree: ' + worktreePath + '"');
    lines.push(
      'echo " Task:     ' + _task.description.slice(0, 60).replace(/"/g, '\\"') + '"'
    );
    lines.push('echo ""');
    lines.push(
      'echo " Claude Code will start in this terminal."'
    );
    lines.push(
      'echo " Complete the task, then type /exit or press Ctrl+D."'
    );
    lines.push(
      'echo " Closing this window directly may lose your work."'
    );
    lines.push('echo "========================================"');
    lines.push('echo ""');
    lines.push("cd " + shellEscape(worktreePath));
    lines.push(this.binaryPath);
    lines.push("rm -f " + shellEscape(sentinelPath));
    lines.push('echo ""');
    lines.push('echo "[LAOL] Session ended. You may close this window."');

    const content = lines.join("\n");
    fs.writeFileSync(wrapperPath, content, "utf-8");
    // Make executable
    try {
      fs.chmodSync(wrapperPath, 0o755);
    } catch {
      // Windows/WSL may not support chmod; ignore
    }
    return wrapperPath;
  }

  // ---- Private: Terminal spawning ----

  /**
   * Launch the terminal with the wrapper script.
   *
   * Platform strategy:
   * - Windows: `start "LAOL" /wait cmd /c wrapper` — blocks outer cmd until
   *   the user closes the terminal window.
   * - macOS: `osascript` to open Terminal.app with a do-script command.
   *   Fire-and-forget; sentinel polling handles completion.
   * - Linux: tries gnome-terminal --wait first, then x-terminal-emulator,
   *   then xterm as last resort.
   *
   * @returns ChildProcess on Windows (for monitoring), null on Unix (polling)
   */
  private spawnTerminal(
    wrapperPath: string,
    worktreePath: string
  ): ChildProcess | null {
    if (this.terminalCmd) {
      return this.spawnCustomTerminal(wrapperPath, worktreePath);
    }

    if (WIN32) {
      return this.spawnWindowsTerminal(wrapperPath, worktreePath);
    } else if (DARWIN) {
      this.spawnMacTerminal(wrapperPath);
      return null; // fire-and-forget
    } else {
      return this.spawnLinuxTerminal(wrapperPath);
    }
  }

  private spawnWindowsTerminal(wrapperPath: string, worktreePath: string): ChildProcess {
    // Windows quoting is deeply hostile to nested invocation. Node.js escapes
    // arguments for CreateProcess which collide with cmd.exe /c parsing which
    // collide with start's own syntax. Every attempt to pass the start command
    // as a spawn argument produces broken quoting (empty titles become escaped
    // quotes, paths get mangled to "\\", etc.).
    //
    // The reliable approach: write the start command into a launcher .bat file
    // whose content is exact and NOT subject to spawn-time escaping. Then spawn
    // cmd.exe /c launcher.bat — the launcher path has no spaces so it survives
    // the single layer of quoting intact.
    const launcherPath = path.join(
      this.sessionDir,
      `launcher_${this.agentId}_${Date.now()}.bat`
    );
    const launcherLines = [
      "@echo off",
      `start "LAOL Agent" /wait "${wrapperPath}"`,
      // Clean up the launcher after start returns
      `del /f /q "${launcherPath}"`,
    ];
    fs.writeFileSync(launcherPath, launcherLines.join("\r\n"), "utf-8");

    console.log(`[interactive] Launching via launcher: ${launcherPath}`);
    console.log(`[interactive]   -> start "LAOL Agent" /wait "${wrapperPath}"`);

    const child = spawn("cmd.exe", ["/d", "/s", "/c", launcherPath], {
      cwd: worktreePath,
      stdio: "ignore",
      detached: false,
    });

    child.on("error", (err) => {
      console.error(`[interactive] Failed to open terminal: ${err.message}`);
    });

    return child;
  }

  private spawnMacTerminal(wrapperPath: string): void {
    // Use osascript to tell Terminal.app to run the wrapper script.
    // This is fire-and-forget — the script itself handles sentinel cleanup.
    const escapedScript = wrapperPath.replace(/'/g, "'\\''");
    const osascript = [
      `tell application "Terminal"`,
      `    activate`,
      `    do script "bash '${escapedScript}'"`,
      `end tell`,
    ].join("\n");

    console.log(`[interactive] Launching Terminal.app...`);

    const child = spawn("osascript", ["-e", osascript], {
      stdio: "ignore",
    });

    child.on("error", (err) => {
      console.error(
        `[interactive] Failed to open Terminal.app: ${err.message}`
      );
    });
  }

  private spawnLinuxTerminal(wrapperPath: string): ChildProcess | null {
    // Try terminals in order of preference
    const terminals = [
      {
        exe: "gnome-terminal",
        args: [
          "--wait",
          "--",
          "bash",
          wrapperPath,
        ],
        blocking: true,
      },
      {
        exe: "konsole",
        args: ["--hold", "-e", "bash", wrapperPath],
        blocking: false,
      },
      {
        exe: "x-terminal-emulator",
        args: ["-e", `bash "${wrapperPath}"`],
        blocking: false,
      },
      {
        exe: "xterm",
        args: ["-e", `bash "${wrapperPath}"`],
        blocking: false,
      },
    ];

    for (const term of terminals) {
      const child = spawn(term.exe, term.args, {
        stdio: "ignore",
        detached: false,
      });

      child.on("error", () => {
        // This terminal is not installed — try next
      });

      // Very brief check: did the process start?
      if (child.pid) {
        console.log(
          `[interactive] Launched ${term.exe} terminal` +
            (term.blocking ? " (blocking)" : " (fire-and-forget)")
        );
        if (term.blocking) {
          return child; // can use close event
        }
        return null; // fire-and-forget; use sentinel polling
      }
    }

    console.warn(
      `[interactive] No terminal emulator found. Install gnome-terminal, konsole, x-terminal-emulator, or xterm.`
    );
    return null;
  }

  private spawnCustomTerminal(
    wrapperPath: string,
    worktreePath: string
  ): ChildProcess | null {
    // User-provided terminal command; supports {script} and {worktree} placeholders
    const cmd = this.terminalCmd!
      .replace(/\{script\}/g, wrapperPath)
      .replace(/\{worktree\}/g, worktreePath);

    console.log(`[interactive] Launching custom terminal: ${cmd}`);

    // Parse the command string simply: split on spaces, first token is exe
    const parts = cmd.split(/\s+/);
    const exe = parts[0];
    const args = parts.slice(1);

    try {
      const child = spawn(exe, args, { stdio: "ignore" });
      child.on("error", (err) => {
        console.error(
          `[interactive] Custom terminal command failed: ${err.message}`
        );
      });
      return child;
    } catch (err) {
      console.error(
        `[interactive] Failed to launch custom terminal: ${err}`
      );
      return null;
    }
  }

  // ---- Private: Sentinel polling ----

  /**
   * Wait for the sentinel file to be removed (indicating Claude Code exited).
   *
   * Uses a dual strategy:
   * 1. If a childProcess is available (Windows/Linux blocking mode), use
   *    the 'close' event as primary signal.
   * 2. Always poll the sentinel file as fallback (for fire-and-forget or
   *    if the process closes but sentinel isn't removed yet).
   */
  private async waitForSentinel(
    sentinelPath: string,
    childProcess?: ChildProcess
  ): Promise<boolean> {
    const deadline = Date.now() + this.timeoutSeconds * 1000;
    let resolved = false;

    // Strategy 1: Process close event (when available)
    if (childProcess) {
      childProcess.on("close", () => {
        // The terminal window closed. Give the wrapper script a moment
        // to run the `del`/`rm` command (it may still be finishing).
      });
    }

    // Strategy 2: Poll sentinel file (always active)
    while (Date.now() < deadline) {
      if (!fs.existsSync(sentinelPath)) {
        resolved = true;
        break;
      }

      // If we have a child process that exited, check if sentinel is gone
      if (childProcess && childProcess.exitCode !== null) {
        // Process exited — give it a short grace period for the wrapper
        // script to delete the sentinel, then check a few more times
        for (let i = 0; i < 5; i++) {
          await sleep(500);
          if (!fs.existsSync(sentinelPath)) {
            resolved = true;
            break;
          }
        }
        if (!resolved) {
          // Exit code was set but sentinel remains — treat as "not clean"
          console.warn(
            `[interactive] Terminal closed but sentinel still exists — ` +
              `user may have closed the window directly.`
          );
        }
        break;
      }

      await sleep(this.pollIntervalMs);
    }

    if (!resolved) {
      console.warn(
        `[interactive] Session timeout after ${this.timeoutSeconds}s — ` +
          `user may still be working.`
      );
    }

    return resolved;
  }

  // ---- Private: Orphan cleanup ----

  /**
   * Remove stale sentinel files and wrapper scripts from previous sessions
   * that crashed before cleanup. A sentinel is considered stale if it is
   * older than 2x the terminal timeout (a session that would have timed out
   * and been cleaned up by now).
   */
  private cleanOrphanedSentinels(): void {
    if (!fs.existsSync(this.sessionDir)) return;

    const staleThreshold = Date.now() - this.timeoutSeconds * 2 * 1000;

    try {
      const entries = fs.readdirSync(this.sessionDir);
      for (const entry of entries) {
        const fullPath = path.join(this.sessionDir, entry);

        // Only clean files matching our naming pattern
        if (
          !entry.startsWith(`laol_session_${this.agentId}`) &&
          !entry.startsWith(`${this.agentId}_`)
        ) {
          continue;
        }

        try {
          const stat = fs.statSync(fullPath);
          if (stat.mtimeMs < staleThreshold) {
            fs.unlinkSync(fullPath);
          }
        } catch {
          // best-effort
        }
      }
    } catch {
      // best-effort — session dir may not exist or be unreadable
    }
  }

  // ---- Private: Binary check ----

  private binaryExists(): boolean {
    try {
      if (WIN32) {
        execSync(`where "${this.binaryPath}" 2>nul`, {
          stdio: "pipe",
          timeout: 5000,
        });
      } else {
        execSync(`command -v "${this.binaryPath}"`, {
          stdio: "pipe",
          timeout: 5000,
        });
      }
      return true;
    } catch {
      return false;
    }
  }
}
