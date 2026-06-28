import * as fs from "node:fs";
import * as path from "node:path";
import { v4 as uuidv4 } from "uuid";
import type { ChangeEntry, ChangeQueryFilter, ChangeType } from "../data/models";

const MAX_MEMORY_ENTRIES = 10_000;
const JOURNAL_DIR = ".multiagent/journal";
const JOURNAL_FILE = "change-log.ndjson";

/**
 * ChangeJournal — central change log for the LAOL scheduler.
 *
 * Records all file modifications, index rebuilds, knowledge sharing,
 * and merge completions. Agents query this journal on demand (pull
 * model) instead of receiving unconditional broadcasts (push model).
 *
 * Entries are persisted as NDJSON (one JSON object per line) at
 * `.multiagent/journal/change-log.ndjson` for crash recovery.
 * In-memory store capped at MAX_MEMORY_ENTRIES (oldest evicted).
 */
export class ChangeJournal {
  private repoRoot: string;
  private entries: ChangeEntry[] = [];
  private journalPath: string;
  private writeStream: fs.WriteStream | null = null;

  constructor(repoRoot: string) {
    this.repoRoot = repoRoot;
    const dir = path.join(repoRoot, JOURNAL_DIR);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.journalPath = path.join(dir, JOURNAL_FILE);
  }

  /**
   * Load existing entries from the NDJSON file (crash recovery).
   */
  load(): void {
    if (!fs.existsSync(this.journalPath)) return;

    try {
      const raw = fs.readFileSync(this.journalPath, "utf-8");
      const lines = raw.split("\n").filter((l) => l.trim());
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as ChangeEntry;
          if (entry.id && entry.type && entry.timestamp) {
            this.entries.push(entry);
          }
        } catch {
          // skip corrupt lines
        }
      }

      // Sort by timestamp (oldest first — matches append order)
      this.entries.sort((a, b) => a.timestamp - b.timestamp);

      // Trim to memory cap
      while (this.entries.length > MAX_MEMORY_ENTRIES) {
        this.entries.shift();
      }
    } catch {
      // File corrupted — start fresh
      this.entries = [];
    }
  }

  // ---- Record methods ----

  /**
   * Record a single-file modification.
   */
  recordFileChange(file: string, agentId: string, worktree: string): ChangeEntry {
    return this.append({
      id: uuidv4(),
      type: "file",
      timestamp: Date.now(),
      agent_id: agentId,
      file,
      worktree,
    });
  }

  /**
   * Record an index rebuild for a set of files.
   */
  recordIndexUpdate(files: string[]): ChangeEntry {
    return this.append({
      id: uuidv4(),
      type: "index",
      timestamp: Date.now(),
      files,
    });
  }

  /**
   * Record a knowledge sharing event.
   */
  recordKnowledgeUpdate(taskId: string, agentId: string, summary: string): ChangeEntry {
    return this.append({
      id: uuidv4(),
      type: "knowledge",
      timestamp: Date.now(),
      agent_id: agentId,
      task_id: taskId,
      summary,
    });
  }

  /**
   * Record a completed merge.
   */
  recordMergeCompleted(taskId: string, files: string[]): ChangeEntry {
    return this.append({
      id: uuidv4(),
      type: "merge",
      timestamp: Date.now(),
      task_id: taskId,
      files,
    });
  }

  // ---- Query ----

  /**
   * Query the journal with optional filters.
   * Results are sorted newest-first.
   */
  query(filter: ChangeQueryFilter = {}): ChangeEntry[] {
    const {
      type = "all",
      files,
      since,
      agentId,
      limit = 50,
    } = filter;

    let results = [...this.entries];

    // Filter by type
    if (type !== "all") {
      results = results.filter((e) => e.type === type);
    }

    // Filter by file path
    if (files && files.length > 0) {
      results = results.filter((e) => {
        if (e.type === "file" && e.file) {
          return files.some((f) => e.file === f || e.file!.startsWith(f + "/") || f.startsWith(e.file! + "/"));
        }
        if (e.files && e.files.length > 0) {
          return e.files.some((ef) =>
            files.some((f) => ef === f || ef.startsWith(f + "/") || f.startsWith(ef + "/"))
          );
        }
        // knowledge entries: match if no file filter is strict
        return false;
      });
    }

    // Filter by time
    if (since !== undefined) {
      results = results.filter((e) => e.timestamp >= since);
    }

    // Filter by agent
    if (agentId) {
      results = results.filter((e) => e.agent_id === agentId);
    }

    // Newest first
    results.sort((a, b) => b.timestamp - a.timestamp);

    // Cap
    if (results.length > limit) {
      results = results.slice(0, limit);
    }

    return results;
  }

  /**
   * Get the total number of entries (for stats/debugging).
   */
  get entryCount(): number {
    return this.entries.length;
  }

  // ---- Internal ----

  private append(entry: ChangeEntry): ChangeEntry {
    // Append to in-memory store
    this.entries.push(entry);

    // Evict oldest if over cap
    while (this.entries.length > MAX_MEMORY_ENTRIES) {
      this.entries.shift();
    }

    // Append to disk (NDJSON)
    try {
      fs.appendFileSync(this.journalPath, JSON.stringify(entry) + "\n", "utf-8");
    } catch {
      // Disk write failure is non-fatal — in-memory store is still valid
    }

    return entry;
  }
}
