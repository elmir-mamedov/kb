import readline from "node:readline";
import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";
import type {
  NormalizedTurn,
  RawContentBlock,
  RawEvent,
  Session,
  ToolResult,
  ToolUse,
} from "./transcript-types.js";

/**
 * Parse a Claude Code session transcript into a normalized {@link Session}.
 *
 * Streams the input line by line (transcripts reach a few MB, so we never buffer
 * the whole file) and tolerates malformed lines: a line that is not valid JSON,
 * or not a usable event, increments `session.parseErrors` and is skipped rather
 * than throwing. Only `assistant` and `user` events become turns; every other
 * event type (`system`, `summary`, `ai-title`, `mode`, ...) is ignored.
 */
export async function parseTranscript(
  input: Readable,
  filePath = ""
): Promise<Session> {
  const turns: NormalizedTurn[] = [];
  const byUuid = new Map<string, NormalizedTurn>();
  const childrenOf = new Map<string, string[]>();
  const resultByToolUseId = new Map<string, ToolResult>();
  let parseErrors = 0;
  let lineCount = 0;
  let sessionId = "";

  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const rawLine of rl) {
    lineCount++;
    const line = rawLine.trim();
    if (!line) continue;

    let event: RawEvent;
    try {
      event = JSON.parse(line) as RawEvent;
    } catch {
      parseErrors++;
      continue;
    }
    if (!event || typeof event !== "object") {
      parseErrors++;
      continue;
    }

    if (!sessionId && typeof event.sessionId === "string") {
      sessionId = event.sessionId;
    }

    if (event.type !== "assistant" && event.type !== "user") continue;

    const turn = normalizeTurn(event);
    if (!turn) {
      parseErrors++;
      continue;
    }

    turns.push(turn);
    if (turn.uuid) byUuid.set(turn.uuid, turn);

    const parent = turn.parentUuid;
    if (parent) {
      const kids = childrenOf.get(parent);
      if (kids) kids.push(turn.uuid);
      else childrenOf.set(parent, [turn.uuid]);
    }

    for (const result of turn.toolResults) {
      if (result.toolUseId) resultByToolUseId.set(result.toolUseId, result);
    }
  }

  return {
    sessionId,
    filePath,
    turns,
    byUuid,
    childrenOf,
    resultByToolUseId,
    parseErrors,
    lineCount,
  };
}

/** Convenience wrapper: parse a file path. */
export async function parseTranscriptFile(filePath: string): Promise<Session> {
  return parseTranscript(createReadStream(filePath, "utf8"), filePath);
}

/** Normalize a raw `assistant`/`user` event. Returns null if it has no uuid. */
function normalizeTurn(event: RawEvent): NormalizedTurn | null {
  const uuid = typeof event.uuid === "string" ? event.uuid : "";
  if (!uuid) return null;

  const role = event.type === "assistant" ? "assistant" : "user";
  const thinking: string[] = [];
  const texts: string[] = [];
  const toolUses: ToolUse[] = [];
  const toolResults: ToolResult[] = [];

  const content = event.message?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      classifyBlock(block, thinking, texts, toolUses, toolResults);
    }
  }

  const turn: NormalizedTurn = {
    uuid,
    parentUuid: event.parentUuid ?? null,
    role,
    ts: typeof event.timestamp === "string" ? event.timestamp : "",
    isMeta: event.isMeta === true,
    isSidechain: event.isSidechain === true,
    cwd: event.cwd,
    gitBranch: event.gitBranch,
    version: event.version,
    entrypoint: typeof event.entrypoint === "string" ? event.entrypoint : undefined,
    model: event.message?.model,
    usage: event.message?.usage,
    thinking,
    texts,
    toolUses,
    toolResults,
  };

  if (role === "user") {
    turn.userKind = classifyUser(content, toolResults, texts);
    if (turn.userKind === "prompt") {
      turn.promptText =
        typeof content === "string" ? content : texts.join("\n\n");
    }
  }

  return turn;
}

/** Sort one content block into the appropriate accumulator. */
function classifyBlock(
  block: RawContentBlock,
  thinking: string[],
  texts: string[],
  toolUses: ToolUse[],
  toolResults: ToolResult[]
): void {
  switch (block.type) {
    case "thinking":
      if (typeof block.thinking === "string") thinking.push(block.thinking);
      break;
    case "text":
      if (typeof block.text === "string") texts.push(block.text);
      break;
    case "tool_use":
      if (typeof block.id === "string" && typeof block.name === "string") {
        toolUses.push({ id: block.id, name: block.name, input: block.input });
      }
      break;
    case "tool_result":
      if (typeof block.tool_use_id === "string") {
        toolResults.push({
          toolUseId: block.tool_use_id,
          text: flattenResultContent(block.content),
          isError: block.is_error === true,
        });
      }
      break;
  }
}

/** Determine how a user turn participates: a real prompt, a tool response, or empty. */
function classifyUser(
  content: string | RawContentBlock[] | undefined,
  toolResults: ToolResult[],
  texts: string[]
): "prompt" | "tool_result" | "empty" {
  if (typeof content === "string") {
    return content.trim() ? "prompt" : "empty";
  }
  if (toolResults.length > 0) return "tool_result";
  if (texts.some((t) => t.trim())) return "prompt";
  return "empty";
}

/**
 * A `tool_result.content` is usually an array of `{type:"text",text}` blocks but
 * can also be a plain string. Flatten either into a single string.
 */
function flattenResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block && typeof block === "object" && typeof (block as RawContentBlock).text === "string"
          ? (block as RawContentBlock).text
          : ""
      )
      .filter(Boolean)
      .join("\n");
  }
  return "";
}
