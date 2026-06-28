# LAOL — Multi-Agent Collaborative Coding System

> **Zero databases. Zero message queues.** File-system-level atomic locks. Git worktree isolation. AI-powered semantic merge. Agents auto-discover files at runtime.

LAOL lets multiple Claude Code AI agents safely modify the same codebase **in parallel**. Agents dynamically discover which files to edit — no need to pre-declare targets. The scheduler handles lock acquisition on-demand, so agents can expand their scope mid-task without conflicts.

## Architecture

```
                           ┌──────────────────────────┐
                           │   .multiagent/            │
                           │   ├── tasks/              │  ← User drops task JSON
                           │   ├── locks/              │  ← Atomic file locks
                           │   ├── staging/            │  ← Two-phase commit
                           │   ├── wal/                │  ← Crash recovery log
                           │   ├── knowledge/          │  ← Shared agent memory
                           │   ├── journal/            │  ← Change log + cache
                           │   ├── cache/tsc/          │  ← TSC result cache
                           │   ├── reports/            │  ← Read-only task reports
                           │   ├── sessions/           │  ← Interactive session state
                           │   └── config.json         │
                           └──────┬───────────────────┘
                                  │
                    ┌─────────────┴─────────────┐
                    │     Scheduler (TCP:9123)   │
                    │  ┌───────────────────────┐ │
                    │  │ Conflict Checker      │ │
                    │  │ Circuit Breaker       │ │
                    │  │ Health Monitor        │ │
                    │  │ ChangeJournal         │ │
                    │  │ Event Bus             │ │
                    │  └───────────────────────┘ │
                    └──────┬─────────┬───────────┘
                           │         │
              ┌────────────┘         └────────────┐
              ▼                                   ▼
    ┌──────────────────┐               ┌──────────────────┐
    │  Agent A          │               │  Agent B          │
    │  ┌──────────────┐ │               │  ┌──────────────┐ │
    │  │ Worktree A   │ │               │  │ Worktree B   │ │
    │  │ (isolated)   │ │               │  │ (isolated)   │ │
    │  │ Claude Code  │ │               │  │ Claude Code  │ │
    │  └──────────────┘ │               │  └──────────────┘ │
    │  ┌──────────────┐ │               │  ┌──────────────┐ │
    │  │ Knowledge    │ │               │  │ Knowledge    │ │
    │  │ Store        │ │               │  │ Store        │ │
    │  └──────────────┘ │               │  └──────────────┘ │
    └──────────────────┘               └──────────────────┘
              │                                   │
              │     ┌──────────────────────┐      │
              └─────│   Shared TSC Cache    │──────┘
                    │   (tree-hash keyed)   │
                    └──────────────────────┘
              │                                   │
              └──────────┬────────────────────────┘
                         ▼
              ┌──────────────────────┐
              │   Semantic Merge     │
              │  L1: Auto (no conflict)  │
              │  L2: AST (diff functions)│
              │  L3: LLM (same function) │
              │  └── Sandbox CI check    │
              └──────────────────────┘
                         │
                         ▼
                    main branch
```

## Context Provider System

LAOL features a **live context injection pipeline** that runs real toolchains before and after each agent task. This eliminates the need for agents to waste tokens running `tsc`, `eslint`, or `git blame` themselves — the results are pre-computed.

**7 built-in providers** run in parallel with individual error isolation:

| Provider | What it does |
|----------|-------------|
| **TypeScriptProvider** | Runs `tsc --noEmit`, filters errors to target files (cap 15). Results cached by git tree hash — agents sharing the same base commit reuse a single tsc run. |
| **ESLintProvider** | Runs `eslint --format compact` on target TS files (cap 10) |
| **TestProvider** | Runs related tests via vitest/jest/pytest and injects pass/fail baseline. Post-task only re-runs previously failing tests, not the full suite. |
| **GitProvider** | Git blame, recent commits, and active agent activity in overlapping modules |
| **PythonProvider** | Runs `ruff check` + `mypy` with graceful degradation if tools absent |
| **CodebaseProvider** | Queries the symbol index for target file structure (functions, classes, exports) |
| **CustomProvider** | Executes user-defined pre/post commands from config |

### Language Support

The context provider system is language-aware. Full coverage varies by language:

| Language | Type Check | Lint | Test | Symbols | Git | Custom | Coverage |
|----------|------------|------|------|---------|-----|--------|----------|
| **TypeScript/JS** | tsc | eslint | vitest/jest | TS AST | Yes | Yes | 7/7 providers |
| **Python** | mypy | ruff | pytest | Python AST | Yes | Yes | 5/7 providers |
| **Other** (Go, Rust, Java, etc.) | — | — | — | — | Yes | Yes | 2/7 providers |

**TypeScript/JavaScript** projects get the full pipeline: type-checking (tsc), linting (eslint), test running (vitest/jest), symbol indexing (TS compiler API), and git diagnostics — all with tree-hash caching to avoid redundant runs across agents.

**Python** projects have solid diagnostics coverage (ruff + mypy, both tree-hash cached) and test support (pytest with test-file inference), but lack a dedicated ESLint equivalent. Ruff covers most lint rules so this gap is narrow in practice. Symbol indexing supports Python AST extraction with Sphinx/Google docstring parsing.

**Other languages** can only use `GitProvider` (works with any git repo) and `CustomProvider` (user-defined pre/post commands). To add diagnostics for a new language, configure `custom` in `context_providers` with shell commands that output errors in a grep-friendly format.

**Smart hint routing:** Critical diagnostics (type errors, lint violations, test results) are injected directly into the agent prompt. Lower-priority context (git blame, codebase symbols) is written to `.multiagent/diagnostics.md` — available on demand without consuming prompt tokens. This saves ~350 tokens per task.

**Cross-provider deduplication:** When TypeScript and ESLint report the same code issue, the duplicate is automatically filtered out (>60% content overlap detection), preventing redundant context from wasting tokens.

After the task, providers with `deactivate()` re-run to compute **before/after deltas** (errors fixed, new failures introduced), stored in the KnowledgeStore for other agents.

**Token impact:** Pre-computed diagnostics reduce agent-initiated tool calls by an estimated **55-65%** — from ~2,500-8,700 tokens down to ~1,000-3,100 per task.

## Change Journal (Pull-Based Change Tracking)

Instead of broadcasting every file modification to all agents (creating noise for agents working on unrelated files), LAOL uses a **pull-based ChangeJournal**. Agents query for changes relevant to their specific target files on demand.

| Component | Purpose |
|-----------|---------|
| **ChangeJournal** (scheduler) | Records file changes, index updates, and merge completions to an append-only NDJSON log at `.multiagent/journal/change-log.ndjson`. Memory-capped at 10,000 entries. |
| **ChangeJournalClient** (agent) | Queries the journal via `change_query` socket message at task start, filters to entries matching the agent's target files, and writes a local cache at `.multiagent/journal/latest-changes.md`. |
| **Knowledge push** (targeted) | Knowledge updates are pushed only to busy agents (those actively executing a task), not broadcast to idle ones. Agents write received knowledge to `.multiagent/notifications.md`. |

**Result:** Agents only see changes that matter to them. File change noise is eliminated; knowledge sharing is preserved.

## Knowledge Sharing

LAOL maintains a **shared agent memory** at `.multiagent/knowledge/`. When agents complete exploration or modification tasks, they record what they learned — which files were explored, what was discovered, and a human-readable summary.

Before starting work, each agent queries the knowledge store for:

- **Predecessor context** — What did the dependency task do? What files did it touch?
- **Relevant discoveries** — Have other agents already explored files in the same module?
- **Provider deltas** — What lint/type errors did the previous agent fix or introduce?

This prevents agents from re-exploring the same code or repeating known mistakes. The store uses the file system directly — one JSON file per task — with O(1) lookups by task ID. An in-memory cache (5-minute TTL) with in-place updates avoids re-reading files on every query.

## Codebase Indexer

LAOL includes a built-in **symbol-level codebase indexer** that extracts and indexes every function, class, interface, type alias, and variable in your project — along with their JSDoc/docstring documentation, parameter signatures, return types, imports, and call graphs.

**Supported languages:** TypeScript/JavaScript (`.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, `.cjs`) and Python (`.py`).

- **TypeScript/JavaScript** — parsed via the TypeScript compiler API. Extracts JSDoc annotations (`@param`, `@returns`, custom tags).
- **Python** — parsed via Python's built-in `ast` module through a subprocess. Extracts Sphinx-style (`:param`, `:returns`, `:raises`, `:rtype`) and Google-style (`Args:`, `Returns:`) docstrings. Type hints are converted to parameter/return types. Requires Python on `$PATH`; gracefully degrades if not found.

The index powers two key workflows:

- **Agent task localization** — Before executing a task, the `CodebaseProvider` queries the index for symbols in target files and writes `[CODEBASE SYMBOLS]` context to `.multiagent/diagnostics.md`. This helps the LLM understand the codebase structure without reading every file.
- **API documentation** — Generate comprehensive API docs from JSDoc annotations with a single command.

The index is stored at `.multiagent/codebase-index.json` and supports incremental updates. When `auto_index` is enabled (default), modified files are **automatically re-indexed** after each successful agent commit — keeping the index fresh without manual intervention.

### Symbol Extraction Depth

| Extracted | Example |
|-----------|---------|
| Symbol name, kind, location | `AuthService` (class), `src/auth.ts:42` |
| JSDoc description & tags | `@deprecated Use AuthServiceV2 instead` |
| Parameter names & types | `(username: string, password: string)` |
| Return type | `Promise<User>` |
| Import map | `import { User } from "./models"` |
| Call graph (outgoing) | `AuthService.login` calls `validatePassword`, `createSession` |

## Performance Optimizations

LAOL includes several optimizations to avoid redundant computation across agents:

| Optimization | What it does |
|-------------|-------------|
| **Pull-based ChangeJournal** | Agents query changes for their target files on demand instead of receiving broadcasts for every file modification. Eliminates irrelevant "file changed" noise for agents working on unrelated files. |
| **Hint priority routing** | Critical diagnostics (tsc, eslint, test) go inline to the prompt. Git and codebase context is written to `.multiagent/diagnostics.md` for on-demand reading, saving ~350 tokens per task. |
| **Cross-provider deduplication** | Overlapping diagnostics from different providers (e.g., same error reported by both tsc and eslint) are detected and filtered by content overlap analysis (>60% threshold). |
| **TSC result cache** | Full-project `tsc --noEmit` results are cached by git tree hash. Two agents working from the same base commit share one tsc run instead of each running it independently. Cache stored at `.multiagent/cache/tsc/`. |
| **Incremental test re-run** | Post-task, only previously failing test files are re-run — not the full test suite. If all tests passed before, no re-run is needed. |
| **Per-provider post-task control** | Each context provider supports `post_task_enabled: false` to skip expensive post-task re-runs. Default: test provider skips post-task (the most expensive re-run). |
| **Targeted knowledge push** | Knowledge updates are sent only to busy agents (those with an active task), not broadcast to all connected agents. |
| **TaskWatcher deduplication** | Tracks already-emitted task IDs to avoid redundant conflict checks from chokidar re-fires or poll timer overlap. |
| **KnowledgeStore in-place cache** | Cache entries are updated in-place on save instead of being invalidated, avoiding full directory re-reads. |

## How It Prevents Conflicts

| Mechanism | What it does |
|-----------|-------------|
| **Two-Phase Commit Lock** | All target files locked atomically via `staging/` → `locks/` rename. If any file is taken, the entire batch rolls back — no partial lock sets. |
| **Dynamic Lock Expansion** | Agents request locks on-demand during execution via TCP. Discovered a new dependency mid-task? Request a lock — granted or denied in real time. |
| **Conflict Pre-Check** | Before assigning a task, the scheduler checks whether any target file is already locked. Blocked tasks stay `pending`. |
| **Auto-Discovery** | No `--files`? No problem. Agents explore the codebase, identify target files, request locks, then proceed — all automatically. |
| **Graded TTL Leases** | New locks: 60s TTL. After 2 successful renewals: 180s TTL. If an agent crashes, locks auto-expire within 90s (not 300s). |
| **Context Provider Pipeline** | Before each task, 7 live providers (tsc, eslint, vitest, git, etc.) run diagnostics. Critical results go inline to the prompt; full results go to `.multiagent/diagnostics.md`. After the task, providers compute deltas so the next agent knows what changed. |
| **Agent Circuit Breaker** | 2 consecutive failures → degraded (simple tasks only). 5 → quarantined (no tasks). Prevents broken agents from burning API costs. |
| **Task Dependency Chains** | When Task B depends on Task A, B's worktree starts from A's branch — inheriting all code changes. Agents receive `[PREDECESSOR]` context hints describing what A did. Chain of any length: A → B → C works naturally. |

## Key Design Decisions

- **File system is the database** — `rename(2)` provides atomicity on NTFS (Windows) and ext4/xfs (Linux). No SQLite, no Redis.
- **TCP localhost instead of Unix sockets** — cross-platform (Windows, Linux, macOS) with zero platform branches.
- **Optimistic concurrency for tasks** (version numbers), **pessimistic locking for files** (exclusive leases).
- **Pull-based change tracking** — agents query the ChangeJournal for changes relevant to their target files. File change notifications are not pushed; knowledge updates are pushed only to busy agents.
- **Claude Code in interactive terminals** — agents open full interactive Claude Code sessions in new terminal windows. All CLI features (MCP, hooks, skills, slash commands, plan mode) are preserved. LAOL manages task coordination, lock leases, and worktree lifecycle; Claude does the coding with full user control.
- **Live toolchain queries, not static parsing** — context providers run real compilers, linters, and test runners instead of relying solely on AST indexing.
- **Shared agent memory** — Knowledge entries from completed tasks are stored on disk and queried by other agents before starting work, preventing duplicate exploration and providing predecessor context for dependency chains.

## Installation

```bash
git clone https://github.com/qingyvsan/LAOL.git
cd LAOL
npm install
npm run build
npm link        # registers "laol" globally on your PATH
```

After `npm link`, the `laol` command is available from any directory.

To unlink later: `npm unlink -g laol`

**Prerequisites:**
- [Node.js](https://nodejs.org/) >= 18
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) must be installed and available on your `PATH`

## Quick Start

### 1. Initialize a project

```bash
cd /path/to/your-codebase
laol init
```

This creates `.multiagent/` with all required directories and default config.

### 2. Start the scheduler

```bash
laol scheduler start
# LAOL Scheduler
#   Repo:  /path/to/your-codebase
#   Port:  9123
#   Pool:  4 worktrees
# Scheduler is running. Press Ctrl+C to stop.
```

### 3. Start one or more agents

```bash
# Terminal 2 — interactive mode (default): opens a new terminal
# window with full Claude Code CLI experience
laol agent start --id agent-001

# Terminal 3 (optional — parallel agent)
laol agent start --id agent-002

# Or use piped mode for headless/automated execution:
laol agent start --id agent-003 --mode piped
```

### 4. Create a task

```bash
# With pre-declared files:
laol task add --description "Refactor the auth module to use async/await" \
              --files "src/auth.ts" "src/auth.test.ts"

# Or let the agent discover files automatically:
laol task add --description "Fix all TypeScript errors in the project"

# Task created: 3f7a9b2c-...
#   Status: pending
#   Files: src/auth.ts, src/auth.test.ts  (or "auto-discover")

# Create a follow-up task that continues from the previous one:
laol task add --description "Add error handling to the login function" \
              --files "src/auth.ts" \
              --dependency 3f7a9b2c
```

### 5. Watch it work

```bash
laol status
# ┌──────────┬────────┐
# │ Pending  │ 0      │
# │ In Prog  │ 1      │
# │ Done     │ 0      │
# │ Failed   │ 0      │
# │ Locks    │ 2      │
# └──────────┴────────┘
```

The agent receives the task, acquires locks, spawns Claude Code in an isolated worktree, commits changes, and pushes the branch.

## CLI Reference

### `laol init`

Initialize `.multiagent/` in the current repository.

### `laol task`

| Command | Description |
|---------|-------------|
| `laol task add --description "..." [--files <paths...>] [--dependency <task-id>] [--read-only]` | Create a task (files optional — agents auto-discover; `--dependency` chains tasks for code inheritance) |
| `laol task list [--status pending\|done\|failed] [--agent <id>]` | List tasks |
| `laol task show <task-id>` | Show task details |
| `laol task cancel <task-id>` | Cancel a pending task |

### `laol scheduler`

| Command | Description |
|---------|-------------|
| `laol scheduler start [--port 9123] [--pool-size 4]` | Start the scheduler |

### `laol agent`

| Command | Description |
|---------|-------------|
| `laol agent start --id <agent-id> [--port 9123] [--host 127.0.0.1] [--mode interactive\|piped]` | Start an agent (default: interactive) |

### `laol locks`

| Command | Description |
|---------|-------------|
| `laol locks list` | List active file locks |
| `laol locks force-release <file>` | Force-release a lock |

### `laol config`

| Command | Description |
|---------|-------------|
| `laol config show` | Display current configuration |
| `laol config set <key> <value>` | Set a config value (e.g. `scheduler.port 9124`) |

### `laol indexer`

| Command | Description |
|---------|-------------|
| `laol indexer build [--full]` | Build or incrementally update the codebase index |
| `laol indexer query <keyword>` | Search indexed symbols with relevance scoring |
| `laol indexer show <file>` | Show all indexed symbols in a file |
| `laol indexer stats` | Show index statistics (files, symbols, kinds) |
| `laol indexer docs [--output <path>] [--files <glob>]` | Generate API documentation in markdown |

### `laol status`

Show system overview: task counts, lock count, pool usage.

### `laol shutdown`

| Command | Description |
|---------|-------------|
| `laol shutdown [--port 9123] [--host 127.0.0.1]` | Gracefully stop the scheduler, all agents, and clean up worktrees |

## Configuration

`.multiagent/config.json` (created by `laol init`):

```jsonc
{
  "scheduler": {
    "port": 9123,           // TCP port for agent connections
    "pool_size": 4          // Pre-warmed worktree count
  },
  "merge_checks": [          // Pre-merge CI validation
    { "name": "type-check", "cmd": "npx tsc --noEmit", "timeout": 60 },
    { "name": "lint",       "cmd": "npx eslint src/ --max-warnings 0", "timeout": 30 }
  ],
  "merge_driver": "ai-merge",
  "merge_driver_config": {
    "same_function_strategy": "always_llm",  // Same-function conflicts → LLM merge
    "cache_size": 100,
    "cache_ttl": 300,
    "quorum_enabled": false                   // Enable dual-model quorum merge
  },
  "llm": {
    "provider": "claude",
    "api_key_env": "ANTHROPIC_API_KEY",
    "model": "claude-sonnet-4-6",
    "secondary_model": "claude-haiku-4-5"     // Optional, for quorum mode
  },
  "agent": {
    "heartbeat_interval_ms": 25000,
    "checkpoint_min_interval_ms": 30000,
    "worktree_pool_size": 1,   // Worktrees per agent (default 1)
    "mode": "interactive",     // "piped" for headless, "interactive" for full CLI experience
    "interactive": {
      "terminal_timeout_seconds": 7200,  // Max session duration (2 hours)
      "poll_interval_ms": 2000,          // Sentinel file poll interval
      "session_dir": "sessions",         // Sentinel file directory
      "terminal_cmd": null               // Custom terminal command (optional)
    }
  },
  "locks": {
    "initial_ttl_ms": 60000,   // New lock TTL (60s)
    "stable_ttl_ms": 180000,   // Stable lock TTL (180s)
    "stable_threshold": 2,     // Renewals before stable
    "probe_timeout_ms": 45000  // Max idle before ping probe
  },
  "claude_executor": {
    "binary_path": "claude",
    "timeout_seconds": 300,    // Max execution time per task
    "max_budget_usd": 5,       // API cost limit per task
    "allowed_tools": ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    "effort": "high",          // low | medium | high | max
    "skip_permissions": true   // Skip interactive permission prompts
  },
  "codebase_indexer": {
    "include": ["src/**/*.ts", "src/**/*.tsx", "src/**/*.py"],
    "exclude": ["**/node_modules/**", "**/dist/**", "**/__tests__/**"],
    "auto_index": true,         // Auto-reindex modified files after agent tasks
    "index_interval_ms": 60000
  },
  "context_providers": {
    "typescript": { "enabled": true, "timeout_seconds": 60 },
    "eslint":     { "enabled": true, "timeout_seconds": 30 },
    "test":       { "enabled": true, "timeout_seconds": 120, "post_task_enabled": false },
    "git":        { "enabled": true, "timeout_seconds": 10 },
    "python":     { "enabled": true, "timeout_seconds": 60 },
    "codebase":   { "enabled": true, "timeout_seconds": 10 },
    "custom":     { "enabled": false, "timeout_seconds": 60 }
  }
}
```

Key config notes:
- `agent.worktree_pool_size` controls worktrees per agent (default 1). Separate from `scheduler.pool_size`.
- `context_providers.<name>.post_task_enabled` controls whether a provider re-runs after the task to compute deltas. Set to `false` for expensive providers (test is disabled by default).
- TSC results are automatically cached at `.multiagent/cache/tsc/` keyed by git tree hash.

## Coordination Files (Agent Workspace)

During task execution, agents have access to these files in their worktree's `.multiagent/` directory:

| File | Purpose |
|------|---------|
| `.multiagent/diagnostics.md` | Pre-flight diagnostics from all context providers (tsc, eslint, test, git, codebase). Written before task start. |
| `.multiagent/journal/latest-changes.md` | Recent file changes, index updates, and merges relevant to the agent's target files (queried from ChangeJournal). |
| `.multiagent/notifications.md` | Knowledge shared by other agents — learnings, summaries, and insights from completed tasks. |

## Task Lifecycle (End to End)

```
User drops task JSON → tasks/
    │
    ▼
chokidar fires "task_created" event
    │
    ▼
Scheduler.runAssignmentLoop()
    ├── ConflictChecker.canAssign(task)
    │   ├── Are any target files locked? → Block
    │   ├── Is the dependency task done? → If not, skip
    │   └── Check registry for semantic warnings → Inject hints
    │
    ├── CircuitBreaker.canAcceptTask(agent, complexity)
    │   ├── normal    → any task
    │   ├── degraded  → simple tasks only (≤2 files)
    │   └── quarantined → no tasks
    │
    ├── LockManager.acquire(task_id, agent_id, files)
    │   ├── Write staging/{task_id}.intent
    │   ├── For each file: write Lock data, renameSync → locks/{file}.lock
    │   └── On any failure: rollback all prior locks
    │
    ├── TaskStore.updateTask(task_id, status: "in_progress")
    │
    └── SocketServer → notify agent: { event: "task_assigned", task_id }
            │
            ▼
AgentRunner.handleTaskAssigned(msg)
    │
    └── AgentWorker.executeTask(task, executor)
        ├── Heartbeat.start()              # Renews locks every 25s
        ├── WorktreePool.acquire()         # Grab pre-warmed worktree
        ├── ChangeJournalClient.query()    # Pull recent changes for target files
        │   └── Writes .multiagent/journal/latest-changes.md
        ├── ContextManager.collectPreHints()   # 7 live providers in parallel
        │   ├── TSC results from cache if tree hash matches (shared across agents)
        │   ├── Critical hints (tsc, eslint, test) → inline prompt
        │   └── Full diagnostics → .multiagent/diagnostics.md
        ├── Checkpoint.checkAndRebase()    # Fetch latest main, rebase if needed
        │
        ├── KnowledgeStore.getByTaskId()   # Query predecessor knowledge (O(1))
        │   └── Build [PREDECESSOR] hint with dependency task summary
        │
        ├── AgentRunner.createInteractiveExecutor()  # Mode: interactive (default)
        │   ├── Writes CLAUDE.md to worktree root   # Task context
        │   ├── InteractiveTerminalOpener opens new terminal window
        │   │   └── Full Claude Code CLI: MCP, hooks, skills, slash commands, plan mode
        │   ├── Polls sentinel file for exit detection
        │   └── User types /exit or Ctrl+D → terminal closes
        │
        ├── AgentRunner.createPipedExecutor()       # Mode: piped (headless)
        │   └── spawn("claude", [...])  # Prompt piped via stdin, automated execution
        │       ├── Claude reads target files
        │       ├── Claude makes edits
        │       └── Claude exits 0 → success
        │
        ├── ContextManager.collectPostHints()  # Re-run enabled providers, compute deltas
        │   └── Respects post_task_enabled flag per provider
        ├── KnowledgeStore.saveDelta()     # Save provider delta
        ├── git add -A && git commit
        ├── CodebaseIndexer.reindexFiles()     # Keep symbol index fresh (auto_index: true)
        ├── git push origin agent/{task_id}
        ├── LockManager.releaseAll()
        ├── TaskStore.updateTask(task_id, status: "done")
        ├── SocketClient.notifyTaskDone(task_id)
        └── WorktreePool.release()         # Return worktree to pool
```

## Development

```bash
npm install
npm run build       # TypeScript → dist/
npm test            # Vitest (287 tests, 21 files)
npm run dev         # Watch mode
```

### Project Structure

```
src/
├── data/            # TypeScript types + Zod schemas
├── task/            # Task JSON CRUD + chokidar watcher
├── lock/            # Two-phase commit locks + TTL leases + symbol resolver
├── scheduler/       # Event-driven scheduler + conflict checker + circuit breaker + health monitor
├── agent/           # Agent worker + heartbeat + checkpoint + interactive/piped executors
├── context/         # Context provider pipeline (7 providers: tsc, eslint, test, git, python, codebase, custom)
│   ├── providers/   # Individual provider implementations
│   └── tsc-cache.ts # Shared TSC result cache (tree-hash keyed)
├── journal/         # ChangeJournal + agent query client (pull-based change tracking)
├── knowledge/       # Shared agent memory — KnowledgeStore (one JSON file per task)
├── worktree/        # Git worktree pool
├── merge/           # 3-level merge: L1 auto / L2 AST / L3 LLM + sandbox validator
├── events/          # EventBus (internal) + TCP socket server/client (cross-platform IPC)
├── wal/             # Write-ahead log for crash recovery
├── registry/        # Semantic change registry (module export tracking)
├── codebase/        # Symbol-level indexer (TS/Python AST extraction, keyword search, API docs)
├── cli/             # Commander-based CLI
└── __tests__/       # 21 test files, 287 tests
```

## License

MIT
