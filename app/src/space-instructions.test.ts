import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Content } from "./content.js";
import {
  CHAR_CAP,
  INSTRUCTIONS_LEAF,
  capState,
  ensureSpaceInstructions,
  hasSpaceInstructions,
  instructionsPayload,
  instructionsSlug,
  isInstructionsSlug,
  loadSpaceInstructions,
  makeInstructionsTokens,
  missingTokenMessage,
  type SpaceInstructions,
} from "./space-instructions.js";
import { makeTempKb, pathExists, type TempKb } from "./test-helpers.js";

/** A fixture for the pure helpers, with no filesystem involved. */
function instructions(over: Partial<SpaceInstructions> = {}): SpaceInstructions {
  const text = over.text ?? "Write in plain English. No em-dashes.";
  return {
    spaceKey: over.spaceKey ?? "de",
    text,
    chars: over.chars ?? text.length,
    truncated: over.truncated ?? false,
  };
}

/** Write instruction text into a space, bypassing the scaffolder. */
async function writeInstructions(kbDir: string, space: string, body: string): Promise<string> {
  const fsPath = path.join(kbDir, space, `${INSTRUCTIONS_LEAF}.md`);
  await fs.writeFile(fsPath, `---\ntitle: Space instructions\nid: abc123\n---\n${body}`, "utf8");
  return fsPath;
}

// --- slug helpers -----------------------------------------------------------

test("space instructions: slug helpers", () => {
  assert.equal(instructionsSlug("de"), "de/_instructions");

  assert.equal(isInstructionsSlug("de/_instructions"), true);
  assert.equal(isInstructionsSlug("/de/_instructions/"), true);
  assert.equal(isInstructionsSlug("de/notes"), false);
  // A page that merely mentions the word is not the instructions file.
  assert.equal(isInstructionsSlug("de/_instructions/child"), false);
  assert.equal(isInstructionsSlug("de/my-instructions"), false);
});

// --- loading ----------------------------------------------------------------

test("space instructions: absent file reads as no instructions", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = new Content(kb.dir);
    await content.createSpace("DE");

    assert.equal(await loadSpaceInstructions(content, "de"), null);
    assert.equal(await hasSpaceInstructions(content, "de"), false);
    // An unknown space is simply "no instructions", not an error.
    assert.equal(await loadSpaceInstructions(content, "nope"), null);
    assert.equal(await loadSpaceInstructions(content, ""), null);
  } finally {
    await kb.cleanup();
  }
});

test("space instructions: authored text is read back trimmed", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = new Content(kb.dir);
    await content.createSpace("DE");
    await writeInstructions(kb.dir, "de", "\n\nAnswer in German.\n\n");

    const loaded = await loadSpaceInstructions(content, "de");
    assert.equal(loaded?.text, "Answer in German.");
    assert.equal(loaded?.chars, "Answer in German.".length);
    assert.equal(loaded?.truncated, false);
    assert.equal(loaded?.spaceKey, "de");
    assert.equal(await hasSpaceInstructions(content, "de"), true);
  } finally {
    await kb.cleanup();
  }
});

test("space instructions: an empty body is not a rule set", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = new Content(kb.dir);
    await content.createSpace("DE");
    // Exactly the state a freshly scaffolded file is in — it must not gate writes.
    await writeInstructions(kb.dir, "de", "\n   \n\n");

    assert.equal(await loadSpaceInstructions(content, "de"), null);
  } finally {
    await kb.cleanup();
  }
});

test("space instructions: text over the cap is truncated for delivery", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = new Content(kb.dir);
    await content.createSpace("DE");
    await writeInstructions(kb.dir, "de", "x".repeat(CHAR_CAP + 250));

    const loaded = await loadSpaceInstructions(content, "de");
    assert.equal(loaded?.truncated, true);
    assert.equal(loaded?.chars, CHAR_CAP);
    assert.equal(loaded?.text.length, CHAR_CAP);
  } finally {
    await kb.cleanup();
  }
});

test("space instructions: a picked-up browser edit changes what is read", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = new Content(kb.dir);
    await content.createSpace("DE");
    await writeInstructions(kb.dir, "de", "Answer in German.");
    assert.equal((await loadSpaceInstructions(content, "de"))?.text, "Answer in German.");

    // The parse cache is keyed on mtime, so a write from the other front-end is
    // visible on the next read with no coordination between the processes.
    await new Promise((r) => setTimeout(r, 10));
    await writeInstructions(kb.dir, "de", "Answer in Czech.");
    assert.equal((await loadSpaceInstructions(content, "de"))?.text, "Answer in Czech.");
  } finally {
    await kb.cleanup();
  }
});

test("space instructions: invalid frontmatter degrades to no instructions", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = new Content(kb.dir);
    await content.createSpace("DE");
    // No title — parsePage rejects it. That must not break the space's tooling.
    const fsPath = path.join(kb.dir, "de", `${INSTRUCTIONS_LEAF}.md`);
    await fs.writeFile(fsPath, "---\nid: abc\n---\nAnswer in German.", "utf8");

    assert.equal(await loadSpaceInstructions(content, "de"), null);
  } finally {
    await kb.cleanup();
  }
});

// --- scaffolding ------------------------------------------------------------

test("space instructions: ensure creates an empty file, then is idempotent", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = new Content(kb.dir);
    await content.createSpace("DE");

    const first = await ensureSpaceInstructions(content, "de");
    assert.equal(first.created, true);
    assert.equal(first.slug, "de/_instructions");
    assert.equal(first.fsPath, path.join(kb.dir, "de", "_instructions.md"));
    assert.deepEqual(first.changedFsPaths, [first.fsPath]);
    assert.equal(await pathExists(first.fsPath), true);

    // Scaffolded with valid frontmatter but no body — not yet a rule set.
    const raw = await fs.readFile(first.fsPath, "utf8");
    assert.match(raw, /title: Space instructions/);
    assert.match(raw, /^id: \w+$/m);
    assert.equal(await loadSpaceInstructions(content, "de"), null);

    const second = await ensureSpaceInstructions(content, "de");
    assert.equal(second.created, false);
    assert.deepEqual(second.changedFsPaths, []);
    assert.equal(second.fsPath, first.fsPath);
  } finally {
    await kb.cleanup();
  }
});

test("space instructions: ensure refuses an unknown space", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = new Content(kb.dir);
    await assert.rejects(() => ensureSpaceInstructions(content, "ghost"), /Unknown space/);
    // A traversing key resolves to no space rather than escaping the KB.
    await assert.rejects(() => ensureSpaceInstructions(content, "../etc"), /Unknown space/);
  } finally {
    await kb.cleanup();
  }
});

test("space instructions: the instructions file stays out of the tree", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = new Content(kb.dir);
    await content.createSpace("DE");
    await writeInstructions(kb.dir, "de", "Answer in German.");

    // Invisible to navigation (the `_` rule), but resolvable by slug so the
    // existing editor and diff viewer work on it.
    const tree = await content.spaceTree("de", "all");
    assert.equal(tree.find((n) => n.slug.endsWith(INSTRUCTIONS_LEAF)), undefined);
    assert.notEqual(await content.resolve("de/_instructions"), null);
  } finally {
    await kb.cleanup();
  }
});

// --- cap state --------------------------------------------------------------

test("space instructions: cap state reports the overage", () => {
  assert.deepEqual(capState(10), { chars: 10, cap: CHAR_CAP, over: false, excess: 0 });
  assert.deepEqual(capState(CHAR_CAP), { chars: CHAR_CAP, cap: CHAR_CAP, over: false, excess: 0 });
  assert.deepEqual(capState(CHAR_CAP + 7), {
    chars: CHAR_CAP + 7,
    cap: CHAR_CAP,
    over: true,
    excess: 7,
  });
});

// --- tokens -----------------------------------------------------------------

test("tokens: the same space and text produce a stable token", () => {
  const tokens = makeInstructionsTokens("nonce-a");
  const a = tokens.tokenFor("de", "Answer in German.");
  assert.equal(a, tokens.tokenFor("de", "Answer in German."));
  assert.equal(tokens.verify("de", "Answer in German.", a), true);
  assert.match(a, /^[0-9a-z]{13}$/);
});

test("tokens: a wrong or missing token fails", () => {
  const tokens = makeInstructionsTokens("nonce-a");
  const good = tokens.tokenFor("de", "Answer in German.");

  assert.equal(tokens.verify("de", "Answer in German.", undefined), false);
  assert.equal(tokens.verify("de", "Answer in German.", ""), false);
  assert.equal(tokens.verify("de", "Answer in German.", "not-a-token"), false);
  // Surrounding whitespace is forgiven; the value is not.
  assert.equal(tokens.verify("de", "Answer in German.", `  ${good} `), true);
});

test("tokens: passing the instruction text instead of the token fails", () => {
  // Observed in the wild: a model that had just read the instructions passed the
  // whole instruction text where the token belonged, because the read-result
  // block and the write parameter shared the name `spaceInstructions`. The
  // parameter is now `spaceInstructionsToken`; this pins the rejection.
  const tokens = makeInstructionsTokens("nonce-a");
  const instr = instructions();
  assert.equal(tokens.verify("de", instr.text, instr.text), false);
});

test("tokens: a token is scoped to one space", () => {
  const tokens = makeInstructionsTokens("nonce-a");
  const de = tokens.tokenFor("de", "Answer in German.");
  assert.equal(tokens.verify("cz", "Answer in German.", de), false);
});

test("tokens: editing the text invalidates outstanding tokens", () => {
  const tokens = makeInstructionsTokens("nonce-a");
  const before = tokens.tokenFor("de", "Answer in German.");
  // This is the freshness guarantee: a person saves a change in the browser and
  // the token the model is holding stops working, forcing a re-read.
  assert.equal(tokens.verify("de", "Answer in Czech.", before), false);
});

test("tokens: a token from another session does not carry over", () => {
  const first = makeInstructionsTokens();
  const second = makeInstructionsTokens();
  const fromFirst = first.tokenFor("de", "Answer in German.");
  assert.equal(second.verify("de", "Answer in German.", fromFirst), false);
});

// --- result payloads --------------------------------------------------------

test("payload: carries the text and a usable token", () => {
  const tokens = makeInstructionsTokens("nonce-a");
  const payload = instructionsPayload(instructions(), tokens);

  assert.equal(payload.space, "de");
  assert.equal(payload.text, "Write in plain English. No em-dashes.");
  assert.equal(payload.chars, payload.text.length);
  assert.equal(tokens.verify("de", payload.text, payload.token), true);
  assert.equal(payload.truncated, undefined);
  assert.equal(payload.note, undefined);
});

test("payload: truncation is stated, never silent", () => {
  const tokens = makeInstructionsTokens("nonce-a");
  const payload = instructionsPayload(
    instructions({ text: "y".repeat(CHAR_CAP), chars: CHAR_CAP, truncated: true }),
    tokens
  );
  assert.equal(payload.truncated, true);
  assert.match(payload.note ?? "", new RegExp(`first ${CHAR_CAP} characters`));
});

test("payload: the token in a payload verifies against the delivered text", () => {
  // The token must cover what was *delivered*, not what was authored, or a
  // truncated space could never produce a valid write.
  const tokens = makeInstructionsTokens("nonce-a");
  const delivered = "z".repeat(CHAR_CAP);
  const payload = instructionsPayload(
    instructions({ text: delivered, chars: CHAR_CAP, truncated: true }),
    tokens
  );
  assert.equal(tokens.verify("de", delivered, payload.token), true);
});

// --- the retry message ------------------------------------------------------

test("missing-token message hands back the text and a working token", () => {
  const tokens = makeInstructionsTokens("nonce-a");
  const instr = instructions();
  const message = missingTokenMessage(instr, tokens, false);

  assert.match(message, /has standing instructions/);
  assert.match(message, /Write in plain English/);
  const token = message.match(/spaceInstructionsToken: (\S+)/)?.[1];
  assert.equal(tokens.verify("de", instr.text, token), true);
});

test("missing-token message distinguishes stale from never-read", () => {
  const tokens = makeInstructionsTokens("nonce-a");
  const instr = instructions();

  assert.match(missingTokenMessage(instr, tokens, true), /out of date/);
  assert.doesNotMatch(missingTokenMessage(instr, tokens, true), /have not read them/);
  assert.match(missingTokenMessage(instr, tokens, false), /have not read them/);
});
