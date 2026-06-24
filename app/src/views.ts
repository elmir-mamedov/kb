import type { PageNode } from "./content.js";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderTree(nodes: PageNode[], activeSlug: string): string {
  if (nodes.length === 0) return "";
  const items = nodes
    .map((n) => {
      const isActive = n.slug === activeSlug;
      const cls = isActive ? ' class="active"' : "";
      const children = n.children.length
        ? `<div class="children">${renderTree(n.children, activeSlug)}</div>`
        : "";
      return `<li><a href="/${n.slug}"${cls}>${escapeHtml(n.title)}</a>${children}</li>`;
    })
    .join("");
  return `<ul>${items}</ul>`;
}

function breadcrumb(slug: string, titles: Map<string, string>): string {
  if (!slug) return "";
  const parts = slug.split("/");
  const crumbs: string[] = [];
  let acc = "";
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    const title = titles.get(acc) ?? part;
    crumbs.push(`<a href="/${acc}">${escapeHtml(title)}</a>`);
  }
  return `<nav class="crumbs"><a href="/">Home</a> ${crumbs
    .map((c) => `<span class="sep">/</span> ${c}`)
    .join(" ")}</nav>`;
}

export interface PageView {
  siteTitle: string;
  tree: PageNode[];
  activeSlug: string;
  titles: Map<string, string>;
  title: string;
  tags?: string[];
  contentHtml: string;
  updated?: string | null;
}

export function layout(v: PageView): string {
  const tags = (v.tags ?? [])
    .map((t) => `<span class="tag">${escapeHtml(t)}</span>`)
    .join("");
  const updated = v.updated
    ? `<div class="updated">Updated ${escapeHtml(v.updated)}</div>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(v.title)} · ${escapeHtml(v.siteTitle)}</title>
<style>${STYLES}</style>
</head>
<body>
<aside class="sidebar">
  <a class="brand" href="/">${escapeHtml(v.siteTitle)}</a>
  <nav class="tree">${renderTree(v.tree, v.activeSlug)}</nav>
</aside>
<main class="content">
  ${breadcrumb(v.activeSlug, v.titles)}
  <header class="page-head">
    <h1>${escapeHtml(v.title)}</h1>
    <div class="meta">${tags}${updated}</div>
  </header>
  <article class="prose">${v.contentHtml}</article>
</main>
</body>
</html>`;
}

export function notFound(siteTitle: string, slug: string, tree: PageNode[]): string {
  return layout({
    siteTitle,
    tree,
    activeSlug: "",
    titles: new Map(),
    title: "Not found",
    contentHtml: `<p>No page exists at <code>/${escapeHtml(slug)}</code>.</p>`,
  });
}

const STYLES = `
:root{
  --bg:#fff; --fg:#1f2328; --muted:#6b7280; --line:#e5e7eb;
  --accent:#2563eb; --sidebar:#f7f8fa; --code-bg:#f6f8fa;
  --maxw:760px;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  color:var(--fg); background:var(--bg); display:flex; min-height:100vh;
}
a{color:var(--accent); text-decoration:none}
a:hover{text-decoration:underline}
.sidebar{
  width:260px; flex:0 0 260px; background:var(--sidebar);
  border-right:1px solid var(--line); padding:20px 16px; position:sticky; top:0;
  height:100vh; overflow:auto;
}
.brand{display:block; font-weight:700; font-size:15px; color:var(--fg);
  margin-bottom:16px; letter-spacing:.2px}
.brand:hover{text-decoration:none}
.tree ul{list-style:none; margin:0; padding:0}
.tree .children{margin-left:12px; border-left:1px solid var(--line); padding-left:8px}
.tree a{display:block; padding:3px 6px; border-radius:6px; color:#374151; font-size:14px}
.tree a:hover{background:#eef0f3; text-decoration:none}
.tree a.active{background:#e7efff; color:var(--accent); font-weight:600}
.content{flex:1; padding:32px 40px; max-width:calc(var(--maxw) + 80px); width:100%}
.crumbs{color:var(--muted); font-size:13px; margin-bottom:18px}
.crumbs .sep{color:var(--line); margin:0 2px}
.page-head h1{font-size:30px; line-height:1.2; margin:0 0 8px}
.meta{display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:24px}
.tag{background:#eef0f3; color:#374151; font-size:12px; padding:2px 8px; border-radius:999px}
.updated{color:var(--muted); font-size:12px; margin-left:auto}
.prose{max-width:var(--maxw)}
.prose h1,.prose h2,.prose h3{line-height:1.25; margin-top:1.6em}
.prose h2{font-size:22px; border-bottom:1px solid var(--line); padding-bottom:.2em}
.prose h3{font-size:18px}
.prose p,.prose ul,.prose ol{margin:.7em 0}
.prose code{background:var(--code-bg); padding:.15em .35em; border-radius:4px;
  font-size:.88em; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.prose pre{background:var(--code-bg); padding:14px 16px; border-radius:8px;
  overflow:auto; border:1px solid var(--line)}
.prose pre code{background:none; padding:0}
.prose blockquote{margin:1em 0; padding:.4em 1em; color:var(--muted);
  border-left:3px solid var(--line)}
.prose table{border-collapse:collapse; width:100%}
.prose th,.prose td{border:1px solid var(--line); padding:6px 10px; text-align:left}
.prose img{max-width:100%}
.wikilink{border-bottom:1px dotted var(--accent)}
/* compact highlight.js theme (github-ish) */
.hljs-comment,.hljs-quote{color:#6a737d}
.hljs-keyword,.hljs-selector-tag,.hljs-literal{color:#d73a49}
.hljs-string,.hljs-doctag,.hljs-regexp{color:#032f62}
.hljs-number,.hljs-built_in{color:#005cc5}
.hljs-title,.hljs-section,.hljs-name{color:#6f42c1}
.hljs-attr,.hljs-attribute,.hljs-variable{color:#e36209}
@media(max-width:780px){
  body{flex-direction:column}
  .sidebar{width:auto; flex:none; height:auto; position:static; border-right:none;
    border-bottom:1px solid var(--line)}
  .content{padding:20px}
}
`;
