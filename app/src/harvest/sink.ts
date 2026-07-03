import { promises as fs } from "node:fs";
import path from "node:path";
import type { HarvestEvent } from "./event-schema.js";

/** Per-session bookkeeping so re-runs don't re-emit events already written. */
export interface SessionWatermark {
  sessionId: string;
  filePath: string;
  fileSize: number;
  mtimeMs: number;
  lineCount: number;
  /** startUuids of tasks already emitted for this session. */
  emittedTaskUuids: string[];
}

export interface HarvestState {
  schemaVersion: 1;
  sessions: Record<string, SessionWatermark>;
  lastRunAt: string;
}

const STATE_SCHEMA_VERSION = 1 as const;

/** A fresh, empty state. */
export function emptyState(): HarvestState {
  return { schemaVersion: STATE_SCHEMA_VERSION, sessions: {}, lastRunAt: "" };
}

export interface Sink {
  eventsPath: string;
  statePath: string;
  /** Append events as JSONL (one per line). No-op on an empty array. */
  append(events: HarvestEvent[]): Promise<void>;
  loadState(): Promise<HarvestState>;
  saveState(state: HarvestState): Promise<void>;
}

/**
 * An append-only JSONL sink plus a JSON watermark store, both under `outDir`
 * (default `app/var/harvest/`, gitignored — raw events stay off the KB).
 */
export function makeSink(outDir: string): Sink {
  const eventsPath = path.join(outDir, "events.jsonl");
  const statePath = path.join(outDir, "state.json");

  async function ensureDir(): Promise<void> {
    await fs.mkdir(outDir, { recursive: true });
  }

  return {
    eventsPath,
    statePath,

    async append(events: HarvestEvent[]): Promise<void> {
      if (events.length === 0) return;
      await ensureDir();
      const lines = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
      await fs.appendFile(eventsPath, lines, "utf8");
    },

    async loadState(): Promise<HarvestState> {
      let raw: string;
      try {
        raw = await fs.readFile(statePath, "utf8");
      } catch {
        return emptyState();
      }
      try {
        const parsed = JSON.parse(raw) as Partial<HarvestState>;
        return {
          schemaVersion: STATE_SCHEMA_VERSION,
          sessions: parsed.sessions ?? {},
          lastRunAt: parsed.lastRunAt ?? "",
        };
      } catch {
        return emptyState();
      }
    },

    async saveState(state: HarvestState): Promise<void> {
      await ensureDir();
      await fs.writeFile(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");
    },
  };
}
