import { test } from "node:test";
import assert from "node:assert/strict";
import { addAgentNote, resolveAgentNote } from "./note-write.js";
import { formatNote, parseNotes } from "./notes.js";

const page = [
  "Run the **rolling restart** script for the flags.",
  "",
  "- drain the node",
  "- then restart it",
  "",
  "Restart it by hand only when the script refuses.",
].join("\n");

/** Add a note and fail loudly rather than narrowing at every call site. */
function added(body: string, quote: string, text: string) {
  const result = addAgentNote(body, { quote, text, author: "agent", now: new Date("2026-09-10T12:00:00.400Z") });
  assert.ok(result.ok, result.ok ? "" : result.error);
  return result;
}

/** The refusal a call produced, or "" when it unexpectedly succeeded. */
function refused(result: { ok: boolean } & Record<string, unknown>) {
  return result.ok ? "" : String(result.error);
}

test("an added note sits directly above the block its quote is in", () => {
  const result = added(page, "the rolling restart script", "Renamed from restart.sh.");
  const lines = result.body.split("\n");
  assert.equal(lines[0], "<!-- flux:note id=" + result.note.id + " kind=agent at=2026-09-10T12:00:00Z by=agent");
  assert.equal(lines[1], "> the rolling restart script");
  assert.equal(lines[3], "Renamed from restart.sh.");
  // The comment abuts the block it annotates, with no blank line between.
  assert.equal(lines[lines.indexOf("-->") + 1], "Run the **rolling restart** script for the flags.");
  assert.match(result.note.id, /^[0-9a-z]{8}$/);
  assert.equal(result.note.line, 0);
});

test("an added note is one the parser reads back as an agent's", () => {
  const result = added(page, "drain the node", "The drain timeout is 90s here, not the default.");
  const parsed = parseNotes(result.body);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].kind, "agent");
  assert.equal(parsed[0].by, "agent");
  assert.equal(parsed[0].id, result.note.id);
  // Anchored to the list, which is the block the quoted item belongs to.
  assert.equal(parsed[0].line, result.note.line);
});

test("the stored quote is the page's text, not the caller's markup", () => {
  const result = added(page, "the **rolling restart** script", "Renamed.");
  assert.equal(result.note.quote, "the rolling restart script");
});

test("a note with nothing written on it is refused", () => {
  for (const text of ["", "   ", "\n\t"]) {
    const result = addAgentNote(page, { quote: "drain the node", text, author: "agent" });
    assert.match(refused(result), /needs something written on it/);
  }
});

test("each way a quote can fail gets its own answer", () => {
  const ambiguous = "Restart the workers.\n\nSomething.\n\nRestart the workers.\n";
  assert.match(
    refused(addAgentNote(ambiguous, { quote: "Restart the workers", text: "x", author: "agent" })),
    /appears in 2 separate blocks/
  );
  assert.match(
    refused(addAgentNote(page, { quote: "nowhere on this page", text: "x", author: "agent" })),
    /not on the page/
  );
  assert.match(
    refused(addAgentNote(page, { quote: "   ", text: "x", author: "agent" })),
    /no words in it/
  );
});

test("an identical note is reported where it is rather than written twice", () => {
  const first = added(page, "drain the node", "The drain timeout is 90s.");
  // A tool call that times out after the write landed gets retried, and two
  // identical marks on one passage are worse than a no-op.
  const again = addAgentNote(first.body, {
    quote: "drain the node",
    text: "The drain timeout is 90s.",
    author: "agent",
  });
  assert.ok(again.ok);
  assert.equal(again.ok && again.added, false);
  assert.equal(again.ok && again.note.id, first.note.id);
  assert.equal(again.ok && again.body, first.body);
  // Different words on the same passage are a different note, and do get written.
  const other = added(first.body, "drain the node", "Also: the node stays cordoned.");
  assert.equal(other.added, true);
  assert.equal(parseNotes(other.body).length, 2);
});

test("resolving takes back an agent note and nothing else", () => {
  const first = added(page, "drain the node", "The drain timeout is 90s.");
  const gone = resolveAgentNote(first.body, first.note.id);
  assert.ok(gone.ok);
  assert.deepEqual(parseNotes(gone.ok ? gone.body : ""), []);
  assert.equal(gone.ok && gone.note.text, "The drain timeout is 90s.");
});

test("resolving a person's note is refused, and says how to close one", () => {
  for (const kind of ["task", "remark", "highlight"] as const) {
    const body =
      formatNote({ id: "hum00001", kind, at: "2026-08-02T10:00:00Z", by: "elmir", text: "do it" }) +
      "\n" +
      page;
    const result = resolveAgentNote(body, "hum00001");
    assert.match(refused(result), new RegExp("is a " + kind + " left by a person"));
    assert.match(refused(result), /kb_update_page/);
  }
});

test("resolving an id that is not there says so instead of succeeding", () => {
  const first = added(page, "drain the node", "The drain timeout is 90s.");
  assert.match(refused(resolveAgentNote(first.body, "nosuchid")), /No note with id nosuchid/);
  assert.match(refused(resolveAgentNote(first.body, "  ")), /\(none given\)/);
  // ...including a second resolve of a note already taken back.
  const gone = resolveAgentNote(first.body, first.note.id);
  assert.match(refused(resolveAgentNote(gone.ok ? gone.body : "", first.note.id)), /No note with id/);
});

test("a hand-written agent note resolves by its positional id", () => {
  // Nothing may assume an agent note came from addAgentNote: a person can write
  // one in the raw editor, where it gets no id= and no timestamp at all.
  const body = "<!-- flux:note kind=agent\nHand-written.\n-->\n" + page;
  const parsed = parseNotes(body);
  assert.equal(parsed[0].id, "@0");
  const gone = resolveAgentNote(body, "@0");
  assert.ok(gone.ok);
  assert.deepEqual(parseNotes(gone.ok ? gone.body : ""), []);
});
