// ============================================================
// LAOL Data Models — Core TypeScript Interfaces
// ============================================================

// --- Task Status ---

export type TaskStatus =
  | "pending"
  | "in_progress"
  | "done"
  | "failed"
  | "stuck"
  | "blocked_by_rebase";

// --- Task ---

export interface Task {
  id: string; // uuid v4
  status: TaskStatus;
  description: string;
  target_files: string[]; // relative paths from repo root (may be empty if agent discovers files)
  assigned_agent: string | null;
  created_at: number; // Unix timestamp ms
  updated_at: number; // Unix timestamp ms
  dependency: string | null; // task ID this task depends on
  metadata: Record<string, unknown>; // semantic_warning, risk_level, retry_count, etc.
  version: number; // optimistic concurrency control
}

// --- Lock ---

export type LockPhase = "initial" | "stable";

export interface Lock {
  file: string; // "src/auth.ts" or "src/auth.ts#login"
  holder: string; // agent ID
  task_id: string;
  expires_at: number; // Unix timestamp ms
  phase: LockPhase;
  last_heartbeat: number; // Unix timestamp ms
  renew_count: number;
  created_at: number; // Unix timestamp ms
}

// --- Registry Entry (per module) ---

export interface RegistryEntry {
  exports: string[]; // e.g. ["login", "logout", "validateToken"]
  hash: string; // content hash of the exported module
  modified_by: string; // agent ID
  updated_at: number; // Unix timestamp ms
}

export interface RegistryData {
  [modulePath: string]: RegistryEntry;
}

// --- WAL Record ---

export interface WalRecord {
  ts: number;
  op: "assign" | "acquire_lock" | "release_lock" | "complete" | "fail" | "heartbeat" | "commit";
  task?: string;
  agent?: string;
  file?: string;
  holder?: string;
  reason?: string;
  expires?: number;
  files?: string[];
  [key: string]: unknown;
}

// --- Agent State (Circuit Breaker) ---

export type AgentCondition = "normal" | "degraded" | "quarantined";

export interface AgentState {
  agent_id: string;
  failures: number;
  state: AgentCondition;
  last_failure_reason: string | null;
  last_success_at: number | null;
}

// --- Event Types (for EventBus) ---

export interface LaolEvents {
  task_created: [task: Task];
  task_assigned: [task: Task, agent: string];
  task_completed: [task: Task];
  task_failed: [task: Task, reason: string];
  lock_acquired: [lock: Lock];
  lock_released: [file: string];
  lock_expired: [file: string];
  heartbeat_lost: [agentId: string];
  agent_connected: [agentId: string];
  agent_disconnected: [agentId: string];
  merge_required: [taskId: string, branch: string];
  merge_completed: [taskId: string];
  merge_rejected: [taskId: string, reason: string];
}

// --- Conflict Check Result ---

export interface ConflictResult {
  can_assign: boolean;
  reason?: string;
  risk_level?: "low" | "high";
  warnings?: string[];
}

// --- Merge Check Config ---

export interface MergeCheck {
  name: string;
  cmd: string;
  timeout: number; // seconds
}

// --- Merge Validation Result ---

export interface ValidationResult {
  passed: boolean;
  failed_check?: string;
  stdout?: string;
  stderr?: string;
  message?: string;
}

// --- Conflict Block (from git merge-file) ---

export interface ConflictBlock {
  ours: string;
  theirs: string;
  base: string;
  oursRange: [number, number];
  theirsRange: [number, number];
}

// --- Merge Attempt Result ---

export interface MergeAttempt {
  resolved: boolean;
  method: "auto" | "ast" | "llm" | "unresolved";
  resolvedCode?: string;
  quorumDiff?: string; // when quorum mode produces different results
}

// --- Symbol Definition (from tree-sitter AST parse) ---

/**
 * JSDoc documentation extracted from a symbol.
 */
export interface JsDocInfo {
  description: string;
  tags: { name: string; text: string }[];
  params: { name: string; text: string }[];
  returns: string;
}

/**
 * A parameter of a function, method, or constructor.
 */
export interface ParamInfo {
  name: string;
  type: string;
  optional: boolean;
  isRest: boolean;
  defaultValue?: string;
}

/**
 * A function call site found inside a symbol's body.
 */
export interface CallInfo {
  name: string;
  line: number;
}

/**
 * An import declaration at file level.
 */
export interface ImportInfo {
  moduleSpecifier: string;
  namedImports: string[];
  defaultImport: string | null;
  namespaceImport: string | null;
}

export interface SymbolDef {
  name: string;
  kind: "function" | "class" | "const" | "let" | "var" | "export" | "interface" | "type";
  range: [number, number]; // line range
  exported: boolean;
  // Rich metadata (optional — backward compatible with SymbolResolver)
  jsDoc?: JsDocInfo;
  parameters?: ParamInfo[];
  returnType?: string;
  calls?: CallInfo[];
}

// --- Codebase Index ---

/**
 * A single indexed file's complete symbol information.
 */
export interface IndexedFile {
  file: string;
  symbols: SymbolDef[];
  imports: ImportInfo[];
  hash: string;
  indexed_at: number;
}

/**
 * The full codebase index, keyed by relative file path.
 */
export type CodebaseIndex = Record<string, IndexedFile>;

// --- Lock Acquisition Result ---

export interface AcquireResult {
  success: boolean;
  reason?: string;
  locks?: Lock[];
}

// --- Worktree Entry ---

export interface WorktreeEntry {
  path: string;
  task_id: string | null;
  branch: string | null;
  state: "available" | "in_use" | "initializing" | "error";
}

// --- Laol Configuration ---

export interface LaolConfig {
  scheduler: {
    port: number;
    pool_size: number;
  };
  merge_checks: MergeCheck[];
  merge_driver: "ai-merge";
  merge_driver_config: {
    same_function_strategy: "always_llm";
    cache_size: number;
    cache_ttl: number;
    quorum_enabled: boolean;
  };
  llm: {
    provider: "claude" | "openai" | "custom";
    api_key_env: string;
    model: string;
    secondary_model?: string; // for quorum mode
  };
  agent: {
    heartbeat_interval_ms: number;
    checkpoint_min_interval_ms: number;
    perception_check_interval_ms: number;
  };
  locks: {
    initial_ttl_ms: number;
    stable_ttl_ms: number;
    stable_threshold: number;
    probe_timeout_ms: number;
  };
  claude_executor: {
    binary_path: string;
    timeout_seconds: number;
    max_budget_usd: number;
    allowed_tools: string[];
    effort: "low" | "medium" | "high" | "max";
    skip_permissions: boolean;
  };
  codebase_indexer: {
    /** Glob patterns for files to include. */
    include: string[];
    /** Glob patterns for files to exclude. */
    exclude: string[];
    /** Whether to auto-index on file changes (reserved for future use). */
    auto_index: boolean;
    /** Debounce interval in ms for auto-indexing. */
    index_interval_ms: number;
  };
}
