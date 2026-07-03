import type { NormalizedTurn, Session } from "./transcript-types.js";

/**
 * A task: a contiguous run of turns opened by a real user prompt and running
 * until just before the next real prompt (or end of session). This is the unit
 * over which the signal extractors compute reasoning, clarifying questions, and
 * token rollups.
 */
export interface Task {
  sessionId: string;
  /** Stable, deterministic: `${sessionId}#${startUuid}`. */
  taskId: string;
  /** Ordinal within the session, starting at 0. */
  index: number;
  startUuid: string;
  promptText: string;
  startedAt: string;
  endedAt: string;
  /** Main-line turns (excludes subagent/sidechain turns). */
  turns: NormalizedTurn[];
  /** Turns produced inside spawned subagents, attached to the enclosing task. */
  sidechainTurns: NormalizedTurn[];
}

/**
 * A turn opens a new task iff it is a genuine user prompt: a user turn whose
 * content is a real message (not a tool response), and which is neither an
 * injected caveat/system-reminder (`isMeta`) nor part of a subagent conversation
 * (`isSidechain`).
 */
export function startsTask(turn: NormalizedTurn): boolean {
  return (
    turn.role === "user" &&
    turn.userKind === "prompt" &&
    !turn.isMeta &&
    !turn.isSidechain
  );
}

/** Split a parsed session into tasks. Turns before the first prompt are dropped. */
export function segment(session: Session): Task[] {
  const tasks: Task[] = [];
  let current: Task | null = null;

  for (const turn of session.turns) {
    if (startsTask(turn)) {
      current = {
        sessionId: session.sessionId,
        taskId: `${session.sessionId}#${turn.uuid}`,
        index: tasks.length,
        startUuid: turn.uuid,
        promptText: turn.promptText ?? "",
        startedAt: turn.ts,
        endedAt: turn.ts,
        turns: [turn],
        sidechainTurns: [],
      };
      tasks.push(current);
      continue;
    }

    // A turn that does not open a task belongs to the task in progress (if any).
    // Sidechain turns attach separately so analysis can include or exclude them.
    if (!current) continue;
    if (turn.isSidechain) {
      current.sidechainTurns.push(turn);
    } else {
      current.turns.push(turn);
    }
    if (turn.ts) current.endedAt = turn.ts;
  }

  return tasks;
}
