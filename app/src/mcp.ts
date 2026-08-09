#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { Content, flatten, isFolderPage, type PageNode, type TreeFilter } from "./content.js";
import { makeGit } from "./git.js";
import { parseNotes, type Note, type NoteKind } from "./notes.js";
import { mapWithConcurrency, searchPages } from "./search.js";
import { syncFromEnv } from "./sync.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

loadEnvFile(path.join(__dirname, "..", "..", ".env"));
loadEnvFile(path.join(__dirname, "..", ".env"));

const KB_DIR = path.resolve(
  process.env.KB_DIR ?? path.join(__dirname, "..", "..", "kb")
);
const SITE_TITLE = process.env.SITE_TITLE ?? "Knowledge Base";
const VERSION = "0.1.0";

const content = new Content(KB_DIR);
// Multi-machine sync, off unless KB_SYNC is set. This process writes to the same
// repos as the web server, so it hooks the same commit callback.
const sync = syncFromEnv(KB_DIR);
const git = makeGit(KB_DIR, sync ? (repoRoot) => sync.notifyCommit(repoRoot) : undefined);

interface ListedPage {
  slug: string;
  /** Stable page id; use it in `[[id:<id>]]` links so they survive moves. */
  id?: string;
  title: string;
  path: string;
  isSection: boolean;
  /** True when this is a pure container (folder), not a content page. */
  isFolder: boolean;
  archived: boolean;
  archivedAt?: string;
  children: ListedPage[];
}

interface SearchMatch {
  slug: string;
  /** Stable page id; use it in `[[id:<id>]]` links so they survive moves. */
  id?: string;
  title: string;
  path: string;
  archived: boolean;
  tags: string[];
  summary?: string;
  excerpt: string;
  score: number;
}

function loadEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;

  const source = fs.readFileSync(filePath, "utf8");
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;

    const value = rawValue.replace(/^(['"])(.*)\1$/, "$2");
    process.env[key] = value;
  }
}

function cleanSlug(slug: string): string {
  return slug.replace(/^\/+|\/+$/g, "");
}

function kbRelPath(fsPath: string): string {
  const relPath = path.relative(KB_DIR, fsPath);
  if (!relPath || relPath.startsWith("..") || path.isAbsolute(relPath)) {
    return "";
  }
  return relPath.split(path.sep).join("/");
}

function pageUri(slug: string): string {
  return `kb://page/${encodeURI(slug)}`;
}

function listedPage(node: PageNode): ListedPage {
  return {
    slug: node.slug,
    id: node.id,
    title: node.title,
    path: kbRelPath(node.fsPath),
    isSection: node.isSection,
    isFolder: node.isFolder,
    archived: node.archived,
    archivedAt: node.archivedAt,
    children: node.children.map(listedPage),
  };
}

function asJsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function textResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : asJsonText(value),
      },
    ],
  };
}

function errorResult(message: string) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: message,
      },
    ],
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function listPages(filter: TreeFilter, space?: string): Promise<ListedPage[]> {
  const nodes = space
    ? await content.spaceTree(space, filter)
    : await content.tree(filter);
  return nodes.map(listedPage);
}

/**
 * `searchPages` reports each hit's absolute `fsPath`; MCP clients want the
 * KB-relative one, so swap it here and keep the tool's JSON shape unchanged.
 */
async function searchMatches(
  query: string,
  filter: TreeFilter,
  limit: number,
  space?: string
): Promise<SearchMatch[]> {
  const hits = await searchPages(content, query, { filter, limit, space });
  // Spelled out rather than spread so the emitted key order stays put.
  return hits.map((hit) => ({
    slug: hit.slug,
    id: hit.id,
    title: hit.title,
    path: kbRelPath(hit.fsPath),
    archived: hit.archived,
    tags: hit.tags,
    summary: hit.summary,
    excerpt: hit.excerpt,
    score: hit.score,
  }));
}

/** A note plus enough of its page to act on it without another lookup. */
interface ListedNote extends Note {
  page: { slug: string; id?: string; title: string; path: string };
}

/**
 * Every inline note across the KB, or within one space or page.
 *
 * Scoping to a space goes through the full tree rather than `spaceTree`, which
 * deliberately omits the space's own landing page — a note left there is still a
 * note, and silently skipping it would be the worst kind of miss.
 */
async function collectNotes(
  filter: TreeFilter,
  opts: { space?: string; slug?: string; kind?: NoteKind }
): Promise<ListedNote[]> {
  let nodes: PageNode[];
  if (opts.slug !== undefined) {
    const top = await content.tree(filter);
    const node = flatten(top).find((n) => n.slug === cleanSlug(opts.slug!));
    nodes = node ? [node] : [];
  } else if (opts.space) {
    const top = await content.tree(filter);
    const key = content.spaceKeyOf(opts.space);
    const node = key ? top.find((n) => n.slug === key) : undefined;
    nodes = node ? flatten([node]) : [];
  } else {
    nodes = flatten(await content.tree(filter));
  }

  const pages = await mapWithConcurrency(nodes, 32, async (node) => {
    if (node.isFolder) return null; // a pure container has no body to annotate
    try {
      return await content.load(node.slug);
    } catch {
      return null; // skip pages with unreadable or invalid frontmatter
    }
  });

  const found: ListedNote[] = [];
  for (const page of pages) {
    if (!page) continue;
    for (const note of parseNotes(page.body)) {
      if (opts.kind && note.kind !== opts.kind) continue;
      found.push({
        ...note,
        page: {
          slug: page.slug,
          id: page.data.id,
          title: page.data.title,
          path: kbRelPath(page.fsPath),
        },
      });
    }
  }
  return found;
}

const filterSchema = z.enum(["live", "archived", "all"]);

const server = new McpServer(
  {
    name: "flux-kb",
    version: VERSION,
  },
  {
    instructions:
      "Read and write access to the Markdown knowledge base. The KB is organized into spaces (top-level containers; the first segment of every page slug). Each space is its own git repo, so every page must live inside a space. A folder is a pure container (no body): it only holds pages and other folders — it is not a content page, cannot be updated, and is excluded from kb_search. Read with kb_list_spaces, kb_search, kb_get_page, kb_list_pages (each listed page reports isFolder), and kb_list_notes; pass `space` to kb_list_pages, kb_search or kb_list_notes to scope to a single space. Write with kb_create_page (single-shot create from title + body), kb_create_folder (a pure container), kb_update_page (replace a page's raw Markdown — rejected for folders), kb_rename_folder (change a folder's display name), kb_archive_page / kb_restore_page (toggle archived state), kb_move_page (re-parent), kb_rename_page (change a page's URL slug), kb_delete_page (permanent), and kb_create_space (new top-level container). Every write is auto-committed to its space's git repo as `... via mcp`. LINKING: every page has a stable `id` (returned by kb_get_page, kb_list_pages, kb_search, and the create tools). To link to another page from Markdown, prefer a wiki-link by id — `[[id:<id>]]` or `[[id:<id>|Link text]]` — which keeps resolving even after the target is moved or renamed; a slug-based link like `[[space/some/slug]]` or `[text](/space/some/slug)` breaks when the target moves. INLINE NOTES: a page's Markdown may contain `<!-- flux:note id=... kind=task|remark ... -->` comments, each anchored directly above the block it refers to, with the annotated phrase on a `> ` line inside it. These are messages left for you, usually from the web UI. A `task` asks for a change to that part of the page; a `remark` is context to respect, not act on. Find them with kb_list_notes. To resolve a task, make the edit and delete that note's comment in the same kb_update_page call — never delete a note without addressing it, and never leave one you have acted on. Do not add or reword notes as a side effect of an unrelated edit; preserve the ones you were not asked about.",
  }
);

server.registerTool(
  "kb_list_spaces",
  {
    title: "List KB Spaces",
    description: "Return the spaces — the top-level containers, each holding a tree of pages.",
    inputSchema: {
      filter: filterSchema.optional().describe("Which spaces to include. Defaults to live."),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  async ({ filter }) => {
    return textResult({
      siteTitle: SITE_TITLE,
      spaces: await content.spaces(filter ?? "live"),
    });
  }
);

server.registerTool(
  "kb_list_pages",
  {
    title: "List KB Pages",
    description:
      "Return the knowledge-base navigation tree. Top-level entries are spaces; pass `space` to list one space's pages.",
    inputSchema: {
      filter: filterSchema.optional().describe("Which pages to include. Defaults to live."),
      space: z
        .string()
        .optional()
        .describe("Limit to a single space (its top-level folder key, e.g. flux)."),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  async ({ filter, space }) => {
    const selectedFilter = filter ?? "live";
    return textResult({
      siteTitle: SITE_TITLE,
      filter: selectedFilter,
      space: space ?? null,
      pages: await listPages(selectedFilter, space),
    });
  }
);

server.registerTool(
  "kb_get_page",
  {
    title: "Get KB Page",
    description:
      "Read a page by slug as parsed Markdown or raw source. The result includes the page's stable `id` — use it to link here with `[[id:<id>]]` so the link survives future moves.",
    inputSchema: {
      slug: z
        .string()
        .describe("Page slug, for example engineering/runbooks/deploy. Use an empty string for the home page."),
      format: z.enum(["parsed", "raw"]).optional().describe("Defaults to parsed."),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  async ({ slug, format }) => {
    const clean = cleanSlug(slug);

    if (format === "raw") {
      const page = await content.loadRaw(clean);
      if (!page) return errorResult(`Page not found: ${clean || "(home)"}`);
      return textResult({
        slug: page.slug,
        path: kbRelPath(page.fsPath),
        raw: page.raw,
      });
    }

    let page: Awaited<ReturnType<Content["load"]>>;
    try {
      page = await content.load(clean);
    } catch (err) {
      return errorResult(errorMessage(err));
    }
    if (!page) return errorResult(`Page not found: ${clean || "(home)"}`);

    // A folder has no body — return its contents listing instead.
    if (isFolderPage(page.data)) {
      const tree = await content.spaceTree(content.spaceKeyOf(page.slug));
      const node = flatten(tree).find((n) => n.slug === page.slug);
      return textResult({
        slug: page.slug,
        id: page.data.id,
        title: page.data.title,
        isFolder: true,
        frontmatter: page.data,
        path: kbRelPath(page.fsPath),
        children: (node?.children ?? []).map(listedPage),
      });
    }

    return textResult({
      slug: page.slug,
      id: page.data.id,
      title: page.data.title,
      isFolder: false,
      frontmatter: page.data,
      path: kbRelPath(page.fsPath),
      body: page.body,
      // Also parsed out, because `body` shows where each note sits but reading
      // the position out of raw comment syntax is needless work.
      notes: parseNotes(page.body),
    });
  }
);

server.registerTool(
  "kb_list_notes",
  {
    title: "List KB Notes",
    description:
      "Return the inline notes left on pages — messages anchored to one specific block of a page's Markdown. Call this to find work waiting in the knowledge base (\"address my notes\"). A `task` note asks for a change to the page; a `remark` is context to read and respect, not act on. Each note reports the `quote` it was attached to, so you can find the exact text it refers to. Addressing a task means editing the prose AND deleting that note's `<!-- flux:note ... -->` comment in the same kb_update_page call — a note is resolved by removing it, and git keeps the history.",
    inputSchema: {
      slug: z.string().optional().describe("Limit to a single page, by slug."),
      space: z
        .string()
        .optional()
        .describe("Limit to a single space (its top-level folder key, e.g. flux)."),
      kind: z.enum(["task", "remark"]).optional().describe("Limit to one kind of note."),
      filter: filterSchema.optional().describe("Which pages to include. Defaults to live."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Maximum notes returned. Defaults to 50."),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  async ({ slug, space, kind, filter, limit }) => {
    const selectedFilter = filter ?? "live";
    const selectedLimit = limit ?? 50;
    const found = await collectNotes(selectedFilter, { space, slug, kind });
    return textResult({
      filter: selectedFilter,
      space: space ?? null,
      slug: slug ?? null,
      kind: kind ?? null,
      total: found.length,
      notes: found.slice(0, selectedLimit),
    });
  }
);

server.registerTool(
  "kb_search",
  {
    title: "Search KB",
    description: "Search page titles, slugs, tags, summaries, and Markdown body text.",
    inputSchema: {
      query: z.string().min(1).describe("Search query."),
      filter: filterSchema.optional().describe("Which pages to include. Defaults to live."),
      limit: z.number().int().min(1).max(50).optional().describe("Maximum matches. Defaults to 10."),
      space: z
        .string()
        .optional()
        .describe("Limit search to a single space (its top-level folder key, e.g. flux)."),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  async ({ query, filter, limit, space }) => {
    const selectedFilter = filter ?? "live";
    const selectedLimit = limit ?? 10;
    return textResult({
      query,
      filter: selectedFilter,
      limit: selectedLimit,
      space: space ?? null,
      matches: await searchMatches(query, selectedFilter, selectedLimit, space),
    });
  }
);

function commitTarget(mutation: { isSection: boolean; slug: string; fsPath: string }): string {
  return mutation.isSection ? mutation.slug : git.kbRelPath(mutation.fsPath);
}

server.registerTool(
  "kb_create_page",
  {
    title: "Create KB Page",
    description:
      "Create a new page from a title and Markdown body inside a space or page. The title becomes the page slug; a leaf-page parent is auto-promoted into a section. Every page must live inside a space, so the parent is required (a space key like `flux`, or a deeper page slug); use kb_create_space for a new space.",
    inputSchema: {
      parent: z
        .string()
        .describe("Parent slug — a space key or deeper page, e.g. flux or flux/runbooks. A leaf parent becomes a section. Required; pages cannot be created at the root."),
      title: z.string().min(1).describe("Page title; also slugified into the filename."),
      body: z.string().optional().describe("Markdown body (without frontmatter). Defaults to a heading."),
      tags: z.array(z.string()).optional().describe("Optional frontmatter tags."),
      summary: z.string().optional().describe("Optional frontmatter summary."),
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
  },
  async ({ parent, title, body, tags, summary }) => {
    try {
      const mutation = await content.createPage(parent ?? "", title, body ?? "", { tags, summary });
      const message = `Create ${git.kbRelPath(mutation.fsPath)} via mcp`;
      const commit = mutation.changedFsPaths
        ? await git.commitMovedPaths(mutation.changedFsPaths, message)
        : await git.commitFiles([mutation.fsPath], message);
      return textResult({
        created: true,
        slug: mutation.slug,
        id: mutation.id,
        path: git.kbRelPath(mutation.fsPath),
        commit,
      });
    } catch (err) {
      return errorResult(errorMessage(err));
    }
  }
);

server.registerTool(
  "kb_create_folder",
  {
    title: "Create KB Folder",
    description:
      "Create a folder — a pure container — inside a space or page. A folder only holds pages and other folders; it has no body and is not a content page (use kb_create_page for that). Drop items into it with kb_move_page or by creating them under it. A leaf-page parent is auto-promoted into a section. Every folder must live inside a space, so the parent is required; use kb_create_space for a new top-level space.",
    inputSchema: {
      parent: z
        .string()
        .describe("Parent slug — a space key or deeper page, e.g. flux or flux/runbooks. Required; folders cannot be created at the root."),
      title: z.string().min(1).describe("Folder display name; also slugified into the (stable) folder URL."),
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
  },
  async ({ parent, title }) => {
    try {
      const mutation = await content.createFolder(parent ?? "", title);
      const message = `Create ${git.kbRelPath(mutation.fsPath)} via mcp`;
      const commit = mutation.changedFsPaths
        ? await git.commitMovedPaths(mutation.changedFsPaths, message)
        : await git.commitFiles([mutation.fsPath], message);
      return textResult({
        created: true,
        slug: mutation.slug,
        id: mutation.id,
        path: git.kbRelPath(mutation.fsPath),
        commit,
      });
    } catch (err) {
      return errorResult(errorMessage(err));
    }
  }
);

server.registerTool(
  "kb_rename_folder",
  {
    title: "Rename KB Folder",
    description:
      "Change a folder's display name. Only the name changes — the folder's URL slug stays stable (use kb_move_page to relocate it). Applies to folders only; content pages use kb_update_page / kb_rename_page.",
    inputSchema: {
      slug: z.string().min(1).describe("Folder slug, e.g. flux/runbooks."),
      name: z.string().min(1).describe("New display name for the folder."),
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
  },
  async ({ slug, name }) => {
    try {
      const mutation = await content.renameFolder(slug, name);
      if (!mutation) return errorResult(`Folder not found: ${cleanSlug(slug)}`);
      const commit = mutation.changedFsPaths.length
        ? await git.commitFiles(mutation.changedFsPaths, `Rename folder ${mutation.slug} via mcp`)
        : null;
      return textResult({ renamed: true, slug: mutation.slug, path: git.kbRelPath(mutation.fsPath), commit });
    } catch (err) {
      return errorResult(errorMessage(err));
    }
  }
);

server.registerTool(
  "kb_update_page",
  {
    title: "Update KB Page",
    description:
      "Replace a page's entire Markdown source, including frontmatter. The frontmatter must be valid (a title is required). Read the current source first with kb_get_page (format: raw). Folders have no body and are rejected — use kb_rename_folder to rename one.",
    inputSchema: {
      slug: z.string().describe("Page slug, e.g. engineering/runbooks/deploy."),
      markdown: z.string().describe("Full replacement Markdown source, including YAML frontmatter."),
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
  },
  async ({ slug, markdown }) => {
    try {
      const mutation = await content.updateRaw(slug, markdown);
      if (!mutation) return errorResult(`Page not found: ${cleanSlug(slug) || "(home)"}`);
      const commit = await git.commitFiles(
        [mutation.fsPath],
        `Update ${git.kbRelPath(mutation.fsPath)} via mcp`
      );
      return textResult({ updated: true, slug: mutation.slug, path: git.kbRelPath(mutation.fsPath), commit });
    } catch (err) {
      return errorResult(errorMessage(err));
    }
  }
);

server.registerTool(
  "kb_archive_page",
  {
    title: "Archive KB Page",
    description:
      "Archive a page (or an entire section subtree). Archiving sets frontmatter flags rather than deleting; it is reversible with kb_restore_page.",
    inputSchema: {
      slug: z.string().min(1).describe("Page or section slug to archive."),
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
  },
  async ({ slug }) => {
    try {
      const mutation = await content.updateArchive(slug, true);
      if (!mutation) return errorResult(`Page not found: ${cleanSlug(slug)}`);
      const commit = await git.commitFiles(
        mutation.changedFsPaths,
        `Archive ${commitTarget(mutation)} via mcp`
      );
      return textResult({
        archived: true,
        slug: mutation.slug,
        isSection: mutation.isSection,
        changed: mutation.changedFsPaths.map(git.kbRelPath),
        commit,
      });
    } catch (err) {
      return errorResult(errorMessage(err));
    }
  }
);

server.registerTool(
  "kb_restore_page",
  {
    title: "Restore KB Page",
    description: "Restore a previously archived page (or section subtree), clearing its archived frontmatter flags.",
    inputSchema: {
      slug: z.string().min(1).describe("Page or section slug to restore."),
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
  },
  async ({ slug }) => {
    try {
      const mutation = await content.updateArchive(slug, false);
      if (!mutation) return errorResult(`Page not found: ${cleanSlug(slug)}`);
      const commit = await git.commitFiles(
        mutation.changedFsPaths,
        `Restore ${commitTarget(mutation)} via mcp`
      );
      return textResult({
        restored: true,
        slug: mutation.slug,
        isSection: mutation.isSection,
        changed: mutation.changedFsPaths.map(git.kbRelPath),
        commit,
      });
    } catch (err) {
      return errorResult(errorMessage(err));
    }
  }
);

server.registerTool(
  "kb_move_page",
  {
    title: "Move KB Page",
    description:
      "Move or rename a page or section under a new parent. A leaf destination is converted into a section. The slug changes to reflect the new location.",
    inputSchema: {
      sourceSlug: z.string().min(1).describe("Slug of the page or section to move."),
      targetParent: z
        .string()
        .optional()
        .describe("Destination parent slug. Omit or use an empty string to move to the root."),
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
  },
  async ({ sourceSlug, targetParent }) => {
    try {
      const mutation = await content.movePage(sourceSlug, targetParent || null);
      if (!mutation) return errorResult(`Page not found: ${cleanSlug(sourceSlug)}`);
      const commit = await git.commitMovedPaths(
        mutation.changedFsPaths,
        `Move ${mutation.oldSlug} to ${mutation.newSlug} via mcp`
      );
      return textResult({ moved: true, oldSlug: mutation.oldSlug, newSlug: mutation.newSlug, commit });
    } catch (err) {
      return errorResult(errorMessage(err));
    }
  }
);

server.registerTool(
  "kb_rename_page",
  {
    title: "Rename KB Page",
    description:
      "Change a page's URL slug — its last path segment — while keeping it in the same parent. Re-parent with kb_move_page instead. Collisions are auto-suffixed (e.g. notes -> notes-2).",
    inputSchema: {
      slug: z.string().min(1).describe("Current page or section slug."),
      newName: z.string().min(1).describe("New last path segment; slugified to be URL-safe."),
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
  },
  async ({ slug, newName }) => {
    try {
      const mutation = await content.renamePage(slug, newName);
      if (!mutation) return errorResult(`Page not found: ${cleanSlug(slug)}`);
      if (mutation.newSlug === mutation.oldSlug) {
        return textResult({ renamed: false, slug: mutation.oldSlug, note: "Slug unchanged." });
      }
      const commit = await git.commitMovedPaths(
        mutation.changedFsPaths,
        `Rename ${mutation.oldSlug} to ${mutation.newSlug} via mcp`
      );
      return textResult({ renamed: true, oldSlug: mutation.oldSlug, newSlug: mutation.newSlug, commit });
    } catch (err) {
      return errorResult(errorMessage(err));
    }
  }
);

server.registerTool(
  "kb_delete_page",
  {
    title: "Delete KB Page",
    description:
      "Permanently delete a page, or an entire section subtree, from the knowledge base. This cannot be undone except via Git history; prefer kb_archive_page when in doubt.",
    inputSchema: {
      slug: z.string().min(1).describe("Page or section slug to delete."),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    },
  },
  async ({ slug }) => {
    try {
      const mutation = await content.deletePage(slug);
      if (!mutation) return errorResult(`Page not found: ${cleanSlug(slug)}`);
      const commit = await git.commitFiles(
        mutation.deletedFsPaths,
        `Delete ${commitTarget(mutation)} via mcp`
      );
      return textResult({
        deleted: true,
        slug: mutation.slug,
        isSection: mutation.isSection,
        deletedPaths: mutation.deletedFsPaths.map(git.kbRelPath),
        commit,
      });
    } catch (err) {
      return errorResult(errorMessage(err));
    }
  }
);

server.registerTool(
  "kb_create_space",
  {
    title: "Create KB Space",
    description:
      "Create a new space: a top-level container with its own index.md home page. The title is slugified into the space key.",
    inputSchema: {
      title: z.string().min(1).describe("Space title; also slugified into the space key."),
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
  },
  async ({ title }) => {
    try {
      const mutation = await content.createSpace(title);
      // A new space is its own git repo: initialize it before committing the
      // scaffolding (index.md, _assets/.gitkeep, .gitignore) into it.
      await git.initSpaceRepo(mutation.slug);
      const commit = await git.commitFiles(
        mutation.changedFsPaths ?? [mutation.fsPath],
        `Create ${git.kbRelPath(mutation.fsPath)} via mcp`
      );
      return textResult({ created: true, slug: mutation.slug, id: mutation.id, path: git.kbRelPath(mutation.fsPath), commit });
    } catch (err) {
      return errorResult(errorMessage(err));
    }
  }
);

server.registerResource(
  "kb_page",
  new ResourceTemplate("kb://page/{+slug}", {
    list: async () => {
      const nodes = flatten(await content.tree("live"));
      return {
        resources: nodes.map((node) => ({
          uri: pageUri(node.slug),
          name: node.slug,
          title: node.title,
          description: node.archived ? "Archived knowledge-base page" : "Knowledge-base page",
          mimeType: "text/markdown",
        })),
      };
    },
    complete: {
      slug: async (value) => {
        const nodes = flatten(await content.tree("live"));
        return nodes
          .map((node) => node.slug)
          .filter((slug) => slug.startsWith(value))
          .slice(0, 50);
      },
    },
  }),
  {
    title: "KB Page",
    description: "Markdown content for a knowledge-base page.",
    mimeType: "text/markdown",
  },
  async (uri, variables) => {
    const variable = variables.slug;
    const slug = cleanSlug(Array.isArray(variable) ? variable.join("/") : variable);
    const page = await content.loadRaw(slug);
    if (!page) {
      throw new Error(`Page not found: ${slug || "(home)"}`);
    }

    return {
      contents: [
        {
          uri: uri.toString(),
          mimeType: "text/markdown",
          text: page.raw,
        },
      ],
    };
  }
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`flux-kb MCP server running on stdio; KB_DIR=${KB_DIR}`);
  // Pull *after* connecting, never before: MCP clients enforce a startup timeout
  // (10s by default per flux/install-mcp-on-new-machine.md), and blocking that on
  // a network round-trip could stop the server coming up at all. A slightly stale
  // first tool call is the cheaper failure.
  void sync?.pullAll();
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(message);
  process.exit(1);
});
