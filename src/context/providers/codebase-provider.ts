import * as path from "node:path";
import * as fs from "node:fs";
import { CodebaseIndexer } from "../../codebase/indexer";
import type { ContextProvider } from "../provider";
import type { Task, ContextHint } from "../../data/models";
import type { ContextProviderConfig } from "../../data/models";

/**
 * Codebase symbol index provider.
 *
 * Queries the CodebaseIndexer for symbols in target files and injects
 * a compact summary into the agent prompt. This gives the agent
 * "what exists here" context alongside the live diagnostic hints
 * from other providers (tsc errors, lint violations, test results).
 *
 * Uses the existing index — does not trigger a rebuild. If no index
 * file exists, returns an empty hint list.
 */
export class CodebaseProvider implements ContextProvider {
  readonly name = "codebase";
  readonly description =
    "Injects symbol index summaries for target files";

  private config: ContextProviderConfig;
  private repoRoot: string;

  constructor(config: ContextProviderConfig, repoRoot?: string) {
    this.config = config;
    this.repoRoot = repoRoot ?? "";
  }

  applies(task: Task): boolean {
    return task.target_files.length > 0;
  }

  async activate(
    worktreePath: string,
    task: Task
  ): Promise<ContextHint[]> {
    // Resolve repo root: prefer the injected one, fall back to walking up
    const root = this.repoRoot || this.resolveRepoRoot(worktreePath);
    if (!root) return [];

    const indexer = new CodebaseIndexer(root);
    const stats = indexer.getStats();
    if (stats.totalFiles === 0) return [];

    const parts: string[] = [];
    let totalSymbols = 0;
    const MAX_CHARS = 3000;

    for (const file of task.target_files.slice(0, 8)) {
      // Normalize file path (index uses forward slashes)
      const idxEntry = indexer.getFileSymbols(file.replace(/\\/g, "/"));
      if (!idxEntry || idxEntry.symbols.length === 0) continue;

      totalSymbols += idxEntry.symbols.length;

      // Group by kind for compact display
      const byKind = new Map<string, string[]>();
      for (const sym of idxEntry.symbols) {
        const list = byKind.get(sym.kind) ?? [];
        const exported = sym.exported ? "export " : "";
        const sig = sym.parameters && sym.parameters.length > 0
          ? `(${sym.parameters.map((p) => p.name).join(", ")})`
          : "()";
        list.push(`${exported}${sym.kind} ${sym.name}${sig}`);
        byKind.set(sym.kind, list);
      }

      const lines: string[] = [`  ${file} (${idxEntry.symbols.length} symbols):`];
      for (const [kind, names] of byKind) {
        const suffix = names.length > 5
          ? ` (+${names.length - 5} more ${kind}s)`
          : "";
        lines.push(`    ${kind}: ${names.slice(0, 5).join(", ")}${suffix}`);
      }
      parts.push(...lines);

      // Cap total output
      if (parts.join("\n").length > MAX_CHARS) {
        parts.push(`  ... (truncated, ${task.target_files.length - parts.length} more files)`);
        break;
      }
    }

    if (parts.length === 0) return [];

    const content = `[CODEBASE SYMBOLS] ${totalSymbols} symbol(s) across target files:\n${parts.join("\n")}`;
    const trimmed = content.length > MAX_CHARS
      ? content.slice(0, MAX_CHARS) + "\n... (truncated)"
      : content;

    return [
      {
        source: this.name,
        priority: "low",
        title: `Codebase: ${totalSymbols} symbol(s) in target file(s)`,
        content: trimmed,
        timestamp: Date.now(),
      },
    ];
  }

  // ---- internal ----

  /**
   * Walk up from the worktree path to find the repo root containing .multiagent/.
   */
  private resolveRepoRoot(worktreePath: string): string | null {
    let dir = path.resolve(worktreePath);
    while (true) {
      if (fs.existsSync(path.join(dir, ".multiagent"))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }
}
