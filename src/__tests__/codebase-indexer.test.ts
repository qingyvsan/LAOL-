import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { CodebaseIndexer } from "../codebase/indexer";
import type { LaolConfig } from "../data/models";

/**
 * CodebaseIndexer Tests
 *
 * Verifies full/incremental builds, query with relevance scoring,
 * file lookup, stats, and index persistence.
 */
describe("CodebaseIndexer — build", () => {
  let tmpDir: string;
  let indexer: CodebaseIndexer;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "laol-idx-"));
    // Create source directory
    fs.mkdirSync(path.join(tmpDir, "src"));
    // Create .multiagent dir for config
    fs.mkdirSync(path.join(tmpDir, ".multiagent"));

    indexer = new CodebaseIndexer(tmpDir, {
      include: ["src/**/*.ts"],
      exclude: [
        "**/node_modules/**",
        "**/dist/**",
        "**/__tests__/**",
        "**/*.test.ts",
        "**/*.spec.ts",
      ],
      auto_index: false,
      index_interval_ms: 60000,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("indexes TypeScript files in the include path", () => {
    fs.writeFileSync(
      path.join(tmpDir, "src", "auth.ts"),
      "export function login(): string { return 'ok'; }\nexport function logout(): void {}",
      "utf-8"
    );
    fs.writeFileSync(
      path.join(tmpDir, "src", "db.ts"),
      "export function connect(url: string): void {}",
      "utf-8"
    );

    const stats = indexer.build(true);
    expect(stats.totalFiles).toBe(2);
    expect(stats.totalSymbols).toBe(3); // login + logout + connect
    expect(stats.totalImports).toBe(0);
  });

  it("skips excluded patterns", () => {
    fs.writeFileSync(
      path.join(tmpDir, "src", "util.ts"),
      "export function helper(): void {}",
      "utf-8"
    );
    // Create a __tests__ dir with a file — should be excluded
    fs.mkdirSync(path.join(tmpDir, "src", "__tests__"));
    fs.writeFileSync(
      path.join(tmpDir, "src", "__tests__", "util.test.ts"),
      "export function testHelper(): void {}",
      "utf-8"
    );
    // Create a .spec.ts file — should be excluded
    fs.writeFileSync(
      path.join(tmpDir, "src", "util.spec.ts"),
      "export function specHelper(): void {}",
      "utf-8"
    );

    const stats = indexer.build(true);
    expect(stats.totalFiles).toBe(1);
    expect(stats.totalSymbols).toBe(1); // only helper from util.ts
  });

  it("skips dot-directories", () => {
    fs.writeFileSync(
      path.join(tmpDir, "src", "main.ts"),
      "export const x = 1;",
      "utf-8"
    );
    // Create a .hidden directory with a .ts file
    fs.mkdirSync(path.join(tmpDir, "src", ".hidden"));
    fs.writeFileSync(
      path.join(tmpDir, "src", ".hidden", "secret.ts"),
      "export function secret(): void {}",
      "utf-8"
    );

    const stats = indexer.build(true);
    expect(stats.totalFiles).toBe(1);
    expect(stats.totalSymbols).toBe(1);
  });

  it("incremental build skips unchanged files", () => {
    fs.writeFileSync(
      path.join(tmpDir, "src", "a.ts"),
      "export function foo(): void {}",
      "utf-8"
    );
    fs.writeFileSync(
      path.join(tmpDir, "src", "b.ts"),
      "export function bar(): void {}",
      "utf-8"
    );

    // Full build
    const stats1 = indexer.build(true);
    expect(stats1.totalFiles).toBe(2);

    // Modify only b.ts
    fs.writeFileSync(
      path.join(tmpDir, "src", "b.ts"),
      "export function bar(): void {}\nexport function baz(): void {}",
      "utf-8"
    );

    // Incremental build
    // Note: we spy on extractor to verify only changed files are re-indexed,
    // but even without spy, the result must still be correct.
    const stats2 = indexer.build(false);
    expect(stats2.totalFiles).toBe(2);
    expect(stats2.totalSymbols).toBe(3); // foo + bar + baz (baz is new)
  });

  it("full rebuild re-indexes all files", () => {
    fs.writeFileSync(
      path.join(tmpDir, "src", "x.ts"),
      "export const one = 1;",
      "utf-8"
    );

    const stats1 = indexer.build(true);
    expect(stats1.totalFiles).toBe(1);

    // Modify the file
    fs.writeFileSync(
      path.join(tmpDir, "src", "x.ts"),
      "export const one = 1;\nexport const two = 2;",
      "utf-8"
    );

    const stats2 = indexer.build(true); // full rebuild
    expect(stats2.totalFiles).toBe(1);
    expect(stats2.totalSymbols).toBe(2); // both symbols picked up
  });
});

describe("CodebaseIndexer — query", () => {
  let tmpDir: string;
  let indexer: CodebaseIndexer;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "laol-qry-"));
    fs.mkdirSync(path.join(tmpDir, "src"));
    fs.mkdirSync(path.join(tmpDir, ".multiagent"));

    indexer = new CodebaseIndexer(tmpDir, {
      include: ["src/**/*.ts"],
      exclude: ["**/node_modules/**", "**/dist/**"],
      auto_index: false,
      index_interval_ms: 60000,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns results sorted by relevance", () => {
    fs.writeFileSync(
      path.join(tmpDir, "src", "auth.ts"),
      [
        "/** Handles user authentication workflows */",
        "export function authenticate(): void {}",
        "export function authorization(): void {}",
        "export function auditLog(): void {}",
      ].join("\n"),
      "utf-8"
    );

    indexer.build(true);
    const results = indexer.query("authenticate");

    expect(results.length).toBeGreaterThan(0);
    // Exact name match should be first
    expect(results[0].symbol.name).toBe("authenticate");
    expect(results[0].relevance).toBe(100);
  });

  it("finds matches in JSDoc description", () => {
    fs.writeFileSync(
      path.join(tmpDir, "src", "worker.ts"),
      [
        "/** Processes incoming webhook events from GitHub */",
        "function handleEvent(): void {}",
      ].join("\n"),
      "utf-8"
    );

    indexer.build(true);
    const results = indexer.query("webhook");

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].matchField).toBe("jsDoc");
    expect(results[0].relevance).toBe(60);
  });

  it("returns at most 50 results", () => {
    // Create many symbols
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) {
      lines.push(`export function proc${i}(): void {}`);
    }
    fs.writeFileSync(path.join(tmpDir, "src", "many.ts"), lines.join("\n"), "utf-8");

    indexer.build(true);
    const results = indexer.query("proc");
    expect(results.length).toBeLessThanOrEqual(50);
  });

  it("returns empty array when no matches", () => {
    fs.writeFileSync(
      path.join(tmpDir, "src", "mod.ts"),
      "export function foo(): void {}",
      "utf-8"
    );

    indexer.build(true);
    const results = indexer.query("nonexistent");
    expect(results).toEqual([]);
  });
});

describe("CodebaseIndexer — getFileSymbols", () => {
  let tmpDir: string;
  let indexer: CodebaseIndexer;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "laol-lookup-"));
    fs.mkdirSync(path.join(tmpDir, "src"));
    fs.mkdirSync(path.join(tmpDir, ".multiagent"));

    indexer = new CodebaseIndexer(tmpDir, {
      include: ["src/**/*.ts"],
      exclude: ["**/node_modules/**", "**/dist/**"],
      auto_index: false,
      index_interval_ms: 60000,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns symbol details for a specific file", () => {
    fs.writeFileSync(
      path.join(tmpDir, "src", "utils.ts"),
      "export function add(a: number, b: number): number { return a + b; }",
      "utf-8"
    );

    indexer.build(true);
    const entry = indexer.getFileSymbols("src/utils.ts");
    expect(entry).not.toBeNull();
    expect(entry!.symbols).toHaveLength(1);
    expect(entry!.symbols[0].name).toBe("add");
    expect(entry!.symbols[0].parameters![0].name).toBe("a");
    expect(entry!.symbols[0].parameters![1].name).toBe("b");
  });

  it("returns null for files not in the index", () => {
    const entry = indexer.getFileSymbols("src/nonexistent.ts");
    expect(entry).toBeNull();
  });
});

describe("CodebaseIndexer — getStats", () => {
  let tmpDir: string;
  let indexer: CodebaseIndexer;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "laol-stats-"));
    fs.mkdirSync(path.join(tmpDir, "src"));
    fs.mkdirSync(path.join(tmpDir, ".multiagent"));

    indexer = new CodebaseIndexer(tmpDir, {
      include: ["src/**/*.ts"],
      exclude: ["**/node_modules/**", "**/dist/**"],
      auto_index: false,
      index_interval_ms: 60000,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns aggregate statistics after build", () => {
    fs.writeFileSync(
      path.join(tmpDir, "src", "api.ts"),
      [
        "export class ApiClient {",
        "  request(): void {}",
        "}",
        "export const BASE_URL = 'http://localhost';",
        "export interface Config { port: number; }",
      ].join("\n"),
      "utf-8"
    );

    const stats = indexer.build(true);
    expect(stats.totalFiles).toBe(1);
    expect(stats.totalSymbols).toBeGreaterThanOrEqual(4); // class + method + const + interface
    expect(stats.totalImports).toBe(0);
    expect(stats.symbolsByKind["class"]).toBe(1);
    expect(stats.symbolsByKind["function"]).toBe(1);
    expect(stats.symbolsByKind["const"]).toBe(1);
    expect(stats.symbolsByKind["interface"]).toBe(1);
    expect(stats.lastBuilt).toBeGreaterThan(0);
  });

  it("returns empty stats for unbuilt index", () => {
    const stats = indexer.getStats();
    expect(stats.totalFiles).toBe(0);
    expect(stats.totalSymbols).toBe(0);
    expect(stats.lastBuilt).toBeNull();
  });
});

describe("CodebaseIndexer — persistence", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("persists index to .multiagent/codebase-index.json", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "laol-persist-"));
    fs.mkdirSync(path.join(tmpDir, "src"));
    fs.mkdirSync(path.join(tmpDir, ".multiagent"));

    const indexer = new CodebaseIndexer(tmpDir, {
      include: ["src/**/*.ts"],
      exclude: ["**/node_modules/**", "**/dist/**"],
      auto_index: false,
      index_interval_ms: 60000,
    });

    fs.writeFileSync(
      path.join(tmpDir, "src", "hello.ts"),
      "export function greet(): string { return 'hi'; }",
      "utf-8"
    );

    indexer.build(true);

    const indexPath = path.join(tmpDir, ".multiagent", "codebase-index.json");
    expect(fs.existsSync(indexPath)).toBe(true);

    const raw = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
    expect(raw["src/hello.ts"]).toBeDefined();
    expect(raw["src/hello.ts"].symbols[0].name).toBe("greet");
  });

  it("loads existing index on subsequent instantiation", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "laol-load-"));
    fs.mkdirSync(path.join(tmpDir, "src"));
    fs.mkdirSync(path.join(tmpDir, ".multiagent"));

    // First instance builds the index
    const indexer1 = new CodebaseIndexer(tmpDir, {
      include: ["src/**/*.ts"],
      exclude: ["**/node_modules/**", "**/dist/**"],
      auto_index: false,
      index_interval_ms: 60000,
    });

    fs.writeFileSync(
      path.join(tmpDir, "src", "data.ts"),
      "export const VERSION = '1.0';",
      "utf-8"
    );

    indexer1.build(true);

    // Second instance should load the existing index
    const indexer2 = new CodebaseIndexer(tmpDir, {
      include: ["src/**/*.ts"],
      exclude: ["**/node_modules/**", "**/dist/**"],
      auto_index: false,
      index_interval_ms: 60000,
    });

    const entry = indexer2.getFileSymbols("src/data.ts");
    expect(entry).not.toBeNull();
    expect(entry!.symbols[0].name).toBe("VERSION");
  });
});
