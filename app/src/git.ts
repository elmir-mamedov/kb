import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** One commit that touched a page, as reported by {@link makeGit}'s `fileCommits`. */
export interface CommitMeta {
  /** Full commit SHA. */
  sha: string;
  /** Committer date, preformatted `YYYY-MM-DD HH:MM` (same format as the "Updated" line). */
  date: string;
  /** Commit subject line — ends in `via web` / `via mcp`, revealing who made the edit. */
  subject: string;
  /**
   * The file's path within its space repo *at this commit* (forward slashes).
   * With `--follow` the path can differ from the current one across a rename, so
   * this is what a per-commit `git show` must be scoped to.
   */
  pathAtCommit: string;
}

/**
 * Parse `git log --follow --name-status` output into commits, newest first.
 * Each commit header line is prefixed with \x01 and its fields are \x1f-separated
 * (see the `--format` in `fileCommits`); the name-status line(s) that follow give
 * the file's path at that commit (`M\tpath`, `A\tpath`, or `R100\told\tnew`).
 */
function parseFileCommits(stdout: string): CommitMeta[] {
  const commits: CommitMeta[] = [];
  let current: CommitMeta | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("\x01")) {
      const [sha, date, subject] = line.slice(1).split("\x1f");
      current = { sha: sha ?? "", date: date ?? "", subject: subject ?? "", pathAtCommit: "" };
      commits.push(current);
    } else if (current && line && !current.pathAtCommit) {
      // First name-status line for this commit. Renames/copies list old then new;
      // every other status lists a single path. We want the path at this commit.
      const parts = line.split("\t");
      const status = parts[0] ?? "";
      current.pathAtCommit =
        status.startsWith("R") || status.startsWith("C")
          ? parts[2] ?? parts[1] ?? ""
          : parts[1] ?? "";
    }
  }
  return commits.filter((c) => c.sha);
}

/**
 * Git auto-commit helpers bound to a knowledge-base directory.
 *
 * Each space under the KB root is its **own git repo** (`kb/<space>/.git`), so
 * the KB root itself is not versioned. These helpers resolve the owning space
 * repo per file and group git commands by repo, so a single call can span repos
 * (only the cross-space move case does) while each commit lands in the right
 * place. Both the web server and the MCP server use these so every write is an
 * audited commit in the correct per-space repo.
 */
export function makeGit(kbDir: string) {
  /** Path of fsPath relative to the KB root (forward slashes). Throws if outside the KB. */
  function kbRelPath(fsPath: string): string {
    const relPath = path.relative(kbDir, fsPath);
    if (!relPath || relPath.startsWith("..") || path.isAbsolute(relPath)) {
      throw new Error("Refusing to commit a file outside the knowledge base.");
    }
    return relPath.split(path.sep).join("/");
  }

  /** Absolute path to the per-space git repo that owns fsPath (`kb/<space>`). */
  function spaceRepoRoot(fsPath: string): string {
    const space = kbRelPath(fsPath).split("/")[0];
    if (!space) {
      throw new Error("Refusing to commit a file that does not live inside a space.");
    }
    return path.join(kbDir, space);
  }

  /**
   * fsPath relative to its space repo root (forward slashes), for `git add`/`commit`.
   * Returns "" when fsPath *is* the repo root itself — i.e. a whole space folder,
   * which is what a space rename or move produces. A space is its own git repo, so
   * moving its folder carries `.git` along and changes nothing tracked *inside* the
   * repo; callers treat "" as "nothing to commit here" and skip it.
   */
  function relInRepo(fsPath: string): string {
    const repoRoot = spaceRepoRoot(fsPath);
    const rel = path.relative(repoRoot, fsPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error("Refusing to commit a file outside its space repo.");
    }
    return rel.split(path.sep).join("/");
  }

  /** Group fsPaths by their owning space repo, mapping each to deduped repo-relative paths. */
  function groupByRepo(fsPaths: string[]): Map<string, string[]> {
    const groups = new Map<string, string[]>();
    for (const fsPath of fsPaths) {
      const rel = relInRepo(fsPath);
      // A space-root path (rel === "") means a whole space folder was renamed or
      // moved. That is not a change inside any repo, so there is nothing to add
      // or commit — skip it rather than failing the whole commit.
      if (rel === "") continue;
      const repoRoot = spaceRepoRoot(fsPath);
      const rels = groups.get(repoRoot);
      if (rels) {
        if (!rels.includes(rel)) rels.push(rel);
      } else {
        groups.set(repoRoot, [rel]);
      }
    }
    return groups;
  }

  /**
   * Run the status→add→commit→rev-parse sequence inside a single repo.
   * `mode: "only"` mirrors {@link commitFiles} (untracked-aware `--only`), while
   * `mode: "all"` mirrors {@link commitMovedPaths} (`git add -A` for renames).
   */
  async function commitInRepo(
    repoRoot: string,
    rels: string[],
    message: string,
    mode: "only" | "all"
  ): Promise<string | null> {
    if (rels.length === 0) return null;

    const { stdout: status } = await execFileAsync(
      "git",
      ["status", "--porcelain", "--", ...rels],
      { cwd: repoRoot }
    );
    if (!status.trim()) return null;

    if (mode === "all") {
      await execFileAsync("git", ["add", "-A", "--", ...rels], { cwd: repoRoot });
      await execFileAsync("git", ["commit", "-m", message, "--", ...rels], {
        cwd: repoRoot,
      });
    } else {
      await execFileAsync("git", ["add", "--", ...rels], { cwd: repoRoot });
      const hasUntracked = status
        .split("\n")
        .filter(Boolean)
        .some((line) => line.startsWith("??"));
      const commitArgs = hasUntracked
        ? ["commit", "-m", message, "--", ...rels]
        : ["commit", "--only", "-m", message, "--", ...rels];
      await execFileAsync("git", commitArgs, { cwd: repoRoot });
    }

    const { stdout } = await execFileAsync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repoRoot,
    });
    return stdout.trim() || null;
  }

  async function commitGrouped(
    fsPaths: string[],
    message: string,
    mode: "only" | "all"
  ): Promise<string | null> {
    let lastSha: string | null = null;
    for (const [repoRoot, rels] of groupByRepo(fsPaths)) {
      const sha = await commitInRepo(repoRoot, rels, message, mode);
      if (sha) lastSha = sha;
    }
    return lastSha;
  }

  async function commitFiles(fsPaths: string[], message: string): Promise<string | null> {
    return commitGrouped(fsPaths, message, "only");
  }

  async function commitMovedPaths(fsPaths: string[], message: string): Promise<string | null> {
    return commitGrouped(fsPaths, message, "all");
  }

  /** Initialize a fresh git repo on branch `main` for a newly created space. */
  async function initSpaceRepo(spaceKey: string): Promise<void> {
    const repoRoot = path.join(kbDir, spaceKey);
    await execFileAsync("git", ["init"], { cwd: repoRoot });
    await execFileAsync("git", ["branch", "-m", "main"], { cwd: repoRoot });
  }

  /**
   * Commits that touched a page, newest first — the edit history behind the diff
   * viewer. `--follow` keeps the history spanning renames. Best-effort like
   * {@link gitUpdated}: a non-repo or untracked file yields `[]` rather than throwing.
   */
  async function fileCommits(fsPath: string): Promise<CommitMeta[]> {
    try {
      const repoRoot = spaceRepoRoot(fsPath);
      const rel = relInRepo(fsPath);
      if (!rel) return [];
      const { stdout } = await execFileAsync(
        "git",
        [
          "log",
          "--follow",
          "--name-status",
          "--date=format:%Y-%m-%d %H:%M",
          // \x01 marks a commit header; \x1f separates sha / date / subject.
          "--format=\x01%H%x1f%cd%x1f%s",
          "--",
          rel,
        ],
        { cwd: repoRoot }
      );
      return parseFileCommits(stdout);
    } catch {
      return [];
    }
  }

  /**
   * Raw `--word-diff=porcelain` patch for what a single commit changed in a file,
   * relative to its parent (the initial commit shows the whole file as added).
   * `pathAtCommit` scopes the diff to the file's path at that commit (rename-safe).
   * Best-effort: returns "" on any failure.
   */
  async function showWordDiff(fsPath: string, sha: string, pathAtCommit: string): Promise<string> {
    try {
      const repoRoot = spaceRepoRoot(fsPath);
      const target = pathAtCommit || relInRepo(fsPath);
      const { stdout } = await execFileAsync(
        "git",
        ["show", "--format=", "--no-color", "--word-diff=porcelain", sha, "--", target],
        { cwd: repoRoot }
      );
      return stdout;
    } catch {
      return "";
    }
  }

  return {
    kbRelPath,
    spaceRepoRoot,
    commitFiles,
    commitMovedPaths,
    initSpaceRepo,
    fileCommits,
    showWordDiff,
  };
}

export type Git = ReturnType<typeof makeGit>;
