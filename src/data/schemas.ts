// ============================================================
// LAOL Zod Schemas — Runtime Validation
// ============================================================

import { z } from "zod";

// --- Task Status ---

export const TaskStatusSchema = z.enum([
  "pending",
  "in_progress",
  "done",
  "failed",
  "stuck",
  "blocked_by_rebase",
]);

// --- Task ---

export const TaskSchema = z.object({
  id: z.string().uuid(),
  status: TaskStatusSchema,
  description: z.string().min(1),
  target_files: z.array(z.string().min(1)).default([]),
  assigned_agent: z.string().nullable(),
  created_at: z.number().positive(),
  updated_at: z.number().positive(),
  dependency: z.string().uuid().nullable(),
  metadata: z.record(z.unknown()).default({}),
  version: z.number().int().positive().default(1),
});

// --- Lock Phase ---

export const LockPhaseSchema = z.enum(["initial", "stable"]);

// --- Lock ---

export const LockSchema = z.object({
  file: z.string().min(1),
  holder: z.string().min(1),
  task_id: z.string().uuid(),
  expires_at: z.number().positive(),
  phase: LockPhaseSchema,
  last_heartbeat: z.number().positive(),
  renew_count: z.number().int().min(0),
  created_at: z.number().positive(),
});

// --- Registry ---

export const RegistryEntrySchema = z.object({
  exports: z.array(z.string()),
  hash: z.string().min(1),
  modified_by: z.string().min(1),
  updated_at: z.number().positive(),
});

export const RegistryDataSchema = z.record(z.string(), RegistryEntrySchema);

// --- WAL Record ---

export const WalRecordSchema = z.object({
  ts: z.number().positive(),
  op: z.enum([
    "assign",
    "acquire_lock",
    "release_lock",
    "complete",
    "fail",
    "heartbeat",
    "commit",
  ]),
  task: z.string().optional(),
  agent: z.string().optional(),
  file: z.string().optional(),
  holder: z.string().optional(),
  reason: z.string().optional(),
  expires: z.number().optional(),
  files: z.array(z.string()).optional(),
}).passthrough();

// --- Agent State ---

export const AgentConditionSchema = z.enum(["normal", "degraded", "quarantined"]);

export const AgentStateSchema = z.object({
  agent_id: z.string().min(1),
  failures: z.number().int().min(0),
  state: AgentConditionSchema,
  last_failure_reason: z.string().nullable(),
  last_success_at: z.number().positive().nullable(),
});

// --- Merge Check ---

export const MergeCheckSchema = z.object({
  name: z.string().min(1),
  cmd: z.string().min(1),
  timeout: z.number().positive(),
});

// --- JsDoc Info ---

export const JsDocInfoSchema = z.object({
  description: z.string().default(""),
  tags: z.array(z.object({ name: z.string(), text: z.string() })).default([]),
  params: z.array(z.object({ name: z.string(), text: z.string() })).default([]),
  returns: z.string().default(""),
});

// --- Param Info ---

export const ParamInfoSchema = z.object({
  name: z.string(),
  type: z.string().default("any"),
  optional: z.boolean().default(false),
  isRest: z.boolean().default(false),
  defaultValue: z.string().optional(),
});

// --- Call Info ---

export const CallInfoSchema = z.object({
  name: z.string(),
  line: z.number().int().positive(),
});

// --- Import Info ---

export const ImportInfoSchema = z.object({
  moduleSpecifier: z.string(),
  namedImports: z.array(z.string()).default([]),
  defaultImport: z.string().nullable().default(null),
  namespaceImport: z.string().nullable().default(null),
});

// --- SymbolDef (extended) ---

export const SymbolDefSchema = z.object({
  name: z.string(),
  kind: z.enum(["function", "class", "const", "let", "var", "export", "interface", "type", "module", "decorator"]),
  range: z.tuple([z.number().int().positive(), z.number().int().positive()]),
  exported: z.boolean(),
  jsDoc: JsDocInfoSchema.optional(),
  parameters: z.array(ParamInfoSchema).optional(),
  returnType: z.string().optional(),
  calls: z.array(CallInfoSchema).optional(),
});

// --- Indexed File ---

export const IndexedFileSchema = z.object({
  file: z.string(),
  symbols: z.array(SymbolDefSchema),
  imports: z.array(ImportInfoSchema),
  hash: z.string(),
  indexed_at: z.number().positive(),
});

// --- Codebase Index ---

export const CodebaseIndexSchema = z.record(z.string(), IndexedFileSchema);

// --- Codebase Indexer Config ---

export const CodebaseIndexerConfigSchema = z.object({
  include: z.array(z.string()).default(["src/**/*.ts", "src/**/*.tsx", "src/**/*.py"]),
  exclude: z.array(z.string()).default([
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/.multiagent/**",
    "**/__tests__/**",
    "**/*.test.ts",
    "**/*.test.tsx",
    "**/*.spec.ts",
    "**/*.spec.tsx",
    "**/*.test.py",
    "**/*.spec.py",
    "**/test_*.py",
    "**/*_test.py",
  ]),
  auto_index: z.boolean().default(true),
  index_interval_ms: z.number().int().min(1000).default(60000),
});

// --- Laol Config ---

export const LaolConfigSchema = z.object({
  scheduler: z.object({
    port: z.number().int().positive().default(9123),
    pool_size: z.number().int().min(1).max(16).default(4),
  }),
  merge_checks: z.array(MergeCheckSchema).default([
    { name: "type-check", cmd: "npx tsc --noEmit", timeout: 60 },
    { name: "lint", cmd: "npx eslint src/ --max-warnings 0", timeout: 30 },
  ]),
  merge_driver: z.literal("ai-merge"),
  merge_driver_config: z.object({
    same_function_strategy: z.literal("always_llm"),
    cache_size: z.number().int().min(1).default(100),
    cache_ttl: z.number().int().min(1).default(300),
    quorum_enabled: z.boolean().default(false),
  }),
  llm: z.object({
    provider: z.enum(["claude", "openai", "custom"]).default("claude"),
    api_key_env: z.string().default("ANTHROPIC_API_KEY"),
    model: z.string().default("claude-sonnet-4-6"),
    secondary_model: z.string().optional(),
  }),
  agent: z.object({
    heartbeat_interval_ms: z.number().int().min(5000).default(25000),
    checkpoint_min_interval_ms: z.number().int().min(10000).default(30000),
    mode: z.enum(["piped", "interactive"]).default("interactive"),
    interactive: z.object({
      terminal_timeout_seconds: z.number().int().min(60).max(86400).default(7200),
      poll_interval_ms: z.number().int().min(1000).max(30000).default(2000),
      session_dir: z.string().default("sessions"),
      terminal_cmd: z.string().optional(),
    }).optional(),
  }),
  locks: z.object({
    initial_ttl_ms: z.number().int().min(10000).default(60000),
    stable_ttl_ms: z.number().int().min(30000).default(180000),
    stable_threshold: z.number().int().min(1).default(2),
    probe_timeout_ms: z.number().int().min(10000).default(45000),
  }),
  claude_executor: z.object({
    binary_path: z.string().default("claude"),
    timeout_seconds: z.number().int().min(30).max(3600).default(300),
    max_budget_usd: z.number().positive().default(5),
    allowed_tools: z.array(z.string()).default(["Read", "Write", "Edit", "Bash", "Glob", "Grep"]),
    effort: z.enum(["low", "medium", "high", "max"]).default("high"),
    skip_permissions: z.boolean().default(true),
  }),
  codebase_indexer: CodebaseIndexerConfigSchema.optional(),
  context_providers: z.record(
    z.string(),
    z.object({
      enabled: z.boolean(),
      include: z.array(z.string()).optional(),
      timeout_seconds: z.number().int().min(1).max(600),
      options: z.record(z.unknown()).optional(),
    })
  ).default({}),
});

// --- Context Provider Schemas ---

export const ContextHintSchema = z.object({
  source: z.string().min(1),
  priority: z.enum(["high", "medium", "low"]),
  title: z.string().min(1),
  content: z.string(),
  artifactPath: z.string().optional(),
  timestamp: z.number().positive(),
});

export const ProviderDeltaSchema = z.object({
  source: z.string().min(1),
  before: z.object({ errors: z.number().int().min(0), warnings: z.number().int().min(0) }),
  after: z.object({ errors: z.number().int().min(0), warnings: z.number().int().min(0) }),
  fixed: z.array(z.string()),
  introduced: z.array(z.string()),
});

export const ContextProviderConfigSchema = z.object({
  enabled: z.boolean(),
  include: z.array(z.string()).optional(),
  timeout_seconds: z.number().int().min(1).max(600),
  options: z.record(z.unknown()).optional(),
});

// --- Derived types ---

export type TaskInput = z.input<typeof TaskSchema>;
export type TaskOutput = z.output<typeof TaskSchema>;
export type LockInput = z.input<typeof LockSchema>;
export type LockOutput = z.output<typeof LockSchema>;
export type LaolConfigInput = z.input<typeof LaolConfigSchema>;
export type LaolConfigOutput = z.output<typeof LaolConfigSchema>;
