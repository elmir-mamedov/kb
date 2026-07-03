import type {
  HarvestEvent,
  ReasoningBlock,
  TaskUsage,
} from "./event-schema.js";
import { SCHEMA_VERSION } from "./event-schema.js";
import type { Task } from "./segmenter.js";
import type { NormalizedTurn, Session } from "./transcript-types.js";

const FLUX_TOOL_PREFIX = "mcp__flux-kb__";
const ASK_USER_TOOL = "AskUserQuestion";
const RESULT_SUMMARY_MAX = 240;

export interface SignalOptions {
  /** ISO timestamp stamped onto every emitted event by the caller (the CLI). */
  emittedAt: string;
}

/**
 * Extract the harvest events for a whole session's worth of tasks. Emits, per
 * task: one `task` rollup, one `reasoning` trace, zero+ `clarifying_question`s,
 * and zero+ `flux_tool_call`s (main-line and subagent turns alike).
 */
export function extractSignals(
  session: Session,
  tasks: Task[],
  opts: SignalOptions
): HarvestEvent[] {
  const events: HarvestEvent[] = [];
  for (const task of tasks) {
    events.push(taskEvent(session, task, opts));
    const reasoning = reasoningEvent(task, opts);
    if (reasoning) events.push(reasoning);
    events.push(...clarifyingEvents(task, opts));
    events.push(...fluxToolCallEvents(session, task, opts));
  }
  return events;
}

/** Correlation/provenance fields shared by events anchored to a specific turn. */
function turnBase(sessionId: string, taskId: string, turn: NormalizedTurn) {
  return {
    schemaVersion: SCHEMA_VERSION,
    source: "transcript" as const,
    sessionId,
    taskId,
    turnUuid: turn.uuid,
    parentUuid: turn.parentUuid,
    cwd: turn.cwd,
    gitBranch: turn.gitBranch,
    clientVersion: turn.version,
    model: turn.model,
    isSidechain: turn.isSidechain,
  };
}

function taskEvent(session: Session, task: Task, opts: SignalOptions): HarvestEvent {
  const usage = aggregateUsage(task);
  const start = task.turns[0];
  return {
    schemaVersion: SCHEMA_VERSION,
    emittedAt: opts.emittedAt,
    source: "transcript",
    sessionId: task.sessionId,
    taskId: task.taskId,
    turnUuid: task.startUuid,
    parentUuid: start?.parentUuid ?? null,
    cwd: start?.cwd,
    gitBranch: start?.gitBranch,
    clientVersion: usage.clientVersions[0],
    model: usage.models[0],
    kind: "task",
    promptText: task.promptText,
    usage,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    spaces: taskSpaces(session, task),
  };
}

/** Distinct KB spaces the task's `mcp__flux-kb__*` actions touched, first-seen order. */
function taskSpaces(session: Session, task: Task): string[] {
  const spaces: string[] = [];
  for (const turn of [...task.turns, ...task.sidechainTurns]) {
    if (turn.role !== "assistant") continue;
    for (const toolUse of turn.toolUses) {
      if (!toolUse.name.startsWith(FLUX_TOOL_PREFIX)) continue;
      const result = session.resultByToolUseId.get(toolUse.id);
      const space = deriveSpace(toolUse.input, result?.text);
      if (space && !spaces.includes(space)) spaces.push(space);
    }
  }
  return spaces;
}

/** Sum token usage and collect distinct models/versions over a task's assistant turns. */
function aggregateUsage(task: Task): TaskUsage {
  const usage: TaskUsage = {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    models: [],
    clientVersions: [],
  };
  for (const turn of task.turns) {
    if (turn.role !== "assistant") continue;
    usage.turns++;
    const u = turn.usage;
    if (u) {
      usage.inputTokens += u.input_tokens ?? 0;
      usage.outputTokens += u.output_tokens ?? 0;
      usage.cacheReadTokens += u.cache_read_input_tokens ?? 0;
      usage.cacheCreationTokens += u.cache_creation_input_tokens ?? 0;
    }
    if (turn.model && !usage.models.includes(turn.model)) usage.models.push(turn.model);
    if (turn.version && !usage.clientVersions.includes(turn.version)) {
      usage.clientVersions.push(turn.version);
    }
    if (!usage.entrypoint && turn.entrypoint) usage.entrypoint = turn.entrypoint;
  }
  return usage;
}

function reasoningEvent(task: Task, opts: SignalOptions): HarvestEvent | null {
  const blocks: ReasoningBlock[] = [];
  for (const turn of task.turns) {
    if (turn.role !== "assistant") continue;
    for (const thinking of turn.thinking) {
      if (thinking.trim()) blocks.push({ turnUuid: turn.uuid, kind: "thinking", text: thinking });
    }
    for (const text of turn.texts) {
      if (text.trim()) blocks.push({ turnUuid: turn.uuid, kind: "text", text });
    }
  }
  if (blocks.length === 0) return null;

  const start = task.turns[0];
  return {
    schemaVersion: SCHEMA_VERSION,
    emittedAt: opts.emittedAt,
    source: "transcript",
    sessionId: task.sessionId,
    taskId: task.taskId,
    turnUuid: task.startUuid,
    parentUuid: start?.parentUuid ?? null,
    cwd: start?.cwd,
    gitBranch: start?.gitBranch,
    kind: "reasoning",
    blocks,
  };
}

function clarifyingEvents(task: Task, opts: SignalOptions): HarvestEvent[] {
  const events: HarvestEvent[] = [];
  for (const turn of task.turns) {
    if (turn.role !== "assistant") continue;

    // Structured clarifying tool — highest confidence, may co-occur with acting.
    const ask = turn.toolUses.find((t) => t.name === ASK_USER_TOOL);
    if (ask) {
      events.push({
        ...turnBase(task.sessionId, task.taskId, turn),
        emittedAt: opts.emittedAt,
        kind: "clarifying_question",
        method: "ask_tool",
        questionText: extractAskQuestion(ask.input),
      });
      continue;
    }

    // Text heuristic — a turn that asked but did not act.
    if (turn.toolUses.length > 0) continue;
    const finalText = lastNonEmpty(turn.texts);
    if (finalText && endsWithQuestion(finalText)) {
      events.push({
        ...turnBase(task.sessionId, task.taskId, turn),
        emittedAt: opts.emittedAt,
        kind: "clarifying_question",
        method: "text_terminal_question",
        questionText: lastQuestionSentence(finalText),
      });
    }
  }
  return events;
}

function fluxToolCallEvents(
  session: Session,
  task: Task,
  opts: SignalOptions
): HarvestEvent[] {
  const events: HarvestEvent[] = [];
  const turns = [...task.turns, ...task.sidechainTurns];
  for (const turn of turns) {
    if (turn.role !== "assistant") continue;
    for (const toolUse of turn.toolUses) {
      if (!toolUse.name.startsWith(FLUX_TOOL_PREFIX)) continue;
      const result = session.resultByToolUseId.get(toolUse.id);
      events.push({
        ...turnBase(task.sessionId, task.taskId, turn),
        emittedAt: opts.emittedAt,
        toolUseId: toolUse.id,
        commit: result ? extractCommit(result.text) : undefined,
        kind: "flux_tool_call",
        name: toolUse.name,
        input: toolUse.input,
        ok: result ? !result.isError : false,
        resultSummary: result ? summarize(result.text) : "(no result captured)",
        space: deriveSpace(toolUse.input, result?.text),
      });
    }
  }
  return events;
}

// --- text helpers -----------------------------------------------------------

function lastNonEmpty(texts: string[]): string | null {
  for (let i = texts.length - 1; i >= 0; i--) {
    if (texts[i].trim()) return texts[i];
  }
  return null;
}

/**
 * True when the text's final meaningful character is `?`. Trailing whitespace and
 * closing markdown (code fences, emphasis, parens) are stripped first so a
 * question wrapped in formatting still counts.
 */
export function endsWithQuestion(text: string): boolean {
  const trimmed = text.replace(/[\s`*_)\]]+$/g, "");
  return trimmed.endsWith("?");
}

/** The last sentence ending in `?`, for a compact `questionText`. */
function lastQuestionSentence(text: string): string {
  const trimmed = text.replace(/[\s`*_)\]]+$/g, "");
  const match = trimmed.match(/[^.!?\n]*\?$/);
  return (match ? match[0] : trimmed).trim();
}

/** Pull the first question out of an `AskUserQuestion` tool input, best-effort. */
function extractAskQuestion(input: unknown): string {
  if (input && typeof input === "object") {
    const questions = (input as { questions?: unknown }).questions;
    if (Array.isArray(questions) && questions.length > 0) {
      const first = questions[0];
      if (first && typeof first === "object") {
        const q = (first as { question?: unknown }).question;
        if (typeof q === "string") return q;
      }
    }
  }
  return "";
}

/** Parse a KB write result and return its `commit` short SHA, if any. */
function extractCommit(resultText: string): string | undefined {
  try {
    const parsed = JSON.parse(resultText) as { commit?: unknown };
    if (typeof parsed.commit === "string" && parsed.commit) return parsed.commit;
  } catch {
    // Not JSON (e.g. an error string) — no commit to extract.
  }
  return undefined;
}

/**
 * Which KB space a `mcp__flux-kb__*` call operated on. Every page slug starts
 * with its space (`engineering/runbooks/deploy` → `engineering`), so we read the
 * space from whichever slug-bearing argument the tool used, falling back to the
 * `slug` in the tool's result (covers `kb_create_space`, whose input is a title).
 * Returns undefined for calls with no single space (e.g. `kb_list_spaces`, an
 * unscoped `kb_search`).
 */
export function deriveSpace(input: unknown, resultText?: string): string | undefined {
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    for (const key of ["slug", "sourceSlug", "parent", "space"]) {
      const value = obj[key];
      if (typeof value === "string") {
        const segment = firstSegment(value);
        if (segment) return segment;
      }
    }
  }
  if (resultText) {
    try {
      const parsed = JSON.parse(resultText) as { slug?: unknown };
      if (typeof parsed.slug === "string") return firstSegment(parsed.slug);
    } catch {
      // Result was not JSON — no slug to read.
    }
  }
  return undefined;
}

/** First path segment of a slug, ignoring leading/trailing slashes. */
function firstSegment(slug: string): string | undefined {
  return slug.replace(/^\/+/, "").split("/")[0]?.trim() || undefined;
}

function summarize(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > RESULT_SUMMARY_MAX
    ? `${collapsed.slice(0, RESULT_SUMMARY_MAX)}…`
    : collapsed;
}
