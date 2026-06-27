import * as fs from "node:fs";
import * as path from "node:path";
import { SymbolExtractor } from "./symbol-extractor";
import { loadConfig } from "../config";
import { CodebaseIndexSchema } from "../data/schemas";
import type { LaolConfig, IndexedFile, CodebaseIndex, SymbolDef } from "../data/models";

/**
 * Query result with relevance scoring.
 */
export interface QueryResult {
  file: string;
  symbol: SymbolDef;
  relevance: number; // 0-100
  matchField: "name" | "jsDoc" | "tags" | "params";
}

/**
 * Index statistics.
 */
export interface IndexStats {
  totalFiles: number;
  totalSymbols: number;
  totalImports: number;
  symbolsByKind: Record<string, number>;
  lastBuilt: number | null;
}

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * CodebaseIndexer — builds and queries a structured index of project symbols.
 *
 * The index is stored at .multiagent/codebase-index.json and maps each
 * source file to its extracted symbols, imports, and metadata.
 *
 * Supports full and incremental builds, keyword search with relevance
 * scoring, per-file lookup, and aggregate statistics.
 */
export class CodebaseIndexer {
  private repoRoot: string;
  private config: LaolConfig["codebase_indexer"];
  private indexPath: string;
  private extractor: SymbolExtractor;

  constructor(repoRoot: string, config?: LaolConfig["codebase_indexer"]) {
    this.repoRoot = repoRoot;
    this.config = config ?? loadConfig(repoRoot).codebase_indexer;
    this.indexPath = path.join(repoRoot, ".multiagent", "codebase-index.json");
    this.extractor = new SymbolExtractor();
  }

  /**
   * Build the index. In incremental mode (full=false), only re-indexes
   * files whose content hash has changed since the last build.
   */
  build(full = false): IndexStats {
    const existing = full ? {} : this.loadIndex();
    const includePatterns = this.config.include;
    const excludePatterns = this.config.exclude;

    // Collect all matching files
    const files = this.collectFiles(includePatterns, excludePatterns);

    const newIndex: CodebaseIndex = {};
    let indexed = 0;
    let skipped = 0;

    for (const file of files) {
      const relPath = file.replace(/\\/g, "/");
      const absPath = path.join(this.repoRoot, file);

      // Incremental: skip unchanged files
      if (!full && existing[relPath]) {
        const hash = SymbolExtractor.hashFile(absPath);
        if (hash === existing[relPath].hash) {
          newIndex[relPath] = existing[relPath];
          skipped++;
          continue;
        }
      }

      const extracted = this.extractor.extract(absPath);
      if (extracted) {
        const hash = SymbolExtractor.hashFile(absPath);
        newIndex[relPath] = {
          file: relPath,
          symbols: extracted.symbols,
          imports: extracted.imports,
          hash,
          indexed_at: Date.now(),
        };
        indexed++;
      }
    }

    this.saveIndex(newIndex);
    return this.computeStats(newIndex);
  }

  /**
   * Re-index specific files, reading their contents from an optional source
   * directory (e.g. a worktree). Updates the shared index in-place.
   *
   * Used to keep the index fresh after agent file modifications without
   * requiring a full rebuild. Files that don't exist on disk are skipped.
   */
  reindexFiles(filePaths: string[], sourcePath?: string): void {
    const index = this.loadIndex();
    const basePath = sourcePath ?? this.repoRoot;

    for (const rawPath of filePaths) {
      const relPath = rawPath.replace(/\\/g, "/");
      const absPath = path.join(basePath, rawPath);

      if (!fs.existsSync(absPath)) continue;

      const extracted = this.extractor.extract(absPath);
      if (extracted) {
        const hash = SymbolExtractor.hashFile(absPath);
        index[relPath] = {
          file: relPath,
          symbols: extracted.symbols,
          imports: extracted.imports,
          hash,
          indexed_at: Date.now(),
        };
      }
    }

    this.saveIndex(index);
  }

  /**
   * Search the index for symbols matching a keyword.
   * Returns results sorted by relevance (highest first).
   */
  query(keyword: string): QueryResult[] {
    const index = this.loadIndex();
    const kw = keyword.toLowerCase();
    const results: QueryResult[] = [];

    for (const [filePath, entry] of Object.entries(index)) {
      for (const symbol of entry.symbols) {
        // Name match (highest relevance)
        if (symbol.name.toLowerCase().includes(kw)) {
          // Exact match scores higher
          const exact = symbol.name.toLowerCase() === kw;
          results.push({
            file: filePath,
            symbol,
            relevance: exact ? 100 : 80,
            matchField: "name",
          });
          continue;
        }

        // JSDoc description match
        if (symbol.jsDoc?.description.toLowerCase().includes(kw)) {
          results.push({
            file: filePath,
            symbol,
            relevance: 60,
            matchField: "jsDoc",
          });
          continue;
        }

        // JSDoc tag match
        if (symbol.jsDoc?.tags.some((t) => t.text.toLowerCase().includes(kw))) {
          results.push({
            file: filePath,
            symbol,
            relevance: 45,
            matchField: "tags",
          });
          continue;
        }

        // JSDoc param match
        if (symbol.jsDoc?.params.some((p) => p.text.toLowerCase().includes(kw))) {
          results.push({
            file: filePath,
            symbol,
            relevance: 30,
            matchField: "params",
          });
        }
      }
    }

    results.sort((a, b) => b.relevance - a.relevance);
    return results.slice(0, 50);
  }

  /**
   * Get all symbols and imports for a specific file.
   */
  getFileSymbols(filePath: string): IndexedFile | null {
    const index = this.loadIndex();
    return index[filePath] ?? null;
  }

  /**
   * Get aggregate index statistics.
   */
  getStats(): IndexStats {
    const index = this.loadIndex();
    return this.computeStats(index);
  }

  /**
   * Generate a comprehensive markdown document of all indexed symbols,
   * organized by file and grouped by kind (class → function → interface → …).
   *
   * Each symbol entry includes its JSDoc description, parameter signatures,
   * return types, and export status — suitable for human learning or LLM
   * context injection.
   *
   * @param filterFiles — optional glob patterns to restrict which files to
   *   include (e.g. `["src/agent/**"]`). If omitted, all files are included.
   */
  generateDocs(filterFiles?: string[]): string {
    const index = this.loadIndex();
    const files = Object.keys(index).sort();

    const filtered = filterFiles && filterFiles.length > 0
      ? files.filter((f) => filterFiles.some((pat) => this.matchSimpleGlob(f, pat)))
      : files;

    if (filtered.length === 0) {
      return "No indexed files found.";
    }

    let totalSymbols = 0;
    const lines: string[] = [];

    lines.push("# Project API Documentation");
    lines.push("");
    const builtTime = filtered.length > 0
      ? new Date(Math.max(...filtered.map((f) => index[f].indexed_at))).toISOString()
      : "unknown";
    lines.push(`> Generated: ${builtTime} | ${filtered.length} files`);
    lines.push("");

    // Table of contents
    lines.push("## Table of Contents");
    lines.push("");
    for (const file of filtered) {
      const name = file.replace(/^src\//, "").replace(/\.tsx?$/, "");
      lines.push(`- [${name}](#${this.slug(file)})`);
    }
    lines.push("");

    for (const file of filtered) {
      const entry = index[file];
      totalSymbols += entry.symbols.length;

      lines.push(`## ${file}`);
      lines.push("");

      // Group symbols by kind
      const byKind = new Map<string, SymbolDef[]>();
      for (const sym of entry.symbols) {
        const list = byKind.get(sym.kind) ?? [];
        list.push(sym);
        byKind.set(sym.kind, list);
      }

      const kindOrder = ["class", "function", "interface", "type", "const", "let", "var", "export", "module", "decorator"];
      for (const kind of kindOrder) {
        const syms = byKind.get(kind);
        if (!syms || syms.length === 0) continue;
        byKind.delete(kind);

        for (const sym of syms) {
          const exp = sym.exported ? " (exported)" : "";
          lines.push(`### ${capitalize(kind)}: \`${sym.name}\`${exp}`);
          lines.push(`_Lines ${sym.range[0]}–${sym.range[1]}_`);
          lines.push("");

          // JSDoc description
          if (sym.jsDoc?.description) {
            lines.push(sym.jsDoc.description);
            lines.push("");
          }

          // Parameters
          if (sym.parameters && sym.parameters.length > 0) {
            lines.push("**Parameters:**");
            lines.push("");
            for (const p of sym.parameters) {
              const opt = p.optional ? " (optional)" : "";
              const rest = p.isRest ? "rest " : "";
              const def = p.defaultValue ? ` = ${p.defaultValue}` : "";
              lines.push(`- \`${rest}${p.name}: ${p.type}${opt}${def}\``);
            }
            lines.push("");
          }

          // Return type
          if (sym.returnType) {
            lines.push(`**Returns:** \`${sym.returnType}\``);
            lines.push("");
          }

          // JSDoc params doc
          if (sym.jsDoc?.params && sym.jsDoc.params.length > 0) {
            lines.push("**Parameter docs:**");
            lines.push("");
            for (const p of sym.jsDoc.params) {
              if (p.text) {
                lines.push(`- \`${p.name}\` — ${p.text}`);
              }
            }
            lines.push("");
          }

          // JSDoc returns doc
          if (sym.jsDoc?.returns) {
            lines.push(`**Returns description:** ${sym.jsDoc.returns}`);
            lines.push("");
          }

          // JSDoc tags
          if (sym.jsDoc?.tags && sym.jsDoc.tags.length > 0) {
            for (const t of sym.jsDoc.tags) {
              lines.push(`> **@${t.name}** ${t.text}`);
            }
            lines.push("");
          }

          // Calls (if any)
          if (sym.calls && sym.calls.length > 0) {
            const callList = sym.calls
              .slice(0, 8)
              .map((c) => `\`${c.name}()\``)
              .join(", ");
            const more = sym.calls.length > 8 ? ` _(+${sym.calls.length - 8} more)_` : "";
            lines.push(`**Calls:** ${callList}${more}`);
            lines.push("");
          }

          lines.push("---");
          lines.push("");
        }
      }

      // Remaining kinds (not in kindOrder)
      for (const [, syms] of byKind) {
        for (const sym of syms) {
          const exp = sym.exported ? " (exported)" : "";
          lines.push(`### ${capitalize(sym.kind)}: \`${sym.name}\`${exp}`);
          lines.push(`_Lines ${sym.range[0]}–${sym.range[1]}_`);
          lines.push("");
          if (sym.jsDoc?.description) {
            lines.push(sym.jsDoc.description);
            lines.push("");
          }
          lines.push("---");
          lines.push("");
        }
      }
    }

    // Footer stats
    lines.push("---");
    lines.push("");
    lines.push(`_${filtered.length} files, ${totalSymbols} symbols documented._`);

    return lines.join("\n");
  }

  // ---- Internal ----

  private loadIndex(): CodebaseIndex {
    if (!fs.existsSync(this.indexPath)) return {};
    try {
      const raw = JSON.parse(fs.readFileSync(this.indexPath, "utf-8"));
      return CodebaseIndexSchema.parse(raw) as CodebaseIndex;
    } catch {
      return {};
    }
  }

  private saveIndex(index: CodebaseIndex): void {
    const dir = path.dirname(this.indexPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.indexPath, JSON.stringify(index, null, 2), "utf-8");
  }

  private computeStats(index: CodebaseIndex): IndexStats {
    const symbolsByKind: Record<string, number> = {};
    let totalSymbols = 0;
    let totalImports = 0;

    for (const entry of Object.values(index)) {
      totalSymbols += entry.symbols.length;
      totalImports += entry.imports.length;
      for (const sym of entry.symbols) {
        symbolsByKind[sym.kind] = (symbolsByKind[sym.kind] ?? 0) + 1;
      }
    }

    const files = Object.keys(index);
    const lastBuilt = files.length > 0
      ? Math.max(...files.map((f) => index[f].indexed_at))
      : null;

    return {
      totalFiles: files.length,
      totalSymbols,
      totalImports,
      symbolsByKind,
      lastBuilt,
    };
  }

  /**
   * Walk the source tree and collect files matching include patterns
   * but not exclude patterns.
   */
  private collectFiles(includePatterns: string[], excludePatterns: string[]): string[] {
    const includeRegexes = includePatterns.map((p) => this.globToRegex(p));
    const excludeRegexes = excludePatterns.map((p) => this.globToRegex(p));

    const results: string[] = [];
    this.walkDir(this.repoRoot, "", includeRegexes, excludeRegexes, results);
    return results;
  }

  private walkDir(
    baseDir: string,
    relDir: string,
    includeRegexes: RegExp[],
    excludeRegexes: RegExp[],
    results: string[]
  ): void {
    const fullDir = path.join(baseDir, relDir);
    let entries: fs.Dirent[];

    try {
      entries = fs.readdirSync(fullDir, { withFileTypes: true });
    } catch {
      return; // permission error, etc.
    }

    for (const entry of entries) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;

      // Skip dot-files/dirs
      if (entry.name.startsWith(".")) continue;

      if (entry.isDirectory()) {
        // Check if this directory is excluded
        if (excludeRegexes.some((re) => re.test(relPath + "/"))) continue;
        this.walkDir(baseDir, relPath, includeRegexes, excludeRegexes, results);
      } else if (entry.isFile()) {
        // Check exclude first
        if (excludeRegexes.some((re) => re.test(relPath))) continue;
        // Check include
        if (includeRegexes.some((re) => re.test(relPath))) {
          results.push(relPath);
        }
      }
    }
  }

  /** Generate an anchor slug from a file path. */
  private slug(filePath: string): string {
    return filePath
      .replace(/[\\/]/g, "-")
      .replace(/\./g, "-")
      .replace(/[^a-zA-Z0-9-]/g, "")
      .toLowerCase();
  }

  /**
   * Lightweight wildcard match: * matches any non-slash sequence.
   * Used for the --files filter in generateDocs, not for full glob parsing.
   */
  private matchSimpleGlob(filePath: string, pattern: string): boolean {
    const re = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, "[^/]*");
    return new RegExp(`^${re}$`).test(filePath);
  }

  /**
   * Convert a glob pattern to a RegExp.
   * Supports: ** (any depth), * (non-slash chars), ? (single non-slash char).
   */
  private globToRegex(pattern: string): RegExp {
    // Normalize backslashes to forward slashes
    const normalized = pattern.replace(/\\/g, "/");

    // Use placeholders to avoid later transforms re-matching regex syntax
    // introduced by earlier transforms (e.g. ?→[^/] corrupts (?:.+/)?).
    const PLACEHOLDERS = [
      "___GLOB_STARSTAR_SLASH___",
      "___GLOB_SLASH_STARSTAR___",
      "___GLOB_STARSTAR___",
      "___GLOB_STAR___",
      "___GLOB_QMARK___",
    ];

    let re = normalized
      .replace(/\*\*\//g, PLACEHOLDERS[0])    // **/ → placeholder
      .replace(/\/\*\*$/g, PLACEHOLDERS[1])   // /** (at end) → placeholder
      .replace(/\*\*/g, PLACEHOLDERS[2])      // ** → placeholder
      .replace(/\*/g, PLACEHOLDERS[3])        // * → placeholder
      .replace(/\?/g, PLACEHOLDERS[4]);       // ? → placeholder

    // Escape regex special characters (now that glob chars are placeholders)
    re = re.replace(/[.+^${}()|[\]\\]/g, "\\$&");

    // Replace placeholders with their regex equivalents
    re = re
      .replace(new RegExp(PLACEHOLDERS[0], "g"), "(?:.+/)?")  // **/ → any dir prefix
      .replace(new RegExp(PLACEHOLDERS[1], "g"), "/.*")       // /** → any suffix
      .replace(new RegExp(PLACEHOLDERS[2], "g"), ".*")        // ** → anything
      .replace(new RegExp(PLACEHOLDERS[3], "g"), "[^/]*")     // * → non-slash chars
      .replace(new RegExp(PLACEHOLDERS[4], "g"), "[^/]");     // ? → single non-slash char

    return new RegExp(`^${re}$`);
  }
}
