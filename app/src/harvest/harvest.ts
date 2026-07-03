#!/usr/bin/env node

import fs from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseTranscriptFile } from "./transcript-parser.js";
import { segment } from "./segmenter.js";
import { makeSink, type SessionWatermark } from "./sink.js";
import {
  encodeProjectDir,
  harvestSession,
  isFluxSession,
  type HarvestConfig,
  type NonFluxMode,
} from "./harvest-core.js";
import type { Session } from "./transcript-types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Same .env loading convention as server.ts / mcp.ts (project root, then app/).
loadEnvFile(path.join(__dirname, "..", "..", "..", ".env"));
loadEnvFile(path.join(__dirname, "..", "..", ".env"));

/** Absolute path to the Flux repo root (parent of `app/`). */
const FLUX_REPO_ROOT = path.resolve(
  process.env.FLUX_REPO_ROOT ?? path.join(__dirname, "..", "..", "..")
);
/** Where Claude Code stores session transcripts, one dir per project cwd. */
const CLAUDE_PROJECTS_DIR = path.resolve(
  process.env.CLAUDE_PROJECTS_DIR ?? path.join(os.homedir(), ".claude", "projects")
);
/** Append-only event log + watermark store (gitignored). */
const HARVEST_OUT_DIR = path.resolve(
  process.env.HARVEST_OUT_DIR ?? path.join(__dirname, "..", "..", "var", "harvest")
);

interface CliOptions {
  nonFluxMode: NonFluxMode;
  dryRun: boolean;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const projectDir = path.join(CLAUDE_PROJECTS_DIR, encodeProjectDir(FLUX_REPO_ROOT));

  if (!fs.existsSync(projectDir)) {
    console.error(`No transcripts found for ${FLUX_REPO_ROOT} (looked in ${projectDir}).`);
    return;
  }

  const cfg: HarvestConfig = { repoRoot: FLUX_REPO_ROOT, nonFluxMode: opts.nonFluxMode };
  const sink = makeSink(HARVEST_OUT_DIR);
  const state = await sink.loadState();
  const emittedAt = new Date().toISOString();

  const entries = await fsp.readdir(projectDir, { withFileTypes: true });
  const sessionFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
    .map((e) => path.join(projectDir, e.name));

  let sessionsProcessed = 0;
  let sessionsSkipped = 0;
  let eventsWritten = 0;

  for (const filePath of sessionFiles) {
    const stat = await fsp.stat(filePath);
    const prior = state.sessions[filePath];

    if (prior && prior.fileSize === stat.size && prior.mtimeMs === stat.mtimeMs) {
      sessionsSkipped++;
      continue;
    }

    const session = await parseTranscriptFile(filePath);
    if (!isFluxSession(FLUX_REPO_ROOT, session)) {
      sessionsSkipped++;
      continue;
    }

    // Truncation/rotation: earlier events are gone, so re-emit from scratch.
    const priorEmitted =
      prior && stat.size >= prior.fileSize ? prior.emittedTaskUuids : null;

    const { events, emittedTaskUuids } = harvestSession(
      session,
      segment(session),
      priorEmitted,
      cfg,
      emittedAt
    );

    if (!opts.dryRun) await sink.append(events);
    eventsWritten += events.length;
    sessionsProcessed++;
    state.sessions[filePath] = watermark(session, filePath, stat, emittedTaskUuids);
  }

  state.lastRunAt = emittedAt;
  if (!opts.dryRun) await sink.saveState(state);

  console.log(
    `Harvest ${opts.dryRun ? "(dry-run) " : ""}complete: ` +
      `${sessionsProcessed} session(s) processed, ${sessionsSkipped} skipped, ` +
      `${eventsWritten} event(s)${opts.dryRun ? " would be" : ""} written to ${sink.eventsPath}.`
  );
}

function watermark(
  session: Session,
  filePath: string,
  stat: fs.Stats,
  emittedTaskUuids: string[]
): SessionWatermark {
  return {
    sessionId: session.sessionId,
    filePath,
    fileSize: stat.size,
    mtimeMs: stat.mtimeMs,
    lineCount: session.lineCount,
    emittedTaskUuids,
  };
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { nonFluxMode: "off", dryRun: false };
  for (const arg of argv) {
    if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg.startsWith("--include-nonflux-context=")) {
      const value = arg.slice("--include-nonflux-context=".length);
      if (value === "off" || value === "redacted" || value === "full") {
        opts.nonFluxMode = value;
      } else {
        throw new Error(`Invalid --include-nonflux-context: ${value} (off|redacted|full)`);
      }
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

function loadEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;

  const source = fs.readFileSync(filePath, "utf8");
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;

    const value = rawValue.replace(/^(['"])(.*)\1$/, "$2");
    process.env[key] = value;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
