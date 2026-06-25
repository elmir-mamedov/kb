#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { Content, type PageNode, type TreeFilter } from "./content.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

loadEnvFile(path.join(__dirname, "..", "..", ".env"));
loadEnvFile(path.join(__dirname, "..", ".env"));

const KB_DIR = path.resolve(
  process.env.KB_DIR ?? path.join(__dirname, "..", "..", "kb")
);
const SITE_TITLE = process.env.SITE_TITLE ?? "Knowledge Base";
const VERSION = "0.1.0";

const content = new Content(KB_DIR);

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

async function listPages(filter: TreeFilter): Promise<ListedPage[]> {
  return (await content.tree(filter)).map(listedPage);
}

async function searchPages(
  query: string,
  filter: TreeFilter,
  limit: number
): Promise<SearchMatch[]> {
  const nodes = flatten(await content.tree(filter));
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
      "Read-only access to the Markdown knowledge base. Use kb_search to find pages, kb_get_page to read Markdown, and kb_list_pages to inspect navigation.",
  }
);

server.registerTool(
  "kb_list_pages",
  {
    title: "List KB Pages",
    description: "Return the knowledge-base navigation tree.",
    inputSchema: {
      filter: filterSchema.optional().describe("Which pages to include. Defaults to live."),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  async ({ filter }) => {
    const selectedFilter = filter ?? "live";
    return textResult({
      siteTitle: SITE_TITLE,
      filter: selectedFilter,
      pages: await listPages(selectedFilter),
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
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  async ({ query, filter, limit }) => {
    const selectedFilter = filter ?? "live";
    const selectedLimit = limit ?? 10;
    return textResult({
      query,
      filter: selectedFilter,
      limit: selectedLimit,
      matches: await searchPages(query, selectedFilter, selectedLimit),
    });
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
