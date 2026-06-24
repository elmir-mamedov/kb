import MarkdownIt from "markdown-it";
import hljs from "highlight.js";

/**
 * Create a markdown renderer.
 * @param resolveTitle maps a slug to a page title, so [[wiki-links]] can show
 *                     the target page's real title.
 */
export function createRenderer(resolveTitle: (slug: string) => string | undefined): MarkdownIt {
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
      const slug = (rawTarget || "").trim().replace(/^\/+/, "");
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
