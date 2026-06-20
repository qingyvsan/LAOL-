import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { SymbolExtractor } from "../codebase/symbol-extractor";

/**
 * SymbolExtractor Tests
 *
 * Verifies enhanced TypeScript AST-based symbol extraction including
 * JSDoc, parameters, return types, imports, and call collection.
 */
describe("SymbolExtractor — extract", () => {
  let tmpDir: string;
  let extractor: SymbolExtractor;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "laol-ext-"));
    extractor = new SymbolExtractor();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- JSDoc extraction ---

  it("extracts JSDoc description from function", () => {
    const filePath = path.join(tmpDir, "jsdoc.ts");
    fs.writeFileSync(
      filePath,
      [
        "/**",
        " * Authenticate a user with credentials.",
        " * @param username - The user's login name",
        " * @param password - The user's secret password",
        " * @returns An auth token string",
        " */",
        "export function login(username: string, password: string): string {",
        "  return 'token';",
        "}",
      ].join("\n"),
      "utf-8"
    );

    const result = extractor.extract(filePath);
    expect(result).not.toBeNull();
    expect(result!.symbols).toHaveLength(1);

    const fn = result!.symbols[0];
    expect(fn.name).toBe("login");
    expect(fn.jsDoc).toBeDefined();
    expect(fn.jsDoc!.description).toContain("Authenticate a user");
    expect(fn.jsDoc!.params).toHaveLength(2);
    expect(fn.jsDoc!.params[0].name).toBe("username");
    expect(fn.jsDoc!.params[0].text).toContain("login name");
    expect(fn.jsDoc!.params[1].name).toBe("password");
    expect(fn.jsDoc!.params[1].text).toContain("secret password");
    expect(fn.jsDoc!.returns).toContain("auth token");
  });

  it("extracts JSDoc custom tags", () => {
    const filePath = path.join(tmpDir, "tags.ts");
    fs.writeFileSync(
      filePath,
      [
        "/**",
        " * @deprecated Use newLogin instead",
        " * @since 2.0.0",
        " */",
        "function oldLogin() {}",
      ].join("\n"),
      "utf-8"
    );

    const result = extractor.extract(filePath);
    expect(result).not.toBeNull();

    const fn = result!.symbols[0];
    expect(fn.jsDoc).toBeDefined();
    expect(fn.jsDoc!.tags).toHaveLength(2);
    expect(fn.jsDoc!.tags[0].name).toBe("deprecated");
    expect(fn.jsDoc!.tags[0].text).toContain("newLogin");
    expect(fn.jsDoc!.tags[1].name).toBe("since");
  });

  it("returns undefined jsDoc when no JSDoc is present", () => {
    const filePath = path.join(tmpDir, "no-jsdoc.ts");
    fs.writeFileSync(filePath, "function plain() {}", "utf-8");

    const result = extractor.extract(filePath);
    expect(result).not.toBeNull();
    expect(result!.symbols[0].jsDoc).toBeUndefined();
  });

  // --- Parameter extraction ---

  it("extracts function parameter signatures", () => {
    const filePath = path.join(tmpDir, "params.ts");
    fs.writeFileSync(
      filePath,
      "function connect(url: string, port: number = 5432, timeout?: number): void {}",
      "utf-8"
    );

    const result = extractor.extract(filePath);
    expect(result).not.toBeNull();

    const fn = result!.symbols[0];
    expect(fn.parameters).toBeDefined();
    expect(fn.parameters!).toHaveLength(3);

    expect(fn.parameters![0].name).toBe("url");
    expect(fn.parameters![0].type).toBe("string");
    expect(fn.parameters![0].optional).toBe(false);
    expect(fn.parameters![0].isRest).toBe(false);

    expect(fn.parameters![1].name).toBe("port");
    expect(fn.parameters![1].type).toBe("number");
    expect(fn.parameters![1].optional).toBe(false);
    expect(fn.parameters![1].defaultValue).toBe("5432");

    expect(fn.parameters![2].name).toBe("timeout");
    expect(fn.parameters![2].type).toBe("number");
    expect(fn.parameters![2].optional).toBe(true);
  });

  it("handles rest parameters", () => {
    const filePath = path.join(tmpDir, "rest.ts");
    fs.writeFileSync(
      filePath,
      "function log(...args: string[]): void {}",
      "utf-8"
    );

    const result = extractor.extract(filePath);
    expect(result).not.toBeNull();

    const fn = result!.symbols[0];
    expect(fn.parameters![0].name).toBe("args");
    expect(fn.parameters![0].isRest).toBe(true);
    expect(fn.parameters![0].type).toBe("string[]");
  });

  it("handles destructured parameters", () => {
    const filePath = path.join(tmpDir, "destructure.ts");
    fs.writeFileSync(
      filePath,
      "function render({ name, age }: { name: string; age: number }): string { return name; }",
      "utf-8"
    );

    const result = extractor.extract(filePath);
    expect(result).not.toBeNull();

    const fn = result!.symbols[0];
    expect(fn.parameters![0].name).toBe("<destructured>");
    expect(fn.parameters![0].type).toContain("{ name");
  });

  // --- Return type extraction ---

  it("extracts explicit return type", () => {
    const filePath = path.join(tmpDir, "return.ts");
    fs.writeFileSync(
      filePath,
      "function fetch(): Promise<Response> { return fetch('/'); }",
      "utf-8"
    );

    const result = extractor.extract(filePath);
    expect(result).not.toBeNull();

    expect(result!.symbols[0].returnType).toBe("Promise<Response>");
  });

  it("leaves returnType undefined for implicit returns", () => {
    const filePath = path.join(tmpDir, "implicit.ts");
    fs.writeFileSync(filePath, "function add(a: number, b: number) { return a + b; }", "utf-8");

    const result = extractor.extract(filePath);
    expect(result).not.toBeNull();

    expect(result!.symbols[0].returnType).toBeUndefined();
  });

  // --- Import extraction ---

  it("extracts named imports", () => {
    const filePath = path.join(tmpDir, "imports.ts");
    fs.writeFileSync(
      filePath,
      [
        "import { ref, computed } from 'vue';",
        "import { readFileSync } from 'node:fs';",
      ].join("\n"),
      "utf-8"
    );

    const result = extractor.extract(filePath);
    expect(result).not.toBeNull();
    expect(result!.imports).toHaveLength(2);

    expect(result!.imports[0].moduleSpecifier).toBe("vue");
    expect(result!.imports[0].namedImports).toEqual(["ref", "computed"]);

    expect(result!.imports[1].moduleSpecifier).toBe("node:fs");
    expect(result!.imports[1].namedImports).toEqual(["readFileSync"]);
  });

  it("extracts default and namespace imports", () => {
    const filePath = path.join(tmpDir, "import-default.ts");
    fs.writeFileSync(
      filePath,
      [
        "import React from 'react';",
        "import * as path from 'node:path';",
        "import fs, { promises as fsp } from 'node:fs';",
      ].join("\n"),
      "utf-8"
    );

    const result = extractor.extract(filePath);
    expect(result).not.toBeNull();
    expect(result!.imports).toHaveLength(3);

    expect(result!.imports[0].defaultImport).toBe("React");
    expect(result!.imports[1].namespaceImport).toBe("path");
    expect(result!.imports[2].defaultImport).toBe("fs");
    // TS AST stores the local binding name ("fsp"), not the source name ("promises")
    expect(result!.imports[2].namedImports).toContain("fsp");
  });

  // --- Call collection ---

  it("collects internal function calls", () => {
    const filePath = path.join(tmpDir, "calls.ts");
    fs.writeFileSync(
      filePath,
      [
        "function init() {",
        "  setup();",
        "  connect();",
        "  setup();  // duplicate call — should be deduplicated",
        "}",
      ].join("\n"),
      "utf-8"
    );

    const result = extractor.extract(filePath);
    expect(result).not.toBeNull();

    const fn = result!.symbols[0];
    expect(fn.calls).toBeDefined();
    const callNames = fn.calls!.map((c) => c.name);
    expect(callNames).toContain("setup");
    expect(callNames).toContain("connect");
    // setup appears on two different lines, so dedup by name:line allows both
    const setupCalls = fn.calls!.filter((c) => c.name === "setup");
    expect(setupCalls.length).toBe(2); // different lines = different entries
  });

  it("collects method calls from class bodies", () => {
    const filePath = path.join(tmpDir, "class-calls.ts");
    fs.writeFileSync(
      filePath,
      [
        "export class DataService {",
        "  fetch() {",
        "    this.parse();",
        "    return this.raw;",
        "  }",
        "  parse() {",
        "    JSON.parse(this.raw);",
        "  }",
        "}",
      ].join("\n"),
      "utf-8"
    );

    const result = extractor.extract(filePath);
    expect(result).not.toBeNull();

    const cls = result!.symbols.find((s) => s.kind === "class");
    expect(cls).toBeDefined();
    expect(cls!.calls).toBeDefined();
    // Class-level calls aggregate from all methods
    const callNames = cls!.calls!.map((c) => c.name);
    expect(callNames).toContain("parse");
  });

  // --- Class symbol extraction ---

  it("extracts class methods as separate symbols", () => {
    const filePath = path.join(tmpDir, "methods.ts");
    fs.writeFileSync(
      filePath,
      [
        "/** Manages user sessions */",
        "export class SessionManager {",
        "  /** Create a new session */",
        "  start(user: string) { return { id: 1, user }; }",
        "  /** End a session */",
        "  stop() {}",
        "}",
      ].join("\n"),
      "utf-8"
    );

    const result = extractor.extract(filePath);
    expect(result).not.toBeNull();

    const cls = result!.symbols.find((s) => s.kind === "class");
    expect(cls).toBeDefined();
    expect(cls!.name).toBe("SessionManager");
    expect(cls!.jsDoc!.description).toContain("Manages user sessions");

    const methods = result!.symbols.filter((s) => s.kind === "function");
    expect(methods).toHaveLength(2);

    const startMethod = methods.find((m) => m.name === "start");
    expect(startMethod).toBeDefined();
    expect(startMethod!.parameters).toBeDefined();
    expect(startMethod!.parameters![0].name).toBe("user");
    expect(startMethod!.jsDoc!.description).toContain("Create a new session");
  });

  // --- Arrow function variables ---

  it("extracts arrow function assigned to const as function symbol", () => {
    const filePath = path.join(tmpDir, "arrow.ts");
    fs.writeFileSync(
      filePath,
      [
        "/** Process items asynchronously */",
        "export const processItems = async (items: string[]): Promise<void> => {",
        "  await Promise.all(items.map(process));",
        "};",
      ].join("\n"),
      "utf-8"
    );

    const result = extractor.extract(filePath);
    expect(result).not.toBeNull();

    const fn = result!.symbols[0];
    expect(fn.name).toBe("processItems");
    expect(fn.kind).toBe("function"); // promoted from const
    expect(fn.exported).toBe(true);
    expect(fn.parameters).toBeDefined();
    expect(fn.parameters![0].name).toBe("items");
    expect(fn.returnType).toBe("Promise<void>");
    expect(fn.jsDoc!.description).toContain("Process items");
  });

  // --- Edge cases ---

  it("returns null for non-TS/JS files", () => {
    const filePath = path.join(tmpDir, "data.json");
    fs.writeFileSync(filePath, '{"key": "value"}', "utf-8");
    expect(extractor.extract(filePath)).toBeNull();
  });

  it("returns null for non-existent files", () => {
    const filePath = path.join(tmpDir, "no-such.ts");
    expect(extractor.extract(filePath)).toBeNull();
  });

  it("returns null for empty files", () => {
    const filePath = path.join(tmpDir, "empty.ts");
    fs.writeFileSync(filePath, "", "utf-8");
    expect(extractor.extract(filePath)).toBeNull();
  });
});

describe("SymbolExtractor — hashFile", () => {
  it("returns a 16-char hex string for a file", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "laol-hash-"));
    const filePath = path.join(tmpDir, "test.ts");
    fs.writeFileSync(filePath, "const x = 1;", "utf-8");

    const hash = SymbolExtractor.hashFile(filePath);
    expect(hash).toMatch(/^[a-f0-9]{16}$/);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns 'hash-error' for non-existent file", () => {
    expect(SymbolExtractor.hashFile("/no/such/file.ts")).toBe("hash-error");
  });
});
