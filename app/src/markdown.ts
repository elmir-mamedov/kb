import MarkdownIt from "markdown-it";
import hljs from "highlight.js";

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
    if (lang === "mermaid") {
      // Mermaid reads the element's textContent, so escape for valid HTML; the
      // browser decodes it back to the raw diagram source before Mermaid runs.
      return `<pre class="mermaid">${md.utils.escapeHtml(token.content)}</pre>\n`;
    }
    return defaultFence(tokens, idx, options, env, self);
  };

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
      const inner = state.src.slice(start + 2, end);
      const [rawTarget, rawLabel] = inner.split("|");
      const label = rawLabel?.trim();
      const target = (rawTarget || "").trim();
      const idMatch = /^id:(.+)$/.exec(target);

      if (idMatch) {
        // `[[id:<id>]]` / `[[id:<id>|Label]]` — resolve the stable id to the
        // page's current slug so the link survives moves/renames. An unknown id
        // renders a visibly-broken, non-crashing link rather than throwing.
        const id = idMatch[1].trim();
        const slug = resolveIdSlug(id);
        const open = state.push("link_open", "a", 1);
        if (slug !== undefined) {
          open.attrSet("href", "/" + slug);
          open.attrSet("class", "wikilink");
          const t = state.push("text", "", 0);
          t.content = label || resolveTitle(slug) || slug.split("/").pop() || slug;
        } else {
          open.attrSet("href", "/id:" + id);
          open.attrSet("class", "wikilink broken");
          const t = state.push("text", "", 0);
          t.content = label || id;
        }
        state.push("link_close", "a", -1);
      } else {
        const slug = resolveWikiTarget(
          rawTarget || "",
          currentSlug,
          (s) => resolveTitle(s) !== undefined
        );
        const text = label || resolveTitle(slug) || slug.split("/").pop() || slug;

        const open = state.push("link_open", "a", 1);
        open.attrSet("href", "/" + slug);
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
