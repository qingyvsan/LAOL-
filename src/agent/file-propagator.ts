import * as fs from "node:fs";
import * as path from "node:path";

/**
 * FilePropagator — copies files between worktrees.
 *
 * When Agent1 modifies a file and Agent2 needs it, the scheduler triggers
 * propagation to ensure Agent2 works from the latest version. This is the
 * core mechanism for Solution 1 (sequential editing with file propagation).
 */

/**
 * Copy a single file from source worktree to target worktree.
 * Creates target directories if needed.
 *
 * @returns true if the file was copied, false if the source doesn't exist
 */
export function propagateFile(
  sourceWorktree: string,
  targetWorktree: string,
  filePath: string
): boolean {
  const sourceAbs = path.join(sourceWorktree, filePath);
  const targetAbs = path.join(targetWorktree, filePath);

  if (!fs.existsSync(sourceAbs)) {
    return false;
  }

  // Ensure target directory exists
  const targetDir = path.dirname(targetAbs);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // Copy file contents
  fs.copyFileSync(sourceAbs, targetAbs);

  return true;
}

/**
 * Copy multiple files from source worktree to target worktree.
 *
 * @returns Array of file paths that were successfully copied
 */
export function propagateFiles(
  sourceWorktree: string,
  targetWorktree: string,
  filePaths: string[]
): string[] {
  const copied: string[] = [];

  for (const filePath of filePaths) {
    if (propagateFile(sourceWorktree, targetWorktree, filePath)) {
      copied.push(filePath);
    }
  }

  return copied;
}

/**
 * Copy all modified files from source worktree to target worktree.
 * Uses git diff to determine which files changed.
 *
 * @param execSync - The execSync function (passed in to avoid circular deps)
 * @returns Array of file paths that were propagated
 */
export function propagateChangedFiles(
  sourceWorktree: string,
  targetWorktree: string,
  execSync: (cmd: string, opts?: Record<string, unknown>) => Buffer | string
): string[] {
  try {
    const output = execSync("git diff --name-only HEAD", {
      cwd: sourceWorktree,
      stdio: "pipe",
      timeout: 5000,
    });

    const files = output
      .toString()
      .split("\n")
      .map((line: string) => line.trim())
      .filter((line: string) => line.length > 0);

    return propagateFiles(sourceWorktree, targetWorktree, files);
  } catch {
    return [];
  }
}
