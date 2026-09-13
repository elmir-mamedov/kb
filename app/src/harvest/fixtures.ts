import { Readable } from "node:stream";

/**
 * Tiny builders for constructing transcript fixtures in tests, mirroring the
 * Claude Code JSONL shape. Not a test file itself; imported by `*.test.ts`.
 */

export const SESSION_ID = "sess-test";
export const REPO_ROOT = "/repo/kb25";

interface Common {
  uuid: string;
  parentUuid?: string | null;
  ts?: string;
  cwd?: string;
  isSidechain?: boolean;
}

interface AssistantSpec extends Common {
  model?: string;
  version?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  thinking?: string[];
  text?: string[];
  toolUses?: { id: string; name: string; input?: unknown }[];
}

interface UserSpec extends Common {
  isMeta?: boolean;
}

type Raw = Record<string, unknown>;

function base(spec: Common, type: string): Raw {
  return {
    type,
    uuid: spec.uuid,
    parentUuid: spec.parentUuid ?? null,
    sessionId: SESSION_ID,
    timestamp: spec.ts ?? "2026-01-01T00:00:00.000Z",
    cwd: spec.cwd ?? REPO_ROOT,
    isSidechain: spec.isSidechain ?? false,
  };
}

/** A real user prompt (string content). */
export function userPrompt(text: string, spec: UserSpec): Raw {
  return {
    ...base(spec, "user"),
    isMeta: spec.isMeta ?? false,
    message: { role: "user", content: text },
  };
}

/** A user prompt whose content is an array of text blocks (also a real prompt). */
export function userPromptBlocks(texts: string[], spec: UserSpec): Raw {
  return {
    ...base(spec, "user"),
    isMeta: spec.isMeta ?? false,
    message: { role: "user", content: texts.map((text) => ({ type: "text", text })) },
  };
}

/** A user turn carrying tool results (a tool response, not a prompt). */
export function userToolResult(
  results: { toolUseId: string; content: unknown; isError?: boolean }[],
  spec: UserSpec
): Raw {
  return {
    ...base(spec, "user"),
    isMeta: spec.isMeta ?? false,
    message: {
      role: "user",
      content: results.map((r) => ({
        type: "tool_result",
        tool_use_id: r.toolUseId,
        content: r.content,
        is_error: r.isError ?? false,
      })),
    },
  };
}

/** An assistant turn with any mix of thinking / text / tool_use blocks. */
export function assistant(spec: AssistantSpec): Raw {
  const content: Raw[] = [];
  for (const t of spec.thinking ?? []) content.push({ type: "thinking", thinking: t });
  for (const t of spec.text ?? []) content.push({ type: "text", text: t });
  for (const u of spec.toolUses ?? []) {
    content.push({ type: "tool_use", id: u.id, name: u.name, input: u.input ?? {} });
  }
  return {
    ...base(spec, "assistant"),
    version: spec.version ?? "2.1.0",
    entrypoint: "cli",
    message: {
      role: "assistant",
      model: spec.model ?? "claude-opus-4-8",
      usage: spec.usage,
      content,
    },
  };
}

/** Serialize raw events to a JSONL string. */
export function toJsonl(events: Raw[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

/** A Readable stream of the given raw events as JSONL. */
export function toStream(events: Raw[]): Readable {
  return Readable.from(toJsonl(events));
}
