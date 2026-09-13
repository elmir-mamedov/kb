import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeSink } from "./sink.js";
import { SCHEMA_VERSION, type HarvestEvent } from "./event-schema.js";

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "kb25-harvest-test-"));
}

const sampleEvent: HarvestEvent = {
  schemaVersion: SCHEMA_VERSION,
  emittedAt: "2026-07-02T00:00:00.000Z",
  source: "transcript",
  sessionId: "s1",
  taskId: "s1#u1",
  kind: "clarifying_question",
  method: "text_terminal_question",
  questionText: "what?",
};

test("append writes one JSON object per line and is additive", async () => {
  const dir = await tempDir();
  try {
    const sink = makeSink(dir);
    await sink.append([sampleEvent]);
    await sink.append([{ ...sampleEvent, taskId: "s1#u2" }]);

    const raw = await fs.readFile(sink.eventsPath, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    assert.equal(lines.length, 2);
    assert.equal((JSON.parse(lines[0]) as HarvestEvent).taskId, "s1#u1");
    assert.equal((JSON.parse(lines[1]) as HarvestEvent).taskId, "s1#u2");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("append of an empty array does not create the events file", async () => {
  const dir = await tempDir();
  try {
    const sink = makeSink(dir);
    await sink.append([]);
    await assert.rejects(() => fs.readFile(sink.eventsPath, "utf8"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("loadState returns empty state when absent and round-trips after save", async () => {
  const dir = await tempDir();
  try {
    const sink = makeSink(dir);
    const empty = await sink.loadState();
    assert.deepEqual(empty.sessions, {});

    empty.sessions["/x.jsonl"] = {
      sessionId: "s1",
      filePath: "/x.jsonl",
      fileSize: 10,
      mtimeMs: 123,
      lineCount: 3,
      emittedTaskUuids: ["u1"],
    };
    empty.lastRunAt = "2026-07-02T00:00:00.000Z";
    await sink.saveState(empty);

    const reloaded = await sink.loadState();
    assert.deepEqual(reloaded.sessions["/x.jsonl"].emittedTaskUuids, ["u1"]);
    assert.equal(reloaded.lastRunAt, "2026-07-02T00:00:00.000Z");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
