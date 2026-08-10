import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Content } from "./content.js";
import { makeGit } from "./git.js";
import { makeSync } from "./sync.js";
import { makeTempKb, git, pathExists, type TempKb } from "./test-helpers.js";

/**
 * A bare repo in a temp dir stands in for GitHub, so the whole suite runs
 * offline and fast. `elsewhere` plays the second machine: a separate clone of
 * the same bare repo. Both live outside the KB root, or `makeSync` would walk
 * into them looking for spaces.
 */
async function seedSpaceWithRemote(kb: TempKb, elsewhere: TempKb, title: string) {
  const content = new Content(kb.dir);
  const mutation = await content.createSpace(title);
  const slug = mutation.slug;

  const g = makeGit(kb.dir);
  await g.initSpaceRepo(slug);
  await g.commitFiles(mutation.changedFsPaths ?? [mutation.fsPath], "Create space via test");

  const bare = path.join(elsewhere.dir, `${slug}.git`);
  await fs.mkdir(bare, { recursive: true });
  await git(bare, "init", "--bare", "-b", "main");

  const repo = path.join(kb.dir, slug);
  await git(repo, "remote", "add", "origin", bare);
  await git(repo, "push", "-u", "origin", "main");

  return { content, slug, repo, bare };
}

/** Clone the bare repo a second time — the "other machine". */
async function cloneElsewhere(elsewhere: TempKb, bare: string, name: string): Promise<string> {
  await git(elsewhere.dir, "clone", bare, name);
  return path.join(elsewhere.dir, name);
}

/** Quiet sync with a debounce long enough that only an explicit flush pushes. */
function quietSync(kbDir: string) {
  return makeSync(kbDir, { debounceMs: 60_000, log: () => {} });
}

test("a commit is pushed to the remote once flushed", async () => {
  const kb = await makeTempKb();
  const elsewhere = await makeTempKb();
  try {
    const { content, slug, bare } = await seedSpaceWithRemote(kb, elsewhere, "Engineering");
    const sync = quietSync(kb.dir);
    const g = makeGit(kb.dir, (repoRoot) => sync.notifyCommit(repoRoot));

    const created = await content.createPage(slug, "Deploy Runbook", "# Deploy\n");
    await g.commitFiles([created.fsPath], "Create deploy page via test");

    await sync.flush();
    sync.stop();

    const remoteLog = await git(bare, "log", "--oneline");
    assert.match(remoteLog, /Create deploy page via test/);
  } finally {
    await kb.cleanup();
    await elsewhere.cleanup();
  }
});

test("a burst of commits coalesces into a single push", async () => {
  const kb = await makeTempKb();
  const elsewhere = await makeTempKb();
  try {
    const { content, slug, bare } = await seedSpaceWithRemote(kb, elsewhere, "Engineering");
    const sync = quietSync(kb.dir);
    const g = makeGit(kb.dir, (repoRoot) => sync.notifyCommit(repoRoot));

    for (const title of ["One", "Two", "Three"]) {
      const created = await content.createPage(slug, title, `# ${title}\n`);
      await g.commitFiles([created.fsPath], `Create ${title} via test`);
    }

    // Nothing has left yet: each commit re-armed the debounce rather than pushing.
    const beforeFlush = await git(bare, "log", "--oneline");
    assert.doesNotMatch(beforeFlush, /Create (One|Two|Three) via test/);

    await sync.flush();
    sync.stop();

    // One push carried all three commits.
    const afterFlush = await git(bare, "log", "--oneline");
    for (const title of ["One", "Two", "Three"]) {
      assert.match(afterFlush, new RegExp(`Create ${title} via test`));
    }
  } finally {
    await kb.cleanup();
    await elsewhere.cleanup();
  }
});

test("pullAll brings in what the other machine pushed", async () => {
  const kb = await makeTempKb();
  const elsewhere = await makeTempKb();
  try {
    const { slug, repo, bare } = await seedSpaceWithRemote(kb, elsewhere, "Engineering");

    const other = await cloneElsewhere(elsewhere, bare, "machine-b");
    await fs.writeFile(path.join(other, "from-b.md"), "# Written on machine B\n");
    await git(other, "add", "-A");
    await git(other, "commit", "-m", "Add page on machine B");
    await git(other, "push");

    const sync = quietSync(kb.dir);
    await sync.pullAll();
    sync.stop();

    assert.ok(
      await pathExists(path.join(repo, "from-b.md")),
      "expected machine B's page to arrive in the local space repo"
    );
    assert.equal(slug, path.basename(repo));
  } finally {
    await kb.cleanup();
    await elsewhere.cleanup();
  }
});

test("a conflicting pull aborts cleanly instead of leaving a half-rebase", async () => {
  const kb = await makeTempKb();
  const elsewhere = await makeTempKb();
  try {
    const { repo, bare } = await seedSpaceWithRemote(kb, elsewhere, "Engineering");

    // Machine B rewrites index.md and publishes it.
    const other = await cloneElsewhere(elsewhere, bare, "machine-b");
    await fs.writeFile(path.join(other, "index.md"), "# Machine B version\n");
    await git(other, "add", "-A");
    await git(other, "commit", "-m", "Rewrite index on machine B");
    await git(other, "push");

    // Machine A rewrites the same lines locally, without having pulled.
    await fs.writeFile(path.join(repo, "index.md"), "# Machine A version\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-m", "Rewrite index on machine A");

    const sync = quietSync(kb.dir);
    await sync.pullAll();
    sync.stop();

    // The repo must be usable: no rebase in progress, nothing half-staged.
    assert.ok(
      !(await pathExists(path.join(repo, ".git", "rebase-merge"))),
      "expected no rebase-merge state left behind"
    );
    assert.ok(
      !(await pathExists(path.join(repo, ".git", "rebase-apply"))),
      "expected no rebase-apply state left behind"
    );
    assert.equal(await git(repo, "status", "--porcelain"), "");

    // The local commit survives the abort — nothing is silently discarded.
    const localLog = await git(repo, "log", "--oneline");
    assert.match(localLog, /Rewrite index on machine A/);
    // And the rebase really was abandoned rather than quietly succeeding: machine
    // B's commit is still absent locally. Without this the test would also pass
    // on a clean rebase, since A's commit replays on top either way.
    assert.doesNotMatch(localLog, /Rewrite index on machine B/);
    assert.equal(
      await fs.readFile(path.join(repo, "index.md"), "utf8"),
      "# Machine A version\n"
    );
  } finally {
    await kb.cleanup();
    await elsewhere.cleanup();
  }
});

test("a space with no remote is skipped rather than failing", async () => {
  const kb = await makeTempKb();
  try {
    const content = new Content(kb.dir);
    const mutation = await content.createSpace("Solo");
    // Capture the log rather than muting it: silence is the point of this test.
    // A space that lives on one machine is a normal setup, not a broken one.
    const logged: string[] = [];
    const sync = makeSync(kb.dir, { debounceMs: 60_000, log: (m) => void logged.push(m) });
    const g = makeGit(kb.dir, (repoRoot) => sync.notifyCommit(repoRoot));
    await g.initSpaceRepo(mutation.slug);
    await g.commitFiles(mutation.changedFsPaths ?? [mutation.fsPath], "Create space via test");

    const created = await content.createPage(mutation.slug, "Note", "# Note\n");
    await g.commitFiles([created.fsPath], "Create note via test");

    // Neither call has anywhere to sync to; both must be quiet no-ops.
    await sync.pullAll();
    await sync.flush();
    sync.stop();

    const localLog = await git(path.join(kb.dir, mutation.slug), "log", "--oneline");
    assert.match(localLog, /Create note via test/);
    assert.deepEqual(logged, [], "expected a remote-less space to sync silently");
  } finally {
    await kb.cleanup();
  }
});

test("a push that the rebase cannot rescue reports the push error, not the rebase's", async () => {
  const kb = await makeTempKb();
  const elsewhere = await makeTempKb();
  try {
    const { content, slug, repo, bare } = await seedSpaceWithRemote(kb, elsewhere, "Engineering");

    // Machine B publishes a conflicting index.md, so the rebase behind the retry
    // is guaranteed to fail and leave the original rejection as the real story.
    const other = await cloneElsewhere(elsewhere, bare, "machine-b");
    await fs.writeFile(path.join(other, "index.md"), "# Machine B version\n");
    await git(other, "add", "-A");
    await git(other, "commit", "-m", "Rewrite index on machine B");
    await git(other, "push");

    await fs.writeFile(path.join(repo, "index.md"), "# Machine A version\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-m", "Rewrite index on machine A");

    const logged: string[] = [];
    const sync = makeSync(kb.dir, { debounceMs: 60_000, log: (m) => void logged.push(m) });
    const g = makeGit(kb.dir, (repoRoot) => sync.notifyCommit(repoRoot));

    const created = await content.createPage(slug, "Note", "# Note\n");
    await g.commitFiles([created.fsPath], "Create note via test");
    await sync.flush();
    sync.stop();

    assert.ok(
      logged.some((m) => m.startsWith("push failed for ")),
      `expected the push failure to be reported, got ${JSON.stringify(logged)}`
    );
  } finally {
    await kb.cleanup();
    await elsewhere.cleanup();
  }
});
