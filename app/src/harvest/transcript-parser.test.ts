import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { parseTranscript } from "./transcript-parser.js";
import {
  SESSION_ID,
  assistant,
  toJsonl,
  toStream,
  userPrompt,
  userPromptBlocks,
  userToolResult,
} from "./fixtures.js";

test("parses assistant and user turns and captures the session id", async () => {
  const session = await parseTranscript(
    toStream([
      userPrompt("do the thing", { uuid: "u1" }),
      assistant({ uuid: "a1", parentUuid: "u1", text: ["on it"] }),
    ])
  );

  assert.equal(session.sessionId, SESSION_ID);
  assert.equal(session.turns.length, 2);
  assert.equal(session.parseErrors, 0);
  assert.equal(session.turns[0].role, "user");
  assert.equal(session.turns[0].userKind, "prompt");
  assert.equal(session.turns[0].promptText, "do the thing");
  assert.deepEqual(session.turns[1].texts, ["on it"]);
});

test("blank lines are skipped and junk lines count as parse errors without throwing", async () => {
  const jsonl =
    "\n" +
    toJsonl([userPrompt("hi", { uuid: "u1" })]) +
    "not json at all\n" +
    "   \n" +
    "{ broken: }\n";
  const session = await parseTranscript(Readable.from(jsonl));

  assert.equal(session.turns.length, 1);
  assert.equal(session.parseErrors, 2); // the two non-JSON lines only
});

test("user prompt content can be a plain string or an array of text blocks", async () => {
  const session = await parseTranscript(
    toStream([
      userPrompt("string form", { uuid: "u1" }),
      userPromptBlocks(["block one", "block two"], { uuid: "u2", parentUuid: "u1" }),
    ])
  );

  assert.equal(session.turns[0].promptText, "string form");
  assert.equal(session.turns[1].userKind, "prompt");
  assert.equal(session.turns[1].promptText, "block one\n\nblock two");
});

test("tool_result content is flattened whether it is a string or an array", async () => {
  const session = await parseTranscript(
    toStream([
      userToolResult([{ toolUseId: "t1", content: "plain string result" }], { uuid: "u1" }),
      userToolResult(
        [{ toolUseId: "t2", content: [{ type: "text", text: "array result" }] }],
        { uuid: "u2", parentUuid: "u1" }
      ),
    ])
  );

  assert.equal(session.turns[0].userKind, "tool_result");
  assert.equal(session.resultByToolUseId.get("t1")?.text, "plain string result");
  assert.equal(session.resultByToolUseId.get("t2")?.text, "array result");
});

test("builds parent/child and tool_use -> tool_result indexes across turns", async () => {
  const session = await parseTranscript(
    toStream([
      userPrompt("go", { uuid: "u1" }),
      assistant({
        uuid: "a1",
        parentUuid: "u1",
        toolUses: [{ id: "call1", name: "mcp__flux-kb__kb_get_page" }],
      }),
      userToolResult([{ toolUseId: "call1", content: "{\"ok\":true}" }], {
        uuid: "u2",
        parentUuid: "a1",
      }),
    ])
  );

  assert.deepEqual(session.childrenOf.get("u1"), ["a1"]);
  assert.deepEqual(session.childrenOf.get("a1"), ["u2"]);
  assert.equal(session.resultByToolUseId.get("call1")?.text, '{"ok":true}');
});
