import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Peer-to-peer git sync for the per-space repos: pull on startup, push after
 * every auto-commit. This is what lets one person work the same knowledge base
 * from several machines — pull, read/write, push — without any manual git.
 *
 * Deliberately temporary. `flux/knowledge-base-plan/multi-machine-sync-one-user-many-machines.md`
 * settles on a central, git-backed host instead, at which point clients stop
 * cloning and this module is deleted outright. It is therefore kept to one file
 * plus a single callback in {@link makeGit}, so removing it later is a clean cut.
 *
 * Everything here is best-effort, matching `fileCommits` / `showWordDiff` in
 * `git.ts`: a dead network, a missing credential or a conflicted rebase must
 * degrade to "not synced right now", never to a failed save.
 */

/** Tuning for {@link makeSync}; every field has a working default. */
export interface SyncOptions {
  /** Quiet period after the last commit before pushing, coalescing bursts. */
  debounceMs?: number;
  /** Hard ceiling on any single git invocation, so no call can hang a save. */
  timeoutMs?: number;
  /** Where warnings go. Defaults to stderr — see the stdout note on {@link makeSync}. */
  log?: (message: string) => void;
}

export interface Sync {
  /** Rebase every space repo that has a remote onto its upstream. */
  pullAll(): Promise<void>;
  /** Record a commit in `repoRoot` and (re-)arm its debounced push. */
  notifyCommit(repoRoot: string): void;
  /** Run every debounced push now and wait for it — used on shutdown and by tests. */
  flush(): Promise<void>;
  /** Begin pulling every `intervalMs`; 0 or less disables it. */
  startPeriodicPull(intervalMs: number): void;
  /** Drop all timers so the process can exit. */
  stop(): void;
}

/**
 * Build the sync driver for a KB root.
 *
 * Two rules shape the implementation and are load-bearing:
 *
 * - **Never log to stdout.** `mcp.ts` speaks JSON-RPC over stdio, and
 *   `flux/install-mcp-on-new-machine.md` records how stray stdout lines corrupt
 *   that stream. Warnings go to stderr.
 * - **Never leave a repo mid-rebase.** The app auto-commits, so a half-finished
 *   rebase would silently compound into a real mess on the next save.
 */
export function makeSync(kbDir: string, options: SyncOptions = {}): Sync {
  const debounceMs = options.debounceMs ?? 5_000;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const log =
    options.log ?? ((message: string) => void process.stderr.write(`[kb-sync] ${message}\n`));

  /** Debounce timers keyed by repo root; a repo appears at most once. */
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Pushes run one at a time on this chain. Serializing them keeps two repos —
   * or a timer firing while `flush` runs — from contending on git's index.lock.
   */
  let running: Promise<unknown> = Promise.resolve();
  let ticker: ReturnType<typeof setInterval> | null = null;

  /**
   * Run git without any chance of blocking on input. `GIT_TERMINAL_PROMPT=0` and
   * ssh's `BatchMode` turn a missing credential into an immediate failure instead
   * of a password prompt that would hang the server; `timeout` covers the case
   * where the network accepts the connection and then stalls.
   */
  function runGit(repoRoot: string, args: string[]) {
    return execFileAsync("git", args, {
      cwd: repoRoot,
      timeout: timeoutMs,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
      },
    });
  }

  /** True when `repoRoot` is a git repo with at least one remote configured. */
  async function hasRemote(repoRoot: string): Promise<boolean> {
    try {
      const { stdout } = await runGit(repoRoot, ["remote"]);
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  /** Space repos under the KB root that are worth syncing (have a remote). */
  async function syncableRepos(): Promise<string[]> {
    let entries;
    try {
      entries = await fs.readdir(kbDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const roots: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const repoRoot = path.join(kbDir, entry.name);
      if (await hasRemote(repoRoot)) roots.push(repoRoot);
    }
    return roots;
  }

  /**
   * Abort a rebase if one is in progress. `--autostash` work is restored by git
   * as part of the abort, so the tree lands back exactly where it started.
   * Failure here means there was no rebase to abort, which is the normal case.
   */
  async function abortRebase(repoRoot: string): Promise<void> {
    try {
      await runGit(repoRoot, ["rebase", "--abort"]);
    } catch {
      /* no rebase in progress */
    }
  }

  /**
   * Rebase local commits onto the remote. On conflict the rebase is abandoned
   * rather than half-applied: the local commits survive untouched and the
   * divergence is left for a human, which is the only safe call for an app that
   * keeps committing underneath itself.
   */
  async function pullRepo(repoRoot: string): Promise<boolean> {
    try {
      await runGit(repoRoot, ["pull", "--rebase", "--autostash"]);
      return true;
    } catch (error) {
      await abortRebase(repoRoot);
      log(`pull failed for ${path.basename(repoRoot)} — ${message(error)}`);
      return false;
    }
  }

  /**
   * Push, and on rejection assume the other machine got there first: rebase onto
   * the remote and retry exactly once. Anything still failing is left for the
   * next commit rather than retried in a loop.
   *
   * The first rejection is reported only once the retry is off the table, since
   * on the common "other machine got there first" path it is not a failure at
   * all. Reporting it then matters: a rejection the rebase cannot fix says why
   * the push lost, where the rebase's own error only says what happened next.
   */
  async function pushRepo(repoRoot: string): Promise<boolean> {
    try {
      await runGit(repoRoot, ["push"]);
      return true;
    } catch (rejected) {
      if (!(await pullRepo(repoRoot))) {
        log(`push failed for ${path.basename(repoRoot)} — ${message(rejected)}`);
        return false;
      }
      try {
        await runGit(repoRoot, ["push"]);
        return true;
      } catch (error) {
        log(`push failed for ${path.basename(repoRoot)} — ${message(error)}`);
        return false;
      }
    }
  }

  /**
   * Append a push to the serial chain, swallowing failures. Remote-less repos
   * are dropped here rather than in {@link notifyCommit}, which is synchronous:
   * they are perfectly normal — a space that lives on one machine — and pushing
   * them would only produce noise about a destination that was never meant to
   * exist. Mirrors the same filter {@link syncableRepos} applies to pulls.
   */
  function queuePush(repoRoot: string): void {
    running = running
      .then(async () => {
        if (await hasRemote(repoRoot)) await pushRepo(repoRoot);
      })
      .catch(() => {});
  }

  async function pullAll(): Promise<void> {
    for (const repoRoot of await syncableRepos()) {
      await pullRepo(repoRoot);
    }
  }

  function notifyCommit(repoRoot: string): void {
    const existing = pending.get(repoRoot);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      pending.delete(repoRoot);
      queuePush(repoRoot);
    }, debounceMs);
    // Never hold the process open: an MCP client can disconnect with a push still
    // pending, and that must not keep its stdio process alive.
    timer.unref?.();
    pending.set(repoRoot, timer);
  }

  async function flush(): Promise<void> {
    for (const [repoRoot, timer] of [...pending]) {
      clearTimeout(timer);
      queuePush(repoRoot);
    }
    pending.clear();
    // A queued push can append to the chain while we await it, so settle until
    // the chain stops moving.
    let seen: Promise<unknown>;
    do {
      seen = running;
      await seen.catch(() => {});
    } while (seen !== running);
  }

  function startPeriodicPull(intervalMs: number): void {
    if (intervalMs <= 0) return;
    ticker = setInterval(() => void pullAll(), intervalMs);
    ticker.unref?.();
  }

  function stop(): void {
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();
    if (ticker) clearInterval(ticker);
    ticker = null;
  }

  return { pullAll, notifyCommit, flush, startPeriodicPull, stop };
}

/** Best-effort one-line description of a failed git invocation. */
function message(error: unknown): string {
  if (error && typeof error === "object" && "stderr" in error) {
    const stderr = String((error as { stderr: unknown }).stderr).trim();
    if (stderr) return stderr.split("\n")[0] ?? stderr;
  }
  return error instanceof Error ? error.message.split("\n")[0] ?? "" : String(error);
}

/** Truthy spellings accepted for an on/off env switch such as `KB_SYNC`. */
export function envFlag(name: string): boolean {
  return /^(1|true|yes|on)$/i.test(process.env[name]?.trim() ?? "");
}

/** A positive integer env var, or `fallback` when unset or unparseable. */
export function envNumber(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Build a {@link Sync} from the environment, or `null` when `KB_SYNC` is unset.
 * Off by default, so the sync layer changes nothing until it is opted into —
 * shared by the web server and the MCP server, which both write to the KB.
 */
export function syncFromEnv(kbDir: string): Sync | null {
  if (!envFlag("KB_SYNC")) return null;
  return makeSync(kbDir, {
    debounceMs: envNumber("KB_SYNC_DEBOUNCE_MS", 5_000),
    timeoutMs: envNumber("KB_SYNC_TIMEOUT_MS", 20_000),
  });
}
