import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Deterministic git identity so commits in throwaway repos succeed without
// depending on (or mutating) the developer's global git config.
process.env.GIT_AUTHOR_NAME ||= "KB25 Test";
process.env.GIT_AUTHOR_EMAIL ||= "test@kb25.local";
process.env.GIT_COMMITTER_NAME ||= "KB25 Test";
process.env.GIT_COMMITTER_EMAIL ||= "test@kb25.local";

export interface TempKb {
  /** Absolute path to a throwaway KB root (the parent of the space folders). */
  dir: string;
  /** Remove the temp tree. Call from a test's `after`/`finally`. */
  cleanup: () => Promise<void>;
}

/** Create an isolated, empty KB directory for a single test. */
export async function makeTempKb(): Promise<TempKb> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kb25-test-"));
  return {
    dir,
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
}

/** Run a git command in `repoRoot` and return trimmed stdout. */
export async function git(repoRoot: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: repoRoot });
  return stdout.trim();
}

/** True when `dir` is the working tree of a git repo (has a `.git` entry). */
export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await fs.access(path.join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

/** True when a filesystem path exists. */
export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
