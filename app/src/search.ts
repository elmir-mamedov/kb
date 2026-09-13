/**
 * Full-text search over the knowledge base, shared by the MCP `kb_search` tool
 * and the sidebar search box in the web viewer. Both entry points must rank
 * pages identically, so the scoring lives here rather than in either caller.
 *
 * Matching is deliberately simple: lowercase substring containment, ANDed across
 * whitespace-separated tokens. No regex is ever built from user input, so a query
 * full of metacharacters is inert rather than dangerous or slow.
 */

import {
  flatten,
  isFolderPage,
  type Content,
  type LoadedPage,
  type PageNode,
  type TreeFilter,
} from "./content.js";
import { extractSections, type Section } from "./markdown.js";
import { stripNotes } from "./notes.js";

export interface SearchHit {
  slug: string;
  /** Stable page id; use it in `[[id:<id>]]` links so they survive moves. */
  id?: string;
  title: string;
  /** Absolute path to the backing .md file, for callers that report locations. */
  fsPath: string;
  archived: boolean;
  tags: string[];
  summary?: string;
  /** Plain-text snippet, windowed around the query where possible. */
  excerpt: string;
  /**
   * The section the match falls in, so a caller can link to that heading rather
   * than to the top of the page. Absent when the query matched only the title,
   * slug or tags, or when the match sits above the page's first heading.
   */
  section?: { anchor: string; text: string };
  score: number;
}

export interface SearchOptions {
  /** Which pages to include. Defaults to "live". */
  filter?: TreeFilter;
  /** Maximum hits returned. Defaults to 10. */
  limit?: number;
  /** Restrict to one space (its top-level folder key, e.g. "flux"). */
  space?: string;
}

/** Characters either side of the matched term in a body excerpt. */
const EXCERPT_LEAD = 80;
const EXCERPT_LENGTH = 220;

export function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/** The lowercase terms a query is ANDed over — also what callers highlight. */
export function searchTokens(query: string): string[] {
  return normalizeText(query).split(" ").filter(Boolean);
}

/**
 * Map over items with bounded concurrency, preserving input order. Exported for
 * `kb_list_notes`, which sweeps the same page set this module does and wants the
 * same "don't open the whole KB at once" behaviour.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export function scorePage(query: string, page: LoadedPage | null): number {
  if (!page) return 0;

  const normalizedQuery = normalizeText(query);
  const tokens = searchTokens(query);
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

/** Earliest position at which any query token appears, or -1 for none. */
function firstTokenIndex(haystack: string, tokens: string[]): number {
  let best = -1;
  for (const token of tokens) {
    const at = haystack.indexOf(token);
    if (at !== -1 && (best === -1 || at < best)) best = at;
  }
  return best;
}

/**
 * A keyword-in-context snippet: a window of the body centred on the first term
 * that actually occurs in it. Falls back to the page's `summary` (then the body's
 * opening) only when the query matched somewhere else entirely — a title, slug or
 * tag hit — so a page having a summary never costs the user their highlight.
 */
export function excerptFor(query: string, body: string, summary?: string): string {
  const tokens = searchTokens(query);
  const text = body.replace(/\s+/g, " ").trim();
  const index = text ? firstTokenIndex(normalizeText(text), tokens) : -1;

  if (index === -1) return summary ?? clamp(text, 0);

  // Whitespace collapsing keeps `text` and its normalized form the same length,
  // so an index found in one addresses the same character in the other.
  return clamp(text, Math.max(0, index - EXCERPT_LEAD));
}

/**
 * The heading a query's first body match sits under.
 *
 * Works in lines rather than characters on purpose: `excerptFor` above windows
 * a whitespace-collapsed copy of the body, so the index it finds cannot be
 * mapped back to a position in the source — but `extractSections` reports each
 * heading's line, so scanning the body line by line lines the two up directly.
 *
 * Returns undefined when the term appears only above the first heading, which is
 * the honest answer: there is no section to link to.
 */
export function sectionFor(
  query: string,
  body: string,
  sections: Section[]
): { anchor: string; text: string } | undefined {
  if (!sections.length) return undefined;
  const tokens = searchTokens(query);
  if (!tokens.length) return undefined;

  const lines = body.split("\n");
  for (let line = 0; line < lines.length; line += 1) {
    const haystack = normalizeText(lines[line]);
    if (!tokens.some((token) => haystack.includes(token))) continue;

    let found: Section | undefined;
    for (const section of sections) {
      if (section.line <= line) found = section;
      else break;
    }
    // A hit on the heading line itself belongs to that heading, which the
    // `<=` above already picks; a hit before any heading belongs to none.
    return found ? { anchor: found.anchor, text: found.text } : undefined;
  }
  return undefined;
}

function clamp(text: string, start: number): string {
  if (!text) return "";
  const end = Math.min(text.length, start + EXCERPT_LENGTH);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

/**
 * Every page a search should consider. Scoping to a space includes the space's
 * own landing page, which `Content.spaceTree` deliberately omits — in the sidebar
 * that page is the one sitting at the top of the switcher, so leaving it
 * unsearchable is surprising.
 */
async function candidates(
  content: Content,
  filter: TreeFilter,
  space?: string
): Promise<PageNode[]> {
  const top = await content.tree(filter);
  if (!space) return flatten(top);

  const key = content.spaceKeyOf(space);
  const node = key ? top.find((n) => n.slug === key) : undefined;
  return node ? flatten([node]) : [];
}

export async function searchPages(
  content: Content,
  query: string,
  opts: SearchOptions = {}
): Promise<SearchHit[]> {
  const { filter = "live", limit = 10, space } = opts;
  if (!searchTokens(query).length) return [];

  const nodes = await candidates(content, filter, space);

  // Load pages concurrently instead of serially. The tree walk above has
  // already warmed Content's parse cache, so these resolve to cheap cache hits;
  // bounded concurrency keeps the cold path from opening too many files at once.
  const pages = await mapWithConcurrency(nodes, 32, async (node) => {
    try {
      return await content.load(node.slug);
    } catch {
      return null; // skip pages with unreadable or invalid frontmatter
    }
  });

  const scored: { hit: SearchHit; body: string }[] = [];
  for (const page of pages) {
    if (!page) continue;
    // Folders are pure containers with no body to match — skip them.
    if (isFolderPage(page.data)) continue;

    // Inline notes are annotations *about* a page, not part of it: they must
    // not make a page match, nor window an excerpt onto comment syntax. Stripped once
    // so scoring and the excerpt see exactly the same prose. `kb_list_notes` is
    // how notes are found.
    const searchable = { ...page, body: stripNotes(page.body) };

    const score = scorePage(query, searchable);
    if (score === 0) continue;

    scored.push({
      hit: {
        slug: page.slug,
        id: page.data.id,
        title: page.data.title,
        fsPath: page.fsPath,
        archived: page.data.archived === true,
        tags: page.data.tags ?? [],
        summary: page.data.summary,
        excerpt: excerptFor(query, searchable.body, page.data.summary),
        score,
      },
      body: searchable.body,
    });
  }

  // Locating each hit's section costs a Markdown parse, so it happens after the
  // cut rather than for every page that matched — the sidebar's type-ahead runs
  // this on each keystroke and would otherwise parse the whole KB to throw all
  // but ten of the results away.
  return scored
    .sort((a, b) => b.hit.score - a.hit.score || a.hit.title.localeCompare(b.hit.title))
    .slice(0, limit)
    .map(({ hit, body }) => ({
      ...hit,
      // Sections come from the same note-stripped body the match was found in,
      // so the line numbers line up. The ids still match the rendered page: a
      // heading inside a note comment is consumed by `kb25_note` there too, so
      // the sequence of real headings — and every id derived from it — is the
      // same either way.
      section: sectionFor(query, body, extractSections(body)),
    }));
}
