import * as path from "node:path";
import { loadConfig } from "../config";
import { TypeScriptProvider } from "./providers/typescript-provider";
import { ESLintProvider } from "./providers/eslint-provider";
import { TestProvider } from "./providers/test-provider";
import { GitProvider } from "./providers/git-provider";
import { CustomProvider } from "./providers/custom-provider";
import { PythonProvider } from "./providers/python-provider";
import { CodebaseProvider } from "./providers/codebase-provider";
import type { ContextProvider } from "./provider";
import type {
  Task,
  ContextHint,
  ProviderDelta,
  ContextProviderConfig,
  LiveContextState,
  LaolConfig,
} from "../data/models";

/**
 * Registry mapping provider names to their constructors.
 * Add new providers here when extending the system.
 */
const PROVIDER_REGISTRY: Record<
  string,
  new (config: ContextProviderConfig, repoRoot?: string) => ContextProvider
> = {
  typescript: TypeScriptProvider,
  eslint: ESLintProvider,
  test: TestProvider,
  git: GitProvider,
  custom: CustomProvider,
  python: PythonProvider,
  codebase: CodebaseProvider,
};

/**
 * ContextManager — central orchestrator for live context providers.
 *
 * On instantiation, reads context_providers from config and creates
 * instances for all enabled providers. Providers that fail to construct
 * are silently skipped (logged to stderr).
 *
 * collectPreHints() runs all relevant providers in parallel before the
 * agent starts work. collectPostHints() runs deactivate() on providers
 * that produced pre-state, computing before/after deltas.
 */
export class ContextManager {
  private repoRoot: string;
  private config: LaolConfig;
  private providers: ContextProvider[];

  constructor(repoRoot: string, config?: LaolConfig) {
    this.repoRoot = repoRoot;
    this.config = config ?? loadConfig(repoRoot);
    this.providers = this.instantiateProviders(this.config);
  }

  /**
   * Run all applicable providers in parallel before the agent starts.
   *
   * Returns structured hints to inject into the agent prompt, sorted
   * by priority (high → medium → low). Provider failures are caught
   * individually — a crash in one provider never affects others.
   *
   * Also returns a Map of providerName → opaque state for later
   * deactivate() calls.
   */
  async collectPreHints(
    task: Task,
    worktreePath: string
  ): Promise<{ hints: ContextHint[]; preStates: Map<string, unknown> }> {
    const applicable = this.providers.filter((p) => {
      try {
        return p.applies(task);
      } catch {
        return false;
      }
    });

    if (applicable.length === 0) {
      return { hints: [], preStates: new Map() };
    }

    const results = await Promise.all(
      applicable.map(async (provider) => {
        try {
          const hints = await provider.activate(worktreePath, task);
          // Attach provider name to metadata for later deactivate
          return {
            providerName: provider.name,
            hints,
            preState: hints.length > 0 ? { providerName: provider.name } : null,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(
            `[ContextManager] Provider "${provider.name}" failed: ${message}`
          );
          return {
            providerName: provider.name,
            hints: [
              {
                source: provider.name,
                priority: "low" as const,
                title: `${provider.name}: Provider error`,
                content: `[${provider.name.toUpperCase()}] Provider failed: ${message}`,
                timestamp: Date.now(),
              },
            ],
            preState: null,
          };
        }
      })
    );

    // Collect hints and pre-states
    const hints: ContextHint[] = [];
    const preStates = new Map<string, unknown>();

    for (const result of results) {
      hints.push(...result.hints);
      if (result.preState) {
        // Tag with _clean if no high-priority issues were found.
        // collectPostHints uses this to skip re-running tools that
        // were already clean (avoids redundant tsc/eslint/test runs).
        const hasIssues = result.hints.some((h) => h.priority === "high");
        preStates.set(result.providerName, {
          ...result.preState,
          _clean: !hasIssues,
        });
      }
    }

    // Deduplicate: remove hints with overlapping content from different providers.
    // TypeScript and ESLint may both report the same code issue; keep the first
    // (higher priority) and skip near-duplicates.
    const dedupedHints = this.deduplicateHints(hints);

    // Sort: high priority first
    dedupedHints.sort((a, b) => {
      const order = { high: 0, medium: 1, low: 2 };
      return order[a.priority] - order[b.priority];
    });

    return { hints: dedupedHints, preStates };
  }

  /**
   * Run deactivate() on providers that produced pre-state during
   * collectPreHints(). Returns post-task hints and before/after deltas.
   */
  async collectPostHints(
    task: Task,
    worktreePath: string,
    preStates: Map<string, unknown>
  ): Promise<{ hints: ContextHint[]; deltas: ProviderDelta[] }> {
    if (preStates.size === 0) {
      return { hints: [], deltas: [] };
    }

    const providerMap = new Map(
      this.providers.map((p) => [p.name, p])
    );

    const results = await Promise.all(
      [...preStates.entries()]
        .filter(([providerName, preState]) => {
          // Skip providers with post_task_enabled explicitly set to false
          const providerCfg = this.config.context_providers[providerName];
          if (providerCfg?.post_task_enabled === false) return false;
          // Skip providers that had no issues pre-task (avoid redundant re-runs)
          const state = preState as Record<string, unknown> | null;
          if (state?._clean === true) return false;
          return true;
        })
        .map(async ([providerName, preState]) => {
          const provider = providerMap.get(providerName);
          if (!provider?.deactivate) return null;

        try {
          return await provider.deactivate(worktreePath, task, preState);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(
            `[ContextManager] Provider "${providerName}" deactivate failed: ${message}`
          );
          return null;
        }
      })
    );

    const hints: ContextHint[] = [];
    const deltas: ProviderDelta[] = [];

    for (const result of results) {
      if (!result) continue;
      hints.push(...result.hints);
      if (result.delta) deltas.push(result.delta);
    }

    return { hints, deltas };
  }

  /**
   * Format a ContextHint into a string suitable for prompt injection.
   * Prefixed with the source as a tag, followed by the content.
   */
  static formatHint(hint: ContextHint): string {
    return `[${hint.source.toUpperCase()}] ${hint.title}\n${hint.content}`;
  }

  /**
   * Format an array of hints for prompt injection.
   * Each hint is separated by a blank line.
   */
  static formatHints(hints: ContextHint[]): string {
    return hints.map((h) => ContextManager.formatHint(h)).join("\n\n");
  }

  /**
   * Get the list of active provider names for status/debugging.
   */
  getProviderNames(): string[] {
    return this.providers.map((p) => p.name);
  }

  /**
   * Remove hints whose content substantially overlaps with another hint
   * from a different provider. Keeps the hint that appears first (typically
   * from the first provider to complete) and skips its near-duplicates.
   *
   * This prevents TypeScript and ESLint from both reporting the same code
   * issue in the agent's prompt, wasting context tokens.
   */
  private deduplicateHints(hints: ContextHint[]): ContextHint[] {
    if (hints.length <= 1) return hints;

    const result: ContextHint[] = [];

    for (const hint of hints) {
      // Check if this hint's content substantially overlaps with any
      // already-kept hint from a DIFFERENT provider
      const isDuplicate = result.some((kept) => {
        if (kept.source === hint.source) return false; // same provider, keep

        // Fast check: same title = likely duplicate
        if (kept.title === hint.title) return true;

        // Content overlap check: if >60% of lines overlap, treat as duplicate
        const keptLines = new Set(kept.content.split("\n"));
        const hintLines = hint.content.split("\n");
        if (hintLines.length === 0) return false;
        const overlap = hintLines.filter((l) => keptLines.has(l)).length;
        return overlap / hintLines.length > 0.6;
      });

      if (!isDuplicate) {
        result.push(hint);
      }
    }

    return result;
  }

  // ---- internal ----

  private instantiateProviders(cfg: LaolConfig): ContextProvider[] {
    const providers: ContextProvider[] = [];
    const providerCfgs = cfg.context_providers ?? {};

    for (const [name, providerCfg] of Object.entries(providerCfgs)) {
      if (!providerCfg.enabled) continue;

      const Ctor = PROVIDER_REGISTRY[name];
      if (!Ctor) {
        console.warn(
          `[ContextManager] Unknown provider "${name}" in config — skipping`
        );
        continue;
      }

      try {
        providers.push(new Ctor(providerCfg, this.repoRoot));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `[ContextManager] Failed to construct provider "${name}": ${message}`
        );
      }
    }

    return providers;
  }
}
