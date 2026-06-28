import * as fs from "node:fs";
import * as path from "node:path";

/**
 * NotificationWriter — manages agent-facing markdown files in a worktree.
 *
 * Knowledge updates are pushed by the scheduler (global broadcast) and
 * written to `.multiagent/notifications.md` as timestamped entries.
 *
 * File changes and index updates are pulled by the agent on demand via the
 * ChangeJournal (pull model). Results are written by ChangeJournalClient
 * to `.multiagent/journal/latest-changes.md`.
 */

const NOTIFICATIONS_DIR = ".multiagent";
const NOTIFICATIONS_FILE = "notifications.md";

/** Maximum file size before rotation (32 KB — ~100-150 entries). */
const MAX_FILE_SIZE = 32 * 1024;

/**
 * Append a notification entry to the worktree's notifications file.
 * Creates the directory and file if they don't exist.
 *
 * When the file exceeds MAX_FILE_SIZE, the oldest half of entries are
 * trimmed to prevent unbounded growth. Each entry is delimited by "## "
 * headers.
 */
export function writeNotification(
  worktreePath: string,
  entry: NotificationEntry
): void {
  const dir = path.join(worktreePath, NOTIFICATIONS_DIR);
  const filePath = path.join(dir, NOTIFICATIONS_FILE);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  const header = `## [${timestamp}] ${entry.title}`;
  const newBlock = [header, "", entry.body, ""].join("\n");

  // Read existing content
  let existing = "";
  if (fs.existsSync(filePath)) {
    existing = fs.readFileSync(filePath, "utf-8");
  }

  const newContent = existing + newBlock;

  // Rotate if over the size limit: keep only the most recent half of entries
  if (Buffer.byteLength(newContent, "utf-8") > MAX_FILE_SIZE) {
    const entries = splitEntries(newContent);
    const keepFrom = Math.max(0, entries.length - Math.ceil(entries.length / 2));
    const rotated = entries.slice(keepFrom).join("");
    fs.writeFileSync(filePath, rotated, "utf-8");
    return;
  }

  fs.appendFileSync(filePath, newBlock, "utf-8");
}

/**
 * Split notification content into individual entries (delimited by "## " headers).
 */
function splitEntries(content: string): string[] {
  const entries: string[] = [];
  const parts = content.split(/(?=^## )/m);
  for (const part of parts) {
    if (part.trim()) entries.push(part);
  }
  return entries;
}

/**
 * Format and write a knowledge_updated notification.
 */
export function notifyKnowledgeUpdated(
  worktreePath: string,
  agentId: string,
  summary: string
): void {
  const preview = summary.length > 200 ? summary.slice(0, 200) + "..." : summary;
  writeNotification(worktreePath, {
    title: `${agentId} shared new knowledge`,
    body: `> ${preview}`,
  });
}

export interface NotificationEntry {
  title: string;
  body: string;
}
