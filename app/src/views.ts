import type { PageNode, SpaceInfo } from "./content.js";
import type { DiffLine } from "./diff.js";
import { relativeAge, type NotePageGroup, type NoteSummary } from "./note-index.js";
import type { RenderedNote, Section } from "./markdown.js";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The sidebar tree. `parentSlug` is the group being rendered (a space key at the
 * top level) and is what the insertion lines report on a drop.
 */
function renderTree(
  nodes: PageNode[],
  activeSlug: string,
  options: {
    archiveMode?: boolean;
    dragEnabled?: boolean;
    collapsible?: boolean;
    parentSlug?: string;
  } = {}
): string {
  if (nodes.length === 0) return "";
  const parentSlug = options.parentSlug ?? "";
  // One zero-height insertion point above every row plus one closing the group,
  // so document order matches the sequence of positions on screen — MOVE_SCRIPT
  // relies on that to turn "the top edge of this row" into a drop target. Each is
  // invisible until dragged at, so a tree at rest looks exactly as it did.
  const dropLine = (before: string): string =>
    options.dragEnabled && parentSlug
      ? `<li class="drop-line" data-drop-line data-drop-parent="${escapeHtml(parentSlug)}"${
          before ? ` data-drop-before="${escapeHtml(before)}"` : ""
        }></li>`
      : "";
  const items = nodes
    .map((n) => {
      const isActive = n.slug === activeSlug;
      // aria-current names the row a reader is on, which the highlight colour
      // alone cannot. The class keeps its exact spelling and slot: MOVE_SCRIPT
      // and COPY_LINK_SCRIPT both select `.tree a.active[data-drag-slug]`.
      const activeAttrs = isActive ? ' class="active" aria-current="page"' : "";
      const dragAttrs = options.dragEnabled
        ? ` draggable="true" data-drag-slug="${escapeHtml(n.slug)}" data-drop-slug="${escapeHtml(n.slug)}"`
        : "";
      const label =
        options.archiveMode && !n.archived
          ? `<span class="tree-label">${escapeHtml(n.title)}</span>`
          : `<a href="${slugPath(n.slug)}"${activeAttrs}${dragAttrs}>${escapeHtml(n.title)}</a>`;
      const hasChildren = n.children.length > 0;
      // Every row opens with one 18px marker column holding exactly one glyph, so
      // an expandable row's caret lands on the same vertical as a sibling leaf's
      // dot instead of a column to its left. Expanding or collapsing swaps the
      // caret's rotation, never its slot, so nothing shifts sideways.
      const toggle = options.collapsible && hasChildren
        ? `<button type="button" class="tree-toggle" aria-label="Toggle subpages" aria-expanded="true"></button>`
        : "";
      // A content page with no caret of its own fills the marker column with a
      // dot, so it reads unambiguously as a standalone page. Folders get a spacer
      // there instead — their own icon follows in the next column.
      const marker = toggle
        ? toggle
        : n.isFolder
          ? `<span class="tree-toggle-spacer"></span>`
          : PAGE_DOT;
      // Only real folders (pure containers) carry the folder icon, so it reads
      // as "container" — distinct from an ordinary content page that merely
      // happens to have child pages.
      const folderIcon = n.isFolder ? FOLDER_ICON : "";
      const row = options.dragEnabled
        ? `<div class="tree-row">${marker}${folderIcon}${label}${treeMenu(n)}</div>`
        : label;
      const children = hasChildren
        ? `<div class="children">${renderTree(n.children, activeSlug, {
            ...options,
            parentSlug: n.slug,
          })}</div>`
        : "";
      return `${dropLine(n.slug)}<li data-tree-slug="${escapeHtml(n.slug)}">${row}${children}</li>`;
    })
    .join("");
  return `<ul>${items}${dropLine("")}</ul>`;
}

/**
 * Per-node ⋯ menu. Every node can hold children (New page / New folder). A
 * folder is a pure container, so it gets a Rename control and NO Edit/Download;
 * ordinary pages keep Edit/Download. Creating a folder prompts for its name.
 */
function treeMenu(node: PageNode): string {
  const slug = node.slug;
  const newPage = `<form method="post" action="/_create">
        <input type="hidden" name="parentSlug" value="${escapeHtml(slug)}" />
        <button type="submit">New page</button>
      </form>`;
  const newFolder = `<form class="menu-name-form" method="post" action="/_create-folder">
        <input type="hidden" name="parentSlug" value="${escapeHtml(slug)}" />
        <input type="text" name="name" placeholder="Folder name" required />
        <button type="submit">New folder</button>
      </form>`;
  // Folders: rename the display name in place. Pages: edit body / download.
  const middle = node.isFolder
    ? `<form class="menu-name-form" method="post" action="/_rename-folder">
        <input type="hidden" name="slug" value="${escapeHtml(slug)}" />
        <input type="text" name="name" value="${escapeHtml(node.title)}" required />
        <button type="submit">Rename</button>
      </form>`
    : `<a href="/_edit${slugPath(slug)}">Edit</a>
      <a href="/_download${slugPath(slug)}" download>Download</a>`;
  return `<details class="tree-menu">
    <summary aria-label="Page actions">⋯</summary>
    <div class="tree-menu-pop">
      ${newPage}
      ${newFolder}
      ${middle}
      <button type="button" data-copy-slug="${escapeHtml(slug)}">Copy link</button>
      <form method="post" action="/_archive${slugPath(slug)}">
        <button type="submit">Archive</button>
      </form>
      <a href="/_delete${slugPath(slug)}">Delete</a>
    </div>
  </details>`;
}

function breadcrumb(slug: string, titles: Map<string, string>): string {
  if (!slug) return "";
  const parts = slug.split("/");
  const crumbs: string[] = [];
  let acc = "";
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    const title = titles.get(acc) ?? part;
    crumbs.push(`<a href="/${acc}">${escapeHtml(title)}</a>`);
  }
  return `<nav class="crumbs"><a href="/">Spaces</a> ${crumbs
    .map((c) => `<span class="sep">/</span> ${c}`)
    .join(" ")}</nav>`;
}

export interface PageView {
  siteTitle: string;
  /** Full space list for the switcher. */
  spaces: SpaceInfo[];
  /** Active space key ("" outside any space, e.g. the archive browser). */
  spaceKey: string;
  /** Navigation subtree for the active space (scoped, not the whole KB). */
  tree: PageNode[];
  activeSlug: string;
  titles: Map<string, string>;
  title: string;
  tags?: string[];
  contentHtml: string;
  /**
   * The page's headings, for the "On this page" rail. Already filtered to the
   * levels the rail shows — `tableOfContents` renders whatever it is given.
   */
  sections?: Section[];
  /** Inline notes saved on this page; the renderer has already anchored them. */
  notes?: RenderedNote[];
  updated?: string | null;
  canEdit?: boolean;
  isArchived?: boolean;
  archivedAt?: string;
  isArchiveView?: boolean;
  notice?: ViewNotice;
  username?: string | null;
}

export interface EditView {
  siteTitle: string;
  spaces: SpaceInfo[];
  spaceKey: string;
  tree: PageNode[];
  activeSlug: string;
  titles: Map<string, string>;
  title: string;
  raw: string;
  error?: string;
  notice?: string;
  username?: string | null;
  /**
   * Set when this is a space's instructions file. Swaps the slug-rename field
   * (renaming it would break the mechanism that finds it) for a character
   * counter, since the text is re-sent to the LLM on space-scoped tool results.
   */
  instructions?: { cap: number; spaceTitle: string };
}

export interface DiffView {
  siteTitle: string;
  spaces: SpaceInfo[];
  spaceKey: string;
  tree: PageNode[];
  activeSlug: string;
  titles: Map<string, string>;
  title: string;
  /** Total commits in this page's history (0 ⇒ empty state). */
  commitCount: number;
  /** Zero-based index of the shown revision (0 = latest edit). */
  revIndex: number;
  /** Committer date of the shown revision (preformatted). */
  revDate?: string | null;
  /** Commit subject of the shown revision (ends in `via web` / `via mcp`). */
  revSubject?: string | null;
  /** Parsed word-diff for the shown revision; no `line` entries ⇒ no textual change. */
  lines: DiffLine[];
  username?: string | null;
}

export interface ArchiveView {
  siteTitle: string;
  spaces: SpaceInfo[];
  archiveTree: PageNode[];
  titles: Map<string, string>;
  username?: string | null;
}

export interface DashboardView {
  siteTitle: string;
  spaces: SpaceInfo[];
  spaceKey: string;
  /** The active space's own tree, so the sidebar reads as it does on any page in it. */
  tree: PageNode[];
  titles: Map<string, string>;
  /** Display name of the space being reported on. */
  spaceTitle: string;
  /** Task notes in this space, already grouped per page. */
  groups: NotePageGroup[];
  summary: NoteSummary;
  /** Evaluated once per render so every age on the page is measured from one instant. */
  now: number;
  username?: string | null;
}

export interface DeleteView {
  siteTitle: string;
  spaces: SpaceInfo[];
  spaceKey: string;
  tree: PageNode[];
  activeSlug: string;
  titles: Map<string, string>;
  title: string;
  fsPath: string;
  isSection: boolean;
  affectedCount: number;
  username?: string | null;
}

export interface SpacesView {
  siteTitle: string;
  spaces: SpaceInfo[];
  notice?: ViewNotice;
  username?: string | null;
  /** When set, show a delete-space confirmation for this space above the grid. */
  confirmDelete?: { key: string; title: string };
}

export interface LoginView {
  siteTitle: string;
  error?: string;
  next: string;
  username?: string;
}

export interface ViewNotice {
  tone: "error" | "success" | "warning";
  text: string;
}

function slugPath(slug: string): string {
  if (!slug) return "/";
  return "/" + slug.split("/").map(encodeURIComponent).join("/");
}

function sidebarHtml(
  siteTitle: string,
  spaces: SpaceInfo[],
  spaceKey: string,
  tree: PageNode[],
  activeSlug: string,
  isArchiveView = false
): string {
  const archiveCls = isArchiveView ? " active" : "";

  // Outside any space (archive browser, 404): just list the spaces.
  if (!spaceKey) {
    const list = spaces.length
      ? `<ul>${spaces
          .map(
            (s) =>
              `<li><a href="${slugPath(s.key)}">${escapeHtml(
                s.icon ? `${s.icon} ${s.title}` : s.title
              )}</a></li>`
          )
          .join("")}</ul>`
      : "";
    return `<aside class="sidebar">
  <a class="brand" href="/">${escapeHtml(siteTitle)}</a>
  <a class="sidebar-link${archiveCls}" href="/_archive">Archive</a>
  <nav class="tree">${list}</nav>
</aside>`;
  }

  const current = spaces.find((s) => s.key === spaceKey);
  const spaceLabel = current
    ? current.icon
      ? `${current.icon} ${current.title}`
      : current.title
    : spaceKey;
  // The space name doubles as the "move to space root" drop target, taking over
  // from the dashed strip that this sidebar's search box replaced. It carries
  // `data-drop-slug` (not `data-drop-root`, which would mean the KB root, outside
  // any space) so MOVE_SCRIPT picks it up with no change and the semantics stay
  // exactly what the old strip had: targetKind "page", targetSlug = the space.
  const rootDropAttrs = isArchiveView
    ? ""
    : ` data-drop-slug="${escapeHtml(spaceKey)}" title="Drop a page here to move it to the space root"`;
  const switcher = `<div class="space-switcher">
    <a class="space-current" href="${slugPath(spaceKey)}"${rootDropAttrs}>${escapeHtml(spaceLabel)}</a>
    <a class="space-all" href="/">↩ All spaces</a>
  </div>`;
  // MOVE_SCRIPT still writes every drag failure into [data-move-error]; it used
  // to sit beside the removed drop strip, so it keeps its slot above the tree.
  const moveError = isArchiveView
    ? ""
    : `<div class="move-error" data-move-error hidden></div>`;

  return `<aside class="sidebar">
  <a class="brand" href="/">${escapeHtml(siteTitle)}</a>
  ${switcher}
  ${sidebarSearch(spaceKey)}
  <details class="create-menu">
    <summary class="sidebar-link">Create</summary>
    <div class="create-menu-pop">
      <form method="post" action="/_create">
        <input type="hidden" name="parentSlug" value="${escapeHtml(spaceKey)}" />
        <button type="submit">Page</button>
      </form>
      <form class="menu-name-form" method="post" action="/_create-folder">
        <input type="hidden" name="parentSlug" value="${escapeHtml(spaceKey)}" />
        <input type="text" name="name" placeholder="Folder name" required />
        <button type="submit">Folder</button>
      </form>
    </div>
  </details>
  <a class="sidebar-link${archiveCls}" href="/_archive">Archive</a>
  ${moveError}
  <nav class="tree">${renderTree(tree, activeSlug, {
    dragEnabled: !isArchiveView,
    collapsible: !isArchiveView,
    parentSlug: spaceKey,
  })}</nav>
</aside>
<script>${SEARCH_SCRIPT}</script>`;
}

/**
 * Sidebar search: an ARIA combobox scoped to the current space. The input owns
 * the combobox role; `SEARCH_SCRIPT` fills the listbox with `<a role="option">`
 * children and tracks the highlighted one through `aria-activedescendant`, so DOM
 * focus never leaves the field.
 *
 * `data-search-space` carries the scope, so the script needs no inline data.
 * With JavaScript off this is an inert field — there is no server-rendered
 * results page to fall back to, so it deliberately has no <form> and no action.
 */
function sidebarSearch(spaceKey: string): string {
  return `<div class="sidebar-search" data-search data-search-space="${escapeHtml(spaceKey)}">
    <input id="kb-search-input" class="sidebar-search-input" type="search" data-search-input
      placeholder="Search this space" aria-label="Search this space"
      autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"
      role="combobox" aria-expanded="false" aria-autocomplete="list"
      aria-haspopup="listbox" aria-controls="kb-search-results" />
    <div class="sidebar-search-panel" data-search-panel hidden>
      <div id="kb-search-results" class="sidebar-search-list" role="listbox"
        aria-label="Search results" data-search-list></div>
      <div class="sidebar-search-status" data-search-status role="status" aria-live="polite" hidden></div>
    </div>
  </div>`;
}

function sessionActions(username?: string | null): string {
  if (!username) return "";
  return `<form class="session-actions" method="post" action="/_logout">
    <span class="session-user">${escapeHtml(username)}</span>
    <button class="button secondary" type="submit">Log out</button>
  </form>`;
}

/**
 * Sun/moon button that flips the color theme. Which glyph shows is decided in
 * CSS from the root `data-theme`; the click is handled by the delegated listener
 * in `THEME_SCRIPT`, so this markup needs no per-page script of its own.
 */
function themeToggle(): string {
  return `<button type="button" class="theme-toggle" data-theme-toggle aria-label="Toggle dark mode" title="Toggle dark mode">
    <svg class="theme-icon icon-sun" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
    <svg class="theme-icon icon-moon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>
  </button>`;
}

/**
 * Link to the current space's dashboard. A plain anchor, so it needs no handler
 * of its own — and it only appears when a space is active, the same rule the
 * sidebar search follows: the dashboard reports on one space, and the home page
 * is not in one.
 */
function dashboardLink(spaceKey: string): string {
  if (!spaceKey) return "";
  return `<a class="dash-button" href="/_dashboard?space=${encodeURIComponent(spaceKey)}" aria-label="Notes dashboard" title="Notes dashboard">
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></svg>
  </a>`;
}

/**
 * Link to the current space's standing instructions for the LLM. Same gate as
 * the dashboard: only meaningful inside a space.
 */
function instructionsLink(spaceKey: string): string {
  if (!spaceKey) return "";
  return `<a class="instructions-button" href="/_instructions?space=${encodeURIComponent(spaceKey)}" aria-label="Space instructions" title="Space instructions — standing orders for the LLM in this space">
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16M4 10h16M4 15h10M4 20h7" /></svg>
  </a>`;
}

/** Dashboard + theme toggle + Help + username + Log out pinned to the top-right corner. */
function sessionCorner(username?: string | null, spaceKey = ""): string {
  if (!username) return "";
  return `<div class="session-corner">
    ${instructionsLink(spaceKey)}
    ${dashboardLink(spaceKey)}
    ${themeToggle()}
    <button type="button" class="button secondary" data-help-open>Help</button>
    ${sessionActions(username)}
  </div>
${HELP_DIALOG}
<script>${HELP_SCRIPT}</script>`;
}

/**
 * The shared document <head>: theming meta, favicons, the inlined stylesheet, and
 * the FOUC-safe theme script. The script sets `data-theme` on <html> before the
 * body paints (from localStorage, else the OS preference) and wires the toggle.
 */
function renderHead(title: string): string {
  return `<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
${FAVICON_TAGS}
<title>${title}</title>
<style>${STYLES}</style>
<script>${THEME_SCRIPT}</script>
</head>`;
}

function actionForm(actionPrefix: string, slug: string, label: string, variant: string): string {
  return `<form class="action-form" method="post" action="${actionPrefix}${slugPath(slug)}">
    <button class="button ${variant}" type="submit">${escapeHtml(label)}</button>
  </form>`;
}

/**
 * Page-header "Copy link" button. Copies the page's relative address — the slug,
 * which starts with the space key and ends with the leaf (e.g. `flux/backlog`).
 * `data-copy-slug` carries the value copied by the delegated `COPY_LINK_SCRIPT`
 * handler; `data-copy-link` marks it as the current page's button so the
 * keyboard shortcut can find it.
 */
function copyLinkButton(slug: string): string {
  return `<button type="button" class="button secondary" data-copy-slug="${escapeHtml(slug)}" data-copy-link>Copy link</button>`;
}

/**
 * The "On this page" rail: the page's headings, indented by level.
 *
 * Rendered as a third column beside the sidebar and the content rather than
 * inside `.content`, so the prose keeps its full measure. A page with only one
 * section gets no rail — a table of contents listing a single entry is noise.
 *
 * `data-depth` carries the indent instead of nested `<ul>`s because the scroll
 * script walks the entries as one flat list, and `data-section` is the anchor it
 * matches against. Deliberately no `white-space:nowrap` anywhere in here: `body`
 * is a flex row, so nowrap raises this column's min-content width and widens the
 * whole page instead of ellipsising.
 */
function tableOfContents(sections: Section[]): string {
  if (sections.length < 2) return "";
  const top = Math.min(...sections.map((s) => s.level));
  const items = sections
    .map((s) => {
      const href = escapeHtml("#" + encodeURIComponent(s.anchor));
      return (
        `<li class="toc-item" data-depth="${s.level - top}">` +
        `<a href="${href}" data-section="${escapeHtml(s.anchor)}">${escapeHtml(s.text)}</a>` +
        `</li>`
      );
    })
    .join("");
  return `<aside class="toc" aria-label="On this page">
  <div class="toc-head">On this page</div>
  <ul class="toc-list">${items}</ul>
</aside>`;
}

export function layout(v: PageView): string {
  const tags = (v.tags ?? [])
    .map((t) => `<span class="tag">${escapeHtml(t)}</span>`)
    .join("");
  const updated = v.updated
    ? `<div class="updated">Updated ${escapeHtml(v.updated)}</div>`
    : "";
  const metaInner = `${tags ? `<div class="tags">${tags}</div>` : ""}${updated}`;
  const editLink =
    v.canEdit === false
      ? ""
      : `<a class="button secondary" href="/_edit${slugPath(v.activeSlug)}" data-edit-link>Edit</a>`;
  const diffLink =
    v.canEdit === false || !v.activeSlug
      ? ""
      : `<a class="button secondary" href="/_diff${slugPath(v.activeSlug)}">Diff</a>`;
  const downloadLink =
    v.canEdit === false || !v.activeSlug
      ? ""
      : `<a class="button secondary" href="/_download${slugPath(v.activeSlug)}" download>Download</a>`;
  const copyLink =
    v.canEdit === false || !v.activeSlug ? "" : copyLinkButton(v.activeSlug);
  const archiveAction =
    v.canEdit === false || v.isArchived || !v.activeSlug
      ? ""
      : actionForm("/_archive", v.activeSlug, "Archive", "danger");
  const restoreAction =
    v.isArchived && v.activeSlug
      ? actionForm("/_restore", v.activeSlug, "Restore", "primary")
      : "";
  const deleteAction =
    v.canEdit === false || !v.activeSlug
      ? ""
      : `<a class="button danger" href="/_delete${slugPath(v.activeSlug)}">Delete</a>`;
  const archivedAt = v.archivedAt ? ` on ${escapeHtml(v.archivedAt)}` : "";
  const archivedBanner = v.isArchived
    ? `<div class="notice archived"><strong>Archived.</strong> This page is hidden from normal navigation${archivedAt}.</div>`
    : "";
  const notice = v.notice
    ? `<div class="notice ${v.notice.tone}">${escapeHtml(v.notice.text)}</div>`
    : "";
  const toc = tableOfContents(v.sections ?? []);
  // Shipped even when there are no notes yet, because it also carries the slug
  // the composer posts to — the reader can always start the first one.
  const notesData =
    v.canEdit === false || v.isArchiveView || !v.activeSlug
      ? ""
      : `<div id="kb25-notes" hidden data-slug="${escapeHtml(v.activeSlug)}" data-notes="${escapeHtml(JSON.stringify(v.notes ?? []))}"></div>`;

  return `<!doctype html>
<html lang="en">
${renderHead(`${escapeHtml(v.title)} · ${escapeHtml(v.siteTitle)}`)}
<body>
${sessionCorner(v.username, v.spaceKey)}
${sidebarHtml(v.siteTitle, v.spaces, v.spaceKey, v.tree, v.activeSlug, v.isArchiveView)}
<main class="content">
  ${breadcrumb(v.activeSlug, v.titles)}
  <header class="page-head">
    <div>
      <h1>${escapeHtml(v.title)}</h1>
      <div class="meta">${metaInner}</div>
    </div>
    <div class="actions">${editLink}${diffLink}${downloadLink}${copyLink}${archiveAction}${deleteAction}${restoreAction}</div>
  </header>
  ${notice}${archivedBanner}
  <article class="prose">${v.contentHtml}</article>
</main>
${toc}
${notesData}
<script>${EDIT_SHORTCUT_SCRIPT}</script>
<script>${COPY_LINK_SCRIPT}</script>
${toc ? `<script>${TOC_SCRIPT}</script>` : ""}
${notesData ? `<script>${NOTES_SCRIPT}</script>` : ""}
${v.isArchiveView ? "" : `<script>${MOVE_SCRIPT}</script>`}
${v.contentHtml.includes('class="mermaid"') ? MERMAID_SCRIPT : ""}
</body>
</html>`;
}

export interface FolderView {
  siteTitle: string;
  spaces: SpaceInfo[];
  spaceKey: string;
  tree: PageNode[];
  activeSlug: string;
  titles: Map<string, string>;
  title: string;
  /** The folder's direct children, rendered as the contents listing. */
  children: PageNode[];
  isArchived?: boolean;
  archivedAt?: string;
  notice?: ViewNotice;
  username?: string | null;
}

/**
 * A folder is a pure container: no prose body, no Edit/Download. This renders
 * its contents as a listing plus controls to create items inside it, rename it
 * (display name only), archive, or delete. Moving a folder is done by dragging
 * it in the sidebar, the same as pages. Its location is shown in the breadcrumb.
 */
export function folderLayout(v: FolderView): string {
  const listing = v.children.length
    ? `<ul class="folder-list">${v.children
        .map((c) => {
          const icon = c.isFolder ? FOLDER_ICON : "";
          return `<li>${icon}<a href="${slugPath(c.slug)}">${escapeHtml(c.title)}</a></li>`;
        })
        .join("")}</ul>`
    : `<p class="folder-empty">This folder is empty. Use “New page” or “New folder” to add items.</p>`;

  const createControls = v.isArchived
    ? ""
    : `<div class="folder-create">
      <form method="post" action="/_create">
        <input type="hidden" name="parentSlug" value="${escapeHtml(v.activeSlug)}" />
        <button class="button secondary" type="submit">New page</button>
      </form>
      <form class="menu-name-form" method="post" action="/_create-folder">
        <input type="hidden" name="parentSlug" value="${escapeHtml(v.activeSlug)}" />
        <input type="text" name="name" placeholder="Folder name" required />
        <button class="button secondary" type="submit">New folder</button>
      </form>
    </div>`;

  const renameControl = v.isArchived
    ? ""
    : `<details class="rename-menu">
    <summary class="button secondary">Rename</summary>
    <form class="menu-name-form" method="post" action="/_rename-folder">
      <input type="hidden" name="slug" value="${escapeHtml(v.activeSlug)}" />
      <input type="text" name="name" value="${escapeHtml(v.title)}" required />
      <button type="submit">Save</button>
    </form>
  </details>`;
  const archiveAction = v.isArchived
    ? ""
    : actionForm("/_archive", v.activeSlug, "Archive", "danger");
  const restoreAction = v.isArchived
    ? actionForm("/_restore", v.activeSlug, "Restore", "primary")
    : "";
  const deleteAction = `<a class="button danger" href="/_delete${slugPath(v.activeSlug)}">Delete</a>`;
  const copyLink = copyLinkButton(v.activeSlug);

  const archivedAt = v.archivedAt ? ` on ${escapeHtml(v.archivedAt)}` : "";
  const archivedBanner = v.isArchived
    ? `<div class="notice archived"><strong>Archived.</strong> This folder is hidden from normal navigation${archivedAt}.</div>`
    : "";
  const notice = v.notice
    ? `<div class="notice ${v.notice.tone}">${escapeHtml(v.notice.text)}</div>`
    : "";

  return `<!doctype html>
<html lang="en">
${renderHead(`${escapeHtml(v.title)} · ${escapeHtml(v.siteTitle)}`)}
<body>
${sessionCorner(v.username, v.spaceKey)}
${sidebarHtml(v.siteTitle, v.spaces, v.spaceKey, v.tree, v.activeSlug, false)}
<main class="content">
  ${breadcrumb(v.activeSlug, v.titles)}
  <header class="page-head">
    <div>
      <h1>${escapeHtml(v.title)}</h1>
      <div class="meta"><span class="folder-tag">Folder</span></div>
    </div>
    <div class="actions">${copyLink}${renameControl}${archiveAction}${deleteAction}${restoreAction}</div>
  </header>
  ${notice}${archivedBanner}
  <section class="folder-view">
    ${createControls}
    ${listing}
  </section>
</main>
<script>${MOVE_SCRIPT}</script>
<script>${COPY_LINK_SCRIPT}</script>
</body>
</html>`;
}

export function archiveLayout(v: ArchiveView): string {
  const archiveHtml = v.archiveTree.length
    ? `<div class="archive-browser tree">${renderTree(v.archiveTree, "", {
        archiveMode: true,
      })}</div>`
    : "<p>No archived pages.</p>";

  return layout({
    siteTitle: v.siteTitle,
    spaces: v.spaces,
    spaceKey: "",
    tree: [],
    activeSlug: "",
    titles: v.titles,
    title: "Archive",
    contentHtml: archiveHtml,
    canEdit: false,
    isArchiveView: true,
    username: v.username,
  });
}

/**
 * Where a page sits, as the titles of the sections above it.
 *
 * The space is dropped (every row on the dashboard is in the same one) and so is
 * the leaf, which is already the heading this sits beside. Titles rather than
 * slug segments, because a trail of `recommendation-removing-the-sharepoint-hop`
 * is longer than the note it is meant to place and reads as noise.
 */
function sectionTrail(slug: string, titles: Map<string, string>): string {
  const parts = slug.split("/");
  const trail: string[] = [];
  let acc = parts[0] ?? "";
  for (let i = 1; i < parts.length - 1; i += 1) {
    acc = `${acc}/${parts[i]}`;
    trail.push(titles.get(acc) ?? parts[i]);
  }
  return trail.join(" / ");
}

/** One statistic, big number over a label. */
function statCard(value: string, label: string): string {
  return `<div class="stat-card">
      <span class="stat-value">${escapeHtml(value)}</span>
      <span class="stat-label">${escapeHtml(label)}</span>
    </div>`;
}

/**
 * A note's handle for pasting into a chat: the page it lives on and the note's
 * own id, e.g. `flux/idea#7uribe42`.
 *
 * The bare id is what the reader sees on the row, but it is not what gets copied.
 * An agent handed `7uribe42` alone has to sweep every note in the KB to find it,
 * and a hand-written note's id is only `@<line>` — a number that means nothing
 * away from the page it was counted on. Prefixing the slug (the same string the
 * page's own "Copy link" copies) makes the reference resolvable by itself: the
 * page is named, and the id picks the note out of it.
 */
function noteRef(slug: string, id: string): string {
  return `${slug}#${id}`;
}

/**
 * One task note: the phrase it was left on, what it asks for, who asked when, and
 * its id.
 *
 * The row is a link pointing at the note's own anchor on its page rather than the
 * top of it — a page with fifteen notes is otherwise a scavenger hunt. The copy
 * button is a sibling of that link, not a child: a button nested inside an anchor
 * is invalid, and the two are separate destinations anyway.
 *
 * Every field here was written into a file by a person or an agent, so all of it
 * is escaped, exactly as the `#kb25-notes` payload treats the same strings.
 */
function noteRow(note: NotePageGroup["notes"][number], slug: string, now: number): string {
  const href = `${slugPath(slug)}#note-${encodeURIComponent(note.id)}`;
  const quote = note.quote
    ? `<span class="task-quote">${escapeHtml(note.quote)}</span>`
    : "";
  // A task with no words is legal (the parser defaults an unlabelled note to
  // task), and reads as a bare mark on the phrase — say so rather than showing a
  // blank row.
  const text = note.text
    ? `<span class="task-text">${escapeHtml(note.text)}</span>`
    : `<span class="task-text is-empty">No message — just marked.</span>`;
  const age = relativeAge(note.at, now);
  const byline = [note.by, age].filter(Boolean).join(" · ");
  const ref = escapeHtml(noteRef(slug, note.id));

  return `<li class="task-item">
      <a class="task-link" href="${href}">
        ${quote}
        ${text}
        ${byline ? `<span class="task-by">${escapeHtml(byline)}</span>` : ""}
      </a>
      <button type="button" class="task-copy" data-copy-slug="${ref}" data-copy-label="Note ID" title="Copy note ID — ${ref}" aria-label="Copy note ID ${ref}">
        ${COPY_GLYPH}
        <span class="task-id">${escapeHtml(note.id)}</span>
      </button>
    </li>`;
}

/**
 * The notes dashboard for one space: how much work is waiting, and every piece of
 * it as a link to where it was left.
 *
 * Only `task` notes appear. A remark is context and a highlight is a reader's
 * bookmark — neither asks for anything, so counting them here would blunt the one
 * question this page answers.
 */
export function dashboardLayout(v: DashboardView): string {
  const oldest = relativeAge(v.summary.oldestAt, v.now);
  const cards = [
    statCard(String(v.summary.total), v.summary.total === 1 ? "open task" : "open tasks"),
    statCard(String(v.summary.pages), v.summary.pages === 1 ? "page" : "pages"),
    statCard(oldest ? oldest.replace(/ ago$/, "") : "—", "oldest"),
  ].join("\n    ");

  const groups = v.groups
    .map((group) => {
      const trail = sectionTrail(group.slug, v.titles);
      // Its own line rather than a column in the heading row: a deep trail is
      // longer than the title it places, and squeezed beside one it would be
      // ellipsised down to "Ingestions / O…".
      const crumb = trail ? `<p class="task-crumb">${escapeHtml(trail)}</p>` : "";
      const count = group.notes.length;
      return `<section class="task-group">
      <h2 class="task-group-head">
        <a href="${slugPath(group.slug)}">${escapeHtml(group.title)}</a>
        <span class="task-count">${count}</span>
      </h2>
      ${crumb}
      <ul class="task-list">
        ${group.notes.map((note) => noteRow(note, group.slug, v.now)).join("\n        ")}
      </ul>
    </section>`;
    })
    .join("\n    ");

  const body = v.summary.total
    ? `<div class="stat-row">
    ${cards}
  </div>
  <div class="task-groups">
    ${groups}
  </div>`
    : `<div class="stat-row">
    ${cards}
  </div>
  <p class="dash-empty">No task notes in <strong>${escapeHtml(v.spaceTitle)}</strong>. Select a phrase on any page and leave one to queue up work here.</p>`;

  return layout({
    siteTitle: v.siteTitle,
    spaces: v.spaces,
    spaceKey: v.spaceKey,
    tree: v.tree,
    activeSlug: "",
    titles: v.titles,
    title: `${v.spaceTitle} · Tasks`,
    contentHtml: `<div class="dash">
  <p class="dash-lede">Task notes waiting in this space. Remarks and highlights are not counted.</p>
  ${body}
</div>`,
    canEdit: false,
    username: v.username,
  });
}

export function deleteLayout(v: DeleteView): string {
  const pagePath = slugPath(v.activeSlug);
  const affected =
    v.isSection && v.affectedCount > 1
      ? `<p>This section delete will remove ${v.affectedCount} Markdown pages from this subtree.</p>`
      : "";

  return layout({
    siteTitle: v.siteTitle,
    spaces: v.spaces,
    spaceKey: v.spaceKey,
    tree: v.tree,
    activeSlug: v.activeSlug,
    titles: v.titles,
    title: `Delete ${v.title}`,
    contentHtml: `<div class="notice error"><strong>Permanent delete.</strong> This cannot be undone from the web UI.</div>
<p>Delete <strong>${escapeHtml(v.title)}</strong> at <code>${escapeHtml(pagePath)}</code>?</p>
${affected}
<form class="confirm-actions" method="post" action="/_delete${pagePath}">
  <button class="button danger" type="submit">Delete</button>
  <a class="button secondary" href="${pagePath}">Cancel</a>
</form>`,
    canEdit: false,
    username: v.username,
  });
}

export function editLayout(v: EditView): string {
  const error = v.error
    ? `<div class="notice error">${escapeHtml(v.error)}</div>`
    : "";
  const notice = v.notice
    ? `<div class="notice success">${escapeHtml(v.notice)}</div>`
    : "";
  const pagePath = slugPath(v.activeSlug);
  const segments = v.activeSlug.split("/");
  const leaf = segments[segments.length - 1] ?? "";
  const parentPrefix = segments.slice(0, -1).join("/");
  const slugField = v.instructions
    ? ""
    : v.activeSlug
    ? `<label class="editor-label" for="slug">URL slug</label>
    <div class="slug-row">
      <span class="slug-prefix">/${parentPrefix ? `${escapeHtml(parentPrefix)}/` : ""}</span>
      <input id="slug" name="slug" type="text" value="${escapeHtml(leaf)}" spellcheck="false" autocapitalize="off" />
    </div>
    <p class="slug-hint">Changes the page URL. Re-parent with drag-and-drop / Move instead.</p>`
    : "";

  const instructionsHint = v.instructions
    ? `<div class="instructions-hint">
      <p>Standing orders for the LLM working in <strong>${escapeHtml(v.instructions.spaceTitle)}</strong> — language, tone, formatting, and any context it should always have. They reach the LLM on its next knowledge-base call; no restart needed.</p>
      <p class="instructions-meta">This page is hidden from the sidebar and from search, and the LLM cannot edit it. Keep it under <span data-instructions-cap>${v.instructions.cap}</span> characters — it is re-sent on every call that touches this space, so put reference material on an ordinary page and link to it.</p>
      <p class="instructions-count" data-instructions-count aria-live="polite"></p>
    </div>`
    : "";

  return `<!doctype html>
<html lang="en">
${renderHead(`Edit ${escapeHtml(v.title)} · ${escapeHtml(v.siteTitle)}`)}
<body>
${sessionCorner(v.username, v.spaceKey)}
${sidebarHtml(v.siteTitle, v.spaces, v.spaceKey, v.tree, v.activeSlug)}
<main class="content editor-content">
  ${breadcrumb(v.activeSlug, v.titles)}
  <header class="page-head">
    <div>
      <h1>Edit ${escapeHtml(v.title)}</h1>
      <div class="meta"><span class="path-label">${escapeHtml(pagePath)}</span></div>
    </div>
    <div class="actions">
      <a class="button secondary" href="${pagePath}">Cancel</a>
    </div>
  </header>
  ${error}${notice}
  ${instructionsHint}
  <form class="editor" method="post" action="/_edit${pagePath}">
    ${slugField}
    <label class="editor-label" for="markdown">Markdown</label>
    <textarea id="markdown" name="markdown" spellcheck="false">${escapeHtml(v.raw)}</textarea>
    <div class="form-actions">
      <button class="button primary" type="submit">Save</button>
      <a class="button secondary" href="${pagePath}">Cancel</a>
    </div>
  </form>
</main>
<script>${EDITOR_SCRIPT}</script>
${v.instructions ? `<script>${INSTRUCTIONS_COUNT_SCRIPT}</script>` : ""}
<script>${MOVE_SCRIPT}</script>
<script>${COPY_LINK_SCRIPT}</script>
</body>
</html>`;
}

/** A small pill labeling who made an edit, inferred from the commit-message suffix. */
function editSourceBadge(subject: string): string {
  const s = subject.toLowerCase();
  if (s.endsWith("via mcp")) return `<span class="badge badge-mcp">LLM</span>`;
  if (s.endsWith("via web")) return `<span class="badge badge-web">Person</span>`;
  return "";
}

/** Render parsed word-diff lines into the body of a <pre class="diffview">. */
function renderDiffBody(lines: DiffLine[]): string {
  const rows: string[] = [];
  let sawHunk = false;
  for (const line of lines) {
    if (line.type === "hunk") {
      // Suppress the leading header; mark only the gaps between later hunks.
      if (sawHunk) rows.push(`<span class="diff-sep">· · ·</span>`);
      sawHunk = true;
      continue;
    }
    rows.push(
      line.runs
        .map((r) => {
          const text = escapeHtml(r.text);
          if (r.kind === "add") return `<ins class="diff-add">${text}</ins>`;
          if (r.kind === "del") return `<del class="diff-del">${text}</del>`;
          return text;
        })
        .join("")
    );
  }
  return rows.join("\n");
}

export function diffLayout(v: DiffView): string {
  const pagePath = slugPath(v.activeSlug);
  const hasHistory = v.commitCount > 0;
  const hasChanges = v.lines.some((l) => l.type === "line");

  let panel: string;
  if (!hasHistory) {
    panel = `<div class="notice">No saved history yet for this page. Edits create history the moment they are committed.</div>`;
  } else {
    const base = `/_diff${pagePath}`;
    const olderIdx = v.revIndex + 1;
    const newerIdx = v.revIndex - 1;
    const olderBtn =
      olderIdx < v.commitCount
        ? `<a class="button secondary" href="${base}?rev=${olderIdx}">← Older</a>`
        : `<span class="button secondary disabled">← Older</span>`;
    const newerBtn =
      newerIdx >= 0
        ? `<a class="button secondary" href="${base}?rev=${newerIdx}">Newer →</a>`
        : `<span class="button secondary disabled">Newer →</span>`;
    const badge = v.revSubject ? editSourceBadge(v.revSubject) : "";
    const date = v.revDate ? `<span class="diff-date">${escapeHtml(v.revDate)}</span>` : "";
    const subject = v.revSubject
      ? `<span class="diff-subject">${escapeHtml(v.revSubject)}</span>`
      : "";
    const revbar = `<div class="revbar">
      <div class="revbar-meta">
        <span class="diff-pos">Edit ${v.revIndex + 1} of ${v.commitCount}</span>
        ${date}${subject}${badge}
      </div>
      <div class="revbar-nav">${newerBtn}${olderBtn}</div>
    </div>`;
    const body = hasChanges
      ? `<pre class="diffview">${renderDiffBody(v.lines)}</pre>`
      : `<div class="notice">No textual changes in this edit (it may have only touched frontmatter or whitespace).</div>`;
    panel = `${revbar}${body}`;
  }

  return `<!doctype html>
<html lang="en">
${renderHead(`History ${escapeHtml(v.title)} · ${escapeHtml(v.siteTitle)}`)}
<body>
${sessionCorner(v.username, v.spaceKey)}
${sidebarHtml(v.siteTitle, v.spaces, v.spaceKey, v.tree, v.activeSlug)}
<main class="content">
  ${breadcrumb(v.activeSlug, v.titles)}
  <header class="page-head">
    <div>
      <h1>History <span class="diff-title">${escapeHtml(v.title)}</span></h1>
      <div class="meta"><span class="path-label">${escapeHtml(pagePath)}</span></div>
    </div>
    <div class="actions">
      <a class="button secondary" href="${pagePath}">Back to page</a>
      <a class="button secondary" href="/_edit${pagePath}">Edit</a>
    </div>
  </header>
  ${panel}
</main>
<script>${MOVE_SCRIPT}</script>
<script>${COPY_LINK_SCRIPT}</script>
</body>
</html>`;
}

export function loginLayout(v: LoginView): string {
  const error = v.error
    ? `<div class="notice error">${escapeHtml(v.error)}</div>`
    : "";

  return `<!doctype html>
<html lang="en">
${renderHead(`Sign in · ${escapeHtml(v.siteTitle)}`)}
<body class="login-page">
<div class="session-corner">${themeToggle()}</div>
<main class="login-panel">
  <h1>${escapeHtml(v.siteTitle)}</h1>
  <p class="login-subtitle">Sign in to continue.</p>
  ${error}
  <form class="login-form" method="post" action="/_login">
    <input type="hidden" name="next" value="${escapeHtml(v.next)}" />
    <label for="username">Username</label>
    <input id="username" name="username" type="text" autocomplete="username" value="${escapeHtml(
      v.username ?? ""
    )}" autofocus required />
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required />
    <button class="button primary" type="submit">Sign in</button>
  </form>
</main>
</body>
</html>`;
}

export function notFound(
  siteTitle: string,
  slug: string,
  spaces: SpaceInfo[],
  username?: string | null
): string {
  return layout({
    siteTitle,
    spaces,
    spaceKey: "",
    tree: [],
    activeSlug: "",
    titles: new Map(),
    title: "Not found",
    contentHtml: `<p>No page exists at <code>/${escapeHtml(slug)}</code>.</p>`,
    canEdit: false,
    username,
  });
}

export function spacesLayout(v: SpacesView): string {
  const notice = v.notice
    ? `<div class="notice ${v.notice.tone}">${escapeHtml(v.notice.text)}</div>`
    : "";
  const confirm = v.confirmDelete
    ? `<div class="notice error space-confirm">
    <strong>Delete the “${escapeHtml(v.confirmDelete.title)}” space?</strong>
    This permanently removes the space, every page inside it, and its Git history. This cannot be undone.
    <form class="confirm-actions" method="post" action="/_delete-space${slugPath(v.confirmDelete.key)}">
      <button class="button danger" type="submit">Delete space</button>
      <a class="button secondary" href="/">Cancel</a>
    </form>
  </div>`
    : "";
  const cards = v.spaces.length
    ? v.spaces
        .map((s) => {
          const icon = s.icon
            ? `<span class="space-icon">${escapeHtml(s.icon)}</span>`
            : "";
          const summary = s.summary
            ? `<p class="space-summary">${escapeHtml(s.summary)}</p>`
            : "";
          // The card link cannot contain the interactive ⋯ menu (no nested
          // forms/anchors), so wrap both and float the menu into the corner.
          return `<div class="space-card-wrap">
    <a class="space-card" href="${slugPath(s.key)}">
      ${icon}
      <span class="space-card-title">${escapeHtml(s.title)}</span>
      ${summary}
    </a>
    ${spaceMenu(s)}
  </div>`;
        })
        .join("")
    : `<p class="empty">No spaces yet — create your first one below.</p>`;

  return `<!doctype html>
<html lang="en">
${renderHead(`Spaces · ${escapeHtml(v.siteTitle)}`)}
<body class="spaces-page">
${sessionCorner(v.username)}
<main class="spaces-main">
  <header class="spaces-head">
    <h1>${escapeHtml(v.siteTitle)}</h1>
    <div class="actions">
      <a class="button secondary" href="/_archive">Archive</a>
    </div>
  </header>
  ${notice}${confirm}
  <section class="spaces-grid">${cards}</section>
  <form class="new-space-form" method="post" action="/_create-space">
    <input type="text" name="title" placeholder="New space name" aria-label="New space name" maxlength="80" required />
    <button class="button primary" type="submit">New Space</button>
  </form>
</main>
<script>${SPACE_MENU_SCRIPT}</script>
</body>
</html>`;
}

/**
 * Per-space ⋯ menu on the home grid: edit the space's display name (an inline
 * rename, the space's key/URL stays put), archive the whole space, or delete it
 * outright. Mirrors the sidebar page menu, but scoped to space-level actions.
 */
function spaceMenu(space: SpaceInfo): string {
  const key = space.key;
  return `<details class="space-menu">
    <summary aria-label="Space actions">⋯</summary>
    <div class="space-menu-pop">
      <form class="menu-name-form" method="post" action="/_rename-space">
        <input type="hidden" name="key" value="${escapeHtml(key)}" />
        <input type="text" name="title" value="${escapeHtml(space.title)}" aria-label="Space name" required />
        <button type="submit">Rename</button>
      </form>
      <form method="post" action="/_archive-space">
        <input type="hidden" name="key" value="${escapeHtml(key)}" />
        <button type="submit">Archive</button>
      </form>
      <a href="/_delete-space${slugPath(key)}">Delete</a>
    </div>
  </details>`;
}

/**
 * Site icon links, shared by every page head. The files live in app/public and
 * are served from the site root (see server.ts). The .ico covers legacy
 * browsers and the automatic /favicon.ico request; the SVG and sized PNGs cover
 * modern tabs, bookmarks, and iOS home-screen shortcuts.
 */
const FAVICON_TAGS = `<link rel="icon" href="/favicon.ico" sizes="any" />
<link rel="icon" type="image/svg+xml" href="/kb25.svg" />
<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />`;

/** Inline folder glyph prefixed to section rows in the sidebar tree. */
const FOLDER_ICON = `<svg class="tree-folder-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M1.75 4c0-.69.56-1.25 1.25-1.25h2.94c.33 0 .65.13.88.37l.87.88c.05.04.11.07.18.07H13c.69 0 1.25.56 1.25 1.25v6.06c0 .69-.56 1.25-1.25 1.25H3c-.69 0-1.25-.56-1.25-1.25z"/></svg>`;

/** Inline dot glyph prefixed to leaf-page rows (a content page with no children). */
const PAGE_DOT = `<svg class="tree-page-dot" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="2.5" fill="currentColor"/></svg>`;

/** Two stacked sheets: the copy affordance on the dashboard's note-id buttons. */
const COPY_GLYPH = `<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" /></svg>`;

/** Help dialog content: a short KB25 overview plus the keyboard shortcuts. */
const HELP_DIALOG = `<dialog class="help-dialog" data-help-dialog>
  <form method="dialog" class="help-head">
    <h2>KB25 Help</h2>
    <button class="help-close" aria-label="Close help" value="close">&times;</button>
  </form>
  <section class="help-section">
    <h3>About KB25</h3>
    <p>KB25 is a lean Markdown knowledge base. Content is organized into <strong>spaces</strong> &mdash; the top-level containers shown on the home page &mdash; and each space holds a tree of pages in the sidebar. Open any page and press <strong>Edit</strong> to change its Markdown; every save is committed to Git automatically. Drag pages in the sidebar to re-organize them: drop a page <em>onto</em> another one to nest it inside, or onto the line that appears <em>between</em> two pages to put it there &mdash; including the line at the top level, which lifts a child page back out to the space root. Use the <strong>&ctdot;</strong> menu next to a page to add a child, edit, download, copy its link, or delete it. <strong>Folders</strong> are pure containers &mdash; they hold pages and other folders but have no content of their own, so you rename them instead of editing them.</p>
  </section>
  <section class="help-section">
    <h3>Keyboard shortcuts</h3>
    <dl class="help-keys">
      <dt><kbd>&#8984;</kbd> / <kbd>Ctrl</kbd> + <kbd>K</kbd></dt>
      <dd>Search this space from the sidebar</dd>
      <dt><kbd>&#8984;</kbd> / <kbd>Ctrl</kbd> + <kbd>E</kbd></dt>
      <dd>Edit the page you are viewing</dd>
      <dt><kbd>&#8984;</kbd> / <kbd>Ctrl</kbd> + <kbd>S</kbd></dt>
      <dd>Save the page you are editing</dd>
      <dt><kbd>&#8984;</kbd> / <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>L</kbd></dt>
      <dd>Copy this page's relative link (space/&hellip;/page)</dd>
      <dt><kbd>Esc</kbd></dt>
      <dd>Close the search results or this dialog</dd>
    </dl>
  </section>
  <section class="help-section">
    <h3>Linking to a section</h3>
    <p>Every heading on a page is linkable. Hover one and click the <strong>#</strong> that appears after it to copy a reference to that section &mdash; <code>space/page#the-heading</code> &mdash; which you can paste into a page as <code>[[space/page#the-heading]]</code>. Long pages also get an <strong>On this page</strong> list on the right that follows you as you scroll. A heading's anchor comes from its text, so rewording it changes the link; to pin one that others rely on, write the anchor yourself as <code>## Heading {#my-anchor}</code>.</p>
  </section>
</dialog>`;

const HELP_SCRIPT = `
(() => {
  const dialog = document.querySelector("[data-help-dialog]");
  const openBtn = document.querySelector("[data-help-open]");
  if (!dialog || !openBtn) return;
  openBtn.addEventListener("click", () => {
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  });
})();
`;

/**
 * Cmd/Ctrl+E opens the editor for the page being viewed. It reads the target
 * from the page's own Edit link, so it is inert on views without one (the
 * archive browser, 404s, system notices).
 */
const EDIT_SHORTCUT_SCRIPT = `
(() => {
  const link = document.querySelector("[data-edit-link]");
  if (!link) return;
  document.addEventListener("keydown", (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
    if (event.key.toLowerCase() !== "e") return;
    event.preventDefault();
    window.location.href = link.href;
  });
})();
`;

/**
 * Copy-to-clipboard for anything addressable. Mostly a page's relative address —
 * its slug, which starts with the space key and ends with the leaf (e.g.
 * `flux/backlog`) — so the copied string lives in `data-copy-slug`. Four entry
 * points share this one handler:
 *   1. Cmd/Ctrl+Shift+L copies the page being viewed.
 *   2. The sidebar ⋯ menu's "Copy link" copies that row's slug.
 *   3. The page-header "Copy link" button copies the current page.
 *   4. The dashboard's per-task button copies that note's `slug#id` reference.
 * The current page's button is also tagged `data-copy-link` so the shortcut can
 * find it (falling back to the active sidebar row on views without a header
 * button, e.g. the editor/history). Clipboard access degrades gracefully: it
 * prefers the async Clipboard API and falls back to a hidden-textarea
 * `execCommand("copy")` for non-secure origins (the default LAN host is plain
 * HTTP, where `navigator.clipboard` is absent).
 *
 * Every entry point confirms the same two ways: the control that was used tints
 * green or red, and a toast rises from the bottom of the window for a couple of
 * seconds. The toast is what covers the keyboard shortcut, whose target control
 * may be scrolled out of view or missing altogether. It names what was copied, so
 * a control that copies something other than a link says so via
 * `data-copy-label`; a control without one is copying a link.
 */
const COPY_LINK_SCRIPT = `
(() => {
  function fallbackCopy(text) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      return false;
    }
  }
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(
        () => true,
        () => fallbackCopy(text)
      );
    }
    return Promise.resolve(fallbackCopy(text));
  }
  // One toast, built up front rather than on first use: an aria-live region that
  // is inserted and filled in the same tick is unreliably announced, and having
  // it already laid out is what lets the first toast slide rather than appear.
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");
  document.body.appendChild(toast);
  let toastTimer = 0;

  function showToast(ok, label) {
    toast.textContent = ok ? (label || "Link") + " copied" : "Copy failed";
    toast.classList.toggle("is-error", !ok);
    window.clearTimeout(toastTimer);
    // Flip the class on the next frame so the browser has painted the offscreen
    // starting position and transitions into view instead of jumping.
    window.requestAnimationFrame(() => toast.classList.add("is-visible"));
    toastTimer = window.setTimeout(() => {
      toast.classList.remove("is-visible");
    }, 2200);
  }

  // Tint the control that was clicked. The toast carries the wording, so this no
  // longer swaps the label — two "Copied" messages at once just read as noise.
  function flash(el, ok) {
    if (!el) return;
    el.classList.add(ok ? "copied" : "copy-failed");
    window.clearTimeout(el.__copyTimer);
    el.__copyTimer = window.setTimeout(() => {
      el.classList.remove("copied", "copy-failed");
    }, 1200);
  }
  function confirmCopy(el, ok, label) {
    flash(el, ok);
    showToast(ok, label);
  }
  document.addEventListener("click", (event) => {
    const target = event.target;
    const btn = target && target.closest ? target.closest("[data-copy-slug]") : null;
    if (!btn) return;
    event.preventDefault();
    const slug = btn.getAttribute("data-copy-slug") || "";
    const label = btn.getAttribute("data-copy-label");
    copyText(slug).then((ok) => confirmCopy(btn, ok, label));
    // A heading's copy control is also a real link to its own section. The
    // click was prevented above so the copy could run, so move the address bar
    // by hand — the reader who wanted the URL now sees it there too.
    const href = btn.getAttribute("href");
    if (href && href.charAt(0) === "#") location.hash = href.slice(1);
  });
  document.addEventListener("keydown", (event) => {
    if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey) return;
    if (event.key.toLowerCase() !== "l") return;
    const pageBtn = document.querySelector("[data-copy-link]");
    const active = document.querySelector(".tree a.active[data-drag-slug]");
    const slug = pageBtn
      ? pageBtn.getAttribute("data-copy-slug")
      : active
      ? active.getAttribute("data-drag-slug")
      : null;
    if (!slug) return;
    event.preventDefault();
    // The shortcut can fire on views where the flashed control is offscreen or
    // absent entirely; the toast is what makes it confirmable there.
    copyText(slug).then((ok) => confirmCopy(pageBtn || active, ok));
  });
})();
`;

/**
 * Highlights the section the reader is currently in, in the "On this page" rail.
 *
 * A scroll listener rather than an IntersectionObserver: the question is "which
 * section am I in", and an observer answers "which headings are visible", which
 * is the wrong answer for a section taller than the viewport (no heading in
 * view, so nothing lights) and for the last section on a short page (it can
 * never reach the top). Instead every heading's position is measured against a
 * probe line just below the viewport top, and the last one at or above it wins.
 *
 * The window is what scrolls — only the sidebar has its own overflow — so
 * `getBoundingClientRect().top` is measured fresh on each pass rather than
 * cached, which keeps it correct after images load or a note popover opens.
 * Reads are throttled to one per animation frame; scroll fires far more often
 * than that and each pass touches every heading.
 *
 * An h3's parent h2 is lit too, so the section you are inside stays marked while
 * you read its subsections.
 */
const TOC_SCRIPT = `
(() => {
  const toc = document.querySelector(".toc");
  if (!toc) return;
  const links = Array.prototype.slice.call(toc.querySelectorAll("[data-section]"));
  if (!links.length) return;

  // Pair each rail entry with its heading once; the DOM order of the rail is
  // document order, which is what the "last one above the line" scan needs.
  const entries = [];
  for (const link of links) {
    const id = link.getAttribute("data-section") || "";
    let heading = null;
    try {
      heading = document.getElementById(id);
    } catch (e) {
      heading = null;
    }
    if (heading) entries.push({ link: link, heading: heading, item: link.parentElement });
  }
  if (!entries.length) return;

  let current = null;
  let queued = false;

  function mark(entry) {
    if (entry === current) return;
    for (const other of entries) {
      other.link.removeAttribute("aria-current");
      if (other.item) {
        other.item.removeAttribute("data-active");
        other.item.removeAttribute("data-current");
      }
    }
    current = entry;
    if (!entry) return;
    entry.link.setAttribute("aria-current", "location");
    if (entry.item) {
      entry.item.setAttribute("data-active", "true");
      entry.item.setAttribute("data-current", "true");
    }
    // Also light the nearest shallower entry above it, so an h3 keeps its h2 lit.
    const depth = entry.item ? Number(entry.item.getAttribute("data-depth") || "0") : 0;
    if (depth > 0) {
      const at = entries.indexOf(entry);
      for (let i = at - 1; i >= 0; i--) {
        const item = entries[i].item;
        if (!item) continue;
        if (Number(item.getAttribute("data-depth") || "0") < depth) {
          item.setAttribute("data-active", "true");
          break;
        }
      }
    }
  }

  function update() {
    queued = false;
    // The headings' scroll-margin-top, so the entry lights at the moment its
    // heading settles where a #link would have put it — plus a pixel of slack.
    // A jump to #section scrolls to the heading's offset minus that margin, and
    // the browser snaps the result to a whole pixel: a heading sitting on a
    // fraction then comes to rest a fraction *below* the line, and without the
    // slack the entry above it wins the section the reader just clicked.
    const line = 28 + 1;
    let found = null;
    for (const entry of entries) {
      if (entry.heading.getBoundingClientRect().top <= line) found = entry;
      else break;
    }
    // Above the first heading nothing is active; at the very bottom the last
    // section wins even if its heading never crosses the line.
    if (!found && window.scrollY <= 0) found = null;
    if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 2) {
      found = entries[entries.length - 1];
    }
    mark(found);
  }

  function schedule() {
    if (queued) return;
    queued = true;
    window.requestAnimationFrame(update);
  }

  update();
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule);
  window.addEventListener("hashchange", schedule);
})();
`;

/**
 * Applies the color theme and keeps it in sync. Runs in <head> before first
 * paint so there is no flash of the wrong theme: it reads the saved preference
 * (`kb:theme`), falling back to the OS `prefers-color-scheme`, and sets
 * `data-theme` on <html>. A single delegated click handler flips + persists the
 * theme for any `[data-theme-toggle]` button on the page, and re-renders Mermaid
 * diagrams (if present) so they re-color live.
 */
const THEME_SCRIPT = `
(() => {
  const KEY = "kb:theme";
  const root = document.documentElement;
  const read = () => { try { return localStorage.getItem(KEY); } catch (e) { return null; } };
  const systemDark = () => !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const effective = () => {
    const s = read();
    return s === "light" || s === "dark" ? s : (systemDark() ? "dark" : "light");
  };
  const apply = (theme) => {
    root.dataset.theme = theme;
    if (typeof window.__renderMermaid === "function") window.__renderMermaid();
  };
  apply(effective());
  document.addEventListener("click", (event) => {
    const target = event.target;
    const btn = target && target.closest ? target.closest("[data-theme-toggle]") : null;
    if (!btn) return;
    event.preventDefault();
    const next = root.dataset.theme === "dark" ? "light" : "dark";
    try { localStorage.setItem(KEY, next); } catch (e) {}
    apply(next);
  });
})();
`;

/**
 * Loads Mermaid from the app's own bundle and renders every `<pre class="mermaid">`
 * container into an SVG diagram. Injected only on pages that contain one (see
 * `layout`). `securityLevel: "strict"` keeps Mermaid's DOMPurify sanitizer on,
 * matching the viewer's no-raw-HTML posture. The `<script>` sits at the end of
 * <body>, so all diagram containers are already in the DOM when it runs.
 *
 * The diagram theme follows the page theme. Because Mermaid bakes colors into the
 * generated SVG, we stash each container's source and expose `window.__renderMermaid`,
 * which re-initializes with the current theme and re-renders — `THEME_SCRIPT` calls
 * it on every toggle so on-screen diagrams re-color live.
 */
const MERMAID_SCRIPT = `<script src="/_vendor/mermaid/mermaid.min.js"></script>
<script>
  (() => {
    const nodes = Array.from(document.querySelectorAll("pre.mermaid"));
    nodes.forEach((n) => { if (n.dataset.src === undefined) n.dataset.src = n.textContent; });
    window.__renderMermaid = () => {
      if (typeof mermaid === "undefined") return;
      const dark = document.documentElement.dataset.theme === "dark";
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "default" });
      nodes.forEach((n) => { n.textContent = n.dataset.src; n.removeAttribute("data-processed"); });
      mermaid.run({ nodes });
    };
    window.__renderMermaid();
  })();
</script>`;

/** Cmd/Ctrl+S submits the open editor form instead of the browser save dialog. */
const EDITOR_SCRIPT = `
(() => {
  document.addEventListener("keydown", (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
    const form = document.querySelector("form.editor");
    if (!form) return;
    event.preventDefault();
    if (typeof form.requestSubmit === "function") form.requestSubmit();
    else form.submit();
  });
})();
`;

/**
 * Live character count for the space-instructions editor.
 *
 * Counts the body only — the frontmatter is plumbing, and it is the body that is
 * delivered to the LLM and measured against the cap. Warns rather than blocks:
 * a hard stop mid-thought is worse than a clear number.
 */
const INSTRUCTIONS_COUNT_SCRIPT = `
(() => {
  const area = document.getElementById("markdown");
  const out = document.querySelector("[data-instructions-count]");
  const capEl = document.querySelector("[data-instructions-cap]");
  if (!area || !out || !capEl) return;
  const cap = parseInt(capEl.textContent, 10) || 2000;

  // Every escape below is doubled because this is a template literal: a
  // single-backslash escape collapses into a real newline on emit and breaks
  // both the regex and the surrounding script. Same trap as NOTES_SCRIPT.
  const bodyOf = (raw) => {
    const match = /^---\\r?\\n[\\s\\S]*?\\r?\\n---\\r?\\n?/.exec(raw);
    return (match ? raw.slice(match[0].length) : raw).trim();
  };

  const render = () => {
    const chars = bodyOf(area.value).length;
    const over = chars > cap;
    out.textContent = over
      ? chars + " characters — " + (chars - cap) + " over the " + cap + " limit. The extra will be cut when it reaches the LLM."
      : chars + " of " + cap + " characters.";
    out.classList.toggle("over", over);
  };

  area.addEventListener("input", render);
  render();
})();
`;

const MOVE_SCRIPT = `
(() => {
  const treeEl = document.querySelector(".tree");
  const orderedLinks = Array.from(document.querySelectorAll(".tree a[data-drag-slug]"));
  // Rows inside the tree are resolved from the pointer (see resolveDrop), which
  // has to decide between "into this page" and "between these two" for the same
  // pixel. Only targets outside the tree — the space name — keep own listeners.
  const dropTargets = Array.from(
    document.querySelectorAll("[data-drop-slug], [data-drop-root]")
  ).filter((el) => !treeEl || !treeEl.contains(el));
  const errorEl = document.querySelector("[data-move-error]");

  // Multi-selection: shift-click selects an inclusive range from the anchor;
  // Ctrl/Cmd-click toggles a single item. State is in-memory only — it just
  // needs to survive from the click until the drag, and navigation reloads.
  const selected = new Set();
  let anchorIndex = orderedLinks.findIndex((el) => el.classList.contains("active"));
  let dragSlugs = [];

  function slugOf(el) {
    return el.getAttribute("data-drag-slug") || "";
  }

  function sourceParent(slug) {
    const parts = slug.split("/");
    parts.pop();
    return parts.join("/");
  }

  function applySelection() {
    for (const el of orderedLinks) {
      el.classList.toggle("selected", selected.has(slugOf(el)));
    }
  }

  function selectRange(a, b) {
    selected.clear();
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    for (let i = lo; i <= hi; i++) selected.add(slugOf(orderedLinks[i]));
    applySelection();
  }

  function showError(message) {
    if (!errorEl) return;
    errorEl.textContent = message;
    errorEl.hidden = false;
    window.setTimeout(() => {
      errorEl.hidden = true;
    }, 5000);
  }

  let activeLine = null;

  function clearTargets() {
    for (const target of dropTargets) target.classList.remove("drop-target-active");
    for (const el of orderedLinks) el.classList.remove("drop-target-active");
    if (activeLine) {
      activeLine.classList.remove("drop-line-active");
      activeLine = null;
    }
  }

  function invalidDrop(target) {
    if (dragSlugs.length === 0) return true;
    if (target.hasAttribute("data-drop-root")) {
      // Valid only if at least one dragged item is nested (has a parent to leave).
      return !dragSlugs.some((s) => s.includes("/"));
    }

    const targetSlug = target.getAttribute("data-drop-slug") || "";
    if (!targetSlug) return true;
    for (const s of dragSlugs) {
      if (targetSlug === s) return true; // onto itself
      if (targetSlug.startsWith(s + "/")) return true; // into a descendant
    }
    // Pure no-op: every dragged item already lives directly under the target.
    if (dragSlugs.every((s) => sourceParent(s) === targetSlug)) return true;
    return false;
  }

  // --- Insertion lines --------------------------------------------------------
  // Rows and insertion lines in document order, which is exactly their order on
  // screen. Rebuilt at dragstart, so rows hidden inside a collapsed group are left
  // out and "the line after this row" never points somewhere invisible.
  let seq = [];
  const EDGE = 6;

  function isLine(el) {
    return el.classList.contains("drop-line");
  }

  function buildSeq() {
    seq = treeEl
      ? Array.from(treeEl.querySelectorAll(".drop-line, .tree-row")).filter(
          (el) => el.offsetParent !== null
        )
      : [];
  }

  function indexOfSlug(slug) {
    return orderedLinks.findIndex((el) => slugOf(el) === slug);
  }

  /** The nearest insertion line before (dir -1) or after (dir 1) a row. */
  function neighborLine(row, dir) {
    let i = seq.indexOf(row);
    if (i < 0) return null;
    for (i += dir; i >= 0 && i < seq.length; i += dir) {
      if (isLine(seq[i])) return seq[i];
    }
    return null;
  }

  /**
   * What the pointer is over: an insertion line when it is within EDGE px of a
   * row's top or bottom, the row itself (= move into that page) anywhere in
   * between, or the line closing the tree once the pointer is past the last row.
   * Lines are zero-height and paint through a pseudo-element, so they are never
   * hit directly — a line drop is always inferred from the row edge under the
   * cursor.
   *
   * Where two groups end at the same height — a nested group's closing line sits
   * level with the line following its parent row — the row whose edge is being
   * touched decides, which is why each is looked up in document order from that
   * row: a group's own lines always neighbour its own rows. So the last nested
   * child's bottom edge appends inside the nested group, while the top edge of the
   * row below it, one pixel further down, lands in the outer one.
   */
  function resolveDrop(event) {
    const node = event.target;
    const row = node && node.closest ? node.closest(".tree-row") : null;
    if (row && seq.indexOf(row) >= 0) {
      const rect = row.getBoundingClientRect();
      const edge = Math.min(EDGE, rect.height / 3);
      const before = event.clientY - rect.top <= edge ? neighborLine(row, -1) : null;
      if (before) return { line: before };
      const after = rect.bottom - event.clientY <= edge ? neighborLine(row, 1) : null;
      if (after) return { line: after };
      const link = row.querySelector("a[data-drop-slug]");
      return link ? { row: link } : null;
    }

    // Past the last row (the tree's trailing padding): append to the top level,
    // which is the last line of all. Overshooting a drag aimed at the end of the
    // sidebar is common, and it should land rather than fall through.
    const rows = seq.filter((el) => !isLine(el));
    const lastRow = rows[rows.length - 1];
    const lines = seq.filter(isLine);
    const lastLine = lines[lines.length - 1];
    if (lastRow && lastLine && event.clientY > lastRow.getBoundingClientRect().bottom) {
      return { line: lastLine };
    }
    return null;
  }

  function invalidLine(line) {
    if (dragSlugs.length === 0) return true;
    const parent = line.getAttribute("data-drop-parent") || "";
    if (!parent) return true;
    for (const s of dragSlugs) {
      // Into itself or one of its own descendants.
      if (parent === s || parent.indexOf(s + "/") === 0) return true;
    }
    // A lone page dropped on the line directly above or below itself stays put.
    if (dragSlugs.length === 1) {
      const link = orderedLinks[indexOfSlug(dragSlugs[0])];
      const row = link ? link.closest(".tree-row") : null;
      if (row && (line === neighborLine(row, -1) || line === neighborLine(row, 1))) {
        return true;
      }
    }
    return false;
  }

  function highlight(el, cls) {
    if (el.classList.contains(cls)) return;
    clearTargets();
    el.classList.add(cls);
    if (cls === "drop-line-active") activeLine = el;
  }

  async function post(url, body, failure) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      const result = await response.json();
      if (!response.ok || !result.ok) {
        showError(result.error || failure);
        return null;
      }
      return result;
    } catch {
      showError(failure);
      return null;
    }
  }

  /** Drop onto a page or the space name: re-parent, then land on the moved page. */
  async function submitMove(target) {
    const isRoot = target.hasAttribute("data-drop-root");
    const targetSlug = isRoot ? "" : target.getAttribute("data-drop-slug") || "";
    // Skip items already parented at the target — the server rejects no-ops.
    const slugs = isRoot
      ? dragSlugs.slice()
      : dragSlugs.filter((s) => sourceParent(s) !== targetSlug);
    if (slugs.length === 0) return;
    const result = await post(
      "/_move",
      new URLSearchParams({
        sourceSlugs: JSON.stringify(slugs),
        targetKind: isRoot ? "root" : "page",
        targetSlug,
      }),
      "Move failed."
    );
    if (!result) return;
    if (result.error) {
      // Partial success: show the note briefly, then land on a moved page.
      showError(result.error);
      window.setTimeout(() => {
        window.location.href = result.url;
      }, 2000);
      return;
    }
    window.location.href = result.url;
  }

  /** Drop onto an insertion line: place the pages at that exact spot. */
  async function submitReorder(line) {
    const result = await post(
      "/_reorder",
      new URLSearchParams({
        sourceSlugs: JSON.stringify(dragSlugs),
        parentSlug: line.getAttribute("data-drop-parent") || "",
        beforeSlug: line.getAttribute("data-drop-before") || "",
      }),
      "Could not reorder pages."
    );
    if (!result) return;
    if (result.error) {
      showError(result.error);
      window.setTimeout(() => settle(result), 2000);
      return;
    }
    settle(result);
  }

  /**
   * Arranging pages must not navigate away — the reader keeps the page they are
   * reading, and a reload is what re-renders the sidebar in its new order. The
   * exception is the page they are on having moved: then follow it to its new URL.
   */
  function settle(result) {
    const activeEl = document.querySelector(".tree a.active[data-drag-slug]");
    const current = activeEl ? slugOf(activeEl) : "";
    const moved = Array.isArray(result.moved) ? result.moved : [];
    for (const m of moved) {
      if (current === m.oldSlug || current.indexOf(m.oldSlug + "/") === 0) {
        const next = m.newSlug + current.slice(m.oldSlug.length);
        window.location.href = "/" + next.split("/").map(encodeURIComponent).join("/");
        return;
      }
    }
    window.location.reload();
  }

  orderedLinks.forEach((link, index) => {
    link.addEventListener("click", (event) => {
      if (event.shiftKey) {
        event.preventDefault();
        if (anchorIndex < 0) anchorIndex = index;
        selectRange(anchorIndex, index);
        const sel = window.getSelection();
        if (sel) sel.removeAllRanges();
      } else if (event.metaKey || event.ctrlKey) {
        event.preventDefault();
        const slug = slugOf(link);
        if (selected.has(slug)) selected.delete(slug);
        else selected.add(slug);
        anchorIndex = index;
        applySelection();
      } else {
        // Plain click navigates; drop any lingering selection first.
        selected.clear();
        applySelection();
      }
    });

    link.addEventListener("dragstart", (event) => {
      const slug = slugOf(link);
      // Grabbing a selected item drags the whole selection; else just this one.
      let slugs = selected.has(slug) && selected.size > 0 ? Array.from(selected) : [slug];
      // Drop descendants of another dragged slug — the ancestor carries them.
      slugs = slugs.filter((s) => !slugs.some((o) => o !== s && s.startsWith(o + "/")));
      // Sidebar order, so a multi-page drop lands in the order it was shown in
      // rather than the order the pages happened to be ctrl-clicked.
      slugs.sort((a, b) => indexOfSlug(a) - indexOfSlug(b));
      dragSlugs = slugs;
      buildSeq();
      for (const el of orderedLinks) {
        if (dragSlugs.includes(slugOf(el))) el.classList.add("drag-source");
      }
      document.body.classList.add("dragging-page");
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", dragSlugs.join("\\n"));
      }
    });

    link.addEventListener("dragend", () => {
      dragSlugs = [];
      for (const el of orderedLinks) el.classList.remove("drag-source");
      document.body.classList.remove("dragging-page");
      clearTargets();
    });
  });

  for (const target of dropTargets) {
    target.addEventListener("dragover", (event) => {
      if (invalidDrop(target)) {
        target.classList.remove("drop-target-active");
        return;
      }

      event.preventDefault();
      highlight(target, "drop-target-active");
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "move";
      }
    });

    target.addEventListener("dragleave", () => {
      target.classList.remove("drop-target-active");
    });

    target.addEventListener("drop", (event) => {
      if (invalidDrop(target)) return;
      event.preventDefault();
      clearTargets();
      submitMove(target);
    });
  }

  // One handler for the whole tree: which of the two gestures a drop is — into a
  // page, or between two of them — depends on where in a row the pointer sits, so
  // it cannot be split across per-element listeners.
  if (treeEl) {
    treeEl.addEventListener("dragover", (event) => {
      const hit = resolveDrop(event);
      if (!hit) {
        clearTargets();
        return;
      }
      if (hit.line ? invalidLine(hit.line) : invalidDrop(hit.row)) {
        clearTargets();
        return;
      }
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "move";
      }
      if (hit.line) highlight(hit.line, "drop-line-active");
      else highlight(hit.row, "drop-target-active");
    });

    treeEl.addEventListener("dragleave", (event) => {
      if (!treeEl.contains(event.relatedTarget)) clearTargets();
    });

    treeEl.addEventListener("drop", (event) => {
      const hit = resolveDrop(event);
      if (!hit) return;
      if (hit.line ? invalidLine(hit.line) : invalidDrop(hit.row)) return;
      event.preventDefault();
      clearTargets();
      if (hit.line) submitReorder(hit.line);
      else submitMove(hit.row);
    });
  }

  const menus = Array.from(document.querySelectorAll(".tree-menu"));
  for (const menu of menus) {
    menu.addEventListener("toggle", () => {
      if (!menu.open) return;
      for (const other of menus) {
        if (other !== menu) other.open = false;
      }
    });
  }
  document.addEventListener("click", (event) => {
    for (const menu of menus) {
      if (menu.open && !menu.contains(event.target)) menu.open = false;
    }
  });

  // Collapsible sidebar tree. Collapsed slugs persist in localStorage so the
  // chosen layout survives the full-page reloads that navigation triggers.
  const COLLAPSE_KEY = "kb:collapsed";
  function loadCollapsed() {
    try {
      return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || "[]"));
    } catch {
      return new Set();
    }
  }
  function saveCollapsed(set) {
    try {
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify(Array.from(set)));
    } catch {}
  }

  const collapsed = loadCollapsed();
  // The open page's row must always be on screen, so a branch the reader
  // collapsed earlier is skipped below rather than un-collapsed: the reveal
  // lasts exactly this page load, never reaches localStorage, and navigating
  // away leaves the branch the way the reader left it. contains() reports true
  // for the node itself, so this covers the open page's own node too -- its
  // direct children get listed -- while everything below it keeps the state it
  // had.
  const activeLink = document.querySelector(".tree a.active");
  const activeLi = activeLink ? activeLink.closest("li[data-tree-slug]") : null;
  const treeItems = Array.from(document.querySelectorAll(".tree li[data-tree-slug]"));
  for (const li of treeItems) {
    const toggle = li.querySelector(":scope > .tree-row .tree-toggle");
    if (!toggle) continue;
    const slug = li.getAttribute("data-tree-slug") || "";
    if (collapsed.has(slug) && !(activeLi && li.contains(activeLi))) {
      li.classList.add("collapsed");
      toggle.setAttribute("aria-expanded", "false");
    }
    toggle.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const isCollapsed = li.classList.toggle("collapsed");
      toggle.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
      if (isCollapsed) collapsed.add(slug);
      else collapsed.delete(slug);
      saveCollapsed(collapsed);
    });
  }

  // Revealing a row is pointless if it sits outside the sidebar's scroll box.
  // Measured after the loop, because collapsing the other branches is what
  // decides where this row ended up. The overflow test skips trees that already
  // fit and skips the narrow layout, where .sidebar is static and scrolling
  // would move the window instead -- pulling the reader off the page they just
  // opened. scrollTop, not scrollIntoView, for the same reason.
  const pane = document.querySelector(".sidebar");
  if (activeLink && pane && pane.scrollHeight > pane.clientHeight) {
    const row = activeLink.closest(".tree-row") || activeLink;
    const paneBox = pane.getBoundingClientRect();
    const rowBox = row.getBoundingClientRect();
    if (rowBox.top < paneBox.top || rowBox.bottom > paneBox.bottom) {
      pane.scrollTop += rowBox.top - paneBox.top - (pane.clientHeight - rowBox.height) / 2;
    }
  }
})();
`;

/**
 * Sidebar search. A debounced GET to /_search fills an ARIA listbox under the
 * input; ↑/↓ move the highlighted option (via aria-activedescendant, so focus
 * stays in the field), Enter opens it, Esc dismisses and then clears.
 * Cmd/Ctrl+K focuses the box from anywhere on the page.
 *
 * The endpoint sends plain text plus the query's tokens — never HTML — and every
 * string reaches the DOM through textContent, so page content cannot inject
 * markup into the dropdown.
 */
const SEARCH_SCRIPT = `
(() => {
  const root = document.querySelector("[data-search]");
  if (!root) return;
  const input = root.querySelector("[data-search-input]");
  const panel = root.querySelector("[data-search-panel]");
  const list = root.querySelector("[data-search-list]");
  const status = root.querySelector("[data-search-status]");
  if (!input || !panel || !list || !status) return;

  const space = root.getAttribute("data-search-space") || "";
  const DEBOUNCE_MS = 180;
  const MIN_LENGTH = 2;
  const LIMIT = 8;

  let timer = 0;
  let controller = null;
  let items = [];
  let activeIndex = -1;
  let lastQuery = "";
  // Backspacing to a query already asked about is the most common wasted round
  // trip; a plain Map kills it. Cleared wholesale rather than evicted by age —
  // it only has to survive until the next navigation.
  const cache = new Map();

  function setStatus(text) {
    status.textContent = text || "";
    status.hidden = !text;
  }

  function open() {
    panel.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }

  function clearList() {
    list.textContent = "";
    items = [];
    activeIndex = -1;
  }

  function close() {
    panel.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    clearList();
    setStatus("");
  }

  function setActive(index) {
    const previous = items[activeIndex];
    if (previous) {
      previous.classList.remove("is-active");
      previous.setAttribute("aria-selected", "false");
    }
    activeIndex = index;
    const el = items[index];
    if (!el) {
      input.removeAttribute("aria-activedescendant");
      return;
    }
    el.classList.add("is-active");
    el.setAttribute("aria-selected", "true");
    input.setAttribute("aria-activedescendant", el.id);
    if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
  }

  // Wrap each occurrence of a query token in <mark>, longest-token-first at any
  // given position so "dep" inside "deploy" cannot produce a nested mark. Every
  // slice goes in as a text node, so nothing here can introduce markup.
  function highlight(target, text, tokens) {
    target.textContent = "";
    const lower = text.toLowerCase();
    // A handful of code points change length when lowercased (e.g. "İ"), which
    // would desync every offset below. Fall back to plain text instead.
    const usable = lower.length === text.length && tokens.length > 0;
    let cursor = 0;
    while (usable && cursor < text.length) {
      let at = -1;
      let length = 0;
      for (const token of tokens) {
        if (!token) continue;
        const found = lower.indexOf(token, cursor);
        if (found === -1) continue;
        if (at === -1 || found < at || (found === at && token.length > length)) {
          at = found;
          length = token.length;
        }
      }
      if (at === -1) break;
      if (at > cursor) target.appendChild(document.createTextNode(text.slice(cursor, at)));
      const mark = document.createElement("mark");
      mark.textContent = text.slice(at, at + length);
      target.appendChild(mark);
      cursor = at + length;
    }
    if (cursor < text.length) target.appendChild(document.createTextNode(text.slice(cursor)));
  }

  function render(payload, query) {
    clearList();
    const results = payload.results || [];
    const tokens = payload.tokens || [];
    if (!results.length) {
      setStatus("No matches for \\"" + query + "\\" in this space.");
      open();
      return;
    }
    setStatus("");
    results.forEach((result, index) => {
      const item = document.createElement("a");
      item.className = "sidebar-search-item";
      item.id = "kb-search-opt-" + index;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", "false");
      item.href = result.url;

      const title = document.createElement("span");
      title.className = "sidebar-search-title";
      highlight(title, String(result.title || ""), tokens);
      item.appendChild(title);

      if (result.crumb) {
        const crumb = document.createElement("span");
        crumb.className = "sidebar-search-crumb";
        crumb.textContent = result.crumb;
        item.appendChild(crumb);
      }

      const excerpt = String(result.excerpt || "");
      if (excerpt) {
        const body = document.createElement("span");
        body.className = "sidebar-search-excerpt";
        highlight(body, excerpt, tokens);
        item.appendChild(body);
      }

      item.addEventListener("mousemove", () => setActive(index));
      list.appendChild(item);
      items.push(item);
    });
    open();
    setActive(0);
  }

  async function run(query) {
    if (controller) controller.abort();
    const cached = cache.get(query);
    if (cached) {
      render(cached, query);
      return;
    }

    controller = new AbortController();
    setStatus("Searching…");
    open();
    const url = "/_search?q=" + encodeURIComponent(query) +
      "&space=" + encodeURIComponent(space) + "&limit=" + LIMIT;
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      // An expired session 303s to the sign-in page, which fetch follows — so a
      // stale tab would get HTML with response.ok true. Reload so the user lands
      // on the login form instead of an empty dropdown.
      if (response.redirected) {
        window.location.reload();
        return;
      }
      const result = await response.json();
      if (!response.ok || !result.ok) {
        clearList();
        setStatus(result && result.error ? result.error : "Search failed.");
        return;
      }
      // abort() does not reliably beat a response already in flight, so stale
      // answers are dropped by query as well.
      if (query !== lastQuery) return;
      if (cache.size > 50) cache.clear();
      cache.set(query, result);
      render(result, query);
    } catch (error) {
      if (error && error.name === "AbortError") return;
      clearList();
      setStatus("Search failed.");
    }
  }

  input.addEventListener("input", () => {
    const query = input.value.trim();
    lastQuery = query;
    window.clearTimeout(timer);
    if (query.length < MIN_LENGTH) {
      if (controller) controller.abort();
      close();
      return;
    }
    timer = window.setTimeout(() => run(query), DEBOUNCE_MS);
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      // First press dismisses the results, second empties the box.
      if (panel.hidden) {
        input.value = "";
        lastQuery = "";
        input.blur();
      } else {
        close();
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (panel.hidden || !items.length) return;
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((activeIndex + step + items.length) % items.length);
      return;
    }
    if (event.key === "Enter") {
      const el = items[activeIndex];
      if (panel.hidden || !el) return;
      event.preventDefault();
      window.location.href = el.href;
    }
  });

  // Keep focus in the input on mousedown, so the focusout teardown below cannot
  // remove the row between mousedown and click and swallow the navigation.
  // Safari does not focus clicked links, which is where this bites hardest.
  list.addEventListener("mousedown", (event) => event.preventDefault());

  document.addEventListener("click", (event) => {
    if (!root.contains(event.target)) close();
  });
  root.addEventListener("focusout", () => {
    window.setTimeout(() => {
      if (!root.contains(document.activeElement)) close();
    }, 0);
  });

  document.addEventListener("keydown", (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
    if (event.key.toLowerCase() !== "k") return;
    event.preventDefault();
    input.focus();
    input.select();
  });
})();
`;

/**
 * Space ⋯ menus on the home grid: keep only one open, and close the open one
 * when the user clicks elsewhere. The <details> toggle works without JS; this
 * just adds the same dismiss behavior the sidebar page menus have.
 */
const SPACE_MENU_SCRIPT = `
(() => {
  const menus = Array.from(document.querySelectorAll(".space-menu"));
  for (const menu of menus) {
    menu.addEventListener("toggle", () => {
      if (!menu.open) return;
      for (const other of menus) {
        if (other !== menu) other.open = false;
      }
    });
  }
  document.addEventListener("click", (event) => {
    for (const menu of menus) {
      if (menu.open && !menu.contains(event.target)) menu.open = false;
    }
  });
})();
`;

/**
 * Inline notes on the rendered page: draw the ones already saved, and let a text
 * selection become a new one.
 *
 * The renderer stamps each top-level block with `data-src-line` / `data-src-hash`
 * and lists the ids of the notes attached to it in `data-kb25-notes`; the notes
 * themselves arrive as JSON on `#kb25-notes`. Everything here is built with
 * `createElement` and text nodes — never `innerHTML` — because note text comes
 * from a file a person or an agent can write anything into.
 *
 * Note that every `\\s` below is doubled: this is a template literal, so a lone
 * backslash would be eaten and `/\s+/` would silently become `/s+/`.
 */
const NOTES_SCRIPT = `
(() => {
  const article = document.querySelector("article.prose");
  const payload = document.getElementById("kb25-notes");
  if (!article || !payload) return;

  const slug = payload.getAttribute("data-slug") || "";
  let notes = [];
  try {
    notes = JSON.parse(payload.getAttribute("data-notes") || "[]");
  } catch (err) {
    notes = [];
  }

  const byId = new Map(notes.map((note) => [note.id, note]));

  /** Collapse whitespace the same way the server does, so quotes still match. */
  function normalize(text) {
    return text.replace(/\\s+/g, " ").trim();
  }

  function relativeTime(iso) {
    const then = Date.parse(iso);
    if (!then) return "";
    const seconds = Math.max(0, (Date.now() - then) / 1000);
    const steps = [[60, "s"], [60, "m"], [24, "h"], [7, "d"], [52, "w"]];
    let value = seconds;
    let unit = "s";
    for (const [size, name] of steps) {
      if (value < size) break;
      value = value / size;
      unit = name;
    }
    return Math.floor(value) + unit + " ago";
  }

  // --- painting saved notes ------------------------------------------------

  /**
   * Wrap a note's quote in <mark>. The quote can straddle <strong>/<a>
   * boundaries, and no single element can wrap across those, so this indexes
   * every text node into one collapsed string, finds the quote there, then
   * splits and wraps each text node the match touches — one <mark> per node.
   * Returns false when the quote is gone, so the caller can degrade instead of
   * throwing.
   */
  function markQuote(block, note) {
    const wanted = normalize(note.quote);
    if (!wanted) return false;

    // Collect the whole walk before mutating: splitText() inserts siblings the
    // walker has already passed, which would otherwise be revisited.
    const nodes = [];
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      // Mermaid re-reads its source from textContent on every theme flip, so
      // that text has to stay one intact node.
      if (node.parentElement && node.parentElement.closest("pre.mermaid")) continue;
      nodes.push(node);
    }

    // text[i] came from nodes[owner[i]] at character offset[i]. A run of
    // whitespace collapses onto the single space that starts it, so every
    // emitted character keeps exactly one source position.
    let text = "";
    const owner = [];
    const offset = [];
    for (let i = 0; i < nodes.length; i++) {
      const value = nodes[i].nodeValue;
      for (let j = 0; j < value.length; j++) {
        const isSpace = /\\s/.test(value[j]);
        if (isSpace && (text === "" || text.charCodeAt(text.length - 1) === 32)) continue;
        text += isSpace ? " " : value[j];
        owner.push(i);
        offset.push(j);
      }
    }

    const at = text.indexOf(wanted);
    if (at < 0) return false;

    // Group the matched characters back into one run per text node. Offsets
    // within a node only increase, so extending the last run is enough.
    const runs = [];
    for (let k = at; k < at + wanted.length; k++) {
      const last = runs.length ? runs[runs.length - 1] : null;
      if (last && last.node === owner[k]) last.end = offset[k] + 1;
      else runs.push({ node: owner[k], start: offset[k], end: offset[k] + 1 });
    }

    let marked = false;
    for (const run of runs) {
      const node = nodes[run.node];
      const length = node.nodeValue.length;
      if (run.start >= length) continue;
      const end = Math.min(run.end, length);
      // Split the head off first, then the tail, leaving exactly the match.
      const middle = run.start > 0 ? node.splitText(run.start) : node;
      if (end - run.start < middle.nodeValue.length) middle.splitText(end - run.start);
      const mark = document.createElement("mark");
      // The kind rides on the highlight itself: a task asks for a change and is
      // coloured for it, a remark is only context.
      mark.className = "note-mark is-" + note.kind;
      mark.setAttribute("data-note-mark", note.id);
      middle.parentNode.insertBefore(mark, middle);
      mark.appendChild(middle);
      marked = true;
    }
    return marked;
  }

  /**
   * Where a block's pin can legally live. A <button> is not valid as a direct
   * child of <ul>/<ol>/<table>, so it goes in the first item or cell instead —
   * which changes nothing about where it appears, because the pin positions
   * against the nearest positioned ancestor and that is still the block.
   */
  function pinHost(block) {
    const tag = block.tagName;
    if (tag === "UL" || tag === "OL") return block.querySelector("li") || block;
    if (tag === "TABLE") return block.querySelector("th, td") || block;
    return block;
  }

  /** The gutter pin for a block, created on first use. */
  function pinFor(block) {
    let pin = block.querySelector(".note-pin");
    if (pin) return pin;
    pin = document.createElement("button");
    pin.type = "button";
    pin.className = "note-pin";
    pin.setAttribute("data-note-pin", "");
    const host = pinHost(block);
    host.insertBefore(pin, host.firstChild);
    return pin;
  }

  function paint() {
    const blocks = article.querySelectorAll("[data-kb25-notes]");
    for (const block of blocks) {
      const ids = (block.getAttribute("data-kb25-notes") || "").split(" ").filter(Boolean);
      const present = ids.filter((id) => byId.has(id));
      if (!present.length) continue;

      block.classList.add("has-note");
      const kinds = present.map((id) => byId.get(id).kind);
      // One pin stands for every note on the block, so the loudest kind on it
      // wins: a single task among remarks still means something is waiting, an
      // agent note outranks a remark because it is something new said by whoever
      // last changed the page, and a highlight only colours the pin when nothing
      // else does.
      const loudest = kinds.includes("task")
        ? "task"
        : kinds.includes("agent")
          ? "agent"
          : kinds.includes("remark")
            ? "remark"
            : "highlight";
      const pin = pinFor(block);
      pin.classList.toggle("is-task", loudest === "task");
      pin.classList.toggle("is-agent", loudest === "agent");
      pin.classList.toggle("is-remark", loudest === "remark");
      pin.classList.toggle("is-highlight", loudest === "highlight");
      pin.setAttribute("aria-label", present.length + " note" + (present.length === 1 ? "" : "s"));
      pin.title = present.length === 1 ? "1 note" : present.length + " notes";

      for (const id of present) {
        const note = byId.get(id);
        if (note.quote && !markQuote(block, note)) note.drifted = true;
      }
    }
  }

  // --- the controls shared by writing and rewriting --------------------------

  /**
   * The three kinds, in the order the switch offers them and with the tooltip
   * each one carries. Highlight leads and is the default because marking a
   * passage is the most common thing to want and the only one that asks for
   * nothing: no words, no work for anyone reading the page later.
   */
  const KINDS = [
    ["highlight", "Highlight", "Marks the phrase — nothing to write"],
    ["remark", "Remark", "Context, not an instruction"],
    ["task", "Task", "Something an agent should change"],
  ];

  /**
   * What each kind is called on a card. Read from here rather than from KINDS,
   * because that table is what the switch *offers* and an agent note is the one
   * kind nobody can write: it needs a name without becoming an option.
   */
  const LABELS = { highlight: "Highlight", remark: "Remark", task: "Task", agent: "Agent" };

  /** A kind's label, falling back to Task the way the parser does. */
  function kindLabel(kind) {
    return LABELS[kind] || "Task";
  }

  /** What the text box asks for, which is nothing at all for a highlight. */
  function placeholderFor(kind) {
    if (kind === "highlight") return "Optional — a highlight needs no words";
    if (kind === "remark") return "Context worth keeping";
    return "What should change here?";
  }

  /**
   * The Highlight/Remark/Task switch. The composer and the in-place editor share
   * it, so a note can be re-typed as another kind with the same three words it
   * was first typed with. Callers read the kind() getter when they submit rather
   * than tracking the choice themselves; onChange exists only so the text box can
   * say whether it still needs filling in.
   */
  function kindPicker(current, onChange) {
    const element = document.createElement("div");
    element.className = "note-kinds";
    let kind = KINDS.some((option) => option[0] === current) ? current : "task";
    for (const option of KINDS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className =
        "note-kind-option is-" + option[0] + (option[0] === kind ? " is-selected" : "");
      button.textContent = option[1];
      button.title = option[2];
      button.addEventListener("click", () => {
        kind = option[0];
        for (const sibling of element.children) {
          sibling.classList.toggle("is-selected", sibling === button);
        }
        if (onChange) onChange(kind);
      });
      element.appendChild(button);
    }
    return { element: element, kind: () => kind };
  }

  /** The note text box, prefilled when an existing note is being rewritten. */
  function noteField(text, kind) {
    const field = document.createElement("textarea");
    field.className = "note-input";
    field.rows = 3;
    field.value = text;
    field.placeholder = placeholderFor(kind);
    return field;
  }

  function actionButton(label, tone) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button " + tone;
    button.textContent = label;
    return button;
  }

  // --- the note popover ----------------------------------------------------

  let popover = null;
  let popoverAnchor = null;

  function closePopover() {
    if (!popover) return;
    popover.remove();
    popover = null;
    popoverAnchor = null;
    const active = article.querySelectorAll(".note-mark.is-active");
    for (const mark of active) mark.classList.remove("is-active");
  }

  /**
   * A note's words, with the links in them as real links.
   *
   * The server ships a note that has links as segments — runs of plain text and
   * runs that are one — with every [[wiki-link]] already resolved to where it
   * points now. A note without any ships none and is drawn as one string. Both
   * paths reach the DOM through createElement and text nodes, so a note can
   * carry a link without being able to carry markup.
   */
  function paintNoteText(target, note) {
    if (!note.segments) {
      target.textContent = note.text;
      return;
    }
    for (const segment of note.segments) {
      if (!segment.href) {
        target.appendChild(document.createTextNode(segment.text));
        continue;
      }
      const link = document.createElement("a");
      link.href = segment.href;
      link.textContent = segment.text;
      target.appendChild(link);
    }
  }

  /**
   * One note in the popover, drawn either for reading or for editing its text
   * and kind in place. Both modes come from the same function so the head —
   * kind, age, author — is identical either way and only the part below it
   * swaps; editing a note is not a different panel, it is the same card.
   */
  function noteCard(note) {
    const card = document.createElement("div");
    card.className = "note-card";

    const head = () => {
      const row = document.createElement("div");
      row.className = "note-card-head";
      const kind = document.createElement("span");
      kind.className = "note-kind is-" + note.kind;
      kind.textContent = kindLabel(note.kind);
      row.appendChild(kind);
      const when = document.createElement("span");
      when.className = "note-when";
      // The pink chip already names an agent as the writer, so printing its
      // by= line beside it would only say the same word twice.
      const by = note.kind === "agent" ? "" : note.by;
      when.textContent = [relativeTime(note.at), by].filter(Boolean).join(" · ");
      row.appendChild(when);
      return row;
    };

    const draw = (editing) => {
      card.textContent = "";
      card.appendChild(head());

      // A quote is shown here only when it could not be highlighted in the prose,
      // where it would otherwise be the one thing pointing at what drifted.
      if (note.quote && note.drifted) {
        const quote = document.createElement("div");
        quote.className = "note-quote";
        quote.textContent = "\\u201c" + note.quote + "\\u201d";
        card.appendChild(quote);
      }

      const actions = document.createElement("div");
      actions.className = "note-card-actions";

      if (editing) {
        const field = noteField(note.text, note.kind);
        card.appendChild(field);

        const picker = kindPicker(note.kind, (kind) => {
          field.placeholder = placeholderFor(kind);
        });
        actions.appendChild(picker.element);

        const cancel = actionButton("Cancel", "secondary");
        cancel.addEventListener("click", (event) => swap(false, event));
        actions.appendChild(cancel);

        const save = actionButton("Save", "primary");
        const submit = () => {
          const text = field.value.trim();
          // A highlight is the mark itself, so it is the one kind that saves with
          // an empty box — including a task or remark retyped into one, which
          // drops the words it no longer needs.
          if (!text && picker.kind() !== "highlight") {
            field.focus();
            return;
          }
          save.disabled = true;
          send({ op: "edit", noteId: note.id, text: text, kind: picker.kind() }, save);
        };
        save.addEventListener("click", submit);
        actions.appendChild(save);

        card.appendChild(actions);
        field.addEventListener("keydown", (event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit();
          // Escape backs out of the editor and nothing more — swap() keeps the
          // keypress from the document handler, which would close the popover.
          if (event.key === "Escape") swap(false, event);
        });
        field.focus();
        return;
      }

      // A highlight has no words of its own — the mark in the prose is the whole
      // note — so the card shows its head and its actions and nothing between.
      if (note.text) {
        const body = document.createElement("div");
        body.className = "note-text";
        paintNoteText(body, note);
        card.appendChild(body);
      }

      // A note from an agent is the agent's own words: it can be taken down but
      // not have words put in its mouth, so it gets no Edit. The route refuses
      // one too — this only keeps the button from promising what it can't do.
      if (note.kind !== "agent") {
        const edit = actionButton("Edit", "secondary");
        edit.addEventListener("click", (event) => swap(true, event));
        actions.appendChild(edit);
      }

      const resolve = actionButton("Resolve", "secondary");
      resolve.addEventListener("click", () => {
        resolve.disabled = true;
        send({ op: "resolve", noteId: note.id }, resolve);
      });
      actions.appendChild(resolve);

      card.appendChild(actions);
    };

    /**
     * Change mode, then re-pin the popover for the height it now wants.
     *
     * The click that got us here is stopped short of the document: redrawing
     * detaches the very button that was clicked, and the outside-click handler
     * would then find no popover above that orphan and close the card out from
     * under the editor it just opened.
     */
    const swap = (editing, event) => {
      if (event) event.stopPropagation();
      draw(editing);
      reposition();
    };

    draw(false);
    return card;
  }

  function openPopover(anchor, ids) {
    closePopover();
    const shown = ids.map((id) => byId.get(id)).filter(Boolean);
    if (!shown.length) return;

    popover = document.createElement("div");
    popover.className = "note-popover";
    popover.setAttribute("role", "dialog");
    for (const note of shown) popover.appendChild(noteCard(note));
    popoverAnchor = anchor;
    document.body.appendChild(popover);
    place(popover, anchor.getBoundingClientRect());
  }

  /**
   * Re-pin the popover after a card changed height. The editor is taller than
   * the note it replaces, so a popover that opened low in the window would
   * otherwise grow off the bottom of it.
   */
  function reposition() {
    if (popover && popoverAnchor) place(popover, popoverAnchor.getBoundingClientRect());
  }

  /** Pin a fixed-position panel under a rect, kept inside the viewport. */
  function place(panel, rect) {
    const width = panel.offsetWidth;
    const left = Math.min(Math.max(12, rect.left), window.innerWidth - width - 12);
    const below = rect.bottom + 8;
    const fitsBelow = below + panel.offsetHeight < window.innerHeight - 12;
    const top = fitsBelow ? below : rect.top - panel.offsetHeight - 8;
    // Neither side always fits — a note low in the window with its editor open
    // is the tall case — so the panel is pulled back inside the viewport rather
    // than left hanging over an edge.
    const lowest = Math.max(12, window.innerHeight - panel.offsetHeight - 12);
    panel.style.left = left + "px";
    panel.style.top = Math.max(12, Math.min(top, lowest)) + "px";
  }

  // --- writing ---------------------------------------------------------------

  function send(fields, button) {
    const body = new URLSearchParams(fields);
    fetch("/_notes/" + slug, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    })
      .then((response) => {
        // A session that expired redirects to the login page; reloading lands
        // the reader there rather than failing silently.
        if (response.redirected) {
          window.location.reload();
          return null;
        }
        return response.json().catch(() => ({ ok: false, error: "Could not save the note." }));
      })
      .then((result) => {
        if (!result) return;
        if (result.ok) window.location.reload();
        else fail(result.error || "Could not save the note.", button);
      })
      .catch(() => fail("Could not reach the server.", button));
  }

  function fail(message, button) {
    if (button) button.disabled = false;
    const toast = document.createElement("div");
    toast.className = "toast is-error";
    toast.setAttribute("role", "status");
    toast.textContent = message;
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add("is-visible"));
    setTimeout(() => {
      toast.classList.remove("is-visible");
      setTimeout(() => toast.remove(), 320);
    }, 3200);
  }

  // --- composing from a selection --------------------------------------------

  let pending = null;
  let addButton = null;
  let composer = null;

  /**
   * The current selection as an anchor, or null. A selection is clipped to the
   * block that holds its start: a quote spanning two blocks is text no single
   * block contains, so it could never be found again.
   */
  function selectionAnchor() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    const range = selection.getRangeAt(0);
    if (!article.contains(range.commonAncestorContainer)) return null;

    let node = range.startContainer;
    if (node.nodeType === 1 && range.startOffset < node.childNodes.length) {
      node = node.childNodes[range.startOffset];
    }
    const element = node && node.nodeType === 1 ? node : node && node.parentElement;
    const block = element && element.closest ? element.closest("[data-src-line]") : null;
    if (!block || !article.contains(block)) return null;

    const clipped = range.cloneRange();
    if (!block.contains(clipped.startContainer)) clipped.setStart(block, 0);
    if (!block.contains(clipped.endContainer)) clipped.setEnd(block, block.childNodes.length);

    const quote = normalize(clipped.toString());
    if (!quote) return null;

    return {
      line: block.getAttribute("data-src-line"),
      hash: block.getAttribute("data-src-hash"),
      quote: quote,
      rect: clipped.getBoundingClientRect(),
    };
  }

  function hideAddButton() {
    if (addButton) addButton.remove();
    addButton = null;
  }

  function showAddButton(anchor) {
    hideAddButton();
    addButton = document.createElement("button");
    addButton.type = "button";
    addButton.className = "note-add";
    addButton.textContent = "Add note";
    // Without this the button's own mousedown collapses the selection before
    // the click handler ever sees it.
    addButton.addEventListener("mousedown", (event) => event.preventDefault());
    addButton.addEventListener("click", () => openComposer(anchor));
    document.body.appendChild(addButton);
    place(addButton, anchor.rect);
  }

  function closeComposer() {
    if (composer) composer.remove();
    composer = null;
  }

  function openComposer(anchor) {
    hideAddButton();
    closeComposer();
    closePopover();

    composer = document.createElement("div");
    composer.className = "note-composer";

    const quote = document.createElement("div");
    quote.className = "note-quote";
    quote.textContent = "\\u201c" + anchor.quote + "\\u201d";
    composer.appendChild(quote);

    const field = noteField("", "highlight");
    composer.appendChild(field);

    const row = document.createElement("div");
    row.className = "note-composer-actions";

    const picker = kindPicker("highlight", (kind) => {
      field.placeholder = placeholderFor(kind);
    });
    row.appendChild(picker.element);

    const cancel = actionButton("Cancel", "secondary");
    cancel.addEventListener("click", closeComposer);
    row.appendChild(cancel);

    const save = actionButton("Save", "primary");
    const submit = () => {
      const text = field.value.trim();
      // Highlight is the default kind, so Save straight after selecting a phrase
      // marks it and nothing else — which is the point of having the kind.
      if (!text && picker.kind() !== "highlight") {
        field.focus();
        return;
      }
      save.disabled = true;
      send(
        {
          op: "add",
          line: anchor.line,
          hash: anchor.hash,
          quote: anchor.quote,
          text: text,
          kind: picker.kind(),
        },
        save
      );
    };
    save.addEventListener("click", submit);
    row.appendChild(save);

    composer.appendChild(row);
    // Cmd/Ctrl+Enter saves, matching the editor's Cmd/Ctrl+S habit.
    field.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit();
      if (event.key === "Escape") closeComposer();
    });

    document.body.appendChild(composer);
    place(composer, anchor.rect);
    field.focus();
  }

  // --- arriving at one particular note ---------------------------------------

  /**
   * Open the note named by a \`#note-<id>\` fragment, which is how the dashboard
   * links to a single task rather than to the top of its page.
   *
   * The anchor is found by walking the candidates and splitting their attribute,
   * the way paint() does, rather than with a \`~=\` selector: a hand-written note
   * gets a positional \`@<line>\` id, which would need escaping to be a valid one.
   * A note that is already resolved leaves the page alone.
   */
  function focusFromHash() {
    // A real element with this id wins. Heading ids share the fragment
    // namespace with \`#note-<id>\`, so a heading called "Note 3f2a91bc" has to
    // scroll to itself rather than open a note that happens to share the tail.
    if (location.hash.length > 1 && document.getElementById(location.hash.slice(1))) return;
    const raw = (location.hash || "").replace(/^#note-/, "");
    if (!raw || raw === location.hash) return;
    // A positional \`@<line>\` id arrives percent-encoded, so the fragment has to
    // be decoded before it can be looked up.
    let id = raw;
    try {
      id = decodeURIComponent(raw);
    } catch (err) {
      id = raw;
    }
    if (!byId.has(id)) return;

    let anchor = null;
    for (const mark of article.querySelectorAll("[data-note-mark]")) {
      if (mark.getAttribute("data-note-mark") === id) {
        anchor = mark;
        break;
      }
    }
    if (anchor) {
      for (const mark of article.querySelectorAll("[data-note-mark]")) {
        if (mark.getAttribute("data-note-mark") === id) mark.classList.add("is-active");
      }
    } else {
      for (const block of article.querySelectorAll("[data-kb25-notes]")) {
        const ids = (block.getAttribute("data-kb25-notes") || "").split(" ").filter(Boolean);
        if (ids.indexOf(id) >= 0) {
          anchor = block.querySelector(".note-pin");
          break;
        }
      }
    }
    if (!anchor) return;

    anchor.scrollIntoView({ block: "center" });
    // After the scroll, so the popover is placed against the rect the anchor
    // ends up with rather than the one it was at.
    openPopover(anchor, [id]);
  }

  // --- wiring ----------------------------------------------------------------

  paint();
  focusFromHash();
  window.addEventListener("hashchange", focusFromHash);

  document.addEventListener("selectionchange", () => {
    if (composer) return; // the composer owns the selection it was opened with
    pending = selectionAnchor();
    if (pending) showAddButton(pending);
    else hideAddButton();
  });

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest(".note-popover, .note-composer, .note-add")) return;

    const pin = target.closest("[data-note-pin]");
    if (pin) {
      const block = pin.closest("[data-kb25-notes]");
      const ids = (block.getAttribute("data-kb25-notes") || "").split(" ").filter(Boolean);
      openPopover(pin, ids);
      return;
    }

    const mark = target.closest("[data-note-mark]");
    if (mark) {
      const id = mark.getAttribute("data-note-mark");
      const marks = article.querySelectorAll('[data-note-mark="' + id + '"]');
      for (const sibling of marks) sibling.classList.add("is-active");
      openPopover(mark, [id]);
      return;
    }

    closePopover();
    closeComposer();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    closePopover();
    closeComposer();
    hideAddButton();
  });
})();
`;

const STYLES = `
:root{
  color-scheme:light;
  --bg:#fff; --fg:#1f2328; --muted:#6b7280; --line:#e5e7eb;
  --accent:#2563eb; --on-accent:#fff; --sidebar:#f7f8fa; --code-bg:#f6f8fa;
  --maxw:1216px;
  --fg-secondary:#374151;
  --surface:#fff; --surface-hover:#eef0f3; --surface-hover-2:#f7f8fa;
  --active-bg:#e7efff; --selected-bg:#dbeafe;
  --mark-bg:#fde68a; --mark-bg-strong:#fcd34d; --mark-fg:#713f12;
  /* A note is teal by default, which is what a remark keeps… */
  --note-bg:#ccfbf1; --note-bg-strong:#99f6e4; --note-fg:#115e59;
  --note-pin:#0d9488; --note-border:#5eead4;
  /* …a task is purple, because it asks for a change and should read as one… */
  --task-bg:#f3e8ff; --task-bg-strong:#e9d5ff; --task-fg:#6b21a8;
  --task-pin:#a855f7; --task-border:#d8b4fe;
  /* …and a highlight is the flat yellow of a highlighter pen, undiluted, because
     a washed-out yellow reads as stained paper rather than as a mark someone
     made. The ink is a dark olive of the same hue, not the brown of the amber
     search mark: the two now say "look here" in visibly different voices. */
  --highlight-bg:#fbff00; --highlight-bg-strong:#e9ed00; --highlight-fg:#3d4000;
  --highlight-pin:#9aa300; --highlight-border:#d8dd00;
  /* An agent note is pink: the one kind the reader did not write, so it wants a
     hue none of theirs uses. Magenta-leaning rather than rose, which keeps it
     off the pale red of the destructive buttons, and carrying more saturation
     than a task's tint, which is what keeps it off that tint's pale lavender —
     the two are hard to tell apart once both are washed out. The only kind
     whose pin needs no per-theme value: this reads on white and on black. */
  --agent-bg:#ffc9e6; --agent-bg-strong:#ffa8d6; --agent-fg:#6b0038;
  --agent-pin:#ff2d87; --agent-border:#ff8ec9;
  --focus-ring:#93c5fd; --focus-ring-soft:#bfdbfe;
  --sidebar-fade:rgba(247,248,250,0); --surface-hover-fade:rgba(238,240,243,0); --active-fade:rgba(231,239,255,0);
  --shadow-sm:0 2px 8px rgba(0,0,0,.08);
  --shadow-md:0 2px 8px rgba(0,0,0,.12);
  --shadow-lg:0 8px 30px rgba(0,0,0,.18);
  --shadow-card:0 1px 4px rgba(0,0,0,.06);
  --backdrop:rgba(15,23,42,.35);
  --diff-add-fg:#166534; --diff-add-bg:#dcfce7;
  --diff-del-fg:#991b1b; --diff-del-bg:#fee2e2;
  --error-fg:#991b1b; --error-bg:#fef2f2; --error-border:#fecaca;
  --success-fg:#166534; --success-bg:#f0fdf4; --success-border:#bbf7d0;
  --warning-fg:#92400e; --warning-bg:#fffbeb; --warning-border:#fde68a;
  --badge-web-fg:#1e40af; --badge-web-bg:#e7efff; --badge-web-border:#c7d7fe;
  --badge-mcp-fg:#6b21a8; --badge-mcp-bg:#f3e8ff; --badge-mcp-border:#e2ccf9;
  --hl-comment:#6a737d; --hl-keyword:#d73a49; --hl-string:#032f62;
  --hl-number:#005cc5; --hl-title:#6f42c1; --hl-attr:#e36209;
}
:root[data-theme="dark"]{
  color-scheme:dark;
  --bg:#0d1117; --fg:#e6edf3; --muted:#8b949e; --line:#30363d;
  --accent:#4493f8; --on-accent:#0d1117; --sidebar:#0b0e14; --code-bg:#161b22;
  --fg-secondary:#c9d1d9;
  --surface:#161b22; --surface-hover:#21262d; --surface-hover-2:#21262d;
  --active-bg:#1f2d44; --selected-bg:#253a5e;
  --mark-bg:#5c4708; --mark-bg-strong:#7a5f0a; --mark-fg:#f5d67b;
  --note-bg:#134e4a; --note-bg-strong:#115e59; --note-fg:#99f6e4;
  --note-pin:#2dd4bf; --note-border:#0f766e;
  --task-bg:#4c1d95; --task-bg-strong:#5b21b6; --task-fg:#e9d5ff;
  --task-pin:#a855f7; --task-border:#6d28d9;
  --highlight-bg:#4a4d00; --highlight-bg-strong:#5f6300; --highlight-fg:#edf37a;
  --highlight-pin:#e2e800; --highlight-border:#6f7400;
  --agent-bg:#5c0f36; --agent-bg-strong:#7a1548; --agent-fg:#ffc9e6;
  --agent-pin:#ff2d87; --agent-border:#a31e5e;
  --focus-ring:#388bfd; --focus-ring-soft:#1f6feb;
  --sidebar-fade:rgba(11,14,20,0); --surface-hover-fade:rgba(33,38,45,0); --active-fade:rgba(31,45,68,0);
  --shadow-sm:0 2px 8px rgba(0,0,0,.5);
  --shadow-md:0 2px 8px rgba(0,0,0,.6);
  --shadow-lg:0 8px 30px rgba(0,0,0,.7);
  --shadow-card:0 1px 4px rgba(0,0,0,.5);
  --backdrop:rgba(1,4,9,.6);
  --diff-add-fg:#7ee787; --diff-add-bg:#12261a;
  --diff-del-fg:#ffa198; --diff-del-bg:#2d1213;
  --error-fg:#ff7b72; --error-bg:#2d1213; --error-border:#5c1a1a;
  --success-fg:#56d364; --success-bg:#12261a; --success-border:#1a4023;
  --warning-fg:#e3b341; --warning-bg:#2b2411; --warning-border:#4a3b12;
  --badge-web-fg:#a8c7fa; --badge-web-bg:#172554; --badge-web-border:#1e3a8a;
  --badge-mcp-fg:#d8b4fe; --badge-mcp-bg:#2e1065; --badge-mcp-border:#4c1d95;
  --hl-comment:#8b949e; --hl-keyword:#ff7b72; --hl-string:#a5d6ff;
  --hl-number:#79c0ff; --hl-title:#d2a8ff; --hl-attr:#ffa657;
}
/* No-JS fallback: honor the OS setting when no explicit choice was made. */
@media (prefers-color-scheme:dark){
  :root:not([data-theme="light"]):not([data-theme="dark"]){
    color-scheme:dark;
    --bg:#0d1117; --fg:#e6edf3; --muted:#8b949e; --line:#30363d;
    --accent:#4493f8; --on-accent:#0d1117; --sidebar:#0b0e14; --code-bg:#161b22;
    --fg-secondary:#c9d1d9;
    --surface:#161b22; --surface-hover:#21262d; --surface-hover-2:#21262d;
    --active-bg:#1f2d44; --selected-bg:#253a5e;
    --mark-bg:#5c4708; --mark-bg-strong:#7a5f0a; --mark-fg:#f5d67b;
    --note-bg:#134e4a; --note-bg-strong:#115e59; --note-fg:#99f6e4;
    --note-pin:#2dd4bf; --note-border:#0f766e;
    --task-bg:#4c1d95; --task-bg-strong:#5b21b6; --task-fg:#e9d5ff;
    --task-pin:#a855f7; --task-border:#6d28d9;
    --highlight-bg:#4a4d00; --highlight-bg-strong:#5f6300; --highlight-fg:#edf37a;
    --highlight-pin:#e2e800; --highlight-border:#6f7400;
    --agent-bg:#5c0f36; --agent-bg-strong:#7a1548; --agent-fg:#ffc9e6;
    --agent-pin:#ff2d87; --agent-border:#a31e5e;
    --focus-ring:#388bfd; --focus-ring-soft:#1f6feb;
    --sidebar-fade:rgba(11,14,20,0); --surface-hover-fade:rgba(33,38,45,0); --active-fade:rgba(31,45,68,0);
    --shadow-sm:0 2px 8px rgba(0,0,0,.5);
    --shadow-md:0 2px 8px rgba(0,0,0,.6);
    --shadow-lg:0 8px 30px rgba(0,0,0,.7);
    --shadow-card:0 1px 4px rgba(0,0,0,.5);
    --backdrop:rgba(1,4,9,.6);
    --diff-add-fg:#7ee787; --diff-add-bg:#12261a;
    --diff-del-fg:#ffa198; --diff-del-bg:#2d1213;
    --error-fg:#ff7b72; --error-bg:#2d1213; --error-border:#5c1a1a;
    --success-fg:#56d364; --success-bg:#12261a; --success-border:#1a4023;
    --warning-fg:#e3b341; --warning-bg:#2b2411; --warning-border:#4a3b12;
    --badge-web-fg:#a8c7fa; --badge-web-bg:#172554; --badge-web-border:#1e3a8a;
    --badge-mcp-fg:#d8b4fe; --badge-mcp-bg:#2e1065; --badge-mcp-border:#4c1d95;
    --hl-comment:#8b949e; --hl-keyword:#ff7b72; --hl-string:#a5d6ff;
    --hl-number:#79c0ff; --hl-title:#d2a8ff; --hl-attr:#ffa657;
  }
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  color:var(--fg); background:var(--bg); display:flex; min-height:100vh;
}
a{color:var(--accent); text-decoration:none}
a:hover{text-decoration:underline}
.sidebar{
  width:300px; flex:0 0 300px; background:var(--sidebar);
  border-right:1px solid var(--line); padding:20px 16px; position:sticky; top:0;
  height:100vh; overflow:auto;
}
.brand{display:block; font-weight:700; font-size:15px; color:var(--fg);
  margin-bottom:16px; letter-spacing:.2px}
.brand:hover{text-decoration:none}
.sidebar-link{
  display:block; margin:0 0 14px; padding:4px 6px; border-radius:6px;
  color:var(--fg-secondary); font-size:14px; font-weight:600;
}
.sidebar-link:hover{background:var(--surface-hover); text-decoration:none}
.sidebar-link.active{background:var(--active-bg); color:var(--accent)}
/* "Create" disclosure: a sidebar link that reveals Page / Folder choices. */
.create-menu{margin:0 0 14px}
.create-menu>summary{margin:0; list-style:none; cursor:pointer}
.create-menu>summary::-webkit-details-marker{display:none}
.create-menu>summary::marker{content:""}
.create-menu-pop{
  margin:6px 0 0; padding:4px; display:flex; flex-direction:column;
  background:var(--surface); border:1px solid var(--line); border-radius:6px;
  box-shadow:var(--shadow-sm);
}
.create-menu-pop form{margin:0}
.create-menu-pop button{
  display:block; width:100%; text-align:left; border:0; background:transparent;
  padding:6px 8px; border-radius:4px; color:var(--fg-secondary); font-size:13px; font-weight:600;
  cursor:pointer; font-family:inherit;
}
.create-menu-pop button:hover{background:var(--surface-hover)}
/* Inline name forms (create-folder + rename) in the Create / ⋯ menus. */
.menu-name-form{display:flex; flex-direction:column; gap:4px; margin:0}
.menu-name-form input[type=text]{
  width:100%; box-sizing:border-box; padding:5px 7px; font-size:13px;
  color:var(--fg); background:var(--surface);
  border:1px solid var(--line); border-radius:4px;
}
/* Folder contents view */
.folder-tag{
  display:inline-block; padding:2px 8px; border-radius:999px;
  background:var(--surface-hover); color:var(--muted); font-size:12px; font-weight:600;
}
.folder-view{margin-top:8px}
.folder-create{display:flex; gap:10px; flex-wrap:wrap; align-items:flex-start; margin-bottom:18px}
.folder-create form{margin:0}
.folder-create .menu-name-form{flex-direction:row; align-items:center}
.folder-create .menu-name-form input[type=text]{width:160px}
.folder-list{list-style:none; padding:0; margin:0; border-top:1px solid var(--line)}
.folder-list li{
  display:flex; align-items:center; gap:6px; padding:9px 4px;
  border-bottom:1px solid var(--line);
}
.folder-list li>a{font-weight:600}
.folder-empty{color:var(--muted); margin:18px 0}
.rename-menu{display:inline-block; position:relative}
.rename-menu>summary{list-style:none; cursor:pointer}
.rename-menu>summary::-webkit-details-marker{display:none}
.rename-menu>summary::marker{content:""}
.rename-menu .menu-name-form{
  position:absolute; right:0; z-index:5; margin-top:6px; width:210px; padding:8px;
  background:var(--surface); border:1px solid var(--line); border-radius:6px;
  box-shadow:var(--shadow-sm);
}
/* Sidebar search: combobox + result panel, scoped to the current space. */
.sidebar-search{position:relative; margin:0 0 14px}
.sidebar-search-input{
  width:100%; padding:6px 8px; border:1px solid var(--line); border-radius:6px;
  background:var(--surface); color:var(--fg); font-size:14px; font-family:inherit;
}
.sidebar-search-input::placeholder{color:var(--muted)}
.sidebar-search-input:focus{outline:2px solid var(--focus-ring-soft); border-color:var(--focus-ring)}
/* Drop WebKit's native clear button so Esc is the one dismiss gesture. */
.sidebar-search-input::-webkit-search-cancel-button{-webkit-appearance:none; appearance:none}
/* The sidebar is the scroll container, so this panel is clipped to it; the input
   sits near the top of a 100vh column, which leaves room for the max-height. */
.sidebar-search-panel{
  position:absolute; left:0; right:0; top:calc(100% + 4px); z-index:20;
  max-height:min(60vh,420px); overflow:auto; padding:4px;
  background:var(--surface); border:1px solid var(--line); border-radius:6px;
  box-shadow:var(--shadow-md);
}
.sidebar-search-item{
  display:block; padding:6px 8px; border-radius:4px; color:var(--fg-secondary);
  overflow-wrap:anywhere; cursor:pointer;
}
.sidebar-search-item:hover{background:var(--surface-hover); text-decoration:none}
.sidebar-search-item.is-active{background:var(--active-bg)}
.sidebar-search-item.is-active .sidebar-search-title{color:var(--accent)}
.sidebar-search-title{display:block; font-size:14px; font-weight:600; color:var(--fg)}
.sidebar-search-crumb{display:block; font-size:11px; color:var(--muted); margin-top:1px}
.sidebar-search-excerpt{
  display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; overflow:hidden;
  font-size:12px; color:var(--muted); margin-top:3px; line-height:1.45;
}
/* Yellow highlight, but the browser default (black on bright yellow) is
   unreadable on a dark surface, so it rides tokens that flip with the theme. */
.sidebar-search-item mark{
  background:var(--mark-bg); color:var(--mark-fg); font-weight:600;
  border-radius:2px; padding:0 1px;
}
.sidebar-search-item.is-active mark{background:var(--mark-bg-strong)}
.sidebar-search-status{padding:6px 8px; font-size:12px; color:var(--muted)}
.sidebar-search-status[hidden]{display:none}
.move-error{
  margin:0 0 14px; padding:8px 10px; border:1px solid var(--error-border);
  border-radius:6px; background:var(--error-bg); color:var(--error-fg); font-size:13px;
}
/* The trailing padding is the overshoot room for a drag aimed at the end of the
   tree: it belongs to the nav, so MOVE_SCRIPT still sees the drag and reads it as
   "append to the space root" instead of letting the page slip past the last row. */
.tree{padding-bottom:24px}
.tree ul{list-style:none; margin:0; padding:0}
.tree .children{margin-left:12px; border-left:1px solid var(--line); padding-left:8px}
.tree a,.tree-label{display:block; padding:3px 6px; border-radius:6px; color:var(--fg-secondary); font-size:14px; overflow-wrap:anywhere; user-select:none}
.tree-label{color:var(--muted); font-weight:600}
.tree a:hover{background:var(--surface-hover); text-decoration:none}
.tree a.active{background:var(--active-bg); color:var(--accent); font-weight:600}
.tree a.selected{background:var(--selected-bg); box-shadow:inset 2px 0 0 var(--accent)}
.tree a[draggable="true"]{cursor:grab}
.tree a.drag-source{opacity:.55}
.tree a.drop-target-active,.space-current.drop-target-active{
  outline:2px solid var(--focus-ring); outline-offset:1px; background:var(--active-bg);
}
/* MOVE_SCRIPT flags the body while a page is in flight. Hinting the space name
   then recovers the affordance the always-visible dashed drop strip provided,
   without spending sidebar space on it the rest of the time. */
body.dragging-page .space-current{
  outline:1px dashed var(--line); outline-offset:2px; border-radius:4px;
}
/* Insertion points between rows. Zero height so the tree keeps its rhythm, and
   the indicator is drawn by a pseudo-element, so the pointer is never "over" a
   line — MOVE_SCRIPT picks one from the row edge under the cursor instead. The
   line inherits its group's indentation, which is what tells the reader which
   group it would drop into where two of them meet at the same height (the
   indicator moves between the two as the cursor crosses that boundary). */
/* pointer-events:none is load-bearing: the 2px indicator below straddles the
   boundary between two rows, and it would otherwise win the hit test over the
   very row edge the pointer is aiming at, swallowing the dragover. */
.tree .drop-line{position:relative; height:0; pointer-events:none}
.tree .drop-line::before{
  content:""; position:absolute; left:0; right:2px; top:-1px; height:2px;
  border-radius:2px; background:var(--accent); opacity:0;
}
.tree .drop-line.drop-line-active::before{opacity:1}
.tree-toggle{
  flex:0 0 auto; width:18px; height:24px; margin:0; padding:0; border:0;
  background:transparent; cursor:pointer; color:var(--muted);
  display:flex; align-items:center; justify-content:center; line-height:1;
}
.tree-toggle::before{content:"\\25B6"; font-size:9px; transition:transform .12s ease; transform:rotate(90deg)}
.tree li.collapsed > .tree-row .tree-toggle::before{transform:rotate(0deg)}
.tree-toggle:hover{color:var(--fg)}
.tree-toggle-spacer{flex:0 0 auto; width:18px}
.tree-folder-icon{flex:0 0 auto; width:14px; height:14px; margin-right:2px; color:var(--muted)}
/* Shares the marker column with .tree-toggle: the 2px side margins centre the
   14px glyph inside the same 18px box, so the dot and the caret sit on one
   vertical axis. Widths here and on .tree-toggle must stay in step. */
.tree-page-dot{flex:0 0 auto; width:14px; height:14px; margin:0 2px; color:var(--muted); opacity:.55}
.tree li.collapsed > .children{display:none}
.tree-row{position:relative; display:flex; align-items:center}
.tree-row>a{
  flex:1; min-width:0;
  display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; overflow:hidden;
}
.tree-menu{position:absolute; right:0; top:0; flex:0 0 auto}
.tree-menu summary{
  list-style:none; cursor:pointer; user-select:none; opacity:0; pointer-events:none;
  display:flex; align-items:center; justify-content:flex-end;
  height:29px; padding:0 6px 0 24px; border-radius:6px;
  color:var(--muted); font-size:14px; line-height:1;
  background:linear-gradient(to right, var(--sidebar-fade) 0, var(--sidebar) 18px);
}
.tree-menu summary::-webkit-details-marker{display:none}
.tree-row:hover .tree-menu summary,.tree-row:focus-within .tree-menu summary,.tree-menu[open] summary{
  opacity:1; pointer-events:auto;
}
.tree-row:hover .tree-menu summary,.tree-row:focus-within .tree-menu summary{
  background:linear-gradient(to right, var(--surface-hover-fade) 0, var(--surface-hover) 18px);
}
.tree-row:has(>a.active) .tree-menu summary{
  background:linear-gradient(to right, var(--active-fade) 0, var(--active-bg) 18px);
}
.tree-menu-pop{
  position:absolute; right:0; top:100%; z-index:10; min-width:150px;
  background:var(--surface); border:1px solid var(--line); border-radius:6px;
  box-shadow:var(--shadow-sm); padding:4px; display:flex; flex-direction:column;
}
.tree-menu-pop form{margin:0}
.tree-menu-pop a,.tree-menu-pop button{
  display:block; width:100%; text-align:left; border:0; background:transparent;
  padding:6px 8px; border-radius:4px; color:var(--fg-secondary); font-size:13px; font-weight:600;
  cursor:pointer; font-family:inherit;
}
.tree-menu-pop a:hover,.tree-menu-pop button:hover{background:var(--surface-hover); text-decoration:none}
.content{flex:1; padding:32px 40px; max-width:calc(var(--maxw) + 80px); width:100%}
/* "On this page". A third flex column so .content keeps its measure, hidden
   whenever the window is too narrow to afford it. min-width:0 and wrapping text
   are load-bearing: body is a flex row, so an unbreakable line in here would
   raise this column's min-content width and scroll the whole page sideways
   instead of being clipped. */
.toc{
  flex:0 0 232px; min-width:0; align-self:flex-start; position:sticky; top:0;
  max-height:100vh; overflow:auto;
  /* Top padding clears .session-corner, which floats at top:12px and is 34px
     tall — without it the rail's own heading sits under the Help button. */
  padding:60px 24px 32px 0;
}
.toc-head{
  color:var(--muted); font-size:11px; font-weight:700; letter-spacing:.06em;
  text-transform:uppercase; margin-bottom:10px;
}
.toc-list{list-style:none; margin:0; padding:0; border-left:1px solid var(--line)}
.toc-item{margin:0}
.toc-item > a{
  display:block; padding:5px 10px; margin-left:-1px;
  border-left:2px solid transparent; overflow-wrap:anywhere;
  color:var(--muted); font-size:13px; line-height:1.4; text-decoration:none;
}
.toc-item[data-depth="1"] > a{padding-left:22px; font-size:12.5px}
.toc-item[data-depth="2"] > a{padding-left:34px; font-size:12.5px}
.toc-item > a:hover{color:var(--fg); text-decoration:none}
/* data-active marks the section and its parent; data-current only the one the
   reader is in. Both are data- attributes rather than the link's ARIA state,
   because this stylesheet ships on every page and a view with no open page is
   asserted to name nothing as current anywhere in its HTML. */
.toc-item[data-active] > a{color:var(--fg-secondary)}
.toc-item[data-current] > a{color:var(--accent); border-left-color:var(--accent)}
@media (max-width:1180px){.toc{display:none}}
.crumbs{color:var(--muted); font-size:13px; margin-bottom:18px}
.crumbs .sep{color:var(--line); margin:0 2px}
.page-head{display:flex; justify-content:space-between; gap:20px; align-items:flex-start}
.page-head h1{font-size:30px; line-height:1.2; margin:0 0 8px}
.meta{margin:0 0 24px}
.tags{display:flex; gap:8px; align-items:center; flex-wrap:wrap}
.tag{background:var(--surface-hover); color:var(--fg-secondary); font-size:12px; padding:2px 8px; border-radius:999px}
.updated{color:var(--muted); font-size:12px}
.tags + .updated{margin-top:8px}
.actions{display:flex; gap:8px; flex:0 0 auto; align-items:center; flex-wrap:wrap}
.action-form{display:inline-flex; margin:0}
.confirm-actions{display:flex; gap:8px; align-items:center; margin-top:16px}
.session-actions{display:inline-flex; align-items:center; gap:8px; margin:0}
.session-user{color:var(--muted); font-size:13px}
.session-corner{position:fixed; top:12px; right:16px; z-index:50;
  display:flex; align-items:center; gap:8px}
/* The corner's two icon buttons share one box; only the theme toggle swaps its
   glyph, so the rules below it stay on that class alone. */
.theme-toggle,.dash-button,.instructions-button{
  display:inline-flex; align-items:center; justify-content:center; flex:0 0 auto;
  width:34px; height:34px; padding:0; border:1px solid var(--line); border-radius:6px;
  background:var(--surface); color:var(--fg-secondary); cursor:pointer;
}
.theme-toggle:hover,.dash-button:hover,.instructions-button:hover{background:var(--surface-hover-2); color:var(--fg)}
.dash-button svg,.instructions-button svg{display:block}
.theme-toggle .theme-icon{display:block}
.theme-toggle .icon-moon{display:none}
:root[data-theme="dark"] .theme-toggle .icon-sun{display:none}
:root[data-theme="dark"] .theme-toggle .icon-moon{display:block}
.help-dialog{
  width:min(520px,92vw); border:1px solid var(--line); border-radius:10px;
  padding:0; color:var(--fg); background:var(--surface); box-shadow:var(--shadow-lg);
}
.help-dialog::backdrop{background:var(--backdrop)}
.help-head{
  display:flex; align-items:center; justify-content:space-between; gap:12px;
  margin:0; padding:16px 20px; border-bottom:1px solid var(--line);
}
.help-head h2{font-size:18px; line-height:1.2; margin:0}
.help-close{
  border:0; background:transparent; cursor:pointer; color:var(--muted);
  font-size:22px; line-height:1; padding:0 4px;
}
.help-close:hover{color:var(--fg)}
.help-section{padding:16px 20px 0}
.help-section:last-child{padding-bottom:20px}
.help-section h3{font-size:14px; margin:0 0 8px}
.help-section p{margin:0; color:var(--fg-secondary); font-size:14px; line-height:1.6}
.help-keys{display:grid; grid-template-columns:auto 1fr; gap:8px 16px; margin:0}
.help-keys dt{display:flex; align-items:center; gap:4px}
.help-keys dd{margin:0; color:var(--fg-secondary); font-size:14px}
.help-keys kbd{
  display:inline-block; border:1px solid var(--line); border-bottom-width:2px;
  border-radius:5px; background:var(--code-bg); padding:1px 6px;
  font:600 12px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
.button{
  display:inline-flex; align-items:center; justify-content:center; min-height:34px;
  border:1px solid var(--line); border-radius:6px; padding:5px 12px;
  font:600 14px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  cursor:pointer;
}
.button:hover{text-decoration:none}
.button.primary{background:var(--accent); border-color:var(--accent); color:var(--on-accent)}
.button.secondary{background:var(--surface); color:var(--fg-secondary)}
.button.secondary:hover{background:var(--surface-hover-2)}
.button.danger{background:var(--surface); border-color:var(--error-border); color:var(--error-fg)}
.button.danger:hover{background:var(--error-bg)}
/* Transient feedback after a "Copy link" action: the clicked control tints, and
   the toast below carries the wording. */
.button.copied{background:var(--success-bg); border-color:var(--success-border); color:var(--success-fg)}
.button.copy-failed{background:var(--error-bg); border-color:var(--error-border); color:var(--error-fg)}
.tree-menu-pop button.copied{color:var(--success-fg)}
.tree-menu-pop button.copy-failed{color:var(--error-fg)}
.tree a.copied{background:var(--success-bg); color:var(--success-fg)}
.tree a.copy-failed{background:var(--error-bg); color:var(--error-fg)}
/* Toast: rises from below the bottom edge, holds a couple of seconds, sinks back.
   Created by COPY_LINK_SCRIPT; the class names stay generic so another action can
   reuse it. z-index clears .session-corner (50); a <dialog> still wins via the
   top layer, which is correct — a modal should cover it. */
.toast{
  position:fixed; left:50%; bottom:24px; z-index:60;
  max-width:min(420px,calc(100vw - 32px)); padding:10px 16px;
  border:1px solid var(--success-border); border-radius:8px;
  background:var(--success-bg); color:var(--success-fg);
  font-size:14px; font-weight:600; text-align:center;
  box-shadow:var(--shadow-md); pointer-events:none;
  opacity:0; transform:translate(-50%,calc(100% + 24px));
  transition:transform .28s ease, opacity .28s ease;
}
.toast.is-visible{opacity:1; transform:translate(-50%,0)}
.toast.is-error{border-color:var(--error-border); background:var(--error-bg); color:var(--error-fg)}
@media(prefers-reduced-motion:reduce){
  /* No travel when less motion was asked for — fade in place instead. */
  .toast{transform:translate(-50%,0); transition:opacity .12s ease}
}
.prose{max-width:var(--maxw)}
.prose h1,.prose h2,.prose h3{line-height:1.25; margin-top:1.6em}
.prose h2{font-size:22px; border-bottom:1px solid var(--line); padding-bottom:.2em}
.prose h3{font-size:18px}
/* Section links. Nothing is sticky above the content, so a #anchor already
   lands at the top of the viewport; the margin is breathing room and clears the
   floating .session-corner. The affordance sits after the heading text because
   the left gutter belongs to .note-pin. */
.prose :is(h1,h2,h3,h4,h5,h6){scroll-margin-top:28px}
.section-link{
  margin-left:.4em; color:var(--muted); text-decoration:none; font-weight:400;
  opacity:0; transition:opacity .12s ease; cursor:pointer;
}
/* Generated, so the glyph stays out of the heading's textContent — see the
   heading_close renderer for why that matters. */
.section-link::before{content:"#"}
@media (prefers-reduced-motion:reduce){.section-link{transition:none}}
.prose :is(h1,h2,h3,h4,h5,h6):hover .section-link,
.section-link:focus-visible{opacity:1}
.section-link:hover{color:var(--accent)}
.section-link.copied{opacity:1; color:var(--success-fg)}
.section-link.copy-failed{opacity:1; color:var(--error-fg)}
@media (hover:none){.section-link{opacity:.5}}
.prose p,.prose ul,.prose ol{margin:.7em 0}
.prose code{background:var(--code-bg); padding:.15em .35em; border-radius:4px;
  font-size:.88em; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.prose pre{background:var(--code-bg); padding:14px 16px; border-radius:8px;
  overflow:auto; border:1px solid var(--line)}
.prose pre code{background:none; padding:0}
.prose pre.mermaid{background:none; border:none; padding:0; text-align:center; overflow:auto}
.prose pre.mermaid:not([data-processed]){visibility:hidden}
.prose blockquote{margin:1em 0; padding:.4em 1em; color:var(--muted);
  border-left:3px solid var(--line)}
.prose table{border-collapse:collapse; width:100%}
.prose th,.prose td{border:1px solid var(--line); padding:6px 10px; text-align:left}
/* height:auto keeps a width-sized image undistorted when max-width shrinks it. */
.prose img{max-width:100%; height:auto}
.wikilink{border-bottom:1px dotted var(--accent)}
/* Inline notes.
   Only annotated blocks become positioning contexts, so an unannotated page
   lays out exactly as it did before this feature existed. The pin sits in the
   left padding of .content (40px, 20px on mobile) — hence the two offsets. */
.prose [data-kb25-notes]{position:relative}
/* A task, a highlight and an agent note each carry their own palette on the
   element, so every rule below stays kind-agnostic and a remark keeps the teal it
   always had. Leaf elements only: swapping the tokens on a container would leak
   into the Remark button of the kind switch nested inside a card. An agent note
   has no .note-kind-option, because the switch never offers it. */
.note-mark.is-task,.note-pin.is-task,.note-kind.is-task,.note-kind-option.is-task{
  --note-bg:var(--task-bg); --note-bg-strong:var(--task-bg-strong);
  --note-fg:var(--task-fg); --note-pin:var(--task-pin); --note-border:var(--task-border);
}
.note-mark.is-highlight,.note-pin.is-highlight,.note-kind.is-highlight,
.note-kind-option.is-highlight{
  --note-bg:var(--highlight-bg); --note-bg-strong:var(--highlight-bg-strong);
  --note-fg:var(--highlight-fg); --note-pin:var(--highlight-pin);
  --note-border:var(--highlight-border);
}
.note-mark.is-agent,.note-pin.is-agent,.note-kind.is-agent{
  --note-bg:var(--agent-bg); --note-bg-strong:var(--agent-bg-strong);
  --note-fg:var(--agent-fg); --note-pin:var(--agent-pin); --note-border:var(--agent-border);
}
.prose mark.note-mark{
  background:var(--note-bg); color:var(--note-fg);
  border-radius:2px; padding:0 .05em; cursor:pointer;
}
.prose mark.note-mark.is-active{background:var(--note-bg-strong)}
.note-pin{
  position:absolute; left:-22px; top:.3em; width:14px; height:14px; padding:0;
  border:2px solid var(--note-pin); border-radius:50%; background:var(--note-pin);
  cursor:pointer; line-height:0;
}
.note-pin.is-remark{background:transparent}
.note-pin:hover{box-shadow:0 0 0 3px var(--note-bg)}
.note-popover,.note-composer{
  position:fixed; z-index:70; width:min(320px,calc(100vw - 24px));
  padding:12px 14px; border:1px solid var(--note-border); border-radius:8px;
  background:var(--surface); color:var(--fg); box-shadow:var(--shadow-lg);
  display:flex; flex-direction:column; gap:10px;
}
.note-card{display:flex; flex-direction:column; gap:6px}
.note-card + .note-card{border-top:1px solid var(--line); padding-top:10px}
.note-card-head{display:flex; align-items:center; gap:8px}
.note-kind{
  font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.04em;
  padding:1px 7px; border-radius:999px;
  background:var(--note-bg); color:var(--note-fg); border:1px solid var(--note-border);
}
.note-kind.is-remark{background:var(--surface-hover); color:var(--muted); border-color:var(--line)}
.note-when{color:var(--muted); font-size:12px}
.note-quote{
  color:var(--muted); font-size:13px; font-style:italic;
  border-left:2px solid var(--note-border); padding-left:8px;
}
/* pre-wrap so a multi-line note keeps the shape its author gave it. */
.note-text{font-size:14px; line-height:1.5; white-space:pre-wrap; overflow-wrap:anywhere}
/* A link in a note is underlined the way a [[wiki-link]] is in the prose: in a
   card this small, colour alone is thin evidence that a phrase is clickable. */
.note-text a{border-bottom:1px dotted var(--accent)}
.note-input{
  width:100%; padding:8px 10px; border:1px solid var(--line); border-radius:6px;
  background:var(--bg); color:var(--fg); font:inherit; font-size:14px; resize:vertical;
}
.note-composer-actions,.note-card-actions{display:flex; align-items:center; gap:8px; flex-wrap:wrap}
/* Three kinds alongside Cancel and Save do not fit across a 320px panel, and a
   clipped third kind is one nobody finds — so the switch takes the full width of
   its own row and splits it evenly. Reading a note shows no switch, so the
   Edit/Resolve row below is unaffected. */
.note-kinds{display:flex; flex:1 0 100%; border:1px solid var(--line); border-radius:6px; overflow:hidden}
.note-kind-option{
  flex:1; padding:4px 8px; text-align:center;
  border:0; background:var(--surface); color:var(--muted);
  font:inherit; font-size:13px; cursor:pointer;
}
.note-kind-option.is-selected{background:var(--note-bg); color:var(--note-fg); font-weight:600}
.note-add{
  position:fixed; z-index:70; padding:5px 12px;
  border:1px solid var(--note-border); border-radius:999px;
  background:var(--note-pin); color:#fff;
  font:inherit; font-size:13px; font-weight:600; cursor:pointer;
  box-shadow:var(--shadow-md);
}
/* Diff / history viewer */
.button.disabled{color:var(--muted); background:var(--surface); cursor:default; opacity:.55}
.button.disabled:hover{background:var(--surface)}
.diff-title{font-weight:400; color:var(--muted)}
.revbar{
  display:flex; flex-wrap:wrap; align-items:center; gap:12px; justify-content:space-between;
  padding:10px 14px; margin:0 0 16px; border:1px solid var(--line); border-radius:8px;
  background:var(--sidebar);
}
.revbar-meta{display:flex; flex-wrap:wrap; align-items:center; gap:10px; min-width:0}
.revbar-nav{display:flex; gap:8px; flex:0 0 auto}
.diff-pos{font-weight:700}
.diff-date{color:var(--muted); font-variant-numeric:tabular-nums}
.diff-subject{
  color:var(--muted); font-size:13px;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
.badge{
  display:inline-block; padding:1px 8px; border-radius:999px; font-size:12px; font-weight:700;
  border:1px solid transparent;
}
.badge-web{color:var(--badge-web-fg); background:var(--badge-web-bg); border-color:var(--badge-web-border)}
.badge-mcp{color:var(--badge-mcp-fg); background:var(--badge-mcp-bg); border-color:var(--badge-mcp-border)}
.diffview{
  max-width:var(--maxw); white-space:pre-wrap; word-wrap:break-word;
  background:var(--code-bg); border:1px solid var(--line); border-radius:8px;
  padding:14px 16px; overflow:auto;
  font:14px/1.7 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
.diffview ins.diff-add{
  text-decoration:none; color:var(--diff-add-fg); background:var(--diff-add-bg);
  border-radius:3px; padding:0 1px;
}
.diffview del.diff-del{
  text-decoration:line-through; color:var(--diff-del-fg); background:var(--diff-del-bg);
  border-radius:3px; padding:0 1px;
}
.diff-sep{display:block; color:var(--muted); text-align:center; user-select:none; margin:.4em 0}
.editor-content{max-width:none}
.editor{max-width:1100px}
.editor-label{display:block; font-size:13px; font-weight:700; margin-bottom:8px}
.editor textarea{
  display:block; width:100%; min-height:62vh; resize:vertical;
  border:1px solid var(--line); border-radius:8px; padding:14px 16px;
  color:var(--fg); background:var(--surface);
  font:14px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
.editor textarea:focus{outline:2px solid var(--focus-ring-soft); border-color:var(--focus-ring)}
.slug-row{display:flex; align-items:center; gap:6px; margin-bottom:6px}
.slug-prefix{color:var(--muted); font:13px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.slug-row input{
  flex:1; border:1px solid var(--line); border-radius:8px; padding:8px 10px;
  color:var(--fg); background:var(--surface);
  font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
.slug-row input:focus{outline:2px solid var(--focus-ring-soft); border-color:var(--focus-ring)}
.slug-hint{color:var(--muted); font-size:12px; margin:0 0 16px}
.form-actions{display:flex; gap:8px; align-items:center; margin-top:12px}
.notice{
  max-width:1100px; margin:0 0 16px; border:1px solid var(--line);
  border-radius:8px; padding:10px 12px; font-size:14px;
}
.notice.error{border-color:var(--error-border); background:var(--error-bg); color:var(--error-fg)}
.notice.success{border-color:var(--success-border); background:var(--success-bg); color:var(--success-fg)}
.notice.warning,.notice.archived{border-color:var(--warning-border); background:var(--warning-bg); color:var(--warning-fg)}
.path-label{color:var(--muted); font-size:12px; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.login-page{
  min-height:100vh; align-items:center; justify-content:center; padding:24px;
  background:var(--sidebar);
}
.login-panel{
  width:100%; max-width:360px; border:1px solid var(--line); border-radius:8px;
  background:var(--surface); padding:24px;
}
.login-panel h1{font-size:24px; line-height:1.2; margin:0 0 4px}
.login-subtitle{color:var(--muted); margin:0 0 20px}
.login-form{display:grid; gap:8px}
.login-form label{font-size:13px; font-weight:700}
.login-form input{
  width:100%; border:1px solid var(--line); border-radius:6px; padding:8px 10px;
  color:var(--fg); background:var(--surface);
  font:15px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}
.login-form input:focus{outline:2px solid var(--focus-ring-soft); border-color:var(--focus-ring)}
.login-form button{margin-top:8px}
.login-panel .notice{max-width:none; margin-bottom:16px}
/* compact highlight.js theme (github-ish) */
.hljs-comment,.hljs-quote{color:var(--hl-comment)}
.hljs-keyword,.hljs-selector-tag,.hljs-literal{color:var(--hl-keyword)}
.hljs-string,.hljs-doctag,.hljs-regexp{color:var(--hl-string)}
.hljs-number,.hljs-built_in{color:var(--hl-number)}
.hljs-title,.hljs-section,.hljs-name{color:var(--hl-title)}
.hljs-attr,.hljs-attribute,.hljs-variable{color:var(--hl-attr)}
/* space switcher in the sidebar */
.space-switcher{margin:0 0 16px}
.space-current{display:block; font-weight:700; font-size:15px; color:var(--fg)}
.space-all{display:block; color:var(--muted); font-size:12px; margin-top:2px}
/* spaces landing page */
.spaces-page{display:block; background:var(--sidebar)}
.spaces-main{max-width:920px; margin:0 auto; padding:40px 24px}
.spaces-head{display:flex; justify-content:space-between; align-items:flex-start; gap:20px; margin-bottom:28px}
.spaces-head h1{font-size:28px; line-height:1.2; margin:0}
.spaces-grid{display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:16px}
.space-card-wrap{position:relative; display:flex}
.space-card{
  flex:1; display:flex; flex-direction:column; gap:6px; padding:18px 18px 20px;
  border:1px solid var(--line); border-radius:10px; background:var(--surface); color:var(--fg);
}
.space-card:hover{text-decoration:none; border-color:var(--focus-ring); box-shadow:var(--shadow-card)}
.space-icon{font-size:26px; line-height:1}
.space-card-title{font-weight:700; font-size:16px}
.space-summary{margin:0; color:var(--muted); font-size:13px; line-height:1.5}
.spaces-grid .empty{color:var(--muted)}
/* Per-space ⋯ menu, floated into the card's top-right corner. */
.space-menu{position:absolute; top:10px; right:10px}
.space-menu>summary{
  list-style:none; cursor:pointer; user-select:none;
  display:flex; align-items:center; justify-content:center;
  width:28px; height:28px; border-radius:6px; opacity:0; transition:opacity .1s ease;
  border:1px solid var(--line); background:var(--surface); color:var(--muted); font-size:16px; line-height:1;
}
.space-menu>summary::-webkit-details-marker{display:none}
.space-menu>summary::marker{content:""}
.space-card-wrap:hover .space-menu>summary,.space-menu[open]>summary{opacity:1}
.space-menu>summary:hover{background:var(--surface-hover-2); color:var(--fg)}
.space-menu-pop{
  position:absolute; right:0; top:32px; z-index:10; min-width:190px;
  background:var(--surface); border:1px solid var(--line); border-radius:6px;
  box-shadow:var(--shadow-md); padding:6px; display:flex; flex-direction:column; gap:4px;
}
.space-menu-pop form{margin:0}
.space-menu-pop>form:not(.menu-name-form)>button,.space-menu-pop>a{
  display:block; width:100%; text-align:left; border:0; background:transparent;
  padding:6px 8px; border-radius:4px; color:var(--fg-secondary); font-size:13px; font-weight:600;
  cursor:pointer; font-family:inherit;
}
.space-menu-pop>form:not(.menu-name-form)>button:hover,.space-menu-pop>a:hover{
  background:var(--surface-hover); text-decoration:none;
}
.space-menu-pop>a{color:var(--error-fg)}
.space-menu-pop .menu-name-form{flex-direction:row; align-items:center; gap:4px}
.space-menu-pop .menu-name-form input[type=text]{flex:1; min-width:0}
.space-menu-pop .menu-name-form button{
  flex:0 0 auto; border:1px solid var(--line); border-radius:4px; background:var(--surface);
  padding:5px 8px; color:var(--fg-secondary); font-size:12px; font-weight:600; cursor:pointer; font-family:inherit;
}
.space-menu-pop .menu-name-form button:hover{background:var(--surface-hover-2)}
.space-confirm .confirm-actions{margin-top:12px}
.new-space-form{display:flex; gap:8px; margin-top:28px}
.new-space-form input{
  flex:1; max-width:360px; border:1px solid var(--line); border-radius:6px; padding:8px 10px;
  color:var(--fg); background:var(--surface);
  font:15px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}
.new-space-form input:focus{outline:2px solid var(--focus-ring-soft); border-color:var(--focus-ring)}
/* Notes dashboard.
   Rides the note palettes already defined for pins and marks — a task is purple
   here for the same reason it is purple on the page it was left on. */
.dash-lede{margin:0 0 20px; color:var(--fg-secondary); font-size:14px}
.stat-row{display:flex; flex-wrap:wrap; gap:12px; margin-bottom:28px}
.stat-card{
  display:flex; flex-direction:column; gap:2px; min-width:96px;
  padding:12px 16px; border:1px solid var(--line); border-radius:8px;
  background:var(--surface);
}
.stat-value{font-size:24px; font-weight:600; line-height:1.1; color:var(--fg)}
.stat-label{font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.04em}
.task-group{margin-bottom:24px}
.task-group-head{
  display:flex; align-items:baseline; gap:8px; margin:0 0 2px;
  font-size:15px; font-weight:600; border:none; padding:0;
}
.task-group-head a{color:var(--fg)}
/* Clipped to one line by height rather than by white-space:nowrap. Nowrap text
   raises the min-content width of everything around it, and .content is a flex
   item sized by its automatic minimum — one long trail widened the whole page. */
.task-crumb{
  margin:0 0 8px; max-height:1.4em; overflow:hidden;
  color:var(--muted); font-size:12px; line-height:1.4;
}
.task-count{
  flex:0 0 auto; padding:1px 8px; border-radius:10px;
  background:var(--task-bg); color:var(--task-fg); font-size:12px; font-weight:600;
}
.task-list{list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:6px}
/* The row is the positioning context for the copy button pinned inside its
   top-right corner; .task-link reserves that corner in its own padding so no
   line of note text ever runs under it. */
.task-item{position:relative}
.task-link{
  display:flex; flex-direction:column; gap:3px;
  padding:10px 104px 10px 14px; border:1px solid var(--line); border-radius:6px;
  border-left:3px solid var(--task-pin); background:var(--surface); color:var(--fg);
}
.task-link:hover{background:var(--surface-hover); text-decoration:none}
/* The note's own handle. The id is shown, not just copied, so a reference pasted
   into a chat can be matched back to the row it came from; what lands on the
   clipboard is that id qualified with its page (space/…/page#id). Quiet until
   pointed at — it sits on every row, and a column of loud chips would compete
   with the notes themselves. */
.task-copy{
  position:absolute; top:9px; right:9px;
  display:inline-flex; align-items:center; gap:5px;
  padding:2px 7px; border:1px solid var(--line); border-radius:6px;
  background:var(--surface); color:var(--muted); cursor:pointer;
  font:11px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
.task-copy:hover{background:var(--surface-hover-2); border-color:var(--task-border); color:var(--fg)}
.task-copy:focus-visible{outline:2px solid var(--focus-ring-soft); outline-offset:1px}
.task-copy.copied{background:var(--success-bg); border-color:var(--success-border); color:var(--success-fg)}
.task-copy.copy-failed{background:var(--error-bg); border-color:var(--error-border); color:var(--error-fg)}
.task-quote{
  color:var(--task-fg); background:var(--task-bg); border-radius:2px;
  align-self:flex-start; padding:0 4px; font-size:13px;
}
.task-text{font-size:14px; line-height:1.45; white-space:pre-wrap}
.task-text.is-empty{color:var(--muted); font-style:italic}
.task-by{color:var(--muted); font-size:12px}
.dash-empty{color:var(--fg-secondary)}
@media(max-width:780px){
  body{flex-direction:column}
  .sidebar{width:auto; flex:none; height:auto; position:static; border-right:none;
    border-bottom:1px solid var(--line)}
  /* iOS Safari zooms the viewport when focusing an input under 16px. */
  .sidebar-search-input{font-size:16px}
  .content{padding:20px}
  .page-head{display:block}
  .actions{margin-bottom:16px}
  /* Too little width to spend 90px of it on an id that is about to be copied
     anyway: the glyph alone keeps the button, and the tooltip keeps the id. */
  .task-copy .task-id{display:none}
  .task-link{padding-right:44px}
  /* Less left padding to hang the pin in, so it tucks in closer. */
  .note-pin{left:-17px; width:11px; height:11px}
}

/* --- space instructions editor -------------------------------------------- */
.instructions-hint{
  margin:0 0 18px; padding:14px 16px;
  border:1px solid var(--line); border-radius:10px;
  background:var(--surface); max-width:70ch;
}
.instructions-hint p{margin:0 0 8px; font-size:0.9rem; line-height:1.5}
.instructions-hint p:last-child{margin-bottom:0}
.instructions-meta{color:var(--muted)}
.instructions-count{
  font-variant-numeric:tabular-nums; color:var(--muted);
  font-size:0.85rem !important;
}
.instructions-count.over{color:var(--error-fg); font-weight:600}
`;
