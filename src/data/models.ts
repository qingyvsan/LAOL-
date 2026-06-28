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
  kind: "function" | "class" | "const" | "let" | "var" | "export" | "interface" | "type" | "module" | "decorator";
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

// --- Waiting Lock Request (scheduler queue) ---

/** A lock request parked in the waiting queue when the target file is held by another agent. */
export interface WaitingLockRequest {
  taskId: string;
  agentId: string;
  files: string[];
  requestedAt: number;
}

// --- Worktree Entry ---

export interface WorktreeEntry {
  path: string;
  task_id: string | null;
  branch: string | null;
  state: "available" | "in_use" | "initializing" | "error";
}

// --- Laol Configuration ---

// --- Context Provider System ---

/**
 * A single context hint produced by a provider.
 * Injected into the agent's prompt before task execution.
 */
export interface ContextHint {
  /** Provider that produced this hint, e.g. "typescript", "git", "test". */
  source: string;
  /** Importance level. High-priority hints are injected first. */
  priority: "high" | "medium" | "low";
  /** One-line summary shown to the agent. */
  title: string;
  /** Markdown content injected into the agent's prompt. */
  content: string;
  /** Optional path to a file with the full raw output (large outputs go here, not in content). */
  artifactPath?: string;
  /** Unix timestamp ms when the hint was produced. */
  timestamp: number;
}

/**
 * Before/after comparison produced by a provider's deactivate() method.
 */
export interface ProviderDelta {
  /** Provider that produced this delta, e.g. "typescript". */
  source: string;
  /** Pre-task counts. */
  before: { errors: number; warnings: number };
  /** Post-task counts. */
  after: { errors: number; warnings: number };
  /** Issues that existed before but are now resolved. */
  fixed: string[];
  /** Issues that did not exist before but appeared after the task. */
  introduced: string[];
}

/**
 * Per-provider configuration in .multiagent/config.json.
 */
export interface ContextProviderConfig {
  /** Whether this provider is active. */
  enabled: boolean;
  /** Glob patterns for files this provider cares about. If omitted, applies to all files. */
  include?: string[];
  /** Max execution time in seconds. */
  timeout_seconds: number;
  /** Provider-specific options (e.g. test runner binary path). */
  options?: Record<string, unknown>;
  /** Whether to run deactivate() after the task to compute before/after deltas. Default: true. */
  post_task_enabled?: boolean;
}

/**
 * Interface implemented by every context provider.
 *
 * Each provider queries a live system (compiler, linter, test runner, git, etc.)
 * and returns structured hints that get injected into the agent's prompt.
 *
 * Providers are instantiated per-task. The ContextManager runs activate()
 * before the agent starts and deactivate() after it finishes to compute deltas.
 */
export interface ContextProvider {
  /** Unique provider name, e.g. "typescript", "eslint", "test", "git". */
  readonly name: string;
  /** Human-readable description for status/logging output. */
  readonly description: string;

  /**
   * Whether this provider is relevant for the given task.
   * Called before activate() — providers that return false are skipped.
   */
  applies(task: Task): boolean;

  /**
   * Run before the agent starts work.
   * @param worktreePath - Absolute path to the isolated worktree.
   * @param task - The task being executed.
   * @returns Context hints to inject into the agent prompt.
   */
  activate(worktreePath: string, task: Task): Promise<ContextHint[]>;

  /**
   * Run after the agent finishes work. Optional — if not provided,
   * no post-task comparison is performed for this provider.
   * @param worktreePath - Absolute path to the isolated worktree.
   * @param task - The completed task.
   * @param preState - Opaque state returned by activate() via ContextHint metadata.
   * @returns Post-task hints and an optional before/after delta.
   */
  deactivate?(
    worktreePath: string,
    task: Task,
    preState: unknown
  ): Promise<{ hints: ContextHint[]; delta: ProviderDelta | null }>;
}

/**
 * Stored state from a provider's activate() phase, passed to deactivate().
 */
export interface LiveContextState {
  providerName: string;
  /** Opaque payload the provider uses to compute the delta. */
  payload: unknown;
}

/**
 * Configuration for interactive terminal mode.
 * Agents open a new terminal window with full Claude Code experience.
 */
export interface InteractiveAgentConfig {
  /** Max time to wait for the interactive session before marking stuck (seconds). */
  terminal_timeout_seconds: number;
  /** Interval for polling sentinel file removal (ms). */
  poll_interval_ms: number;
  /** Directory under .multiagent/ for session state files. */
  session_dir: string;
  /** Optional custom terminal command override. */
  terminal_cmd?: string;
}

/**
 * Result of an interactive terminal session.
 */
export interface InteractiveResult {
  exitCode: number | null;
  sentinelRemoved: boolean;
  durationMs: number;
}

// ---- ChangeJournal types ----

export type ChangeType = "file" | "index" | "knowledge" | "merge";

export interface ChangeEntry {
  id: string;
  type: ChangeType;
  timestamp: number;
  agent_id?: string;
  file?: string;
  files?: string[];
  task_id?: string;
  summary?: string;
  worktree?: string;
}

export interface ChangeQueryFilter {
  type?: ChangeType | "all";
  files?: string[];
  since?: number;
  agentId?: string;
  limit?: number;
}

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
    /** Execution mode: "piped" (stdin, non-interactive) or "interactive" (new terminal window). */
    mode: "piped" | "interactive";
    /** Configuration for interactive terminal mode. */
    interactive?: InteractiveAgentConfig;
    /** Per-agent worktree pool size. Falls back to scheduler.pool_size if not set. */
    worktree_pool_size?: number;
  };
  locks: {
    initial_ttl_ms: number;
    stable_ttl_ms: number;
    stable_threshold: number;
    probe_timeout_ms: number;
    /** Max time an agent waits in the lock queue before giving up (ms). Default: 600_000 (10 min). */
    lock_waiting_timeout_ms: number;
    /** Enable cycle detection in the wait-for graph. Default: true. */
    deadlock_detection_enabled: boolean;
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
    /** Whether to re-index modified files after agent tasks complete. */
    auto_index: boolean;
    /** Debounce interval in ms for auto-indexing. */
    index_interval_ms: number;
  };
  /** Live context providers that query toolchains before/after agent tasks. */
  context_providers: Record<string, ContextProviderConfig>;
}
