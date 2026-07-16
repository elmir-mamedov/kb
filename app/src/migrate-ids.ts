#!/usr/bin/env node

/**
 * One-time backfill: give every existing KB page a stable `id` in its
 * frontmatter, so `[[id:<id>]]` links keep resolving after the page is moved or
 * renamed. Pages created after this migration get an id on create; this stamps
 * everything that predates that.
 *
 * The migration only edits frontmatter — it never touches page bodies or the
 * links inside them (existing slug-based links are left exactly as-is). It is
 * idempotent: a page that already has an id is skipped, so it is safe to re-run.
 *
 * Usage (from app/):
 *   npm run migrate:ids            # stamp + commit per space
 *   npm run migrate:ids -- --dry-run   # report what would change, write nothing
 */

import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";
import { Content, newPageId, type PageNode } from "./content.js";
import { makeGit } from "./git.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Same .env loading convention as server.ts / mcp.ts (project root, then app/).
loadEnvFile(path.join(__dirname, "..", "..", ".env"));
loadEnvFile(path.join(__dirname, "..", ".env"));

const KB_DIR = path.resolve(process.env.KB_DIR ?? path.join(__dirname, "..", "..", "kb"));

interface CliOptions {
  dryRun: boolean;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const content = new Content(KB_DIR);
  const git = makeGit(KB_DIR);

  // Every markdown-backed page inside a space. A section directory without an
  // index.md has no frontmatter to stamp, and files at the KB root are not part
  // of any space repo, so both are excluded.
  const pages = flatten(await content.tree("all")).filter(
    (n) => n.fsPath.endsWith(".md") && insideSpace(n.fsPath)
  );

  // Seed the uniqueness set with ids already present so a re-run (or a partly
  // migrated KB) never mints a duplicate.
  const seenIds = new Set<string>();
  for (const n of pages) if (n.id) seenIds.add(n.id);

  const changedBySpace = new Map<string, string[]>();
  let stamped = 0;
  let skipped = 0;

  for (const page of pages) {
    const raw = await fsp.readFile(page.fsPath, "utf8");
    const parsed = matter(raw);
    if (parsed.data.id) {
      seenIds.add(String(parsed.data.id));
      skipped += 1;
      continue;
    }

    const id = uniqueId(seenIds);
    seenIds.add(id);
    const nextRaw = matter.stringify(parsed.content, { ...parsed.data, id });
    if (!opts.dryRun) {
      await fsp.writeFile(page.fsPath, nextRaw, "utf8");
    }

    const space = page.slug.split("/")[0];
    const list = changedBySpace.get(space) ?? [];
    list.push(page.fsPath);
    changedBySpace.set(space, list);
    stamped += 1;
    console.log(`${opts.dryRun ? "[dry-run] would stamp" : "stamped"} ${page.slug} -> id ${id}`);
  }

  if (!opts.dryRun) {
    for (const [space, fsPaths] of changedBySpace) {
      const commit = await git.commitFiles(fsPaths, "Backfill page ids via migration");
      console.log(
        `committed ${fsPaths.length} page(s) in space "${space}"${commit ? ` (${commit})` : ""}`
      );
    }
  }

  console.log(
    `\nDone. ${stamped} page(s) ${opts.dryRun ? "would be" : "were"} stamped; ${skipped} already had an id.`
  );
}

/** True when fsPath lives inside a space (kb/<space>/…), not at the KB root. */
function insideSpace(fsPath: string): boolean {
  const rel = path.relative(KB_DIR, fsPath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  return rel.split(path.sep).length >= 2;
}

function uniqueId(existing: Set<string>): string {
  let id = newPageId();
  while (existing.has(id)) id = newPageId();
  return id;
}

function flatten(nodes: PageNode[]): PageNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

function parseArgs(argv: string[]): CliOptions {
  return { dryRun: argv.includes("--dry-run") };
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
    process.env[key] = rawValue.replace(/^(['"])(.*)\1$/, "$2");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
