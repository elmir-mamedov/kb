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

test("search: the in-space sidebar renders a combobox scoped to the space", () => {
  const html = layout(pageView());
  assert.match(html, /data-search-space="flux"/);
  assert.match(html, /role="combobox"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-controls="kb-search-results"/);
  assert.match(html, /id="kb-search-results"[\s\S]*?role="listbox"/);
  // The drop strip it replaced is gone.
  assert.doesNotMatch(html, /Move to space root/);
  assert.doesNotMatch(html, /class="root-drop"/);
});

test("search: every in-space layout gets the box, since sidebarHtml carries it", () => {
  assert.match(folderLayout(folderView()), /data-search-input/);
});

test("search: views without a space render neither the box nor its script", () => {
  const html = layout(pageView({ spaceKey: "", activeSlug: "", isArchiveView: true }));
  assert.doesNotMatch(html, /data-search-space/);
  assert.doesNotMatch(html, /data-search-input/);
});

test("search: the shortcut script binds Cmd/Ctrl+K and the Help dialog documents it", () => {
  const html = layout(pageView());
  assert.match(html, /key\.toLowerCase\(\) !== "k"/);
  assert.match(html, /Search this space from the sidebar/);
});

test("search: highlighting builds <mark> nodes rather than assigning HTML", () => {
  const html = layout(pageView());
  // The endpoint sends plain text; the client must never route it through HTML.
  assert.match(html, /createElement\("mark"\)/);
  assert.doesNotMatch(html, /innerHTML/);
});

test("search: the space name takes over as the move-to-space-root drop target", () => {
  const html = layout(pageView());
  assert.match(html, /class="space-current" href="\/flux" data-drop-slug="flux"/);
  // MOVE_SCRIPT discovers it through the selector it already uses.
  assert.match(html, /querySelectorAll\("\[data-drop-slug\], \[data-drop-root\]"\)/);
});

test("search: the move-error banner survives, along with the code that writes to it", () => {
  const html = layout(pageView());
  assert.match(html, /class="move-error" data-move-error hidden/);
  assert.match(html, /querySelector\("\[data-move-error\]"\)/);
});

test("tree rows open with exactly one marker glyph, so carets and dots share a column", () => {
  const html = layout(
    pageView({
      tree: [
        // A page with children: gets the caret.
        node({
          slug: "flux/handbook",
          title: "Handbook",
          isSection: true,
          modifiedMs: 4,
          children: [node({ slug: "flux/handbook/intro", title: "Intro", modifiedMs: 3 })],
        }),
        // A leaf page: gets the dot, in the caret's column.
        node({ slug: "flux/notes", title: "Notes", modifiedMs: 2 }),
        // A folder: spacer or caret in that column, then its own icon.
        node({ slug: "flux/box", title: "Box", isSection: true, isFolder: true, modifiedMs: 1 }),
      ],
    })
  );

  const rows = html.match(/<div class="tree-row">[\s\S]*?<a /g) ?? [];
  assert.equal(rows.length, 4, "one row per node, children included");
  for (const row of rows) {
    const markers = [...row.matchAll(/class="(tree-toggle|tree-toggle-spacer|tree-page-dot)"/g)];
    // Exactly one, and first — anything else would offset the glyph sideways.
    assert.equal(markers.length, 1, `expected a single marker, got ${markers.length} in ${row}`);
    assert.match(row, /^<div class="tree-row">(<button type="button" class="tree-toggle"|<span class="tree-toggle-spacer"|<svg class="tree-page-dot")/);
  }
});

test("copy link: a toast is created up front and rises from below on copy", () => {
  const html = layout(pageView());
  // Built on init, not on first use, so the aria-live region pre-exists its message.
  assert.match(html, /createElement\("div"\)/);
  assert.match(html, /toast\.setAttribute\("aria-live", "polite"\)/);
  assert.match(html, /"Link copied"/);
  assert.match(html, /"Copy failed"/);
  // Class flip is deferred a frame so the offscreen start position gets painted.
  assert.match(html, /requestAnimationFrame\(\(\) => toast\.classList\.add\("is-visible"\)\)/);
  // Travels up from below the bottom edge, and fades in place under reduced motion.
  assert.match(html, /\.toast\{[\s\S]*?transform:translate\(-50%,calc\(100% \+ 24px\)\)/);
  assert.match(html, /\.toast\.is-visible\{opacity:1; transform:translate\(-50%,0\)\}/);
  assert.match(html, /prefers-reduced-motion:reduce\)\{[\s\S]*?\.toast\{transform:translate\(-50%,0\)/);
  // The toast carries the wording now, so the button no longer swaps its label.
  assert.doesNotMatch(html, /copyLabel/);
});

test("notes: the page view carries its notes as an escaped JSON payload", () => {
  const html = layout(
    pageView({
      notes: [
        {
          id: "n7k2m4x8",
          kind: "task",
          at: "2026-08-10T09:12:04Z",
          by: "alice",
          quote: "restart the workers",
          text: 'Stale — use <b>rolling</b> restart & "the script".',
          line: 4,
        },
      ],
    })
  );
  assert.match(html, /<div id="flux-notes" hidden data-slug="flux\/notes" data-notes="/);
  // Everything that could break out of the attribute or the document is escaped.
  assert.match(html, /&quot;n7k2m4x8&quot;/);
  assert.match(html, /&lt;b&gt;rolling&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>rolling<\/b>/);
});

test("notes: the payload ships even with no notes, so the composer can post", () => {
  const html = layout(pageView());
  assert.match(html, /data-slug="flux\/notes" data-notes="\[\]"/);
  assert.match(html, /fetch\("\/_notes\/" \+ slug/);
});

test("notes: highlights are built as nodes, never assigned as HTML", () => {
  const html = layout(pageView());
  assert.match(html, /document\.createElement\("mark"\)/);
  assert.match(html, /createTreeWalker\(block, NodeFilter\.SHOW_TEXT\)/);
  // The whole feature writes user- and agent-authored text into the page.
  assert.doesNotMatch(html, /innerHTML/);
});

test("notes: the composer keeps the selection alive across its own mousedown", () => {
  const html = layout(pageView());
  // Without this the button collapses the selection before the click fires.
  assert.match(html, /addButton\.addEventListener\("mousedown", \(event\) => event\.preventDefault\(\)\)/);
});

test("notes: whitespace normalization survives the template literal intact", () => {
  const html = layout(pageView());
  // A single backslash here would make this /s+/ and quietly break every quote
  // containing the letter s.
  assert.match(html, /text\.replace\(\/\\s\+\/g, " "\)/);
});

test("notes: a read-only or archive view ships neither the payload nor the script", () => {
  for (const view of [pageView({ canEdit: false }), pageView({ isArchiveView: true })]) {
    const html = layout(view);
    assert.doesNotMatch(html, /id="flux-notes"/);
    assert.doesNotMatch(html, /_notes\//);
  }
});

test("notes: the pin finds a legal host inside list and table blocks", () => {
  const html = layout(pageView());
  // A <button> is invalid as a direct child of <ul>/<ol>/<table>.
  assert.match(html, /if \(tag === "UL" \|\| tag === "OL"\) return block\.querySelector\("li"\)/);
  assert.match(html, /if \(tag === "TABLE"\) return block\.querySelector\("th, td"\)/);
});
