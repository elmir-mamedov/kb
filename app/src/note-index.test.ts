import { test } from "node:test";
import assert from "node:assert/strict";
import { Content } from "./content.js";
import {
  collectNotes,
  groupNotesByPage,
  relativeAge,
  summarizeNotes,
  type IndexedNote,
} from "./note-index.js";
import { makeTempKb, type TempKb } from "./test-helpers.js";

/** A note comment as it sits in a page body, above the block it annotates. */
function noteComment(
  id: string,
  kind: string,
  at: string,
  quote: string,
  text: string
): string {
  return `<!-- flux:note id=${id} kind=${kind} at=${at} by=elmir\n> ${quote}\n\n${text}\n-->`;
}

/** A bare `IndexedNote` for the pure helpers, which never touch the filesystem. */
function indexed(fields: {
  id?: string;
  at?: string;
  line?: number;
  slug?: string;
  title?: string;
}): IndexedNote {
  return {
    id: fields.id ?? "n1",
    kind: "task",
    at: fields.at ?? "2026-08-01T00:00:00Z",
    text: "do the thing",
    line: fields.line ?? 0,
    page: {
      slug: fields.slug ?? "docs/page",
      title: fields.title ?? "Page",
      fsPath: `/tmp/${fields.slug ?? "docs/page"}.md`,
    },
  };
}

/** Two spaces, each with a task note, plus a remark to filter against. */
async function seed(dir: string): Promise<Content> {
  const content = new Content(dir);
  await content.createSpace("Docs");
  await content.createSpace("Other");

  await content.createPage(
    "docs",
    "Deploy",
    `${noteComment("aaa11111", "task", "2026-08-02T10:00:00Z", "the workers", "restart them")}\nRestart the workers.`
  );
  await content.createPage(
    "docs",
    "Notes Page",
    `${noteComment("bbb22222", "remark", "2026-08-03T10:00:00Z", "context", "just context")}\nSome prose.`
  );
  await content.createPage(
    "other",
    "Elsewhere",
    `${noteComment("ccc33333", "task", "2026-08-04T10:00:00Z", "elsewhere", "fix it")}\nOther space.`
  );
  return content;
}

test("collectNotes filters an agent's notes out of a person's work", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = new Content(kb.dir);
    await content.createSpace("Docs");
    await content.createPage(
      "docs",
      "Deploy",
      [
        noteComment("aaa11111", "task", "2026-08-02T10:00:00Z", "the workers", "restart them"),
        noteComment("bbb22222", "agent", "2026-08-03T10:00:00Z", "the workers", "renamed in 08"),
        "Restart the workers.",
      ].join("\n")
    );

    // The dashboard and kb_list_notes share this path, so the two have to be
    // separable: an agent's note is not work a person asked for.
    const tasks = await collectNotes(content, "live", { kind: "task" });
    assert.deepEqual(
      tasks.map((note) => note.id),
      ["aaa11111"]
    );
    const agent = await collectNotes(content, "live", { kind: "agent" });
    assert.deepEqual(
      agent.map((note) => note.id),
      ["bbb22222"]
    );
    assert.equal((await collectNotes(content, "live")).length, 2);
  } finally {
    await kb.cleanup();
  }
});

test("collectNotes scoped to a space returns only that space's notes", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = await seed(kb.dir);

    const found = await collectNotes(content, "live", { space: "docs" });
    const ids = found.map((note) => note.id).sort();
    assert.deepEqual(ids, ["aaa11111", "bbb22222"]);
  } finally {
    await kb.cleanup();
  }
});

test("collectNotes filters to one kind, so tasks exclude remarks", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = await seed(kb.dir);

    const tasks = await collectNotes(content, "live", { space: "docs", kind: "task" });
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, "aaa11111");
    assert.equal(tasks[0].page.title, "Deploy");
    assert.equal(tasks[0].quote, "the workers");
  } finally {
    await kb.cleanup();
  }
});

test("collectNotes finds a note left on the space's own landing page", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = new Content(kb.dir);
    await content.createSpace("Docs");
    // Straight onto docs/index.md — the page `spaceTree` omits, which is why the
    // sweep walks the full tree and picks the space node out of it.
    await content.updateRaw(
      "docs",
      `---\ntitle: Docs\n---\n\n${noteComment("ddd44444", "task", "2026-08-05T10:00:00Z", "landing", "explain this")}\nWelcome.\n`
    );

    const found = await collectNotes(content, "live", { space: "docs", kind: "task" });
    assert.equal(found.length, 1, "a note on the landing page must not be skipped");
    assert.equal(found[0].id, "ddd44444");
    assert.equal(found[0].page.slug, "docs");
  } finally {
    await kb.cleanup();
  }
});

test("collectNotes walks past folders, which have no body to annotate", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = new Content(kb.dir);
    await content.createSpace("Docs");
    await content.createFolder("docs", "Runbooks");
    await content.createPage(
      "docs/runbooks",
      "Inside",
      `${noteComment("eee55555", "task", "2026-08-06T10:00:00Z", "inside", "nested work")}\nNested.`
    );

    const found = await collectNotes(content, "live", { space: "docs", kind: "task" });
    assert.equal(found.length, 1);
    assert.equal(found[0].page.slug, "docs/runbooks/inside");
  } finally {
    await kb.cleanup();
  }
});

test("collectNotes hides an archived page's notes unless the filter widens", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = new Content(kb.dir);
    await content.createSpace("Docs");
    const page = await content.createPage(
      "docs",
      "Retired",
      `${noteComment("fff66666", "task", "2026-08-07T10:00:00Z", "retired", "old work")}\nOld.`
    );
    await content.updateArchive(page.slug, true);

    const live = await collectNotes(content, "live", { space: "docs", kind: "task" });
    assert.equal(live.length, 0, "an archived page's notes are not open work");

    const all = await collectNotes(content, "all", { space: "docs", kind: "task" });
    assert.equal(all.length, 1);
    assert.equal(all[0].id, "fff66666");
  } finally {
    await kb.cleanup();
  }
});

test("collectNotes with no scope sweeps every space", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = await seed(kb.dir);

    const tasks = await collectNotes(content, "live", { kind: "task" });
    const ids = tasks.map((note) => note.id).sort();
    assert.deepEqual(ids, ["aaa11111", "ccc33333"]);
  } finally {
    await kb.cleanup();
  }
});

test("summarizeNotes counts notes and the distinct pages holding them", () => {
  const summary = summarizeNotes([
    indexed({ id: "a", slug: "docs/one", at: "2026-08-02T00:00:00Z" }),
    indexed({ id: "b", slug: "docs/one", at: "2026-08-04T00:00:00Z" }),
    indexed({ id: "c", slug: "docs/two", at: "2026-08-03T00:00:00Z" }),
  ]);

  assert.equal(summary.total, 3);
  assert.equal(summary.pages, 2);
  assert.equal(summary.oldestAt, "2026-08-02T00:00:00Z");
  assert.equal(summary.newestAt, "2026-08-04T00:00:00Z");
});

test("summarizeNotes ignores undated notes rather than treating them as ancient", () => {
  const summary = summarizeNotes([
    indexed({ id: "a", at: "" }),
    indexed({ id: "b", at: "2026-08-02T00:00:00Z", slug: "docs/two" }),
  ]);

  assert.equal(summary.total, 2, "an undated note is still a note");
  assert.equal(summary.oldestAt, "2026-08-02T00:00:00Z");
});

test("summarizeNotes reports empty ends when nothing carries a stamp", () => {
  const summary = summarizeNotes([indexed({ at: "" }), indexed({ at: "nonsense" })]);
  assert.equal(summary.oldestAt, "");
  assert.equal(summary.newestAt, "");
});

test("groupNotesByPage buckets per page, freshest page first", () => {
  const groups = groupNotesByPage([
    indexed({ id: "old", slug: "docs/stale", title: "Stale", at: "2026-08-01T00:00:00Z" }),
    indexed({ id: "new", slug: "docs/fresh", title: "Fresh", at: "2026-08-09T00:00:00Z" }),
  ]);

  assert.deepEqual(
    groups.map((group) => group.slug),
    ["docs/fresh", "docs/stale"]
  );
});

test("groupNotesByPage keeps a page's notes in document order", () => {
  const groups = groupNotesByPage([
    indexed({ id: "second", line: 40, at: "2026-08-09T00:00:00Z" }),
    indexed({ id: "first", line: 4, at: "2026-08-01T00:00:00Z" }),
  ]);

  assert.equal(groups.length, 1);
  assert.deepEqual(
    groups[0].notes.map((note) => note.id),
    ["first", "second"],
    "notes read in the order they appear on the page, not by age"
  );
});

test("groupNotesByPage carries each page's slug, id and title through", () => {
  const [group] = groupNotesByPage([
    indexed({ slug: "docs/runbooks/deploy", title: "Deploy" }),
  ]);
  assert.equal(group.slug, "docs/runbooks/deploy");
  assert.equal(group.title, "Deploy");
  assert.equal(group.notes.length, 1);
});

test("relativeAge names the unit it actually measured", () => {
  const now = Date.parse("2026-08-17T12:00:00Z");
  assert.equal(relativeAge("2026-08-17T11:59:30Z", now), "just now");
  assert.equal(relativeAge("2026-08-17T11:45:00Z", now), "15m ago");
  // The client's divisor-table twin gets this one wrong, reporting "1m ago".
  assert.equal(relativeAge("2026-08-17T11:00:00Z", now), "1h ago");
  assert.equal(relativeAge("2026-08-15T12:00:00Z", now), "2d ago");
  assert.equal(relativeAge("2026-07-27T12:00:00Z", now), "3w ago");
  assert.equal(relativeAge("2024-08-17T12:00:00Z", now), "2y ago");
});

test("relativeAge returns nothing for a missing or unreadable stamp", () => {
  const now = Date.parse("2026-08-17T12:00:00Z");
  assert.equal(relativeAge("", now), "");
  assert.equal(relativeAge("whenever", now), "");
});

test("relativeAge does not run backwards for a stamp in the future", () => {
  const now = Date.parse("2026-08-17T12:00:00Z");
  assert.equal(relativeAge("2026-09-01T00:00:00Z", now), "just now");
});
