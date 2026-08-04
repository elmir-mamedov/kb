/**
 * Parse Git's `--word-diff=porcelain` output into structured lines for rendering.
 *
 * In porcelain word-diff, each run of text is on its own line prefixed with a
 * single marker: " " (unchanged), "+" (added), or "-" (removed); the rest of the
 * line is the run's literal text. A lone "~" represents a newline in the source,
 * so runs accumulate into a logical line that is emitted on each "~". Everything
 * before the first "@@" hunk header (the `diff`/`index`/`---`/`+++` preamble) is
 * ignored, as is a trailing "\ No newline at end of file" marker.
 *
 * This is a pure string→struct transform: HTML-escaping happens at render time.
 */

export type RunKind = "ctx" | "add" | "del";

export interface DiffRun {
  kind: RunKind;
  text: string;
}

export type DiffLine =
  | { type: "hunk"; header: string }
  | { type: "line"; runs: DiffRun[] };

const MARKER_KIND: Record<string, RunKind> = { " ": "ctx", "+": "add", "-": "del" };

export function parseWordDiff(porcelain: string): DiffLine[] {
  const out: DiffLine[] = [];
  let runs: DiffRun[] = [];
  let inHunk = false;

  const flush = () => {
    out.push({ type: "line", runs });
    runs = [];
  };

  for (const line of porcelain.split("\n")) {
    // Skip the diff preamble until the first hunk header.
    if (!inHunk) {
      if (line.startsWith("@@")) {
        inHunk = true;
        out.push({ type: "hunk", header: line });
      }
      continue;
    }

    if (line.startsWith("@@")) {
      if (runs.length) flush();
      out.push({ type: "hunk", header: line });
      continue;
    }
    // A lone "~" terminates the current logical line (blank lines flush []).
    if (line === "~") {
      flush();
      continue;
    }
    // "\ No newline at end of file" and the trailing split artifact carry no run.
    if (line.startsWith("\\") || line.length === 0) continue;

    const kind = MARKER_KIND[line[0]];
    if (!kind) continue; // defensive: unexpected line shape
    runs.push({ kind, text: line.slice(1) });
  }

  // A hunk with no trailing "~" (file lacked a final newline) leaves a dangling line.
  if (runs.length) flush();
  return out;
}
