import { test } from "node:test";
import assert from "node:assert/strict";
import { createRenderer } from "./markdown.js";

/** Render Markdown with a renderer scoped to a representative page slug. */
const render = (src: string) =>
  createRenderer(() => undefined, "flux/page").render(src);

test("```mermaid fences render as a Mermaid container, not a code block", () => {
  const html = render("```mermaid\nflowchart LR\n  a --> b\n```\n");
  // Emitted as a container the client-side Mermaid library picks up.
  assert.match(html, /<pre class="mermaid">/);
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
