#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { Content, flatten, isFolderPage, type PageNode, type TreeFilter } from "./content.js";
import { makeGit } from "./git.js";
import { collectNotes } from "./note-index.js";
import { parseNotes, splitFrontmatter, type Note, type NoteKind } from "./notes.js";
import { addAgentNote, resolveAgentNote } from "./note-write.js";
import { searchPages } from "./search.js";
import { extractSections } from "./markdown.js";
import {
  instructionsPayload,
  isInstructionsSlug,
  loadSpaceInstructions,
  makeInstructionsTokens,
  missingTokenMessage,
  type InstructionsPayload,
} from "./space-instructions.js";
import { syncFromEnv } from "./sync.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

loadEnvFile(path.join(__dirname, "..", "..", ".env"));
loadEnvFile(path.join(__dirname, "..", ".env"));

const KB_DIR = path.resolve(
  process.env.KB_DIR ?? path.join(__dirname, "..", "..", "kb")
);
const SITE_TITLE = process.env.SITE_TITLE ?? "Knowledge Base";
/**
 * The `by=` line on a note this server writes. Fixed, not a tool parameter: the
 * web side does not let a writer choose its own byline either (it comes from
 * AUTH_USERNAME), and a parameter would let a model sign a pink note with a
 * person's name.
 */
const NOTE_AUTHOR = "agent";
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
  /**
   * The heading the match falls under, for linking straight to that part of the
   * page. Absent when only the title/slug/tags matched, or when the match sits
   * above the page's first heading.
   */
  section?: { anchor: string; text: string };
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
    section: hit.section,
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
 * The sweep itself lives in `note-index.ts`, shared with the web dashboard. This
 * only swaps each page's absolute `fsPath` for the KB-relative one MCP clients
 * expect — spelled out rather than spread so the emitted key order stays put.
 */
async function collectListedNotes(
  filter: TreeFilter,
  opts: { space?: string; slug?: string; kind?: NoteKind }
): Promise<ListedNote[]> {
  const found = await collectNotes(content, filter, opts);
  return found.map((note) => ({
    ...note,
    page: {
      slug: note.page.slug,
      id: note.page.id,
      title: note.page.title,
      path: kbRelPath(note.page.fsPath),
    },
  }));
}

const filterSchema = z.enum(["live", "archived", "all"]);

/**
 * Per-space standing orders, and the read-before-write gate around them.
 *
 * The tokens are per-process, which is per-session: the server is stdio only and
 * the client spawns one process per connection, so a token cannot be carried
 * over from a previous session. See `space-instructions.ts` for why that matters.
 */
const instructionTokens = makeInstructionsTokens();

/** The `spaceInstructionsToken` param shared by every space-scoped write tool. */
const instructionTokenSchema = z
  .string()
  .optional()
  .describe(
    "The `spaceInstructions.token` value from a tool result scoped to this space (or from kb_get_space_instructions) — a short opaque string. Pass that token only, never the instruction text itself. Required when the space has standing instructions; omit it for spaces that have none. If this call is refused, the current instructions and a fresh token come back with the refusal — follow them and retry once."
  );

/**
 * Attach a space's instructions to a result, when it has any.
 *
 * Read from disk on every call. `Content.load` shares the mtime-keyed parse
 * cache, so a repeat read costs one `fs.stat` — which is what lets an edit made
 * in the browser reach the model on the very next tool call, with no restart.
 */
async function withInstructions<T extends object>(
  spaceKey: string,
  payload: T
): Promise<T & { spaceInstructions?: InstructionsPayload }> {
  const instructions = await loadSpaceInstructions(content, spaceKey);
  if (!instructions) return payload;
  return { ...payload, spaceInstructions: instructionsPayload(instructions, instructionTokens) };
}

/** Space keys that carry instructions — the roster for cross-space results. */
async function instructedSpaces(filter: TreeFilter): Promise<string[]> {
  const spaces = await content.spaces(filter);
  const flags = await Promise.all(
    spaces.map(async (space) => ((await loadSpaceInstructions(content, space.key)) ? space.key : null))
  );
  return flags.filter((key): key is string => key !== null);
}

/**
 * Refuse a write into an instructed space unless the caller proves it received
 * those instructions this session. Returns an error result to hand straight
 * back, or null when the write may proceed.
 *
 * A space with no instructions is never gated — otherwise adding this feature
 * would break every write in every space that has not authored a file yet.
 */
async function gateWrite(spaceKey: string, provided: string | undefined) {
  const instructions = await loadSpaceInstructions(content, spaceKey);
  if (!instructions) return null;
  if (instructionTokens.verify(spaceKey, instructions.text, provided)) return null;
  const stale = typeof provided === "string" && provided.trim() !== "";
  return errorResult(missingTokenMessage(instructions, instructionTokens, stale));
}

/**
 * A fresh token for a successful write's result, so a create → update chain
 * needs only the one read that opened it.
 */
async function writeToken(spaceKey: string): Promise<{ spaceInstructionsToken?: string }> {
  const instructions = await loadSpaceInstructions(content, spaceKey);
  if (!instructions) return {};
  return { spaceInstructionsToken: instructionTokens.tokenFor(spaceKey, instructions.text) };
}

/**
 * Keep the tools off a space's instructions file. These are the human's standing
 * orders; a model quietly loosening its own constraints is the failure you cannot
 * diagnose from the page it produced.
 */
function refuseInstructionsPath(slug: string) {
  if (!isInstructionsSlug(slug)) return null;
  return errorResult(
    "A space's instructions are edited only from the Flux web UI (the Space instructions button, top right). They are the space owner's standing orders, so the tools will not change them. You can read them with kb_get_space_instructions."
  );
}

const server = new McpServer(
  {
    name: "flux-kb",
    version: VERSION,
  },
  {
    instructions:
      "Read and write access to the Markdown knowledge base. The KB is organized into spaces: top-level containers, each its own git repo, and the first segment of every page slug — so every page must live inside a space. Every write is auto-committed to its space's repo as `... via mcp`. SPACE INSTRUCTIONS: a space may carry standing instructions written by its owner — language, register, formatting, standing domain context — that govern everything you write there and how you answer questions about it. They arrive as a `spaceInstructions` block on any tool result scoped to one space, and they are binding: follow them in preference to your own defaults, and do not restate or negotiate them. Where a space has them, writing into it also requires passing that block's `token` back as the write tool's `spaceInstructionsToken` — so read a space before you write to it. The token changes whenever a person edits the instructions; a refused write returns the current text and a fresh token, so retry once with those. `kb_get_space_instructions` fetches them directly, and `kb_list_spaces` reports which spaces have them. LINKING: every page has a stable `id`, returned by the read and create tools. Prefer a wiki-link by id — `[[id:<id>]]` or `[[id:<id>|Link text]]` — which keeps resolving even after the target is moved or renamed; a slug-based link like `[[space/some/slug]]` or `[text](/space/some/slug)` breaks when the target moves. To point at one section of a page rather than the whole thing, append its anchor: `[[id:<id>#<anchor>]]` or `[[space/some/slug#<anchor>]]`. Anchors come back in `kb_get_page`'s `sections` and on each `kb_search` match — read them, do not guess them from the heading text.",
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
    const selectedFilter = filter ?? "live";
    const instructed = await instructedSpaces(selectedFilter);
    return textResult({
      siteTitle: SITE_TITLE,
      spaces: (await content.spaces(selectedFilter)).map((space) => ({
        ...space,
        hasInstructions: instructed.includes(space.key),
      })),
      // Named rather than merely flagged, so the obligation is legible without
      // re-reading the per-space objects.
      spacesWithInstructions: instructed,
      ...(instructed.length > 0 && {
        note: "The listed spaces marked hasInstructions carry standing instructions that govern what you write there. Read them (kb_get_space_instructions, or any tool call scoped to the space) before writing into one.",
      }),
    });
  }
);

server.registerTool(
  "kb_get_space_instructions",
  {
    title: "Get Space Instructions",
    description:
      "Read a space's standing instructions: the space owner's rules for what you write there, how you answer questions about it, and any standing domain context. Returns the text plus the `spaceInstructionsToken` value the write tools require for that space. Call this before writing into a space you have not yet read from in this session. A person edits these in the Flux web UI; the tools cannot change them.",
    inputSchema: {
      space: z.string().min(1).describe("Space key — its top-level folder name, e.g. flux."),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  async ({ space }) => {
    const spaceKey = content.spaceKeyOf(space);
    // Membership doubles as the traversal guard, as it does on the web routes.
    const known = (await content.spaces("all")).some((entry) => entry.key === spaceKey);
    if (!known) return errorResult(`Unknown space: ${space}`);

    const instructions = await loadSpaceInstructions(content, spaceKey);
    if (!instructions) {
      return textResult({
        space: spaceKey,
        hasInstructions: false,
        note: "This space has no standing instructions, so writes into it need no spaceInstructionsToken.",
      });
    }
    return textResult({
      hasInstructions: true,
      ...instructionsPayload(instructions, instructionTokens),
    });
  }
);

server.registerTool(
  "kb_list_pages",
  {
    title: "List KB Pages",
    description:
      "Return the knowledge-base navigation tree. Top-level entries are spaces; pass `space` to list one space's pages. Each listed page reports `isFolder` (a pure container, not a content page) and its stable `id` for `[[id:<id>]]` linking.",
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
    const payload = {
      siteTitle: SITE_TITLE,
      filter: selectedFilter,
      space: space ?? null,
      pages: await listPages(selectedFilter, space),
    };
    if (space) return textResult(await withInstructions(content.spaceKeyOf(space), payload));
    return textResult({ ...payload, spacesWithInstructions: await instructedSpaces(selectedFilter) });
  }
);

server.registerTool(
  "kb_get_page",
  {
    title: "Get KB Page",
    description:
      "Read a page by slug as parsed Markdown or raw source. The result includes the page's stable `id` — use it to link here with `[[id:<id>]]` so the link survives future moves — and, in `parsed` form, a `sections` array giving every heading with the `anchor` that links to it (`[[id:<id>#<anchor>]]`), plus a `notes` array of the inline notes left on the page, already located for you.",
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
      return textResult(
        await withInstructions(content.spaceKeyOf(page.slug), {
          slug: page.slug,
          path: kbRelPath(page.fsPath),
          raw: page.raw,
        })
      );
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
      return textResult(
        await withInstructions(content.spaceKeyOf(page.slug), {
          slug: page.slug,
          id: page.data.id,
          title: page.data.title,
          isFolder: true,
          frontmatter: page.data,
          path: kbRelPath(page.fsPath),
          children: (node?.children ?? []).map(listedPage),
        })
      );
    }

    return textResult(
      await withInstructions(content.spaceKeyOf(page.slug), {
        slug: page.slug,
        id: page.data.id,
        title: page.data.title,
        isFolder: false,
        frontmatter: page.data,
        path: kbRelPath(page.fsPath),
        body: page.body,
        // The headings with the anchors the rendered page actually gives them,
        // so a link to one section does not depend on guessing the slug rule.
        sections: extractSections(page.body),
        // Also parsed out, because `body` shows where each note sits but reading
        // the position out of raw comment syntax is needless work.
        notes: parseNotes(page.body),
      })
    );
  }
);

server.registerTool(
  "kb_list_notes",
  {
    title: "List KB Notes",
    description:
      "Return the inline notes left on pages — messages anchored to one specific block of a page's Markdown. Call this to find work waiting in the knowledge base (\"address my notes\"). A `task` note asks for a change to the page; a `remark` is context to read and respect, not act on; a `highlight` only marks a phrase the reader thought worth remembering, carries no text, and is not work — leave it exactly where it is; an `agent` note is one you left yourself, explaining something about the page to whoever reads it next, and is not work either — leave it alone unless it has gone wrong, and take it down with kb_resolve_agent_note rather than by hand. Each note reports the `quote` it was attached to, so you can find the exact text it refers to. Addressing a task means editing the prose AND deleting that note's `<!-- flux:note ... -->` comment in the same kb_update_page call — a note is resolved by removing it, and git keeps the history. A note is written into the Markdown as `<!-- flux:note id=... kind=task|remark|highlight|agent ... -->`, anchored directly above the block it refers to. Never delete a note without addressing it, and never leave one you have acted on.",
    inputSchema: {
      slug: z.string().optional().describe("Limit to a single page, by slug."),
      space: z
        .string()
        .optional()
        .describe("Limit to a single space (its top-level folder key, e.g. flux)."),
      kind: z
        .enum(["task", "remark", "highlight", "agent"])
        .optional()
        .describe("Limit to one kind of note."),
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
    const found = await collectListedNotes(selectedFilter, { space, slug, kind });
    const payload = {
      filter: selectedFilter,
      space: space ?? null,
      slug: slug ?? null,
      kind: kind ?? null,
      total: found.length,
      notes: found.slice(0, selectedLimit),
    };
    // A slug pins the space more precisely than the `space` argument does.
    const scope = slug !== undefined ? slug : space;
    if (scope) return textResult(await withInstructions(content.spaceKeyOf(scope), payload));
    return textResult({ ...payload, spacesWithInstructions: await instructedSpaces(selectedFilter) });
  }
);

server.registerTool(
  "kb_search",
  {
    title: "Search KB",
    description:
      "Search page titles, slugs, tags, summaries, and Markdown body text. Folders are pure containers with no body and are excluded from the results. Each match reports the page's stable `id` for `[[id:<id>]]` linking, and — when the query hit the body under a heading — a `section` giving that heading's anchor, so you can link to the passage itself with `[[id:<id>#<anchor>]]`.",
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
    const payload = {
      query,
      filter: selectedFilter,
      limit: selectedLimit,
      space: space ?? null,
      matches: await searchMatches(query, selectedFilter, selectedLimit, space),
    };
    if (space) return textResult(await withInstructions(content.spaceKeyOf(space), payload));
    return textResult({ ...payload, spacesWithInstructions: await instructedSpaces(selectedFilter) });
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
      spaceInstructionsToken: instructionTokenSchema,
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
  },
  async ({ parent, title, body, tags, summary, spaceInstructionsToken }) => {
    const refused = refuseInstructionsPath(parent ?? "");
    if (refused) return refused;

    const spaceKey = content.spaceKeyOf(parent ?? "");
    const gate = await gateWrite(spaceKey, spaceInstructionsToken);
    if (gate) return gate;

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
        ...(await writeToken(spaceKey)),
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
      spaceInstructionsToken: instructionTokenSchema,
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
  },
  async ({ parent, title, spaceInstructionsToken }) => {
    const refused = refuseInstructionsPath(parent ?? "");
    if (refused) return refused;

    const spaceKey = content.spaceKeyOf(parent ?? "");
    const gate = await gateWrite(spaceKey, spaceInstructionsToken);
    if (gate) return gate;

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
        ...(await writeToken(spaceKey)),
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
      spaceInstructionsToken: instructionTokenSchema,
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
  },
  async ({ slug, name, spaceInstructionsToken }) => {
    const refused = refuseInstructionsPath(slug);
    if (refused) return refused;

    const spaceKey = content.spaceKeyOf(slug);
    const gate = await gateWrite(spaceKey, spaceInstructionsToken);
    if (gate) return gate;

    try {
      const mutation = await content.renameFolder(slug, name);
      if (!mutation) return errorResult(`Folder not found: ${cleanSlug(slug)}`);
      const commit = mutation.changedFsPaths.length
        ? await git.commitFiles(mutation.changedFsPaths, `Rename folder ${mutation.slug} via mcp`)
        : null;
      return textResult({
        renamed: true,
        slug: mutation.slug,
        path: git.kbRelPath(mutation.fsPath),
        commit,
        ...(await writeToken(spaceKey)),
      });
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
      "Replace a page's entire Markdown source, including frontmatter. The frontmatter must be valid (a title is required), and it must keep the page's existing `id` — that id is what `[[id:<id>]]` links resolve through, so read the current source first with kb_get_page (format: raw) rather than composing frontmatter from scratch. Do not add or reword inline notes as a side effect of an unrelated edit; preserve the ones you were not asked about. To leave an explanation of your own, use kb_add_agent_note rather than writing `<!-- flux:note ... -->` syntax by hand — a note written by hand gets no id, so nothing can resolve it afterwards. Folders have no body and are rejected — use kb_rename_folder to rename one.",
    inputSchema: {
      slug: z.string().describe("Page slug, e.g. engineering/runbooks/deploy."),
      markdown: z.string().describe("Full replacement Markdown source, including YAML frontmatter."),
      spaceInstructionsToken: instructionTokenSchema,
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
  },
  async ({ slug, markdown, spaceInstructionsToken }) => {
    const refused = refuseInstructionsPath(slug);
    if (refused) return refused;

    const spaceKey = content.spaceKeyOf(slug);
    const gate = await gateWrite(spaceKey, spaceInstructionsToken);
    if (gate) return gate;

    try {
      const mutation = await content.updateRaw(slug, markdown);
      if (!mutation) return errorResult(`Page not found: ${cleanSlug(slug) || "(home)"}`);
      const commit = await git.commitFiles(
        [mutation.fsPath],
        `Update ${git.kbRelPath(mutation.fsPath)} via mcp`
      );
      return textResult({
        updated: true,
        slug: mutation.slug,
        path: git.kbRelPath(mutation.fsPath),
        commit,
        // Flagged when the submitted frontmatter dropped or altered the page's
        // stable id and the on-disk one was restored — read before you rewrite.
        ...(mutation.idPreserved && { idPreserved: true }),
        ...(await writeToken(spaceKey)),
      });
    } catch (err) {
      return errorResult(errorMessage(err));
    }
  }
);

/**
 * Write a page body back and commit it, for the two note tools below.
 *
 * Through `updateRaw`, so a note write is held to the same frontmatter
 * validation and folder rules as any other edit, and with the header's bytes
 * carried across untouched: leaving a note is not an edit to the YAML, and
 * reformatting someone's frontmatter as a side effect of one would be a surprise
 * in the diff.
 */
async function commitNoteWrite(slug: string, header: string, body: string, verb: string) {
  const mutation = await content.updateRaw(slug, header + body);
  if (!mutation) return null;
  const relPath = git.kbRelPath(mutation.fsPath);
  return {
    slug: mutation.slug,
    path: relPath,
    commit: await git.commitFiles([mutation.fsPath], `${verb} ${relPath} via mcp`),
  };
}

server.registerTool(
  "kb_add_agent_note",
  {
    title: "Leave an Agent Note",
    description:
      "Leave a note of your own on one passage of a page: a short explanation, anchored to the words it is about and shown to the reader in place, in pink, as yours. This is how you say why a page reads the way it does — after an edit whose reason a diff will not show (why a figure changed, what you could not verify, which of two readings you took), or to flag something you noticed and were not asked to change. `quote` is the text to anchor to, copied as a reader sees it: plain words with no Markdown markup, from inside a single paragraph, list, heading, table or code block — kb_get_page returns the source to copy from. A quote that is not found, or that appears in more than one block, is refused rather than guessed at. `text` is required, unlike a human highlight: a pink mark with nothing written on it explains nothing. Leave one note per thing actually worth saying, not one per paragraph — a page fenced in pink marks is one nobody reads. A person can resolve your note but never edit it, so write it to be read once and taken down; take down your own with kb_resolve_agent_note.",
    inputSchema: {
      slug: z.string().describe("Page slug, e.g. engineering/runbooks/deploy."),
      quote: z
        .string()
        .min(1)
        .describe(
          "The passage to anchor the note to, as a reader sees it. Must appear in exactly one block of the page."
        ),
      text: z.string().min(1).describe("The note itself — what the reader should know here."),
      spaceInstructionsToken: instructionTokenSchema,
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
  },
  async ({ slug, quote, text, spaceInstructionsToken }) => {
    const refused = refuseInstructionsPath(slug);
    if (refused) return refused;

    const spaceKey = content.spaceKeyOf(slug);
    const gate = await gateWrite(spaceKey, spaceInstructionsToken);
    if (gate) return gate;

    try {
      const page = await content.loadRaw(slug);
      if (!page) return errorResult(`Page not found: ${cleanSlug(slug) || "(home)"}`);
      const { header, body } = splitFrontmatter(page.raw);
      const written = addAgentNote(body, { quote, text, author: NOTE_AUTHOR });
      if (!written.ok) return errorResult(written.error);

      // The same note was already on the page — a retried call, most likely. Say
      // where it is and write nothing, rather than leaving two identical marks.
      if (!written.added) {
        return textResult({
          added: false,
          reason: "An identical note is already on that passage.",
          slug: cleanSlug(slug),
          path: git.kbRelPath(page.fsPath),
          noteId: written.note.id,
          quote: written.note.quote,
          ...(await writeToken(spaceKey)),
        });
      }

      const mutation = await commitNoteWrite(slug, header, written.body, "Add note to");
      if (!mutation) return errorResult(`Page not found: ${cleanSlug(slug) || "(home)"}`);
      return textResult({
        added: true,
        ...mutation,
        noteId: written.note.id,
        // The quote as stored, which is the page's own text: markup resolved
        // away and punctuation smartened, so it can be found again in the
        // rendered page. It may not be the string that was passed in.
        quote: written.note.quote,
        line: written.note.line,
        ...(await writeToken(spaceKey)),
      });
    } catch (err) {
      return errorResult(errorMessage(err));
    }
  }
);

server.registerTool(
  "kb_resolve_agent_note",
  {
    title: "Resolve an Agent Note",
    description:
      "Take down one of your own notes by id — one you left that has become wrong, has been answered, or was about text that no longer exists. Only `agent` notes, the ones you wrote: a person's `task` or `remark` is not yours to clear with a tool call. A task is addressed by making the change it asks for AND deleting its `<!-- flux:note ... -->` comment in the same kb_update_page call, which is deliberately the only way to close one. kb_list_notes with kind: agent reports the ids. Resolving deletes the note outright; git keeps it.",
    inputSchema: {
      slug: z.string().describe("Page slug the note sits on."),
      noteId: z.string().min(1).describe("The note's `id`, as reported by kb_list_notes."),
      spaceInstructionsToken: instructionTokenSchema,
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
  },
  async ({ slug, noteId, spaceInstructionsToken }) => {
    const refused = refuseInstructionsPath(slug);
    if (refused) return refused;

    const spaceKey = content.spaceKeyOf(slug);
    const gate = await gateWrite(spaceKey, spaceInstructionsToken);
    if (gate) return gate;

    try {
      const page = await content.loadRaw(slug);
      if (!page) return errorResult(`Page not found: ${cleanSlug(slug) || "(home)"}`);
      const { header, body } = splitFrontmatter(page.raw);
      const written = resolveAgentNote(body, noteId);
      if (!written.ok) return errorResult(written.error);

      const mutation = await commitNoteWrite(slug, header, written.body, "Resolve note on");
      if (!mutation) return errorResult(`Page not found: ${cleanSlug(slug) || "(home)"}`);
      return textResult({
        resolved: true,
        ...mutation,
        noteId: written.note.id,
        quote: written.note.quote,
        ...(await writeToken(spaceKey)),
      });
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
      spaceInstructionsToken: instructionTokenSchema,
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
  },
  async ({ slug, spaceInstructionsToken }) => {
    const refused = refuseInstructionsPath(slug);
    if (refused) return refused;

    const spaceKey = content.spaceKeyOf(slug);
    const gate = await gateWrite(spaceKey, spaceInstructionsToken);
    if (gate) return gate;

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
        ...(await writeToken(spaceKey)),
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
      spaceInstructionsToken: instructionTokenSchema,
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
  },
  async ({ slug, spaceInstructionsToken }) => {
    const refused = refuseInstructionsPath(slug);
    if (refused) return refused;

    const spaceKey = content.spaceKeyOf(slug);
    const gate = await gateWrite(spaceKey, spaceInstructionsToken);
    if (gate) return gate;

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
        ...(await writeToken(spaceKey)),
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
      spaceInstructionsToken: instructionTokenSchema,
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
  },
  async ({ sourceSlug, targetParent, spaceInstructionsToken }) => {
    const refused = refuseInstructionsPath(sourceSlug);
    if (refused) return refused;
    const refusedTarget = refuseInstructionsPath(targetParent ?? "");
    if (refusedTarget) return refusedTarget;

    const spaceKey = content.spaceKeyOf(sourceSlug);
    const gate = await gateWrite(spaceKey, spaceInstructionsToken);
    if (gate) return gate;

    try {
      const mutation = await content.movePage(sourceSlug, targetParent || null);
      if (!mutation) return errorResult(`Page not found: ${cleanSlug(sourceSlug)}`);
      const commit = await git.commitMovedPaths(
        mutation.changedFsPaths,
        `Move ${mutation.oldSlug} to ${mutation.newSlug} via mcp`
      );
      return textResult({
        moved: true,
        oldSlug: mutation.oldSlug,
        newSlug: mutation.newSlug,
        commit,
        ...(await writeToken(spaceKey)),
      });
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
      spaceInstructionsToken: instructionTokenSchema,
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
  },
  async ({ slug, newName, spaceInstructionsToken }) => {
    const refused = refuseInstructionsPath(slug);
    if (refused) return refused;

    const spaceKey = content.spaceKeyOf(slug);
    const gate = await gateWrite(spaceKey, spaceInstructionsToken);
    if (gate) return gate;

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
      return textResult({
        renamed: true,
        oldSlug: mutation.oldSlug,
        newSlug: mutation.newSlug,
        commit,
        ...(await writeToken(spaceKey)),
      });
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
      spaceInstructionsToken: instructionTokenSchema,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    },
  },
  async ({ slug, spaceInstructionsToken }) => {
    const refused = refuseInstructionsPath(slug);
    if (refused) return refused;

    const spaceKey = content.spaceKeyOf(slug);
    const gate = await gateWrite(spaceKey, spaceInstructionsToken);
    if (gate) return gate;

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
        ...(await writeToken(spaceKey)),
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
