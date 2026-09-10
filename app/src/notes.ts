import { randomBytes } from "node:crypto";

/**
 * Inline notes: a message left on a specific part of a page, stored in the
 * page's own Markdown as an HTML comment sitting directly above the block it
 * refers to.
 *
 *     <!-- flux:note id=n7k2m4x8 kind=task at=2026-08-10T09:12:04Z by=elmir
 *     > restart the workers manually
 *
 *     Stale — we use the rolling restart script now.
 *     -->
 *     After the image is pushed, restart the workers manually…
 *
 * Storing them in the body rather than a sidecar buys three things: the note's
 * position *is* its anchor (nothing to re-locate, nothing to drift when the page
 * is edited), git versions it alongside the prose it comments on, and an LLM
 * reading the raw Markdown sees it already in place without a second lookup.
 *
 * Resolving a note means deleting the comment; editing one rewrites it where it
 * sits, keeping the id it was written with — git keeps the history of both.
 */

/**
 * How a note should be treated by an agent reading the page. A `task` asks for a
 * change, a `remark` is context to respect — and a `highlight` asks for nothing
 * at all: it marks a phrase as worth remembering, so it usually has no text.
 *
 * An `agent` note runs the other way: it is something an agent left *for* the
 * reader, an explanation of a page it just wrote or changed. A person can
 * resolve one but never write or reword one, so a green note on a page is
 * always something the agent itself actually said.
 */
export type NoteKind = "task" | "remark" | "highlight" | "agent";

export interface Note {
  /**
   * The note's `id=` attribute. A note written by hand (by a person in the
   * editor, or by an agent) may omit it, in which case it gets a positional
   * `@<line>` id instead so it is still addressable — that fallback is only
   * valid for the body it was parsed from, not stable across edits.
   */
  id: string;
  kind: NoteKind;
  /** ISO timestamp, or "" if the note was hand-written without one. */
  at: string;
  by?: string;
  /** The selected text this note was attached to, whitespace-collapsed to one line. */
  quote?: string;
  /** The message left on the block; empty for a highlight, which carries none. */
  text: string;
  /** 0-based line in the body where the note's opening `<!--` sits. */
  line: number;
}

/**
 * Whether a note came from an agent rather than a person. It lives next to the
 * kind it tests so the literal sits in one place: the web editor refuses to
 * rewrite one of these, and the MCP resolve tool refuses everything else.
 */
export function isAgentNote(note: { kind: NoteKind }): boolean {
  return note.kind === "agent";
}

/** A note plus the line range it occupies, used by the splice helpers below. */
interface ScannedNote {
  note: Note;
  start: number;
  /** Inclusive index of the line holding the closing `-->`. */
  end: number;
}

const OPEN_RE = /^ {0,3}<!--[ \t]*flux:note\b(.*)$/;
const CLOSE = "-->";
/** An opening or closing code fence: three or more backticks or tildes. */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * A short note id: 40 random bits as a fixed 8-char lowercase base36 string.
 * Purely alphanumeric like {@link newPageId}, so it needs no quoting inside the
 * comment header and stays readable when you are looking at raw Markdown.
 */
export function newNoteId(): string {
  return BigInt("0x" + randomBytes(5).toString("hex"))
    .toString(36)
    .padStart(8, "0");
}

/**
 * The timestamp a note is written with. Seconds are plenty for something a
 * person reads as "2h ago", and both writers — the web route and the MCP tool —
 * have to agree on the shape or the same page ends up with two of them.
 */
export function noteStamp(now: Date = new Date()): string {
  return now.toISOString().replace(/\.\d+Z$/, "Z");
}

/**
 * Make a note's quote or text safe to sit inside an HTML comment, losslessly.
 * `-->` would end the comment early, and `&` has to go first so unescaping can
 * tell an escaped sequence from one the author actually typed.
 */
function escapeNoteValue(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/-->/g, "--&gt;");
}

/** Inverse of {@link escapeNoteValue}; the order mirrors it exactly. */
function unescapeNoteValue(value: string): string {
  return value.replace(/--&gt;/g, "-->").replace(/&amp;/g, "&");
}

/**
 * Collapse a selection to the single line the `> ` quote marker expects. The
 * quote is only ever used to re-find the phrase in the rendered page, so
 * flattening runs of whitespace loses nothing that matters.
 */
export function normalizeQuote(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Parse the `key=value` pairs that follow `flux:note` on the opening line. */
function parseAttrs(rest: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const match of rest.matchAll(/([a-z][a-z0-9-]*)=(\S+)/gi)) {
    attrs.set(match[1].toLowerCase(), match[2]);
  }
  return attrs;
}

/**
 * Find every note in a body, in document order.
 *
 * An unterminated comment is skipped rather than swallowing the rest of the
 * page: the block rule in `markdown.ts` bails on it the same way, so a note
 * someone broke by hand shows up as visible text instead of silently eating
 * everything below it.
 */
function scanNotes(body: string): ScannedNote[] {
  // Search runs this over every page on every keystroke, and almost no page has
  // a note; one substring scan is much cheaper than a regex per line.
  if (!body.includes("flux:note")) return [];

  const lines = body.split("\n");
  const found: ScannedNote[] = [];
  let fence = "";

  for (let i = 0; i < lines.length; i += 1) {
    // Note syntax inside a code fence is a documented example, not a note —
    // this page is one. The renderer never sees those lines (the fence rule
    // consumes them), so the scanner must skip them too or the two disagree.
    const rail = FENCE_RE.exec(lines[i]);
    if (fence) {
      if (rail && rail[1][0] === fence[0] && rail[1].length >= fence.length && !rail[2].trim()) {
        fence = "";
      }
      continue;
    }
    // A backtick fence's info string may not itself contain a backtick.
    if (rail && !(rail[1][0] === "`" && rail[2].includes("`"))) {
      fence = rail[1];
      continue;
    }

    const open = OPEN_RE.exec(lines[i]);
    if (!open) continue;

    const header = open[1];
    const closeOnOpen = header.indexOf(CLOSE);
    let end = i;
    let bodyLines: string[] = [];

    if (closeOnOpen >= 0) {
      // `<!-- flux:note id=… -->` all on one line: a note with no text.
      end = i;
    } else {
      let close = -1;
      for (let j = i + 1; j < lines.length; j += 1) {
        if (lines[j].trim() === CLOSE) {
          close = j;
          break;
        }
      }
      if (close < 0) continue; // unterminated — leave it to render as text
      end = close;
      bodyLines = lines.slice(i + 1, close);
    }

    const attrs = parseAttrs(closeOnOpen >= 0 ? header.slice(0, closeOnOpen) : header);

    // An optional `> …` line directly under the header carries the quoted
    // selection, followed by one blank line before the note text.
    let quote: string | undefined;
    if (bodyLines.length && /^ {0,3}>\s?/.test(bodyLines[0])) {
      quote = unescapeNoteValue(bodyLines[0].replace(/^ {0,3}>\s?/, "").trim());
      bodyLines = bodyLines.slice(1);
      if (bodyLines.length && bodyLines[0].trim() === "") bodyLines = bodyLines.slice(1);
    }

    // A note whose text legitimately starts with ">" had that one character
    // escaped on write so it could not be mistaken for the quote line above.
    if (bodyLines.length && bodyLines[0].startsWith("&gt;")) {
      bodyLines = [">" + bodyLines[0].slice(4), ...bodyLines.slice(1)];
    }

    const kind = attrs.get("kind");
    found.push({
      start: i,
      end,
      note: {
        id: attrs.get("id") || `@${i}`,
        // Anything unrecognised (or absent) reads as a task: a note someone
        // wrote by hand without a kind is almost always an instruction.
        kind: kind === "remark" || kind === "highlight" || kind === "agent" ? kind : "task",
        at: attrs.get("at") ?? "",
        by: attrs.get("by"),
        quote: quote || undefined,
        text: unescapeNoteValue(bodyLines.join("\n").trim()),
        line: i,
      },
    });

    i = end;
  }

  return found;
}

/** Every note on a page, in document order. */
export function parseNotes(body: string): Note[] {
  return scanNotes(body).map((s) => s.note);
}

/** Render a note as the comment block that gets spliced into the body. */
export function formatNote(note: Omit<Note, "line">): string {
  const attrs = [`id=${note.id}`, `kind=${note.kind}`];
  if (note.at) attrs.push(`at=${note.at}`);
  const by = note.by?.replace(/\s+/g, "");
  if (by) attrs.push(`by=${by}`);

  const lines = [`<!-- flux:note ${attrs.join(" ")}`];
  if (note.quote) lines.push(`> ${escapeNoteValue(normalizeQuote(note.quote))}`);

  let text = escapeNoteValue(note.text.trim());
  // Protect a leading ">" so the first text line is never read back as the
  // quote line. This matters when the note has no quote of its own, where the
  // two would otherwise be indistinguishable; the parser undoes exactly this.
  if (text.startsWith(">")) text = "&gt;" + text.slice(1);
  // A highlight has no message, so its block is the header and the quote alone.
  if (text) {
    if (note.quote) lines.push("");
    lines.push(text);
  }

  lines.push(CLOSE);
  return lines.join("\n");
}

/**
 * Splice a note into `body` so it sits immediately above the block starting at
 * line `at`, separated from whatever precedes it by exactly one blank line.
 */
export function insertNote(body: string, at: number, note: Omit<Note, "line">): string {
  const lines = body.split("\n");
  const index = Math.max(0, Math.min(at, lines.length));
  const block = formatNote(note).split("\n");
  const needsGap = index > 0 && lines[index - 1].trim() !== "";
  lines.splice(index, 0, ...(needsGap ? ["", ...block] : block));
  return lines.join("\n");
}

/**
 * Rewrite a note's text, its kind, or both, in place. Everything else — id,
 * timestamp, author, quote, and the position that anchors it — is carried over:
 * this is the same note amended, not a new one, and git holds the before and
 * after. Returns the new body, or `null` if no note has that id.
 *
 * An empty `text` clears the message rather than being ignored — that is how a
 * note retyped as a highlight drops the words it no longer needs.
 *
 * A note written by hand without an `id=` is addressed by position, which is not
 * a durable handle; rewriting one stamps a real id on it so the next edit can
 * find it by name.
 *
 * `changes.kind` will take any kind, `agent` included. Keeping a person from
 * retyping a note into an agent note is `noteKindOf`'s job, in the web route
 * that calls this.
 */
export function updateNote(
  body: string,
  id: string,
  changes: { text?: string; kind?: NoteKind }
): string | null {
  if (!id) return null;
  const target = scanNotes(body).find((s) => s.note.id === id);
  if (!target) return null;

  const current = target.note;
  const block = formatNote({
    id: current.id.startsWith("@") ? newNoteId() : current.id,
    kind: changes.kind ?? current.kind,
    at: current.at,
    by: current.by,
    quote: current.quote,
    text: changes.text ?? current.text,
  }).split("\n");

  const lines = body.split("\n");
  lines.splice(target.start, target.end - target.start + 1, ...block);
  return lines.join("\n");
}

/**
 * Delete a line range and close the gap behind it.
 *
 * A note stacked between others sits with a blank line on either side; removing
 * just its own lines would leave both, and the gap would widen every time a note
 * is resolved. Collapsing only when *both* sides are blank leaves a lone
 * separator — which the prose needs — untouched.
 */
function spliceLines(lines: string[], start: number, end: number): void {
  lines.splice(start, end - start + 1);
  if (start > 0 && lines[start - 1]?.trim() === "" && lines[start]?.trim() === "") {
    lines.splice(start, 1);
  }
}

/**
 * Remove a note by id. Returns the new body, or `null` if no note has that id
 * so the caller can report a stale request rather than silently succeeding.
 */
export function removeNote(body: string, id: string): string | null {
  if (!id) return null;
  const target = scanNotes(body).find((s) => s.note.id === id);
  if (!target) return null;
  const lines = body.split("\n");
  spliceLines(lines, target.start, target.end);
  return lines.join("\n");
}

/**
 * The body with every note comment removed. Used for search indexing, so note
 * text never turns up as a page match or leaks into an excerpt.
 */
export function stripNotes(body: string): string {
  const found = scanNotes(body);
  if (!found.length) return body;
  const lines = body.split("\n");
  for (let i = found.length - 1; i >= 0; i -= 1) {
    spliceLines(lines, found[i].start, found[i].end);
  }
  return lines.join("\n");
}

/**
 * Split a raw `.md` file into its frontmatter header and its body, preserving
 * the header's bytes exactly.
 *
 * `content.ts` re-serialises frontmatter through `matter.stringify` because it
 * is editing the YAML; a note write is not, and reformatting someone's header
 * as a side effect of leaving a comment would be a surprise in the diff.
 */
export function splitFrontmatter(raw: string): { header: string; body: string } {
  const lines = raw.split("\n");
  if (lines[0]?.trimEnd() !== "---") return { header: "", body: raw };

  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trimEnd() === "---") {
      return {
        header: lines.slice(0, i + 1).join("\n") + "\n",
        body: lines.slice(i + 1).join("\n"),
      };
    }
  }
  return { header: "", body: raw };
}
