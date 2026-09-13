import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTranscript } from "./transcript-parser.js";
import { segment } from "./segmenter.js";
import {
  encodeProjectDir,
  harvestSession,
  isKb25Session,
  underRepo,
  type HarvestConfig,
} from "./harvest-core.js";
import type { HarvestEvent } from "./event-schema.js";
import { REPO_ROOT, assistant, toStream, userPrompt } from "./fixtures.js";

type Raw = Parameters<typeof toStream>[0][number];

const cfg: HarvestConfig = { repoRoot: REPO_ROOT, nonKb25Mode: "off" };

async function harvest(raw: Raw[], priorEmitted: string[] | null, config = cfg) {
  const session = await parseTranscript(toStream(raw));
  return harvestSession(session, segment(session), priorEmitted, config, "T");
}

test("encodeProjectDir matches Claude Code's per-project directory naming", () => {
  assert.equal(
    encodeProjectDir("/Users/elmir.mamedov/dev/flux"),
    "-Users-elmir-mamedov-dev-flux"
  );
});

test("underRepo matches the root and descendants but not sibling prefixes", () => {
  assert.equal(underRepo("/repo/kb25", "/repo/kb25"), true);
  assert.equal(underRepo("/repo/kb25", "/repo/kb25/app"), true);
  assert.equal(underRepo("/repo/kb25", "/repo/kb25-app"), false);
  assert.equal(underRepo("/repo/kb25", undefined), false);
});

test("isKb25Session requires most located turns to be inside the repo", async () => {
  const inRepo = await parseTranscript(
    toStream([userPrompt("go", { uuid: "u1", cwd: "/repo/kb25/app" })])
  );
  assert.equal(isKb25Session(REPO_ROOT, inRepo), true);

  const elsewhere = await parseTranscript(
    toStream([userPrompt("go", { uuid: "u1", cwd: "/somewhere/else" })])
  );
  assert.equal(isKb25Session(REPO_ROOT, elsewhere), false);
});

test("re-running only emits tasks not already emitted (watermark honored)", async () => {
  const run1 = await harvest(
    [
      userPrompt("first", { uuid: "u1" }),
      assistant({ uuid: "a1", parentUuid: "u1", text: ["done one"] }),
    ],
    null
  );
  assert.deepEqual(run1.emittedTaskUuids, ["u1"]);
  assert.ok(run1.events.some((e) => e.taskId === "sess-test#u1"));

  // Append a second task; re-run with the prior watermark.
  const run2 = await harvest(
    [
      userPrompt("first", { uuid: "u1" }),
      assistant({ uuid: "a1", parentUuid: "u1", text: ["done one"] }),
      userPrompt("second", { uuid: "u2", parentUuid: "a1" }),
      assistant({ uuid: "a2", parentUuid: "u2", text: ["done two"] }),
    ],
    run1.emittedTaskUuids
  );

  assert.deepEqual(run2.emittedTaskUuids, ["u1", "u2"]);
  assert.ok(run2.events.length > 0);
  assert.ok(
    run2.events.every((e) => e.taskId === "sess-test#u2"),
    "only the new task's events should be emitted"
  );
});

test("non-kb25 tasks are dropped by default, kept with --full, redacted with --redacted", async () => {
  const raw: Raw[] = [
    userPrompt("outside work", { uuid: "u1", cwd: "/other/project" }),
    assistant({ uuid: "a1", parentUuid: "u1", text: ["ok"] }),
  ];

  const off = await harvest(raw, null, { repoRoot: REPO_ROOT, nonKb25Mode: "off" });
  assert.equal(off.events.length, 0);

  const full = await harvest(raw, null, { repoRoot: REPO_ROOT, nonKb25Mode: "full" });
  const fullTask = full.events.find((e): e is Extract<HarvestEvent, { kind: "task" }> => e.kind === "task");
  assert.ok(fullTask);
  assert.equal(fullTask!.promptText, "outside work");

  const redacted = await harvest(raw, null, { repoRoot: REPO_ROOT, nonKb25Mode: "redacted" });
  const redactedTask = redacted.events.find((e): e is Extract<HarvestEvent, { kind: "task" }> => e.kind === "task");
  assert.ok(redactedTask);
  assert.match(redactedTask!.promptText, /^\[redacted \d+ chars sha256:[0-9a-f]{8}\]$/);
});
