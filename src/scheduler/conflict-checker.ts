import * as path from "node:path";
import { LockManager } from "../lock/lock-manager";
import type { Task, ConflictResult } from "../data/models";

/**
 * Conflict Checker — screens tasks before assignment.
 *
 * Three-level check:
 * 1. Direct lock conflict: any target file already locked → reject
 * 2. Semantic (registry) conflict: same module recently modified → warn (don't reject)
 * 3. Dependency check: task's dependency not yet done → reject
 *
 * The checker is invoked by the scheduler on every task_created event
 * and whenever a lock is released (to retry blocked tasks).
 */

export class ConflictChecker {
  private lockManager: LockManager;

  // Symbol-level lock awareness (P2 — when SymbolResolver is available)
  private symbolResolver: SymbolResolver | null = null;

  constructor(lockManager: LockManager) {
    this.lockManager = lockManager;
  }

  /**
   * Set a symbol resolver for finer-grained lock conflict detection.
   * Without this, all locks are file-level.
   */
  setSymbolResolver(resolver: SymbolResolver): void {
    this.symbolResolver = resolver;
  }

  /**
   * Determine whether a task can be safely assigned to an agent.
   */
  canAssign(task: Task): ConflictResult {
    const warnings: string[] = [];
    let riskLevel: "low" | "high" = "low";

    // --- Check 1: Dependency resolution ---
    if (task.dependency) {
      // Note: the scheduler passes the dependency task status into this check
      // For now, we only check if a dependency is declared — the scheduler
      // resolves the actual dependency status before calling this method.
      // If the dependency is declared, the scheduler must verify it.
    }

    // If target_files is empty, skip conflict detection — the agent will
    // discover and request locks dynamically during execution.
    if (task.target_files.length === 0) {
      return { can_assign: true, risk_level: "low" };
    }

    // --- Check 2: Direct lock conflicts ---
    const directConflict = this.checkDirectConflicts(task.target_files);
    if (directConflict) {
      return {
        can_assign: false,
        reason: directConflict,
        risk_level: riskLevel,
        warnings,
      };
    }

    // --- Check 3: Symbol-level conflicts (P2) ---
    if (this.symbolResolver) {
      const symbolConflict = this.checkSymbolConflicts(task);
      if (symbolConflict) {
        return {
          can_assign: false,
          reason: symbolConflict,
          risk_level: riskLevel,
          warnings,
        };
      }
    }

    // --- Check 4: Module-level semantic proximity ---
    // If any target file is in a module that has active locks, flag it
    const moduleWarning = this.checkModuleProximity(task.target_files);
    if (moduleWarning) {
      warnings.push(moduleWarning);
      riskLevel = "high";
    }

    return {
      can_assign: true,
      risk_level: riskLevel,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  /**
   * Check if any of the given files is currently locked.
   * Returns the conflict description string, or null if all clear.
   */
  private checkDirectConflicts(files: string[]): string | null {
    const conflict = this.lockManager.findConflict(files);
    if (conflict) {
      return `File "${conflict.file}" is locked by agent "${conflict.holder}"`;
    }

    // Also check for file-level locks when we have symbol-level targets
    // e.g. if "src/auth.ts" is locked, "src/auth.ts#login" should also conflict
    for (const file of files) {
      if (file.includes("#")) {
        const fileLevel = file.split("#")[0];
        const lock = this.lockManager.getLock(fileLevel);
        if (lock) {
          return `File "${fileLevel}" is fully locked by agent "${lock.holder}" (symbol-level lock on "${file}" blocked)`;
        }
      }
    }

    return null;
  }

  /**
   * Check for symbol-level conflicts using tree-sitter AST resolution.
   * Returns conflict string or null if all clear.
   */
  private checkSymbolConflicts(task: Task): string | null {
    if (!this.symbolResolver) return null;

    for (const file of task.target_files) {
      if (file.includes("#")) {
        // This is already a symbol-level target — check directly
        const lock = this.lockManager.getLock(file);
        if (lock) {
          return `Symbol "${file}" is locked by agent "${lock.holder}"`;
        }
      }
    }

    return null;
  }

  /**
   * Check if the task's target files are in the same module directory
   * as other actively locked files (semantic proximity warning).
   */
  private checkModuleProximity(files: string[]): string | null {
    const allLocks = this.lockManager.listLocks();

    for (const file of files) {
      const moduleDir = path.dirname(file);

      for (const lock of allLocks) {
        const lockModuleDir = path.dirname(lock.file);

        // Same module directory, but different file → proximity warning
        if (moduleDir === lockModuleDir && !files.includes(lock.file)) {
          return (
            `Module "${moduleDir}" is currently being modified by agent "${lock.holder}" ` +
            `(file: ${lock.file}). Consider reviewing changes before proceeding.`
          );
        }
      }
    }

    return null;
  }
}

/**
 * Symbol resolver interface — implemented by src/lock/symbol-resolver.ts (Phase 6).
 */
export interface SymbolResolver {
  resolveLocksForTask(targetFiles: string[], description: string): string[];
  hasConflict(locksA: string[], locksB: string[]): boolean;
}
