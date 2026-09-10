import { type QuoteLocation, locateQuote } from "./markdown.js";
import {
  type Note,
  insertNote,
  isAgentNote,
  newNoteId,
  noteStamp,
  parseNotes,
  removeNote,
} from "./notes.js";

/**
 * The two note writes an agent is allowed to make: leave a note of its own, and
 * take one of its own back.
 *
 * Body in, body out, no I/O — which is what makes them testable. The MCP tools
 * that call these build an `McpServer` at import time and so can never be
 * imported by a test; keeping every decision and every refusal string here
 * leaves the tools as the load/commit glue around them, and stops the wording a
 * model reads in a refusal from drifting away from the wording it was given in
 * the tool description.
 */

export type AddNoteResult =
  | { ok: true; body: string; note: Note; added: boolean }
  | { ok: false; error: string };

export type ResolveNoteResult =
  | { ok: true; body: string; note: Note }
  | { ok: false; error: string };

/**
 * Leave an agent note on the block containing `quote`.
 *
 * The stored quote is the one `locateQuote` hands back, not the one that came
 * in: markup is resolved away and punctuation smartened, so the note anchors to
 * what the reader actually sees. Text is required, unlike a highlight's — a
 * green note with nothing written on it would explain nothing.
 *
 * An identical note already on the page is left alone and reported as such
 * rather than duplicated. A tool call that times out after the write has landed
 * gets retried, and two identical green marks on one passage are worse than a
 * no-op.
 */
export function addAgentNote(
  body: string,
  fields: { quote: string; text: string; author: string; now?: Date }
): AddNoteResult {
  const text = fields.text.trim();
  if (!text) {
    return {
      ok: false,
      error: "A note needs something written on it: say what the reader should know here.",
    };
  }

  const found = locateQuote(body, fields.quote);
  if (!found.ok) return { ok: false, error: quoteRefusal(found) };

  const existing = parseNotes(body).find(
    (note) => isAgentNote(note) && note.text === text && (note.quote ?? "") === found.quote
  );
  if (existing) return { ok: true, body, note: existing, added: false };

  const draft = {
    id: newNoteId(),
    kind: "agent" as const,
    at: noteStamp(fields.now),
    by: fields.author,
    quote: found.quote,
    text,
  };
  const next = insertNote(body, found.line, draft);
  // Read the line back rather than assuming it: `insertNote` adds a blank
  // separator above the comment when the prose above it needs one.
  const line = parseNotes(next).find((note) => note.id === draft.id)?.line ?? found.line;
  return { ok: true, body: next, note: { ...draft, line }, added: true };
}

/** Why a quote could not be anchored, said in a way the caller can act on. */
function quoteRefusal(found: Extract<QuoteLocation, { ok: false }>): string {
  if (found.reason === "ambiguous") {
    return (
      `That quote appears in ${found.blocks} separate blocks of the page, so there is no ` +
      "one place to put the note. Quote a longer phrase that appears exactly once."
    );
  }
  if (found.reason === "empty") {
    return "The quote has no words in it. Pass the text as a reader sees it on the page.";
  }
  return (
    "That quote is not on the page. Copy the words exactly as a reader sees them, from " +
    "within a single paragraph, list, heading, table or code block — a quote that runs " +
    "across two of them cannot be anchored to either. kb_get_page returns the source."
  );
}

/**
 * Take back an agent note by id.
 *
 * Only an agent note: a person's note is resolved by doing what it asks and
 * deleting the comment in the same page write, which is deliberately the only
 * way to clear one. Nothing here assumes the note was written by
 * `addAgentNote` — a person can hand-write `kind=agent` in the raw editor, so it
 * may carry a positional `@<line>` id and no timestamp, and both parse fine.
 */
export function resolveAgentNote(body: string, noteId: string): ResolveNoteResult {
  const id = noteId.trim();
  const note = parseNotes(body).find((candidate) => candidate.id === id);
  if (!note) {
    return {
      ok: false,
      error:
        `No note with id ${id || "(none given)"} on that page. ` +
        "kb_list_notes reports the ids that are there.",
    };
  }
  if (!isAgentNote(note)) {
    return {
      ok: false,
      error:
        `Note ${id} is a ${note.kind} left by a person, and this tool only takes back an ` +
        "agent's own notes. Address it instead: make the change it asks for and delete its " +
        "<!-- flux:note --> comment in the same kb_update_page call.",
    };
  }

  const next = removeNote(body, id);
  // parseNotes just found it, so removeNote cannot miss; the guard is here so
  // the impossible case can't return a body with the note still in it.
  if (next === null) return { ok: false, error: `Could not remove note ${id}.` };
  return { ok: true, body: next, note };
}
