import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Content } from "./content.js";
import { makeGit } from "./git.js";
import { makeTempKb, git, isGitRepo, type TempKb } from "./test-helpers.js";

/** Create a space folder that is its own initialized git repo with one commit. */
async function seedSpace(kbDir: string, title: string) {
  const content = new Content(kbDir);
  const g = makeGit(kbDir);
  const mutation = await content.createSpace(title);
  await g.initSpaceRepo(mutation.slug);
  await g.commitFiles(
    mutation.changedFsPaths ?? [mutation.fsPath],
    `Create ${g.kbRelPath(mutation.fsPath)} via test`
  );
  return { content, g, slug: mutation.slug };
}

test("commitFiles commits a new page inside its space repo", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const { content, g, slug } = await seedSpace(kb.dir, "Engineering");
    const created = await content.createPage(slug, "Deploy Runbook", "# Deploy\n");
    const sha = await g.commitFiles([created.fsPath], "Create page via test");

    assert.ok(sha, "expected a commit sha");
    const log = await git(path.join(kb.dir, slug), "log", "--oneline");
    assert.match(log, /Create page via test/);
  } finally {
    await kb.cleanup();
  }
});

test("renaming a space does not fail the git commit (issue #2)", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const { content, g, slug } = await seedSpace(kb.dir, "My Space");
    assert.equal(slug, "my-space");

    // Reproduce the reported flow: rename the freshly created space, then run
    // the same commit the web/MCP layer runs after a rename.
    const renamed = await content.renamePage(slug, "renamed");
    assert.ok(renamed);
    assert.equal(renamed!.newSlug, "renamed");

    // Previously this threw "Refusing to commit a file outside its space repo."
    await assert.doesNotReject(
      () => g.commitMovedPaths(renamed!.changedFsPaths, `Rename ${renamed!.oldSlug} to ${renamed!.newSlug} via test`),
      "renaming a space must not fail the commit"
    );

    // The folder moved wholesale, carrying its .git with it: the new location is
    // still a valid repo and its history survives.
    assert.equal(await isGitRepo(path.join(kb.dir, "renamed")), true);
    assert.equal(await isGitRepo(path.join(kb.dir, "my-space")), false);
    const log = await git(path.join(kb.dir, "renamed"), "log", "--oneline");
    assert.match(log, /Create .*index\.md via test/);
  } finally {
    await kb.cleanup();
  }
});

test("renaming a space also commits an index.md content edit made in the same save", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const { content, g, slug } = await seedSpace(kb.dir, "My Space");

    // Mirror the web edit flow: content is saved first, then the slug changes.
    const edited = "---\ntitle: My Space\n---\n\n# My Space\n\nNow with a body.\n";
    await content.updateRaw(slug, edited);
    const renamed = await content.renamePage(slug, "renamed");
    assert.ok(renamed);

    const sha = await g.commitMovedPaths(
      renamed!.changedFsPaths,
      `Rename ${renamed!.oldSlug} to ${renamed!.newSlug} via test`
    );
    assert.ok(sha, "the index.md content edit should produce a commit");

    const repo = path.join(kb.dir, "renamed");
    const status = await git(repo, "status", "--porcelain");
    assert.equal(status, "", "working tree must be clean — the edit was committed");
    const head = await git(repo, "log", "-1", "--format=%s");
    assert.equal(head, "Rename my-space to renamed via test");
    const committed = await git(repo, "show", "HEAD:index.md");
    assert.match(committed, /Now with a body\./);
  } finally {
    await kb.cleanup();
  }
});

test("commitMovedPaths still commits real file moves alongside a space-root no-op", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const { content, g, slug } = await seedSpace(kb.dir, "Docs");
    // A normal in-space rename (leaf page) must keep working: the folder-root
    // skip only applies to paths that ARE a repo root.
    const created = await content.createPage(slug, "Notes", "# Notes\n");
    await g.commitFiles([created.fsPath], "Create notes via test");

    const renamed = await content.renamePage(created.slug, "meeting-notes");
    assert.ok(renamed);
    const sha = await g.commitMovedPaths(
      renamed!.changedFsPaths,
      `Rename ${renamed!.oldSlug} to ${renamed!.newSlug} via test`
    );
    assert.ok(sha, "a real file rename should still produce a commit");

    assert.equal(await fs.readFile(path.join(kb.dir, slug, "meeting-notes.md"), "utf8").then(() => true), true);
    const status = await git(path.join(kb.dir, slug), "status", "--porcelain");
    assert.equal(status, "", "working tree should be clean after committing the rename");
  } finally {
    await kb.cleanup();
  }
});
