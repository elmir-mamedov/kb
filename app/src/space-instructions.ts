import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import matter from "gray-matter";
import { Content, newPageId } from "./content.js";
import { parsePage } from "./frontmatter.js";

/**
 * Per-space standing orders for an LLM working inside a space.
 *
 * A space's voice is stable and belongs with the space: one wants German,
 * another English; one a dry technical register, another narrative. Repeating
 * that in every session is the friction this removes. It deliberately does not
 * live in a global CLAUDE.md — the constraint only matters while an agent is
 * inside a KB25 space, and loading every space's rules into unrelated sessions
 * is the pollution to avoid.
 *
 * The text lives at `kb/<space>/_instructions.md`. The `_` prefix means
 * `Content.walk` skips it (the same rule that hides `_assets/`), so it never
 * appears in the sidebar, `kb_search`, the note sweep, or `resources/list`. But
 * `Content.resolve` does *not* apply that rule, so `<space>/_instructions`
 * resolves like any other slug — which is why the existing editor, diff viewer
 * and per-space auto-commit all work on it untouched.
 *
 * Both surfaces share this module: `mcp.ts` delivers the text to the model and
 * enforces the read-before-write token; `server.ts` scaffolds and edits it. It
 * is its own module rather than living in `mcp.ts` because `mcp.ts` builds an
 * `McpServer` at import time and so can never be imported by the web server.
 */

/** Filename stem, without the `.md`. Underscored so the tree walk skips it. */
export const INSTRUCTIONS_LEAF = "_instructions";

/**
 * Soft ceiling on one space's instructions, in characters.
 *
 * Not a client limit — tool results are uncapped. It is context economy: this
 * text rides along on every space-scoped tool result, so it must stay small
 * enough to be worth re-sending. A long glossary belongs on an ordinary KB page
 * that the instructions link to by `[[id:…]]`, which keeps it searchable too —
 * something this hidden file is not.
 */
export const CHAR_CAP = 2000;

/** Frontmatter title given to a scaffolded instructions file. */
const INSTRUCTIONS_TITLE = "Space instructions";

export interface SpaceInstructions {
  spaceKey: string;
  /** The instruction text — the file's Markdown body, trimmed. Never empty. */
  text: string;
  /** Length of `text` as delivered (already truncated when `truncated` is true). */
  chars: number;
  /** True when the authored text exceeded CHAR_CAP and was cut for delivery. */
  truncated: boolean;
}

/** The slug of a space's instructions file. */
export function instructionsSlug(spaceKey: string): string {
  return `${spaceKey}/${INSTRUCTIONS_LEAF}`;
}

/**
 * Whether a slug points at any space's instructions file.
 *
 * Used to keep the MCP write tools off it: these are the human's standing
 * orders, and a model quietly loosening its own constraints is the failure you
 * cannot diagnose by looking at the page it produced.
 */
export function isInstructionsSlug(slug: string): boolean {
  const leaf = slug.replace(/^\/+|\/+$/g, "").split("/").at(-1);
  return leaf === INSTRUCTIONS_LEAF;
}

/**
 * Read a space's instructions, or null when it has none.
 *
 * Goes through `Content.load`, so it shares the mtime-keyed parse cache: a
 * repeat read inside one process costs a single `fs.stat`. That is what makes a
 * browser edit visible to the MCP server on its very next tool call, with no
 * restart and no coordination between the two processes.
 *
 * A file that exists but has an empty body counts as *no* instructions — that is
 * exactly the state a freshly scaffolded file is in, and an empty rule set must
 * not start gating writes.
 */
export async function loadSpaceInstructions(
  content: Content,
  spaceKey: string
): Promise<SpaceInstructions | null> {
  if (!spaceKey) return null;

  let page: Awaited<ReturnType<Content["load"]>>;
  try {
    page = await content.load(instructionsSlug(spaceKey));
  } catch {
    // Invalid frontmatter must not take the whole space's tooling down with it.
    return null;
  }
  if (!page) return null;

  const authored = page.body.trim();
  if (!authored) return null;

  const truncated = authored.length > CHAR_CAP;
  const text = truncated ? authored.slice(0, CHAR_CAP) : authored;
  return { spaceKey, text, chars: text.length, truncated };
}

/** Whether a space has non-empty instructions, without carrying the text. */
export async function hasSpaceInstructions(
  content: Content,
  spaceKey: string
): Promise<boolean> {
  return (await loadSpaceInstructions(content, spaceKey)) !== null;
}

export interface EnsureInstructionsResult {
  slug: string;
  fsPath: string;
  /** True when this call created the file; false when it already existed. */
  created: boolean;
  /** Paths a caller should commit. Empty when nothing was written. */
  changedFsPaths: string[];
}

/**
 * Make sure a space's instructions file exists, creating an empty one if not.
 *
 * Scaffolded with valid frontmatter and a deliberately **empty body**: the file
 * has to exist for the editor to open it, but must not read as a rule set until
 * a person actually writes one. Guidance for the author belongs in the editor
 * UI, not in the file, so that the file is only ever instruction text.
 *
 * Mirrors `Content.createSpace`'s contract — returns the paths, and leaves
 * committing them to the caller.
 */
export async function ensureSpaceInstructions(
  content: Content,
  spaceKey: string
): Promise<EnsureInstructionsResult> {
  const slug = instructionsSlug(spaceKey);

  const existing = await content.resolve(slug);
  if (existing) {
    return { slug, fsPath: existing, created: false, changedFsPaths: [] };
  }

  // Locate the space through its own home page rather than by joining paths, so
  // an unknown or traversing key cannot resolve to somewhere outside the KB.
  const spaceIndex = await content.resolve(spaceKey);
  if (!spaceIndex) {
    throw new Error(`Unknown space: ${spaceKey}`);
  }

  const fsPath = path.join(path.dirname(spaceIndex), `${INSTRUCTIONS_LEAF}.md`);
  const raw = matter.stringify("", { title: INSTRUCTIONS_TITLE, id: newPageId() });
  parsePage(raw, fsPath);
  await fs.writeFile(fsPath, raw, { encoding: "utf8", flag: "wx" });

  return { slug, fsPath, created: true, changedFsPaths: [fsPath] };
}

export interface CapState {
  chars: number;
  cap: number;
  /** True once the text is over the cap and would be cut for delivery. */
  over: boolean;
  /** Characters past the cap; 0 when within it. */
  excess: number;
}

/** Character budget state, for the editor's counter and warning. */
export function capState(chars: number): CapState {
  return {
    chars,
    cap: CHAR_CAP,
    over: chars > CHAR_CAP,
    excess: Math.max(0, chars - CHAR_CAP),
  };
}

export interface InstructionsTokens {
  /** The token proving the holder received `text` for `spaceKey` this session. */
  tokenFor(spaceKey: string, text: string): string;
  /** Whether `provided` is the token this session would issue for that text. */
  verify(spaceKey: string, text: string, provided: string | undefined): boolean;
}

/**
 * Proof-of-read tokens: the mechanism that makes "the model saw this space's
 * instructions before it wrote" verifiable rather than hoped for.
 *
 * A token is a fingerprint of (this process's secret nonce, the space, the exact
 * instruction text). It is handed out with the instructions on every space-scoped
 * read, and the write tools check it. Three properties follow from the shape:
 *
 * - **Unforgeable.** The nonce never leaves the process, so a token cannot be
 *   guessed or derived from the text alone.
 * - **Not memorisable across sessions.** The nonce is new per process, so a token
 *   remembered from a previous session fails. The instructions must be in *this*
 *   session's context.
 * - **Freshness, for free.** The text is an input, so editing the file changes
 *   every valid token. An outstanding token stops verifying the moment a person
 *   saves a change, forcing a re-read. Injection alone cannot promise that.
 *
 * Verification is stateless — recompute and compare — so there is no issued-token
 * table to keep. Module-level session state is safe here: the MCP server is stdio
 * only, one process per client.
 */
export function makeInstructionsTokens(nonce = randomBytes(16).toString("hex")): InstructionsTokens {
  const tokenFor = (spaceKey: string, text: string): string =>
    BigInt(
      "0x" +
        createHash("sha256")
          .update(nonce)
          .update("\0")
          .update(spaceKey)
          .update("\0")
          .update(text)
          .digest("hex")
          .slice(0, 16)
    )
      .toString(36)
      .padStart(13, "0");

  return {
    tokenFor,
    verify(spaceKey, text, provided) {
      if (!provided) return false;
      const expected = tokenFor(spaceKey, text);
      // Same length every time, so a plain comparison leaks nothing useful; this
      // gates prose quality, not a secret.
      return provided.trim() === expected;
    },
  };
}

/** The `spaceInstructions` block attached to a space-scoped tool result. */
export interface InstructionsPayload {
  space: string;
  text: string;
  chars: number;
  token: string;
  truncated?: true;
  note?: string;
}

/**
 * Shape the block that rides along on a space-scoped tool result.
 *
 * The wording is load-bearing: it has to read as binding to a model that meets
 * it mid-transcript with no other context about what a "space instruction" is.
 */
export function instructionsPayload(
  instructions: SpaceInstructions,
  tokens: InstructionsTokens
): InstructionsPayload {
  const payload: InstructionsPayload = {
    space: instructions.spaceKey,
    text: instructions.text,
    chars: instructions.chars,
    token: tokens.tokenFor(instructions.spaceKey, instructions.text),
  };
  if (instructions.truncated) {
    payload.truncated = true;
    payload.note = `Truncated to the first ${CHAR_CAP} characters; the author should shorten it or move reference material onto a linked page.`;
  }
  return payload;
}

/**
 * The error returned when a write into an instructed space arrives without a
 * valid token. Carries the current text *and* a usable token, so exactly one
 * retry always succeeds.
 */
export function missingTokenMessage(
  instructions: SpaceInstructions,
  tokens: InstructionsTokens,
  stale: boolean
): string {
  const token = tokens.tokenFor(instructions.spaceKey, instructions.text);
  const lead = stale
    ? `The spaceInstructionsToken for "${instructions.spaceKey}" is out of date — these instructions changed since you read them.`
    : `Space "${instructions.spaceKey}" has standing instructions that govern what you write there, and you have not read them in this session.`;
  return [
    lead,
    "",
    "Follow them, then repeat this call with spaceInstructionsToken set to the value below.",
    "",
    `--- instructions for ${instructions.spaceKey} ---`,
    instructions.text,
    "--- end instructions ---",
    "",
    `spaceInstructionsToken: ${token}`,
  ].join("\n");
}
