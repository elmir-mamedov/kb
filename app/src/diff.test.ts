import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWordDiff, type DiffLine } from "./diff.js";

/** Build porcelain input from lines without relying on fragile trailing whitespace. */
const porcelain = (...lines: string[]) => lines.join("\n");

test("word change within a line yields ctx/del/add/ctx runs on one line", () => {
  const input = porcelain(
    "diff --git a/x.md b/x.md",
    "index 111..222 100644",
    "--- a/x.md",
    "+++ b/x.md",
    "@@ -1 +1 @@",
    " the ",
    "-quick",
    "+slow",
    " fox",
    "~"
  );
  const expected: DiffLine[] = [
    { type: "hunk", header: "@@ -1 +1 @@" },
    {
      type: "line",
      runs: [
        { kind: "ctx", text: "the " },
        { kind: "del", text: "quick" },
        { kind: "add", text: "slow" },
        { kind: "ctx", text: "fox" },
      ],
    },
  ];
  assert.deepEqual(parseWordDiff(input), expected);
});

test("consecutive ~ produce a blank line between content lines", () => {
  const input = porcelain("@@ -1,3 +1,3 @@", " a", "~", "~", " b", "~");
  assert.deepEqual(parseWordDiff(input), [
    { type: "hunk", header: "@@ -1,3 +1,3 @@" },
    { type: "line", runs: [{ kind: "ctx", text: "a" }] },
    { type: "line", runs: [] },
    { type: "line", runs: [{ kind: "ctx", text: "b" }] },
  ]);
});

test("an all-added patch (initial commit) marks every run as add", () => {
  const input = porcelain("@@ -0,0 +1,2 @@", "+Hello", "~", "+world", "~");
  assert.deepEqual(parseWordDiff(input), [
    { type: "hunk", header: "@@ -0,0 +1,2 @@" },
    { type: "line", runs: [{ kind: "add", text: "Hello" }] },
    { type: "line", runs: [{ kind: "add", text: "world" }] },
  ]);
});

test("preamble is skipped and 'no newline' marker is ignored; dangling line flushes", () => {
  const input = porcelain(
    "diff --git a/x.md b/x.md",
    "index 1..2 100644",
    "--- a/x.md",
    "+++ b/x.md",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "\\ No newline at end of file"
  );
  assert.deepEqual(parseWordDiff(input), [
    { type: "hunk", header: "@@ -1 +1 @@" },
    {
      type: "line",
      runs: [
        { kind: "del", text: "old" },
        { kind: "add", text: "new" },
      ],
    },
  ]);
});

test("multiple hunks each get their own header", () => {
  const input = porcelain(
    "@@ -1 +1 @@",
    "-a",
    "+b",
    "~",
    "@@ -9 +9 @@",
    "-c",
    "+d",
    "~"
  );
  const result = parseWordDiff(input);
  assert.equal(result.filter((l) => l.type === "hunk").length, 2);
  assert.equal(result.filter((l) => l.type === "line").length, 2);
});

test("empty input yields no lines", () => {
  assert.deepEqual(parseWordDiff(""), []);
});
