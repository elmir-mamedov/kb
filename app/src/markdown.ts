import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";
import type StateBlock from "markdown-it/lib/rules_block/state_block.mjs";
import type StateCore from "markdown-it/lib/rules_core/state_core.mjs";
import hljs from "highlight.js";
import { createHash } from "node:crypto";
import { normalizeQuote, parseNotes } from "./notes.js";

/**
 * Resolve a [[wiki-link]] target against the page it appears on.
 *
 * A bare target like `crif-credit-report` written on
 * `pdf-extraction/crif-credit-report/backlog` should land on the page of that
 * name within the same space, not at the repo root (`/crif-credit-report`). We
 * try candidates from most specific (a child of the current page) up through
 * each ancestor to the space root, then the bare target, and return the first
 * that names a real page. A leading slash forces an absolute, repo-root target.
 */
export function resolveWikiTarget(
  rawTarget: string,
  currentSlug: string,
  isPage: (slug: string) => boolean
): string {
  const target = rawTarget.trim().replace(/^\/+/, "");
  if (!target) return target;
  // Explicit absolute target ("/foo/bar") is used verbatim.
  if (rawTarget.trim().startsWith("/")) return target;

  const segments = currentSlug ? currentSlug.split("/") : [];
  const candidates: string[] = [];
  if (currentSlug) candidates.push(`${currentSlug}/${target}`); // a child page
  for (let i = segments.length - 1; i >= 1; i -= 1) {
    candidates.push(`${segments.slice(0, i).join("/")}/${target}`); // ancestors
  }
  candidates.push(target); // bare, repo-root

  for (const candidate of candidates) {
    if (isPage(candidate)) return candidate;
  }

  // No match: keep a broken link inside the current space rather than sending
  // it to the repo root.
  const spaceKey = segments[0];
  return spaceKey ? `${spaceKey}/${target}` : target;
}

/**
 * A heading's URL fragment, so a reader or an agent can link to one section of a
 * page rather than to the whole thing.
 *
 * Decomposing and dropping combining marks folds `Kosťukovič` to `kostukovic`,
 * which is what keeps a Czech heading's anchor short and typable once a browser
 * percent-encodes it. What does not decompose is kept rather than deleted: this
 * KB has Chinese headings (`一句话`), and the ASCII-only rule `content.ts` uses
 * for filenames would leave those with no anchor at all.
 *
 * A literal hyphen is a separator like any other character, not something to
 * preserve: keeping it would turn `P1 - Multi` into `p1---multi`, because the
 * spaces on either side each match on their own. Underscores do survive, so
 * `claude_code_launcher` stays one readable identifier.
 *
 * Quotes are deleted rather than separated so `isn't` reads `isnt`, and both the
 * straight and curly shapes are listed because a heading is slugged from its raw
 * source, where `typographer` has not curled them yet, while a `{#pin}` is
 * stripped from the rendered text, where it has.
 */
export function headingSlug(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/['‘’"“”]/g, "")
    .replace(/[^\p{L}\p{N}_]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * An explicit anchor pinned to the end of a heading: `## Rate limits {#limits}`.
 * A slug derived from the text silently breaks every inbound link when the
 * heading is reworded; a pin is how a link worth keeping is protected.
 */
const SECTION_PIN = /\s*\{#([\p{L}\p{N}_-]+)\}\s*$/u;

/**
 * The same shape, but incurious about what sits between the braces. Used only to
 * strip a pin the strict pattern has already recognised in the raw source: by
 * the time the rendered text is reached, `typographer` has turned a pin's `--`
 * into an en-dash, which the strict pattern no longer matches — and the pin
 * would be left showing in the heading.
 */
const SECTION_PIN_RENDERED = /\s*\{#[^}\n]*\}\s*$/;

/** What a heading with no sluggable characters at all falls back to. */
const SECTION_FALLBACK = "section";

/**
 * Ids a heading must not take, because the page already uses them for something
 * else. `getElementById` returns the first match in document order, and every
 * heading precedes `layout()`'s own `<div id="flux-notes">` — so a heading
 * titled "Flux notes" would answer to that lookup and the notes feature would go
 * dark with nothing logged anywhere.
 */
const RESERVED_SECTION_IDS = ["flux-notes"];

/**
 * Claim `base` for this page, suffixing `-2`, `-3`, … until it is free.
 *
 * `taken` holds ids that were actually emitted, not the base names they came
 * from: a page with three `## Problem` headings *and* a literal `## problem-2`
 * heading hands out `problem-2` twice if you only count bases.
 *
 * `avoid` additionally holds every id pinned anywhere on the page, so a derived
 * slug steps over a name some later heading has reserved for itself.
 */
function reserveSectionId(taken: Set<string>, base: string, avoid?: Set<string>): string {
  let id = base;
  for (let n = 2; taken.has(id) || avoid?.has(id); n += 1) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

/**
 * Split a `#section` suffix off a link target.
 *
 * Exported because the move/rename rewriter in `content.ts` has to make the same
 * cut: it remaps the page part of a wiki-link and must put the fragment back
 * untouched, or a link to a section stops being rewritten when the page moves.
 */
export function splitFragment(raw: string): { target: string; fragment: string } {
  const hash = raw.indexOf("#");
  if (hash === -1) return { target: raw, fragment: "" };
  return { target: raw.slice(0, hash), fragment: raw.slice(hash + 1).trim() };
}

/** A fragment as an href suffix, encoded so a non-ASCII anchor resolves. */
function fragmentHref(fragment: string): string {
  return fragment ? "#" + encodeURIComponent(fragment) : "";
}

/** A page slug as a root-relative href, each segment encoded, plus a fragment. */
function pageHref(slug: string, fragment = ""): string {
  const path = slug.split("/").map(encodeURIComponent).join("/");
  return "/" + path + fragmentHref(fragment);
}

/** A trailing `=WxH` size spec inside an image's parens: `=600x`, `=600x400`, `=x400`. */
const IMAGE_SIZE_RE = /^=(\d*)x(\d*)/;

/** An opening or closing code fence: three or more backticks or tildes. */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** A GFM table's delimiter row — the `| --- | :--: |` line under its header. */
const TABLE_DELIMITER_RE = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

/** One whole `[[…]]` wiki-link, the same span the inline rule below claims. */
const WIKILINK_RE = /\[\[[^\]\n]*\]\]/g;

/** The delimiter row under a table header. A `|`-less `---` is a setext rule. */
function isTableDelimiter(line: string): boolean {
  return line.includes("|") && TABLE_DELIMITER_RE.test(line);
}

/** Escape every not-already-escaped `|` inside the wiki-links on one line. */
function escapeWikiPipes(line: string): string {
  if (!line.includes("[[")) return line;
  return line.replace(WIKILINK_RE, (span) => span.replace(/(?<!\\)\|/g, "\\|"));
}

/**
 * Escape the `|` in `[[target|Label]]` wiki-links that sit inside a table row.
 *
 * A table row is split into cells before any inline rule runs, so a wiki-link's
 * alias pipe reads as a cell boundary: `[[id:abc|ledger]]` ends the cell after
 * `[[id:abc`, and the rest spills into a column the header does not have, where
 * it is dropped. Escaping is the GFM-sanctioned fix, and the cell splitter takes
 * the backslash back off again — so the inline rule still sees the plain
 * `[[id:abc|ledger]]` it expects, and only the two characters between the source
 * and the cell change. Doing it here rather than asking every author (and every
 * LLM writing a page) to remember `\|` keeps one wiki-link syntax across a page.
 *
 * Rows are found by the shape markdown-it itself looks for — a line containing
 * `|` followed by a `| --- |` delimiter row, running to the next blank line —
 * with fenced code skipped. The scan deliberately errs towards marking too much:
 * markdown-it ends a table at several kinds of line this does not model, and an
 * escape that lands outside a real table costs nothing, because the inline rule
 * unescapes `\|` before splitting target from label. It errs the other way for a
 * table nested inside a blockquote or a list item, which it does not recognise
 * at all; the pipe still has to be written `\|` by hand there.
 */
function escapeTableWikiPipes(src: string): string {
  if (!src.includes("[[")) return src;

  const lines = src.split("\n");
  let fence = "";
  let inTable = false;
  let changed = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // Fence tracking mirrors `scanNotes`: a table cannot open inside a fence,
    // and a `[[a|b]]` written in a code sample is text, not a link.
    const rail = FENCE_RE.exec(line);
    if (fence) {
      if (rail && rail[1][0] === fence[0] && rail[1].length >= fence.length && !rail[2].trim()) {
        fence = "";
      }
      continue;
    }
    if (rail && !(rail[1][0] === "`" && rail[2].includes("`"))) {
      fence = rail[1];
      inTable = false;
      continue;
    }

    if (inTable) {
      if (!line.trim()) {
        inTable = false;
        continue;
      }
    } else if (line.includes("|") && line.trim() && isTableDelimiter(lines[i + 1] ?? "")) {
      inTable = true; // this is the header; the delimiter row follows
    } else {
      continue;
    }

    const escaped = escapeWikiPipes(line);
    if (escaped !== line) {
      lines[i] = escaped;
      changed = true;
    }
  }

  return changed ? lines.join("\n") : src;
}

/** markdown-it's own whitespace test, inlined to avoid a deep internal import. */
function isSpaceCode(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d;
}

/**
 * markdown-it's `image` inline rule, extended to accept an optional `=WxH`
 * size spec before the closing paren:
 *
 *     ![alt](_assets/diagram.png =600x)      → width 600, height unset
 *     ![alt](_assets/diagram.png =600x400)   → both set
 *     ![alt](_assets/diagram.png "Title" =600x)
 *
 * The size must be separated from the destination by whitespace, otherwise
 * markdown-it reads it as part of the URL. Tokens are ordinary `image` tokens,
 * so the `_assets` src rewrite and the default renderer still apply unchanged.
 */
function imageWithSize(state: StateInline, silent: boolean): boolean {
  let code: number;
  let label: string | undefined;
  let pos: number;
  let res: { ok: boolean; pos: number; str: string };
  let title: string;
  let start: number;
  let href = "";
  let width = "";
  let height = "";
  const oldPos = state.pos;
  const max = state.posMax;

  if (state.src.charCodeAt(state.pos) !== 0x21 /* ! */) return false;
  if (state.src.charCodeAt(state.pos + 1) !== 0x5b /* [ */) return false;

  const labelStart = state.pos + 2;
  const labelEnd = state.md.helpers.parseLinkLabel(state, state.pos + 1, false);
  if (labelEnd < 0) return false; // no closing ']', not an image

  pos = labelEnd + 1;
  if (pos < max && state.src.charCodeAt(pos) === 0x28 /* ( */) {
    // Inline form: ![alt](  <href>  "title"  =WxH  )
    pos++;
    for (; pos < max; pos++) {
      if (!isSpaceCode(state.src.charCodeAt(pos))) break;
    }
    if (pos >= max) return false;

    start = pos;
    res = state.md.helpers.parseLinkDestination(state.src, pos, state.posMax);
    if (res.ok) {
      href = state.md.normalizeLink(res.str);
      if (state.md.validateLink(href)) pos = res.pos;
      else href = "";
    }

    start = pos;
    for (; pos < max; pos++) {
      if (!isSpaceCode(state.src.charCodeAt(pos))) break;
    }

    res = state.md.helpers.parseLinkTitle(state.src, pos, state.posMax);
    if (pos < max && start !== pos && res.ok) {
      title = res.str;
      pos = res.pos;
      for (; pos < max; pos++) {
        if (!isSpaceCode(state.src.charCodeAt(pos))) break;
      }
    } else {
      title = "";
    }

    // The one addition to markdown-it's rule: an optional `=WxH` spec. A spec
    // with neither dimension (`=x`) is not treated as a size, so the closing
    // paren check below rejects the image rather than emitting empty attrs.
    const sizeMatch = IMAGE_SIZE_RE.exec(state.src.slice(pos, state.posMax));
    if (sizeMatch && (sizeMatch[1] || sizeMatch[2])) {
      width = sizeMatch[1];
      height = sizeMatch[2];
      pos += sizeMatch[0].length;
      for (; pos < max; pos++) {
        if (!isSpaceCode(state.src.charCodeAt(pos))) break;
      }
    }

    if (pos >= max || state.src.charCodeAt(pos) !== 0x29 /* ) */) {
      state.pos = oldPos;
      return false;
    }
    pos++;
  } else {
    // Reference form: ![alt][ref] — unchanged from markdown-it, no size spec.
    if (typeof state.env.references === "undefined") return false;

    if (pos < max && state.src.charCodeAt(pos) === 0x5b /* [ */) {
      start = pos + 1;
      pos = state.md.helpers.parseLinkLabel(state, pos);
      if (pos >= 0) label = state.src.slice(start, pos++);
      else pos = labelEnd + 1;
    } else {
      pos = labelEnd + 1;
    }

    if (!label) label = state.src.slice(labelStart, labelEnd);

    const ref = state.env.references[label.toUpperCase().replace(/\s+/g, " ")];
    if (!ref) {
      state.pos = oldPos;
      return false;
    }
    href = ref.href;
    title = ref.title;
  }

  if (!silent) {
    const content = state.src.slice(labelStart, labelEnd);
    const tokens: Token[] = [];
    state.md.inline.parse(content, state.md, state.env, tokens);

    const token = state.push("image", "img", 0);
    const attrs: [string, string][] = [
      ["src", href],
      ["alt", ""],
    ];
    token.attrs = attrs;
    token.children = tokens;
    token.content = content;

    if (title) attrs.push(["title", title]);
    if (width) attrs.push(["width", width]);
    if (height) attrs.push(["height", height]);
  }

  state.pos = pos;
  state.posMax = max;
  return true;
}

/**
 * Rewrite a portable `_assets/…` reference to the current page's space-scoped
 * asset URL (`/<spaceKey>/_assets/…`). Absolute/external/anchor URLs and any
 * target not beginning with `_assets/` are returned unchanged.
 */
function rewriteAssetUrl(url: string, spaceKey: string): string {
  if (!spaceKey || !url.startsWith("_assets/")) return url;
  return `/${spaceKey}/${url}`;
}

/**
 * Wrap a markdown-it render rule so a named attribute (`src`/`href`) is passed
 * through {@link rewriteAssetUrl} before the default renderer runs. Preserves
 * any previously installed rule and falls back to `renderToken`.
 */
function rewriteAttr(md: MarkdownIt, rule: string, attr: string, spaceKey: string): void {
  if (!spaceKey) return;
  const rules = md.renderer.rules;
  const previous = rules[rule];
  rules[rule] = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const index = token.attrIndex(attr);
    if (index >= 0 && token.attrs) {
      token.attrs[index][1] = rewriteAssetUrl(token.attrs[index][1], spaceKey);
    }
    return previous
      ? previous(tokens, idx, options, env, self)
      : self.renderToken(tokens, idx, options);
  };
}

/** Opening marker of a note comment, at the start of its own line. */
const NOTE_OPEN_RE = /^<!--[ \t]*flux:note\b/;

/** A line's content with the block indent and any blockquote markers stripped. */
function blockLine(state: StateBlock, line: number): string {
  return state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
}

/**
 * `<!-- flux:note … -->` comments, the on-disk form of an inline note.
 *
 * With `html: false` markdown-it's own `html_block` rule bails out, so without
 * this the comment would render as visible escaped text — and worse, its
 * `> quoted selection` line would start a blockquote that swallows the rest of
 * the note. This claims the whole comment and renders nothing in its place.
 * Every other HTML comment still renders escaped, so this is a carve-out for
 * our own syntax rather than a relaxation of `html: false`.
 *
 * Registered first in the block chain rather than merely before `paragraph`:
 * `lheading` inspects the following line for a setext underline before it
 * consults any terminator rule, so a note whose text contains a `---` line
 * would otherwise be parsed as an `<h2>`. `table` looks ahead similarly.
 *
 * An unterminated comment is left alone deliberately. Consuming to EOF (what
 * `html_block` does) would blank the rest of the page and strip every anchor
 * below it with nothing on screen to explain why; falling through to
 * `paragraph` shows the broken marker as text, which is loud and local.
 */
function fluxNote(
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean
): boolean {
  if (state.sCount[startLine] - state.blkIndent >= 4) return false; // indented code

  const first = blockLine(state, startLine);
  if (first.charCodeAt(0) !== 0x3c /* < */) return false;
  if (!NOTE_OPEN_RE.test(first)) return false;

  let lastLine = -1;
  if (first.includes("-->")) {
    lastLine = startLine;
  } else {
    for (let line = startLine + 1; line < endLine; line += 1) {
      if (blockLine(state, line).trim() === "-->") {
        lastLine = line;
        break;
      }
    }
  }
  // Checked before the `silent` return so both modes agree on what is a note;
  // otherwise a malformed one could terminate a paragraph the non-silent pass
  // then declines to consume.
  if (lastLine < 0) return false;
  if (silent) return true;

  const token = state.push("flux_note", "", 0);
  token.map = [startLine, lastLine + 1];
  state.line = lastLine + 1;
  return true;
}

/**
 * Where `flux_table_pipes` parks the untouched source for `flux_anchor`. On
 * `state.env` rather than a closure variable so nested or repeated renders on
 * one renderer can't read each other's source.
 */
const RAW_SRC = "fluxRawSrc";

/** The source as `md.render` received it, before `flux_table_pipes` ran. */
function rawSource(state: StateCore): string {
  const raw = (state.env as Record<string, unknown> | undefined)?.[RAW_SRC];
  return typeof raw === "string" ? raw : state.src;
}

/** Source position of a rendered block, so the write path can find it again. */
export interface SourceBlock {
  /** 0-based start line within the body. */
  line: number;
  /** Fingerprint of the block's source, matching its `data-src-hash`. */
  hash: string;
}

/**
 * A short digest of a block's source lines. Only used to detect that a page
 * changed under a note being written, so eight hex characters is plenty.
 */
function blockHash(lines: string[]): string {
  return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 8);
}

/** Top-level block-open tokens carrying a source map, in document order. */
function anchorTokens(tokens: Token[]): Token[] {
  // `state.push` decrements the level before stamping a closer, so `*_close`
  // tokens also report level 0 — hence the explicit `nesting` test.
  return tokens.filter(
    (t) => t.level === 0 && t.nesting >= 0 && t.map !== null && t.type !== "flux_note"
  );
}

/**
 * Every line occupied by a note comment, at any nesting depth. Excluded from
 * block hashes below, so that leaving a note *inside* a list or blockquote
 * doesn't invalidate the enclosing block's own anchor. (A note placed before a
 * block already falls outside that block's map.)
 */
function noteLines(tokens: Token[]): Set<number> {
  const lines = new Set<number>();
  for (const token of tokens) {
    if (token.type !== "flux_note" || !token.map) continue;
    for (let line = token.map[0]; line < token.map[1]; line += 1) lines.add(line);
  }
  return lines;
}

/** The source lines a block covers, minus any note comments nested inside it. */
function sourceOf(lines: string[], map: [number, number], notes: Set<number>): string[] {
  const out: string[] = [];
  for (let line = map[0]; line < map[1]; line += 1) {
    if (!notes.has(line)) out.push(lines[line]);
  }
  // A block's map can run past its last line of content (a list's does), so
  // trailing blanks are dropped: whether a block is followed by one blank line
  // or two is not part of what makes it that block.
  while (out.length && out[out.length - 1].trim() === "") out.pop();
  return out;
}

/**
 * Stamp every top-level block with the source position it came from, and with
 * the ids of the notes attached to it.
 *
 * Line numbers are relative to the string handed to `md.render()` — the page
 * body, frontmatter already stripped — because the transforms markdown-it runs
 * first (`normalize`, and our own `flux_table_pipes`) rewrite characters within
 * a line without changing the line count.
 *
 * A note attaches to the block that *contains* it if it was written inside one
 * (a note in a list item annotates the whole list), otherwise to the first
 * block that starts after it. A note trailing the last block falls back to that
 * block, so a note is never rendered invisible.
 */
function fluxAnchor(state: StateCore): void {
  // The source as it is on disk, not as `flux_table_pipes` rewrote it: these
  // hashes have to match the ones `sourceBlocks` computes from the stored body.
  const src = rawSource(state);
  const lines = src.split("\n");
  const notes = noteLines(state.tokens);
  const blocks = anchorTokens(state.tokens);
  const attached = new Map<Token, string[]>();

  for (const note of parseNotes(src)) {
    const target =
      blocks.find((t) => t.map![0] <= note.line && note.line < t.map![1]) ??
      blocks.find((t) => t.map![0] > note.line) ??
      blocks[blocks.length - 1];
    if (!target) continue;
    const ids = attached.get(target);
    if (ids) ids.push(note.id);
    else attached.set(target, [note.id]);
  }

  for (const token of blocks) {
    const anchor = {
      line: token.map![0],
      hash: blockHash(sourceOf(lines, token.map!, notes)),
      notes: attached.get(token) ?? [],
    };
    if (token.type === "fence") {
      // The default fence renderer hangs `token.attrs` off the inner <code>,
      // and the mermaid override below builds its <pre> by hand, so the fence
      // renderer emits these itself.
      token.meta = { ...(token.meta ?? {}), anchor };
      continue;
    }
    token.attrSet("data-src-line", String(anchor.line));
    token.attrSet("data-src-hash", anchor.hash);
    if (anchor.notes.length) token.attrSet("data-flux-notes", anchor.notes.join(" "));
  }
}

/**
 * Give every heading a stable `id` so it can be linked to directly.
 *
 * "Anchor" already means something else in this file — `fluxAnchor` above stamps
 * the *source* position a block came from, for the notes feature — so everything
 * to do with heading links is called a section instead.
 *
 * The slug comes from the inline token's raw `.content` rather than the rendered
 * HTML, so markup in a heading (`## \`api.foo\` is *gone*`) contributes its text
 * and not its tags. The id is also stashed on the matching `heading_close` token,
 * which is where the renderer hangs the copy affordance.
 */
function fluxSection(state: StateCore): void {
  const tokens = state.tokens;
  const heads: { open: Token; close?: Token; inline: Token; pin: string | null }[] = [];
  const pinned = new Set<string>();

  // First pass: find the headings and take their pins off, collecting the pinned
  // ids before any derived slug is handed out.
  for (let i = 0; i < tokens.length; i += 1) {
    const open = tokens[i];
    if (open.type !== "heading_open") continue;
    const inline = tokens[i + 1];
    if (!inline || inline.type !== "inline") continue;

    const pin = stripSectionPin(inline);
    if (pin) pinned.add(pin);

    let close: Token | undefined;
    for (let j = i + 2; j < tokens.length; j += 1) {
      if (tokens[j].type === "heading_close" && tokens[j].level === open.level) {
        close = tokens[j];
        break;
      }
    }
    heads.push({ open, close, inline, pin });
  }

  // Second pass: assign. A pin outranks a derived slug — it is a promise to
  // whatever already links there, and letting an earlier heading claim the name
  // first would quietly demote the pin to `-2` and break that promise.
  const taken = new Set<string>(RESERVED_SECTION_IDS);
  const sections: Section[] = [];
  for (const head of heads) {
    // A second heading pinned to the same id loses it and falls back to its
    // text, rather than silently shadowing the first.
    const id =
      head.pin && !taken.has(head.pin)
        ? reserveSectionId(taken, head.pin)
        : reserveSectionId(taken, headingSlug(head.inline.content) || SECTION_FALLBACK, pinned);

    head.open.attrSet("id", id);
    const text = inlineText(head.inline);
    if (head.close) {
      head.close.meta = { ...(head.close.meta ?? {}), sectionId: id, sectionText: text };
    }
    sections.push({
      level: Number(head.open.tag.slice(1)),
      text,
      anchor: id,
      line: head.open.map?.[0] ?? 0,
    });
  }

  // Parked here rather than re-derived by the caller, so the page's table of
  // contents and the HTML it indexes can only ever come from one pass.
  (state.env as Record<string, unknown>).fluxSections = sections;
}

/**
 * Take an explicit `{#pin}` off a heading — out of the slug source and out of
 * the text the reader sees — and return the id it named.
 *
 * Detection reads `inline.content`, the heading's source before `typographer`
 * touched it, so the id is exactly what the author typed. The strip against the
 * rendered children has to be looser, because by then `{#a--b}` has become
 * `{#a–b}` and the strict pattern would slide off it, leaving the pin on screen.
 */
function stripSectionPin(inline: Token): string | null {
  const match = SECTION_PIN.exec(inline.content);
  if (!match) return null;
  inline.content = inline.content.replace(SECTION_PIN, "");

  const children = inline.children ?? [];
  for (let i = children.length - 1; i >= 0; i -= 1) {
    const child = children[i];
    if (child.type === "softbreak" || child.type === "hardbreak") continue;
    // Only the last rendered child can hold the pin. If it is a code span or a
    // link there is nothing to strip — the strict pattern would not have matched
    // the raw content either, since that ends in a backtick or a paren.
    if (child.type === "text") {
      child.content = child.content.replace(SECTION_PIN_RENDERED, "");
    }
    break;
  }
  return match[1].toLowerCase();
}

/**
 * A heading as the reader sees it: inline markup resolved away, tags dropped.
 *
 * The slug is taken from the raw source, but the rail and the MCP payload show
 * this text to a person — raw source would put literal backticks and asterisks
 * in front of them, and would join a setext heading's two lines with a newline.
 *
 * `imageAlt` is what a heading wants and `locateQuote` does not: alt text names
 * an image for a heading that is one, but it reaches the browser as an
 * attribute, so it is not text a note's quote could ever be highlighted in.
 */
function inlineText(token: Token, imageAlt = true): string {
  let out = "";
  for (const child of token.children ?? []) {
    if (child.type === "text" || child.type === "code_inline") out += child.content;
    else if (child.type === "softbreak" || child.type === "hardbreak") out += " ";
    else if (child.type === "image" && imageAlt) out += child.content; // alt text
  }
  return out.replace(/\s+/g, " ").trim();
}

/** One heading of a page, addressable by its `anchor`. */
export interface Section {
  /** 1–6, matching the `<h*>` level. */
  level: number;
  /** The heading's plain text, with any `{#pin}` already removed. */
  text: string;
  /** The URL fragment that scrolls to it, without the leading `#`. */
  anchor: string;
  /** 0-based start line within the body. */
  line: number;
}

/**
 * The headings of a body, with the anchors the renderer gives them.
 *
 * Shaped like `sourceBlocks` below, and for the same reason: the MCP server has
 * to report anchors that the rendered page will actually have. Running the real
 * parser is what guarantees that — the ids come from the same core rule, and
 * `# comments` inside fenced code are excluded for free.
 */
export function extractSections(body: string): Section[] {
  // Built once: `kb_search` asks for this per hit, and a fresh MarkdownIt drags
  // the whole highlight.js wiring up with it. The rule is stateless — every id
  // is reserved against a set created inside the pass — so one instance is safe
  // to reuse across bodies.
  sectionRenderer ??= createRenderer(() => undefined);
  const env: Record<string, unknown> = {};
  sectionRenderer.parse(body.replace(/\r\n?/g, "\n"), env);
  return (env.fluxSections as Section[] | undefined) ?? [];
}

let sectionRenderer: MarkdownIt | undefined;

/** A block anchor as attributes, for renderers that build their own open tag. */
function anchorAttrs(md: MarkdownIt, token: Token): string {
  const anchor = (token.meta as { anchor?: { line: number; hash: string; notes: string[] } })
    ?.anchor;
  if (!anchor) return "";
  let out = ` data-src-line="${anchor.line}" data-src-hash="${md.utils.escapeHtml(anchor.hash)}"`;
  if (anchor.notes.length) {
    out += ` data-flux-notes="${md.utils.escapeHtml(anchor.notes.join(" "))}"`;
  }
  return out;
}

/**
 * The top-level blocks of a body, with the same line anchors and fingerprints
 * the renderer stamps into the HTML. The note write path uses this to confirm
 * the block a note is aimed at is still the one the reader was looking at.
 */
export function sourceBlocks(body: string): SourceBlock[] {
  const md = createRenderer(() => undefined);
  // Hash the same normalized text the renderer sees, so the two always agree.
  const src = body.replace(/\r\n?/g, "\n");
  const tokens = md.parse(src, {});
  const lines = src.split("\n");
  const notes = noteLines(tokens);
  return anchorTokens(tokens).map((token) => ({
    line: token.map![0],
    hash: blockHash(sourceOf(lines, token.map!, notes)),
  }));
}

/** Where a quoted phrase sits in a body, or why it could not be pinned down. */
export type QuoteLocation =
  | { ok: true; line: number; quote: string }
  | { ok: false; reason: "empty" | "not-found" }
  | { ok: false; reason: "ambiguous"; blocks: number };

/**
 * Fold the punctuation the typographer rewrites but a writer types plainly, so a
 * quote copied with an ASCII apostrophe still matches the curly one on the page.
 *
 * Length-preserving on purpose: the match offset is used to slice the block's own
 * text, and a fold that changed the length would slice the wrong window. That
 * rules out dashes and ellipses — `--` is two characters and `\u2013` is one — but
 * those need no folding here, because `parseInline` converts them on the quote's
 * side exactly as `parse` did on the page's.
 */
function foldPunctuation(value: string): string {
  return value.replace(/[\u2018\u2019\u201a\u201b]/g, "'").replace(/[\u201c-\u201f]/g, '"');
}

/**
 * Every top-level block of a body, with the text a reader sees in it.
 *
 * This has to be the string the *browser* would build: `markQuote` indexes the
 * block's text nodes with runs of whitespace collapsed, which is what joining
 * each inline token's text with one space reproduces — markdown-it emits a
 * newline between `</li>` and `<li>`, and the DOM collapses it to a space.
 *
 * Blocks come from `anchorTokens`, the same list `sourceBlocks` reports, so a
 * line found here always names a block the note machinery can anchor to. A note
 * comment contributes nothing: its token carries a map but no content.
 */
function blockTexts(md: MarkdownIt, body: string): { line: number; text: string }[] {
  const src = body.replace(/\r\n?/g, "\n");
  const tokens = md.parse(src, {});
  const anchors = new Set(anchorTokens(tokens));
  const blocks: { line: number; parts: string[] }[] = [];

  for (const token of tokens) {
    if (anchors.has(token)) blocks.push({ line: token.map![0], parts: [] });
    const current = blocks[blocks.length - 1];
    if (!current) continue;
    if (token.type === "inline") {
      current.parts.push(inlineText(token, false));
    } else if (token.type === "fence" || token.type === "code_block") {
      // A mermaid fence's text belongs to the diagram, and `markQuote` steps
      // around those nodes, so a quote there could only ever read as drifted.
      if (token.info.trim().split(/\s+/)[0] !== "mermaid") current.parts.push(token.content);
    }
  }

  return blocks.map((block) => ({ line: block.line, text: normalizeQuote(block.parts.join(" ")) }));
}

/**
 * Find the block a quoted phrase sits in, so a note can be anchored to it.
 *
 * The browser reports the block it was looking at by line and fingerprint; an
 * agent writing over MCP has neither, only the words. So both sides go through
 * the real parser here — the body through `parse`, the quote through
 * `parseInline` — and markup, entities and the typographer resolve identically
 * on each: `**the rolling restart** script` finds the block that reads "the
 * rolling restart script".
 *
 * The quote that comes back is sliced out of the block's own text rather than
 * echoed from the argument, so what gets stored is a verbatim substring of what
 * `markQuote` will search: a note written this way cannot be born drifted.
 *
 * A phrase found in more than one block is refused rather than resolved to the
 * first of them. A note on the wrong paragraph is worse than a refusal the
 * caller can do something about.
 */
export function locateQuote(body: string, quote: string): QuoteLocation {
  // One instance, kept for the same reason `extractSections` keeps one: a fresh
  // MarkdownIt drags the whole highlight.js wiring up with it, and parsing is
  // stateless, so it is safe to reuse across bodies.
  quoteRenderer ??= createRenderer(() => undefined);
  const inline = quoteRenderer.parseInline(quote.replace(/\r\n?/g, "\n"), {})[0];
  const want = inline ? inlineText(inline, false) : "";
  // Empty covers a quote that was only markup ("****"), which has no words to
  // find even though the caller sent characters.
  if (!want) return { ok: false, reason: "empty" };

  const folded = foldPunctuation(want);
  const hits = blockTexts(quoteRenderer, body).filter((block) =>
    foldPunctuation(block.text).includes(folded)
  );
  if (!hits.length) return { ok: false, reason: "not-found" };
  if (hits.length > 1) return { ok: false, reason: "ambiguous", blocks: hits.length };

  const at = foldPunctuation(hits[0].text).indexOf(folded);
  return { ok: true, line: hits[0].line, quote: hits[0].text.slice(at, at + want.length) };
}

let quoteRenderer: MarkdownIt | undefined;

/**
 * Create a markdown renderer.
 * @param resolveTitle maps a slug to a page title, so [[wiki-links]] can show
 *                     the target page's real title. A slug that maps to a
 *                     title is also treated as an existing page.
 * @param currentSlug  the slug of the page being rendered, used to resolve
 *                     relative [[wiki-link]] targets within the same space.
 * @param resolveIdSlug maps a stable page id to its current slug, so an
 *                     `[[id:<id>]]` link resolves to the page's live location
 *                     even after it has been moved or renamed.
 */
export function createRenderer(
  resolveTitle: (slug: string) => string | undefined,
  currentSlug = "",
  resolveIdSlug: (id: string) => string | undefined = () => undefined
): MarkdownIt {
  const md = new MarkdownIt({
    html: false, // don't allow raw HTML from content for safety
    linkify: true,
    typographer: true,
    highlight(code, lang) {
      if (lang && hljs.getLanguage(lang)) {
        try {
          return hljs.highlight(code, { language: lang }).value;
        } catch {
          /* fall through to default escaping */
        }
      }
      return ""; // markdown-it will escape & wrap in <pre><code>
    },
  });

  // ```mermaid fences become a container the client-side Mermaid library finds
  // and replaces with an SVG diagram, instead of a highlighted code block. The
  // default fence renderer (which drives the `highlight` callback above) still
  // handles every other language, so normal code blocks are unaffected.
  const defaultFence = md.renderer.rules.fence!;
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const lang = token.info.trim().split(/\s+/)[0];
    const html =
      lang === "mermaid"
        ? // Mermaid reads the element's textContent, so escape for valid HTML;
          // the browser decodes it back to the raw diagram source before
          // Mermaid runs.
          `<pre class="mermaid">${md.utils.escapeHtml(token.content)}</pre>\n`
        : defaultFence(tokens, idx, options, env, self);
    // Both branches open with `<pre`. The note anchor goes there rather than
    // through attrSet, which would put it on the inner <code> — not the element
    // the reader selects text in or the pin is positioned against.
    const anchor = anchorAttrs(md, token);
    return anchor && html.startsWith("<pre") ? `<pre${anchor}${html.slice(4)}` : html;
  };

  // Table rows are cut into cells before any inline rule runs, so a wiki-link's
  // `|` has to be escaped in the source or it reads as a cell boundary. Runs
  // ahead of `block` for that reason, and stashes what it was given so the
  // anchors stamped later still fingerprint the body as it is stored.
  md.core.ruler.before("block", "flux_table_pipes", (state) => {
    if (state.env) (state.env as Record<string, unknown>)[RAW_SRC] = state.src;
    state.src = escapeTableWikiPipes(state.src);
  });

  // Inline notes: consume the comment (see fluxNote for why this is needed at
  // all with html:false) and stamp source anchors onto every top-level block.
  md.block.ruler.before("table", "flux_note", fluxNote, {
    alt: ["paragraph", "reference", "blockquote", "list"],
  });
  md.core.ruler.push("flux_anchor", fluxAnchor);
  // After flux_anchor, so a heading carries both its source position and its id.
  md.core.ruler.push("flux_section", fluxSection);
  // A newline rather than "": markdown-it relies on block tokens emitting their
  // own separators, and an empty string merges the paragraphs of a tight list
  // that has a note between them.
  md.renderer.rules.flux_note = () => "\n";

  // A hover affordance after each heading's text that copies the section's
  // reference. It goes here rather than in the left gutter, which `.note-pin`
  // already occupies. `href` is percent-encoded so a non-ASCII anchor resolves;
  // `data-copy-slug` keeps the readable form, because that is what gets pasted.
  const defaultHeadingClose =
    md.renderer.rules.heading_close ??
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.heading_close = (tokens, idx, options, env, self) => {
    const close = defaultHeadingClose(tokens, idx, options, env, self);
    const meta = tokens[idx].meta as { sectionId?: string; sectionText?: string } | undefined;
    const id = meta?.sectionId;
    if (!id) return close;
    const reference = md.utils.escapeHtml(currentSlug ? `${currentSlug}#${id}` : `#${id}`);
    const href = md.utils.escapeHtml("#" + encodeURIComponent(id));
    const label = md.utils.escapeHtml(`Copy link to section: ${meta?.sectionText || id}`);
    // The element is deliberately empty and the "#" is drawn by CSS. A text node
    // here would join the heading's textContent — which is what a reader sweeps
    // up when they drag across a heading to leave a note on it.
    return (
      `<a class="section-link" href="${href}" data-copy-slug="${reference}"` +
      ` data-copy-label="Section link" aria-label="${label}"></a>` +
      close
    );
  };

  // Accept an optional `=WxH` size spec on images (`![alt](pic.png =600x)`),
  // the only way to size an image given `html: false` above.
  md.inline.ruler.at("image", imageWithSize);

  // Rewrite relative `_assets/…` references (images and attachment links such
  // as PDFs) to the current page's space, e.g. `_assets/diagram.png` on a `flux`
  // page → `/flux/_assets/diagram.png`. Portable across space renames.
  const spaceKey = currentSlug.split("/")[0] ?? "";
  rewriteAttr(md, "image", "src", spaceKey);
  rewriteAttr(md, "link_open", "href", spaceKey);

  // [[slug]] or [[slug|Label]] wiki-links, resolved before normal links.
  md.inline.ruler.before("link", "wikilink", (state, silent) => {
    const start = state.pos;
    if (
      state.src.charCodeAt(start) !== 0x5b /* [ */ ||
      state.src.charCodeAt(start + 1) !== 0x5b
    ) {
      return false;
    }
    const end = state.src.indexOf("]]", start + 2);
    if (end < 0) return false;

    if (!silent) {
      // `\|` is how the alias pipe survives a table cell — written by hand, or
      // by `flux_table_pipes` above on a line it read as a table row. Cell
      // splitting removes the escape again, so one is only still here when the
      // link turned out not to be in a table after all; either way the label
      // starts after the first pipe, escaped or not.
      const inner = state.src.slice(start + 2, end).replace(/\\\|/g, "|");
      const bar = inner.indexOf("|");
      const withFragment = bar === -1 ? inner : inner.slice(0, bar);
      const label = bar === -1 ? undefined : inner.slice(bar + 1).trim();
      // A `#section` suffix has to come off before the target is resolved —
      // otherwise it is read as part of the page's name and nothing matches.
      // The link text still names the page; use `|Label` to say more.
      const { target: rawTarget, fragment } = splitFragment(withFragment);
      const target = rawTarget.trim();
      const idMatch = /^id:(.+)$/.exec(target);

      if (idMatch) {
        // `[[id:<id>]]` / `[[id:<id>|Label]]` — resolve the stable id to the
        // page's current slug so the link survives moves/renames. An unknown id
        // renders a visibly-broken, non-crashing link rather than throwing.
        const id = idMatch[1].trim();
        const slug = resolveIdSlug(id);
        const open = state.push("link_open", "a", 1);
        if (slug !== undefined) {
          open.attrSet("href", pageHref(slug, fragment));
          open.attrSet("class", "wikilink");
          const t = state.push("text", "", 0);
          t.content = label || resolveTitle(slug) || slug.split("/").pop() || slug;
        } else {
          open.attrSet("href", "/id:" + id + fragmentHref(fragment));
          open.attrSet("class", "wikilink broken");
          const t = state.push("text", "", 0);
          t.content = label || id;
        }
        state.push("link_close", "a", -1);
      } else {
        const slug = resolveWikiTarget(rawTarget, currentSlug, (s) => resolveTitle(s) !== undefined);
        const text = label || resolveTitle(slug) || slug.split("/").pop() || slug;

        const open = state.push("link_open", "a", 1);
        open.attrSet("href", pageHref(slug, fragment));
        open.attrSet("class", "wikilink");
        const t = state.push("text", "", 0);
        t.content = text;
        state.push("link_close", "a", -1);
      }
    }

    state.pos = end + 2;
    return true;
  });

  return md;
}
