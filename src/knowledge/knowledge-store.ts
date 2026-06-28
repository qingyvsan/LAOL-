import * as path from "node:path";
import * as fs from "node:fs";

/**
 * A single knowledge entry written when an agent completes a task.
 */
export interface KnowledgeEntry {
  task_id: string;
  agent_id: string;
  description: string;
  /** Human-readable summary of what was learned. */
  summary: string;
  /** Which files were explored/modified (for relevance matching). */
  files: string[];
  created_at: number;
}

/**
 * KnowledgeStore — shared agent memory.
 *
 * When agents complete exploration or modification tasks, they record
 * what they learned here. Other agents consult this store before starting
 * work so they benefit from prior discoveries without re-exploring.
 *
 * Directory: .multiagent/knowledge/
 * One JSON file per task.
 */
export class KnowledgeStore {
  private knowledgeDir: string;

  constructor(repoRoot: string) {
    this.knowledgeDir = path.join(repoRoot, ".multiagent", "knowledge");
  }

  /**
   * Save an agent's findings so other agents can learn from them.
   */
  save(entry: KnowledgeEntry): void {
    if (!fs.existsSync(this.knowledgeDir)) {
      fs.mkdirSync(this.knowledgeDir, { recursive: true });
    }

    const filePath = path.join(this.knowledgeDir, `${entry.task_id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(entry, null, 2), "utf-8");
  }

  /**
   * Load all knowledge entries, most recent first.
   */
  loadAll(): KnowledgeEntry[] {
    if (!fs.existsSync(this.knowledgeDir)) return [];

    const entries: KnowledgeEntry[] = [];
    for (const name of fs.readdirSync(this.knowledgeDir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const raw = fs.readFileSync(path.join(this.knowledgeDir, name), "utf-8");
        const entry = JSON.parse(raw) as KnowledgeEntry;
        if (entry.task_id && entry.summary) {
          entries.push(entry);
        }
      } catch {
        // skip corrupt files
      }
    }

    // Most recent first
    entries.sort((a, b) => b.created_at - a.created_at);
    return entries;
  }

  /**
   * Look up a single knowledge entry by task ID (O(1) direct read).
   * Returns null if no entry exists for the given task.
   */
  getByTaskId(taskId: string): KnowledgeEntry | null {
    const filePath = path.join(this.knowledgeDir, `${taskId}.json`);
    if (!fs.existsSync(filePath)) return null;
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const entry = JSON.parse(raw) as KnowledgeEntry;
      if (entry.task_id === taskId && entry.summary) return entry;
    } catch {
      // corrupt file
    }
    return null;
  }

  /**
   * Save a post-task delta entry without overwriting the main knowledge
   * entry for the same task. Uses a distinct filename suffix so both the
   * Claude stdout summary AND the provider delta info are preserved.
   */
  saveDelta(entry: KnowledgeEntry): void {
    if (!fs.existsSync(this.knowledgeDir)) {
      fs.mkdirSync(this.knowledgeDir, { recursive: true });
    }
    const filePath = path.join(this.knowledgeDir, `${entry.task_id}_delta.json`);
    fs.writeFileSync(filePath, JSON.stringify(entry, null, 2), "utf-8");
  }

  /**
   * Find knowledge entries relevant to a set of files or a text query.
   * Simple substring matching for now — scalable to embeddings later.
   */
  findRelevant(files: string[], query: string, limit = 5): KnowledgeEntry[] {
    const all = this.loadAll();
    if (all.length === 0) return [];

    const scored = all.map((entry) => {
      let score = 0;

      // File overlap
      for (const f of files) {
        for (const ef of entry.files) {
          if (f.includes(ef) || ef.includes(f)) {
            score += 3;
          }
        }
      }

      // Keyword overlap with query
      const queryWords = query.toLowerCase().split(/\s+/);
      const entryText = (entry.description + " " + entry.summary).toLowerCase();
      for (const w of queryWords) {
        if (w.length > 2 && entryText.includes(w)) {
          score += 1;
        }
      }

      return { entry, score };
    });

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.entry);
  }

  /**
   * Format a list of knowledge entries as a context hint for injection
   * into an agent's prompt.
   */
  formatContext(entries: KnowledgeEntry[]): string | null {
    if (entries.length === 0) return null;

    const lines: string[] = [];
    lines.push("[SHARED KNOWLEDGE — other agents have already learned:]");

    for (const e of entries) {
      const age = Math.round((Date.now() - e.created_at) / 1000);
      const ageStr = age < 60 ? `${age}s ago` : age < 3600 ? `${Math.round(age / 60)}m ago` : `${Math.round(age / 3600)}h ago`;
      lines.push(`- [${ageStr}] ${e.summary.slice(0, 300)}`);
    }

    lines.push("[END SHARED KNOWLEDGE]");
    return lines.join("\n");
  }
}
