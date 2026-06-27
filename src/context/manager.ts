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
  new (config: ContextProviderConfig) => ContextProvider
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
  private providers: ContextProvider[];

  constructor(repoRoot: string, config?: LaolConfig) {
    this.repoRoot = repoRoot;
    const cfg = config ?? loadConfig(repoRoot);
    this.providers = this.instantiateProviders(cfg);
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
                priority: "low",
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
        preStates.set(result.providerName, result.preState);
      }
    }

    // Sort: high priority first
    hints.sort((a, b) => {
      const order = { high: 0, medium: 1, low: 2 };
      return order[a.priority] - order[b.priority];
    });

    return { hints, preStates };
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
      [...preStates.entries()].map(async ([providerName, preState]) => {
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
