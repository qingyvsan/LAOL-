import * as fs from "node:fs";
import * as path from "node:path";
import { LaolConfigSchema } from "./data/schemas";
import type { LaolConfig } from "./data/models";

// Default configuration
export const DEFAULT_CONFIG: LaolConfig = {
  scheduler: {
    port: 9123,
    pool_size: 4,
  },
  merge_checks: [
    { name: "type-check", cmd: "npx tsc --noEmit", timeout: 60 },
    { name: "lint", cmd: "npx eslint src/ --max-warnings 0", timeout: 30 },
  ],
  merge_driver: "ai-merge",
  merge_driver_config: {
    same_function_strategy: "always_llm",
    cache_size: 100,
    cache_ttl: 300,
    quorum_enabled: false,
  },
  llm: {
    provider: "claude",
    api_key_env: "ANTHROPIC_API_KEY",
    model: "claude-sonnet-4-6",
  },
  agent: {
    heartbeat_interval_ms: 25000,
    checkpoint_min_interval_ms: 30000,
    perception_check_interval_ms: 15000,
  },
  locks: {
    initial_ttl_ms: 60000,
    stable_ttl_ms: 180000,
    stable_threshold: 2,
    probe_timeout_ms: 45000,
  },
  claude_executor: {
    binary_path: "claude",
    timeout_seconds: 300,
    max_budget_usd: 5,
    allowed_tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    effort: "high",
    skip_permissions: true,
  },
  codebase_indexer: {
    include: ["src/**/*.ts", "src/**/*.tsx"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/.multiagent/**",
      "**/__tests__/**",
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/*.spec.ts",
      "**/*.spec.tsx",
    ],
    auto_index: true,
    index_interval_ms: 60000,
  },
};

/**
 * Load configuration from .multiagent/config.json.
 * Merges with defaults — user config overrides default values.
 */
export function loadConfig(repoRoot: string): LaolConfig {
  const configPath = path.join(repoRoot, ".multiagent", "config.json");

  if (!fs.existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const parsed = LaolConfigSchema.parse(raw);
    return deepMerge(DEFAULT_CONFIG as unknown as Record<string, unknown>, parsed as unknown as Record<string, unknown>) as unknown as LaolConfig;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[laol] Invalid config.json, using defaults: ${message}`);
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Save configuration to .multiagent/config.json.
 */
export function saveConfig(repoRoot: string, config: LaolConfig): void {
  const multiagentDir = path.join(repoRoot, ".multiagent");
  if (!fs.existsSync(multiagentDir)) {
    fs.mkdirSync(multiagentDir, { recursive: true });
  }

  const configPath = path.join(multiagentDir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}

/**
 * Deep merge two objects. Source overrides target.
 * Simple implementation — sufficient for our flat-ish config.
 */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };

  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = target[key];

    if (
      sv !== undefined &&
      tv !== null &&
      typeof tv === "object" &&
      !Array.isArray(tv) &&
      typeof sv === "object" &&
      !Array.isArray(sv) &&
      sv !== null
    ) {
      result[key] = deepMerge(tv as Record<string, unknown>, sv as Record<string, unknown>);
    } else if (sv !== undefined) {
      result[key] = sv;
    }
  }

  return result;
}

/**
 * Resolve the repository root by walking up from cwd looking for .multiagent/ or .git/.
 */
export function resolveRepoRoot(cwd?: string): string {
  let dir = cwd ?? process.cwd();

  while (true) {
    const multiagentDir = path.join(dir, ".multiagent");
    const gitDir = path.join(dir, ".git");

    if (fs.existsSync(multiagentDir) || fs.existsSync(gitDir)) {
      return dir;
    }

    const parent = path.dirname(dir);
    if (parent === dir) {
      // Reached filesystem root without finding repo
      return cwd ?? process.cwd();
    }
    dir = parent;
  }
}
