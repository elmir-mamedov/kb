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

test("issue #3: a table link written with an escaped pipe follows the move too", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = new Content(kb.dir);
    await seedSpace(content, "Docs");
    await content.createPage("docs", "Area", "# Area\n");
    await content.createPage("docs/area", "Deep", "# Deep\n");
    // `\|` is how a wiki-link's label survives a table cell, so the rewriter has
    // to read the target as ending at the backslash, not include it.
    await content.createPage(
      "docs",
      "Ref",
      "| A | B |\n| --- | --- |\n| x | [[docs/area/deep\\|the page]] |\n"
    );
    await content.createPage("docs", "Dest", "# Dest\n");

    await content.movePage("docs/area", "docs/dest");

    const ref = await content.loadRaw("docs/ref");
    assert.match(ref!.raw, /\[\[docs\/dest\/area\/deep\\\|the page\]\]/);
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

/** Sidebar order of a group, by slug leaf. */
async function orderOf(content: Content, parentSlug: string): Promise<string[]> {
  const tree = await content.tree("live");
  const parts = parentSlug.split("/");
  let nodes = tree;
  let found: (typeof tree)[number] | undefined;
  for (const _ of parts) {
    found = nodes.find((n) => parentSlug === n.slug || parentSlug.startsWith(`${n.slug}/`));
    if (!found) return [];
    nodes = found.children;
  }
  return nodes.map((n) => n.slug.split("/").at(-1)!);
}

test("issue #2: reorderPages arranges siblings, and the tree renders that order", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = new Content(kb.dir);
    await seedSpace(content, "Docs");
    // Each new page opens at the top, so creating them in this order lists them
    // backwards.
    for (const title of ["Alpha", "Beta", "Gamma"]) {
      await content.createPage("docs", title, `# ${title}\n`);
    }
    assert.deepEqual(await orderOf(content, "docs"), ["gamma", "beta", "alpha"]);

    // Drag gamma down onto the line above alpha: [beta, gamma, alpha].
    const result = await content.reorderPages(["docs/gamma"], "docs", "docs/alpha");
    assert.deepEqual(result.orderedSlugs, ["docs/beta", "docs/gamma", "docs/alpha"]);
    assert.equal(result.moves.length, 0, "a same-parent reorder moves no files");
    assert.deepEqual(await orderOf(content, "docs"), ["beta", "gamma", "alpha"]);

    // The arrangement is on disk, 1-based, and survives a fresh read.
    const beta = await content.loadRaw("docs/beta");
    assert.match(beta!.raw, /^order: 1$/m);
    assert.deepEqual(await orderOf(new Content(kb.dir), "docs"), ["beta", "gamma", "alpha"]);

    // An empty anchor appends: beta goes last.
    await content.reorderPages(["docs/beta"], "docs", "");
    assert.deepEqual(await orderOf(content, "docs"), ["gamma", "alpha", "beta"]);
  } finally {
    await kb.cleanup();
  }
});

test("issue #2: a drop on a top-level line lifts a child page out to the space root", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = new Content(kb.dir);
    await seedSpace(content, "Docs");
    await content.createPage("docs", "Area", "# Area\n");
    await content.createPage("docs", "Notes", "# Notes\n");
    await content.createPage("docs/area", "Deep", "# Deep\n");
    // Notes opened above Area and stays there: the page added inside Area is
    // first among *its* children and does not lift Area over its own sibling.
    assert.deepEqual(await orderOf(content, "docs"), ["notes", "area"]);

    // Drop docs/area/deep on the line above docs/notes at the top level.
    const result = await content.reorderPages(["docs/area/deep"], "docs", "docs/notes");
    assert.deepEqual(
      result.moves.map((m) => [m.oldSlug, m.newSlug]),
      [["docs/area/deep", "docs/deep"]],
      "leaving its parent is a real move, reported so the client can follow it"
    );
    assert.deepEqual(result.placedSlugs, ["docs/deep"], "positioned by its post-move slug");
    // It lands at the requested spot — directly above notes — and the group is
    // renumbered around it, so area keeps the position it already had.
    assert.deepEqual(await orderOf(content, "docs"), ["deep", "notes", "area"]);
    assert.equal(await pathExists(path.join(kb.dir, "docs", "deep.md")), true);
  } finally {
    await kb.cleanup();
  }
});

test("issue #2: reorderPages keeps a multi-page drop in the order it was given", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = new Content(kb.dir);
    await seedSpace(content, "Docs");
    for (const title of ["One", "Two", "Three", "Four"]) {
      await content.createPage("docs", title, `# ${title}\n`);
    }

    await content.reorderPages(["docs/two", "docs/four"], "docs", "docs/one");
    const order = await orderOf(content, "docs");
    assert.deepEqual(order.slice(order.indexOf("two")), ["two", "four", "one"]);
  } finally {
    await kb.cleanup();
  }
});

test("issue #2: a new page opens on top of an arranged group without reshuffling it", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = new Content(kb.dir);
    await seedSpace(content, "Docs");
    for (const title of ["Alpha", "Beta"]) {
      await content.createPage("docs", title, `# ${title}\n`);
    }
    await content.reorderPages(["docs/alpha"], "docs", "docs/beta");
    assert.deepEqual(await orderOf(content, "docs"), ["alpha", "beta"]);

    // A brand-new page is the one thing that claims the top of a level — the
    // arrangement below it keeps the shape the reader gave it.
    await content.createPage("docs", "Fresh", "# Fresh\n");
    assert.deepEqual(await orderOf(content, "docs"), ["fresh", "alpha", "beta"]);

    // It got there by being numbered below the group's lowest sibling (1), not by
    // being the most recently touched file.
    const fresh = await content.loadRaw("docs/fresh");
    assert.match(fresh!.raw, /^order: 0$/m);
  } finally {
    await kb.cleanup();
  }
});

test("issue #2: reorderPages refuses to drop a page inside itself", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = new Content(kb.dir);
    await seedSpace(content, "Docs");
    await content.createPage("docs", "Area", "# Area\n");
    await content.createPage("docs/area", "Deep", "# Deep\n");

    await assert.rejects(
      () => content.reorderPages(["docs/area"], "docs/area/deep", ""),
      /cannot be moved into itself/
    );
    await assert.rejects(() => content.reorderPages(["docs/area"], "", ""), /inside a space/);
    await assert.rejects(
      () => content.reorderPages(["docs/area"], "docs/nope", ""),
      /does not exist/
    );
  } finally {
    await kb.cleanup();
  }
});

test("issue #2: an archived sibling is numbered too, so restoring keeps its place", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = new Content(kb.dir);
    await seedSpace(content, "Docs");
    for (const title of ["Alpha", "Beta", "Gamma"]) {
      await content.createPage("docs", title, `# ${title}\n`);
    }
    await content.updateArchive("docs/beta", true);

    // Arranging the live pages numbers the hidden one along with them.
    const result = await content.reorderPages(["docs/alpha"], "docs", "docs/gamma");
    assert.ok(result.orderedSlugs.includes("docs/beta"), "the archived sibling is numbered too");

    const beta = await content.loadRaw("docs/beta");
    assert.match(beta!.raw, /^order: \d+$/m);
    // Invisible in the live sidebar, which shows the rest in the arranged order.
    assert.deepEqual(
      await orderOf(content, "docs"),
      result.orderedSlugs.filter((s) => s !== "docs/beta").map((s) => s.split("/").at(-1)),
    );

    // Restoring it puts it back in the slot it was numbered into.
    await content.updateArchive("docs/beta", false);
    assert.deepEqual(
      await orderOf(content, "docs"),
      result.orderedSlugs.map((s) => s.split("/").at(-1)),
    );
  } finally {
    await kb.cleanup();
  }
});

test("editing a page — body or note — leaves the sidebar exactly as it was", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = new Content(kb.dir);
    await seedSpace(content, "Docs");
    for (const title of ["Alpha", "Beta", "Gamma"]) {
      await content.createPage("docs", title, `# ${title}\n`);
    }
    await content.createPage("docs/alpha", "Deep", "# Deep\n");
    await content.createPage("docs/alpha", "Deeper", "# Deeper\n");

    const before = await orderOf(content, "docs");
    const beforeChildren = await orderOf(content, "docs/alpha");
    assert.deepEqual(before, ["gamma", "beta", "alpha"]);

    // Rewrite the page at the *bottom* of the group, the case that used to jump
    // it to the top: sibling order came from the file's mtime.
    const alpha = await content.loadRaw("docs/alpha");
    await content.updateRaw("docs/alpha", `${alpha!.raw}\nA second paragraph.\n`);

    // A note is written through updateRaw too (see /_notes), so leaving one on a
    // deep page is the same edit as far as the tree is concerned.
    const deep = await content.loadRaw("docs/alpha/deep");
    await content.updateRaw(
      "docs/alpha/deep",
      `${deep!.raw}\n<!-- flux:note id=n1 kind=task\n> Deep\n\nFix this.\n-->\n`
    );

    assert.deepEqual(await orderOf(content, "docs"), before);
    assert.deepEqual(await orderOf(content, "docs/alpha"), beforeChildren);
    // And it is the files that say so, not a warm cache in this instance.
    assert.deepEqual(await orderOf(new Content(kb.dir), "docs"), before);
  } finally {
    await kb.cleanup();
  }
});

test("a page created deep in a branch leaves every ancestor where it was", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = new Content(kb.dir);
    await seedSpace(content, "Docs");
    await content.createFolder("docs", "Area");
    await content.createFolder("docs/area", "Inner");
    await content.createPage("docs", "Notes", "# Notes\n");
    assert.deepEqual(await orderOf(content, "docs"), ["notes", "area"]);

    // The new page is first among its own siblings; area does not overtake notes
    // on the strength of activity underneath it.
    await content.createPage("docs/area/inner", "Fresh", "# Fresh\n");
    assert.deepEqual(await orderOf(content, "docs"), ["notes", "area"]);
    assert.deepEqual(await orderOf(content, "docs/area/inner"), ["fresh"]);
  } finally {
    await kb.cleanup();
  }
});

test("pages written without an order follow the placed ones, by title", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = new Content(kb.dir);
    await seedSpace(content, "Docs");
    // Pages that predate the create-time stamping, or that arrived from another
    // machine: written straight to disk with no order of their own.
    for (const [name, title] of [
      ["zulu", "Zulu"],
      ["alpha", "Alpha"],
      ["mike", "Mike"],
    ]) {
      await fs.writeFile(
        path.join(kb.dir, "docs", `${name}.md`),
        `---\ntitle: ${title}\n---\n# ${title}\n`,
        "utf8"
      );
    }
    assert.deepEqual(await orderOf(content, "docs"), ["alpha", "mike", "zulu"]);

    // Touching one changes nothing; a page that *is* placed goes above them all.
    const mike = await content.loadRaw("docs/mike");
    await content.updateRaw("docs/mike", `${mike!.raw}\nEdited.\n`);
    await content.createPage("docs", "Fresh", "# Fresh\n");
    assert.deepEqual(await orderOf(content, "docs"), ["fresh", "alpha", "mike", "zulu"]);
  } finally {
    await kb.cleanup();
  }
});

test("issue #2: a page dropped into another folder drops the order it was arranged with", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = new Content(kb.dir);
    await seedSpace(content, "Docs");
    await content.createFolder("docs", "Box");
    for (const title of ["Alpha", "Beta"]) {
      await content.createPage("docs/box", title, `# ${title}\n`);
    }
    await content.createPage("docs", "Wanderer", "# Wanderer\n");
    await content.reorderPages(["docs/wanderer"], "docs", "");
    assert.match((await content.loadRaw("docs/wanderer"))!.raw, /^order: \d+$/m);

    // Dropped onto box, its "second in that group" means nothing here, so it
    // arrives unplaced and joins the end rather than a spot it never asked for.
    await content.movePages(["docs/wanderer"], "docs/box");
    const moved = await content.loadRaw("docs/box/wanderer");
    assert.doesNotMatch(moved!.raw, /^order:/m);
    assert.deepEqual(await orderOf(content, "docs/box"), ["beta", "alpha", "wanderer"]);
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

// --- cross-space moves ------------------------------------------------------

test("movePage refuses to move a page between spaces", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = new Content(kb.dir);
    await seedSpace(content, "Docs");
    await seedSpace(content, "Notes");
    const page = await content.createPage("docs", "Deploy", "# Deploy\n");

    // Each space is its own git repo, so this would tear the page out of the
    // history that owns it.
    await assert.rejects(
      () => content.movePage(page.slug, "notes"),
      /cannot move between spaces/
    );

    // Nothing moved.
    assert.equal(await pathExists(page.fsPath), true);
    assert.equal(await content.resolve("notes/deploy"), null);
  } finally {
    await kb.cleanup();
  }
});

test("movePage still allows a move within one space", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = new Content(kb.dir);
    await seedSpace(content, "Docs");
    const home = await content.createPage("docs", "Runbooks", "# Runbooks\n");
    const page = await content.createPage("docs", "Deploy", "# Deploy\n");

    const moved = await content.movePage(page.slug, home.slug);
    assert.equal(moved?.oldSlug, "docs/deploy");
    assert.equal(moved?.newSlug, "docs/runbooks/deploy");
  } finally {
    await kb.cleanup();
  }
});

// --- id preservation on update ----------------------------------------------

test("updateRaw restores the on-disk id when the new source omits it", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = new Content(kb.dir);
    await seedSpace(content, "Docs");
    const page = await content.createPage("docs", "Deploy", "# Deploy\n");

    // What a caller that never read the page produces: valid frontmatter, no id.
    const mutation = await content.updateRaw(page.slug, "---\ntitle: Deploy\n---\n# Rewritten\n");
    assert.equal(mutation?.idPreserved, true);

    const reloaded = await content.load(page.slug);
    assert.equal(reloaded?.data.id, page.id, "the stable id must survive");
    assert.match(reloaded?.body ?? "", /# Rewritten/);
  } finally {
    await kb.cleanup();
  }
});

test("updateRaw refuses to let a caller change an existing id", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = new Content(kb.dir);
    await seedSpace(content, "Docs");
    const page = await content.createPage("docs", "Deploy", "# Deploy\n");

    const mutation = await content.updateRaw(
      page.slug,
      "---\ntitle: Deploy\nid: totallymadeup\n---\n# Rewritten\n"
    );
    assert.equal(mutation?.idPreserved, true);
    assert.equal((await content.load(page.slug))?.data.id, page.id);
  } finally {
    await kb.cleanup();
  }
});

test("updateRaw leaves a correct id untouched and reports no repair", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = new Content(kb.dir);
    await seedSpace(content, "Docs");
    const page = await content.createPage("docs", "Deploy", "# Deploy\n");

    const mutation = await content.updateRaw(
      page.slug,
      `---\ntitle: Deploy\nid: ${page.id}\n---\n# Rewritten\n`
    );
    assert.notEqual(mutation, null);
    assert.notEqual(mutation?.idPreserved, true);
    assert.equal((await content.load(page.slug))?.data.id, page.id);
  } finally {
    await kb.cleanup();
  }
});

test("updateRaw: stripping only the id is a no-op that still reports the slip", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = new Content(kb.dir);
    await seedSpace(content, "Docs");
    const page = await content.createPage("docs", "Deploy", "# Deploy\n");
    const before = await fs.readFile(page.fsPath, "utf8");

    const withoutId = before.replace(/^id: .*\n/m, "");
    const mutation = await content.updateRaw(page.slug, withoutId);

    // Restored, so the file is byte-identical and there is nothing to commit —
    // but the caller is still told the id was missing.
    assert.equal(mutation?.idPreserved, true);
    assert.equal(await fs.readFile(page.fsPath, "utf8"), before);
  } finally {
    await kb.cleanup();
  }
});

test("updateRaw adds no id to a page that never had one", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = new Content(kb.dir);
    await seedSpace(content, "Docs");
    // Pages predating the id backfill validate without one; nothing to preserve.
    const fsPath = path.join(kb.dir, "docs", "legacy.md");
    await fs.writeFile(fsPath, "---\ntitle: Legacy\n---\n# Legacy\n", "utf8");

    const mutation = await content.updateRaw("docs/legacy", "---\ntitle: Legacy\n---\n# Newer\n");
    assert.notEqual(mutation?.idPreserved, true);
    assert.equal((await content.load("docs/legacy"))?.data.id, undefined);
  } finally {
    await kb.cleanup();
  }
});

test("a wiki-link into a section follows its page across a move, fragment intact", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = new Content(kb.dir);
    await seedSpace(content, "Docs");
    await content.createPage("docs", "Guide", "# Guide\n"); // becomes a section
    const target = await content.createPage("docs/guide", "Target", "# Target\n");
    await content.createPage("docs/guide", "Sibling", "See [[target#setup]].\n");
    await content.createPage(
      "docs",
      "Cousin",
      `Full [[docs/guide/target#setup]]. Abs [x](/docs/guide/target#setup). ` +
        `Id [[id:${target.id}#setup|t]]. Table [[docs/guide/target#setup\\|the page]].\n`
    );
    await content.createPage("docs", "Dest", "# Dest\n");

    await content.movePage("docs/guide/target", "docs/dest");

    // Before the fragment split, `remap("docs/guide/target#setup")` matched
    // nothing and the link was silently left pointing at the old location.
    const sibling = await content.loadRaw("docs/guide/sibling");
    assert.match(sibling!.raw, /\[\[docs\/dest\/target#setup\]\]/);

    const cousin = await content.loadRaw("docs/cousin");
    assert.match(cousin!.raw, /\[\[docs\/dest\/target#setup\]\]/);
    assert.match(cousin!.raw, /\(\/docs\/dest\/target#setup\)/);
    assert.match(cousin!.raw, /\[\[docs\/dest\/target#setup\\\|the page\]\]/);
    // An id link is already move-proof, fragment and all.
    assert.match(cousin!.raw, new RegExp(`\\[\\[id:${target.id}#setup\\|t\\]\\]`));
  } finally {
    await kb.cleanup();
  }
});
