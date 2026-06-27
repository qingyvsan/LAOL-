// ============================================================
// ContextProvider base interface and helpers
// ============================================================

import type { Task, ContextHint, ProviderDelta, ContextProviderConfig } from "../data/models";

/**
 * Interface implemented by every context provider.
 *
 * Each provider queries a live system (compiler, linter, test runner, git,
 * custom commands) and returns structured hints injected into the agent prompt.
 *
 * Providers are instantiated per-task by ContextManager. activate() runs
 * before the agent starts; deactivate() runs after to compute deltas.
 */
export interface ContextProvider {
  readonly name: string;
  readonly description: string;

  /** Whether this provider is relevant for the given task. */
  applies(task: Task): boolean;

  /** Run before the agent starts work. */
  activate(worktreePath: string, task: Task): Promise<ContextHint[]>;

  /** Run after the agent finishes (optional). */
  deactivate?(
    worktreePath: string,
    task: Task,
    preState: unknown
  ): Promise<{ hints: ContextHint[]; delta: ProviderDelta | null }>;
}

/**
 * Factory function signature for creating providers from config.
 */
export type ProviderFactory = (
  config: ContextProviderConfig
) => ContextProvider;
