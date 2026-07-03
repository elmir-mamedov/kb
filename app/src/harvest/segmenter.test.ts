import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTranscript } from "./transcript-parser.js";
import { segment } from "./segmenter.js";
import { SESSION_ID, assistant, toStream, userPrompt, userToolResult } from "./fixtures.js";

test("a real prompt starts a task; meta and tool_result turns do not", async () => {
  const session = await parseTranscript(
    toStream([
      userPrompt("<system-reminder> caveat", { uuid: "m1", isMeta: true }),
      userPrompt("actual request", { uuid: "u1", parentUuid: "m1" }),
      assistant({
        uuid: "a1",
        parentUuid: "u1",
        toolUses: [{ id: "c1", name: "mcp__flux-kb__kb_search" }],
      }),
      userToolResult([{ toolUseId: "c1", content: "[]" }], { uuid: "u2", parentUuid: "a1" }),
      assistant({ uuid: "a2", parentUuid: "u2", text: ["done"] }),
    ])
  );

  const tasks = segment(session);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].startUuid, "u1");
  assert.equal(tasks[0].taskId, `${SESSION_ID}#u1`);
  // The meta preamble is dropped; the task holds the prompt + 3 following turns.
  assert.equal(tasks[0].turns.length, 4);
});

test("two consecutive prompts produce two tasks", async () => {
  const session = await parseTranscript(
    toStream([
      userPrompt("first", { uuid: "u1" }),
      assistant({ uuid: "a1", parentUuid: "u1", text: ["ok"] }),
      userPrompt("second", { uuid: "u2", parentUuid: "a1" }),
      assistant({ uuid: "a2", parentUuid: "u2", text: ["ok again"] }),
    ])
  );

  const tasks = segment(session);
  assert.equal(tasks.length, 2);
  assert.deepEqual(
    tasks.map((t) => t.startUuid),
    ["u1", "u2"]
  );
  assert.equal(tasks[0].turns.length, 2);
  assert.equal(tasks[1].turns.length, 2);
});

test("sidechain turns attach to the enclosing task, not the main line", async () => {
  const session = await parseTranscript(
    toStream([
      userPrompt("spawn a subagent", { uuid: "u1" }),
      assistant({
        uuid: "a1",
        parentUuid: "u1",
        toolUses: [{ id: "task1", name: "Task" }],
      }),
      assistant({ uuid: "s1", parentUuid: "a1", isSidechain: true, text: ["subagent thinking"] }),
      assistant({ uuid: "a2", parentUuid: "a1", text: ["subagent done"] }),
    ])
  );

  const tasks = segment(session);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].sidechainTurns.length, 1);
  assert.equal(tasks[0].sidechainTurns[0].uuid, "s1");
  // main-line turns: prompt + a1 + a2 (the sidechain turn is excluded)
  assert.equal(tasks[0].turns.length, 3);
});

test("startedAt and endedAt bound the task by turn timestamps", async () => {
  const session = await parseTranscript(
    toStream([
      userPrompt("go", { uuid: "u1", ts: "2026-01-01T10:00:00.000Z" }),
      assistant({ uuid: "a1", parentUuid: "u1", ts: "2026-01-01T10:05:00.000Z", text: ["done"] }),
    ])
  );

  const [task] = segment(session);
  assert.equal(task.startedAt, "2026-01-01T10:00:00.000Z");
  assert.equal(task.endedAt, "2026-01-01T10:05:00.000Z");
});
