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
 * Create a markdown renderer.
 * @param resolveTitle maps a slug to a page title, so [[wiki-links]] can show
 *                     the target page's real title. A slug that maps to a
 *                     title is also treated as an existing page.
 * @param currentSlug  the slug of the page being rendered, used to resolve
 *                     relative [[wiki-link]] targets within the same space.
 */
export function createRenderer(
  resolveTitle: (slug: string) => string | undefined,
  currentSlug = ""
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
      const slug = resolveWikiTarget(
        rawTarget || "",
        currentSlug,
        (s) => resolveTitle(s) !== undefined
      );
      const text =
        (rawLabel && rawLabel.trim()) ||
        resolveTitle(slug) ||
        slug.split("/").pop() ||
        slug;

      const open = state.push("link_open", "a", 1);
      open.attrSet("href", "/" + slug);
      open.attrSet("class", "wikilink");
      const t = state.push("text", "", 0);
      t.content = text;
      state.push("link_close", "a", -1);
    }

    state.pos = end + 2;
    return true;
  });

  return md;
}
