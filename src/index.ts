// LAOL - Multi-agent collaborative coding system
// Public API surface

export * from "./data/models";
export { TaskStore } from "./task/task-store";
export { TaskWatcher } from "./task/task-watcher";
export { LockManager } from "./lock/lock-manager";
export { LeaseManager } from "./lock/lease-manager";
export { SymbolResolver } from "./lock/symbol-resolver";
export { Scheduler } from "./scheduler/scheduler";
export { ConflictChecker } from "./scheduler/conflict-checker";
export { HealthMonitor } from "./scheduler/health-monitor";
export { CircuitBreaker } from "./scheduler/circuit-breaker";
export { AgentWorker } from "./agent/agent-worker";
export { AgentRunner } from "./agent/agent-runner";
export { ClaudeCodeExecutor } from "./agent/claude-executor";
export type { ClaudeExecutionResult } from "./agent/claude-executor";
export { Heartbeat } from "./agent/heartbeat";
export { Checkpoint, RebaseConflictError } from "./agent/checkpoint";
export { Perception } from "./agent/perception";
export { WorktreePool } from "./worktree/pool";
export { MergeDriver } from "./merge/merge-driver";
export { parseConflictBlocks, rebuildFile, hasConflictMarkers } from "./merge/conflict-parser";
export * from "./merge/ast-merge";
export * from "./merge/llm-merge";
export { SandboxValidator } from "./merge/sandbox-validator";
export { ClaudeLLMProvider } from "./merge/claude-llm-provider";
export { EventBus } from "./events/event-bus";
export { SocketServer } from "./events/socket-server";
export { SocketClient } from "./events/socket-client";
export { WalManager } from "./wal/wal-manager";
export { RegistryManager } from "./registry/registry-manager";
export { KnowledgeStore } from "./knowledge/knowledge-store";
export type { KnowledgeEntry } from "./knowledge/knowledge-store";
export { loadConfig, saveConfig, resolveRepoRoot, DEFAULT_CONFIG } from "./config";
