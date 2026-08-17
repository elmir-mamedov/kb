import { Content, flatten, type PageNode, type TreeFilter } from "./content.js";
import { parseNotes, type Note, type NoteKind } from "./notes.js";
import { mapWithConcurrency } from "./search.js";

/**
 * Reading notes across pages, rather than within one.
 *
 * `notes.ts` owns the format — how a note is written into a page's Markdown and
 * read back out of it. This module owns the sweep: every note in the KB, or in
 * one space, plus the small pure helpers that turn a pile of them into something
 * a reader can scan (counts, per-page grouping, an age in words).
 *
 * Both surfaces share it. The MCP `kb_list_notes` tool answers "what work is
 * waiting?" for an agent; the web dashboard answers it for a person. They differ
 * only in how they render the same sweep.
 */

/** A note plus enough of its page to act on it, or link to it, without another lookup. */
export interface IndexedNote extends Note {
  page: {
    slug: string;
    /** Stable page id; use it in `[[id:<id>]]` links so they survive moves. */
    id?: string;
    title: string;
    /** Absolute path on disk. Callers that report paths outward relativize it themselves. */
    fsPath: string;
  };
}

/** Notes that share a page, with the page's own details hoisted out of them. */
export interface NotePageGroup {
  slug: string;
  id?: string;
  title: string;
  notes: IndexedNote[];
}

/** Headline counts for a set of notes. */
export interface NoteSummary {
  total: number;
  /** How many distinct pages carry at least one of them. */
  pages: number;
  /** ISO stamp of the earliest note, or "" when none carries a readable one. */
  oldestAt: string;
  newestAt: string;
}

function cleanSlug(slug: string): string {
  return slug.replace(/^\/+|\/+$/g, "");
}

/**
 * Every inline note across the KB, or within one space or page.
 *
 * Scoping to a space goes through the full tree rather than `spaceTree`, which
 * deliberately omits the space's own landing page — a note left there is still a
 * note, and silently skipping it would be the worst kind of miss.
 */
export async function collectNotes(
  content: Content,
  filter: TreeFilter,
  opts: { space?: string; slug?: string; kind?: NoteKind } = {}
): Promise<IndexedNote[]> {
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

  const found: IndexedNote[] = [];
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
          fsPath: page.fsPath,
        },
      });
    }
  }
  return found;
}

/**
 * Count the notes, the pages they sit on, and the span they cover.
 *
 * A note written by hand can carry no timestamp at all (`at: ""`), so the two
 * ends are computed over the readable stamps only and come back "" when there
 * are none — an age of "just now" for an undated note would be a fabrication.
 */
export function summarizeNotes(notes: IndexedNote[]): NoteSummary {
  const slugs = new Set<string>();
  let oldest = "";
  let newest = "";

  for (const note of notes) {
    slugs.add(note.page.slug);
    if (!note.at || !Number.isFinite(Date.parse(note.at))) continue;
    // ISO stamps sort lexicographically, so no parse is needed to compare them.
    if (!oldest || note.at < oldest) oldest = note.at;
    if (!newest || note.at > newest) newest = note.at;
  }

  return { total: notes.length, pages: slugs.size, oldestAt: oldest, newestAt: newest };
}

/**
 * Bucket notes by the page they annotate.
 *
 * Pages come back freshest first, because the dashboard's job is to surface what
 * was just asked for; within a page the notes stay in document order, which is
 * the order you would meet them reading it. A page whose notes are all undated
 * sorts last rather than first — an unknown age is not a recent one.
 */
export function groupNotesByPage(notes: IndexedNote[]): NotePageGroup[] {
  const groups = new Map<string, NotePageGroup>();

  for (const note of notes) {
    const existing = groups.get(note.page.slug);
    if (existing) {
      existing.notes.push(note);
      continue;
    }
    groups.set(note.page.slug, {
      slug: note.page.slug,
      id: note.page.id,
      title: note.page.title,
      notes: [note],
    });
  }

  const ordered = [...groups.values()];
  for (const group of ordered) {
    group.notes.sort((a, b) => a.line - b.line);
  }
  ordered.sort((a, b) => {
    const freshest = (group: NotePageGroup) =>
      group.notes.reduce((max, note) => (note.at > max ? note.at : max), "");
    const diff = freshest(b).localeCompare(freshest(a));
    return diff !== 0 ? diff : a.title.localeCompare(b.title);
  });
  return ordered;
}

/**
 * How long ago a note was written, in words.
 *
 * The server-side counterpart of the `relativeTime` helper inside `NOTES_SCRIPT`:
 * the dashboard is rendered as HTML on the server, so it cannot reach the
 * client's copy. `now` is a parameter rather than a `Date.now()` call so a test
 * can pin it. An unreadable or missing stamp yields "" for the caller to omit.
 *
 * Written out one unit at a time rather than as a divisor table, because the
 * table form is where the client's copy went wrong: it advances the value and the
 * label out of step, so an hour-old note reads "1m ago".
 */
export function relativeAge(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";

  const seconds = Math.max(0, (now - then) / 1000);
  if (seconds < 60) return "just now";

  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.floor(minutes)}m ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)}h ago`;
  const days = hours / 24;
  if (days < 7) return `${Math.floor(days)}d ago`;
  const weeks = days / 7;
  if (weeks < 52) return `${Math.floor(weeks)}w ago`;
  return `${Math.floor(weeks / 52)}y ago`;
}
