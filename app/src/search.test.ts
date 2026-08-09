import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Content } from "./content.js";
import { excerptFor, normalizeText, scorePage, searchPages, searchTokens } from "./search.js";
import { makeTempKb, type TempKb } from "./test-helpers.js";

function page(fields: {
  slug?: string;
  title?: string;
  body?: string;
  tags?: string[];
  summary?: string;
}) {
  return {
    slug: fields.slug ?? "space/page",
    fsPath: "/tmp/space/page.md",
    body: fields.body ?? "",
    data: {
      title: fields.title ?? "Page",
      tags: fields.tags,
      summary: fields.summary,
    },
  };
}

test("normalizeText lowercases and collapses whitespace runs", () => {
  assert.equal(normalizeText("  Deploy\n\tThe   App "), "deploy the app");
});

test("searchTokens splits on whitespace and drops empties", () => {
  assert.deepEqual(searchTokens("  Deploy   Runbook "), ["deploy", "runbook"]);
  assert.deepEqual(searchTokens("   "), []);
});

test("scorePage requires every token to match somewhere (AND, not OR)", () => {
  const both = page({ title: "Deploy Runbook", body: "how to ship" });
  const one = page({ title: "Deploy Notes", body: "how to ship" });
  assert.ok(scorePage("deploy runbook", both) > 0);
  assert.equal(scorePage("deploy runbook", one), 0, "a page missing a token must not match");
});

test("scorePage ranks title over slug over summary over tag over body", () => {
  const query = "deploy";
  const title = scorePage(query, page({ title: "Deploy" }));
  const slug = scorePage(query, page({ title: "X", slug: "space/deploy" }));
  const summary = scorePage(query, page({ title: "X", summary: "deploy" }));
  const tag = scorePage(query, page({ title: "X", tags: ["deploy"] }));
  const body = scorePage(query, page({ title: "X", body: "deploy" }));

  // Relative order only — absolute weights are free to be retuned. Note tags
  // rank below summaries despite the higher per-token weight: every field except
  // tags also earns a whole-query bonus.
  assert.ok(title > slug, "title beats slug");
  assert.ok(slug > summary, "slug beats summary");
  assert.ok(summary > tag, "summary beats tag");
  assert.ok(tag > body, "tag beats body");
});

test("scorePage treats regex metacharacters literally", () => {
  const dotted = page({ title: "X", body: "version a.b released" });
  const plain = page({ title: "X", body: "version aXb released" });
  assert.ok(scorePage("a.b", dotted) > 0);
  assert.equal(scorePage("a.b", plain), 0, "the dot must not act as a wildcard");
  // Characters that would throw inside a RegExp are inert here.
  assert.equal(scorePage("c++", page({ title: "X", body: "written in c++" })) > 0, true);
  assert.equal(scorePage("(x", page({ title: "X", body: "call (x)" })) > 0, true);
});

test("excerptFor windows the body around the query even when a summary exists", () => {
  const body = `${"filler ".repeat(40)}the deploy script runs here${" trailing".repeat(40)}`;
  const excerpt = excerptFor("deploy", body, "A short summary");

  assert.match(excerpt, /deploy/, "the matched term must appear in the excerpt");
  assert.doesNotMatch(excerpt, /A short summary/, "the summary must not shadow the match");
  assert.match(excerpt, /^\.\.\./, "a window taken from mid-body is prefixed");
  assert.match(excerpt, /\.\.\.$/, "a truncated tail is suffixed");
});

test("excerptFor falls back to the summary when the query only hit metadata", () => {
  // The query matched the title/tags, so there is nothing to centre on in the body.
  assert.equal(excerptFor("deploy", "unrelated prose", "A short summary"), "A short summary");
  // With no summary either, it opens at the top of the body and is not prefixed.
  assert.equal(excerptFor("deploy", "unrelated prose"), "unrelated prose");
  assert.equal(excerptFor("deploy", ""), "");
});

test("excerptFor collapses newlines and stays within the window", () => {
  const excerpt = excerptFor("deploy", `line one\n\nthe deploy step\n\n${"x".repeat(500)}`);
  assert.doesNotMatch(excerpt, /\n/);
  assert.ok(excerpt.length <= 226, `expected a clamped excerpt, got ${excerpt.length}`);
});

/** A space plus a couple of pages, enough to exercise scoping and filters. */
async function seed(dir: string): Promise<Content> {
  const content = new Content(dir);
  await content.createSpace("Docs");
  await content.createSpace("Other");
  return content;
}

test("searchPages matches body text, not just titles", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = await seed(kb.dir);
    await content.createPage("docs", "Unrelated Title", "the deploy script lives here");

    const hits = await searchPages(content, "deploy", { space: "docs" });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].title, "Unrelated Title");
    assert.match(hits[0].excerpt, /deploy/);
  } finally {
    await kb.cleanup();
  }
});

test("searchPages scoped to a space excludes other spaces", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = await seed(kb.dir);
    await content.createPage("docs", "Deploy Here", "body");
    await content.createPage("other", "Deploy There", "body");

    const scoped = await searchPages(content, "deploy", { space: "docs" });
    assert.deepEqual(
      scoped.map((h) => h.slug),
      ["docs/deploy-here"]
    );

    const unscoped = await searchPages(content, "deploy", { limit: 50 });
    assert.equal(unscoped.length, 2, "an unscoped search still spans both spaces");
  } finally {
    await kb.cleanup();
  }
});

test("searchPages scoped to a space can find the space's own landing page", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = await seed(kb.dir);

    // Content.spaceTree omits the space home, so this is the case that would
    // otherwise be unreachable from the sidebar box.
    const hits = await searchPages(content, "docs", { space: "docs" });
    assert.ok(
      hits.some((h) => h.slug === "docs"),
      "the space landing page should be searchable within its own space"
    );
  } finally {
    await kb.cleanup();
  }
});

test("searchPages skips folders even when their title matches", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = await seed(kb.dir);
    await content.createFolder("docs", "Deploy");

    const hits = await searchPages(content, "deploy", { space: "docs" });
    assert.deepEqual(hits, [], "a folder is a pure container with nothing to match");
  } finally {
    await kb.cleanup();
  }
});

test("searchPages honours the archive filter", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = await seed(kb.dir);
    const created = await content.createPage("docs", "Deploy Runbook", "body");
    await content.updateArchive(created.slug, true);

    assert.deepEqual(await searchPages(content, "deploy runbook", { space: "docs" }), []);

    const all = await searchPages(content, "deploy runbook", { space: "docs", filter: "all" });
    assert.deepEqual(
      all.map((h) => h.slug),
      ["docs/deploy-runbook"]
    );
    assert.equal(all[0].archived, true);
  } finally {
    await kb.cleanup();
  }
});

test("searchPages sorts by score then title, and honours limit", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = await seed(kb.dir);
    await content.createPage("docs", "Deploy Runbook", "no match in body");
    // Same scoring shape as the page above, so the tie breaks on title.
    await content.createPage("docs", "Deploy Guide", "no match in body");
    await content.createPage("docs", "Notes", "mentions deploy once");

    const hits = await searchPages(content, "deploy", { space: "docs", limit: 50 });
    assert.deepEqual(
      hits.map((h) => h.title),
      ["Deploy Guide", "Deploy Runbook", "Notes"],
      "title hits outrank the body-only hit, and the tie sorts by title"
    );

    const capped = await searchPages(content, "deploy", { space: "docs", limit: 2 });
    assert.equal(capped.length, 2);
  } finally {
    await kb.cleanup();
  }
});

test("searchPages survives a page with invalid frontmatter", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = await seed(kb.dir);
    await content.createPage("docs", "Deploy Runbook", "body");
    // No title: parsePage throws for this file, and the walk must not take the
    // whole search down with it.
    await fs.writeFile(
      path.join(kb.dir, "docs", "broken.md"),
      "---\ntags: [x]\n---\n\ndeploy\n",
      "utf8"
    );

    const hits = await searchPages(content, "deploy", { space: "docs", limit: 50 });
    assert.ok(hits.some((h) => h.slug === "docs/deploy-runbook"));
    assert.ok(!hits.some((h) => h.slug === "docs/broken"));
  } finally {
    await kb.cleanup();
  }
});

test("searchPages returns nothing for a blank query or an unknown space", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = await seed(kb.dir);
    await content.createPage("docs", "Deploy Runbook", "body");

    assert.deepEqual(await searchPages(content, "   ", { space: "docs" }), []);
    assert.deepEqual(await searchPages(content, "deploy", { space: "nope" }), []);
    // spaceKeyOf keeps a traversal attempt from ever reaching the filesystem.
    assert.deepEqual(await searchPages(content, "deploy", { space: "../etc" }), []);
  } finally {
    await kb.cleanup();
  }
});

test("inline notes are not searchable and never leak into an excerpt", async () => {
  const kb: TempKb = await makeTempKb();
  try {
    const content = await seed(kb.dir);
    await content.createPage(
      "docs",
      "Deploy",
      "<!-- flux:note id=aaa kind=task\n> the queue\n\nMention zookeeper here.\n-->\nWatch the queue drain."
    );

    // A word that appears only inside the note must not match the page.
    assert.deepEqual(await searchPages(content, "zookeeper", { space: "docs" }), []);

    // ...and the excerpt for a real hit shows prose, not comment syntax.
    const hits = await searchPages(content, "queue", { space: "docs" });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].excerpt, "Watch the queue drain.");
    assert.doesNotMatch(hits[0].excerpt, /flux:note|-->/);
  } finally {
    await kb.cleanup();
  }
});
