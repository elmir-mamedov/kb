import { promises as fs } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { parsePage, type Frontmatter } from "./frontmatter.js";

export type TreeFilter = "live" | "archived" | "all";

export interface PageNode {
  /** URL path with no leading slash, e.g. "engineering/runbooks/deploy". */
  slug: string;
  title: string;
  /** Absolute path to the backing .md file (index.md for sections). */
  fsPath: string;
  /** True when backed by a folder + index.md. */
  isSection: boolean;
  /**
   * True when this is a pure container (index.md carries `type: folder`).
   * A folder is always also a section (`isFolder ⇒ isSection`); the reverse is
   * not true — an ordinary content page can have children and still be a
   * section. Only folders show the folder icon and render as a contents listing.
   */
  isFolder: boolean;
  /** True when the backing page has archived: true in frontmatter. */
  archived: boolean;
  archivedAt?: string;
  /**
   * Last-modified time (ms since epoch) of the backing file. For sections it is
   * the most recent mtime across the whole subtree, so an area with recent
   * activity bubbles up. Drives "recently modified" sibling ordering.
   */
  modifiedMs: number;
  children: PageNode[];
}

export interface SpaceInfo {
  /** Top-level directory name; also the first segment of every page slug within. */
  key: string;
  title: string;
  summary?: string;
  icon?: string;
  archived: boolean;
}

export interface LoadedPage {
  slug: string;
  data: Frontmatter;
  body: string;
  fsPath: string;
}

export interface RawPage {
  slug: string;
  raw: string;
  fsPath: string;
}

export interface ArchiveMutation {
  slug: string;
  fsPath: string;
  isSection: boolean;
  changedFsPaths: string[];
}

export interface CreatePageMutation {
  slug: string;
  fsPath: string;
  /** When a leaf parent was promoted to a section, the paths the commit must cover. */
  changedFsPaths?: string[];
}

/** A pending leaf→section promotion: move `from` (foo.md) to `to` (foo/index.md). */
interface LeafPromotion {
  from: string;
  to: string;
  dir: string;
}

export interface DeletePreview {
  slug: string;
  title: string;
  fsPath: string;
  isSection: boolean;
  affectedFsPaths: string[];
}

export interface DeleteMutation extends DeletePreview {
  deletedFsPaths: string[];
}

export interface MoveMutation {
  oldSlug: string;
  newSlug: string;
  changedFsPaths: string[];
}

export interface BatchMoveMutation {
  /** Sources that moved, in the order they were processed. */
  moves: MoveMutation[];
  /** Sources that could not be moved, with the reason. */
  failures: { slug: string; error: string }[];
  /** Union of every filesystem path touched across all moves, deduped. */
  changedFsPaths: string[];
}

export interface RenameSpaceMutation {
  key: string;
  fsPath: string;
  /** The space's index.md when its title changed; empty when the name was unchanged. */
  changedFsPaths: string[];
}

export interface DeleteSpaceMutation {
  key: string;
  title: string;
  /** Absolute path of the removed space directory (its whole per-space repo). */
  dir: string;
}

/**
 * The content layer. Everything reads from a single folder of markdown files —
 * the same folder the MCP server will write to in a later step.
 */
export class Content {
  /**
   * Read+parse cache keyed by absolute file path and invalidated whenever the
   * file's mtime changes. The navigation walk and per-page loads share it, so
   * each file is read and parsed at most once per modification instead of once
   * per caller — search previously read every page twice (once to build the
   * tree, once to score it).
   */
  private parseCache = new Map<
    string,
    { data: Frontmatter; body: string; mtimeMs: number }
  >();

  constructor(private root: string) {
    this.root = path.resolve(root);
  }

  /** Build the navigation tree by walking the folder. */
  async tree(filter: TreeFilter = "live"): Promise<PageNode[]> {
    return this.walk(this.root, "", filter);
  }

  /** The space a slug belongs to: its first path segment ("" for the root). */
  spaceKeyOf(slug: string): string {
    return cleanSlug(slug).split("/")[0] ?? "";
  }

  /** List spaces — the top-level directories, each described by its index.md. */
  async spaces(filter: TreeFilter = "live"): Promise<SpaceInfo[]> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(this.root, { withFileTypes: true });
    } catch {
      return [];
    }

    const spaces: SpaceInfo[] = [];
    for (const entry of entries) {
      const name = entry.name;
      if (!entry.isDirectory()) continue;
      if (name.startsWith(".") || name.startsWith("_")) continue;

      let title = name;
      let summary: string | undefined;
      let icon: string | undefined;
      let archived = false;
      try {
        const raw = await fs.readFile(path.join(this.root, name, "index.md"), "utf8");
        const data = parsePage(raw, name).data;
        title = data.title;
        summary = data.summary;
        icon = data.icon;
        archived = data.archived === true;
      } catch {
        /* folder without a valid index.md — still a navigable space */
      }

      if (filter === "live" && archived) continue;
      if (filter === "archived" && !archived) continue;
      spaces.push({ key: name, title, summary, icon, archived });
    }

    spaces.sort((a, b) => a.title.localeCompare(b.title));
    return spaces;
  }

  /** The navigation subtree for a single space (its pages, minus the space home). */
  async spaceTree(spaceKey: string, filter: TreeFilter = "live"): Promise<PageNode[]> {
    const key = this.spaceKeyOf(spaceKey);
    if (!key) return [];
    const top = await this.tree(filter);
    return top.find((n) => n.slug === key)?.children ?? [];
  }

  private async walk(dir: string, baseSlug: string, filter: TreeFilter): Promise<PageNode[]> {
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
        let archived = false;
        let archivedAt: string | undefined;
        let ownMtime: number | undefined;
        let isFolder = false;
        try {
          const parsed = await this.readParsed(indexPath);
          if (parsed) {
            title = parsed.data.title;
            archived = parsed.data.archived === true;
            archivedAt = parsed.data.archivedAt;
            backing = indexPath;
            ownMtime = parsed.mtimeMs;
            isFolder = isFolderPage(parsed.data);
          }
        } catch {
          /* no/invalid index.md — still a navigable container */
        }
        const children = await this.walk(dirPath, slug, filter);
        // A section's modified time is the most recent change to its own index
        // or any descendant, so recently-touched branches sort to the top.
        const modifiedMs = children.reduce(
          (max, child) => Math.max(max, child.modifiedMs),
          ownMtime ?? (await mtimeMs(backing))
        );
        if (this.includeNode(filter, archived, children.length)) {
          nodes.push({
            slug,
            title,
            fsPath: backing,
            isSection: true,
            isFolder,
            archived,
            archivedAt,
            modifiedMs,
            children,
          });
        }
      } else if (entry.isFile() && name.endsWith(".md") && name !== "index.md") {
        const base = name.slice(0, -3);
        const slug = baseSlug ? `${baseSlug}/${base}` : base;
        const fsPath = path.join(dir, name);
        let title = base;
        let archived = false;
        let archivedAt: string | undefined;
        let ownMtime: number | undefined;
        try {
          const parsed = await this.readParsed(fsPath);
          if (parsed) {
            title = parsed.data.title;
            archived = parsed.data.archived === true;
            archivedAt = parsed.data.archivedAt;
            ownMtime = parsed.mtimeMs;
          }
        } catch {
          /* fall back to filename */
        }
        const modifiedMs = ownMtime ?? (await mtimeMs(fsPath));
        if (this.includeNode(filter, archived, 0)) {
          nodes.push({ slug, title, fsPath, isSection: false, isFolder: false, archived, archivedAt, modifiedMs, children: [] });
        }
      }
    }

    // Most-recently-modified first, falling back to title for a stable order
    // when timestamps tie (e.g. a fresh checkout where mtimes are uniform).
    nodes.sort(
      (a, b) => b.modifiedMs - a.modifiedMs || a.title.localeCompare(b.title)
    );
    return nodes;
  }

  private includeNode(filter: TreeFilter, archived: boolean, childCount: number): boolean {
    if (filter === "all") return true;
    if (filter === "live") return !archived;
    return archived || childCount > 0;
  }

  /** Resolve a URL slug to a file path (folder+index.md aware), or null. */
  async resolve(slug: string): Promise<string | null> {
    const clean = cleanSlug(slug);

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

  /**
   * Read + parse a markdown file, memoized by mtime. Returns null when the
   * file can't be stat'd or read; propagates parsePage errors (invalid
   * frontmatter) so callers can surface them — the navigation walk wraps this
   * in try/catch to fall back to the filename instead.
   */
  private async readParsed(
    fsPath: string
  ): Promise<{ data: Frontmatter; body: string; mtimeMs: number } | null> {
    let mtimeMs: number;
    try {
      mtimeMs = (await fs.stat(fsPath)).mtimeMs;
    } catch {
      return null;
    }

    const cached = this.parseCache.get(fsPath);
    if (cached && cached.mtimeMs === mtimeMs) return cached;

    let raw: string;
    try {
      raw = await fs.readFile(fsPath, "utf8");
    } catch {
      return null;
    }

    const { data, body } = parsePage(raw, fsPath);
    const entry = { data, body, mtimeMs };
    this.parseCache.set(fsPath, entry);
    return entry;
  }

  /** Load and parse a page by slug. */
  async load(slug: string): Promise<LoadedPage | null> {
    const fsPath = await this.resolve(slug);
    if (!fsPath) return null;
    const parsed = await this.readParsed(fsPath);
    if (!parsed) return null;
    return { slug: cleanSlug(slug), data: parsed.data, body: parsed.body, fsPath };
  }

  /** Load the original markdown document, including frontmatter. */
  async loadRaw(slug: string): Promise<RawPage | null> {
    const fsPath = await this.resolve(slug);
    if (!fsPath) return null;
    const raw = await fs.readFile(fsPath, "utf8");
    return { slug: cleanSlug(slug), raw, fsPath };
  }

  /** Validate and replace the original markdown document for an existing page. */
  async updateRaw(slug: string, raw: string): Promise<RawPage | null> {
    const fsPath = await this.resolve(slug);
    if (!fsPath) return null;

    // Folders are pure containers with no editable body. Check the *on-disk*
    // frontmatter (not the incoming raw) so a caller can't strip the
    // `type: folder` marker to sneak a body onto a folder.
    const current = await this.readParsed(fsPath);
    if (current && isFolderPage(current.data)) {
      throw new Error("Folders have no editable body. Rename or move it instead.");
    }

    parsePage(raw, fsPath);

    // Browsers submit <textarea> content with CRLF newlines, so normalise to LF
    // (the repo convention) before comparing and writing. A save that changes
    // nothing must stay a true no-op: no rewrite, no spurious "updated" commit.
    const next = normalizeEol(raw);
    const existing = await fs.readFile(fsPath, "utf8");
    if (normalizeEol(existing) === next) {
      return { slug: cleanSlug(slug), raw: existing, fsPath };
    }

    await fs.writeFile(fsPath, next, "utf8");
    return { slug: cleanSlug(slug), raw: next, fsPath };
  }

  /** Create a root-level draft page with a unique slug. */
  /** Create an untitled draft page inside a space/section (or root when parent is ""). */
  async createDraft(parentSlug = ""): Promise<CreatePageMutation> {
    const cleanParent = cleanSlug(parentSlug);
    if (!cleanParent) {
      throw new Error("Pages must live inside a space.");
    }
    let parentDir = this.root;
    let parentPrefix = "";
    let promotion: LeafPromotion | null = null;

    if (cleanParent) {
      const parentFsPath = await this.resolve(cleanParent);
      if (!parentFsPath) {
        throw new Error("The destination space or section does not exist.");
      }
      const resolved = await this.sectionDirFor(parentFsPath);
      parentDir = resolved.dir;
      promotion = resolved.conversion;
      parentPrefix = cleanParent;
    }

    const { name, title } = await this.nextUntitledName(parentDir, "page");
    const slug = parentPrefix ? `${parentPrefix}/${name}` : name;
    const fsPath = path.join(parentDir, `${name}.md`);
    const raw = matter.stringify(`# ${title}\n\n`, { title });

    parsePage(raw, fsPath);
    if (promotion) await this.applyPromotion(promotion);
    await fs.writeFile(fsPath, raw, { encoding: "utf8", flag: "wx" });
    return promotion
      ? { slug, fsPath, changedFsPaths: [promotion.from, promotion.to, fsPath] }
      : { slug, fsPath };
  }

  /** Create a finished page from a title and body inside a space/section (or root when parent is ""). */
  async createPage(
    parentSlug: string,
    title: string,
    body = "",
    opts: { tags?: string[]; summary?: string } = {}
  ): Promise<CreatePageMutation> {
    const cleanParent = cleanSlug(parentSlug);
    if (!cleanParent) {
      throw new Error("Pages must live inside a space.");
    }
    let parentDir = this.root;
    let parentPrefix = "";
    let promotion: LeafPromotion | null = null;

    if (cleanParent) {
      const parentFsPath = await this.resolve(cleanParent);
      if (!parentFsPath) {
        throw new Error("The destination space or section does not exist.");
      }
      const resolved = await this.sectionDirFor(parentFsPath);
      parentDir = resolved.dir;
      promotion = resolved.conversion;
      parentPrefix = cleanParent;
    }

    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      throw new Error("A page title is required.");
    }
    const base = slugify(trimmedTitle);
    if (!base) {
      throw new Error("The page title must contain letters or numbers.");
    }

    const name = await this.nextPageName(parentDir, base);
    const slug = parentPrefix ? `${parentPrefix}/${name}` : name;
    const fsPath = path.join(parentDir, `${name}.md`);

    const data: Record<string, unknown> = { title: trimmedTitle };
    if (opts.tags && opts.tags.length > 0) data.tags = opts.tags;
    if (opts.summary) data.summary = opts.summary;
    const content = body.trim() ? `${body.trim()}\n` : `# ${trimmedTitle}\n\n`;
    const raw = matter.stringify(content, data);

    parsePage(raw, fsPath);
    if (promotion) await this.applyPromotion(promotion);
    await fs.writeFile(fsPath, raw, { encoding: "utf8", flag: "wx" });
    return promotion
      ? { slug, fsPath, changedFsPaths: [promotion.from, promotion.to, fsPath] }
      : { slug, fsPath };
  }

  /**
   * Create a folder (a section) inside a space/section. A folder is a directory
   * with an `index.md` landing page; pages or other folders can then be dropped
   * into it. When `title` is omitted an "Untitled Folder" draft is created (the
   * web flow, which then opens the editor to name it); MCP passes a real title.
   * A leaf-page parent is auto-promoted into a section first.
   */
  async createFolder(parentSlug: string, title?: string): Promise<CreatePageMutation> {
    const cleanParent = cleanSlug(parentSlug);
    if (!cleanParent) {
      throw new Error("Folders must live inside a space.");
    }

    const parentFsPath = await this.resolve(cleanParent);
    if (!parentFsPath) {
      throw new Error("The destination space or section does not exist.");
    }
    const { dir: parentDir, conversion: promotion } = await this.sectionDirFor(parentFsPath);

    const trimmed = (title ?? "").trim();
    let folderName: string;
    let folderTitle: string;
    if (trimmed) {
      const base = slugify(trimmed);
      if (!base) {
        throw new Error("The folder title must contain letters or numbers.");
      }
      folderName = await this.nextPageName(parentDir, base);
      folderTitle = trimmed;
    } else {
      const draft = await this.nextUntitledName(parentDir, "folder");
      folderName = draft.name;
      folderTitle = draft.title;
    }

    const folderDir = path.join(parentDir, folderName);
    const indexPath = path.join(folderDir, "index.md");
    // A folder is a pure container: its index.md carries only the display name
    // and the `type: folder` marker, with no body to edit.
    const raw = matter.stringify("", { title: folderTitle, type: "folder" });
    parsePage(raw, indexPath);

    if (promotion) await this.applyPromotion(promotion);
    await fs.mkdir(folderDir, { recursive: true });
    await fs.writeFile(indexPath, raw, { encoding: "utf8", flag: "wx" });

    const slug = `${cleanParent}/${folderName}`;
    return promotion
      ? { slug, fsPath: indexPath, changedFsPaths: [promotion.from, promotion.to, indexPath] }
      : { slug, fsPath: indexPath };
  }

  /**
   * Rename a folder's display name (rewrites only its index.md `title`). The
   * slug and directory are deliberately left untouched — a folder's URL is
   * stable; use movePage to change its location. Returns an empty
   * `changedFsPaths` when the name is unchanged so the caller skips a spurious
   * commit; returns null when the slug does not resolve.
   */
  async renameFolder(
    slug: string,
    name: string
  ): Promise<{ slug: string; fsPath: string; changedFsPaths: string[] } | null> {
    const clean = cleanSlug(slug);
    const fsPath = await this.resolve(clean);
    if (!fsPath) return null;

    const raw = await fs.readFile(fsPath, "utf8");
    const { data } = parsePage(raw, fsPath);
    if (!isFolderPage(data)) {
      throw new Error("Only folders can be renamed this way.");
    }

    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error("The folder name is required.");
    }
    if (data.title === trimmed) {
      return { slug: clean, fsPath, changedFsPaths: [] };
    }

    const parsed = matter(raw);
    const nextData = { ...parsed.data, title: trimmed } as Record<string, unknown>;
    const nextRaw = matter.stringify(parsed.content, nextData);
    parsePage(nextRaw, fsPath);

    await fs.writeFile(fsPath, nextRaw, "utf8");
    return { slug: clean, fsPath, changedFsPaths: [fsPath] };
  }

  /** Create a new space: a top-level folder with an index.md home page. */
  async createSpace(title: string): Promise<CreatePageMutation> {
    const trimmed = title.trim();
    if (!trimmed) {
      throw new Error("A space title is required.");
    }
    const key = slugify(trimmed);
    if (!key) {
      throw new Error("The space title must contain letters or numbers.");
    }

    const dir = path.join(this.root, key);
    const fsPath = path.join(dir, "index.md");
    if ((await exists(dir)) || (await exists(path.join(this.root, `${key}.md`)))) {
      throw new Error(`A space named "${key}" already exists.`);
    }

    const raw = matter.stringify(`# ${trimmed}\n\n`, { title: trimmed });
    parsePage(raw, fsPath);

    // Scaffold the space as a self-contained, ready-to-version folder: its home
    // page, an attachments dir, and a default .gitignore. The caller turns this
    // into a git repo (git.initSpaceRepo) and commits these paths.
    const assetsDir = path.join(dir, "_assets");
    const gitkeepPath = path.join(assetsDir, ".gitkeep");
    const gitignorePath = path.join(dir, ".gitignore");

    await fs.mkdir(assetsDir, { recursive: true });
    await fs.writeFile(fsPath, raw, { encoding: "utf8", flag: "wx" });
    await fs.writeFile(gitkeepPath, "", { encoding: "utf8", flag: "wx" });
    await fs.writeFile(gitignorePath, SPACE_GITIGNORE, { encoding: "utf8", flag: "wx" });

    return { slug: key, fsPath, changedFsPaths: [fsPath, gitkeepPath, gitignorePath] };
  }

  /**
   * Rename a space's display name (rewrites only its index.md `title`). Like
   * renameFolder, the space's key/URL is deliberately stable — the on-disk
   * folder is its own git repo, so its name is its identity. Returns an empty
   * `changedFsPaths` when the name is unchanged so the caller skips a spurious
   * commit; returns null when the key is not a space with an index.md.
   */
  async renameSpace(key: string, title: string): Promise<RenameSpaceMutation | null> {
    const clean = cleanSlug(key);
    if (!clean || clean.includes("/")) {
      throw new Error("Only a top-level space can be renamed this way.");
    }

    const fsPath = await this.resolve(clean);
    // A space is a top-level folder backed by index.md; anything else is not one.
    if (!fsPath || !this.isSectionFsPath(fsPath) || path.dirname(fsPath) !== path.join(this.root, clean)) {
      return null;
    }

    const trimmed = title.trim();
    if (!trimmed) {
      throw new Error("The space name is required.");
    }

    const raw = await fs.readFile(fsPath, "utf8");
    const { data } = parsePage(raw, fsPath);
    if (data.title === trimmed) {
      return { key: clean, fsPath, changedFsPaths: [] };
    }

    const parsed = matter(raw);
    const nextData = { ...parsed.data, title: trimmed } as Record<string, unknown>;
    const nextRaw = matter.stringify(parsed.content, nextData);
    parsePage(nextRaw, fsPath);

    await fs.writeFile(fsPath, nextRaw, "utf8");
    return { key: clean, fsPath, changedFsPaths: [fsPath] };
  }

  /**
   * Permanently delete an entire space: its whole top-level directory, including
   * the space's own git repo and `_assets`. The KB root itself is not versioned,
   * so there is nothing to commit — the caller just removes and redirects.
   * Returns null when the key does not name an existing space directory.
   */
  async deleteSpace(key: string): Promise<DeleteSpaceMutation | null> {
    const clean = cleanSlug(key);
    if (!clean || clean.includes("/") || clean.startsWith(".") || clean.startsWith("_")) {
      throw new Error("Only a top-level space can be deleted this way.");
    }

    const dir = path.join(this.root, clean);
    // A space is always a direct child of the KB root; reject any traversal.
    if (path.dirname(dir) !== this.root) {
      throw new Error("Only a top-level space can be deleted this way.");
    }

    let stat: import("node:fs").Stats;
    try {
      stat = await fs.stat(dir);
    } catch {
      return null;
    }
    if (!stat.isDirectory()) return null;

    // Capture the display name before removing, for the caller's messaging.
    let title = clean;
    try {
      const raw = await fs.readFile(path.join(dir, "index.md"), "utf8");
      title = parsePage(raw, dir).data.title;
    } catch {
      /* no/invalid index.md — fall back to the key */
    }

    await fs.rm(dir, { recursive: true, force: true });

    // Drop cached parses beneath the removed dir so the tree reflects the delete.
    for (const cached of this.parseCache.keys()) {
      if (cached === dir || cached.startsWith(dir + path.sep)) {
        this.parseCache.delete(cached);
      }
    }

    return { key: clean, title, dir };
  }

  /** Return deletion impact without mutating the filesystem. */
  async deletePreview(slug: string): Promise<DeletePreview | null> {
    const clean = cleanSlug(slug);
    if (clean === "") {
      throw new Error("The home page cannot be deleted.");
    }

    const page = await this.load(clean);
    if (!page) return null;

    const isSection = path.basename(page.fsPath) === "index.md" && path.dirname(page.fsPath) !== this.root;
    const affectedFsPaths = isSection
      ? await this.markdownFiles(path.dirname(page.fsPath))
      : [page.fsPath];

    return {
      slug: page.slug,
      title: page.data.title,
      fsPath: page.fsPath,
      isSection,
      affectedFsPaths,
    };
  }

  /** Permanently delete a page or section subtree from the knowledge base. */
  async deletePage(slug: string): Promise<DeleteMutation | null> {
    const preview = await this.deletePreview(slug);
    if (!preview) return null;

    for (const target of preview.affectedFsPaths) {
      await fs.rm(target);
    }

    if (preview.isSection) {
      await this.pruneEmptyTree(path.dirname(preview.fsPath));
    } else {
      await this.pruneEmptyDirs(path.dirname(preview.fsPath));
    }

    return { ...preview, deletedFsPaths: preview.affectedFsPaths };
  }

  /** Move a page or section under a new parent, converting leaf parents to sections. */
  async movePage(sourceSlug: string, targetParentSlug: string | null): Promise<MoveMutation | null> {
    const cleanSource = cleanSlug(sourceSlug);
    if (cleanSource === "") {
      throw new Error("The home page cannot be moved.");
    }

    const source = await this.load(cleanSource);
    if (!source) return null;

    const cleanTarget = targetParentSlug === null ? "" : cleanSlug(targetParentSlug);
    if (!cleanTarget) {
      throw new Error("Pages must live inside a space.");
    }
    if (cleanTarget === cleanSource || cleanTarget.startsWith(`${cleanSource}/`)) {
      throw new Error("A page cannot be moved into itself or one of its children.");
    }

    let parentDir = this.root;
    let parentSlug = "";
    let targetConversion: LeafPromotion | null = null;

    if (cleanTarget) {
      const targetFsPath = await this.resolve(cleanTarget);
      if (!targetFsPath) {
        throw new Error("The destination page does not exist.");
      }

      const resolved = await this.sectionDirFor(targetFsPath);
      parentDir = resolved.dir;
      targetConversion = resolved.conversion;
      parentSlug = cleanTarget;
    }

    const sourceName = cleanSource.split("/").at(-1);
    if (!sourceName) {
      throw new Error("Could not determine the source page name.");
    }

    if ((parentSlug ? `${parentSlug}/${sourceName}` : sourceName) === cleanSource) {
      throw new Error("The page is already in that location.");
    }

    // Auto-suffix the leaf (e.g. notes -> notes-2) when the destination is taken.
    const freeName = await this.nextPageName(parentDir, sourceName);
    const newSlug = parentSlug ? `${parentSlug}/${freeName}` : freeName;
    const destinationFile = path.join(this.root, `${newSlug}.md`);
    const destinationDir = path.join(this.root, newSlug);

    const sourceIsSection = this.isSectionFsPath(source.fsPath);
    const sourcePath = sourceIsSection ? path.dirname(source.fsPath) : source.fsPath;
    const destinationPath = sourceIsSection ? destinationDir : destinationFile;
    const resolvedSource = path.resolve(sourcePath);
    const resolvedDestination = path.resolve(destinationPath);
    if (
      resolvedDestination === resolvedSource ||
      resolvedDestination.startsWith(`${resolvedSource}${path.sep}`)
    ) {
      throw new Error("A page cannot be moved into itself or one of its children.");
    }

    const changedFsPaths = [
      sourcePath,
      destinationPath,
      ...(targetConversion ? [targetConversion.from, targetConversion.to] : []),
    ];

    if (targetConversion) {
      await this.applyPromotion(targetConversion);
    }

    await fs.mkdir(parentDir, { recursive: true });
    await fs.rename(sourcePath, destinationPath);
    await this.pruneEmptyDirs(path.dirname(sourcePath));

    return {
      oldSlug: cleanSource,
      newSlug,
      changedFsPaths: uniquePaths(changedFsPaths),
    };
  }

  /**
   * Move several pages/sections under one new parent in a single pass. Sources
   * are deduped and any source nested under another selected source is dropped
   * (moving a folder already carries its children, so re-moving a child by its
   * stale slug would fail). Each move is attempted independently: failures are
   * collected rather than aborting the batch, and moves run sequentially so the
   * collision auto-suffix sees earlier renames.
   */
  async movePages(
    sourceSlugs: string[],
    targetParentSlug: string | null
  ): Promise<BatchMoveMutation> {
    const cleaned = [...new Set(sourceSlugs.map((s) => cleanSlug(s)).filter(Boolean))];
    // Keep only "roots": a source that is not a descendant of another source.
    const roots = cleaned.filter(
      (slug) => !cleaned.some((other) => other !== slug && slug.startsWith(`${other}/`))
    );

    const moves: MoveMutation[] = [];
    const failures: { slug: string; error: string }[] = [];
    const changedFsPaths: string[] = [];

    for (const slug of roots) {
      try {
        const mutation = await this.movePage(slug, targetParentSlug);
        if (!mutation) {
          failures.push({ slug, error: "Source page not found." });
          continue;
        }
        moves.push(mutation);
        changedFsPaths.push(...mutation.changedFsPaths);
      } catch (err) {
        failures.push({ slug, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return { moves, failures, changedFsPaths: uniquePaths(changedFsPaths) };
  }

  /** Rename a page's slug leaf within its current parent; suffixes on collision. */
  async renamePage(slug: string, newLeaf: string): Promise<MoveMutation | null> {
    const cleanSource = cleanSlug(slug);
    if (cleanSource === "") {
      throw new Error("The home page cannot be renamed.");
    }

    const source = await this.load(cleanSource);
    if (!source) return null;

    const desired = slugify(newLeaf);
    if (!desired) {
      throw new Error("The slug must contain letters or numbers.");
    }

    const segments = cleanSource.split("/");
    const currentLeaf = segments[segments.length - 1];
    const parentSlug = segments.slice(0, -1).join("/");

    const sourceIsSection = this.isSectionFsPath(source.fsPath);
    const sourcePath = sourceIsSection ? path.dirname(source.fsPath) : source.fsPath;
    const parentDir = path.dirname(sourcePath);

    if (desired === currentLeaf) {
      return { oldSlug: cleanSource, newSlug: cleanSource, changedFsPaths: [] };
    }

    const freeName = await this.nextPageName(parentDir, desired);
    const newSlug = parentSlug ? `${parentSlug}/${freeName}` : freeName;
    const destinationPath = sourceIsSection
      ? path.join(parentDir, freeName)
      : path.join(parentDir, `${freeName}.md`);

    await fs.rename(sourcePath, destinationPath);

    // Renaming a top-level space renames its whole folder, which carries the
    // space's own `.git` with it — the move itself is invisible to git. But the
    // caller may have just rewritten the space's index.md (the web editor saves
    // content, then renames), so include the moved index.md: the git layer skips
    // the space-root dirs and commits index.md only if its content changed.
    const isSpaceRename = parentSlug === "" && sourceIsSection;
    const changedFsPaths = isSpaceRename
      ? [sourcePath, destinationPath, path.join(destinationPath, "index.md")]
      : [sourcePath, destinationPath];

    return {
      oldSlug: cleanSource,
      newSlug,
      changedFsPaths: uniquePaths(changedFsPaths),
    };
  }

  /** Mark a page or section subtree archived/restored in frontmatter. */
  async updateArchive(slug: string, archived: boolean): Promise<ArchiveMutation | null> {
    const clean = cleanSlug(slug);
    if (clean === "" && archived) {
      throw new Error("The home page cannot be archived.");
    }

    const fsPath = await this.resolve(clean);
    if (!fsPath) return null;

    const isSection = path.basename(fsPath) === "index.md" && path.dirname(fsPath) !== this.root;
    const targets = isSection ? await this.markdownFiles(path.dirname(fsPath)) : [fsPath];
    const timestamp = new Date().toISOString();
    const changedFsPaths: string[] = [];

    for (const target of targets) {
      if (await this.updateArchiveMetadata(target, archived, timestamp)) {
        changedFsPaths.push(target);
      }
    }

    return { slug: clean, fsPath, isSection, changedFsPaths };
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
    collect(await this.tree("all"));
    return map;
  }

  private async markdownFiles(dir: string): Promise<string[]> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    const files: string[] = [];
    for (const entry of entries) {
      const name = entry.name;
      if (name.startsWith(".") || name.startsWith("_")) continue;

      const entryPath = path.join(dir, name);
      if (entry.isDirectory()) {
        files.push(...(await this.markdownFiles(entryPath)));
      } else if (entry.isFile() && name.endsWith(".md")) {
        files.push(entryPath);
      }
    }

    return files.sort((a, b) => a.localeCompare(b));
  }

  private async nextUntitledName(
    baseDir: string,
    kind: "page" | "folder" = "page"
  ): Promise<{ name: string; title: string }> {
    const nameBase = kind === "folder" ? "untitled-folder" : "untitled-page";
    const titleBase = kind === "folder" ? "Untitled Folder" : "Untitled Page";
    for (let index = 1; index < 10_000; index += 1) {
      const suffix = index === 1 ? "" : `-${index}`;
      const titleSuffix = index === 1 ? "" : ` ${index}`;
      const name = `${nameBase}${suffix}`;
      const candidateFile = path.join(baseDir, `${name}.md`);
      const candidateDir = path.join(baseDir, name);

      if (!(await exists(candidateFile)) && !(await exists(candidateDir))) {
        return { name, title: `${titleBase}${titleSuffix}` };
      }
    }

    throw new Error(`Could not find an available ${kind} slug.`);
  }

  private async nextPageName(baseDir: string, base: string): Promise<string> {
    for (let index = 1; index < 10_000; index += 1) {
      const name = index === 1 ? base : `${base}-${index}`;
      const candidateFile = path.join(baseDir, `${name}.md`);
      const candidateDir = path.join(baseDir, name);

      if (!(await exists(candidateFile)) && !(await exists(candidateDir))) {
        return name;
      }
    }

    throw new Error("Could not find an available page slug.");
  }

  private async pruneEmptyDirs(dir: string): Promise<void> {
    let current = path.resolve(dir);
    while (current !== this.root && current.startsWith(this.root + path.sep)) {
      try {
        await fs.rmdir(current);
      } catch {
        return;
      }
      current = path.dirname(current);
    }
  }

  private async pruneEmptyTree(dir: string): Promise<void> {
    const current = path.resolve(dir);
    if (current === this.root || !current.startsWith(this.root + path.sep)) return;

    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        await this.pruneEmptyTree(path.join(current, entry.name));
      }
    }

    await this.pruneEmptyDirs(current);
  }

  private isSectionFsPath(fsPath: string): boolean {
    return path.basename(fsPath) === "index.md" && path.dirname(fsPath) !== this.root;
  }

  /**
   * Resolve where new children of `parentFsPath` should live. A section's own
   * folder is returned as-is; a leaf page yields a pending conversion that
   * promotes `foo.md` to `foo/index.md` (apply it with applyPromotion).
   */
  private async sectionDirFor(
    parentFsPath: string
  ): Promise<{ dir: string; conversion: LeafPromotion | null }> {
    if (this.isSectionFsPath(parentFsPath)) {
      return { dir: path.dirname(parentFsPath), conversion: null };
    }
    const targetDir = path.join(
      path.dirname(parentFsPath),
      path.basename(parentFsPath, ".md")
    );
    if (await exists(targetDir)) {
      throw new Error("The destination already has a folder at that path.");
    }
    return {
      dir: targetDir,
      conversion: { from: parentFsPath, to: path.join(targetDir, "index.md"), dir: targetDir },
    };
  }

  /** Promote a leaf page into a section: create its folder and move it to index.md. */
  private async applyPromotion(conversion: LeafPromotion): Promise<void> {
    await fs.mkdir(conversion.dir);
    await fs.rename(conversion.from, conversion.to);
  }

  private async updateArchiveMetadata(
    fsPath: string,
    archived: boolean,
    timestamp: string
  ): Promise<boolean> {
    const raw = await fs.readFile(fsPath, "utf8");
    parsePage(raw, fsPath);

    const parsed = matter(raw);
    const data = { ...parsed.data } as Record<string, unknown>;
    const isArchived = data.archived === true;
    const hasArchived = Object.prototype.hasOwnProperty.call(data, "archived");
    const hasArchivedAt = Object.prototype.hasOwnProperty.call(data, "archivedAt");

    if (archived) {
      if (isArchived && typeof data.archivedAt === "string" && data.archivedAt.length > 0) {
        return false;
      }
      data.archived = true;
      data.archivedAt = timestamp;
    } else {
      if (!hasArchived && !hasArchivedAt) return false;
      delete data.archived;
      delete data.archivedAt;
    }

    const nextRaw = matter.stringify(parsed.content, data);
    parsePage(nextRaw, fsPath);
    if (nextRaw === raw) return false;

    await fs.writeFile(fsPath, nextRaw, "utf8");
    return true;
  }
}

/** Default .gitignore written into each new space repo (mirrors the migration script). */
const SPACE_GITIGNORE = `# Derived search index — generated from the markdown files, never committed.
*.sqlite
*.sqlite-*
.search-index/

# OS / editor cruft
.DS_Store
Thumbs.db
`;

function cleanSlug(slug: string): string {
  return slug.replace(/^\/+|\/+$/g, "");
}

/**
 * A page is a "folder" (pure container) when its frontmatter declares
 * `type: folder`. Single source of truth, shared by the content, server, and
 * MCP layers so folder detection can never drift between them.
 */
export function isFolderPage(data: Frontmatter): boolean {
  return data.type === "folder";
}

/**
 * Filename for a page downloaded as Markdown: its slug leaf + ".md". Slug
 * segments are already lowercase-hyphenated and URL-safe, so this is safe to
 * drop into a Content-Disposition header. Falls back to "page.md" for the
 * (leaf-less) home page.
 */
export function downloadFilename(slug: string): string {
  const leaf = cleanSlug(slug).split("/").filter(Boolean).at(-1) ?? "";
  return `${leaf || "page"}.md`;
}

/** Normalise CRLF/CR line endings to LF so saves compare and store consistently. */
function normalizeEol(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Best-effort last-modified time in ms; 0 when the path can't be stat'd. */
async function mtimeMs(p: string): Promise<number> {
  try {
    return (await fs.stat(p)).mtimeMs;
  } catch {
    return 0;
  }
}
