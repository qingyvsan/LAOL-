# LAOL — 多智能体协作编程系统

> **零数据库。零消息队列。** 文件系统级原子锁。Git Worktree 隔离。AI 语义合并。智能体运行时自动发现目标文件。

LAOL 让多个 Claude Code AI 智能体**并行**安全地修改同一代码库。智能体可动态发现需要编辑的文件——无需预先声明。调度器按需分配锁，智能体可在任务中途扩展修改范围而不会产生冲突。

## 架构

```
                           ┌──────────────────────────┐
                           │   .multiagent/            │
                           │   ├── tasks/              │  ← 用户投放任务 JSON
                           │   ├── locks/              │  ← 原子文件锁
                           │   ├── staging/            │  ← 两阶段提交
                           │   ├── wal/                │  ← 崩溃恢复日志
                           │   ├── knowledge/          │  ← 共享智能体记忆
                           │   ├── cache/tsc/          │  ← TSC 结果缓存
                           │   ├── reports/            │  ← 只读任务报告
                           │   ├── sessions/           │  ← 交互会话状态
                           │   └── config.json         │
                           └──────┬───────────────────┘
                                  │
                    ┌─────────────┴─────────────┐
                    │     调度器 (TCP:9123)       │
                    │  ┌───────────────────────┐ │
                    │  │ 冲突检测器             │ │
                    │  │ 熔断器                 │ │
                    │  │ 健康监控               │ │
                    │  │ 事件总线               │ │
                    │  └───────────────────────┘ │
                    └──────┬─────────┬───────────┘
                           │         │
              ┌────────────┘         └────────────┐
              ▼                                   ▼
    ┌──────────────────┐               ┌──────────────────┐
    │  智能体 A         │               │  智能体 B         │
    │  ┌──────────────┐ │               │  ┌──────────────┐ │
    │  │ Worktree A   │ │               │  │ Worktree B   │ │
    │  │ (隔离环境)    │ │               │  │ (隔离环境)    │ │
    │  │ Claude Code  │ │               │  │ Claude Code  │ │
    │  └──────────────┘ │               │  └──────────────┘ │
    │  ┌──────────────┐ │               │  ┌──────────────┐ │
    │  │ 知识存储      │ │               │  │ 知识存储      │ │
    │  └──────────────┘ │               │  └──────────────┘ │
    └──────────────────┘               └──────────────────┘
              │                                   │
              │     ┌──────────────────────┐      │
              └─────│   共享 TSC 缓存       │──────┘
                    │   (tree-hash 索引)   │
                    └──────────────────────┘
              │                                   │
              └──────────┬────────────────────────┘
                         ▼
              ┌──────────────────────┐
              │     语义合并          │
              │  L1: 自动（无冲突）    │
              │  L2: AST（不同函数）   │
              │  L3: LLM（同一函数）   │
              │  └── 沙箱 CI 检查     │
              └──────────────────────┘
                         │
                         ▼
                      main 分支
```

## Context Provider 上下文注入系统

LAOL 内置了**实时上下文注入流水线**，在每个智能体任务执行前后运行真实的工具链，将结构化诊断信息直接注入智能体 prompt。这避免了智能体自己执行 `tsc`、`eslint` 或 `git blame` 浪费 token——诊断结果已被预计算。

**7 个内置 Provider** 并行运行，各自错误隔离：

| Provider | 功能 |
|----------|------|
| **TypeScriptProvider** | 运行 `tsc --noEmit`，过滤错误至目标文件（上限 15 条）。结果按 git tree hash 缓存——同一次提交上的多个智能体共享一次 tsc 运行。 |
| **ESLintProvider** | 对目标 TS 文件运行 `eslint --format compact`（上限 10 条） |
| **TestProvider** | 通过 vitest/jest/pytest 运行相关测试，注入通过/失败基线。任务后仅重跑之前失败的测试，而非完整套件。 |
| **GitProvider** | Git blame、最近提交记录、重叠模块中的活跃智能体信息 |
| **PythonProvider** | 运行 `ruff check` + `mypy`，工具不可用时优雅降级 |
| **CodebaseProvider** | 查询符号索引，获取目标文件结构（函数、类、导出） |
| **CustomProvider** | 从配置执行用户自定义的前置/后置命令 |

任务执行后，实现了 `deactivate()` 的 Provider 会重新运行以计算**前后差异**（已修复错误数、新增错误数），存入 KnowledgeStore 供其他智能体使用。

**Token 效果：** 预计算诊断减少智能体发起的工具调用约 **55-65%**——每任务从约 2,500-8,700 token 降至约 1,000-3,100 token。

## 知识共享

LAOL 在 `.multiagent/knowledge/` 维护了**共享智能体记忆**。当智能体完成探索或修改任务时，它们记录所学内容——探索了哪些文件、发现了什么、以及可读的摘要。

每个智能体在开始工作前查询知识存储：

- **前序任务上下文** — 依赖任务做了什么？改了哪些文件？
- **相关发现** — 其他智能体是否已探索过相同模块的文件？
- **Provider 差异** — 前序智能体修复或引入了哪些 lint/类型错误？

这避免了智能体重复探索相同代码或重复已知错误。存储直接使用文件系统——每个任务一个 JSON 文件——支持 O(1) 按任务 ID 查找。

## 代码库索引器

LAOL 内置了**符号级代码库索引器**，可提取并索引项目中的每个函数、类、接口、类型别名和变量——连同它们的 JSDoc/docstring 文档、参数签名、返回值类型、导入关系和调用图。

**支持的语言：** TypeScript/JavaScript（`.ts`、`.tsx`、`.js`、`.jsx`、`.mts`、`.cts`、`.mjs`、`.cjs`）和 Python（`.py`）。

- **TypeScript/JavaScript** — 通过 TypeScript 编译器 API 解析。提取 JSDoc 注解（`@param`、`@returns`、自定义标签）。
- **Python** — 通过 Python 内置 `ast` 模块，以子进程方式解析。提取 Sphinx 风格（`:param`、`:returns`、`:raises`、`:rtype`）和 Google 风格（`Args:`、`Returns:`）docstring。类型提示被转换为参数/返回值类型。需要 Python 在 `$PATH` 中；若未安装则优雅降级。

索引支持两个关键工作流：

- **智能体任务定位** — 执行任务前，`CodebaseProvider` 查询索引获取目标文件中的符号，并注入 `[CODEBASE SYMBOLS]` 上下文提示。这帮助 LLM 无需遍历全部文件即可理解代码库结构。
- **API 文档生成** — 一条命令即可从 JSDoc 注解生成完整的 API 文档。

索引存储在 `.multiagent/codebase-index.json`，支持增量更新。当 `auto_index` 启用时（默认），每个智能体成功提交后**自动重新索引**修改过的文件——无需人工干预即可保持索引新鲜。

### 符号提取深度

| 提取内容 | 示例 |
|---------|------|
| 符号名、类型、位置 | `AuthService`（class），`src/auth.ts:42` |
| JSDoc 描述与标签 | `@deprecated 请使用 AuthServiceV2 代替` |
| 参数名与类型 | `(username: string, password: string)` |
| 返回值类型 | `Promise<User>` |
| 导入映射 | `import { User } from "./models"` |
| 调用图（出向） | `AuthService.login` 调用 `validatePassword`、`createSession` |

## 性能优化

LAOL 包含多项优化以避免智能体间的冗余计算：

| 优化项 | 说明 |
|--------|------|
| **TSC 结果缓存** | 全项目 `tsc --noEmit` 结果按 git tree hash 缓存。基于同一提交的两个智能体共享一次 tsc 运行，而非各自独立执行。缓存存储在 `.multiagent/cache/tsc/`。 |
| **增量测试重跑** | 任务完成后仅重跑之前失败的测试文件，而非完整测试套件。若之前全部通过，则无需重跑。 |
| **Provider 级后置开关** | 每个 Context Provider 支持 `post_task_enabled: false` 以跳过昂贵的后置重跑。默认：test provider 跳过后置（最昂贵的重跑项）。 |
| **每智能体独立 Worktree 池** | 每个智能体默认 1 个 worktree（`agent.worktree_pool_size: 1`），而非共享调度器池大小，减少初始化开销。 |

## 如何防止冲突

| 机制 | 说明 |
|------|------|
| **两阶段提交锁** | 通过 `staging/` → `locks/` 的重命名操作，原子性地锁定所有目标文件。如有任一文件被占用，整个批次回滚——不会出现部分锁定的情况。 |
| **动态锁扩展** | 智能体执行期间可通过 TCP 实时请求额外文件锁。中途发现新依赖？请求锁——实时批准或拒绝。 |
| **冲突预检** | 分配任务前，调度器检查是否已有目标文件被锁定。被阻塞的任务保持 `pending` 状态。 |
| **自动发现** | 不指定 `--files`？没问题。智能体先探索代码库，确定目标文件，请求锁，再执行修改——全自动完成。 |
| **分级 TTL 租约** | 新锁：60 秒 TTL。成功续约 2 次后：180 秒 TTL。若智能体崩溃，锁最多 90 秒内自动过期（非 300 秒）。 |
| **上下文注入流水线** | 每个任务执行前，7 个实时 Provider（tsc、eslint、vitest、git 等）将诊断信息注入智能体 prompt。任务完成后，Provider 计算变更差异，使下一个智能体了解发生了什么变化。 |
| **智能体熔断器** | 2 次连续失败 → 降级（仅接受简单任务）。5 次 → 隔离（不再接受任务）。防止故障智能体持续消耗 API 费用。 |
| **任务依赖链** | 当任务 B 依赖任务 A 时，B 的 Worktree 从 A 的分支创建——继承全部代码变更。智能体收到 `[PREDECESSOR]` 上下文提示，了解 A 做了什么。任意长度的链 A → B → C 自然工作。 |

## 核心设计决策

- **文件系统即数据库** — `rename(2)` 在 NTFS（Windows）和 ext4/xfs（Linux）上均提供原子性。无需 SQLite、无需 Redis。
- **TCP localhost 代替 Unix socket** — 跨平台（Windows、Linux、macOS），零平台分支代码。
- **任务采用乐观并发**（版本号），**文件采用悲观锁**（独占租约）。
- **Claude Code 交互式终端运行** — 智能体在新终端窗口中打开完整的交互式 Claude Code 会话。所有 CLI 功能（MCP、hooks、skills、slash 指令、plan 模式）完整保留。LAOL 管理任务协调、锁租约和 Worktree 生命周期；Claude 在用户完全控制下完成编码工作。
- **实时工具链查询，而非静态解析** — Context Provider 运行真实的编译器、linter 和测试运行器，而非仅依赖 AST 索引。受 fennara-godot-ai 实时编辑器查询架构启发。
- **共享智能体记忆** — 已完成任务的知识条目持久化在磁盘上，其他智能体开始工作前查询，避免重复探索，并为依赖链提供前序上下文。

## 安装

```bash
git clone https://github.com/qingyvsan/LAOL.git
cd LAOL
npm install
npm run build
npm link        # 将 laol 注册到系统 PATH，全局可用
```

执行 `npm link` 后，`laol` 命令可在任意目录下使用。

如需取消注册：`npm unlink -g laol`

**前置条件：**
- [Node.js](https://nodejs.org/) >= 18
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) 必须安装并在 `PATH` 中可用

## 快速开始

### 1. 初始化项目

```bash
cd /path/to/your-codebase
laol init
```

此命令创建 `.multiagent/` 目录，包含所有必需的子目录和默认配置。

### 2. 启动调度器

```bash
laol scheduler start
# LAOL 调度器
#   仓库:  /path/to/your-codebase
#   端口:  9123
#   池大小: 4 个 worktree
# 调度器运行中。按 Ctrl+C 停止。
```

### 3. 启动一个或多个智能体

```bash
# 终端 2 — 交互模式（默认）：打开新终端窗口，
# 提供完整的 Claude Code CLI 体验
laol agent start --id agent-001

# 终端 3（可选——并行智能体）
laol agent start --id agent-002

# 或使用 piped 模式进行无界面/自动化执行：
laol agent start --id agent-003 --mode piped
```

### 4. 创建任务

```bash
# 预先指定文件：
laol task add --description "将 auth 模块重构为 async/await" \
              --files "src/auth.ts" "src/auth.test.ts"

# 或让智能体自动发现文件：
laol task add --description "修复项目中所有 TypeScript 错误"

# 任务已创建: 3f7a9b2c-...
#   状态: pending
#   文件: src/auth.ts, src/auth.test.ts  (或 "自动发现")

# 创建一个延续前序任务的后续任务：
laol task add --description "给 login 函数增加错误处理" \
              --files "src/auth.ts" \
              --dependency 3f7a9b2c
```

### 5. 观察运行

```bash
laol status
# ┌──────────┬────────┐
# │ 待处理    │ 0      │
# │ 进行中    │ 1      │
# │ 已完成    │ 0      │
# │ 失败      │ 0      │
# │ 锁        │ 2      │
# └──────────┴────────┘
```

智能体接收任务、获取锁、在隔离的 Worktree 中启动 Claude Code、提交变更并推送分支。

## CLI 参考

### `laol init`

在当前仓库中初始化 `.multiagent/`。

### `laol task`

| 命令 | 说明 |
|------|------|
| `laol task add --description "..." [--files <路径...>] [--dependency <任务ID>] [--read-only]` | 创建任务（文件可选——智能体自动发现；`--dependency` 串联任务实现代码继承） |
| `laol task list [--status pending\|done\|failed] [--agent <id>]` | 列出任务 |
| `laol task show <任务ID>` | 查看任务详情 |
| `laol task cancel <任务ID>` | 取消待处理任务 |

### `laol scheduler`

| 命令 | 说明 |
|------|------|
| `laol scheduler start [--port 9123] [--pool-size 4]` | 启动调度器 |

### `laol agent`

| 命令 | 说明 |
|------|------|
| `laol agent start --id <智能体ID> [--port 9123] [--host 127.0.0.1] [--mode interactive\|piped]` | 启动智能体（默认：interactive） |

### `laol locks`

| 命令 | 说明 |
|------|------|
| `laol locks list` | 列出当前文件锁 |
| `laol locks force-release <文件>` | 强制释放某个文件锁 |

### `laol config`

| 命令 | 说明 |
|------|------|
| `laol config show` | 显示当前配置 |
| `laol config set <键> <值>` | 设置配置项（如 `scheduler.port 9124`） |

### `laol indexer`

| 命令 | 说明 |
|------|------|
| `laol indexer build [--full]` | 构建或增量更新代码库索引 |
| `laol indexer query <关键词>` | 搜索索引符号，按相关性排序 |
| `laol indexer show <文件>` | 查看文件中所有已索引的符号 |
| `laol indexer stats` | 显示索引统计信息（文件数、符号数、种类分布） |
| `laol indexer docs [--output <路径>] [--files <glob>]` | 生成 Markdown 格式的 API 文档 |

### `laol status`

显示系统概览：任务数量、锁数量、池使用情况。

### `laol shutdown`

| 命令 | 说明 |
|------|------|
| `laol shutdown [--port 9123] [--host 127.0.0.1]` | 优雅关闭调度器、所有智能体，并清理 Worktree |

## 配置

`.multiagent/config.json`（由 `laol init` 创建）：

```jsonc
{
  "scheduler": {
    "port": 9123,           // 调度器 TCP 端口
    "pool_size": 4          // 预热的 Worktree 数量（共享池）
  },
  "merge_checks": [          // 合并前 CI 验证
    { "name": "type-check", "cmd": "npx tsc --noEmit", "timeout": 60 },
    { "name": "lint",       "cmd": "npx eslint src/ --max-warnings 0", "timeout": 30 }
  ],
  "merge_driver": "ai-merge",
  "merge_driver_config": {
    "same_function_strategy": "always_llm",  // 同函数冲突 → LLM 合并
    "cache_size": 100,
    "cache_ttl": 300,
    "quorum_enabled": false                   // 启用双模 Quorum 合并
  },
  "llm": {
    "provider": "claude",
    "api_key_env": "ANTHROPIC_API_KEY",
    "model": "claude-sonnet-4-6",
    "secondary_model": "claude-haiku-4-5"     // 可选，用于 Quorum 模式
  },
  "agent": {
    "heartbeat_interval_ms": 25000,
    "checkpoint_min_interval_ms": 30000,
    "worktree_pool_size": 1,   // 每智能体的 worktree 数量（默认 1；每个智能体仅需一个）
    "mode": "interactive",     // "piped" 用于无界面执行，"interactive" 用于完整 CLI 体验
    "interactive": {
      "terminal_timeout_seconds": 7200,  // 最大会话时长（2 小时）
      "poll_interval_ms": 2000,          // Sentinel 文件轮询间隔
      "session_dir": "sessions",         // Sentinel 文件目录
      "terminal_cmd": null               // 自定义终端命令（可选）
    }
  },
  "locks": {
    "initial_ttl_ms": 60000,   // 新锁 TTL（60 秒）
    "stable_ttl_ms": 180000,   // 稳定锁 TTL（180 秒）
    "stable_threshold": 2,     // 达到稳定态所需的续约次数
    "probe_timeout_ms": 45000  // 最大空闲时间，超时发送 ping 探活
  },
  "claude_executor": {
    "binary_path": "claude",
    "timeout_seconds": 300,    // 单任务最大执行时间
    "max_budget_usd": 5,       // 单任务 API 费用上限
    "allowed_tools": ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    "effort": "high",          // low | medium | high | max
    "skip_permissions": true   // 跳过交互式权限确认
  },
  "codebase_indexer": {
    "include": ["src/**/*.ts", "src/**/*.tsx", "src/**/*.py"],
    "exclude": ["**/node_modules/**", "**/dist/**", "**/__tests__/**"],
    "auto_index": true,         // 智能体提交后自动重新索引
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

关键配置说明：
- `agent.worktree_pool_size` 控制每个智能体的 worktree 数量（默认 1）。与 `scheduler.pool_size` 独立。
- `context_providers.<name>.post_task_enabled` 控制某个 Provider 是否在任务后重新运行以计算差异。对耗时 Provider 可设为 `false`（test 默认禁用）。
- TSC 结果自动缓存在 `.multiagent/cache/tsc/`，按 git tree hash 索引。

## 任务生命周期（端到端）

```
用户投放任务 JSON → tasks/
    │
    ▼
chokidar 触发 "task_created" 事件
    │
    ▼
调度器.runAssignmentLoop()
    ├── 冲突检测器.canAssign(任务)
    │   ├── 是否有目标文件被锁定？ → 阻塞
    │   ├── 依赖任务是否已完成？ → 未完成则跳过
    │   └── 检查注册表中的语义警告 → 注入提示
    │
    ├── 熔断器.canAcceptTask(智能体, 复杂度)
    │   ├── normal    → 任意任务
    │   ├── degraded  → 仅简单任务（≤2 个文件）
    │   └── quarantined → 不分配任务
    │
    ├── 锁管理器.acquire(任务ID, 智能体ID, 文件列表)
    │   ├── 写入 staging/{任务ID}.intent
    │   ├── 对每个文件：写入锁数据，renameSync → locks/{文件}.lock
    │   └── 任何失败：回滚所有已创建的锁
    │
    ├── 任务存储.updateTask(任务ID, status: "in_progress")
    │
    └── SocketServer → 通知智能体: { event: "task_assigned", task_id }
            │
            ▼
AgentRunner.handleTaskAssigned(消息)
    │
    └── AgentWorker.executeTask(任务, 执行器)
        ├── Heartbeat.start()              # 每 25 秒续约锁
        ├── WorktreePool.acquire()         # 获取预热的 Worktree
        ├── Checkpoint.checkAndRebase()    # 拉取最新 main，必要时 rebase
        │
        ├── ContextManager.collectPreHints()   # 7 个实时 Provider：tsc、eslint、tests、git 等
        │   ├── 若 tree hash 匹配，从缓存读取 TSC 结果（跨智能体共享）
        │   └── 注入 [TYPESCRIPT]、[ESLINT]、[TEST BASELINE]、[GIT]、[SYMBOLS] 等提示
        │
        ├── KnowledgeStore.getByTaskId()   # 查询前序任务知识（O(1) 直接读取）
        │   └── 构建 [PREDECESSOR] 提示，包含依赖任务摘要
        │
        ├── AgentRunner.createInteractiveExecutor()  # 模式：interactive（默认）
        │   ├── 写入 CLAUDE.md 到 worktree 根目录   # 注入任务上下文
        │   ├── InteractiveTerminalOpener 打开新终端窗口
        │   │   └── 完整 Claude Code CLI：MCP、hooks、skills、slash 指令、plan 模式
        │   ├── 轮询 sentinel 文件检测退出
        │   └── 用户输入 /exit 或 Ctrl+D → 终端关闭
        │
        ├── AgentRunner.createPipedExecutor()       # 模式：piped（无界面）
        │   └── spawn("claude", [...])  # 通过 stdin 管道传入 prompt，自动化执行
        │       ├── Claude 读取目标文件
        │       ├── Claude 进行编辑
        │       └── Claude 退出码 0 → 成功
        │
        ├── ContextManager.collectPostHints()  # 重新运行启用的 Provider，计算前后差异
        │   └── 遵循每个 Provider 的 post_task_enabled 标志
        ├── KnowledgeStore.saveDelta()     # 保存 Provider 差异（不覆盖主条目）
        ├── git add -A && git commit
        ├── CodebaseIndexer.reindexFiles()     # 保持符号索引新鲜（auto_index: true 时）
        ├── git push origin agent/{任务ID}
        ├── LockManager.releaseAll()
        ├── TaskStore.updateTask(任务ID, status: "done")
        ├── SocketClient.notifyTaskDone(任务ID)
        └── WorktreePool.release()         # 归还 Worktree 到池中
```

## 开发

```bash
npm install
npm run build       # TypeScript → dist/
npm test            # Vitest（269 个测试，20 个文件）
npm run dev         # 监视模式
```

### 项目结构

```
src/
├── data/            # TypeScript 类型 + Zod 校验
├── task/            # 任务 JSON 增删改查 + chokidar 监控
├── lock/            # 两阶段提交锁 + TTL 租约 + 符号解析器
├── scheduler/       # 事件驱动调度器 + 冲突检测器 + 熔断器 + 健康监控
├── agent/           # 智能体工作器 + 心跳 + 检查点 + 交互式/管道执行器 + Claude 执行器
├── context/         # 上下文注入流水线（7 个 Provider：tsc、eslint、test、git、python、codebase、custom）
│   ├── providers/   # 各 Provider 独立实现
│   └── tsc-cache.ts # 共享 TSC 结果缓存（tree-hash 索引）
├── knowledge/       # 共享智能体记忆 — KnowledgeStore（每任务一个 JSON 文件）
├── worktree/        # Git Worktree 池
├── merge/           # 三级合并：L1 自动 / L2 AST / L3 LLM + 沙箱验证
├── events/          # EventBus（内部）+ TCP Socket 服务端/客户端（跨平台 IPC）
├── wal/             # 预写日志，用于崩溃恢复
├── registry/        # 语义变更注册表（模块导出追踪）
├── codebase/        # 符号级索引器（TS AST 提取、关键词搜索、API 文档生成）
├── cli/             # 基于 Commander 的 CLI（8 个命令组）
└── __tests__/       # 20 个测试文件，269 个测试
```

## 开源协议

MIT
