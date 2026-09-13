/**
 * The OUTPUT schema for harvested events: a single append-only JSONL stream of
 * {@link HarvestEvent} records, one per line.
 *
 * The envelope is a discriminated union keyed by `kind`, designed as a
 * **superset** so a future server-side tap on the MCP handlers ("point A") can
 * emit the same shape with `source: "mcp"` and join on the shared correlation
 * keys (`sessionId`, `taskId`, `turnUuid`, `toolUseId`, `commit`). Raw events
 * stay off the knowledge base; only distilled analysis is written back later.
 */

export const SCHEMA_VERSION = 1 as const;

/** Where an event was harvested from. Only "transcript" is emitted today. */
export type EventSource = "transcript" | "mcp";

/** Per-task token / model / client rollup, summed over the task's assistant turns. */
export interface TaskUsage {
  /** Number of assistant turns in the task. */
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Distinct models seen, in first-seen order (captures mid-task switches). */
  models: string[];
  /** Distinct client versions seen, in first-seen order. */
  clientVersions: string[];
  entrypoint?: string;
}

/** One block of a reasoning trace, tagged by whether it was thinking or output text. */
export interface ReasoningBlock {
  turnUuid: string;
  kind: "thinking" | "text";
  text: string;
}

/** How a clarifying question was detected. */
export type ClarifyingMethod = "text_terminal_question" | "ask_tool";

/** Fields shared by every harvested event; the correlation spine lives here. */
export interface HarvestEventBase {
  schemaVersion: typeof SCHEMA_VERSION;
  /** When this harvest run emitted the event (ISO). Stamped by the CLI. */
  emittedAt: string;
  source: EventSource;
  // correlation keys
  sessionId: string;
  taskId?: string;
  turnUuid?: string;
  parentUuid?: string | null;
  toolUseId?: string;
  /** Bridges to a future MCP-side request id. */
  requestId?: string;
  /** Git short SHA — the key that links transcript <-> git <-> future MCP log. */
  commit?: string;
  // provenance / filtering
  cwd?: string;
  gitBranch?: string;
  clientVersion?: string;
  model?: string;
  isSidechain?: boolean;
}

/** A whole task: its opening prompt, span, and token/model rollup. */
export interface TaskEvent extends HarvestEventBase {
  kind: "task";
  promptText: string;
  usage: TaskUsage;
  startedAt: string;
  endedAt: string;
  /** Distinct KB spaces this task's actions touched, in first-seen order (may be empty). */
  spaces: string[];
}

/** The ordered reasoning (thinking + output text) of a task. */
export interface ReasoningEvent extends HarvestEventBase {
  kind: "reasoning";
  blocks: ReasoningBlock[];
}

/** An assistant turn that asked the user something instead of (only) acting. */
export interface ClarifyingQuestionEvent extends HarvestEventBase {
  kind: "clarifying_question";
  method: ClarifyingMethod;
  questionText: string;
}

/** A single `mcp__kb25__*` tool call and (a summary of) its result. */
export interface Kb25ToolCallEvent extends HarvestEventBase {
  kind: "kb25_tool_call";
  name: string;
  input: unknown;
  ok: boolean;
  resultSummary: string;
  /** The KB space the action targeted (first path segment); absent when not space-specific. */
  space?: string;
}

export type HarvestEvent =
  | TaskEvent
  | ReasoningEvent
  | ClarifyingQuestionEvent
  | Kb25ToolCallEvent;

/** Discriminants reserved for later phases: "correction_pair", task.outcome, etc. */
export type HarvestEventKind = HarvestEvent["kind"];
