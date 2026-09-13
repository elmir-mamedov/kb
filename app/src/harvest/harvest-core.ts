import { createHash } from "node:crypto";
import path from "node:path";
import { extractSignals } from "./signals.js";
import type { Task } from "./segmenter.js";
import type { HarvestEvent } from "./event-schema.js";
import type { NormalizedTurn, Session } from "./transcript-types.js";

/** How to treat tasks whose working directory is outside the KB25 repo. */
export type NonKb25Mode = "off" | "redacted" | "full";

export interface HarvestConfig {
  /** Absolute path to the KB25 repo root. */
  repoRoot: string;
  nonKb25Mode: NonKb25Mode;
}

/** Encode an absolute path the way Claude Code names its per-project dir. */
export function encodeProjectDir(absPath: string): string {
  return absPath.replace(/[^a-zA-Z0-9]/g, "-");
}

/** A path is inside the repo if it is the root or a descendant of it. */
export function underRepo(repoRoot: string, p: string | undefined): boolean {
  if (!p) return false;
  return p === repoRoot || p.startsWith(repoRoot + path.sep);
}

/** Guard against a resumed session that `cd`'d away: most turns must be in the repo. */
export function isKb25Session(repoRoot: string, session: Session): boolean {
  const withCwd = session.turns.filter((t) => t.cwd);
  if (withCwd.length === 0) return true;
  const inRepo = withCwd.filter((t) => underRepo(repoRoot, t.cwd)).length;
  return inRepo / withCwd.length >= 0.5;
}

/** A task is kb25-scoped when its opening prompt was issued inside the repo. */
export function isKb25Task(repoRoot: string, task: Task): boolean {
  const start: NormalizedTurn | undefined = task.turns[0];
  return start?.cwd ? underRepo(repoRoot, start.cwd) : true;
}

export interface HarvestSessionResult {
  events: HarvestEvent[];
  /** startUuids of every task now considered emitted for this session. */
  emittedTaskUuids: string[];
}

/**
 * Build the events for the tasks of one parsed session that have not been
 * emitted before, applying the non-kb25 policy and redaction. `priorEmitted`
 * is the set of task startUuids already emitted (pass `null` to re-emit all,
 * e.g. after a truncation/rotation reset).
 */
export function harvestSession(
  session: Session,
  tasks: Task[],
  priorEmitted: string[] | null,
  cfg: HarvestConfig,
  emittedAt: string
): HarvestSessionResult {
  const emitted = new Set(priorEmitted ?? []);
  const fresh = tasks.filter((t) => !emitted.has(t.startUuid));

  const redactedTaskIds = new Set<string>();
  const kept: Task[] = [];
  for (const task of fresh) {
    if (isKb25Task(cfg.repoRoot, task)) {
      kept.push(task);
    } else if (cfg.nonKb25Mode === "full") {
      kept.push(task);
    } else if (cfg.nonKb25Mode === "redacted") {
      kept.push(task);
      redactedTaskIds.add(task.taskId);
    }
    // "off" (default): drop non-kb25 tasks entirely.
  }

  let events = extractSignals(session, kept, { emittedAt });
  if (redactedTaskIds.size > 0) {
    events = events.map((e) => (redactedTaskIds.has(e.taskId ?? "") ? redactEvent(e) : e));
  }

  for (const task of tasks) emitted.add(task.startUuid);
  return { events, emittedTaskUuids: [...emitted] };
}

/** Replace free text with a length + hash placeholder, keeping structure/tokens. */
export function redactEvent(event: HarvestEvent): HarvestEvent {
  switch (event.kind) {
    case "task":
      return { ...event, promptText: redact(event.promptText) };
    case "reasoning":
      return { ...event, blocks: event.blocks.map((b) => ({ ...b, text: redact(b.text) })) };
    case "clarifying_question":
      return { ...event, questionText: redact(event.questionText) };
    case "kb25_tool_call":
      return { ...event, input: "[redacted]", resultSummary: redact(event.resultSummary) };
  }
}

function redact(text: string): string {
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 8);
  return `[redacted ${text.length} chars sha256:${hash}]`;
}
