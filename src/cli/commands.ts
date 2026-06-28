import { Command } from "commander";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import chalk from "chalk";
import { TaskStore } from "../task/task-store";
import { LockManager } from "../lock/lock-manager";
import { Scheduler } from "../scheduler/scheduler";
import { AgentRunner } from "../agent/agent-runner";
import { loadConfig, saveConfig, resolveRepoRoot, DEFAULT_CONFIG } from "../config";
import { formatTaskTable, formatLockTable, formatAgentTable, formatStatusOverview } from "./formatters";
import { CodebaseIndexer } from "../codebase/indexer";

const program = new Command();

program
  .name("laol")
  .description("Multi-agent collaborative coding system")
  .version("0.1.0");

// ---- laol init ----

program
  .command("init")
  .description("Initialize .multiagent/ directory structure in the current repository")
  .action(() => {
    const root = process.cwd();
    const multiagentDir = path.join(root, ".multiagent");

    if (fs.existsSync(multiagentDir)) {
      console.log(chalk.yellow(".multiagent/ already exists."));
      return;
    }

    const dirs = [
      ".multiagent",
      ".multiagent/tasks",
      ".multiagent/locks",
      ".multiagent/staging",
      ".multiagent/wal",
      ".multiagent/warnings",
      ".multiagent/worktrees",
      ".multiagent/reports",
    ];

    for (const dir of dirs) {
      const fullPath = path.join(root, dir);
      fs.mkdirSync(fullPath, { recursive: true });
      console.log(chalk.green(`  created: ${dir}/`));
    }

    const configPath = path.join(multiagentDir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf-8");
    console.log(chalk.green("  created: .multiagent/config.json"));

    const gitignorePath = path.join(multiagentDir, ".gitignore");
    fs.writeFileSync(gitignorePath, "worktrees/\nwal/\nstaging/\ntasks/\nlocks/\n", "utf-8");
    console.log(chalk.green("  created: .multiagent/.gitignore"));

    console.log(chalk.bold("\nLAOL initialized successfully."));
    console.log(chalk.dim("\nNext steps:"));
    console.log(chalk.dim("  laol scheduler start     # Start the task scheduler"));
    console.log(chalk.dim("  laol agent start --id agent-001  # Start an agent"));
    console.log(chalk.dim("  laol task add --description \"...\" --files \"src/a.ts\""));
  });

// ---- laol task ----

const taskCmd = program
  .command("task")
  .description("Manage tasks in the task queue");

taskCmd
  .command("add")
  .description("Create a new task")
  .requiredOption("--description <text>", "Task description")
  .option("--files <paths...>", "Target file paths (optional — agent will discover if not specified)")
  .option("--dependency <task-id>", "Task ID this task depends on")
  .option("--read-only", "Mark task as read-only (analysis/report, no file modifications)")
  .action((options) => {
    const root = resolveRepoRoot();
    const store = new TaskStore(root);

    const targetFiles: string[] = options.files ?? [];

    // Validate early before creating task
    try {
      TaskStore.validateTargetFiles(targetFiles);
    } catch (err) {
      console.log(chalk.red((err as Error).message));
      process.exit(1);
    }

    const task = store.createTask({
      description: options.description,
      target_files: targetFiles,
      dependency: options.dependency ?? null,
      metadata: options.readOnly ? { read_only: true } : undefined,
    });

    console.log(chalk.green(`Task created: ${task.id}`));
    console.log(`  Status: ${chalk.yellow(task.status)}`);
    console.log(`  Type:   ${options.readOnly ? chalk.blue("read-only (analysis)") : chalk.dim("modification")}`);
    if (task.target_files.length > 0) {
      console.log(`  Files: ${task.target_files.join(", ")}`);
    } else {
      console.log(`  Files: ${chalk.dim("(auto-discover)")}`);
    }
  });

taskCmd
  .command("list")
  .description("List tasks")
  .option("--status <status>", "Filter by status")
  .option("--agent <id>", "Filter by assigned agent")
  .action((options) => {
    const root = resolveRepoRoot();
    const store = new TaskStore(root);

    const filter: Record<string, string> = {};
    if (options.status) filter.status = options.status;
    if (options.agent) filter.assigned_agent = options.agent;

    const tasks = store.listTasks(filter as Parameters<typeof store.listTasks>[0]);
    console.log(formatTaskTable(tasks));
  });

taskCmd
  .command("show")
  .description("Show task details")
  .argument("<task-id>", "Task ID")
  .action((taskId: string) => {
    const root = resolveRepoRoot();
    const store = new TaskStore(root);

    const task = store.getTask(taskId);
    if (!task) {
      console.log(chalk.red(`Task ${taskId} not found.`));
      return;
    }

    console.log(chalk.bold("\nTask Details:"));
    console.log(`  ID:          ${task.id}`);
    console.log(`  Status:      ${task.status}`);
    const isReadOnly = task.metadata?.read_only === true;
    console.log(`  Type:        ${isReadOnly ? chalk.blue("read-only (analysis)") : chalk.dim("modification")}`);
    console.log(`  Description: ${task.description}`);
    console.log(`  Files:       ${task.target_files.join(", ")}`);
    console.log(`  Agent:       ${task.assigned_agent ?? "(unassigned)"}`);
    console.log(`  Dependency:  ${task.dependency ?? "(none)"}`);
    console.log(`  Created:     ${new Date(task.created_at).toISOString()}`);
    console.log(`  Updated:     ${new Date(task.updated_at).toISOString()}`);
    console.log(`  Version:     ${task.version}`);
    if (Object.keys(task.metadata).length > 0) {
      console.log(`  Metadata:    ${JSON.stringify(task.metadata, null, 2)}`);
    }

    // Display report for read-only tasks
    const reportPath = path.join(root, ".multiagent", "reports", `${taskId}.md`);
    if (fs.existsSync(reportPath)) {
      console.log(chalk.bold("\n--- Report ---"));
      const report = fs.readFileSync(reportPath, "utf-8");
      console.log(report);
    } else if (isReadOnly && task.status === "done") {
      console.log(chalk.yellow("\n  (Report file not found — the agent may not have saved output)"));
    }
  });

taskCmd
  .command("cancel")
  .description("Cancel a pending or in-progress task")
  .argument("<task-id>", "Task ID")
  .action((taskId: string) => {
    const root = resolveRepoRoot();
    const store = new TaskStore(root);

    const task = store.getTask(taskId);
    if (!task) {
      console.log(chalk.red(`Task ${taskId} not found.`));
      return;
    }

    if (task.status === "done") {
      console.log(chalk.yellow(`Task already done, nothing to cancel.`));
      return;
    }

    if (task.status === "failed" || task.status === "stuck") {
      console.log(chalk.yellow(`Task is already in terminal state "${task.status}".`));
      return;
    }

    if (task.status === "in_progress") {
      console.log(chalk.yellow(`Task is in progress — cancelling (agent will detect on next status check).`));
    }

    const updated = store.updateTask(taskId, () => ({
      status: "failed",
      metadata: { cancelled: true, cancelled_at: Date.now() },
    }));
    if (!updated) {
      console.log(chalk.red("Failed to update task (version conflict)."));
      return;
    }

    console.log(chalk.green(`Task ${taskId.slice(0, 8)} cancelled.`));

    // Cascade cancellation to dependent tasks
    const dependents = store.findDependents(taskId);
    for (const dep of dependents) {
      if (dep.status === "pending") {
        store.updateTask(dep.id, () => ({
          status: "failed",
          metadata: {
            failure_reason: `Dependency task ${taskId.slice(0, 8)} was cancelled`,
            cancelled: true,
          },
        }));
        console.log(chalk.yellow(`  Cascaded: task ${dep.id.slice(0, 8)} cancelled (depended on ${taskId.slice(0, 8)})`));
      }
    }
  });

// ---- laol scheduler ----

const schedulerCmd = program
  .command("scheduler")
  .description("Manage the task scheduler");

schedulerCmd
  .command("start")
  .description("Start the scheduler (long-running process)")
  .option("--port <number>", "TCP port for agent connections", "9123")
  .option("--pool-size <number>", "Worktree pool size", "4")
  .action(async (options) => {
    const root = resolveRepoRoot();

    // Override config with CLI options
    const config = loadConfig(root);
    config.scheduler.port = parseInt(options.port, 10);
    config.scheduler.pool_size = parseInt(options.poolSize, 10);
    saveConfig(root, config);

    console.log(chalk.bold("LAOL Scheduler"));
    console.log(`  Repo:  ${root}`);
    console.log(`  Port:  ${config.scheduler.port}`);
    console.log(`  Pool:  ${config.scheduler.pool_size} worktrees`);
    console.log("");

    const scheduler = new Scheduler(root);

    // Graceful shutdown
    const shutdown = async () => {
      console.log(chalk.yellow("\nShutting down..."));
      await scheduler.stop();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    try {
      await scheduler.start();
      console.log(chalk.green("Scheduler is running. Press Ctrl+C to stop."));
    } catch (err) {
      console.error(chalk.red(`Failed to start scheduler: ${err}`));
      process.exit(1);
    }
  });

// ---- laol agent ----

const agentCmd = program
  .command("agent")
  .description("Manage agent workers");

agentCmd
  .command("start")
  .description("Start an agent (long-running process)")
  .requiredOption("--id <agent-id>", "Unique agent identifier")
  .option("--port <number>", "Scheduler port to connect to", "9123")
  .option("--host <host>", "Scheduler host", "127.0.0.1")
  .option("--mode <mode>", "Execution mode: piped (non-interactive) or interactive (full terminal). Default: from config (interactive)")
  .action(async (options) => {
    const root = resolveRepoRoot();
    const agentId = options.id;
    const port = parseInt(options.port, 10);
    const host = options.host;
    const mode = options.mode as string | undefined;

    // Validate mode if provided
    if (mode !== undefined && mode !== "piped" && mode !== "interactive") {
      console.log(chalk.red(`Invalid mode: "${mode}". Must be "piped" or "interactive".`));
      process.exit(1);
    }

    // Resolve effective mode: CLI flag > config > default ("interactive")
    const config = loadConfig(root);
    const effectiveMode = mode ?? config.agent.mode ?? "interactive";

    const modeDisplay = effectiveMode === "interactive"
      ? chalk.cyan("interactive (terminal)")
      : chalk.dim("piped (background)");

    console.log(chalk.bold(`LAOL Agent: ${agentId}`));
    console.log(`  Repo:         ${root}`);
    console.log(`  Scheduler:    ${host}:${port}`);
    console.log(`  Mode:         ${modeDisplay}`);
    console.log("");

    if (effectiveMode === "interactive") {
      console.log(chalk.dim("  In interactive mode, a new terminal window will open for each task."));
      console.log(chalk.dim("  This agent terminal shows logs and status. Keep it running.\n"));
    }

    const runner = new AgentRunner(root, agentId, port, host, effectiveMode as "piped" | "interactive");

    const shutdown = async () => {
      console.log(chalk.yellow("\nShutting down agent..."));
      await runner.stop();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    try {
      await runner.start();
      console.log(chalk.green(`Agent "${agentId}" is running. Press Ctrl+C to stop.`));
    } catch (err) {
      console.error(chalk.red(`Failed to start agent: ${err}`));
      process.exit(1);
    }
  });

// ---- laol locks ----

const locksCmd = program
  .command("locks")
  .description("Manage file locks");

locksCmd
  .command("list")
  .description("List active locks")
  .action(() => {
    const root = resolveRepoRoot();
    const lm = new LockManager(root);
    const locks = lm.listLocks();
    console.log(formatLockTable(locks));
  });

locksCmd
  .command("force-release")
  .description("Force-release a lock (caution: may cause conflicts)")
  .argument("<file>", "File path to unlock")
  .action((file: string) => {
    const root = resolveRepoRoot();
    const lm = new LockManager(root);

    if (lm.forceRelease(file)) {
      console.log(chalk.green(`Lock released: ${file}`));
    } else {
      console.log(chalk.yellow(`No lock found for: ${file}`));
    }
  });

// ---- laol config ----

const configCmd = program
  .command("config")
  .description("View and manage configuration");

configCmd
  .command("show")
  .description("Display current configuration")
  .action(() => {
    const root = resolveRepoRoot();
    const config = loadConfig(root);
    console.log(JSON.stringify(config, null, 2));
  });

configCmd
  .command("set")
  .description("Set a configuration value (dot-separated path)")
  .argument("<key>", "Config key path (e.g. scheduler.port)")
  .argument("<value>", "New value")
  .action((key: string, value: string) => {
    const root = resolveRepoRoot();
    const config = loadConfig(root);

    // Parse the dot-separated key and set the value
    const parts = key.split(".");
    let current: Record<string, unknown> = config as unknown as Record<string, unknown>;

    for (let i = 0; i < parts.length - 1; i++) {
      if (!(parts[i] in current)) {
        console.log(chalk.red(`Unknown config key: ${key}`));
        return;
      }
      current = current[parts[i]] as Record<string, unknown>;
    }

    const lastKey = parts[parts.length - 1];
    if (!(lastKey in current)) {
      console.log(chalk.red(`Unknown config key: ${key}`));
      return;
    }

    // Try to parse the value (number, boolean, or string)
    const currentVal = current[lastKey];
    let parsedValue: unknown = value;
    if (typeof currentVal === "number") {
      parsedValue = parseInt(value, 10);
      if (isNaN(parsedValue as number)) {
        console.log(chalk.red(`Expected a number for ${key}`));
        return;
      }
    } else if (typeof currentVal === "boolean") {
      parsedValue = value === "true" || value === "1";
    }

    current[lastKey] = parsedValue;
    saveConfig(root, config);
    console.log(chalk.green(`${key} = ${JSON.stringify(parsedValue)}`));
  });

// ---- laol status ----

program
  .command("status")
  .description("Show system status overview")
  .action(() => {
    const root = resolveRepoRoot();
    const store = new TaskStore(root);

    const allTasks = store.listTasks();
    const statusCount = {
      total: allTasks.length,
      pending: allTasks.filter((t) => t.status === "pending").length,
      in_progress: allTasks.filter((t) => t.status === "in_progress").length,
      done: allTasks.filter((t) => t.status === "done").length,
      failed: allTasks.filter((t) => t.status === "failed" || t.status === "stuck").length,
    };

    const locksDir = path.join(root, ".multiagent", "locks");
    const lockCount = fs.existsSync(locksDir)
      ? fs.readdirSync(locksDir).filter((f) => f.endsWith(".lock")).length
      : 0;

    const worktreesDir = path.join(root, ".multiagent", "worktrees");
    const poolTotal = fs.existsSync(worktreesDir)
      ? fs.readdirSync(worktreesDir).length
      : 0;

    console.log(formatStatusOverview({
      tasks: statusCount,
      locks: lockCount,
      agents: 0, // agents tracked in-process, CLI has no live view
      worktreePool: { available: poolTotal, in_use: 0 },
    }));
  });

// ---- laol shutdown ----

program
  .command("shutdown")
  .description("Gracefully stop all agents, the scheduler, and clean up worktrees")
  .option("--port <number>", "Scheduler port", "9123")
  .option("--host <host>", "Scheduler host", "127.0.0.1")
  .action(async (options) => {
    const port = parseInt(options.port, 10);
    const host = options.host;

    console.log(chalk.yellow("Sending shutdown signal to scheduler..."));

    const socket = new net.Socket();

    try {
      await new Promise<void>((resolve, reject) => {
        socket.connect(port, host, () => {
          socket.write(JSON.stringify({ type: "shutdown" }) + "\n");
          // Give the scheduler a moment to receive and process
          setTimeout(() => {
            socket.destroy();
            resolve();
          }, 1000);
        });

        socket.on("error", (err: NodeJS.ErrnoException) => {
          if (err.code === "ECONNREFUSED") {
            reject(new Error(`No scheduler running at ${host}:${port}`));
          } else {
            reject(err);
          }
        });
      });

      console.log(chalk.green("Shutdown signal sent."));
      console.log(chalk.dim("Scheduler and all agents should exit within a few seconds."));
    } catch (err) {
      console.error(chalk.red(`Failed to send shutdown signal: ${(err as Error).message}`));
      process.exit(1);
    }
  });

// ---- laol merge ----

const mergeCmd = program
  .command("merge")
  .description("AI-powered semantic merge pipeline");

mergeCmd
  .command("start")
  .description("Merge an agent branch using semantic conflict resolution")
  .requiredOption("--agent-branch <branch>", "Agent branch to merge (e.g., agent/task-uuid)")
  .option("--base <branch>", "Base branch to merge into", "main")
  .action(async (options) => {
    const root = resolveRepoRoot();
    const config = loadConfig(root);
    const { ClaudeLLMProvider } = await import("../merge/claude-llm-provider");
    const { MergeDriver } = await import("../merge/merge-driver");

    // Use repo root as the worktree for the merge (it has the full git history)
    const worktreePath = root;

    // Verify the worktree is clean before starting
    console.log(chalk.bold("LAOL Semantic Merge"));
    console.log(`  Repo:          ${root}`);
    console.log(`  Base branch:   ${options.base}`);
    console.log(`  Agent branch:  ${options.agentBranch}`);
    console.log("");

    // Build LLM provider from config
    const primaryProvider = new ClaudeLLMProvider({
      model: config.llm.model,
      timeoutMs: 60_000,
      binaryPath: config.claude_executor.binary_path,
    });

    let quorumProvider; // ClaudeLLMProvider | undefined
    if (config.merge_driver_config.quorum_enabled && config.llm.secondary_model) {
      quorumProvider = new ClaudeLLMProvider({
        model: config.llm.secondary_model,
        timeoutMs: 60_000,
        binaryPath: config.claude_executor.binary_path,
      });
      console.log(chalk.dim(`  Quorum mode enabled (secondary model: ${config.llm.secondary_model})`));
    }

    const driver = new MergeDriver({
      worktreePath,
      llmProvider: primaryProvider,
      quorumProvider,
      mergeChecks: config.merge_checks,
    });

    // Write merge status file
    writeStatusFile(root, {
      state: "in_progress",
      base_branch: options.base,
      agent_branch: options.agentBranch,
      started_at: Date.now(),
      conflicted_files: [],
      resolutions: [],
    });

    console.log(chalk.dim("Starting merge..."));
    const result = await driver.merge(options.base, options.agentBranch);

    // Print per-block resolution details
    if (result.resolutions.length > 0) {
      console.log(chalk.bold("\nConflict Resolutions:"));
      for (const r of result.resolutions) {
        const methodIcon =
          r.method === "ast" ? chalk.green("✓") :
          r.method === "llm" ? chalk.blue("🤖") :
          chalk.red("✗");
        const status = r.resolved ? chalk.green("resolved") : chalk.red("unresolved");
        console.log(`  ${methodIcon} ${r.file}#${r.blockIndex} [${r.method}] — ${status}`);
        if (r.quorumDiff) {
          console.log(chalk.yellow(`    ${r.quorumDiff}`));
        }
      }
    }

    // Validation
    if (result.validation) {
      console.log("");
      if (result.validation.passed) {
        console.log(chalk.green(`Validation: ${result.validation.message}`));
      } else {
        console.log(chalk.red(`Validation FAILED: ${result.validation.message}`));
      }
    }

    if (result.success) {
      writeStatusFile(root, {
        state: "complete",
        base_branch: options.base,
        agent_branch: options.agentBranch,
        completed_at: Date.now(),
        method: result.method,
        resolutions: result.resolutions,
        validation: result.validation,
      });
      console.log(chalk.green("\nMerge completed successfully."));

      // Prompt to push
      if (result.method === "llm" && result.resolutions.some((r) => r.method === "llm")) {
        console.log(chalk.yellow("\n[!] LLM-generated merge — review the result before pushing."));
        console.log(chalk.dim(`  Review changes:  cd "${root}" && git diff ${options.base}..HEAD`));
        console.log(chalk.dim(`  Push to remote: git push origin ${options.base}`));
      }
    } else {
      writeStatusFile(root, {
        state: result.resolutions.some((r) => !r.resolved) ? "conflicts_remain" : "failed",
        base_branch: options.base,
        agent_branch: options.agentBranch,
        error: result.error ?? "Merge failed",
        resolutions: result.resolutions,
        conflicted_files: result.resolutions.filter((r) => !r.resolved).map((r) => r.file),
      });

      console.log(chalk.red(`\nMerge failed: ${result.error ?? "Unknown error"}`));
      if (result.resolutions.some((r) => !r.resolved)) {
        console.log(chalk.yellow("\nSome conflicts could not be auto-resolved."));
        console.log(chalk.dim("  Manually resolve the conflicts, then run:"));
        console.log(chalk.dim(`  laol merge resolve --file <path>`));
      }
      process.exit(1);
    }
  });

mergeCmd
  .command("status")
  .description("Show current merge status")
  .action(() => {
    const root = resolveRepoRoot();
    const statusPath = path.join(root, ".multiagent", "merge-status.json");

    if (!fs.existsSync(statusPath)) {
      console.log(chalk.dim("No active or recent merge. Use `laol merge start` to begin a merge."));
      return;
    }

    const status = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
    const stateColors: Record<string, (s: string) => string> = {
      in_progress: chalk.yellow,
      complete: chalk.green,
      conflicts_remain: chalk.red,
      failed: chalk.red,
    };

    const colorFn = stateColors[status.state] ?? chalk.dim;
    console.log(chalk.bold("Merge Status"));
    console.log(`  State:         ${colorFn(status.state)}`);
    console.log(`  Base branch:   ${status.base_branch}`);
    console.log(`  Agent branch:  ${status.agent_branch}`);
    if (status.started_at) {
      console.log(`  Started:       ${new Date(status.started_at).toISOString()}`);
    }
    if (status.completed_at) {
      console.log(`  Completed:     ${new Date(status.completed_at).toISOString()}`);
    }

    if (status.resolutions?.length > 0) {
      console.log(chalk.bold("\n  Resolutions:"));
      for (const r of status.resolutions) {
        const icon = r.resolved ? chalk.green("✓") : chalk.red("✗");
        console.log(`    ${icon} ${r.file}#${r.blockIndex} [${r.method}]`);
      }
    }

    if (status.conflicted_files?.length > 0) {
      console.log(chalk.bold("\n  Unresolved files:"));
      for (const f of status.conflicted_files) {
        console.log(`    ${chalk.red("✗")} ${f}`);
      }
    }

    if (status.error) {
      console.log(chalk.red(`\n  Error: ${status.error}`));
    }
  });

mergeCmd
  .command("resolve")
  .description("Mark a conflicted file as manually resolved and continue the merge")
  .requiredOption("--file <path>", "Path to the manually resolved file")
  .action(async (options) => {
    const root = resolveRepoRoot();
    const statusPath = path.join(root, ".multiagent", "merge-status.json");

    if (!fs.existsSync(statusPath)) {
      console.log(chalk.red("No active merge. Use `laol merge start` to begin a merge."));
      process.exit(1);
    }

    const status = JSON.parse(fs.readFileSync(statusPath, "utf-8"));

    if (status.state !== "conflicts_remain" && status.state !== "in_progress") {
      console.log(chalk.yellow(`Merge state is "${status.state}" — no conflicts to resolve.`));
      return;
    }

    const file = options.file;
    // Check if file still has conflict markers
    const filePath = path.join(root, file);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf-8");
      // Dynamic import for the conflict-parser (same lazy-load strategy as start)
      const { hasConflictMarkers } = await import("../merge/conflict-parser");
      if (hasConflictMarkers(content)) {
        console.log(
          chalk.yellow(`File "${file}" still contains conflict markers. Please resolve all <<<<<<< / >>>>>>> blocks.`)
        );
        return;
      }
    }

    // Remove from unresolved list
    const stillConflict = (status.conflicted_files ?? []).filter(
      (f: string) => f !== file
    );
    status.conflicted_files = stillConflict;

    console.log(chalk.green(`Marked "${file}" as resolved.`));

    if (stillConflict.length === 0) {
      // All conflicts resolved — stage and commit
      try {
        execSync("git add -A", { cwd: root, stdio: "pipe", timeout: 10_000 });
        execSync('git commit -m "Merge: manual resolution of remaining conflicts"', {
          cwd: root,
          stdio: "pipe",
          timeout: 10_000,
        });
        status.state = "complete";
        status.completed_at = Date.now();
        console.log(chalk.green("All conflicts resolved and committed."));
      } catch (err) {
        console.log(chalk.red(`Failed to commit: ${err}`));
        status.error = String(err);
      }
    } else {
      console.log(chalk.yellow(`  ${stillConflict.length} file(s) still need resolution:`));
      for (const f of stillConflict) {
        console.log(chalk.dim(`    ${f}`));
      }
    }

    writeStatusFile(root, status);
  });

// ---- laol indexer ----

const indexerCmd = program
  .command("indexer")
  .description("Codebase symbol index for LLM-assisted task localization");

indexerCmd
  .command("build")
  .description("Build or rebuild the codebase index")
  .option("--full", "Force full rebuild (ignore cached hashes)")
  .action((options) => {
    const root = resolveRepoRoot();
    const indexer = new CodebaseIndexer(root);
    console.log(chalk.dim("Indexing codebase..."));
    const stats = indexer.build(options.full ?? false);
    console.log(chalk.green(`Index built: ${stats.totalFiles} files, ${stats.totalSymbols} symbols`));
    if (Object.keys(stats.symbolsByKind).length > 0) {
      for (const [kind, count] of Object.entries(stats.symbolsByKind).sort()) {
        console.log(chalk.dim(`  ${kind}: ${count}`));
      }
    }
    if (stats.lastBuilt) {
      console.log(chalk.dim(`  built at: ${new Date(stats.lastBuilt).toISOString()}`));
    }
  });

indexerCmd
  .command("query")
  .description("Search the codebase index for symbols")
  .argument("<keyword>", "Keyword to search for")
  .action((keyword: string) => {
    const root = resolveRepoRoot();
    const indexer = new CodebaseIndexer(root);
    const results = indexer.query(keyword);
    if (results.length === 0) {
      console.log(chalk.yellow(`No results for "${keyword}". Run "laol indexer build" first.`));
      return;
    }
    console.log(chalk.bold(`\nResults for "${keyword}" (${results.length}):`));
    for (const r of results.slice(0, 20)) {
      const line =
        `  [${chalk.yellow(r.symbol.kind)}] ${chalk.cyan(r.symbol.name)} ` +
        `in ${chalk.dim(r.file)}:${r.symbol.range[0]} ` +
        `(${chalk.green(Math.round(r.relevance) + "%")})`;
      console.log(line);
      if (r.symbol.jsDoc?.description) {
        console.log(chalk.dim(`    ${r.symbol.jsDoc.description.slice(0, 120)}`));
      }
      if (r.symbol.parameters && r.symbol.parameters.length > 0) {
        const params = r.symbol.parameters
          .map((p) => `${p.name}${p.optional ? "?" : ""}: ${p.type}`)
          .join(", ");
        console.log(chalk.dim(`    (${params}) => ${r.symbol.returnType ?? "unknown"}`));
      }
    }
  });

indexerCmd
  .command("show")
  .description("Show indexed symbols in a file")
  .argument("<file>", "Relative file path (e.g. src/agent/agent-worker.ts)")
  .action((file: string) => {
    const root = resolveRepoRoot();
    const indexer = new CodebaseIndexer(root);
    const entry = indexer.getFileSymbols(file);
    if (!entry) {
      console.log(chalk.yellow(`File "${file}" not found in index. Run "laol indexer build" first.`));
      return;
    }
    console.log(chalk.bold(`\n${file} — ${entry.symbols.length} symbols, ${entry.imports.length} imports`));
    console.log(chalk.dim(`  Indexed: ${new Date(entry.indexed_at).toISOString()}`));

    if (entry.imports.length > 0) {
      console.log(chalk.bold("\n  Imports:"));
      for (const imp of entry.imports) {
        const parts: string[] = [];
        if (imp.defaultImport) parts.push(`default: ${imp.defaultImport}`);
        if (imp.namespaceImport) parts.push(`* as ${imp.namespaceImport}`);
        if (imp.namedImports.length > 0) parts.push(`{ ${imp.namedImports.join(", ")} }`);
        console.log(chalk.dim(`    ${parts.join(", ")} from "${imp.moduleSpecifier}"`));
      }
    }

    console.log(chalk.bold("\n  Symbols:"));
    for (const sym of entry.symbols) {
      const exp = sym.exported ? chalk.yellow(" export") : "";
      console.log(
        `    [${chalk.cyan(sym.kind)}${exp}] ${chalk.green(sym.name)} ` +
        `(lines ${sym.range[0]}-${sym.range[1]})`
      );
      if (sym.jsDoc?.description) {
        console.log(chalk.dim(`      ${sym.jsDoc.description.slice(0, 100)}`));
      }
      if (sym.parameters && sym.parameters.length > 0) {
        const params = sym.parameters
          .map((p) => `${p.name}${p.optional ? "?" : ""}: ${p.type}`)
          .join(", ");
        console.log(chalk.dim(`      (${params})`));
      }
      if (sym.returnType) {
        console.log(chalk.dim(`      => ${sym.returnType}`));
      }
    }
  });

indexerCmd
  .command("docs")
  .description("Generate project API documentation in markdown format")
  .option("--output <file>", "Write docs to a file instead of stdout")
  .option("--files <pattern>", "Filter to matching files (glob, e.g. 'src/agent/**')")
  .action((options) => {
    const root = resolveRepoRoot();
    const indexer = new CodebaseIndexer(root);
    const filter = options.files ? [options.files] : undefined;
    const doc = indexer.generateDocs(filter);

    if (options.output) {
      const outPath = path.resolve(root, options.output);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, doc, "utf-8");
      console.log(chalk.green(`Documentation written to: ${path.relative(process.cwd(), outPath)}`));
    } else {
      console.log(doc);
    }
  });

indexerCmd
  .command("stats")
  .description("Show codebase index statistics")
  .action(() => {
    const root = resolveRepoRoot();
    const indexer = new CodebaseIndexer(root);
    const stats = indexer.getStats();

    console.log(chalk.bold("\nCodebase Index Statistics"));
    console.log(`  Files:    ${stats.totalFiles}`);
    console.log(`  Symbols:  ${stats.totalSymbols}`);
    console.log(`  Imports:  ${stats.totalImports}`);

    if (stats.lastBuilt) {
      console.log(`  Built:    ${new Date(stats.lastBuilt).toISOString()}`);
    } else {
      console.log(chalk.yellow(`  No index built yet. Run "laol indexer build" first.`));
    }

    if (Object.keys(stats.symbolsByKind).length > 0) {
      console.log(chalk.bold("\n  By kind:"));
      for (const [kind, count] of Object.entries(stats.symbolsByKind).sort()) {
        console.log(`    ${kind}: ${count}`);
      }
    }
  });

// ---- helpers ----

function writeStatusFile(root: string, status: Record<string, unknown>): void {
  const statusPath = path.join(root, ".multiagent", "merge-status.json");
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  fs.writeFileSync(statusPath, JSON.stringify(status, null, 2), "utf-8");
}

// ---- export ----

export function run(): void {
  program.parse(process.argv);
}
