/**
 * Types for reading Claude Code session transcripts (the INPUT side of the
 * harvester) and the normalized structures downstream stages consume.
 *
 * Claude Code stores one JSONL file per session at
 * `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`; each line is one
 * event. The raw shapes below are deliberately permissive (everything optional,
 * `unknown` payloads) because the transcript format is owned by another tool and
 * may carry fields we do not model. The parser normalizes the two event types we
 * care about — `assistant` and `user` — into {@link NormalizedTurn}.
 */

/** Token accounting attached to an assistant message. All fields optional. */
export interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/**
 * One content block inside a `message.content` array. The `type` discriminates:
 * `text`/`thinking` carry prose, `tool_use` is an assistant tool invocation, and
 * `tool_result` (found on user turns) is the response to a prior `tool_use`.
 */
export interface RawContentBlock {
  type: "text" | "thinking" | "tool_use" | "tool_result" | (string & {});
  // text
  text?: string;
  // thinking
  thinking?: string;
  // tool_use
  id?: string;
  name?: string;
  input?: unknown;
  // tool_result
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

export interface RawMessage {
  role?: string;
  model?: string;
  usage?: RawUsage;
  /** Either a plain string (user prompt) or an array of content blocks. */
  content?: string | RawContentBlock[];
}

/** One raw JSONL line. Only the fields the harvester reads are typed. */
export interface RawEvent {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  /** Claude Code client version, e.g. "2.1.197" (present on user/assistant turns). */
  version?: string;
  entrypoint?: string;
  requestId?: string;
  /** Injected caveats / system reminders set this; such user turns are not prompts. */
  isMeta?: boolean;
  /** Turns produced inside a spawned subagent conversation. */
  isSidechain?: boolean;
  userType?: string;
  promptId?: string;
  message?: RawMessage;
  [key: string]: unknown;
}

export type TurnRole = "user" | "assistant";

/** How a user turn relates to the conversation flow. */
export type UserKind = "prompt" | "tool_result" | "empty";

/** A tool invocation extracted from an assistant turn. */
export interface ToolUse {
  id: string;
  name: string;
  input: unknown;
}

/** A tool response extracted from a user turn. */
export interface ToolResult {
  toolUseId: string;
  /** Flattened text of the result (blocks concatenated, or a plain string). */
  text: string;
  isError: boolean;
}

/**
 * A single conversation turn, normalized from a raw `assistant` or `user` event.
 * Assistant-only fields (`model`, `usage`, `thinking`, `texts`, `toolUses`) are
 * empty/undefined on user turns and vice versa.
 */
export interface NormalizedTurn {
  uuid: string;
  parentUuid: string | null;
  role: TurnRole;
  /** ISO timestamp; empty string if the event omitted one. */
  ts: string;
  isMeta: boolean;
  isSidechain: boolean;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  /** Claude Code entrypoint (e.g. "cli"), when present. */
  entrypoint?: string;
  // assistant-only
  model?: string;
  usage?: RawUsage;
  thinking: string[];
  texts: string[];
  toolUses: ToolUse[];
  // user-only
  userKind?: UserKind;
  promptText?: string;
  toolResults: ToolResult[];
}

/** A parsed transcript: turns in chronological (file) order plus lookup indexes. */
export interface Session {
  sessionId: string;
  filePath: string;
  /** Turns in file order, which is chronological. */
  turns: NormalizedTurn[];
  /** uuid -> turn. */
  byUuid: Map<string, NormalizedTurn>;
  /** parentUuid -> child uuids, in file order. */
  childrenOf: Map<string, string[]>;
  /** tool_use id -> the tool_result that answered it (spans turns). */
  resultByToolUseId: Map<string, ToolResult>;
  /** Count of lines that failed to parse or were unusable; never throws. */
  parseErrors: number;
  /** Total non-empty lines seen. */
  lineCount: number;
}
