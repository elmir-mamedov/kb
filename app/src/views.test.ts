import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dashboardLayout,
  editLayout,
  layout,
  folderLayout,
  spacesLayout,
  type DashboardView,
  type EditView,
  type PageView,
  type FolderView,
  type SpacesView,
} from "./views.js";
import type { PageNode } from "./content.js";
import type { IndexedNote } from "./note-index.js";
import type { Section } from "./markdown.js";

/** A leaf-page tree node fixture (fills in the required flags). */
function node(overrides: Partial<PageNode> & Pick<PageNode, "slug" | "title">): PageNode {
  return {
    fsPath: `/kb/${overrides.slug}.md`,
    isSection: false,
    isFolder: false,
    archived: false,
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

/** The headings the rail is built from, in document order. */
function sections(overrides: Section[] = []): Section[] {
  return overrides.length
    ? overrides
    : [
        { level: 2, text: "First", anchor: "first", line: 0 },
        { level: 3, text: "Detail", anchor: "detail", line: 4 },
        { level: 2, text: "Second", anchor: "second", line: 8 },
      ];
}

/** A task note as the dashboard receives it, already paired with its page. */
function note(overrides: Partial<IndexedNote> = {}): IndexedNote {
  return {
    id: "aaa11111",
    kind: "task",
    at: "2026-08-17T10:00:00Z",
    by: "elmir",
    quote: "the workers",
    text: "restart them",
    line: 4,
    page: { slug: "flux/deploy", title: "Deploy", fsPath: "/kb/flux/deploy.md" },
    ...overrides,
  };
}

function dashboardView(overrides: Partial<DashboardView> = {}): DashboardView {
  return {
    siteTitle: "KB",
    spaces: [{ key: "flux", title: "Flux", archived: false }],
    spaceKey: "flux",
    tree: [],
    titles: new Map([["flux", "Flux"]]),
    spaceTitle: "Flux",
    groups: [
      {
        slug: "flux/deploy",
        title: "Deploy",
        notes: [note(), note({ id: "bbb22222", line: 20, text: "and the queue" })],
      },
    ],
    summary: {
      total: 2,
      pages: 2,
      oldestAt: "2026-08-17T10:00:00Z",
      newestAt: "2026-08-17T11:00:00Z",
    },
    now: Date.parse("2026-08-17T12:00:00Z"),
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
        node({ slug: "flux/box", title: "Box", isSection: true, isFolder: true }),
        // A content section: a page that happens to have children — NOT a folder.
        node({
          slug: "flux/handbook",
          title: "Handbook",
          isSection: true,
          isFolder: false,
        }),
        // A leaf page.
        node({ slug: "flux/notes", title: "Notes" }),
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
        node({ slug: "flux/box", title: "Box", isSection: true, isFolder: true }),
        // A content section: a page with children — expand caret, no dot.
        node({
          slug: "flux/handbook",
          title: "Handbook",
          isSection: true,
          isFolder: false,
          children: [node({ slug: "flux/handbook/intro", title: "Intro" })],
        }),
        // A leaf page — gets the dot.
        node({ slug: "flux/notes", title: "Notes" }),
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
          children: [node({ slug: "flux/handbook/intro", title: "Intro" })],
        }),
        // A leaf page: gets the dot, in the caret's column.
        node({ slug: "flux/notes", title: "Notes" }),
        // A folder: spacer or caret in that column, then its own icon.
        node({ slug: "flux/box", title: "Box", isSection: true, isFolder: true }),
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

test("the open page's row is marked as the current page", () => {
  const html = layout(
    pageView({
      tree: [
        node({
          slug: "flux/handbook",
          title: "Handbook",
          isSection: true,
          children: [node({ slug: "flux/notes", title: "Notes" })],
        }),
      ],
      activeSlug: "flux/notes",
    })
  );

  // The whole attribute run, in order: MOVE_SCRIPT and COPY_LINK_SCRIPT select
  // `.tree a.active[data-drag-slug]`, so the class must keep its exact slot.
  assert.match(
    html,
    /class="active" aria-current="page" draggable="true" data-drag-slug="flux\/notes"/
  );
  // One page is open, so exactly one row claims to be it.
  assert.equal([...html.matchAll(/aria-current="page"/g)].length, 1);
});

test("a view with no open page marks no row as current", () => {
  // The dashboard passes activeSlug: "", which must not match a real slug.
  assert.doesNotMatch(dashboardLayout(dashboardView()), /aria-current/);
});

/**
 * The reveal of the open page's chain is transient by construction: it skips
 * the collapse instead of undoing it, and has no write path at all. Only the
 * toggle's own click handler may reach localStorage — that is what makes an
 * automatic expansion fall shut again on the next page while the reader's own
 * clicks survive. None of this executes under `npm test`, so these assert on
 * the emitted source; the runtime behaviour has to be driven in a browser.
 */
test("the collapse script reveals the open page without persisting it", () => {
  const html = layout(pageView());
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const move = scripts.find((s) => s.includes("kb:collapsed"));
  assert.ok(move, "the collapse script is emitted with the page");

  // Ancestors of the open page — and the page's own node — keep their children.
  assert.match(move, /!\(activeLi && li\.contains\(activeLi\)\)/);
  // Storage is written from the click handler and nowhere else.
  assert.equal([...move.matchAll(/saveCollapsed\(/g)].length, 2);
  // The row is scrolled into view by moving the sidebar's own scroll box, so
  // the window never travels with it.
  assert.match(move, /pane\.scrollTop \+=/);
});

test("issue #2: every group gets an insertion line above each row and one closing it", () => {
  const html = layout(
    pageView({
      tree: [
        node({
          slug: "flux/handbook",
          title: "Handbook",
          isSection: true,
          children: [node({ slug: "flux/handbook/intro", title: "Intro" })],
        }),
        node({ slug: "flux/notes", title: "Notes" }),
      ],
    })
  );

  // Top level: above handbook, above notes, and one appending to the space root.
  assert.match(html, /<li class="drop-line" data-drop-line data-drop-parent="flux" data-drop-before="flux\/handbook"><\/li><li data-tree-slug="flux\/handbook">/);
  assert.match(html, /<li class="drop-line" data-drop-line data-drop-parent="flux" data-drop-before="flux\/notes"><\/li><li data-tree-slug="flux\/notes">/);
  // The closing line of a group carries no anchor — that means "append here".
  assert.match(html, /<li class="drop-line" data-drop-line data-drop-parent="flux"><\/li><\/ul>/);
  // A child group reports its own parent, so a drop there nests rather than lifts.
  assert.match(html, /data-drop-parent="flux\/handbook" data-drop-before="flux\/handbook\/intro"/);
  assert.match(html, /<li class="drop-line" data-drop-line data-drop-parent="flux\/handbook"><\/li>/);

  // Zero height, invisible until targeted: a tree at rest looks untouched. The
  // 2px indicator straddles a row boundary, so it must not take the hit test from
  // the row edge the pointer is aiming at — that would swallow the dragover.
  assert.match(html, /\.tree \.drop-line\{position:relative; height:0; pointer-events:none\}/);
  assert.match(html, /\.tree \.drop-line::before\{[^}]*opacity:0/);
  assert.match(html, /\.tree \.drop-line\.drop-line-active::before\{opacity:1\}/);
});

test("issue #2: the archive view renders no insertion lines, since it cannot drag", () => {
  const html = layout(
    pageView({
      isArchiveView: true,
      tree: [node({ slug: "flux/notes", title: "Notes", archived: true })],
    })
  );
  assert.doesNotMatch(html, /data-drop-line/);
});

test("issue #2: a line drop posts to /_reorder and stays on the current page", () => {
  const html = layout(pageView());
  assert.match(html, /fetch\(url, \{/);
  assert.match(html, /"\/_reorder",/);
  assert.match(html, /parentSlug: line\.getAttribute\("data-drop-parent"\)/);
  assert.match(html, /beforeSlug: line\.getAttribute\("data-drop-before"\)/);
  // Arranging pages reloads in place; only a page that moved is followed.
  assert.match(html, /window\.location\.reload\(\)/);
});

test("copy link: a toast is created up front and rises from below on copy", () => {
  const html = layout(pageView());
  // Built on init, not on first use, so the aria-live region pre-exists its message.
  assert.match(html, /createElement\("div"\)/);
  assert.match(html, /toast\.setAttribute\("aria-live", "polite"\)/);
  // The wording names what was copied; a control with no label copies a link.
  assert.match(html, /\(label \|\| "Link"\) \+ " copied"/);
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

test("notes: a link in a note's text is drawn as an anchor, still without HTML", () => {
  const html = layout(
    pageView({
      notes: [
        {
          id: "d1ggvluu",
          kind: "agent",
          at: "2026-09-11T11:36:25Z",
          by: "agent",
          text: "See FDT-230.",
          segments: [{ text: "See " }, { text: "FDT-230", href: "/data/fdt-230" }],
          line: 4,
        },
      ],
    })
  );
  // The segments ride along in the payload the client reads.
  assert.match(html, /&quot;href&quot;:&quot;\/data\/fdt-230&quot;/);
  // And are put on a real anchor, node by node, never as markup.
  assert.match(html, /link\.href = segment\.href/);
  assert.match(html, /link\.textContent = segment\.text/);
  assert.match(html, /createTextNode\(segment\.text\)/);
  assert.doesNotMatch(html, /innerHTML/);
});

test("notes: a note with no links falls back to its plain text", () => {
  const html = layout(pageView());
  assert.match(html, /if \(!note\.segments\) \{\n\s*target\.textContent = note\.text;/);
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

test("notes: a note is rewritten and re-typed in its own card", () => {
  const html = layout(pageView());
  // Editing swaps the card in place rather than opening a second panel...
  assert.match(html, /edit\.addEventListener\("click", \(event\) => swap\(true, event\)\)/);
  // ...and that click stops short of the document: redrawing detaches the very
  // button that was clicked, and the outside-click handler would find no popover
  // above the orphan and close the card out from under the editor.
  assert.match(html, /const swap = \(editing, event\) => \{\s*if \(event\) event\.stopPropagation\(\);/);
  // ...and saving posts the new text and kind against the note's own id, so the
  // note keeps its anchor instead of being resolved and written again.
  assert.match(
    html,
    /send\(\{ op: "edit", noteId: note\.id, text: text, kind: picker\.kind\(\) \}, save\)/
  );
  // The kind switch is the composer's, so both paths offer all three kinds.
  assert.match(html, /function kindPicker\(current, onChange\)/);
  assert.match(html, /const picker = kindPicker\(note\.kind, \(kind\) =>/);
  assert.match(html, /const picker = kindPicker\("highlight", \(kind\) =>/);
});

test("notes: the switch offers highlight, remark, task — highlight first", () => {
  const html = layout(pageView());
  assert.match(
    html,
    /\["highlight", "Highlight",[^\]]+\],\s*\["remark", "Remark",[^\]]+\],\s*\["task", "Task",/
  );
  // A highlight is the mark itself, so it is the one kind that saves empty —
  // which is the whole point of not having to type "!!" into a remark.
  assert.equal(html.split(/!text && picker\.kind\(\) !== "highlight"/).length - 1, 2);
  // ...and the card it is read in shows no empty text block where its words aren't.
  assert.match(html, /if \(note\.text\) \{\s*const body = document\.createElement\("div"\)/);
});

test("notes: tasks are purple, highlights yellow, remarks stay teal", () => {
  const html = layout(pageView());
  // Every theme block defines both palettes; one missing them renders unstyled.
  assert.equal(html.split("--task-bg:").length - 1, 3);
  assert.equal(html.split("--highlight-bg:").length - 1, 3);
  assert.match(html, /--task-pin:#a855f7/);
  // The highlight pin is the one token that cannot be shared across themes: a
  // yellow dark enough to be seen on white disappears on the dark page.
  assert.equal(html.split("--highlight-pin:#9aa300").length - 1, 1);
  assert.equal(html.split("--highlight-pin:#e2e800").length - 1, 2);
  // The kind's palette rides on the element, so the rules that draw a note are
  // shared and a remark keeps the teal it always had.
  assert.match(html, /\.note-mark\.is-task,[^{]+\{\s*--note-bg:var\(--task-bg\)/);
  assert.match(html, /\.note-mark\.is-highlight,[^{]+\{\s*--note-bg:var\(--highlight-bg\)/);
  assert.match(html, /\.note-kind\.is-remark\{background:var\(--surface-hover\)/);
  assert.match(html, /mark\.className = "note-mark is-" \+ note\.kind/);
  // One pin per block, coloured by the loudest kind on it.
  assert.match(html, /pin\.classList\.toggle\("is-task", loudest === "task"\)/);
  assert.match(html, /pin\.classList\.toggle\("is-highlight", loudest === "highlight"\)/);
});

test("notes: an agent's note is pink, and a reader can only resolve it", () => {
  const html = layout(pageView());
  // Every theme block defines the palette; one missing it renders unstyled.
  for (const token of [
    "--agent-bg:",
    "--agent-bg-strong:",
    "--agent-fg:",
    "--agent-pin:",
    "--agent-border:",
  ]) {
    assert.equal(html.split(token).length - 1, 3, token + " is not in all three theme blocks");
  }
  // Pink is legible on white and on black, so the pin carries one value across
  // all three — the split the highlight's yellow needs is not needed here.
  assert.equal(html.split("--agent-pin:#ff2d87").length - 1, 3);
  assert.match(html, /\.note-mark\.is-agent,[^{]+\{\s*--note-bg:var\(--agent-bg\)/);
  // No .note-kind-option, because the switch never offers a kind nobody can
  // write — so the chip needs a name from somewhere other than KINDS.
  assert.doesNotMatch(html, /\.note-kind-option\.is-agent/);
  assert.match(html, /const LABELS = \{[^}]*agent: "Agent"/);
  // The pin is coloured for it above a remark and below a task, and colouring it
  // at all takes a fourth toggle — without one the pin falls back to the base
  // token and an agent note reads as a remark.
  assert.match(html, /kinds\.includes\("task"\)\s*\? "task"\s*: kinds\.includes\("agent"\)/);
  assert.match(html, /pin\.classList\.toggle\("is-agent", loudest === "agent"\)/);
  // Resolve and nothing else: an agent's note is the agent's own words.
  assert.match(html, /if \(note\.kind !== "agent"\) \{\s*const edit = actionButton\("Edit"/);
  // And the chip names the writer, so the byline does not say it twice.
  assert.match(html, /const by = note\.kind === "agent" \? "" : note\.by;/);
});

test("notes: the kind switch gets its own row, so no kind is clipped", () => {
  const html = layout(pageView());
  // Three kinds beside Cancel and Save overflow the 320px panel, and .note-kinds
  // hides its overflow — which silently swallowed the third option.
  assert.match(html, /\.note-kinds\{display:flex; flex:1 0 100%/);
  assert.match(html, /\.note-composer-actions,\.note-card-actions\{[^}]*flex-wrap:wrap/);
});

test("notes: the pin finds a legal host inside list and table blocks", () => {
  const html = layout(pageView());
  // A <button> is invalid as a direct child of <ul>/<ol>/<table>.
  assert.match(html, /if \(tag === "UL" \|\| tag === "OL"\) return block\.querySelector\("li"\)/);
  assert.match(html, /if \(tag === "TABLE"\) return block\.querySelector\("th, td"\)/);
});

test("dashboard: the corner button links to the space being viewed", () => {
  const html = layout(pageView());
  assert.match(html, /class="dash-button" href="\/_dashboard\?space=flux"/);
});

test("dashboard: no button outside a space, where it would report on nothing", () => {
  // The spaces home page has no current space — the same reason it ships no
  // sidebar search.
  const html = spacesLayout({
    siteTitle: "KB",
    spaces: [{ key: "flux", title: "Flux", archived: false }],
    username: "alice",
  } satisfies SpacesView);
  // The stylesheet still carries the rule — it is the anchor that must be absent.
  assert.doesNotMatch(html, /class="dash-button"/);
  assert.doesNotMatch(html, /href="\/_dashboard/);
});

test("dashboard: the space key is URL-encoded, not pasted into the href raw", () => {
  const html = layout(pageView({ spaceKey: "a b&c" }));
  assert.match(html, /href="\/_dashboard\?space=a%20b%26c"/);
});

test("dashboard: each task links to its own note anchor, not the page top", () => {
  const html = dashboardLayout(dashboardView());
  assert.match(html, /href="\/flux\/deploy#note-aaa11111"/);
  assert.match(html, /class="task-count">2</);
});

test("dashboard: a positional note id survives the trip into the fragment", () => {
  // A hand-written note with no id= gets an `@<line>` one; unencoded it would not
  // survive the URL, and the client decodes it back before the lookup.
  const html = dashboardLayout(
    dashboardView({
      groups: [
        {
          slug: "flux/deploy",
          title: "Deploy",
          notes: [note({ id: "@12" })],
        },
      ],
    })
  );
  assert.match(html, /#note-%4012"/);
});

test("dashboard: each task carries a copy button holding its note reference", () => {
  const html = dashboardLayout(dashboardView());
  // Copied value is the id qualified by its page, so pasting it into a chat names
  // both; the visible label is the bare id, to match against later.
  assert.match(
    html,
    /<button type="button" class="task-copy" data-copy-slug="flux\/deploy#aaa11111" data-copy-label="Note ID"/
  );
  assert.match(html, /<span class="task-id">aaa11111<\/span>/);
  assert.match(html, /data-copy-slug="flux\/deploy#bbb22222"/);
});

test("dashboard: the copy button is a sibling of the row link, not nested in it", () => {
  // A <button> inside an <a> is invalid, and the click would fight the anchor.
  const html = dashboardLayout(dashboardView());
  assert.match(html, /<\/a>\s*<button type="button" class="task-copy"/);
});

test("dashboard: the copy button reuses the shared clipboard handler", () => {
  const html = dashboardLayout(dashboardView());
  // Same delegated [data-copy-slug] listener as Copy link — no second script.
  assert.match(html, /target\.closest\("\[data-copy-slug\]"\)/);
  // …which names what it copied, so this one's toast reads "Note ID copied".
  assert.match(html, /getAttribute\("data-copy-label"\)/);
  assert.match(html, /\(label \|\| "Link"\) \+ " copied"/);
});

test("dashboard: a note reference is escaped, quotes included", () => {
  const html = dashboardLayout(
    dashboardView({
      groups: [
        { slug: 'flux/a"b', title: "Odd", notes: [note({ id: '"><img src=x>' })] },
      ],
    })
  );
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /data-copy-slug="flux\/a&quot;b#&quot;&gt;&lt;img src=x&gt;"/);
});

test("dashboard: a positional id is copied with its page, which is what locates it", () => {
  // `@12` counts lines in one body and means nothing on its own; the slug is what
  // makes the pasted reference resolvable.
  const html = dashboardLayout(
    dashboardView({
      groups: [{ slug: "flux/deploy", title: "Deploy", notes: [note({ id: "@12" })] }],
    })
  );
  assert.match(html, /data-copy-slug="flux\/deploy#@12"/);
});

test("dashboard: note text and quotes are escaped, never trusted as markup", () => {
  const html = dashboardLayout(
    dashboardView({
      groups: [
        {
          slug: "flux/deploy",
          title: "<script>t</script>",
          notes: [
            note({ text: "<script>alert(1)</script>", quote: "<img src=x onerror=1>" }),
          ],
        },
      ],
    })
  );
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("dashboard: a page's location reads as section titles, not slug segments", () => {
  const html = dashboardLayout(
    dashboardView({
      titles: new Map([
        ["flux", "Flux"],
        ["flux/runbooks", "Runbooks"],
        ["flux/runbooks/deep", "Deep Dives"],
        ["flux/runbooks/deep/deploy", "Deploy"],
      ]),
      groups: [
        { slug: "flux/runbooks/deep/deploy", title: "Deploy", notes: [note()] },
      ],
    })
  );
  // The space is implied and the leaf is already the heading beside it.
  assert.match(html, /class="task-crumb">Runbooks \/ Deep Dives</);
  assert.doesNotMatch(html, /task-crumb">flux/);
});

test("dashboard: an untitled section falls back to its slug segment", () => {
  const html = dashboardLayout(
    dashboardView({
      titles: new Map([["flux", "Flux"]]),
      groups: [{ slug: "flux/runbooks/deploy", title: "Deploy", notes: [note()] }],
    })
  );
  assert.match(html, /class="task-crumb">runbooks</);
});

test("dashboard: a page at the space root gets no location line at all", () => {
  const html = dashboardLayout(
    dashboardView({ groups: [{ slug: "flux/deploy", title: "Deploy", notes: [note()] }] })
  );
  // The stylesheet still carries the rule — it is the span that must be absent.
  assert.doesNotMatch(html, /class="task-crumb"/);
});

test("dashboard: the counts are pluralized against what they count", () => {
  const one = dashboardLayout(
    dashboardView({
      summary: { total: 1, pages: 1, oldestAt: "", newestAt: "" },
    })
  );
  assert.match(one, /<span class="stat-label">open task<\/span>/);
  assert.match(one, /<span class="stat-label">page<\/span>/);

  const many = dashboardLayout(dashboardView());
  assert.match(many, /<span class="stat-label">open tasks<\/span>/);
  assert.match(many, /<span class="stat-label">pages<\/span>/);
});

test("dashboard: an empty space says so instead of showing a bare heading", () => {
  const html = dashboardLayout(
    dashboardView({ groups: [], summary: { total: 0, pages: 0, oldestAt: "", newestAt: "" } })
  );
  assert.match(html, /No task notes in <strong>Flux<\/strong>/);
  // The oldest-age card has nothing to report, and says nothing rather than "0".
  assert.match(html, /<span class="stat-value">—<\/span>/);
});

test("dashboard: a task with no message reads as a bare mark, not a blank row", () => {
  const html = dashboardLayout(
    dashboardView({
      groups: [
        { slug: "flux/deploy", title: "Deploy", notes: [note({ text: "" })] },
      ],
    })
  );
  assert.match(html, /No message — just marked\./);
});

test("dashboard: the page's own notes payload and script stay off it", () => {
  // canEdit:false, so there is nothing to annotate here and NOTES_SCRIPT — which
  // would find no article of notes — is not shipped.
  const html = dashboardLayout(dashboardView());
  assert.doesNotMatch(html, /id="flux-notes"/);
});

test("dashboard: a #note-<id> fragment scrolls to that note and opens it", () => {
  const html = layout(pageView());
  assert.match(html, /location\.hash \|\| ""\)\.replace\(\/\^#note-\/, ""\)/);
  assert.match(html, /anchor\.scrollIntoView\(\{ block: "center" \}\)/);
  assert.match(html, /openPopover\(anchor, \[id\]\)/);
  assert.match(html, /window\.addEventListener\("hashchange", focusFromHash\)/);
  // Ids are compared by splitting the attribute, not with a ~= selector that an
  // `@<line>` id would break.
  assert.doesNotMatch(html, /data-flux-notes~=/);
});

// --- space instructions -----------------------------------------------------

function editView(over: Partial<EditView> = {}): EditView {
  return {
    siteTitle: "KB",
    spaces: [{ key: "flux", title: "Flux", archived: false }],
    spaceKey: "flux",
    tree: [],
    activeSlug: "flux/notes",
    titles: new Map([["flux/notes", "Notes"]]),
    title: "Notes",
    raw: "---\ntitle: Notes\n---\n# Notes\n",
    username: "elmir",
    ...over,
  };
}

test("space instructions: the corner link appears only inside a space", () => {
  const inSpace = dashboardLayout(dashboardView());
  assert.match(inSpace, /class="instructions-button" href="\/_instructions\?space=flux"/);

  // No active space (the archive browser, a 404) — nothing to point at.
  const noSpace = dashboardLayout(dashboardView({ spaceKey: "" }));
  assert.doesNotMatch(noSpace, /href="\/_instructions/);
});

test("space instructions: the space key is URL-encoded in the link", () => {
  const html = dashboardLayout(dashboardView({ spaceKey: "a b&c" }));
  assert.match(html, /href="\/_instructions\?space=a%20b%26c"/);
  assert.doesNotMatch(html, /space=a b&c/);
});

test("space instructions: an ordinary edit page gets no hint and no counter", () => {
  const html = editLayout(editView());
  // Anchor on the markup, not the bare class: the inlined stylesheet always
  // carries the `.instructions-hint` rule, so a class-name match false-positives.
  assert.doesNotMatch(html, /class="instructions-hint"/);
  assert.doesNotMatch(html, /data-instructions-count/);
  // The slug-rename field is the normal affordance.
  assert.match(html, /<input id="slug" name="slug"/);
});

test("space instructions: the instructions editor swaps slug rename for a counter", () => {
  const html = editLayout(
    editView({
      activeSlug: "flux/_instructions",
      title: "Flux instructions",
      instructions: { cap: 2000, spaceTitle: "Flux" },
    })
  );

  assert.match(html, /class="instructions-hint"/);
  assert.match(html, /data-instructions-count/);
  assert.match(html, /<span data-instructions-cap>2000<\/span>/);
  // Renaming this file would break the mechanism that finds it.
  assert.doesNotMatch(html, /<input id="slug" name="slug"/);
  // It still posts to the ordinary editor endpoint.
  assert.match(html, /action="\/_edit\/flux\/_instructions"/);
});

test("space instructions: the counter script ships only on that editor", () => {
  const plain = editLayout(editView());
  assert.doesNotMatch(plain, /data-instructions-cap/);

  const html = editLayout(
    editView({
      activeSlug: "flux/_instructions",
      instructions: { cap: 2000, spaceTitle: "Flux" },
    })
  );
  // The counter measures the body, not the frontmatter, since that is what is
  // delivered to the LLM and measured against the cap.
  assert.match(html, /const bodyOf = \(raw\)/);
  assert.match(html, /area\.addEventListener\("input", render\)/);
});

test("space instructions: the space title is escaped in the hint", () => {
  const html = editLayout(
    editView({
      activeSlug: "flux/_instructions",
      instructions: { cap: 2000, spaceTitle: '<img src=x onerror=alert(1)>' },
    })
  );
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});

test("space instructions: the hint states it is hidden and LLM-read-only", () => {
  const html = editLayout(
    editView({
      activeSlug: "flux/_instructions",
      instructions: { cap: 2000, spaceTitle: "Flux" },
    })
  );
  assert.match(html, /hidden from the sidebar and from search/);
  assert.match(html, /the LLM cannot edit it/);
  // The freshness promise is the thing a reader most needs to trust.
  assert.match(html, /no restart needed/);
});

/**
 * Every inline script must at least parse.
 *
 * The client-side code in views.ts lives inside template literals and never
 * executes under `npm test`, so a lone `\n` in a regex or comment silently
 * collapses into a real newline and breaks the whole script — with no test, no
 * typecheck error, and no server-side symptom. Parsing each emitted script is
 * the cheapest guard that catches it.
 */
test("views: every inline script in every layout parses as JavaScript", () => {
  const pages: Array<[string, string]> = [
    ["page", layout(pageView())],
    ["page-toc", layout(pageView({ sections: sections() }))],
    ["folder", folderLayout({ ...pageView(), children: [] } as unknown as FolderView)],
    ["dashboard", dashboardLayout(dashboardView())],
    ["spaces", spacesLayout({ siteTitle: "KB", spaces: [], username: "u" } as SpacesView)],
    ["edit", editLayout(editView())],
    [
      "edit-instructions",
      editLayout(
        editView({
          activeSlug: "flux/_instructions",
          instructions: { cap: 2000, spaceTitle: "Flux" },
        })
      ),
    ],
  ];

  for (const [name, html] of pages) {
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.ok(scripts.length > 0, `${name}: expected at least one inline script`);
    for (const [i, src] of scripts.entries()) {
      assert.doesNotThrow(
        () => new Function(src),
        `${name}: inline script #${i} does not parse`
      );
    }
  }
});

// --- section linking ---------------------------------------------------------

test("the rail lists the sections it is given, indented by level", () => {
  const html = layout(pageView({ sections: sections() }));
  assert.match(html, /<aside class="toc" aria-label="On this page">/);
  assert.match(html, /<div class="toc-head">On this page<\/div>/);
  assert.match(html, /<li class="toc-item" data-depth="0"><a href="#first" data-section="first">First<\/a>/);
  assert.match(html, /<li class="toc-item" data-depth="1"><a href="#detail" data-section="detail">Detail<\/a>/);
  assert.match(html, /<li class="toc-item" data-depth="0"><a href="#second" data-section="second">Second<\/a>/);
});

test("the rail sits after the content, not inside it", () => {
  const html = layout(pageView({ sections: sections() }));
  assert.ok(html.indexOf("</main>") < html.indexOf('<aside class="toc"'));
});

test("a page with fewer than two sections gets no rail and no scroll script", () => {
  for (const list of [[], sections([{ level: 2, text: "Only", anchor: "only", line: 0 }])]) {
    const html = layout(pageView({ sections: list }));
    assert.doesNotMatch(html, /class="toc"/);
    assert.doesNotMatch(html, /data-section=/);
  }
});

test("a rail entry escapes its heading text and percent-encodes its href", () => {
  const html = layout(
    pageView({
      sections: sections([
        { level: 2, text: "A & B <script>", anchor: "a-b", line: 0 },
        { level: 2, text: "一句话", anchor: "一句话", line: 4 },
      ]),
    })
  );
  assert.match(html, /<a href="#a-b" data-section="a-b">A &amp; B &lt;script&gt;<\/a>/);
  // The href has to be encoded to resolve; data-section stays raw because the
  // script looks the heading up by id.
  assert.match(html, /<a href="#%E4%B8%80%E5%8F%A5%E8%AF%9D" data-section="一句话">/);
});

test("the scroll spy looks headings up by id, never by selector", () => {
  // 1249 headings in this KB start with a digit, and `#1-setup` is not a valid
  // CSS selector — querySelector would throw rather than miss.
  const html = layout(pageView({ sections: sections() }));
  assert.match(html, /document\.getElementById\(/);
  assert.doesNotMatch(html, /querySelector\("#"/);
});

test("the scroll spy's probe line clears the scroll margin by a pixel", () => {
  // A jump to #section scrolls to the heading's offset minus its 28px margin and
  // the browser snaps that to a whole pixel, so a heading on a fractional offset
  // settles a fraction *below* 28 — measured at 27.5–28.5 across one page's
  // headings. Probing at exactly 28 hands the highlight to the section above the
  // one the reader just clicked, on roughly half of them.
  const html = layout(pageView({ sections: sections() }));
  assert.match(html, /const line = 28 \+ 1;/);
});

test("headings get a scroll margin, and smooth scrolling stays off", () => {
  const html = layout(pageView());
  assert.match(html, /\.prose :is\(h1,h2,h3,h4,h5,h6\)\{scroll-margin-top:28px\}/);
  // Smooth scrolling would make scrollIntoView async, and NOTES_SCRIPT places a
  // popover against the rect the anchor lands at immediately afterwards.
  assert.doesNotMatch(html, /scroll-behavior/);
});

test("the section glyph is drawn by CSS so it stays out of the heading text", () => {
  assert.match(layout(pageView()), /\.section-link::before\{content:"#"\}/);
});

test("a real element id wins over the note-fragment handler", () => {
  const html = layout(pageView({ notes: [] }));
  assert.match(html, /if \(location\.hash\.length > 1 && document\.getElementById\(location\.hash\.slice\(1\)\)\) return;/);
});

test("the copy handler moves the address bar for a fragment control", () => {
  const html = layout(pageView());
  assert.match(html, /if \(href && href\.charAt\(0\) === "#"\) location\.hash = href\.slice\(1\);/);
});

test("Help documents section linking and the pin syntax", () => {
  const html = layout(pageView());
  assert.match(html, /Linking to a section/);
  assert.match(html, /\{#my-anchor\}/);
});
