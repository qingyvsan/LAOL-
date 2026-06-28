import * as fs from "node:fs";
import * as path from "node:path";
import type { SocketClient } from "../events/socket-client";
import type { ChangeEntry } from "../data/models";

/**
 * ChangeJournalClient — agent-side interface for querying the central
 * ChangeJournal via the scheduler socket.
 *
 * Agents call queryJournal() at task start to pull recent changes relevant
 * to their target files, then writeLocalJournal() to persist the results as
 * a markdown file that Claude Code reads during execution.
 *
 * Uses a pull model: the agent asks for what it needs, instead of receiving
 * unconditional push broadcasts for every file change in the repo.
 */

const JOURNAL_DIR = ".multiagent/journal";
const LATEST_CHANGES_FILE = "latest-changes.md";

export class ChangeJournalClient {
  private socketClient: SocketClient;
  private lastQueryTime: number;

  constructor(socketClient: SocketClient) {
    this.socketClient = socketClient;
    this.lastQueryTime = 0;
  }

  /**
   * Query the journal for recent file, index, and merge changes relevant
   * to the given files. Knowledge entries are excluded — they belong in
   * notifications.md (push model), not latest-changes.md (pull model).
   *
   * Returns entries sorted newest-first (up to 100).
   *
   * @param files - Target files to query changes for
   * @param since - Optional timestamp to limit results (defaults to lastQueryTime)
   */
  async queryJournal(
    files: string[],
    since?: number
  ): Promise<ChangeEntry[]> {
    const effectiveSince = since ?? this.lastQueryTime;
    const results = await this.socketClient.queryChanges({
      files,
      since: effectiveSince,
    });
    this.lastQueryTime = Date.now();
    // Exclude knowledge entries — knowledge is pushed to notifications.md
    return (results as ChangeEntry[]).filter((e) => e.type !== "knowledge");
  }

  /**
   * Query the journal for all change types except knowledge.
   */
  async queryAll(since?: number): Promise<ChangeEntry[]> {
    const effectiveSince = since ?? this.lastQueryTime;
    const results = await this.socketClient.queryChanges({
      qtype: "all",
      since: effectiveSince,
    });
    this.lastQueryTime = Date.now();
    return (results as ChangeEntry[]).filter((e) => e.type !== "knowledge");
  }

  /**
   * Write the journal query results as a markdown file in the worktree.
   * Claude Code reads this file to understand what other agents have changed.
   *
   * Format:
   *   ## Change Journal (as of 2024-01-15 10:30:00 UTC)
   *   - [file] agent-001 modified src/auth.ts
   *   - [index] 3 files re-indexed
   *   - [knowledge] agent-002 shared new knowledge
   */
  writeLocalJournal(worktreePath: string, entries: ChangeEntry[]): void {
    const journalDir = path.join(worktreePath, JOURNAL_DIR);
    if (!fs.existsSync(journalDir)) {
      fs.mkdirSync(journalDir, { recursive: true });
    }

    const filePath = path.join(journalDir, LATEST_CHANGES_FILE);
    const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);

    if (entries.length === 0) {
      const content = [
        `# Change Journal (as of ${timestamp} UTC)`,
        "",
        "No recent changes relevant to your current task.",
        "",
      ].join("\n");
      fs.writeFileSync(filePath, content, "utf-8");
      return;
    }

    const lines: string[] = [
      `# Change Journal (as of ${timestamp} UTC)`,
      "",
      `Showing ${entries.length} recent change(s):`,
      "",
    ];

    for (const entry of entries) {
      const entryTime = new Date(entry.timestamp).toISOString()
        .replace("T", " ").slice(0, 19);

      switch (entry.type) {
        case "file":
          lines.push(
            `- **[FILE]** \`${entry.agent_id ?? "?"}\` modified \`${entry.file ?? "?"}\` at ${entryTime}`
          );
          if (entry.worktree) {
            lines.push(`  - Worktree: \`${entry.worktree}\``);
          }
          break;

        case "index":
          lines.push(
            `- **[INDEX]** ${(entry.files ?? []).length} file(s) re-indexed at ${entryTime}`
          );
          if (entry.files) {
            for (const f of entry.files.slice(0, 10)) {
              lines.push(`  - \`${f}\``);
            }
            if (entry.files.length > 10) {
              lines.push(`  - ... and ${entry.files.length - 10} more`);
            }
          }
          break;

        case "knowledge":
          lines.push(
            `- **[KNOWLEDGE]** \`${entry.agent_id ?? "?"}\` shared knowledge at ${entryTime}`
          );
          if (entry.summary) {
            const preview = entry.summary.length > 200
              ? entry.summary.slice(0, 200) + "..."
              : entry.summary;
            lines.push(`  > ${preview}`);
          }
          break;

        case "merge":
          lines.push(
            `- **[MERGE]** Task \`${(entry.task_id ?? "?").slice(0, 8)}\` merged at ${entryTime}`
          );
          if (entry.files && entry.files.length > 0) {
            lines.push(`  - ${entry.files.length} file(s) merged`);
          }
          break;
      }
    }

    lines.push(""); // trailing newline
    fs.writeFileSync(filePath, lines.join("\n"), "utf-8");
  }

  /**
   * Reset the last query time (e.g. when starting a new task).
   */
  reset(): void {
    this.lastQueryTime = 0;
  }

  /**
   * Get the timestamp of the last query.
   */
  getLastQueryTime(): number {
    return this.lastQueryTime;
  }
}
