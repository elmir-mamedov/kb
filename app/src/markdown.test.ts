import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createRenderer,
  extractSections,
  headingSlug,
  locateQuote,
  noteSegments,
  sourceBlocks,
} from "./markdown.js";

/** Render Markdown with a renderer scoped to a representative page slug. */
const render = (src: string) =>
  createRenderer(() => undefined, "kb25/page").render(src);

test("```mermaid fences render as a Mermaid container, not a code block", () => {
  const html = render("```mermaid\nflowchart LR\n  a --> b\n```\n");
  // Emitted as a container the client-side Mermaid library picks up. Matched on
  // the class alone because every top-level block also carries a note anchor —
  // and `class="mermaid"` is the exact substring layout() looks for to decide
  // whether to ship the Mermaid loader.
  assert.match(html, /<pre[^>]* class="mermaid">/);
  assert.match(html, /flowchart LR/);
  // Not a highlighted code block.
  assert.doesNotMatch(html, /language-mermaid/);
  assert.doesNotMatch(html, /<code/);
});

test("mermaid diagram source is HTML-escaped inside the container", () => {
  const html = render('```mermaid\nflowchart LR\n  a["x<br/>y"]\n```\n');
  // Escaped for valid HTML; the browser decodes it back to text for Mermaid.
  assert.match(html, /&lt;br\/&gt;/);
  assert.doesNotMatch(html, /<br\/>/);
});

test("non-mermaid code fences are still syntax-highlighted", () => {
  const html = render("```ts\nconst x: number = 1;\n```\n");
  assert.match(html, /class="language-ts"/);
  assert.match(html, /hljs/); // highlight.js markup present
  assert.doesNotMatch(html, /class="mermaid"/);
});

test("[[id:<id>]] resolves to the target's current slug and title", () => {
  const md = createRenderer(
    (slug) => (slug === "kb25/moved-here" ? "Moved Page" : undefined),
    "kb25/page",
    (id) => (id === "abc123" ? "kb25/moved-here" : undefined)
  );
  const html = md.render("See [[id:abc123]].");
  assert.match(html, /href="\/kb25\/moved-here"/);
  assert.match(html, /class="wikilink"/);
  assert.match(html, />Moved Page</);
});

test("[[id:<id>|Label]] keeps the explicit label", () => {
  const md = createRenderer(
    () => "Real Title",
    "kb25/page",
    (id) => (id === "abc123" ? "kb25/target" : undefined)
  );
  const html = md.render("[[id:abc123|Custom Label]]");
  assert.match(html, /href="\/kb25\/target"/);
  assert.match(html, />Custom Label</);
});

test("[[id:<id>]] with an unknown id renders a non-crashing broken link", () => {
  const md = createRenderer(() => undefined, "kb25/page", () => undefined);
  const html = md.render("[[id:ghost|Gone]]");
  assert.match(html, /class="wikilink broken"/);
  assert.match(html, />Gone</);
});

test("slug-based [[wiki-links]] still resolve when no id resolver is given", () => {
  const md = createRenderer(
    (slug) => (slug === "kb25/other" ? "Other" : undefined),
    "kb25/page"
  );
  const html = md.render("[[kb25/other]]");
  assert.match(html, /href="\/kb25\/other"/);
  assert.match(html, />Other</);
});

/** A renderer with one id-addressable page, for the table tests below. */
const tableRenderer = () =>
  createRenderer(
    (slug) => (slug === "kb25/ledger" ? "Ledger" : undefined),
    "kb25/page",
    (id) => (id === "abc123" ? "kb25/ledger" : undefined)
  );

test("a wiki-link's label pipe inside a table cell is not read as a cell boundary", () => {
  const html = tableRenderer().render(
    "| What | Where |\n| --- | --- |\n| `invoice` | a historical [[id:abc123|ledger]] in Postgres |\n"
  );
  // The whole cell survives: before the fix it ended at "[[id:abc123", and the
  // remainder landed in a third column the header does not have, so it was
  // dropped outright.
  assert.match(html, /<td>a historical <a href="\/kb25\/ledger" class="wikilink">ledger<\/a> in Postgres<\/td>/);
  assert.doesNotMatch(html, /\[\[/);
});

test("a hand-escaped `\\|` in a table cell renders the same, without a stray backslash", () => {
  const html = tableRenderer().render(
    "| A | B |\n| --- | --- |\n| x | see [[id:abc123\\|the ledger]] |\n"
  );
  assert.match(html, /<td>see <a href="\/kb25\/ledger" class="wikilink">the ledger<\/a><\/td>/);
  assert.doesNotMatch(html, /\\/);
});

test("slug wiki-links and table headers get the same treatment as id links", () => {
  const html = tableRenderer().render(
    "| Page [[kb25/ledger|H]] | B |\n| --- | --- |\n| [[kb25/ledger|the ledger]] | y |\n"
  );
  assert.match(html, /<th>Page <a href="\/kb25\/ledger" class="wikilink">H<\/a><\/th>/);
  assert.match(html, /<td><a href="\/kb25\/ledger" class="wikilink">the ledger<\/a><\/td>/);
});

test("a pipe outside a wiki-link still splits cells, and one in prose is untouched", () => {
  const html = tableRenderer().render(
    "| A | B |\n| --- | --- |\n| x | y |\n\nProse with a | pipe and [[id:abc123|a link]].\n"
  );
  assert.match(html, /<td>x<\/td>\n<td>y<\/td>/);
  assert.match(html, /<p[^>]*>Prose with a \| pipe and <a href="\/kb25\/ledger" class="wikilink">a link<\/a>\.<\/p>/);
});

test("a table-shaped code sample keeps its wiki-link pipe verbatim", () => {
  const html = tableRenderer().render(
    "```\n| A | B |\n| --- | --- |\n| x | [[id:abc123|ledger]] |\n```\n"
  );
  assert.match(html, /\[\[id:abc123\|ledger\]\]/);
  assert.doesNotMatch(html, /\\\|/);
});

test("escaping table pipes leaves a block's source anchor pointing at the stored body", () => {
  const body = "| A | B |\n| --- | --- |\n| x | [[id:abc123|ledger]] |\n";
  const html = tableRenderer().render(body);
  const hash = /data-src-hash="([0-9a-f]+)"/.exec(html)?.[1];
  // The note write path re-derives this from the file on disk, which still has
  // the unescaped pipe — the two must agree or notes on the table cannot save.
  assert.equal(hash, sourceBlocks(body)[0].hash);
});

test("images render without size attributes by default", () => {
  const html = render("![Diagram](_assets/pic.png)");
  assert.match(html, /<img src="\/kb25\/_assets\/pic\.png" alt="Diagram">/);
});

test("`=WxH` sets width only when height is omitted", () => {
  const html = render("![Diagram](_assets/pic.png =600x)");
  assert.match(html, /src="\/kb25\/_assets\/pic\.png"/); // asset rewrite still applies
  assert.match(html, /width="600"/);
  assert.doesNotMatch(html, /height=/);
  assert.doesNotMatch(html, /=600x/); // spec consumed, not left in the URL
});

test("`=WxH` sets both dimensions, and height alone works", () => {
  assert.match(render("![D](_assets/pic.png =600x400)"), /width="600" height="400"/);
  const heightOnly = render("![D](_assets/pic.png =x400)");
  assert.match(heightOnly, /height="400"/);
  assert.doesNotMatch(heightOnly, /width=/);
});

test("a size spec coexists with a title", () => {
  const html = render('![D](_assets/pic.png "A title" =600x)');
  assert.match(html, /title="A title"/);
  assert.match(html, /width="600"/);
});

test("a size spec with no dimensions is not an image", () => {
  const html = render("![D](_assets/pic.png =x)");
  assert.doesNotMatch(html, /<img/);
});

test("external image URLs accept a size and are not asset-rewritten", () => {
  const html = render("![D](https://example.com/pic.png =320x)");
  assert.match(html, /src="https:\/\/example\.com\/pic\.png"/);
  assert.match(html, /width="320"/);
});

/** A `kb25:note` comment as it appears on disk, with the given text. */
const noteComment = (id: string, text: string, quote?: string) =>
  ["<!-- kb25:note id=" + id + " kind=task", ...(quote ? ["> " + quote, ""] : []), text, "-->"].join(
    "\n"
  );

test("a kb25:note comment renders nothing, not escaped text", () => {
  const html = render(noteComment("aaa", "Fix this.", "the phrase") + "\nAnnotated paragraph.\n");
  assert.doesNotMatch(html, /kb25:note/);
  assert.doesNotMatch(html, /&lt;!--/);
  assert.doesNotMatch(html, /Fix this\./);
  assert.match(html, /Annotated paragraph\./);
});

test("the block below a note carries its id, and every top-level block is anchored", () => {
  const html = render("# Title\n\n" + noteComment("aaa", "Fix this.") + "\nAnnotated paragraph.\n");
  // The heading also carries its section id and copy affordance; what matters
  // here is that the source anchors survive alongside them.
  assert.match(html, /<h1 data-src-line="0" data-src-hash="[0-9a-f]{8}" id="title">Title</);
  assert.match(html, /<p data-src-line="\d+" data-src-hash="[0-9a-f]{8}" data-kb25-notes="aaa">/);
});

test("two notes stacked on one block are both listed on it", () => {
  const html = render(
    noteComment("aaa", "First.") + "\n" + noteComment("bbb", "Second.") + "\nParagraph.\n"
  );
  assert.match(html, /data-kb25-notes="aaa bbb"/);
});

test("a note whose text contains --- is not parsed as a setext heading", () => {
  // `lheading` looks for an underline before consulting terminator rules, so
  // this only works because the note rule is registered first in the chain.
  const html = render(noteComment("aaa", "Before\n---\nAfter") + "\nParagraph.\n");
  assert.doesNotMatch(html, /<h2/);
  assert.doesNotMatch(html, /kb25:note/);
  assert.match(html, /<p data-src-line="\d+"[^>]*data-kb25-notes="aaa">Paragraph\.<\/p>/);
});

test("an unterminated note comment renders as text instead of eating the page", () => {
  const html = render("<!-- kb25:note id=aaa kind=task\nnever closed\n\nReal content.\n");
  assert.match(html, /&lt;!-- kb25:note/);
  assert.match(html, /Real content\./);
});

test("an ordinary HTML comment still renders escaped, unchanged", () => {
  const html = render("<!-- just a comment -->\n\nParagraph.\n");
  assert.match(html, /&lt;!-- just a comment --&gt;/);
});

test("a note written inside a list annotates the whole list", () => {
  const html = render("- one\n- two\n\n  " + noteComment("aaa", "Fix.").replace(/\n/g, "\n  ") + "\n");
  assert.doesNotMatch(html, /kb25:note/);
  assert.match(html, /<ul data-src-line="0"[^>]*data-kb25-notes="aaa">/);
});

test("a note between the items of a tight list does not merge them", () => {
  const html = render("- one\n\n  " + noteComment("aaa", "Fix.").replace(/\n/g, "\n  ") + "\n\n  two\n");
  assert.doesNotMatch(html, /onetwo/);
});

test("code fences carry the anchor on the <pre>, not the inner <code>", () => {
  const html = render(noteComment("aaa", "Wrong flag.") + "\n```sh\nls -a\n```\n");
  assert.match(html, /<pre data-src-line="\d+" data-src-hash="[0-9a-f]{8}" data-kb25-notes="aaa">/);
  assert.match(html, /<code class="language-sh">/);
});

test("mermaid containers keep their class alongside the anchor", () => {
  const html = render("```mermaid\nflowchart LR\n  a --> b\n```\n");
  assert.match(html, /<pre data-src-line="0" data-src-hash="[0-9a-f]{8}" class="mermaid">/);
});

test("sourceBlocks reports the same anchors the renderer stamps into the HTML", () => {
  const body = "# Title\n\nFirst paragraph.\n\n- a\n- b\n\n```sh\nls\n```\n";
  const html = render(body);
  for (const block of sourceBlocks(body)) {
    assert.match(
      html,
      new RegExp(`data-src-line="${block.line}" data-src-hash="${block.hash}"`),
      `no rendered block at line ${block.line} with hash ${block.hash}`
    );
  }
  assert.deepEqual(
    sourceBlocks(body).map((b) => b.line),
    [0, 2, 4, 7]
  );
});

test("adding a note shifts a block's line but leaves its hash alone", () => {
  const body = "First paragraph.\n\nSecond paragraph.\n";
  const annotated = "First paragraph.\n\n" + noteComment("aaa", "Fix.") + "\nSecond paragraph.\n";
  const before = sourceBlocks(body);
  const after = sourceBlocks(annotated);
  assert.notEqual(before[1].line, after[1].line); // the block moved down
  assert.equal(before[1].hash, after[1].hash); // ...but is still the same block
});

test("a note nested in a list does not change the list's hash", () => {
  const plain = "- one\n- two\n";
  const annotated = "- one\n- two\n\n  " + noteComment("aaa", "Fix.").replace(/\n/g, "\n  ") + "\n";
  assert.equal(sourceBlocks(plain)[0].hash, sourceBlocks(annotated)[0].hash);
});

// --- section anchors ---------------------------------------------------------

test("headingSlug lowercases, separates on punctuation, and trims", () => {
  assert.equal(
    headingSlug("Choose between per-directory CLAUDE.md and path-scoped rules"),
    "choose-between-per-directory-claude-md-and-path-scoped-rules"
  );
  assert.equal(headingSlug("Step 1: Install"), "step-1-install");
  assert.equal(headingSlug("Traces (beta)"), "traces-beta");
  assert.equal(headingSlug("Postgres or DBX?"), "postgres-or-dbx");
});

test("headingSlug drops quotes rather than breaking the word on them", () => {
  // `typographer` has already curled the apostrophe by the time the rule runs,
  // so both shapes have to land on the same anchor.
  assert.equal(headingSlug("Session isn't responding"), "session-isnt-responding");
  assert.equal(headingSlug("Session isn’t responding"), "session-isnt-responding");
});

test("headingSlug folds diacritics but keeps letters that do not decompose", () => {
  // Folding keeps a Czech anchor typable once a browser percent-encodes it;
  // an ASCII-only rule would leave the Chinese headings with no anchor at all.
  assert.equal(headingSlug("Příliš žluťoučký kůň"), "prilis-zlutoucky-kun");
  assert.equal(headingSlug("FDT-94 — DEV landing · Vladimír Kosťukovič"), "fdt-94-dev-landing-vladimir-kostukovic");
  assert.equal(headingSlug("一句话"), "一句话");
  assert.equal(headingSlug("✅ Cluster 1 — verified (2026-08-06)"), "cluster-1-verified-2026-08-06");
});

test("headingSlug collapses separator runs instead of stacking hyphens", () => {
  // A literal hyphen is a separator too; keeping it would make the spaces on
  // either side each add one of their own.
  assert.equal(headingSlug("P1 - Multi-PDF batch"), "p1-multi-pdf-batch");
  assert.equal(headingSlug("A -- B"), "a-b");
  // Underscores survive, so an identifier stays one readable word.
  assert.equal(headingSlug("`user_identifier` — the answer"), "user_identifier-the-answer");
});

test("every heading level gets an id", () => {
  const html = render("# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six\n");
  for (const [tag, id] of [["h1", "one"], ["h2", "two"], ["h3", "three"], ["h4", "four"], ["h5", "five"], ["h6", "six"]]) {
    assert.match(html, new RegExp(`<${tag}[^>]* id="${id}"`));
  }
});

test("repeated heading text is suffixed, and the first keeps the bare anchor", () => {
  const html = render("## Problem\n\ntext\n\n## Problem\n\ntext\n\n## Problem\n");
  assert.match(html, /<h2[^>]* id="problem">/);
  assert.match(html, /<h2[^>]* id="problem-2">/);
  assert.match(html, /<h2[^>]* id="problem-3">/);
});

test("a heading whose text already looks like a suffix does not collide", () => {
  // Counting base names alone would hand out `problem-2` twice here.
  const html = render("## Problem\n\n## Problem\n\n## problem-2\n");
  const ids = [...html.matchAll(/<h2[^>]* id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ["problem", "problem-2", "problem-2-2"]);
  assert.equal(new Set(ids).size, ids.length);
});

test("a {#pin} sets the anchor and is not rendered as heading text", () => {
  const html = render("## Rate limits {#limits}\n");
  assert.match(html, /<h2[^>]* id="limits">/);
  assert.match(html, />Rate limits</);
  assert.doesNotMatch(html, /\{#limits\}/);
});

test("a {#pin} survives markup at the end of the heading", () => {
  assert.match(render("## Rate `limits` {#a}\n"), /<h2[^>]* id="a">Rate <code>limits<\/code></);
  assert.match(render("## Trailing *stress* {#b}\n"), /<h2[^>]* id="b">Trailing <em>stress<\/em></);
});

test("a brace group that is not at the end is left alone", () => {
  const html = render("## Has {#notapin} in the middle\n");
  assert.match(html, /<h2[^>]* id="has-notapin-in-the-middle">/);
  assert.match(html, /\{#notapin\}/);
});

test("a heading with nothing sluggable falls back to a numbered section id", () => {
  const html = render("## \u{1F389}\n\n## \u{1F680}\n");
  assert.match(html, /<h2[^>]* id="section">/);
  assert.match(html, /<h2[^>]* id="section-2">/);
});

test("each heading carries a copy affordance addressed to the current page", () => {
  const html = render("## Rate limits\n");
  assert.match(
    html,
    /<a class="section-link" href="#rate-limits" data-copy-slug="kb25\/page#rate-limits" data-copy-label="Section link"/
  );
});

test("a non-ASCII anchor is percent-encoded in href but readable in what is copied", () => {
  const html = render("## 一句话\n");
  assert.match(html, /href="#%E4%B8%80%E5%8F%A5%E8%AF%9D"/);
  assert.match(html, /data-copy-slug="kb25\/page#一句话"/);
});

test("extractSections reports the same anchors the renderer stamps", () => {
  const body = "# Title\n\n## Problem\n\n### Detail\n\n## Problem\n";
  const html = render(body);
  const sections = extractSections(body);
  assert.deepEqual(
    sections.map((s) => s.anchor),
    ["title", "problem", "detail", "problem-2"]
  );
  for (const section of sections) {
    assert.match(html, new RegExp(`id="${section.anchor}"`));
  }
});

test("extractSections reports level, text and line, with the pin stripped", () => {
  const sections = extractSections("# Title\n\ntext\n\n## Rate limits {#limits}\n");
  assert.deepEqual(sections, [
    { level: 1, text: "Title", anchor: "title", line: 0 },
    { level: 2, text: "Rate limits", anchor: "limits", line: 4 },
  ]);
});

test("a # line inside a fence is code, not a section", () => {
  const body = "## Real\n\n```bash\n# not a heading\n```\n";
  assert.deepEqual(
    extractSections(body).map((s) => s.anchor),
    ["real"]
  );
  assert.doesNotMatch(render(body), /id="not-a-heading"/);
});

// --- fragments in links ------------------------------------------------------

test("[[slug#section]] resolves the page and keeps the fragment", () => {
  const md = createRenderer(
    (slug) => (slug === "kb25/ledger" ? "Ledger" : undefined),
    "kb25/page"
  );
  const html = md.render("See [[kb25/ledger#retention]].");
  assert.match(html, /<a href="\/kb25\/ledger#retention" class="wikilink">Ledger<\/a>/);
});

test("[[id:<id>#section]] resolves the id and keeps the fragment", () => {
  const md = createRenderer(
    (slug) => (slug === "kb25/moved-here" ? "Moved Page" : undefined),
    "kb25/page",
    (id) => (id === "abc123" ? "kb25/moved-here" : undefined)
  );
  const html = md.render("See [[id:abc123#retention|the rules]].");
  assert.match(html, /<a href="\/kb25\/moved-here#retention" class="wikilink">the rules<\/a>/);
});

test("an unknown id with a fragment still renders as visibly broken", () => {
  const md = createRenderer(() => undefined, "kb25/page", () => undefined);
  const html = md.render("See [[id:nope#retention]].");
  assert.match(html, /class="wikilink broken"/);
  assert.match(html, /href="\/id:nope#retention"/);
});

test("a fragment on a bare wiki-link does not become part of the page name", () => {
  const md = createRenderer(
    (slug) => (slug === "kb25/ledger" ? "Ledger" : undefined),
    "kb25/page"
  );
  const html = md.render("See [[ledger#retention]].");
  assert.match(html, /href="\/kb25\/ledger#retention"/);
});

test("a non-ASCII fragment is encoded in the href", () => {
  const md = createRenderer(
    (slug) => (slug === "kb25/ledger" ? "Ledger" : undefined),
    "kb25/page"
  );
  assert.match(
    md.render("[[kb25/ledger#一句话]]"),
    /href="\/kb25\/ledger#%E4%B8%80%E5%8F%A5%E8%AF%9D"/
  );
});

test("a pin outranks a derived slug that would have taken its name first", () => {
  // A pin is a promise to whatever already links there. Letting the earlier
  // heading claim `overview` would demote the pin to `overview-2` and break it.
  const html = render("## Overview\n\ntext\n\n## Something else {#overview}\n");
  assert.match(html, /<h2[^>]* id="overview-2">Overview</);
  assert.match(html, /<h2[^>]* id="overview">Something else</);
});

test("a second heading pinned to the same id falls back to its own text", () => {
  const html = render("## First {#dup}\n\n## Second {#dup}\n");
  assert.match(html, /<h2[^>]* id="dup">First</);
  assert.match(html, /<h2[^>]* id="second">Second</);
});

test("a pin containing -- is still removed from the rendered heading", () => {
  // typographer turns the pin's `--` into an en-dash before the strip runs, so
  // a strict pattern slides off it and leaves `{#a-b}` showing.
  const html = render("## Rate limits {#a--b}\n");
  assert.match(html, /<h2[^>]* id="a--b">Rate limits</);
  assert.doesNotMatch(html, /\{#/);
});

test("a heading cannot take an id the page already uses for something else", () => {
  // getElementById returns the first match in document order, and every heading
  // precedes layout()'s own <div id="kb25-notes">.
  assert.match(render("## KB25 notes\n"), /<h2[^>]* id="kb25-notes-2">/);
});

test("a section's text is what the reader sees, not the raw source", () => {
  assert.equal(extractSections("## `api.foo` is *gone*\n")[0].text, "api.foo is gone");
  assert.equal(extractSections("Setext heading\n---\n")[0].text, "Setext heading");
});

test("the copy affordance is an empty element, so no glyph joins the heading text", () => {
  // A "#" text node here would be swept up by a reader dragging across the
  // heading to leave a note on it. CSS draws it instead.
  const html = render("## Rate limits\n");
  assert.match(html, /data-copy-label="Section link" aria-label="Copy link to section: Rate limits"><\/a>/);
});

test("rendering parks the same sections on env that extractSections reports", () => {
  const body = "## One\n\n### Two\n\n## One\n";
  const env: Record<string, unknown> = {};
  createRenderer(() => undefined, "kb25/page").render(body, env);
  assert.deepEqual(env.kb25Sections, extractSections(body));
});

// --- locating a quote --------------------------------------------------------

/** A page with one of every shape a quote can be aimed at. */
const quotable = [
  "Run the **rolling restart** script -- see `deploy.sh` for the flags.", // 0
  "",
  "## Rollback steps", // 2
  "",
  "- drain the node", // 4
  "- then [restart it](https://example.com/restart)",
  "",
  noteComment("aaa11111", "document the drain timeout", "drain the node"), // 7
  "Restart it by hand only when the script refuses.", // 12
  "",
  "```sh", // 14
  "kubectl drain node-1",
  "```",
  "",
  "```mermaid", // 18
  "flowchart LR",
  "  a --> b",
  "```",
].join("\n");

/** The line locateQuote picked, or the reason it refused. */
const locate = (quote: string, body = quotable) => {
  const found = locateQuote(body, quote);
  return found.ok ? found.line : found.reason;
};

test("locateQuote finds a plain phrase and reports its block's line", () => {
  assert.equal(locate("Rollback steps"), 2);
  assert.equal(locate("Restart it by hand"), 12);
  assert.equal(locate("kubectl drain node-1"), 14);
});

test("locateQuote reads through markup, from either side of it", () => {
  // The agent reads raw Markdown and the browser searches rendered text, so both
  // spellings of the same phrase have to land on the same block.
  assert.equal(locate("the rolling restart script"), 0);
  assert.equal(locate("the **rolling restart** script"), 0);
  assert.equal(locate("see `deploy.sh` for the flags"), 0);
  assert.equal(locate("then restart it"), 4); // link text, not the URL
});

test("locateQuote stores the page's text, not the caller's spelling of it", () => {
  // What comes back is what `markQuote` will look for in the rendered page, so
  // the markup is gone and the typographer's punctuation is in.
  const found = locateQuote(quotable, "script -- see `deploy.sh`");
  assert.equal(found.ok && found.quote, "script \u2013 see deploy.sh");
});

test("locateQuote matches an ASCII quotation mark against a smartened one", () => {
  const body = 'He said "yes" to the rollback.\n';
  const found = locateQuote(body, 'said "yes');
  // Matched through the fold, but stored in the form the page actually renders.
  assert.equal(found.ok && found.quote, "said \u201cyes");
});

test("locateQuote refuses a phrase that sits in more than one block", () => {
  const body = "Restart the workers.\n\nSomething else.\n\nRestart the workers.\n";
  const found = locateQuote(body, "Restart the workers");
  assert.equal(found.ok, false);
  assert.equal(found.ok === false && found.reason, "ambiguous");
  assert.equal(found.ok === false && found.reason === "ambiguous" && found.blocks, 2);
});

test("locateQuote takes a phrase repeated inside one block, which is one place", () => {
  // The anchor is that block either way, and the browser marks the first hit —
  // exactly what a person's note on the same words already does.
  const body = "The script calls the script twice.\n";
  assert.equal(locate("the script", body), 0);
});

test("locateQuote refuses a phrase spanning two blocks, and says nothing found", () => {
  assert.equal(locate("then restart it Restart it by hand"), "not-found");
});

test("locateQuote reads across the paragraphs inside one block", () => {
  // Two paragraphs in one list item are still one block, and the browser
  // searches the whole <ul> — so a quote across them is findable.
  const body = "- item one\n\n  second paragraph of it\n";
  assert.equal(locate("item one second paragraph of it", body), 0);
});

test("locateQuote cannot see a note's own text, which is not on the page", () => {
  assert.equal(locate("document the drain timeout"), "not-found");
});

test("locateQuote refuses a quote inside a mermaid fence", () => {
  // Mermaid owns those text nodes and `markQuote` steps around them, so a note
  // anchored there could only ever read as drifted.
  assert.equal(locate("flowchart LR"), "not-found");
});

test("locateQuote refuses a quote with no words in it", () => {
  assert.equal(locate(""), "empty");
  assert.equal(locate("   \n  "), "empty");
  // An image is an attribute by the time it reaches the reader, not text.
  assert.equal(locate("![a diagram](x.png)", "![a diagram](x.png)\n"), "empty");
});

test("locateQuote only ever names a line sourceBlocks also reports", () => {
  const lines = new Set(sourceBlocks(quotable).map((block) => block.line));
  for (const quote of ["Rollback steps", "the rolling restart script", "drain the node"]) {
    const found = locateQuote(quotable, quote);
    assert.equal(found.ok, true);
    assert.ok(found.ok && lines.has(found.line), `line ${found.ok && found.line} is not a block`);
  }
});

test("locateQuote is unmoved by a note already sitting above the block", () => {
  const plain = "First paragraph.\n\nSecond paragraph.\n";
  const annotated = "First paragraph.\n\n" + noteComment("bbb", "Fix.") + "\nSecond paragraph.\n";
  // The block moved down, and the answer moves with it rather than staying put.
  assert.equal(locate("Second paragraph", plain), 2);
  assert.equal(locate("Second paragraph", annotated), sourceBlocks(annotated)[1].line);
});

/** A renderer with one id-addressable page, for the note-segment tests below. */
const noteRenderer = () =>
  createRenderer(
    (slug) => (slug === "data/fdt-230" ? "FDT-230" : undefined),
    "data/pipedrive",
    (id) => (id === "2ikrbnpzudb7e" ? "data/fdt-230" : undefined)
  );

test("a note without a link is one plain segment", () => {
  const segments = noteSegments(noteRenderer(), "Overtaken by events.");
  assert.deepEqual(segments, [{ text: "Overtaken by events." }]);
});

test("a note's [[id:…]] link becomes a segment pointing at the live slug", () => {
  const segments = noteSegments(
    noteRenderer(),
    "Answered by [[id:2ikrbnpzudb7e|FDT-230]] on the 11th."
  );
  assert.deepEqual(segments, [
    { text: "Answered by " },
    { text: "FDT-230", href: "/data/fdt-230" },
    { text: " on the 11th." },
  ]);
});

test("a note's [[id:…#anchor]] link keeps the section it points at", () => {
  const segments = noteSegments(noteRenderer(), "[[id:2ikrbnpzudb7e#the-inventory|§ The inventory]]");
  assert.deepEqual(segments, [
    { text: "§ The inventory", href: "/data/fdt-230#the-inventory" },
  ]);
});

test("a note's Markdown link and bare URL both become link segments", () => {
  const segments = noteSegments(
    noteRenderer(),
    "[rejected](https://example.test/browse/FDT-130) — see https://example.test/docs"
  );
  assert.deepEqual(segments, [
    { text: "rejected", href: "https://example.test/browse/FDT-130" },
    { text: " — see " },
    { text: "https://example.test/docs", href: "https://example.test/docs" },
  ]);
});

test("a note's portable _assets/ link is scoped to its own space", () => {
  const segments = noteSegments(noteRenderer(), "[the export](_assets/budget.pdf)", "data");
  assert.deepEqual(segments, [{ text: "the export", href: "/data/_assets/budget.pdf" }]);
});

test("a note's line breaks survive segmenting, and its markup does not", () => {
  const segments = noteSegments(noteRenderer(), "**Closed** on the 11th.\n\nSee `raw_pipedrive`.");
  // pre-wrap draws the blank line, so the shape the author gave the note holds.
  assert.deepEqual(segments, [{ text: "Closed on the 11th.\n\nSee raw_pipedrive." }]);
});

test("an unresolvable [[id:…]] in a note is still a segment, not swallowed", () => {
  const segments = noteSegments(noteRenderer(), "See [[id:ghost|the missing page]].");
  assert.deepEqual(segments, [
    { text: "See " },
    { text: "the missing page", href: "/id:ghost" },
    { text: "." },
  ]);
});
