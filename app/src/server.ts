import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import {
  Content,
  downloadFilename,
  isFolderPage,
  type ArchiveMutation,
  type CreatePageMutation,
  type DeleteMutation,
  type MoveMutation,
  type PageNode,
} from "./content.js";
import { makeGit } from "./git.js";
import { createRenderer } from "./markdown.js";
import {
  archiveLayout,
  deleteLayout,
  editLayout,
  escapeHtml,
  folderLayout,
  layout,
  loginLayout,
  notFound,
  spacesLayout,
  type ViewNotice,
} from "./views.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- config ---------------------------------------------------------------
loadEnvFile(path.join(__dirname, "..", "..", ".env"));
loadEnvFile(path.join(__dirname, "..", ".env"));

const KB_DIR = path.resolve(
  process.env.KB_DIR ?? path.join(__dirname, "..", "..", "kb")
);
const HOST = process.env.HOST ?? "0.0.0.0"; // bind for LAN access
const PORT = Number(process.env.PORT ?? 4000);
const SITE_TITLE = process.env.SITE_TITLE ?? "Knowledge Base";

// Site icons bundled with the app, served from the site root so the
// <link rel="icon"> tags and the browser's automatic /favicon.ico lookup
// resolve. Each is registered as a literal route, which find-my-way ranks
// above the `/*` page catch-all.
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const PUBLIC_FILES = [
  "favicon.ico",
  "favicon-16x16.png",
  "favicon-32x32.png",
  "favicon-48x48.png",
  "favicon-64x64.png",
  "favicon-96x96.png",
  "favicon-192x192.png",
  "favicon-512x512.png",
  "apple-touch-icon.png",
  "flux.svg",
];
const PUBLIC_PATHS = new Set(PUBLIC_FILES.map((file) => `/${file}`));
const AUTH_USERNAME = requireEnv("AUTH_USERNAME");
const AUTH_PASSWORD = requireEnv("AUTH_PASSWORD");
const AUTH_SESSION_SECRET = requireEnv("AUTH_SESSION_SECRET");
const SESSION_COOKIE = "kb_session";
const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

const content = new Content(KB_DIR);
const git = makeGit(KB_DIR);
const app = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024 });

function loadEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;

  const source = fs.readFileSync(filePath, "utf8");
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;

    const value = rawValue.replace(/^(['"])(.*)\1$/, "$2");
    process.env[key] = value;
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

app.addContentTypeParser(
  "application/x-www-form-urlencoded",
  { parseAs: "string" },
  (_request, body, done) => {
    const parsed: Record<string, string> = {};
    const rawBody = typeof body === "string" ? body : body.toString("utf8");
    for (const [key, value] of new URLSearchParams(rawBody)) {
      parsed[key] = value;
    }
    done(null, parsed);
  }
);

function requestPath(req: FastifyRequest): string {
  return new URL(req.url, "http://localhost").pathname;
}

function safeRedirectPath(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  if (value === "/_login" || value.startsWith("/_login?")) return "/";
  return value;
}

function queryString(query: unknown, field: string): string | null {
  if (!query || typeof query !== "object") return null;
  const value = (query as Record<string, unknown>)[field];
  return typeof value === "string" ? value : null;
}

function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;

  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    try {
      cookies.set(key, decodeURIComponent(value));
    } catch {
      continue;
    }
  }

  return cookies;
}

function sign(value: string): string {
  return crypto
    .createHmac("sha256", AUTH_SESSION_SECRET)
    .update(value)
    .digest("base64url");
}

function timingSafeEqualString(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function createSession(username: string): string {
  const payload = Buffer.from(
    JSON.stringify({
      exp: Date.now() + SESSION_MAX_AGE_SECONDS * 1000,
      user: username,
    }),
    "utf8"
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function readSession(token: string | undefined): string | null {
  if (!token) return null;

  const [payload, signature] = token.split(".");
  if (!payload || !signature || !timingSafeEqualString(signature, sign(payload))) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      exp?: unknown;
      user?: unknown;
    };
    if (parsed.user !== AUTH_USERNAME) return null;
    if (typeof parsed.exp !== "number" || parsed.exp < Date.now()) return null;
    return parsed.user;
  } catch {
    return null;
  }
}

function currentUser(req: FastifyRequest): string | null {
  return readSession(parseCookies(req.headers.cookie).get(SESSION_COOKIE));
}

function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(
    token
  )}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}`;
}

function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

app.addHook("onRequest", async (req, reply) => {
  const reqPath = requestPath(req);
  if (reqPath === "/_login") return;
  if (PUBLIC_PATHS.has(reqPath)) return; // site icons load before sign-in
  if (currentUser(req)) return;

  const next = encodeURIComponent(req.url || "/");
  return reply.redirect(`/_login?next=${next}`, 303);
});

// Register @fastify/static once with no route of its own (`serve: false`), just
// to decorate reply with sendFile so a per-call rootOverride can target each
// space's _assets dir.
await app.register(fastifyStatic, {
  root: KB_DIR,
  serve: false,
  decorateReply: true,
});

// Per-space attachments: kb/<space>/_assets/* served at /<space>/_assets/*.
// find-my-way ranks the literal `_assets` segment above the `/*` page
// catch-all, so page routing is unaffected. Sits behind the auth hook.
app.get("/:space/_assets/*", async (req, reply) => {
  const params = req.params as { space: string; "*": string };
  const space = content.spaceKeyOf(params.space);
  const assetsRoot = path.join(KB_DIR, space, "_assets");
  if (
    !space ||
    space.startsWith(".") ||
    space.startsWith("_") ||
    !isInsideDir(KB_DIR, assetsRoot)
  ) {
    return reply.callNotFound();
  }
  return reply.sendFile(params["*"], assetsRoot);
});

// Bundled site icons (favicons, app icons) served from app/public at the root.
for (const file of PUBLIC_FILES) {
  app.get(`/${file}`, async (_req, reply) => reply.sendFile(file, PUBLIC_DIR));
}

/** Best-effort git commit date+time for a file; falls back to null. */
async function gitUpdated(fsPath: string): Promise<string | null> {
  try {
    // History lives in the file's per-space repo, not at the KB root.
    const repoRoot = git.spaceRepoRoot(fsPath);
    const rel = path.relative(repoRoot, fsPath);
    const { stdout } = await execFileAsync(
      "git",
      ["log", "-1", "--date=format:%Y-%m-%d %H:%M", "--format=%cd", "--", rel],
      { cwd: repoRoot }
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function gitCommitPage(fsPath: string): Promise<string | null> {
  const rel = git.kbRelPath(fsPath);
  return git.commitFiles([fsPath], `Update ${rel} via web`);
}

function archiveCommitMessage(action: "Archive" | "Restore", mutation: ArchiveMutation): string {
  const target = mutation.isSection ? mutation.slug : git.kbRelPath(mutation.fsPath);
  return `${action} ${target} via web`;
}

function createCommitMessage(mutation: CreatePageMutation): string {
  return `Create ${git.kbRelPath(mutation.fsPath)} via web`;
}

function deleteCommitMessage(mutation: DeleteMutation): string {
  const target = mutation.isSection ? mutation.slug : git.kbRelPath(mutation.fsPath);
  return `Delete ${target} via web`;
}

function moveCommitMessage(mutation: MoveMutation): string {
  return `Move ${mutation.oldSlug} to ${mutation.newSlug} via web`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formString(body: unknown, field: string): string | null {
  if (!body || typeof body !== "object") return null;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === "string" ? value : null;
}

function pagePath(slug: string): string {
  if (!slug) return "/";
  return "/" + slug.split("/").map(encodeURIComponent).join("/");
}

/** True when `child` resolves to `parent` itself or a path beneath it (no traversal). */
function isInsideDir(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Depth-first search for a node by slug within a (possibly nested) tree. */
function findNode(nodes: PageNode[], slug: string): PageNode | null {
  for (const n of nodes) {
    if (n.slug === slug) return n;
    const hit = findNode(n.children, slug);
    if (hit) return hit;
  }
  return null;
}

/** True when the slug resolves to a folder (a pure container with no body). */
async function slugIsFolder(slug: string): Promise<boolean> {
  const page = await content.load(slug);
  return page ? isFolderPage(page.data) : false;
}

async function renderPage(
  slug: string,
  options: { notice?: ViewNotice } = {}
): Promise<{ status: number; html: string }> {
  const [spaces, titles, page] = await Promise.all([
    content.spaces(),
    content.titleIndex(),
    content.load(slug),
  ]);

  if (!page) {
    return {
      status: 404,
      html: notFound(SITE_TITLE, slug.replace(/^\/+/, ""), spaces, AUTH_USERNAME),
    };
  }

  const spaceKey = content.spaceKeyOf(page.slug);
  const tree = await content.spaceTree(spaceKey);

  // A folder is a pure container: render its contents listing, never prose.
  if (isFolderPage(page.data)) {
    const node = findNode(tree, page.slug);
    const html = folderLayout({
      siteTitle: SITE_TITLE,
      spaces,
      spaceKey,
      tree,
      activeSlug: page.slug,
      titles,
      title: page.data.title,
      children: node?.children ?? [],
      isArchived: page.data.archived === true,
      archivedAt: page.data.archivedAt,
      notice: options.notice,
      username: AUTH_USERNAME,
    });
    return { status: 200, html };
  }

  const md = createRenderer((s) => titles.get(s), page.slug);
  const contentHtml = md.render(page.body);
  const updated = await gitUpdated(page.fsPath);

  const html = layout({
    siteTitle: SITE_TITLE,
    spaces,
    spaceKey,
    tree,
    activeSlug: page.slug,
    titles,
    title: page.data.title,
    tags: page.data.tags,
    contentHtml,
    updated,
    isArchived: page.data.archived === true,
    archivedAt: page.data.archivedAt,
    notice: options.notice,
    username: AUTH_USERNAME,
  });
  return { status: 200, html };
}

async function renderArchiveBrowser(): Promise<string> {
  const [spaces, archiveTree, titles] = await Promise.all([
    content.spaces(),
    content.tree("archived"),
    content.titleIndex(),
  ]);

  return archiveLayout({
    siteTitle: SITE_TITLE,
    spaces,
    archiveTree,
    titles,
    username: AUTH_USERNAME,
  });
}

async function renderSystemNotice(title: string, notice: ViewNotice): Promise<string> {
  const [spaces, titles] = await Promise.all([content.spaces(), content.titleIndex()]);
  return layout({
    siteTitle: SITE_TITLE,
    spaces,
    spaceKey: "",
    tree: [],
    activeSlug: "",
    titles,
    title,
    contentHtml: `<p>${escapeHtml(notice.text)}</p>`,
    canEdit: false,
    notice,
    username: AUTH_USERNAME,
  });
}

async function renderEditPage(
  slug: string,
  options: { raw?: string; error?: string; notice?: string } = {}
): Promise<{ status: number; html: string }> {
  const [spaces, titles, page] = await Promise.all([
    content.spaces(),
    content.titleIndex(),
    content.loadRaw(slug),
  ]);

  if (!page) {
    return {
      status: 404,
      html: notFound(SITE_TITLE, slug.replace(/^\/+/, ""), spaces, AUTH_USERNAME),
    };
  }

  const spaceKey = content.spaceKeyOf(page.slug);
  const tree = await content.spaceTree(spaceKey);
  const fallbackTitle = page.slug.split("/").pop() || "Home";
  const html = editLayout({
    siteTitle: SITE_TITLE,
    spaces,
    spaceKey,
    tree,
    activeSlug: page.slug,
    titles,
    title: titles.get(page.slug) ?? fallbackTitle,
    raw: options.raw ?? page.raw,
    error: options.error,
    notice: options.notice,
    username: AUTH_USERNAME,
  });
  return { status: options.error ? 400 : 200, html };
}

async function renderDeletePage(slug: string): Promise<{ status: number; html: string }> {
  const [spaces, titles, preview] = await Promise.all([
    content.spaces(),
    content.titleIndex(),
    content.deletePreview(slug),
  ]);

  if (!preview) {
    return {
      status: 404,
      html: notFound(SITE_TITLE, slug.replace(/^\/+/, ""), spaces, AUTH_USERNAME),
    };
  }

  const spaceKey = content.spaceKeyOf(preview.slug);
  const tree = await content.spaceTree(spaceKey);
  return {
    status: 200,
    html: deleteLayout({
      siteTitle: SITE_TITLE,
      spaces,
      spaceKey,
      tree,
      activeSlug: preview.slug,
      titles,
      title: preview.title,
      fsPath: preview.fsPath,
      isSection: preview.isSection,
      affectedCount: preview.affectedFsPaths.length,
      username: AUTH_USERNAME,
    }),
  };
}

app.get("/_login", async (req, reply) => {
  const next = safeRedirectPath(queryString(req.query, "next"));
  if (currentUser(req)) return reply.redirect(next);

  return reply.type("text/html").send(
    loginLayout({
      siteTitle: SITE_TITLE,
      next,
    })
  );
});

app.post("/_login", async (req, reply) => {
  const next = safeRedirectPath(formString(req.body, "next"));
  const username = formString(req.body, "username") ?? "";
  const password = formString(req.body, "password") ?? "";

  if (username === AUTH_USERNAME && password === AUTH_PASSWORD) {
    return reply.header("set-cookie", sessionCookie(createSession(username))).redirect(next, 303);
  }

  return reply.code(401).type("text/html").send(
    loginLayout({
      siteTitle: SITE_TITLE,
      error: "The username or password is incorrect.",
      next,
      username,
    })
  );
});

app.post("/_logout", async (_req, reply) => {
  return reply.header("set-cookie", clearSessionCookie()).redirect("/_login", 303);
});

app.post("/_create", async (req, reply) => {
  const parentSlug = formString(req.body, "parentSlug") ?? "";
  let mutation: CreatePageMutation;
  try {
    mutation = await content.createDraft(parentSlug);
  } catch (err) {
    const notice = { tone: "error", text: errorMessage(err) } satisfies ViewNotice;
    return reply
      .code(500)
      .type("text/html")
      .send(await renderSystemNotice("Create failed", notice));
  }

  try {
    if (mutation.changedFsPaths) {
      await git.commitMovedPaths(mutation.changedFsPaths, createCommitMessage(mutation));
    } else {
      await git.commitFiles([mutation.fsPath], createCommitMessage(mutation));
    }
  } catch (err) {
    const { html } = await renderEditPage(mutation.slug, {
      error: `Created, but Git commit failed: ${errorMessage(err)}`,
    });
    return reply.code(500).type("text/html").send(html);
  }

  return reply.redirect(`/_edit${pagePath(mutation.slug)}`, 303);
});

app.post("/_create-folder", async (req, reply) => {
  const parentSlug = formString(req.body, "parentSlug") ?? "";
  const name = formString(req.body, "name") ?? "";
  let mutation: CreatePageMutation;
  try {
    // A folder is created with its name up front; there is nothing to edit
    // afterwards, so we land on its listing rather than the markdown editor.
    mutation = await content.createFolder(parentSlug, name);
  } catch (err) {
    const notice = { tone: "error", text: errorMessage(err) } satisfies ViewNotice;
    return reply
      .code(500)
      .type("text/html")
      .send(await renderSystemNotice("Create failed", notice));
  }

  try {
    if (mutation.changedFsPaths) {
      await git.commitMovedPaths(mutation.changedFsPaths, createCommitMessage(mutation));
    } else {
      await git.commitFiles([mutation.fsPath], createCommitMessage(mutation));
    }
  } catch (err) {
    const notice = {
      tone: "error",
      text: `Created, but Git commit failed: ${errorMessage(err)}`,
    } satisfies ViewNotice;
    const { html } = await renderPage(mutation.slug, { notice });
    return reply.code(500).type("text/html").send(html);
  }

  return reply.redirect(pagePath(mutation.slug), 303);
});

// Rename a folder's display name in place (its URL slug does not change).
app.post("/_rename-folder", async (req, reply) => {
  const slug = formString(req.body, "slug") ?? "";
  const name = formString(req.body, "name") ?? "";

  let mutation: Awaited<ReturnType<typeof content.renameFolder>>;
  try {
    mutation = await content.renameFolder(slug, name);
  } catch (err) {
    const notice = { tone: "error", text: errorMessage(err) } satisfies ViewNotice;
    const { html } = await renderPage(slug, { notice });
    return reply.code(400).type("text/html").send(html);
  }
  if (!mutation) {
    const spaces = await content.spaces();
    return reply
      .code(404)
      .type("text/html")
      .send(notFound(SITE_TITLE, slug.replace(/^\/+/, ""), spaces, AUTH_USERNAME));
  }

  try {
    // Empty changedFsPaths means the name was unchanged — skip the commit.
    if (mutation.changedFsPaths.length) {
      await git.commitFiles(mutation.changedFsPaths, `Rename folder ${mutation.slug} via web`);
    }
  } catch (err) {
    const notice = {
      tone: "error",
      text: `Renamed, but Git commit failed: ${errorMessage(err)}`,
    } satisfies ViewNotice;
    const { html } = await renderPage(mutation.slug, { notice });
    return reply.code(500).type("text/html").send(html);
  }

  return reply.redirect(pagePath(mutation.slug), 303);
});

app.post("/_create-space", async (req, reply) => {
  const title = formString(req.body, "title") ?? "";
  let mutation: CreatePageMutation;
  try {
    mutation = await content.createSpace(title);
  } catch (err) {
    const notice = { tone: "error", text: errorMessage(err) } satisfies ViewNotice;
    return reply
      .code(400)
      .type("text/html")
      .send(
        spacesLayout({
          siteTitle: SITE_TITLE,
          spaces: await content.spaces(),
          notice,
          username: AUTH_USERNAME,
        })
      );
  }

  try {
    // A new space is its own git repo: initialize it before committing the
    // scaffolding (index.md, _assets/.gitkeep, .gitignore) into it.
    await git.initSpaceRepo(mutation.slug);
    await git.commitFiles(
      mutation.changedFsPaths ?? [mutation.fsPath],
      createCommitMessage(mutation)
    );
  } catch (err) {
    const { html } = await renderEditPage(mutation.slug, {
      error: `Created, but Git commit failed: ${errorMessage(err)}`,
    });
    return reply.code(500).type("text/html").send(html);
  }

  return reply.redirect(`/_edit${pagePath(mutation.slug)}`, 303);
});

// --- Space management from the home grid ---------------------------------
// The ⋯ menu on each space card posts here. All three actions land back on the
// spaces home ("/"): the grid is where the user was, and the acted-on space has
// either changed name, dropped off the live grid (archived), or vanished.

async function renderSpacesPage(
  reply: FastifyReply,
  status: number,
  extra: { notice?: ViewNotice; confirmDelete?: { key: string; title: string } } = {}
): Promise<FastifyReply> {
  return reply
    .code(status)
    .type("text/html")
    .send(
      spacesLayout({
        siteTitle: SITE_TITLE,
        spaces: await content.spaces(),
        username: AUTH_USERNAME,
        ...extra,
      })
    );
}

// Edit a space's display name in place (its key/URL is stable).
app.post("/_rename-space", async (req, reply) => {
  const key = formString(req.body, "key") ?? "";
  const title = formString(req.body, "title") ?? "";

  let mutation: Awaited<ReturnType<typeof content.renameSpace>>;
  try {
    mutation = await content.renameSpace(key, title);
  } catch (err) {
    return renderSpacesPage(reply, 400, {
      notice: { tone: "error", text: errorMessage(err) },
    });
  }
  if (!mutation) {
    return renderSpacesPage(reply, 404, {
      notice: { tone: "error", text: `No space named "${key}".` },
    });
  }

  try {
    // Empty changedFsPaths means the name was unchanged — skip the commit.
    if (mutation.changedFsPaths.length) {
      await git.commitFiles(mutation.changedFsPaths, `Rename space ${mutation.key} via web`);
    }
  } catch (err) {
    return renderSpacesPage(reply, 500, {
      notice: { tone: "error", text: `Renamed, but Git commit failed: ${errorMessage(err)}` },
    });
  }

  return reply.redirect("/", 303);
});

// Archive a whole space: marks every page in it archived (reusing the page
// archive path) so it drops off the live grid but stays restorable.
app.post("/_archive-space", async (req, reply) => {
  const key = formString(req.body, "key") ?? "";
  if (!key || key.includes("/")) {
    return renderSpacesPage(reply, 400, {
      notice: { tone: "error", text: "Only a top-level space can be archived here." },
    });
  }

  let mutation: ArchiveMutation | null;
  try {
    mutation = await content.updateArchive(key, true);
  } catch (err) {
    return renderSpacesPage(reply, 400, {
      notice: { tone: "error", text: errorMessage(err) },
    });
  }
  if (!mutation) {
    return renderSpacesPage(reply, 404, {
      notice: { tone: "error", text: `No space named "${key}".` },
    });
  }

  try {
    await git.commitFiles(mutation.changedFsPaths, archiveCommitMessage("Archive", mutation));
  } catch (err) {
    return renderSpacesPage(reply, 500, {
      notice: { tone: "error", text: `Archived, but Git commit failed: ${errorMessage(err)}` },
    });
  }

  return reply.redirect("/", 303);
});

// Deleting a whole space is irreversible (its git repo goes with it), so the
// menu's Delete link lands here first for a confirmation prompt.
app.get("/_delete-space/*", async (req, reply) => {
  const key = content.spaceKeyOf((req.params as { "*": string })["*"] ?? "");
  const space = (await content.spaces("all")).find((s) => s.key === key);
  if (!space) {
    return renderSpacesPage(reply, 404, {
      notice: { tone: "error", text: `No space named "${key}".` },
    });
  }
  return renderSpacesPage(reply, 200, {
    confirmDelete: { key: space.key, title: space.title },
  });
});

app.post("/_delete-space/*", async (req, reply) => {
  const key = (req.params as { "*": string })["*"] ?? "";

  let mutation: Awaited<ReturnType<typeof content.deleteSpace>>;
  try {
    mutation = await content.deleteSpace(key);
  } catch (err) {
    return renderSpacesPage(reply, 400, {
      notice: { tone: "error", text: errorMessage(err) },
    });
  }
  if (!mutation) {
    return renderSpacesPage(reply, 404, {
      notice: { tone: "error", text: `No space named "${key}".` },
    });
  }

  return reply.redirect("/", 303);
});

app.post("/_move", async (req, reply) => {
  const sourceSlug = formString(req.body, "sourceSlug") ?? "";
  const targetKind = formString(req.body, "targetKind") ?? "";
  const targetSlug = formString(req.body, "targetSlug") ?? "";

  if (!sourceSlug) {
    return reply.code(400).send({ ok: false, error: "Missing source page." });
  }
  if (targetKind !== "root" && targetKind !== "page") {
    return reply.code(400).send({ ok: false, error: "Invalid destination." });
  }
  if (targetKind === "page" && !targetSlug) {
    return reply.code(400).send({ ok: false, error: "Missing destination page." });
  }

  let mutation: MoveMutation | null;
  try {
    mutation = await content.movePage(
      sourceSlug,
      targetKind === "root" ? null : targetSlug
    );
  } catch (err) {
    return reply.code(400).send({ ok: false, error: errorMessage(err) });
  }

  if (!mutation) {
    return reply.code(404).send({ ok: false, error: "Source page not found." });
  }

  try {
    await git.commitMovedPaths(mutation.changedFsPaths, moveCommitMessage(mutation));
  } catch (err) {
    return reply.code(500).send({
      ok: false,
      error: `Moved, but Git commit failed: ${errorMessage(err)}`,
      url: pagePath(mutation.newSlug),
    });
  }

  return reply.send({
    ok: true,
    slug: mutation.newSlug,
    url: pagePath(mutation.newSlug),
  });
});

app.get("/_archive", async (_req, reply) => {
  return reply.type("text/html").send(await renderArchiveBrowser());
});

async function handleArchiveMutation(
  slug: string,
  archived: boolean,
  reply: FastifyReply
) {
  let mutation: ArchiveMutation | null;
  try {
    mutation = await content.updateArchive(slug, archived);
  } catch (err) {
    const notice = { tone: "error", text: errorMessage(err) } satisfies ViewNotice;
    if (slug.replace(/^\/+|\/+$/g, "") === "") {
      return reply
        .code(400)
        .type("text/html")
        .send(await renderSystemNotice("Archive blocked", notice));
    }

    const { status, html } = await renderPage(slug, {
      notice,
    });
    if (status === 404) {
      return reply
        .code(400)
        .type("text/html")
        .send(await renderSystemNotice("Archive failed", notice));
    }
    return reply.code(400).type("text/html").send(html);
  }

  if (!mutation) {
    const spaces = await content.spaces();
    return reply
      .code(404)
      .type("text/html")
      .send(notFound(SITE_TITLE, slug.replace(/^\/+/, ""), spaces, AUTH_USERNAME));
  }

  try {
    await git.commitFiles(
      mutation.changedFsPaths,
      archiveCommitMessage(archived ? "Archive" : "Restore", mutation)
    );
  } catch (err) {
    const verb = archived ? "Archived" : "Restored";
    const { html } = await renderPage(mutation.slug, {
      notice: {
        tone: "error",
        text: `${verb}, but Git commit failed: ${errorMessage(err)}`,
      },
    });
    return reply.code(500).type("text/html").send(html);
  }

  return reply.redirect(pagePath(mutation.slug), 303);
}

app.post("/_archive", async (_req, reply) => {
  return handleArchiveMutation("", true, reply);
});

app.post("/_archive/*", async (req, reply) => {
  const slug = (req.params as { "*": string })["*"] ?? "";
  return handleArchiveMutation(slug, true, reply);
});

app.post("/_restore", async (_req, reply) => {
  return handleArchiveMutation("", false, reply);
});

app.post("/_restore/*", async (req, reply) => {
  const slug = (req.params as { "*": string })["*"] ?? "";
  return handleArchiveMutation(slug, false, reply);
});

app.get("/_delete", async (_req, reply) => {
  const notice = {
    tone: "error",
    text: "The home page cannot be deleted.",
  } satisfies ViewNotice;
  return reply
    .code(400)
    .type("text/html")
    .send(await renderSystemNotice("Delete blocked", notice));
});

app.get("/_delete/*", async (req, reply) => {
  const slug = (req.params as { "*": string })["*"] ?? "";
  try {
    const { status, html } = await renderDeletePage(slug);
    return reply.code(status).type("text/html").send(html);
  } catch (err) {
    const notice = { tone: "error", text: errorMessage(err) } satisfies ViewNotice;
    return reply
      .code(400)
      .type("text/html")
      .send(await renderSystemNotice("Delete blocked", notice));
  }
});

app.post("/_delete", async (_req, reply) => {
  const notice = {
    tone: "error",
    text: "The home page cannot be deleted.",
  } satisfies ViewNotice;
  return reply
    .code(400)
    .type("text/html")
    .send(await renderSystemNotice("Delete blocked", notice));
});

app.post("/_delete/*", async (req, reply) => {
  const slug = (req.params as { "*": string })["*"] ?? "";
  let mutation: DeleteMutation | null;

  try {
    mutation = await content.deletePage(slug);
  } catch (err) {
    const notice = { tone: "error", text: errorMessage(err) } satisfies ViewNotice;
    return reply
      .code(400)
      .type("text/html")
      .send(await renderSystemNotice("Delete blocked", notice));
  }

  if (!mutation) {
    const spaces = await content.spaces();
    return reply
      .code(404)
      .type("text/html")
      .send(notFound(SITE_TITLE, slug.replace(/^\/+/, ""), spaces, AUTH_USERNAME));
  }

  try {
    await git.commitFiles(mutation.deletedFsPaths, deleteCommitMessage(mutation));
  } catch (err) {
    const notice = {
      tone: "error",
      text: `Deleted, but Git commit failed: ${errorMessage(err)}`,
    } satisfies ViewNotice;
    return reply
      .code(500)
      .type("text/html")
      .send(await renderSystemNotice("Delete commit failed", notice));
  }

  // Land on the nearest surviving ancestor (parent page or space) rather than
  // bouncing all the way out to the spaces home.
  let destination = "/";
  let ancestor = mutation.slug.split("/").slice(0, -1).join("/");
  while (ancestor) {
    if (await content.resolve(ancestor)) {
      destination = pagePath(ancestor);
      break;
    }
    ancestor = ancestor.split("/").slice(0, -1).join("/");
  }
  return reply.redirect(destination, 303);
});

// Home: the spaces landing grid (each top-level folder is a space).
app.get("/", async (_req, reply) => {
  const spaces = await content.spaces();
  return reply.type("text/html").send(
    spacesLayout({
      siteTitle: SITE_TITLE,
      spaces,
      username: AUTH_USERNAME,
    })
  );
});

app.get("/_edit/*", async (req, reply) => {
  const slug = (req.params as { "*": string })["*"] ?? "";
  // Folders have no editable body — send the user to the folder listing.
  if (await slugIsFolder(slug)) return reply.redirect(pagePath(slug), 303);
  const { status, html } = await renderEditPage(slug);
  return reply.code(status).type("text/html").send(html);
});

app.post("/_edit/*", async (req, reply) => {
  const slug = (req.params as { "*": string })["*"] ?? "";
  if (await slugIsFolder(slug)) return reply.redirect(pagePath(slug), 303);
  const markdown = formString(req.body, "markdown");
  if (markdown === null) {
    const { status, html } = await renderEditPage(slug, {
      error: "Missing markdown form field.",
    });
    return reply.code(status).type("text/html").send(html);
  }

  let page;
  try {
    page = await content.updateRaw(slug, markdown);
  } catch (err) {
    const { html } = await renderEditPage(slug, {
      raw: markdown,
      error: `Could not save page: ${errorMessage(err)}`,
    });
    return reply.code(400).type("text/html").send(html);
  }

  if (!page) {
    const spaces = await content.spaces();
    return reply
      .code(404)
      .type("text/html")
      .send(notFound(SITE_TITLE, slug.replace(/^\/+/, ""), spaces, AUTH_USERNAME));
  }

  // Optional URL-slug change: rename the file/folder after the content is saved.
  let renamed: Awaited<ReturnType<typeof content.renamePage>> = null;
  const newLeaf = formString(req.body, "slug")?.trim();
  if (newLeaf) {
    try {
      renamed = await content.renamePage(page.slug, newLeaf);
    } catch (err) {
      const { html } = await renderEditPage(page.slug, {
        raw: markdown,
        error: `Saved the content, but could not change the URL: ${errorMessage(err)}`,
      });
      return reply.code(400).type("text/html").send(html);
    }
  }

  const didRename = renamed !== null && renamed.newSlug !== renamed.oldSlug;
  try {
    if (didRename) {
      await git.commitMovedPaths(
        renamed!.changedFsPaths,
        `Rename ${renamed!.oldSlug} to ${renamed!.newSlug} via web`
      );
    } else {
      await gitCommitPage(page.fsPath);
    }
  } catch (err) {
    const { html } = await renderEditPage(didRename ? renamed!.newSlug : page.slug, {
      raw: markdown,
      error: `Saved, but Git commit failed: ${errorMessage(err)}`,
    });
    return reply.code(500).type("text/html").send(html);
  }

  return reply.redirect(pagePath(didRename ? renamed!.newSlug : page.slug));
});

// Download a page's raw Markdown (frontmatter included) as an attachment.
app.get("/_download/*", async (req, reply) => {
  const slug = (req.params as { "*": string })["*"] ?? "";
  // A folder is a pure container — there is no document to download.
  if (await slugIsFolder(slug)) {
    const spaces = await content.spaces();
    return reply
      .code(404)
      .type("text/html")
      .send(notFound(SITE_TITLE, slug.replace(/^\/+/, ""), spaces, AUTH_USERNAME));
  }
  const page = await content.loadRaw(slug);
  if (!page) {
    const spaces = await content.spaces();
    return reply
      .code(404)
      .type("text/html")
      .send(notFound(SITE_TITLE, slug.replace(/^\/+/, ""), spaces, AUTH_USERNAME));
  }
  return reply
    .header(
      "content-disposition",
      `attachment; filename="${downloadFilename(page.slug)}"`
    )
    .type("text/markdown; charset=utf-8")
    .send(page.raw);
});

// Any page by slug (supports nested paths).
app.get("/*", async (req, reply) => {
  const slug = (req.params as { "*": string })["*"] ?? "";
  const { status, html } = await renderPage(slug);
  return reply.code(status).type("text/html").send(html);
});

try {
  await app.listen({ host: HOST, port: PORT });
  console.log(`KB viewer running at http://${HOST}:${PORT}  (content: ${KB_DIR})`);
} catch (err) {
  console.error(err);
  process.exit(1);
}
