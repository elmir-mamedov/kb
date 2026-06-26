import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Git auto-commit helpers bound to a knowledge-base directory. Both the web
 * server and the MCP server use these so every write lands as an audited commit.
 */
export function makeGit(kbDir: string) {
  function kbRelPath(fsPath: string): string {
    const relPath = path.relative(kbDir, fsPath);
    if (!relPath || relPath.startsWith("..") || path.isAbsolute(relPath)) {
      throw new Error("Refusing to commit a file outside the knowledge base.");
    }
    return relPath.split(path.sep).join("/");
  }

  async function commitFiles(fsPaths: string[], message: string): Promise<string | null> {
    const rels = [...new Set(fsPaths.map(kbRelPath))];
    if (rels.length === 0) return null;

    const { stdout: status } = await execFileAsync(
      "git",
      ["status", "--porcelain", "--", ...rels],
      { cwd: kbDir }
    );
    if (!status.trim()) return null;

    await execFileAsync("git", ["add", "--", ...rels], { cwd: kbDir });

    const hasUntracked = status
      .split("\n")
      .filter(Boolean)
      .some((line) => line.startsWith("??"));
    const commitArgs = hasUntracked
      ? ["commit", "-m", message, "--", ...rels]
      : ["commit", "--only", "-m", message, "--", ...rels];

    await execFileAsync("git", commitArgs, { cwd: kbDir });

    const { stdout } = await execFileAsync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: kbDir,
    });
    return stdout.trim() || null;
  }

  async function commitMovedPaths(fsPaths: string[], message: string): Promise<string | null> {
    const rels = [...new Set(fsPaths.map(kbRelPath))];
    if (rels.length === 0) return null;

    const { stdout: status } = await execFileAsync(
      "git",
      ["status", "--porcelain", "--", ...rels],
      { cwd: kbDir }
    );
    if (!status.trim()) return null;

    await execFileAsync("git", ["add", "-A", "--", ...rels], { cwd: kbDir });
    await execFileAsync("git", ["commit", "-m", message, "--", ...rels], {
      cwd: kbDir,
    });

    const { stdout } = await execFileAsync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: kbDir,
    });
    return stdout.trim() || null;
  }

  return { kbRelPath, commitFiles, commitMovedPaths };
}

export type Git = ReturnType<typeof makeGit>;
