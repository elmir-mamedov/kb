import matter from "gray-matter";
import { z } from "zod";

/**
 * The minimal page frontmatter schema agreed in Step 1.
 * `created` / `updated` / `author` are intentionally NOT here — they come from
 * git, so there's a single source of truth and nothing to keep in sync.
 */
export const FrontmatterSchema = z.object({
  title: z.string().min(1, "title is required"),
  /**
   * Stable, immutable page identity. Unlike the slug (which is the file path and
   * changes on move/rename), the id never changes, so an `[[id:<id>]]` link keeps
   * resolving after a page is moved. Optional so pages predating the id backfill
   * still validate; new pages get one on create and the migration adds it to the rest.
   */
  id: z.string().optional(),
  tags: z.array(z.string()).optional(),
  summary: z.string().optional(),
  /**
   * Manual sibling position in the navigation, 1-based and ascending. Written by
   * sidebar drag-and-drop reordering, which renumbers every sibling in the group
   * it touches. Absent means "unplaced": those siblings keep the recent-first
   * default and sort after the explicitly ordered ones (see Content.walk).
   * Any number is accepted, so a fractional value can be hand-written to slot a
   * page between two ordered siblings without renumbering them.
   */
  order: z.number().optional(),
  /** Optional emoji shown on the space card; only meaningful on a space's index.md. */
  icon: z.string().optional(),
  /**
   * Marks a directory's index.md as a pure container ("folder") rather than a
   * content page. Only "folder" is meaningful; its absence means an ordinary
   * page/section. Kept optional so every existing page validates unchanged.
   */
  type: z.literal("folder").optional(),
  archived: z.boolean().optional(),
  archivedAt: z.string().optional(),
});

export type Frontmatter = z.infer<typeof FrontmatterSchema>;

export interface ParsedPage {
  data: Frontmatter;
  body: string;
}

/**
 * Parse a raw .md file: split frontmatter from body and validate it.
 * Throws a clear error if the frontmatter is malformed — so a bad header is
 * caught on read rather than crashing the renderer somewhere downstream.
 */
export function parsePage(raw: string, sourceLabel = "page"): ParsedPage {
  const { data, content } = matter(raw);
  const result = FrontmatterSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid frontmatter in ${sourceLabel}: ${issues}`);
  }
  return { data: result.data, body: content };
}
