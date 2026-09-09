import { test } from "node:test";
import assert from "node:assert/strict";
import { createRenderer, extractSections, headingSlug, sourceBlocks } from "./markdown.js";

/** Render Markdown with a renderer scoped to a representative page slug. */
const render = (src: string) =>
  createRenderer(() => undefined, "flux/page").render(src);

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
    (slug) => (slug === "flux/moved-here" ? "Moved Page" : undefined),
    "flux/page",
    (id) => (id === "abc123" ? "flux/moved-here" : undefined)
  );
  const html = md.render("See [[id:abc123]].");
  assert.match(html, /href="\/flux\/moved-here"/);
  assert.match(html, /class="wikilink"/);
  assert.match(html, />Moved Page</);
});

test("[[id:<id>|Label]] keeps the explicit label", () => {
  const md = createRenderer(
    () => "Real Title",
    "flux/page",
    (id) => (id === "abc123" ? "flux/target" : undefined)
  );
  const html = md.render("[[id:abc123|Custom Label]]");
  assert.match(html, /href="\/flux\/target"/);
  assert.match(html, />Custom Label</);
});

test("[[id:<id>]] with an unknown id renders a non-crashing broken link", () => {
  const md = createRenderer(() => undefined, "flux/page", () => undefined);
  const html = md.render("[[id:ghost|Gone]]");
  assert.match(html, /class="wikilink broken"/);
  assert.match(html, />Gone</);
});

test("slug-based [[wiki-links]] still resolve when no id resolver is given", () => {
  const md = createRenderer(
    (slug) => (slug === "flux/other" ? "Other" : undefined),
    "flux/page"
  );
  const html = md.render("[[flux/other]]");
  assert.match(html, /href="\/flux\/other"/);
  assert.match(html, />Other</);
});

/** A renderer with one id-addressable page, for the table tests below. */
const tableRenderer = () =>
  createRenderer(
    (slug) => (slug === "flux/ledger" ? "Ledger" : undefined),
    "flux/page",
    (id) => (id === "abc123" ? "flux/ledger" : undefined)
  );

test("a wiki-link's label pipe inside a table cell is not read as a cell boundary", () => {
  const html = tableRenderer().render(
    "| What | Where |\n| --- | --- |\n| `invoice` | a historical [[id:abc123|ledger]] in Postgres |\n"
  );
  // The whole cell survives: before the fix it ended at "[[id:abc123", and the
  // remainder landed in a third column the header does not have, so it was
  // dropped outright.
  assert.match(html, /<td>a historical <a href="\/flux\/ledger" class="wikilink">ledger<\/a> in Postgres<\/td>/);
  assert.doesNotMatch(html, /\[\[/);
});

test("a hand-escaped `\\|` in a table cell renders the same, without a stray backslash", () => {
  const html = tableRenderer().render(
    "| A | B |\n| --- | --- |\n| x | see [[id:abc123\\|the ledger]] |\n"
  );
  assert.match(html, /<td>see <a href="\/flux\/ledger" class="wikilink">the ledger<\/a><\/td>/);
  assert.doesNotMatch(html, /\\/);
});

test("slug wiki-links and table headers get the same treatment as id links", () => {
  const html = tableRenderer().render(
    "| Page [[flux/ledger|H]] | B |\n| --- | --- |\n| [[flux/ledger|the ledger]] | y |\n"
  );
  assert.match(html, /<th>Page <a href="\/flux\/ledger" class="wikilink">H<\/a><\/th>/);
  assert.match(html, /<td><a href="\/flux\/ledger" class="wikilink">the ledger<\/a><\/td>/);
});

test("a pipe outside a wiki-link still splits cells, and one in prose is untouched", () => {
  const html = tableRenderer().render(
    "| A | B |\n| --- | --- |\n| x | y |\n\nProse with a | pipe and [[id:abc123|a link]].\n"
  );
  assert.match(html, /<td>x<\/td>\n<td>y<\/td>/);
  assert.match(html, /<p[^>]*>Prose with a \| pipe and <a href="\/flux\/ledger" class="wikilink">a link<\/a>\.<\/p>/);
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
  assert.match(html, /<img src="\/flux\/_assets\/pic\.png" alt="Diagram">/);
});

test("`=WxH` sets width only when height is omitted", () => {
  const html = render("![Diagram](_assets/pic.png =600x)");
  assert.match(html, /src="\/flux\/_assets\/pic\.png"/); // asset rewrite still applies
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

/** A `flux:note` comment as it appears on disk, with the given text. */
const noteComment = (id: string, text: string, quote?: string) =>
  ["<!-- flux:note id=" + id + " kind=task", ...(quote ? ["> " + quote, ""] : []), text, "-->"].join(
    "\n"
  );

test("a flux:note comment renders nothing, not escaped text", () => {
  const html = render(noteComment("aaa", "Fix this.", "the phrase") + "\nAnnotated paragraph.\n");
  assert.doesNotMatch(html, /flux:note/);
  assert.doesNotMatch(html, /&lt;!--/);
  assert.doesNotMatch(html, /Fix this\./);
  assert.match(html, /Annotated paragraph\./);
});

test("the block below a note carries its id, and every top-level block is anchored", () => {
  const html = render("# Title\n\n" + noteComment("aaa", "Fix this.") + "\nAnnotated paragraph.\n");
  // The heading also carries its section id and copy affordance; what matters
  // here is that the source anchors survive alongside them.
  assert.match(html, /<h1 data-src-line="0" data-src-hash="[0-9a-f]{8}" id="title">Title</);
  assert.match(html, /<p data-src-line="\d+" data-src-hash="[0-9a-f]{8}" data-flux-notes="aaa">/);
});

test("two notes stacked on one block are both listed on it", () => {
  const html = render(
    noteComment("aaa", "First.") + "\n" + noteComment("bbb", "Second.") + "\nParagraph.\n"
  );
  assert.match(html, /data-flux-notes="aaa bbb"/);
});

test("a note whose text contains --- is not parsed as a setext heading", () => {
  // `lheading` looks for an underline before consulting terminator rules, so
  // this only works because the note rule is registered first in the chain.
  const html = render(noteComment("aaa", "Before\n---\nAfter") + "\nParagraph.\n");
  assert.doesNotMatch(html, /<h2/);
  assert.doesNotMatch(html, /flux:note/);
  assert.match(html, /<p data-src-line="\d+"[^>]*data-flux-notes="aaa">Paragraph\.<\/p>/);
});

test("an unterminated note comment renders as text instead of eating the page", () => {
  const html = render("<!-- flux:note id=aaa kind=task\nnever closed\n\nReal content.\n");
  assert.match(html, /&lt;!-- flux:note/);
  assert.match(html, /Real content\./);
});

test("an ordinary HTML comment still renders escaped, unchanged", () => {
  const html = render("<!-- just a comment -->\n\nParagraph.\n");
  assert.match(html, /&lt;!-- just a comment --&gt;/);
});

test("a note written inside a list annotates the whole list", () => {
  const html = render("- one\n- two\n\n  " + noteComment("aaa", "Fix.").replace(/\n/g, "\n  ") + "\n");
  assert.doesNotMatch(html, /flux:note/);
  assert.match(html, /<ul data-src-line="0"[^>]*data-flux-notes="aaa">/);
});

test("a note between the items of a tight list does not merge them", () => {
  const html = render("- one\n\n  " + noteComment("aaa", "Fix.").replace(/\n/g, "\n  ") + "\n\n  two\n");
  assert.doesNotMatch(html, /onetwo/);
});

test("code fences carry the anchor on the <pre>, not the inner <code>", () => {
  const html = render(noteComment("aaa", "Wrong flag.") + "\n```sh\nls -a\n```\n");
  assert.match(html, /<pre data-src-line="\d+" data-src-hash="[0-9a-f]{8}" data-flux-notes="aaa">/);
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
    /<a class="section-link" href="#rate-limits" data-copy-slug="flux\/page#rate-limits" data-copy-label="Section link"/
  );
});

test("a non-ASCII anchor is percent-encoded in href but readable in what is copied", () => {
  const html = render("## 一句话\n");
  assert.match(html, /href="#%E4%B8%80%E5%8F%A5%E8%AF%9D"/);
  assert.match(html, /data-copy-slug="flux\/page#一句话"/);
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
    (slug) => (slug === "flux/ledger" ? "Ledger" : undefined),
    "flux/page"
  );
  const html = md.render("See [[flux/ledger#retention]].");
  assert.match(html, /<a href="\/flux\/ledger#retention" class="wikilink">Ledger<\/a>/);
});

test("[[id:<id>#section]] resolves the id and keeps the fragment", () => {
  const md = createRenderer(
    (slug) => (slug === "flux/moved-here" ? "Moved Page" : undefined),
    "flux/page",
    (id) => (id === "abc123" ? "flux/moved-here" : undefined)
  );
  const html = md.render("See [[id:abc123#retention|the rules]].");
  assert.match(html, /<a href="\/flux\/moved-here#retention" class="wikilink">the rules<\/a>/);
});

test("an unknown id with a fragment still renders as visibly broken", () => {
  const md = createRenderer(() => undefined, "flux/page", () => undefined);
  const html = md.render("See [[id:nope#retention]].");
  assert.match(html, /class="wikilink broken"/);
  assert.match(html, /href="\/id:nope#retention"/);
});

test("a fragment on a bare wiki-link does not become part of the page name", () => {
  const md = createRenderer(
    (slug) => (slug === "flux/ledger" ? "Ledger" : undefined),
    "flux/page"
  );
  const html = md.render("See [[ledger#retention]].");
  assert.match(html, /href="\/flux\/ledger#retention"/);
});

test("a non-ASCII fragment is encoded in the href", () => {
  const md = createRenderer(
    (slug) => (slug === "flux/ledger" ? "Ledger" : undefined),
    "flux/page"
  );
  assert.match(
    md.render("[[flux/ledger#一句话]]"),
    /href="\/flux\/ledger#%E4%B8%80%E5%8F%A5%E8%AF%9D"/
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
  // precedes layout()'s own <div id="flux-notes">.
  assert.match(render("## Flux notes\n"), /<h2[^>]* id="flux-notes-2">/);
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
  createRenderer(() => undefined, "flux/page").render(body, env);
  assert.deepEqual(env.fluxSections, extractSections(body));
});
