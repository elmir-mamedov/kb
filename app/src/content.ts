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
  /** True when the backing page has archived: true in frontmatter. */
  archived: boolean;
  archivedAt?: string;
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

/**
 * The content layer. Everything reads from a single folder of markdown files —
 * the same folder the MCP server will write to in a later step.
 */
export class Content {
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
        try {
          const raw = await fs.readFile(indexPath, "utf8");
          const data = parsePage(raw, indexPath).data;
          title = data.title;
          archived = data.archived === true;
          archivedAt = data.archivedAt;
          backing = indexPath;
        } catch {
          /* no/invalid index.md — still a navigable container */
        }
        const children = await this.walk(dirPath, slug, filter);
        if (this.includeNode(filter, archived, children.length)) {
          nodes.push({
            slug,
            title,
            fsPath: backing,
            isSection: true,
            archived,
            archivedAt,
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
        try {
          const raw = await fs.readFile(fsPath, "utf8");
          const data = parsePage(raw, fsPath).data;
          title = data.title;
          archived = data.archived === true;
          archivedAt = data.archivedAt;
        } catch {
          /* fall back to filename */
        }
        if (this.includeNode(filter, archived, 0)) {
          nodes.push({ slug, title, fsPath, isSection: false, archived, archivedAt, children: [] });
        }
      }
    }

    nodes.sort((a, b) => a.title.localeCompare(b.title));
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

  /** Load and parse a page by slug. */
  async load(slug: string): Promise<LoadedPage | null> {
    const fsPath = await this.resolve(slug);
    if (!fsPath) return null;
    const raw = await fs.readFile(fsPath, "utf8");
    const { data, body } = parsePage(raw, fsPath);
    return { slug: cleanSlug(slug), data, body, fsPath };
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
    parsePage(raw, fsPath);
    await fs.writeFile(fsPath, raw, "utf8");
    return { slug: cleanSlug(slug), raw, fsPath };
  }

  /** Create a root-level draft page with a unique slug. */
  /** Create an untitled draft page inside a space/section (or root when parent is ""). */
  async createDraft(parentSlug = ""): Promise<CreatePageMutation> {
    const cleanParent = cleanSlug(parentSlug);
    let parentDir = this.root;
    let parentPrefix = "";

    if (cleanParent) {
      const parentFsPath = await this.resolve(cleanParent);
      if (!parentFsPath) {
        throw new Error("The destination space or section does not exist.");
      }
      if (!this.isSectionFsPath(parentFsPath)) {
        throw new Error("Pages can only be created inside a space or section.");
      }
      parentDir = path.dirname(parentFsPath);
      parentPrefix = cleanParent;
    }

    const { name, title } = await this.nextDraftName(parentDir);
    const slug = parentPrefix ? `${parentPrefix}/${name}` : name;
    const fsPath = path.join(parentDir, `${name}.md`);
    const raw = matter.stringify(`# ${title}\n\n`, { title });

    parsePage(raw, fsPath);
    await fs.writeFile(fsPath, raw, { encoding: "utf8", flag: "wx" });
    return { slug, fsPath };
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
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(fsPath, raw, { encoding: "utf8", flag: "wx" });
    return { slug: key, fsPath };
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
    if (cleanTarget && (cleanTarget === cleanSource || cleanTarget.startsWith(`${cleanSource}/`))) {
      throw new Error("A page cannot be moved into itself or one of its children.");
    }

    let parentDir = this.root;
    let parentSlug = "";
    let targetConversion: { from: string; to: string; dir: string } | null = null;

    if (cleanTarget) {
      const targetFsPath = await this.resolve(cleanTarget);
      if (!targetFsPath) {
        throw new Error("The destination page does not exist.");
      }

      if (this.isSectionFsPath(targetFsPath)) {
        parentDir = path.dirname(targetFsPath);
      } else {
        const targetDir = path.join(
          path.dirname(targetFsPath),
          path.basename(targetFsPath, ".md")
        );
        if (await exists(targetDir)) {
          throw new Error("The destination already has a folder at that path.");
        }
        parentDir = targetDir;
        targetConversion = {
          from: targetFsPath,
          to: path.join(targetDir, "index.md"),
          dir: targetDir,
        };
      }
      parentSlug = cleanTarget;
    }

    const sourceName = cleanSource.split("/").at(-1);
    if (!sourceName) {
      throw new Error("Could not determine the source page name.");
    }

    const newSlug = parentSlug ? `${parentSlug}/${sourceName}` : sourceName;
    if (newSlug === cleanSource) {
      throw new Error("The page is already in that location.");
    }

    const destinationFile = path.join(this.root, `${newSlug}.md`);
    const destinationDir = path.join(this.root, newSlug);
    if (await exists(destinationFile) || await exists(destinationDir)) {
      throw new Error("A page already exists at the destination path.");
    }

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
      await fs.mkdir(targetConversion.dir);
      await fs.rename(targetConversion.from, targetConversion.to);
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

  private async nextDraftName(baseDir: string): Promise<{ name: string; title: string }> {
    for (let index = 1; index < 10_000; index += 1) {
      const suffix = index === 1 ? "" : `-${index}`;
      const titleSuffix = index === 1 ? "" : ` ${index}`;
      const name = `untitled-page${suffix}`;
      const candidateFile = path.join(baseDir, `${name}.md`);
      const candidateDir = path.join(baseDir, name);

      if (!(await exists(candidateFile)) && !(await exists(candidateDir))) {
        return { name, title: `Untitled Page${titleSuffix}` };
      }
    }

    throw new Error("Could not find an available draft page slug.");
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

function cleanSlug(slug: string): string {
  return slug.replace(/^\/+|\/+$/g, "");
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
