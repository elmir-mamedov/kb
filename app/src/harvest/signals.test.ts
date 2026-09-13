import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTranscript } from "./transcript-parser.js";
import { segment } from "./segmenter.js";
import { deriveSpace, endsWithQuestion, extractSignals } from "./signals.js";
import type { HarvestEvent } from "./event-schema.js";
import { assistant, toStream, userPrompt, userToolResult } from "./fixtures.js";

type Raw = Parameters<typeof toStream>[0][number];

async function eventsFor(raw: Raw[]): Promise<HarvestEvent[]> {
  const session = await parseTranscript(toStream(raw));
  return extractSignals(session, segment(session), { emittedAt: "2026-07-02T00:00:00.000Z" });
}

function byKind<K extends HarvestEvent["kind"]>(
  events: HarvestEvent[],
  kind: K
): Extract<HarvestEvent, { kind: K }>[] {
  return events.filter((e): e is Extract<HarvestEvent, { kind: K }> => e.kind === kind);
}

test("endsWithQuestion tolerates trailing whitespace and markdown", () => {
  assert.equal(endsWithQuestion("What next?"), true);
  assert.equal(endsWithQuestion("What next?**  "), true);
  assert.equal(endsWithQuestion("Here is the answer."), false);
});

test("detects a terminal-question turn but not one that also acted", async () => {
  const events = await eventsFor([
    userPrompt("add a release note", { uuid: "u1" }),
    assistant({ uuid: "a1", parentUuid: "u1", text: ["What should it document?"] }),
  ]);

  const clarifying = byKind(events, "clarifying_question");
  assert.equal(clarifying.length, 1);
  assert.equal(clarifying[0].method, "text_terminal_question");
  assert.equal(clarifying[0].questionText, "What should it document?");
});

test("a question that also calls a tool is not a clarifying signal", async () => {
  const events = await eventsFor([
    userPrompt("find pages", { uuid: "u1" }),
    assistant({
      uuid: "a1",
      parentUuid: "u1",
      text: ["Should I search everywhere?"],
      toolUses: [{ id: "c1", name: "mcp__kb25__kb_search" }],
    }),
  ]);

  assert.equal(byKind(events, "clarifying_question").length, 0);
});

test("AskUserQuestion is detected via the tool with its question text", async () => {
  const events = await eventsFor([
    userPrompt("plan it", { uuid: "u1" }),
    assistant({
      uuid: "a1",
      parentUuid: "u1",
      toolUses: [
        {
          id: "c1",
          name: "AskUserQuestion",
          input: { questions: [{ question: "Which approach do you prefer?" }] },
        },
      ],
    }),
  ]);

  const clarifying = byKind(events, "clarifying_question");
  assert.equal(clarifying.length, 1);
  assert.equal(clarifying[0].method, "ask_tool");
  assert.equal(clarifying[0].questionText, "Which approach do you prefer?");
});

test("token usage is summed and models are collected distinctly per task", async () => {
  const events = await eventsFor([
    userPrompt("go", { uuid: "u1" }),
    assistant({
      uuid: "a1",
      parentUuid: "u1",
      model: "claude-opus-4-8",
      text: ["step one"],
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5 },
    }),
    assistant({
      uuid: "a2",
      parentUuid: "a1",
      model: "claude-opus-4-8",
      text: ["step two"],
      usage: { input_tokens: 50, output_tokens: 10 },
    }),
  ]);

  const [task] = byKind(events, "task");
  assert.equal(task.usage.turns, 2);
  assert.equal(task.usage.inputTokens, 150);
  assert.equal(task.usage.outputTokens, 30);
  assert.equal(task.usage.cacheReadTokens, 5);
  assert.deepEqual(task.usage.models, ["claude-opus-4-8"]);
});

test("kb25 tool calls are extracted with commit SHA and ok status from results", async () => {
  const events = await eventsFor([
    userPrompt("edit a page", { uuid: "u1" }),
    assistant({
      uuid: "a1",
      parentUuid: "u1",
      toolUses: [
        { id: "c1", name: "mcp__kb25__kb_update_page", input: { slug: "kb25/x" } },
        { id: "c2", name: "mcp__kb25__kb_get_page", input: { slug: "nope" } },
      ],
    }),
    userToolResult(
      [
        { toolUseId: "c1", content: '{"updated":true,"slug":"kb25/x","commit":"abc1234"}' },
        { toolUseId: "c2", content: "not found", isError: true },
      ],
      { uuid: "u2", parentUuid: "a1" }
    ),
  ]);

  const calls = byKind(events, "kb25_tool_call");
  assert.equal(calls.length, 2);

  const update = calls.find((c) => c.name === "mcp__kb25__kb_update_page");
  assert.ok(update);
  assert.equal(update!.ok, true);
  assert.equal(update!.commit, "abc1234");
  assert.equal(update!.space, "kb25");

  const get = calls.find((c) => c.name === "mcp__kb25__kb_get_page");
  assert.ok(get);
  assert.equal(get!.ok, false);
  assert.equal(get!.commit, undefined);
  assert.equal(get!.space, "nope");

  // The task rollup lists the distinct spaces it touched.
  const [task] = byKind(events, "task");
  assert.deepEqual(task.spaces, ["kb25", "nope"]);
});

test("deriveSpace reads the space from a slug, parent, space arg, or result", () => {
  assert.equal(deriveSpace({ slug: "engineering/runbooks/deploy" }), "engineering");
  assert.equal(deriveSpace({ sourceSlug: "kb25/logging" }), "kb25");
  assert.equal(deriveSpace({ parent: "release-notes-2/notes" }), "release-notes-2");
  assert.equal(deriveSpace({ space: "kb25" }), "kb25");
  // kb_create_space passes a title, not a slug — fall back to the result's slug.
  assert.equal(deriveSpace({ title: "Marketing" }, '{"created":true,"slug":"marketing"}'), "marketing");
  // No space-bearing argument and no usable result (e.g. kb_list_spaces).
  assert.equal(deriveSpace({}, "[]"), undefined);
});

test("non-kb25 tools are ignored and a reasoning trace is assembled in order", async () => {
  const events = await eventsFor([
    userPrompt("go", { uuid: "u1" }),
    assistant({
      uuid: "a1",
      parentUuid: "u1",
      thinking: ["let me think"],
      text: ["here goes"],
      toolUses: [{ id: "c1", name: "Read" }],
    }),
  ]);

  assert.equal(byKind(events, "kb25_tool_call").length, 0);
  const [reasoning] = byKind(events, "reasoning");
  assert.deepEqual(
    reasoning.blocks.map((b) => `${b.kind}:${b.text}`),
    ["thinking:let me think", "text:here goes"]
  );
});
