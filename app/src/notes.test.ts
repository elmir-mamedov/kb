import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatNote,
  insertNote,
  newNoteId,
  normalizeQuote,
  parseNotes,
  removeNote,
  splitFrontmatter,
  stripNotes,
  updateNote,
  type Note,
} from "./notes.js";

/** A note with the fixed fields filled in, so tests only state what they vary. */
const note = (overrides: Partial<Omit<Note, "line">> = {}): Omit<Note, "line"> => ({
  id: "n7k2m4x8",
  kind: "task",
  at: "2026-08-10T09:12:04Z",
  text: "Rewrite this paragraph.",
  ...overrides,
});

/** Round-trip a single note through the comment syntax and back. */
const roundTrip = (input: Omit<Note, "line">): Note => {
  const parsed = parseNotes(formatNote(input));
  assert.equal(parsed.length, 1, "expected exactly one note");
  return parsed[0];
};

test("a note round-trips through the comment syntax", () => {
  const parsed = roundTrip(note({ quote: "restart the workers manually", by: "elmir" }));
  assert.equal(parsed.id, "n7k2m4x8");
  assert.equal(parsed.kind, "task");
  assert.equal(parsed.at, "2026-08-10T09:12:04Z");
  assert.equal(parsed.by, "elmir");
  assert.equal(parsed.quote, "restart the workers manually");
  assert.equal(parsed.text, "Rewrite this paragraph.");
});

test("a note with no quote round-trips, and reports no quote", () => {
  const parsed = roundTrip(note({ kind: "remark" }));
  assert.equal(parsed.quote, undefined);
  assert.equal(parsed.kind, "remark");
  assert.equal(parsed.text, "Rewrite this paragraph.");
});

test("note text containing --> does not end the comment early", () => {
  const text = "The arrow --> here must survive.";
  const formatted = formatNote(note({ text }));
  // The only bare `-->` in the block is the terminator on its own line.
  assert.equal(formatted.split("\n").filter((l) => l.trim() === "-->").length, 1);
  assert.equal(roundTrip(note({ text })).text, text);
});

test("note text starting with > is not mistaken for the quote line", () => {
  const parsed = roundTrip(note({ text: "> keep this blockquote" }));
  assert.equal(parsed.quote, undefined);
  assert.equal(parsed.text, "> keep this blockquote");
});

test("a leading > survives even when the note also has a quote", () => {
  const parsed = roundTrip(note({ quote: "the phrase", text: "> and a blockquote" }));
  assert.equal(parsed.quote, "the phrase");
  assert.equal(parsed.text, "> and a blockquote");
});

test("escaping is lossless for text that already looks escaped", () => {
  for (const text of ["--&gt; literal", "&amp; literal", "&gt; literal", "a & b --> c"]) {
    assert.equal(roundTrip(note({ text })).text, text, `failed for ${text}`);
  }
});

test("multi-line note text keeps its line breaks", () => {
  const text = "First line.\nSecond line.";
  assert.equal(roundTrip(note({ text })).text, text);
});

test("a quote spanning lines is collapsed to one line", () => {
  assert.equal(normalizeQuote("  restart   the\nworkers  "), "restart the workers");
  assert.equal(roundTrip(note({ quote: "restart\nthe workers" })).quote, "restart the workers");
});

test("notes are found in document order with their body line numbers", () => {
  const body = [
    "Intro paragraph.",
    "",
    "<!-- flux:note id=aaa kind=task",
    "> first phrase",
    "",
    "Fix this.",
    "-->",
    "Annotated paragraph.",
    "",
    "<!-- flux:note id=bbb kind=remark",
    "Just noting.",
    "-->",
    "Another paragraph.",
  ].join("\n");

  const notes = parseNotes(body);
  assert.equal(notes.length, 2);
  assert.deepEqual(
    notes.map((n) => [n.id, n.kind, n.line]),
    [
      ["aaa", "task", 2],
      ["bbb", "remark", 9],
    ]
  );
  assert.equal(notes[0].quote, "first phrase");
  assert.equal(notes[1].text, "Just noting.");
});

test("two notes stacked on the same block are both found", () => {
  const body = insertNote(
    insertNote("Target paragraph.", 0, note({ id: "aaa" })),
    0,
    note({ id: "bbb" })
  );
  assert.deepEqual(
    parseNotes(body).map((n) => n.id),
    ["bbb", "aaa"]
  );
  assert.equal(stripNotes(body).trim(), "Target paragraph.");
});

test("an unterminated note comment is ignored rather than swallowing the page", () => {
  const body = "<!-- flux:note id=aaa kind=task\nNo terminator here.\n\nReal content.";
  assert.deepEqual(parseNotes(body), []);
  assert.equal(stripNotes(body), body);
});

test("a single-line note comment parses with empty text", () => {
  const notes = parseNotes("<!-- flux:note id=aaa kind=remark -->\nParagraph.");
  assert.equal(notes.length, 1);
  assert.equal(notes[0].id, "aaa");
  assert.equal(notes[0].text, "");
});

test("a hand-written note without id or kind reads as a task, addressable by position", () => {
  const body = "Paragraph.\n\n<!-- flux:note\nDo the thing.\n-->\nAnother.";
  const notes = parseNotes(body);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].kind, "task");
  assert.equal(notes[0].text, "Do the thing.");
  // No id= in the file, so it gets a positional one — otherwise a note written
  // by hand or by an agent could be read but never resolved.
  assert.equal(notes[0].id, "@2");
  assert.equal(removeNote(body, "@2"), "Paragraph.\n\nAnother.");
});

test("an ordinary HTML comment is not a note", () => {
  const body = "<!-- just a comment -->\n\nParagraph.";
  assert.deepEqual(parseNotes(body), []);
  assert.equal(stripNotes(body), body);
});

test("insertNote puts the comment directly above the target block", () => {
  const body = "First paragraph.\n\nSecond paragraph.\n";
  const next = insertNote(body, 2, note({ quote: "Second" }));
  const lines = next.split("\n");
  assert.equal(lines[0], "First paragraph.");
  assert.equal(lines[1], "");
  assert.equal(lines[2], "<!-- flux:note id=n7k2m4x8 kind=task at=2026-08-10T09:12:04Z");
  // The comment abuts the block it annotates, with no blank line between.
  assert.equal(lines[lines.indexOf("-->") + 1], "Second paragraph.");
  assert.equal(parseNotes(next)[0].quote, "Second");
});

test("insertNote adds a blank line when the preceding line is not blank", () => {
  const next = insertNote("Alpha.\nBravo.", 1, note());
  const lines = next.split("\n");
  assert.equal(lines[0], "Alpha.");
  assert.equal(lines[1], "");
  assert.match(lines[2], /^<!-- flux:note/);
});

test("insertNote at the top of the body adds no leading blank line", () => {
  const next = insertNote("Alpha.", 0, note());
  assert.match(next.split("\n")[0], /^<!-- flux:note/);
});

test("inserting above an already-annotated block keeps both notes on it", () => {
  const body = insertNote("Target paragraph.", 0, note({ id: "aaa" }));
  const targetLine = body.split("\n").indexOf("Target paragraph.");
  const next = insertNote(body, targetLine, note({ id: "bbb" }));
  assert.deepEqual(
    parseNotes(next).map((n) => n.id),
    ["aaa", "bbb"]
  );
  assert.equal(stripNotes(next).trim(), "Target paragraph.");
});

test("removeNote deletes only the named note and leaves the prose intact", () => {
  const body = insertNote(
    insertNote("Target paragraph.\n", 0, note({ id: "aaa", text: "First." })),
    0,
    note({ id: "bbb", text: "Second." })
  );
  const next = removeNote(body, "aaa");
  assert.ok(next !== null);
  assert.deepEqual(
    parseNotes(next).map((n) => n.id),
    ["bbb"]
  );
  assert.match(next, /Target paragraph\./);
});

test("removeNote reports an unknown or missing id rather than silently succeeding", () => {
  const body = insertNote("Paragraph.", 0, note({ id: "aaa" }));
  assert.equal(removeNote(body, "nope"), null);
  assert.equal(removeNote(body, ""), null);
});

test("removing the only note restores the original body", () => {
  const original = "First paragraph.\n\nSecond paragraph.\n";
  const withNote = insertNote(original, 2, note());
  assert.equal(removeNote(withNote, "n7k2m4x8"), original);
});

test("updateNote rewrites a note in place, keeping everything that anchors it", () => {
  const original = "First paragraph.\n\nSecond paragraph.\n";
  const body = insertNote(original, 2, note({ quote: "Second", by: "elmir" }));

  const next = updateNote(body, "n7k2m4x8", { text: "Reworded.", kind: "remark" });
  assert.ok(next !== null);
  const parsed = parseNotes(next);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].text, "Reworded.");
  assert.equal(parsed[0].kind, "remark");
  // Id, timestamp, author and quote are what make this the same note amended
  // rather than a new one, so an edit must carry all four over.
  assert.equal(parsed[0].id, "n7k2m4x8");
  assert.equal(parsed[0].at, "2026-08-10T09:12:04Z");
  assert.equal(parsed[0].by, "elmir");
  assert.equal(parsed[0].quote, "Second");
  // ...and it still abuts the block it annotates, with the prose untouched.
  const lines = next.split("\n");
  assert.equal(lines[lines.indexOf("-->") + 1], "Second paragraph.");
  assert.equal(stripNotes(next), original);
});

test("updateNote changes only what it is given", () => {
  const body = insertNote("Paragraph.", 0, note({ text: "Original." }));

  const retyped = updateNote(body, "n7k2m4x8", { kind: "remark" });
  assert.ok(retyped !== null);
  assert.deepEqual(
    parseNotes(retyped).map((n) => [n.kind, n.text]),
    [["remark", "Original."]]
  );

  const reworded = updateNote(body, "n7k2m4x8", { text: "Rewritten." });
  assert.ok(reworded !== null);
  assert.deepEqual(
    parseNotes(reworded).map((n) => [n.kind, n.text]),
    [["task", "Rewritten."]]
  );
});

test("updateNote leaves the other notes stacked on a block alone", () => {
  const body = insertNote(
    insertNote("Target paragraph.\n", 0, note({ id: "aaa", text: "First." })),
    0,
    note({ id: "bbb", text: "Second." })
  );
  const next = updateNote(body, "aaa", { text: "First, rewritten.", kind: "remark" });
  assert.ok(next !== null);
  assert.deepEqual(
    parseNotes(next).map((n) => [n.id, n.kind, n.text]),
    [
      ["bbb", "task", "Second."],
      ["aaa", "remark", "First, rewritten."],
    ]
  );
  assert.equal(stripNotes(next).trim(), "Target paragraph.");
});

test("updateNote reports an unknown or missing id rather than silently succeeding", () => {
  const body = insertNote("Paragraph.", 0, note({ id: "aaa" }));
  assert.equal(updateNote(body, "nope", { text: "Rewritten." }), null);
  assert.equal(updateNote(body, "", { text: "Rewritten." }), null);
});

test("updateNote stamps a real id on a hand-written note so the next edit finds it", () => {
  const body = "Paragraph.\n\n<!-- flux:note\nDo the thing.\n-->\nAnother.";
  const next = updateNote(body, "@2", { text: "Do the other thing." });
  assert.ok(next !== null);
  const parsed = parseNotes(next);
  assert.match(parsed[0].id, /^[a-z0-9]{8}$/);
  assert.equal(parsed[0].text, "Do the other thing.");
  // Addressable by name now, rather than by whatever line it happens to sit on.
  assert.equal(updateNote(next, "@2", { text: "Again." }), null);
});

test("text rewritten into a note is escaped, not left to end the comment early", () => {
  const next = updateNote(insertNote("Paragraph.", 0, note()), "n7k2m4x8", {
    text: "Point --> there",
  });
  assert.ok(next !== null);
  assert.equal(next.split("\n").filter((l) => l.trim() === "-->").length, 1);
  assert.equal(parseNotes(next)[0].text, "Point --> there");
});

test("splitFrontmatter preserves the header bytes exactly", () => {
  const raw = "---\ntitle: Deploy\nid: abc\n---\n\nBody text.\n";
  const { header, body } = splitFrontmatter(raw);
  assert.equal(header, "---\ntitle: Deploy\nid: abc\n---\n");
  assert.equal(body, "\nBody text.\n");
  assert.equal(header + body, raw);
});

test("splitFrontmatter treats a file without frontmatter as all body", () => {
  const raw = "Just a body.\n";
  assert.deepEqual(splitFrontmatter(raw), { header: "", body: raw });
  // An opening delimiter that is never closed is not frontmatter either.
  assert.deepEqual(splitFrontmatter("---\ntitle: x\n"), {
    header: "",
    body: "---\ntitle: x\n",
  });
});

test("note line numbers are relative to the body, so they splice back correctly", () => {
  const raw = "---\ntitle: Deploy\n---\n\nFirst paragraph.\n\nSecond paragraph.\n";
  const { header, body } = splitFrontmatter(raw);
  const targetLine = body.split("\n").indexOf("Second paragraph.");
  const next = header + insertNote(body, targetLine, note());
  const parsed = parseNotes(splitFrontmatter(next).body);
  assert.equal(parsed.length, 1);
  // Reading the note's line back out of the body lands on the comment itself.
  assert.match(splitFrontmatter(next).body.split("\n")[parsed[0].line], /^<!-- flux:note/);
  assert.match(next, /^---\ntitle: Deploy\n---\n/);
});

test("note ids are short, alphanumeric and distinct", () => {
  const ids = new Set(Array.from({ length: 200 }, () => newNoteId()));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, /^[a-z0-9]{8}$/);
});

test("resolving a stacked note closes the gap instead of widening it", () => {
  const original = "## Deploy\n\nParagraph.\n";
  const target = original.split("\n").indexOf("Paragraph.");
  const one = insertNote(original, target, note({ id: "aaa" }));
  const two = insertNote(one, one.split("\n").indexOf("Paragraph."), note({ id: "bbb" }));

  const afterFirst = removeNote(two, "aaa");
  assert.ok(afterFirst !== null);
  assert.doesNotMatch(afterFirst, /\n\n\n/, "a blank line accumulated");
  assert.deepEqual(
    parseNotes(afterFirst).map((n) => n.id),
    ["bbb"]
  );

  // ...and resolving the last one gets all the way back to the original prose.
  assert.equal(removeNote(afterFirst, "bbb"), original);
});

test("note syntax inside a code fence is an example, not a note", () => {
  const body = [
    "Here is what a note looks like:",
    "",
    "```markdown",
    "<!-- flux:note id=demo kind=task",
    "> restart the workers manually",
    "",
    "Rewrite this paragraph.",
    "-->",
    "After the image is pushed...",
    "```",
    "",
    "<!-- flux:note id=real kind=task",
    "This one is real.",
    "-->",
    "Annotated paragraph.",
  ].join("\n");

  // The renderer never sees fenced lines, so the scanner must not either —
  // otherwise a page documenting the syntax sprouts a phantom note.
  assert.deepEqual(
    parseNotes(body).map((n) => n.id),
    ["real"]
  );
  // ...and search must not gut the code block while stripping the real note.
  assert.match(stripNotes(body), /<!-- flux:note id=demo/);
  assert.doesNotMatch(stripNotes(body), /This one is real/);
});

test("tilde fences and fences with a longer closing rail are both respected", () => {
  assert.deepEqual(parseNotes("~~~\n<!-- flux:note id=a kind=task\nx\n-->\n~~~"), []);
  // A closing rail may be longer than the opening one, but not shorter.
  assert.deepEqual(parseNotes("```\n<!-- flux:note id=a kind=task\nx\n-->\n`````"), []);
  // An indented code block is already excluded by the four-space rule.
  assert.deepEqual(parseNotes("    <!-- flux:note id=a kind=task\n    x\n    -->"), []);
});
