import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ChangeJournal } from "../journal/change-journal";

function createTempRepo(): string {
  const dir = path.join(os.tmpdir(), `laol-journal-test-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe("ChangeJournal", () => {
  let repoRoot: string;
  let journal: ChangeJournal;

  beforeEach(() => {
    repoRoot = createTempRepo();
    journal = new ChangeJournal(repoRoot);
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it("records a file change entry", () => {
    const entry = journal.recordFileChange("src/auth.ts", "agent-001", "/tmp/wt1");

    expect(entry.type).toBe("file");
    expect(entry.file).toBe("src/auth.ts");
    expect(entry.agent_id).toBe("agent-001");
    expect(entry.worktree).toBe("/tmp/wt1");
    expect(entry.timestamp).toBeGreaterThan(0);
    expect(entry.id).toBeTruthy();
  });

  it("records an index update entry", () => {
    const entry = journal.recordIndexUpdate(["src/a.ts", "src/b.ts"]);

    expect(entry.type).toBe("index");
    expect(entry.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(entry.timestamp).toBeGreaterThan(0);
  });

  it("records a knowledge update entry", () => {
    const entry = journal.recordKnowledgeUpdate("task-001", "agent-001", "Refactored auth");

    expect(entry.type).toBe("knowledge");
    expect(entry.task_id).toBe("task-001");
    expect(entry.agent_id).toBe("agent-001");
    expect(entry.summary).toBe("Refactored auth");
  });

  it("records a merge completed entry", () => {
    const entry = journal.recordMergeCompleted("task-001", ["src/a.ts"]);

    expect(entry.type).toBe("merge");
    expect(entry.task_id).toBe("task-001");
    expect(entry.files).toEqual(["src/a.ts"]);
  });

  it("queries entries filtered by type", () => {
    journal.recordFileChange("src/a.ts", "agent-001", "/wt1");
    journal.recordIndexUpdate(["src/b.ts"]);
    journal.recordKnowledgeUpdate("task-001", "agent-001", "summary");

    const results = journal.query({ type: "file" });
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("file");
    expect(results[0].file).toBe("src/a.ts");
  });

  it("queries entries filtered by files (prefix match)", () => {
    journal.recordFileChange("src/auth.ts", "agent-001", "/wt1");
    journal.recordFileChange("src/utils.ts", "agent-002", "/wt2");
    journal.recordFileChange("lib/other.ts", "agent-003", "/wt3");

    let results = journal.query({ files: ["src/auth.ts"] });
    expect(results).toHaveLength(1);
    expect(results[0].file).toBe("src/auth.ts");

    // Prefix match: "src" should match files under src/
    results = journal.query({ files: ["src"] });
    expect(results).toHaveLength(2);
  });

  it("queries entries filtered by time (since)", async () => {
    journal.recordFileChange("old.ts", "agent-001", "/wt1");

    // Capture a timestamp between the two records
    await new Promise((r) => setTimeout(r, 5));
    const midTime = Date.now();
    await new Promise((r) => setTimeout(r, 5));
    journal.recordFileChange("new.ts", "agent-002", "/wt2");

    const results = journal.query({ since: midTime });
    expect(results).toHaveLength(1);
    expect(results[0].file).toBe("new.ts");
  });

  it("returns results sorted newest-first", async () => {
    journal.recordFileChange("first.ts", "agent-001", "/wt1");
    await new Promise((r) => setTimeout(r, 5));
    journal.recordFileChange("second.ts", "agent-002", "/wt2");
    await new Promise((r) => setTimeout(r, 5));
    journal.recordFileChange("third.ts", "agent-003", "/wt3");

    const results = journal.query({});
    expect(results[0].file).toBe("third.ts");
    expect(results[1].file).toBe("second.ts");
    expect(results[2].file).toBe("first.ts");
  });

  it("caps results at the given limit", () => {
    for (let i = 0; i < 20; i++) {
      journal.recordFileChange(`src/file${i}.ts`, "agent-001", "/wt1");
    }

    const results = journal.query({ limit: 5 });
    expect(results).toHaveLength(5);
  });

  it("defaults to limit 50 when not specified", () => {
    for (let i = 0; i < 60; i++) {
      journal.recordFileChange(`src/file${i}.ts`, "agent-001", "/wt1");
    }

    const results = journal.query({});
    expect(results).toHaveLength(50);
  });

  it("persists entries to NDJSON file", () => {
    journal.recordFileChange("src/persisted.ts", "agent-001", "/wt1");
    journal.recordIndexUpdate(["src/persisted.ts"]);

    const journalPath = path.join(repoRoot, ".multiagent/journal/change-log.ndjson");
    expect(fs.existsSync(journalPath)).toBe(true);

    const raw = fs.readFileSync(journalPath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).type).toBe("file");
    expect(JSON.parse(lines[1]).type).toBe("index");
  });

  it("loads entries from NDJSON on startup", () => {
    journal.recordFileChange("src/a.ts", "agent-001", "/wt1");
    journal.recordIndexUpdate(["src/b.ts"]);

    // Create a new journal instance pointing to the same repo
    const journal2 = new ChangeJournal(repoRoot);
    journal2.load();

    expect(journal2.entryCount).toBe(2);
    const results = journal2.query({});
    expect(results).toHaveLength(2);
  });

  it("evicts oldest entries when exceeding MAX_MEMORY_ENTRIES", () => {
    // MAX_MEMORY_ENTRIES = 10_000; test with 10 more
    for (let i = 0; i < 10_010; i++) {
      journal.recordFileChange(`src/file${i}.ts`, "agent-001", "/wt1");
    }

    expect(journal.entryCount).toBe(10_000);
    // Oldest entries should be evicted
    const results = journal.query({ limit: 1 });
    expect(results[0].file).not.toBe("src/file0.ts");
  });

  it("queries entries filtered by agent", () => {
    journal.recordFileChange("src/a.ts", "agent-001", "/wt1");
    journal.recordFileChange("src/b.ts", "agent-002", "/wt2");
    journal.recordIndexUpdate(["src/c.ts"]);

    const results = journal.query({ agentId: "agent-001" });
    expect(results).toHaveLength(1);
    expect(results[0].agent_id).toBe("agent-001");
  });

  it("matches index and merge entries by file prefix", () => {
    journal.recordIndexUpdate(["src/components/button.ts"]);
    journal.recordMergeCompleted("task-001", ["src/utils/helper.ts"]);

    // Should match both via prefix
    const results = journal.query({ files: ["src"] });
    expect(results).toHaveLength(2);
  });

  it("handles knowledge entries in file queries", () => {
    journal.recordKnowledgeUpdate("task-001", "agent-001", "summary");
    // Knowledge entries don't have files, so a file-based filter should not match
    const results = journal.query({ files: ["src"] });
    expect(results).toHaveLength(0);
  });
});
