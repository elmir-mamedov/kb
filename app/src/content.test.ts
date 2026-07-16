import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Content, downloadFilename } from "./content.js";
import { makeGit } from "./git.js";
import { makeTempKb, pathExists, type TempKb } from "./test-helpers.js";

test("issue #3: downloadFilename uses the slug leaf plus .md", () => {
  assert.equal(downloadFilename("flux/backlog/issues"), "issues.md");
  assert.equal(downloadFilename("flux"), "flux.md");
  assert.equal(downloadFilename("/flux/notes/"), "notes.md");
  assert.equal(downloadFilename(""), "page.md");
});

/** Create a bare space folder (index.md only) for content-layer tests. */
async function seedSpace(content: Content, slug: string): Promise<void> {
  await content.createSpace(slug);
}

test("issue #4: createFolder makes a pure container (type: folder, empty body)", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = new Content(kb.dir);
    await seedSpace(content, "Docs");

    const mutation = await content.createFolder("docs", "Runbooks");
    assert.equal(mutation.slug, "docs/runbooks");
    assert.equal(mutation.fsPath, path.join(kb.dir, "docs", "runbooks", "index.md"));
    assert.equal(await pathExists(mutation.fsPath), true);

    const raw = await fs.readFile(mutation.fsPath, "utf8");
    assert.match(raw, /title: Runbooks/);
    assert.match(raw, /type: folder/);
    // A folder has no body — there is nothing to write into it.
    assert.doesNotMatch(raw, /# Runbooks/);

    // It shows up in the tree as both a folder and (structurally) a section.
    const tree = await content.spaceTree("docs");
    const folder = tree.find((n) => n.slug === "docs/runbooks");
    assert.ok(folder, "the new folder should appear in the space tree");
    assert.equal(folder!.isFolder, true);
    assert.equal(folder!.isSection, true, "a folder is always structurally a section");
  } finally {
    await kb.cleanup();
  }
});

test("a content page with children is a section but NOT a folder", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = new Content(kb.dir);
    await seedSpace(content, "Docs");
    // Promote a leaf into a section by adding a child page under it.
    await content.createPage("docs", "Guide", "# Guide\n\nBody.\n");
    await content.createPage("docs/guide", "Intro", "# Intro\n");

    const tree = await content.spaceTree("docs");
    const guide = tree.find((n) => n.slug === "docs/guide");
    assert.ok(guide);
    assert.equal(guide!.isSection, true);
    assert.equal(guide!.isFolder, false, "an ordinary content section is not a folder");
  } finally {
    await kb.cleanup();
  }
});

test("updateRaw rejects a folder — even when the incoming raw omits the marker", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = new Content(kb.dir);
    await seedSpace(content, "Docs");
    const folder = await content.createFolder("docs", "Runbooks");

    // Full folder markdown.
    await assert.rejects(
      () => content.updateRaw(folder.slug, "---\ntitle: Runbooks\ntype: folder\n---\n# Sneaky body\n"),
      /Folders have no editable body/
    );
    // Stripping `type: folder` from the payload must not bypass the guard —
    // folder-ness is read from disk, not from the submitted content.
    await assert.rejects(
      () => content.updateRaw(folder.slug, "---\ntitle: Runbooks\n---\n# Sneaky body\n"),
      /Folders have no editable body/
    );

    // A normal page still updates fine (regression).
    const page = await content.createPage("docs", "Note", "# Note\n");
    const saved = await content.updateRaw(page.slug, "---\ntitle: Note\n---\n# Note\n\nEdited.\n");
    assert.ok(saved);
    assert.match(saved!.raw, /Edited\./);
  } finally {
    await kb.cleanup();
  }
});

test("renameFolder changes the display name but keeps the slug stable", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = new Content(kb.dir);
    await seedSpace(content, "Docs");
    const folder = await content.createFolder("docs", "Runbooks");

    const renamed = await content.renameFolder(folder.slug, "Playbooks");
    assert.ok(renamed);
    assert.equal(renamed!.slug, "docs/runbooks", "the slug/URL must not move on rename");
    assert.deepEqual(renamed!.changedFsPaths, [folder.fsPath]);

    const raw = await fs.readFile(folder.fsPath, "utf8");
    assert.match(raw, /title: Playbooks/);
    assert.match(raw, /type: folder/);
    // Still resolvable at the same slug, now with the new display name.
    const node = (await content.spaceTree("docs")).find((n) => n.slug === "docs/runbooks");
    assert.equal(node!.title, "Playbooks");

    // Renaming to the same name is a no-op (no spurious commit).
    const noop = await content.renameFolder(folder.slug, "Playbooks");
    assert.deepEqual(noop!.changedFsPaths, []);

    // Guards: empty name and non-folder targets are rejected.
    await assert.rejects(() => content.renameFolder(folder.slug, "   "), /name is required/);
    const page = await content.createPage("docs", "Note", "# Note\n");
    await assert.rejects(() => content.renameFolder(page.slug, "X"), /Only folders/);
  } finally {
    await kb.cleanup();
  }
});

test("issue #4: createFolder without a title creates auto-numbered drafts", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = new Content(kb.dir);
    await seedSpace(content, "Docs");

    const first = await content.createFolder("docs");
    assert.equal(first.slug, "docs/untitled-folder");
    const second = await content.createFolder("docs");
    assert.equal(second.slug, "docs/untitled-folder-2");
  } finally {
    await kb.cleanup();
  }
});

test("issue #4: creating a folder under a leaf page promotes it to a section", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = new Content(kb.dir);
    await seedSpace(content, "Docs");
    const leaf = await content.createPage("docs", "Guide", "# Guide\n");
    assert.equal(leaf.slug, "docs/guide");

    const folder = await content.createFolder("docs/guide", "Chapter One");
    assert.equal(folder.slug, "docs/guide/chapter-one");
    // The leaf guide.md was promoted to guide/index.md; the commit must cover both.
    assert.ok(folder.changedFsPaths, "promotion should report changed paths");
    assert.equal(await pathExists(path.join(kb.dir, "docs", "guide", "index.md")), true);
    assert.equal(await pathExists(path.join(kb.dir, "docs", "guide.md")), false);
    assert.equal(
      await pathExists(path.join(kb.dir, "docs", "guide", "chapter-one", "index.md")),
      true
    );
  } finally {
    await kb.cleanup();
  }
});

test("issue #4: pages can be moved into a folder (drop pages into folders)", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = new Content(kb.dir);
    await seedSpace(content, "Docs");
    await content.createFolder("docs", "Archive Box");
    const note = await content.createPage("docs", "Loose Note", "# Loose Note\n");

    const moved = await content.movePage(note.slug, "docs/archive-box");
    assert.ok(moved);
    assert.equal(moved!.newSlug, "docs/archive-box/loose-note");
    assert.equal(
      await pathExists(path.join(kb.dir, "docs", "archive-box", "loose-note.md")),
      true
    );
  } finally {
    await kb.cleanup();
  }
});

test("movePages: moves several pages into a folder in one pass", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = new Content(kb.dir);
    await seedSpace(content, "Docs");
    await content.createFolder("docs", "Archive Box");
    const a = await content.createPage("docs", "Note A", "# Note A\n");
    const b = await content.createPage("docs", "Note B", "# Note B\n");

    const result = await content.movePages([a.slug, b.slug], "docs/archive-box");
    assert.equal(result.failures.length, 0);
    assert.equal(result.moves.length, 2);
    assert.deepEqual(
      result.moves.map((m) => m.newSlug).sort(),
      ["docs/archive-box/note-a", "docs/archive-box/note-b"]
    );
    assert.equal(
      await pathExists(path.join(kb.dir, "docs", "archive-box", "note-a.md")),
      true
    );
    assert.equal(
      await pathExists(path.join(kb.dir, "docs", "archive-box", "note-b.md")),
      true
    );
    assert.ok(result.changedFsPaths.length > 0);
  } finally {
    await kb.cleanup();
  }
});

test("movePages: a selected parent carries its child; the child is not re-moved", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = new Content(kb.dir);
    await seedSpace(content, "Docs");
    await content.createFolder("docs", "Dest");
    const parent = await content.createFolder("docs", "Bundle");
    const child = await content.createPage("docs/bundle", "Inner", "# Inner\n");

    // Selecting both the folder and its child must move only the folder — the
    // child is a descendant and rides along with the rename.
    const result = await content.movePages([parent.slug, child.slug], "docs/dest");
    assert.equal(result.moves.length, 1);
    assert.equal(result.moves[0].newSlug, "docs/dest/bundle");
    assert.equal(result.failures.length, 0);
    assert.equal(
      await pathExists(path.join(kb.dir, "docs", "dest", "bundle", "inner.md")),
      true
    );
    assert.equal(await pathExists(path.join(kb.dir, "docs", "bundle")), false);
  } finally {
    await kb.cleanup();
  }
});

test("movePages: same-named pages moved into one folder auto-suffix", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = new Content(kb.dir);
    await seedSpace(content, "Docs");
    await content.createFolder("docs", "Dest");
    await content.createFolder("docs", "A");
    await content.createFolder("docs", "B");
    const a = await content.createPage("docs/a", "Notes", "# A\n");
    const b = await content.createPage("docs/b", "Notes", "# B\n");

    const result = await content.movePages([a.slug, b.slug], "docs/dest");
    assert.equal(result.moves.length, 2);
    assert.deepEqual(
      result.moves.map((m) => m.newSlug).sort(),
      ["docs/dest/notes", "docs/dest/notes-2"]
    );
    assert.equal(await pathExists(path.join(kb.dir, "docs", "dest", "notes.md")), true);
    assert.equal(await pathExists(path.join(kb.dir, "docs", "dest", "notes-2.md")), true);
  } finally {
    await kb.cleanup();
  }
});

test("movePages: a bad source is reported as a failure without blocking the rest", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = new Content(kb.dir);
    await seedSpace(content, "Docs");
    await content.createFolder("docs", "Dest");
    const good = await content.createPage("docs", "Keeper", "# Keeper\n");

    const result = await content.movePages([good.slug, "docs/does-not-exist"], "docs/dest");
    assert.equal(result.moves.length, 1);
    assert.equal(result.moves[0].newSlug, "docs/dest/keeper");
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].slug, "docs/does-not-exist");
    assert.match(result.failures[0].error, /not found/i);
  } finally {
    await kb.cleanup();
  }
});

test("TODO #1: renameSpace edits the display name but keeps the key/URL", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = new Content(kb.dir);
    const space = await content.createSpace("Docs");
    assert.equal(space.slug, "docs");

    const renamed = await content.renameSpace("docs", "Documentation");
    assert.ok(renamed);
    assert.equal(renamed!.key, "docs", "the space key/URL must not change on rename");
    assert.deepEqual(renamed!.changedFsPaths, [space.fsPath]);

    const raw = await fs.readFile(space.fsPath, "utf8");
    assert.match(raw, /title: Documentation/);
    // Still resolvable at the same key, now with the new display name.
    const spaces = await content.spaces();
    assert.equal(spaces.find((s) => s.key === "docs")!.title, "Documentation");

    // Renaming to the same name is a no-op (no spurious commit).
    const noop = await content.renameSpace("docs", "Documentation");
    assert.deepEqual(noop!.changedFsPaths, []);

    // Guards: empty name, nested slugs, and unknown spaces.
    await assert.rejects(() => content.renameSpace("docs", "   "), /name is required/);
    await assert.rejects(() => content.renameSpace("docs/child", "X"), /top-level space/);
    assert.equal(await content.renameSpace("ghost", "X"), null);
  } finally {
    await kb.cleanup();
  }
});

test("TODO #1: deleteSpace removes the whole space directory, git repo included", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = new Content(kb.dir);
    await content.createSpace("Docs");
    await content.createPage("docs", "Note", "# Note\n");
    // Give it a real per-space git repo, like the running app does.
    const g = makeGit(kb.dir);
    await g.initSpaceRepo("docs");
    const dir = path.join(kb.dir, "docs");
    assert.equal(await pathExists(path.join(dir, ".git")), true);

    const mutation = await content.deleteSpace("docs");
    assert.ok(mutation);
    assert.equal(mutation!.key, "docs");
    assert.equal(mutation!.title, "Docs");
    assert.equal(mutation!.dir, dir);
    // The entire directory is gone — no orphaned .git / _assets left behind.
    assert.equal(await pathExists(dir), false);
    assert.deepEqual(await content.spaces(), []);

    // Guards: nested slugs / underscore helpers are rejected; unknown → null.
    await assert.rejects(() => content.deleteSpace("a/b"), /top-level space/);
    await assert.rejects(() => content.deleteSpace("_assets"), /top-level space/);
    assert.equal(await content.deleteSpace("ghost"), null);
  } finally {
    await kb.cleanup();
  }
});

test("issue #4: createFolder rejects a missing parent space", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = new Content(kb.dir);
    await assert.rejects(() => content.createFolder("", "Orphan"), /must live inside a space/);
    await assert.rejects(
      () => content.createFolder("nope", "Orphan"),
      /does not exist/
    );
  } finally {
    await kb.cleanup();
  }
});

test("issue #3: create writes a stable id, surfaced on the tree node and idIndex", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = new Content(kb.dir);
    await seedSpace(content, "Docs");

    const created = await content.createPage("docs", "Deploy", "# Deploy\n");
    assert.match(created.id, /^[a-z0-9]{13}$/);
    const raw = await fs.readFile(created.fsPath, "utf8");
    assert.ok(raw.includes(`id: ${created.id}`), "id is persisted to frontmatter");

    const node = (await content.spaceTree("docs")).find((n) => n.slug === "docs/deploy");
    assert.equal(node?.id, created.id);

    const ids = await content.idIndex();
    assert.equal(ids.get(created.id), "docs/deploy");
  } finally {
    await kb.cleanup();
  }
});

test("issue #3: a page keeps its id after being moved, so an [[id:…]] link stays valid", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = new Content(kb.dir);
    await seedSpace(content, "Docs");
    await content.createPage("docs", "Section", "# Section\n"); // destination parent
    const created = await content.createPage("docs", "Target", "# Target\n");

    const moved = await content.movePage("docs/target", "docs/section");
    assert.ok(moved);
    assert.equal(moved!.oldSlug, "docs/target");
    assert.equal(moved!.newSlug, "docs/section/target");

    // Same id, now resolving to the new location; frontmatter is untouched.
    const ids = await content.idIndex();
    assert.equal(ids.get(created.id), "docs/section/target");
    const movedPage = await content.load("docs/section/target");
    assert.equal(movedPage?.data.id, created.id);
  } finally {
    await kb.cleanup();
  }
});

test("issue #3: moving a page rewrites inbound links (bare, full-slug, absolute) and leaves id links", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = new Content(kb.dir);
    await seedSpace(content, "Docs");
    await content.createPage("docs", "Guide", "# Guide\n"); // becomes a section
    const target = await content.createPage("docs/guide", "Target", "# Target\n");
    // A sibling links by bare name; a cousin links by full slug, absolute URL, and id.
    await content.createPage("docs/guide", "Sibling", "See [[target]].\n");
    await content.createPage(
      "docs",
      "Cousin",
      `Full [[docs/guide/target]]. Abs [x](/docs/guide/target). Id [[id:${target.id}|t]].\n`
    );
    await content.createPage("docs", "Dest", "# Dest\n"); // move destination

    const moved = await content.movePage("docs/guide/target", "docs/dest");
    assert.equal(moved!.newSlug, "docs/dest/target");

    // The bare link no longer resolves by ancestor-walk, so it is pinned to the
    // new absolute slug.
    const sibling = await content.loadRaw("docs/guide/sibling");
    assert.match(sibling!.raw, /\[\[docs\/dest\/target\]\]/);

    const cousin = await content.loadRaw("docs/cousin");
    assert.match(cousin!.raw, /\[\[docs\/dest\/target\]\]/); // full-slug wiki-link
    assert.match(cousin!.raw, /\(\/docs\/dest\/target\)/); // absolute Markdown link
    assert.match(cousin!.raw, new RegExp(`\\[\\[id:${target.id}\\|t\\]\\]`)); // id link untouched
  } finally {
    await kb.cleanup();
  }
});

test("issue #3: moving a section rewrites links to its descendants too", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = new Content(kb.dir);
    await seedSpace(content, "Docs");
    await content.createPage("docs", "Area", "# Area\n");
    await content.createPage("docs/area", "Deep", "# Deep\n"); // descendant
    await content.createPage(
      "docs",
      "Ref",
      "Link [[docs/area/deep]] and [x](/docs/area/deep).\n"
    );
    await content.createPage("docs", "Dest", "# Dest\n");

    const moved = await content.movePage("docs/area", "docs/dest");
    assert.equal(moved!.newSlug, "docs/dest/area");

    const ref = await content.loadRaw("docs/ref");
    assert.match(ref!.raw, /\[\[docs\/dest\/area\/deep\]\]/);
    assert.match(ref!.raw, /\(\/docs\/dest\/area\/deep\)/);
  } finally {
    await kb.cleanup();
  }
});

test("issue #3: folders and spaces also get a stable id", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = new Content(kb.dir);
    const space = await content.createSpace("Docs");
    const folder = await content.createFolder("docs", "Runbooks");
    assert.ok(space.id);
    assert.ok(folder.id);

    const ids = await content.idIndex();
    assert.equal(ids.get(space.id), "docs");
    assert.equal(ids.get(folder.id), "docs/runbooks");
  } finally {
    await kb.cleanup();
  }
});
