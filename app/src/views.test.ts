import { test } from "node:test";
import assert from "node:assert/strict";
import {
  layout,
  folderLayout,
  spacesLayout,
  type PageView,
  type FolderView,
  type SpacesView,
} from "./views.js";
import type { PageNode } from "./content.js";

/** A leaf-page tree node fixture (fills in the required flags). */
function node(overrides: Partial<PageNode> & Pick<PageNode, "slug" | "title">): PageNode {
  return {
    fsPath: `/kb/${overrides.slug}.md`,
    isSection: false,
    isFolder: false,
    archived: false,
    modifiedMs: 0,
    children: [],
    ...overrides,
  };
}

function pageView(overrides: Partial<PageView> = {}): PageView {
  return {
    siteTitle: "KB",
    spaces: [{ key: "flux", title: "Flux", archived: false }],
    spaceKey: "flux",
    tree: [],
    activeSlug: "flux/notes",
    titles: new Map([["flux/notes", "Notes"]]),
    title: "Notes",
    contentHtml: "<p>hi</p>",
    username: "alice",
    ...overrides,
  };
}

test("issue #1: page view carries the edit link + Cmd/Ctrl+E shortcut", () => {
  const html = layout(pageView());
  assert.match(html, /href="\/_edit\/flux\/notes" data-edit-link/);
  // The shortcut script targets the edit link and binds the E key.
  assert.match(html, /querySelector\("\[data-edit-link\]"\)/);
  assert.match(html, /key\.toLowerCase\(\) !== "e"/);
});

test("issue #1: Help dialog documents the edit shortcut", () => {
  const html = layout(pageView());
  assert.match(html, /Edit the page you are viewing/);
});

test("issue #1: non-editable views have no edit link for the shortcut to fire", () => {
  const html = layout(pageView({ canEdit: false, activeSlug: "", isArchiveView: true }));
  // No Edit anchor is rendered (the trailing `>` distinguishes the tag from the
  // script's `[data-edit-link]` selector, which is always present but inert).
  assert.doesNotMatch(html, /data-edit-link>/);
});

test("issue #3: the page header exposes a Download-as-Markdown link", () => {
  const html = layout(pageView());
  assert.match(
    html,
    /class="button secondary" href="\/_download\/flux\/notes" download>Download<\/a>/
  );
});

test("issue #3: the sidebar ⋯ menu exposes a Download link", () => {
  const html = layout(
    pageView({ tree: [node({ slug: "flux/guide", title: "Guide" })] })
  );
  assert.match(html, /href="\/_download\/flux\/guide" download>Download<\/a>/);
});

test("issue #3: non-editable / rootless views omit the Download button", () => {
  const html = layout(pageView({ canEdit: false, activeSlug: "", isArchiveView: true }));
  assert.doesNotMatch(html, /_download/);
});

test("copy link: the page header exposes a Copy link button carrying the slug", () => {
  const html = layout(pageView());
  assert.match(
    html,
    /<button type="button" class="button secondary" data-copy-slug="flux\/notes" data-copy-link>Copy link<\/button>/
  );
});

test("copy link: the sidebar ⋯ menu offers Copy link for a page", () => {
  const html = layout(
    pageView({ tree: [node({ slug: "flux/guide", title: "Guide" })] })
  );
  assert.match(html, /<button type="button" data-copy-slug="flux\/guide">Copy link<\/button>/);
});

test("copy link: folders also get a Copy link (header + ⋯ menu)", () => {
  const html = folderLayout(
    folderView({ tree: [node({ slug: "flux/box", title: "Box", isFolder: true })] })
  );
  // Header button copies the folder's own slug…
  assert.match(html, /data-copy-slug="flux\/box" data-copy-link>Copy link<\/button>/);
  // …and the sidebar row for a folder offers it too.
  assert.match(html, /<button type="button" data-copy-slug="flux\/box">Copy link<\/button>/);
});

test("copy link: the shortcut script binds Cmd/Ctrl+Shift+L and copies the slug", () => {
  const html = layout(pageView());
  // Shift-gated L key, distinct from the plain Cmd/Ctrl+E / +S shortcuts.
  assert.match(html, /event\.shiftKey/);
  assert.match(html, /key\.toLowerCase\(\) !== "l"/);
  // It reads the current page's button, falling back to the active sidebar row.
  assert.match(html, /querySelector\("\[data-copy-link\]"\)/);
});

test("copy link: Help dialog documents the copy-link shortcut", () => {
  const html = layout(pageView());
  assert.match(html, /Copy this page's relative link/);
});

test("copy link: non-editable / rootless views omit the header Copy link button", () => {
  const html = layout(pageView({ canEdit: false, activeSlug: "", isArchiveView: true }));
  // No header button is rendered (the script's [data-copy-link] selector remains
  // but is inert without a matching element), so no copyable header control.
  assert.doesNotMatch(html, /data-copy-link>/);
});

test("issue #4: the sidebar Create menu offers Page and Folder", () => {
  const html = layout(pageView());
  assert.match(html, /<summary class="sidebar-link">Create<\/summary>/);
  assert.match(html, /action="\/_create">\s*<input[^>]*value="flux"[^>]*>\s*<button type="submit">Page<\/button>/);
  // The folder form now also carries a name text input before its button.
  assert.match(html, /action="\/_create-folder">[\s\S]*?name="name"[\s\S]*?<button type="submit">Folder<\/button>/);
  // The old single-purpose button is gone.
  assert.doesNotMatch(html, /Create page/);
});

test("only real folders render a folder icon — content sections do not", () => {
  const html = layout(
    pageView({
      tree: [
        // A real folder (pure container).
        node({ slug: "flux/box", title: "Box", isSection: true, isFolder: true, modifiedMs: 3 }),
        // A content section: a page that happens to have children — NOT a folder.
        node({
          slug: "flux/handbook",
          title: "Handbook",
          isSection: true,
          isFolder: false,
          modifiedMs: 2,
        }),
        // A leaf page.
        node({ slug: "flux/notes", title: "Notes", modifiedMs: 1 }),
      ],
    })
  );
  // Exactly one icon instance in the markup (the folder), separate from the CSS rule.
  const icons = html.match(/class="tree-folder-icon"/g) ?? [];
  assert.equal(icons.length, 1);
});

test("only leaf pages get a dot — folders and pages-with-children do not", () => {
  const html = layout(
    pageView({
      tree: [
        // A real folder (pure container) — folder icon, no dot.
        node({ slug: "flux/box", title: "Box", isSection: true, isFolder: true, modifiedMs: 4 }),
        // A content section: a page with children — expand caret, no dot.
        node({
          slug: "flux/handbook",
          title: "Handbook",
          isSection: true,
          isFolder: false,
          modifiedMs: 3,
          children: [node({ slug: "flux/handbook/intro", title: "Intro", modifiedMs: 2 })],
        }),
        // A leaf page — gets the dot.
        node({ slug: "flux/notes", title: "Notes", modifiedMs: 1 }),
      ],
    })
  );
  // Two leaf pages in the tree (Notes + the nested Intro), so exactly two dots.
  const dots = html.match(/class="tree-page-dot"/g) ?? [];
  assert.equal(dots.length, 2);
});

test("issue #4: the sidebar ⋯ menu offers New folder", () => {
  const html = layout(pageView({ tree: [node({ slug: "flux/guide", title: "Guide" })] }));
  assert.match(html, /action="\/_create-folder">[\s\S]*?value="flux\/guide"[\s\S]*?New folder<\/button>/);
});

test("the ⋯ menu for a folder shows Rename, not Edit/Download", () => {
  const html = layout(
    pageView({
      tree: [node({ slug: "flux/box", title: "Box", isSection: true, isFolder: true })],
    })
  );
  // Folder menu offers a rename form targeting the folder slug…
  assert.match(html, /action="\/_rename-folder">[\s\S]*?value="flux\/box"/);
  // …and omits the page-only Edit/Download actions for that node.
  assert.doesNotMatch(html, /href="\/_edit\/flux\/box"/);
  assert.doesNotMatch(html, /href="\/_download\/flux\/box"/);
});

function folderView(overrides: Partial<FolderView> = {}): FolderView {
  return {
    siteTitle: "KB",
    spaces: [{ key: "flux", title: "Flux", archived: false }],
    spaceKey: "flux",
    tree: [],
    activeSlug: "flux/box",
    titles: new Map([["flux/box", "Box"]]),
    title: "Box",
    children: [],
    username: "alice",
    ...overrides,
  };
}

test("folderLayout lists children and offers create/rename, but no Edit/Download/prose", () => {
  const html = folderLayout(
    folderView({
      children: [
        node({ slug: "flux/box/sub", title: "Sub", isSection: true, isFolder: true }),
        node({ slug: "flux/box/note", title: "Note" }),
      ],
    })
  );
  // Contents listing with links to each child.
  assert.match(html, /href="\/flux\/box\/sub">Sub<\/a>/);
  assert.match(html, /href="\/flux\/box\/note">Note<\/a>/);
  // Create-inside + rename controls.
  assert.match(html, /action="\/_create-folder">/);
  assert.match(html, /action="\/_rename-folder">/);
  // A folder is not editable/downloadable and has no prose body.
  assert.doesNotMatch(html, /data-edit-link>/);
  assert.doesNotMatch(html, /_download/);
  assert.doesNotMatch(html, /class="prose"/);
});

test("folderLayout shows an empty-state when the folder has no items", () => {
  const html = folderLayout(folderView({ children: [] }));
  assert.match(html, /This folder is empty/);
});

function spacesView(overrides: Partial<SpacesView> = {}): SpacesView {
  return {
    siteTitle: "KB",
    spaces: [
      { key: "flux", title: "Flux", summary: "Notes", icon: "📘", archived: false },
    ],
    username: "alice",
    ...overrides,
  };
}

test("TODO #1: each space card carries a ⋯ menu with Rename, Archive, Delete", () => {
  const html = spacesLayout(spacesView());
  // The card link and the menu are siblings (the menu can't nest in the <a>).
  assert.match(html, /class="space-card-wrap"/);
  assert.match(html, /<summary aria-label="Space actions">⋯<\/summary>/);
  // Edit the name in place — inline rename posting the space key + new title.
  assert.match(
    html,
    /action="\/_rename-space">[\s\S]*?name="key"[^>]*value="flux"[\s\S]*?name="title"[^>]*value="Flux"/
  );
  // Archive the whole space.
  assert.match(
    html,
    /action="\/_archive-space">[\s\S]*?value="flux"[\s\S]*?<button type="submit">Archive<\/button>/
  );
  // Delete goes through a confirmation route.
  assert.match(html, /href="\/_delete-space\/flux">Delete<\/a>/);
});

test("TODO #1: confirmDelete renders a scary confirmation posting to _delete-space", () => {
  const html = spacesLayout(spacesView({ confirmDelete: { key: "flux", title: "Flux" } }));
  assert.match(html, /Delete the “Flux” space\?/);
  assert.match(html, /its Git history/);
  assert.match(
    html,
    /action="\/_delete-space\/flux">[\s\S]*?<button class="button danger" type="submit">Delete space<\/button>/
  );
  // Cancel bails back to the grid.
  assert.match(html, /href="\/">Cancel<\/a>/);
});
