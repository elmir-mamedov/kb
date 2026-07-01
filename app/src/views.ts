import type { PageNode, SpaceInfo } from "./content.js";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderTree(
  nodes: PageNode[],
  activeSlug: string,
  options: { archiveMode?: boolean; dragEnabled?: boolean; collapsible?: boolean } = {}
): string {
  if (nodes.length === 0) return "";
  const items = nodes
    .map((n) => {
      const isActive = n.slug === activeSlug;
      const cls = isActive ? ' class="active"' : "";
      const dragAttrs = options.dragEnabled
        ? ` draggable="true" data-drag-slug="${escapeHtml(n.slug)}" data-drop-slug="${escapeHtml(n.slug)}"`
        : "";
      const label =
        options.archiveMode && !n.archived
          ? `<span class="tree-label">${escapeHtml(n.title)}</span>`
          : `<a href="${slugPath(n.slug)}"${cls}${dragAttrs}>${escapeHtml(n.title)}</a>`;
      const hasChildren = n.children.length > 0;
      // Expand/collapse control for nodes with children; a spacer keeps leaf
      // labels aligned with their siblings' carets.
      const toggle = options.collapsible
        ? hasChildren
          ? `<button type="button" class="tree-toggle" aria-label="Toggle subpages" aria-expanded="true"></button>`
          : `<span class="tree-toggle-spacer"></span>`
        : "";
      // Only real folders (pure containers) carry the folder icon, so it reads
      // as "container" — distinct from an ordinary content page that merely
      // happens to have child pages.
      const folderIcon = n.isFolder ? FOLDER_ICON : "";
      const row = options.dragEnabled
        ? `<div class="tree-row">${toggle}${folderIcon}${label}${treeMenu(n)}</div>`
        : label;
      const children = hasChildren
        ? `<div class="children">${renderTree(n.children, activeSlug, options)}</div>`
        : "";
      return `<li data-tree-slug="${escapeHtml(n.slug)}">${row}${children}</li>`;
    })
    .join("");
  return `<ul>${items}</ul>`;
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
}

export interface ArchiveView {
  siteTitle: string;
  spaces: SpaceInfo[];
  archiveTree: PageNode[];
  titles: Map<string, string>;
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
  const switcher = `<div class="space-switcher">
    <a class="space-current" href="${slugPath(spaceKey)}">${escapeHtml(spaceLabel)}</a>
    <a class="space-all" href="/">↩ All spaces</a>
  </div>`;
  const spaceRootDrop = isArchiveView
    ? ""
    : `<div class="root-drop" data-drop-slug="${escapeHtml(spaceKey)}">Move to space root</div>
  <div class="move-error" data-move-error hidden></div>`;

  return `<aside class="sidebar">
  <a class="brand" href="/">${escapeHtml(siteTitle)}</a>
  ${switcher}
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
  ${spaceRootDrop}
  <nav class="tree">${renderTree(tree, activeSlug, {
    dragEnabled: !isArchiveView,
    collapsible: !isArchiveView,
  })}</nav>
</aside>`;
}

function sessionActions(username?: string | null): string {
  if (!username) return "";
  return `<form class="session-actions" method="post" action="/_logout">
    <span class="session-user">${escapeHtml(username)}</span>
    <button class="button secondary" type="submit">Log out</button>
  </form>`;
}

/** Help + username + Log out pinned to the top-right corner of the page. */
function sessionCorner(username?: string | null): string {
  if (!username) return "";
  return `<div class="session-corner">
    <button type="button" class="button secondary" data-help-open>Help</button>
    ${sessionActions(username)}
  </div>
${HELP_DIALOG}
<script>${HELP_SCRIPT}</script>`;
}

function actionForm(actionPrefix: string, slug: string, label: string, variant: string): string {
  return `<form class="action-form" method="post" action="${actionPrefix}${slugPath(slug)}">
    <button class="button ${variant}" type="submit">${escapeHtml(label)}</button>
  </form>`;
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
  const downloadLink =
    v.canEdit === false || !v.activeSlug
      ? ""
      : `<a class="button secondary" href="/_download${slugPath(v.activeSlug)}" download>Download</a>`;
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

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
${FAVICON_TAGS}
<title>${escapeHtml(v.title)} · ${escapeHtml(v.siteTitle)}</title>
<style>${STYLES}</style>
</head>
<body>
${sessionCorner(v.username)}
${sidebarHtml(v.siteTitle, v.spaces, v.spaceKey, v.tree, v.activeSlug, v.isArchiveView)}
<main class="content">
  ${breadcrumb(v.activeSlug, v.titles)}
  <header class="page-head">
    <div>
      <h1>${escapeHtml(v.title)}</h1>
      <div class="meta">${metaInner}</div>
    </div>
    <div class="actions">${editLink}${downloadLink}${archiveAction}${deleteAction}${restoreAction}</div>
  </header>
  ${notice}${archivedBanner}
  <article class="prose">${v.contentHtml}</article>
</main>
<script>${EDIT_SHORTCUT_SCRIPT}</script>
${v.isArchiveView ? "" : `<script>${MOVE_SCRIPT}</script>`}
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

  const archivedAt = v.archivedAt ? ` on ${escapeHtml(v.archivedAt)}` : "";
  const archivedBanner = v.isArchived
    ? `<div class="notice archived"><strong>Archived.</strong> This folder is hidden from normal navigation${archivedAt}.</div>`
    : "";
  const notice = v.notice
    ? `<div class="notice ${v.notice.tone}">${escapeHtml(v.notice.text)}</div>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
${FAVICON_TAGS}
<title>${escapeHtml(v.title)} · ${escapeHtml(v.siteTitle)}</title>
<style>${STYLES}</style>
</head>
<body>
${sessionCorner(v.username)}
${sidebarHtml(v.siteTitle, v.spaces, v.spaceKey, v.tree, v.activeSlug, false)}
<main class="content">
  ${breadcrumb(v.activeSlug, v.titles)}
  <header class="page-head">
    <div>
      <h1>${escapeHtml(v.title)}</h1>
      <div class="meta"><span class="folder-tag">Folder</span></div>
    </div>
    <div class="actions">${renameControl}${archiveAction}${deleteAction}${restoreAction}</div>
  </header>
  ${notice}${archivedBanner}
  <section class="folder-view">
    ${createControls}
    ${listing}
  </section>
</main>
<script>${MOVE_SCRIPT}</script>
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
  const slugField = v.activeSlug
    ? `<label class="editor-label" for="slug">URL slug</label>
    <div class="slug-row">
      <span class="slug-prefix">/${parentPrefix ? `${escapeHtml(parentPrefix)}/` : ""}</span>
      <input id="slug" name="slug" type="text" value="${escapeHtml(leaf)}" spellcheck="false" autocapitalize="off" />
    </div>
    <p class="slug-hint">Changes the page URL. Re-parent with drag-and-drop / Move instead.</p>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
${FAVICON_TAGS}
<title>Edit ${escapeHtml(v.title)} · ${escapeHtml(v.siteTitle)}</title>
<style>${STYLES}</style>
</head>
<body>
${sessionCorner(v.username)}
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
<script>${MOVE_SCRIPT}</script>
</body>
</html>`;
}

export function loginLayout(v: LoginView): string {
  const error = v.error
    ? `<div class="notice error">${escapeHtml(v.error)}</div>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
${FAVICON_TAGS}
<title>Sign in · ${escapeHtml(v.siteTitle)}</title>
<style>${STYLES}</style>
</head>
<body class="login-page">
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
  const cards = v.spaces.length
    ? v.spaces
        .map((s) => {
          const icon = s.icon
            ? `<span class="space-icon">${escapeHtml(s.icon)}</span>`
            : "";
          const summary = s.summary
            ? `<p class="space-summary">${escapeHtml(s.summary)}</p>`
            : "";
          return `<a class="space-card" href="${slugPath(s.key)}">
    ${icon}
    <span class="space-card-title">${escapeHtml(s.title)}</span>
    ${summary}
  </a>`;
        })
        .join("")
    : `<p class="empty">No spaces yet — create your first one below.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
${FAVICON_TAGS}
<title>Spaces · ${escapeHtml(v.siteTitle)}</title>
<style>${STYLES}</style>
</head>
<body class="spaces-page">
${sessionCorner(v.username)}
<main class="spaces-main">
  <header class="spaces-head">
    <h1>${escapeHtml(v.siteTitle)}</h1>
    <div class="actions">
      <a class="button secondary" href="/_archive">Archive</a>
    </div>
  </header>
  ${notice}
  <section class="spaces-grid">${cards}</section>
  <form class="new-space-form" method="post" action="/_create-space">
    <input type="text" name="title" placeholder="New space name" aria-label="New space name" maxlength="80" required />
    <button class="button primary" type="submit">New Space</button>
  </form>
</main>
</body>
</html>`;
}

/**
 * Site icon links, shared by every page head. The files live in app/public and
 * are served from the site root (see server.ts). The .ico covers legacy
 * browsers and the automatic /favicon.ico request; the SVG and sized PNGs cover
 * modern tabs, bookmarks, and iOS home-screen shortcuts.
 */
const FAVICON_TAGS = `<link rel="icon" href="/favicon.ico" sizes="any" />
<link rel="icon" type="image/svg+xml" href="/flux.svg" />
<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />`;

/** Inline folder glyph prefixed to section rows in the sidebar tree. */
const FOLDER_ICON = `<svg class="tree-folder-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M1.75 4c0-.69.56-1.25 1.25-1.25h2.94c.33 0 .65.13.88.37l.87.88c.05.04.11.07.18.07H13c.69 0 1.25.56 1.25 1.25v6.06c0 .69-.56 1.25-1.25 1.25H3c-.69 0-1.25-.56-1.25-1.25z"/></svg>`;

/** Help dialog content: a short Flux overview plus the keyboard shortcuts. */
const HELP_DIALOG = `<dialog class="help-dialog" data-help-dialog>
  <form method="dialog" class="help-head">
    <h2>Flux Help</h2>
    <button class="help-close" aria-label="Close help" value="close">&times;</button>
  </form>
  <section class="help-section">
    <h3>About Flux</h3>
    <p>Flux is a lean Markdown knowledge base. Content is organized into <strong>spaces</strong> &mdash; the top-level containers shown on the home page &mdash; and each space holds a tree of pages in the sidebar. Open any page and press <strong>Edit</strong> to change its Markdown; every save is committed to Git automatically. Drag pages in the sidebar to re-organize them, and use the <strong>&ctdot;</strong> menu next to a page to add a child, edit, download, or delete it. <strong>Folders</strong> are pure containers &mdash; they hold pages and other folders but have no content of their own, so you rename them instead of editing them.</p>
  </section>
  <section class="help-section">
    <h3>Keyboard shortcuts</h3>
    <dl class="help-keys">
      <dt><kbd>&#8984;</kbd> / <kbd>Ctrl</kbd> + <kbd>E</kbd></dt>
      <dd>Edit the page you are viewing</dd>
      <dt><kbd>&#8984;</kbd> / <kbd>Ctrl</kbd> + <kbd>S</kbd></dt>
      <dd>Save the page you are editing</dd>
      <dt><kbd>Esc</kbd></dt>
      <dd>Close this dialog</dd>
    </dl>
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

const MOVE_SCRIPT = `
(() => {
  const dragItems = Array.from(document.querySelectorAll("[data-drag-slug]"));
  const dropTargets = Array.from(
    document.querySelectorAll("[data-drop-slug], [data-drop-root]")
  );
  const errorEl = document.querySelector("[data-move-error]");
  let sourceSlug = "";

  function sourceParent(slug) {
    const parts = slug.split("/");
    parts.pop();
    return parts.join("/");
  }

  function showError(message) {
    if (!errorEl) return;
    errorEl.textContent = message;
    errorEl.hidden = false;
    window.setTimeout(() => {
      errorEl.hidden = true;
    }, 5000);
  }

  function clearTargets() {
    for (const target of dropTargets) {
      target.classList.remove("drop-target-active");
    }
  }

  function invalidDrop(target) {
    if (!sourceSlug) return true;
    if (target.hasAttribute("data-drop-root")) {
      return !sourceSlug.includes("/");
    }

    const targetSlug = target.getAttribute("data-drop-slug") || "";
    if (!targetSlug) return true;
    if (targetSlug === sourceSlug) return true;
    if (targetSlug.startsWith(sourceSlug + "/")) return true;
    if (targetSlug === sourceParent(sourceSlug)) return true;
    return false;
  }

  for (const item of dragItems) {
    item.addEventListener("dragstart", (event) => {
      sourceSlug = item.getAttribute("data-drag-slug") || "";
      item.classList.add("drag-source");
      document.body.classList.add("dragging-page");
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", sourceSlug);
      }
    });

    item.addEventListener("dragend", () => {
      sourceSlug = "";
      item.classList.remove("drag-source");
      document.body.classList.remove("dragging-page");
      clearTargets();
    });
  }

  for (const target of dropTargets) {
    target.addEventListener("dragover", (event) => {
      if (invalidDrop(target)) {
        target.classList.remove("drop-target-active");
        return;
      }

      event.preventDefault();
      target.classList.add("drop-target-active");
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "move";
      }
    });

    target.addEventListener("dragleave", () => {
      target.classList.remove("drop-target-active");
    });

    target.addEventListener("drop", async (event) => {
      if (invalidDrop(target)) return;

      event.preventDefault();
      clearTargets();

      const isRoot = target.hasAttribute("data-drop-root");
      const targetSlug = isRoot ? "" : target.getAttribute("data-drop-slug") || "";
      const body = new URLSearchParams({
        sourceSlug,
        targetKind: isRoot ? "root" : "page",
        targetSlug,
      });

      try {
        const response = await fetch("/_move", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
        });
        const result = await response.json();
        if (!response.ok || !result.ok) {
          showError(result.error || "Move failed.");
          return;
        }
        window.location.href = result.url;
      } catch {
        showError("Move failed.");
      }
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
  const treeItems = Array.from(document.querySelectorAll(".tree li[data-tree-slug]"));
  for (const li of treeItems) {
    const toggle = li.querySelector(":scope > .tree-row .tree-toggle");
    if (!toggle) continue;
    const slug = li.getAttribute("data-tree-slug") || "";
    if (collapsed.has(slug)) {
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
})();
`;

const STYLES = `
:root{
  --bg:#fff; --fg:#1f2328; --muted:#6b7280; --line:#e5e7eb;
  --accent:#2563eb; --sidebar:#f7f8fa; --code-bg:#f6f8fa;
  --maxw:760px;
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
  color:#374151; font-size:14px; font-weight:600;
}
.sidebar-link:hover{background:#eef0f3; text-decoration:none}
.sidebar-link.active{background:#e7efff; color:var(--accent)}
/* "Create" disclosure: a sidebar link that reveals Page / Folder choices. */
.create-menu{margin:0 0 14px}
.create-menu>summary{margin:0; list-style:none; cursor:pointer}
.create-menu>summary::-webkit-details-marker{display:none}
.create-menu>summary::marker{content:""}
.create-menu-pop{
  margin:6px 0 0; padding:4px; display:flex; flex-direction:column;
  background:#fff; border:1px solid var(--line); border-radius:6px;
  box-shadow:0 2px 8px rgba(0,0,0,.08);
}
.create-menu-pop form{margin:0}
.create-menu-pop button{
  display:block; width:100%; text-align:left; border:0; background:transparent;
  padding:6px 8px; border-radius:4px; color:#374151; font-size:13px; font-weight:600;
  cursor:pointer; font-family:inherit;
}
.create-menu-pop button:hover{background:#eef0f3}
/* Inline name forms (create-folder + rename) in the Create / ⋯ menus. */
.menu-name-form{display:flex; flex-direction:column; gap:4px; margin:0}
.menu-name-form input[type=text]{
  width:100%; box-sizing:border-box; padding:5px 7px; font-size:13px;
  border:1px solid var(--line); border-radius:4px;
}
/* Folder contents view */
.folder-tag{
  display:inline-block; padding:2px 8px; border-radius:999px;
  background:#eef0f3; color:var(--muted); font-size:12px; font-weight:600;
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
  background:#fff; border:1px solid var(--line); border-radius:6px;
  box-shadow:0 2px 8px rgba(0,0,0,.08);
}
.root-drop{
  margin:0 0 14px; padding:5px 6px; border:1px dashed var(--line);
  border-radius:6px; color:var(--muted); font-size:13px; font-weight:600;
}
.move-error{
  margin:0 0 14px; padding:8px 10px; border:1px solid #fecaca;
  border-radius:6px; background:#fef2f2; color:#991b1b; font-size:13px;
}
.tree ul{list-style:none; margin:0; padding:0}
.tree .children{margin-left:12px; border-left:1px solid var(--line); padding-left:8px}
.tree a,.tree-label{display:block; padding:3px 6px; border-radius:6px; color:#374151; font-size:14px; overflow-wrap:anywhere}
.tree-label{color:var(--muted); font-weight:600}
.tree a:hover{background:#eef0f3; text-decoration:none}
.tree a.active{background:#e7efff; color:var(--accent); font-weight:600}
.tree a[draggable="true"]{cursor:grab}
.tree a.drag-source{opacity:.55}
.tree a.drop-target-active,.root-drop.drop-target-active{
  outline:2px solid #93c5fd; outline-offset:1px; background:#e7efff;
}
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
  background:linear-gradient(to right, rgba(247,248,250,0) 0, var(--sidebar) 18px);
}
.tree-menu summary::-webkit-details-marker{display:none}
.tree-row:hover .tree-menu summary,.tree-row:focus-within .tree-menu summary,.tree-menu[open] summary{
  opacity:1; pointer-events:auto;
}
.tree-row:hover .tree-menu summary,.tree-row:focus-within .tree-menu summary{
  background:linear-gradient(to right, rgba(238,240,243,0) 0, #eef0f3 18px);
}
.tree-row:has(>a.active) .tree-menu summary{
  background:linear-gradient(to right, rgba(231,239,255,0) 0, #e7efff 18px);
}
.tree-menu-pop{
  position:absolute; right:0; top:100%; z-index:10; min-width:150px;
  background:#fff; border:1px solid var(--line); border-radius:6px;
  box-shadow:0 2px 8px rgba(0,0,0,.08); padding:4px; display:flex; flex-direction:column;
}
.tree-menu-pop form{margin:0}
.tree-menu-pop a,.tree-menu-pop button{
  display:block; width:100%; text-align:left; border:0; background:transparent;
  padding:6px 8px; border-radius:4px; color:#374151; font-size:13px; font-weight:600;
  cursor:pointer; font-family:inherit;
}
.tree-menu-pop a:hover,.tree-menu-pop button:hover{background:#eef0f3; text-decoration:none}
.content{flex:1; padding:32px 40px; max-width:calc(var(--maxw) + 80px); width:100%}
.crumbs{color:var(--muted); font-size:13px; margin-bottom:18px}
.crumbs .sep{color:var(--line); margin:0 2px}
.page-head{display:flex; justify-content:space-between; gap:20px; align-items:flex-start}
.page-head h1{font-size:30px; line-height:1.2; margin:0 0 8px}
.meta{margin:0 0 24px}
.tags{display:flex; gap:8px; align-items:center; flex-wrap:wrap}
.tag{background:#eef0f3; color:#374151; font-size:12px; padding:2px 8px; border-radius:999px}
.updated{color:var(--muted); font-size:12px}
.tags + .updated{margin-top:8px}
.actions{display:flex; gap:8px; flex:0 0 auto; align-items:center; flex-wrap:wrap}
.action-form{display:inline-flex; margin:0}
.confirm-actions{display:flex; gap:8px; align-items:center; margin-top:16px}
.session-actions{display:inline-flex; align-items:center; gap:8px; margin:0}
.session-user{color:var(--muted); font-size:13px}
.session-corner{position:fixed; top:12px; right:16px; z-index:50;
  display:flex; align-items:center; gap:8px}
.help-dialog{
  width:min(520px,92vw); border:1px solid var(--line); border-radius:10px;
  padding:0; color:var(--fg); box-shadow:0 8px 30px rgba(0,0,0,.18);
}
.help-dialog::backdrop{background:rgba(15,23,42,.35)}
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
.help-section p{margin:0; color:#374151; font-size:14px; line-height:1.6}
.help-keys{display:grid; grid-template-columns:auto 1fr; gap:8px 16px; margin:0}
.help-keys dt{display:flex; align-items:center; gap:4px}
.help-keys dd{margin:0; color:#374151; font-size:14px}
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
.button.primary{background:var(--accent); border-color:var(--accent); color:#fff}
.button.secondary{background:#fff; color:#374151}
.button.secondary:hover{background:#f7f8fa}
.button.danger{background:#fff; border-color:#fecaca; color:#991b1b}
.button.danger:hover{background:#fef2f2}
.prose{max-width:var(--maxw)}
.prose h1,.prose h2,.prose h3{line-height:1.25; margin-top:1.6em}
.prose h2{font-size:22px; border-bottom:1px solid var(--line); padding-bottom:.2em}
.prose h3{font-size:18px}
.prose p,.prose ul,.prose ol{margin:.7em 0}
.prose code{background:var(--code-bg); padding:.15em .35em; border-radius:4px;
  font-size:.88em; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.prose pre{background:var(--code-bg); padding:14px 16px; border-radius:8px;
  overflow:auto; border:1px solid var(--line)}
.prose pre code{background:none; padding:0}
.prose blockquote{margin:1em 0; padding:.4em 1em; color:var(--muted);
  border-left:3px solid var(--line)}
.prose table{border-collapse:collapse; width:100%}
.prose th,.prose td{border:1px solid var(--line); padding:6px 10px; text-align:left}
.prose img{max-width:100%}
.wikilink{border-bottom:1px dotted var(--accent)}
.editor-content{max-width:none}
.editor{max-width:1100px}
.editor-label{display:block; font-size:13px; font-weight:700; margin-bottom:8px}
.editor textarea{
  display:block; width:100%; min-height:62vh; resize:vertical;
  border:1px solid var(--line); border-radius:8px; padding:14px 16px;
  color:var(--fg); background:#fff;
  font:14px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
.editor textarea:focus{outline:2px solid #bfdbfe; border-color:#93c5fd}
.slug-row{display:flex; align-items:center; gap:6px; margin-bottom:6px}
.slug-prefix{color:var(--muted); font:13px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.slug-row input{
  flex:1; border:1px solid var(--line); border-radius:8px; padding:8px 10px;
  color:var(--fg); background:#fff;
  font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
.slug-row input:focus{outline:2px solid #bfdbfe; border-color:#93c5fd}
.slug-hint{color:var(--muted); font-size:12px; margin:0 0 16px}
.form-actions{display:flex; gap:8px; align-items:center; margin-top:12px}
.notice{
  max-width:1100px; margin:0 0 16px; border:1px solid var(--line);
  border-radius:8px; padding:10px 12px; font-size:14px;
}
.notice.error{border-color:#fecaca; background:#fef2f2; color:#991b1b}
.notice.success{border-color:#bbf7d0; background:#f0fdf4; color:#166534}
.notice.warning,.notice.archived{border-color:#fde68a; background:#fffbeb; color:#92400e}
.path-label{color:var(--muted); font-size:12px; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.login-page{
  min-height:100vh; align-items:center; justify-content:center; padding:24px;
  background:var(--sidebar);
}
.login-panel{
  width:100%; max-width:360px; border:1px solid var(--line); border-radius:8px;
  background:#fff; padding:24px;
}
.login-panel h1{font-size:24px; line-height:1.2; margin:0 0 4px}
.login-subtitle{color:var(--muted); margin:0 0 20px}
.login-form{display:grid; gap:8px}
.login-form label{font-size:13px; font-weight:700}
.login-form input{
  width:100%; border:1px solid var(--line); border-radius:6px; padding:8px 10px;
  font:15px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}
.login-form input:focus{outline:2px solid #bfdbfe; border-color:#93c5fd}
.login-form button{margin-top:8px}
.login-panel .notice{max-width:none; margin-bottom:16px}
/* compact highlight.js theme (github-ish) */
.hljs-comment,.hljs-quote{color:#6a737d}
.hljs-keyword,.hljs-selector-tag,.hljs-literal{color:#d73a49}
.hljs-string,.hljs-doctag,.hljs-regexp{color:#032f62}
.hljs-number,.hljs-built_in{color:#005cc5}
.hljs-title,.hljs-section,.hljs-name{color:#6f42c1}
.hljs-attr,.hljs-attribute,.hljs-variable{color:#e36209}
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
.space-card{
  display:flex; flex-direction:column; gap:6px; padding:18px 18px 20px;
  border:1px solid var(--line); border-radius:10px; background:#fff; color:var(--fg);
}
.space-card:hover{text-decoration:none; border-color:#93c5fd; box-shadow:0 1px 4px rgba(0,0,0,.06)}
.space-icon{font-size:26px; line-height:1}
.space-card-title{font-weight:700; font-size:16px}
.space-summary{margin:0; color:var(--muted); font-size:13px; line-height:1.5}
.spaces-grid .empty{color:var(--muted)}
.new-space-form{display:flex; gap:8px; margin-top:28px}
.new-space-form input{
  flex:1; max-width:360px; border:1px solid var(--line); border-radius:6px; padding:8px 10px;
  font:15px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}
.new-space-form input:focus{outline:2px solid #bfdbfe; border-color:#93c5fd}
@media(max-width:780px){
  body{flex-direction:column}
  .sidebar{width:auto; flex:none; height:auto; position:static; border-right:none;
    border-bottom:1px solid var(--line)}
  .content{padding:20px}
  .page-head{display:block}
  .actions{margin-bottom:16px}
}
`;
