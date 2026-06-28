import { execSync } from "node:child_process";
import * as process from "node:process";
import type { ContextProvider } from "../provider";
import type { Task, ContextHint } from "../../data/models";
import type { ContextProviderConfig } from "../../data/models";

const SHELL =
  process.platform === "win32"
    ? process.env.ComSpec ?? "cmd.exe"
    : process.env.SHELL ?? "/bin/sh";

/**
 * Custom command provider.
 *
 * Executes user-defined pre_commands and post_commands from config.
 * Each command's stdout becomes a context hint. Commands can be filtered
 * to only run for tasks touching specific files via include patterns.
 */
export class CustomProvider implements ContextProvider {
  readonly name = "custom";
  readonly description =
    "Runs user-defined commands before/after agent tasks";

  private config: ContextProviderConfig;

  constructor(config: ContextProviderConfig, _repoRoot?: string) {
    this.config = config;
  }

  applies(task: Task): boolean {
    const preCommands = this.getCommands("pre_commands");
    if (preCommands.length === 0) return false;

    // Check include filter
    if (
      this.config.include &&
      this.config.include.length > 0 &&
      task.target_files.length > 0
    ) {
      return task.target_files.some((f) =>
        this.config.include!.some((pattern) =>
          f.includes(pattern.replace(/\*\*/g, "").replace(/\*/g, ""))
        )
      );
    }

    return true;
  }

  async activate(
    worktreePath: string,
    task: Task
  ): Promise<ContextHint[]> {
    const commands = this.getCommands("pre_commands");
    if (commands.length === 0) return [];

    const hints: ContextHint[] = [];

    for (const cmd of commands) {
      try {
        const stdout = execSync(cmd, {
          cwd: worktreePath,
          stdio: "pipe",
          timeout: this.config.timeout_seconds * 1000,
          encoding: "utf-8",
          shell: SHELL,
        }).trim();

        hints.push({
          source: this.name,
          priority: "medium",
          title: `Custom: ${cmd}`,
          content: `[CUSTOM] \`${cmd}\`:\n${stdout.slice(0, 1500)}`,
          timestamp: Date.now(),
        });
      } catch (err: unknown) {
        const stderr =
          (err as { stderr?: Buffer })?.stderr?.toString("utf-8") ??
          (err as { message?: string })?.message ??
          "Unknown error";

        hints.push({
          source: this.name,
          priority: "high",
          title: `Custom: ${cmd} FAILED`,
          content: `[CUSTOM FAILED] \`${cmd}\`:\n${stderr.slice(0, 1500)}`,
          timestamp: Date.now(),
        });
      }
    }

    return hints;
  }

  async deactivate(
    worktreePath: string,
    _task: Task,
    _preState: unknown
  ): Promise<{ hints: ContextHint[]; delta: null }> {
    const commands = this.getCommands("post_commands");
    if (commands.length === 0) return { hints: [], delta: null };

    const hints: ContextHint[] = [];

    for (const cmd of commands) {
      try {
        const stdout = execSync(cmd, {
          cwd: worktreePath,
          stdio: "pipe",
          timeout: this.config.timeout_seconds * 1000,
          encoding: "utf-8",
          shell: SHELL,
        }).trim();

        hints.push({
          source: this.name,
          priority: "medium",
          title: `Custom post: ${cmd}`,
          content: `[CUSTOM POST] \`${cmd}\`:\n${stdout.slice(0, 1500)}`,
          timestamp: Date.now(),
        });
      } catch (err: unknown) {
        const stderr =
          (err as { stderr?: Buffer })?.stderr?.toString("utf-8") ?? "";
        hints.push({
          source: this.name,
          priority: "high",
          title: `Custom post: ${cmd} FAILED`,
          content: `[CUSTOM POST FAILED] \`${cmd}\`:\n${stderr.slice(0, 1500)}`,
          timestamp: Date.now(),
        });
      }
    }

    return { hints, delta: null };
  }

  // ---- internal ----

  private getCommands(
    key: "pre_commands" | "post_commands"
  ): string[] {
    const opts = this.config.options as Record<string, unknown> | undefined;
    const commands = opts?.[key];
    if (Array.isArray(commands)) {
      return commands.filter(
        (c): c is string => typeof c === "string" && c.trim().length > 0
      );
    }
    return [];
  }
}
