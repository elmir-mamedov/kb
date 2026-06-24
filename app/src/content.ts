import { promises as fs } from "node:fs";
import path from "node:path";
import { parsePage, type Frontmatter } from "./frontmatter.js";

export interface PageNode {
  /** URL path with no leading slash, e.g. "engineering/runbooks/deploy". */
  slug: string;
  title: string;
  /** Absolute path to the backing .md file (index.md for sections). */
  fsPath: string;
  /** True when backed by a folder + index.md. */
  isSection: boolean;
  children: PageNode[];
}

export interface LoadedPage {
  slug: string;
  data: Frontmatter;
  body: string;
  fsPath: string;
}

/**
 * The content layer. Everything reads from a single folder of markdown files —
 * the same folder the MCP server will write to in a later step.
 */
export class Content {
  constructor(private root: string) {
    this.root = path.resolve(root);
  }

  /** Build the navigation tree by walking the folder. */
  async tree(): Promise<PageNode[]> {
    return this.walk(this.root, "");
  }

  private async walk(dir: string, baseSlug: string): Promise<PageNode[]> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const nodes: PageNode[] = [];

    for (const entry of entries) {
      const name = entry.name;
      // Skip dotfiles, _assets and other underscore-prefixed helpers.
      if (name.startsWith(".") || name.startsWith("_")) continue;

      if (entry.isDirectory()) {
        const dirPath = path.join(dir, name);
        const indexPath = path.join(dirPath, "index.md");
        const slug = baseSlug ? `${baseSlug}/${name}` : name;
        let title = name;
        let backing = dirPath;
        try {
          const raw = await fs.readFile(indexPath, "utf8");
          title = parsePage(raw, indexPath).data.title;
          backing = indexPath;
        } catch {
          /* no/invalid index.md — still a navigable container */
        }
        const children = await this.walk(dirPath, slug);
        nodes.push({ slug, title, fsPath: backing, isSection: true, children });
      } else if (entry.isFile() && name.endsWith(".md") && name !== "index.md") {
        const base = name.slice(0, -3);
        const slug = baseSlug ? `${baseSlug}/${base}` : base;
        const fsPath = path.join(dir, name);
        let title = base;
        try {
          const raw = await fs.readFile(fsPath, "utf8");
          title = parsePage(raw, fsPath).data.title;
        } catch {
          /* fall back to filename */
        }
        nodes.push({ slug, title, fsPath, isSection: false, children: [] });
      }
    }

    nodes.sort((a, b) => a.title.localeCompare(b.title));
    return nodes;
  }

  /** Resolve a URL slug to a file path (folder+index.md aware), or null. */
  async resolve(slug: string): Promise<string | null> {
    const clean = slug.replace(/^\/+|\/+$/g, "");

    if (clean === "") {
      const rootIndex = path.join(this.root, "index.md");
      return (await exists(rootIndex)) ? rootIndex : null;
    }

    // Guard against path traversal (e.g. "../secrets").
    const candidateDir = path.resolve(this.root, clean);
    if (candidateDir !== this.root && !candidateDir.startsWith(this.root + path.sep)) {
      return null;
    }

    const asFile = path.join(this.root, `${clean}.md`);
    if (await exists(asFile)) return asFile;

    const asIndex = path.join(this.root, clean, "index.md");
    if (await exists(asIndex)) return asIndex;

    return null;
  }

  /** Load and parse a page by slug. */
  async load(slug: string): Promise<LoadedPage | null> {
    const fsPath = await this.resolve(slug);
    if (!fsPath) return null;
    const raw = await fs.readFile(fsPath, "utf8");
    const { data, body } = parsePage(raw, fsPath);
    return { slug: slug.replace(/^\/+|\/+$/g, ""), data, body, fsPath };
  }

  /** Flat slug -> title map, used to resolve wiki-link labels. */
  async titleIndex(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const collect = (nodes: PageNode[]) => {
      for (const n of nodes) {
        map.set(n.slug, n.title);
        collect(n.children);
      }
    };
    collect(await this.tree());
    return map;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
