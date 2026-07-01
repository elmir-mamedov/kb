import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Content, downloadFilename } from "./content.js";
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
