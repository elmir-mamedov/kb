#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { Content, type PageNode, type TreeFilter } from "./content.js";
import { makeGit } from "./git.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

loadEnvFile(path.join(__dirname, "..", "..", ".env"));
loadEnvFile(path.join(__dirname, "..", ".env"));

const KB_DIR = path.resolve(
  process.env.KB_DIR ?? path.join(__dirname, "..", "..", "kb")
);
const SITE_TITLE = process.env.SITE_TITLE ?? "Knowledge Base";
const VERSION = "0.1.0";

const content = new Content(KB_DIR);
const git = makeGit(KB_DIR);

interface ListedPage {
  slug: string;
  title: string;
  path: string;
  isSection: boolean;
  archived: boolean;
  archivedAt?: string;
  children: ListedPage[];
}

interface SearchMatch {
  slug: string;
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
    title: node.title,
    path: kbRelPath(node.fsPath),
    isSection: node.isSection,
    archived: node.archived,
    archivedAt: node.archivedAt,
    children: node.children.map(listedPage),
  };
}

function flatten(nodes: PageNode[]): PageNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
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

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function scorePage(query: string, page: Awaited<ReturnType<Content["load"]>>): number {
  if (!page) return 0;

  const normalizedQuery = normalizeText(query);
  const tokens = normalizedQuery.split(" ").filter(Boolean);
  const title = normalizeText(page.data.title);
  const slug = normalizeText(page.slug);
  const summary = normalizeText(page.data.summary ?? "");
  const tags = normalizeText((page.data.tags ?? []).join(" "));
  const body = normalizeText(page.body);
  const haystack = `${title} ${slug} ${summary} ${tags} ${body}`;

  if (!tokens.every((token) => haystack.includes(token))) return 0;

  let score = 1;
  for (const token of tokens) {
    if (title.includes(token)) score += 8;
    if (slug.includes(token)) score += 5;
    if (tags.includes(token)) score += 4;
    if (summary.includes(token)) score += 3;
    if (body.includes(token)) score += 1;
  }
  if (title.includes(normalizedQuery)) score += 12;
  if (slug.includes(normalizedQuery)) score += 6;
  if (summary.includes(normalizedQuery)) score += 5;
  if (body.includes(normalizedQuery)) score += 2;
  return score;
}

function excerptFor(query: string, body: string, summary?: string): string {
  if (summary) return summary;

  const normalizedBody = body.replace(/\s+/g, " ").trim();
  if (!normalizedBody) return "";

  const firstToken = normalizeText(query).split(" ").find(Boolean);
  const normalized = normalizeText(normalizedBody);
  const index = firstToken ? normalized.indexOf(firstToken) : -1;
  const start = index === -1 ? 0 : Math.max(0, index - 80);
  const end = Math.min(normalizedBody.length, start + 220);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < normalizedBody.length ? "..." : "";
  return `${prefix}${normalizedBody.slice(start, end)}${suffix}`;
}

async function listPages(filter: TreeFilter, space?: string): Promise<ListedPage[]> {
  const nodes = space
    ? await content.spaceTree(space, filter)
    : await content.tree(filter);
  return nodes.map(listedPage);
}

async function searchPages(
  query: string,
  filter: TreeFilter,
  limit: number,
  space?: string
): Promise<SearchMatch[]> {
  const nodes = flatten(
    space ? await content.spaceTree(space, filter) : await content.tree(filter)
  );
  const matches: SearchMatch[] = [];

  for (const node of nodes) {
    let page: Awaited<ReturnType<Content["load"]>>;
    try {
      page = await content.load(node.slug);
    } catch {
      continue;
    }
    if (!page) continue;

    const score = scorePage(query, page);
    if (score === 0) continue;

    matches.push({
      slug: page.slug,
      title: page.data.title,
      path: kbRelPath(page.fsPath),
      archived: page.data.archived === true,
      tags: page.data.tags ?? [],
      summary: page.data.summary,
      excerpt: excerptFor(query, page.body, page.data.summary),
      score,
    });
  }

  return matches
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, limit);
}

const filterSchema = z.enum(["live", "archived", "all"]);

const server = new McpServer(
  {
    name: "flux-kb",
    version: VERSION,
  },
  {
    instructions:
      "Read and write access to the Markdown knowledge base. The KB is organized into spaces (top-level containers; the first segment of every page slug). Read with kb_list_spaces, kb_search, kb_get_page, and kb_list_pages; pass `space` to kb_list_pages or kb_search to scope to a single space. Write with kb_create_page (single-shot create from title + body), kb_update_page (replace raw Markdown), kb_archive_page / kb_restore_page (toggle archived state), kb_move_page (re-parent), kb_rename_page (change a page's URL slug), kb_delete_page (permanent), and kb_create_space (new top-level container). Every write is auto-committed to git as `... via mcp`.",
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
    description: "Read a page by slug as parsed Markdown or raw source.",
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

    return textResult({
      slug: page.slug,
      title: page.data.title,
      frontmatter: page.data,
      path: kbRelPath(page.fsPath),
      body: page.body,
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
      matches: await searchPages(query, selectedFilter, selectedLimit, space),
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
      "Create a new page from a title and Markdown body inside any page. The title becomes the page slug; a leaf-page parent is auto-promoted into a section. Pass an empty parent only to create a top-level page (use kb_create_space for a new space).",
    inputSchema: {
      parent: z
        .string()
        .describe("Parent page slug, e.g. flux/runbooks. A leaf parent becomes a section. Use an empty string for the root."),
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
        path: git.kbRelPath(mutation.fsPath),
        commit,
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
      "Replace a page's entire Markdown source, including frontmatter. The frontmatter must be valid (a title is required). Read the current source first with kb_get_page (format: raw).",
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
      const commit = await git.commitFiles(
        [mutation.fsPath],
        `Create ${git.kbRelPath(mutation.fsPath)} via mcp`
      );
      return textResult({ created: true, slug: mutation.slug, path: git.kbRelPath(mutation.fsPath), commit });
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
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(message);
  process.exit(1);
});
