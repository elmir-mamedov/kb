import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Fastify, { type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import { Content } from "./content.js";
import { createRenderer } from "./markdown.js";
import { editLayout, layout, loginLayout, notFound } from "./views.js";

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
const AUTH_USERNAME = requireEnv("AUTH_USERNAME");
const AUTH_PASSWORD = requireEnv("AUTH_PASSWORD");
const AUTH_SESSION_SECRET = requireEnv("AUTH_SESSION_SECRET");
const SESSION_COOKIE = "kb_session";
const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

const content = new Content(KB_DIR);
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
  if (requestPath(req) === "/_login") return;
  if (currentUser(req)) return;

  const next = encodeURIComponent(req.url || "/");
  return reply.redirect(`/_login?next=${next}`, 303);
});

// Serve attachments from kb/_assets at /_assets/*
await app.register(fastifyStatic, {
  root: path.join(KB_DIR, "_assets"),
  prefix: "/_assets/",
  decorateReply: false,
});

/** Best-effort git commit date+time for a file; falls back to null. */
async function gitUpdated(fsPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["log", "-1", "--date=format:%Y-%m-%d %H:%M", "--format=%cd", "--", fsPath],
      { cwd: KB_DIR }
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function gitCommitPage(fsPath: string): Promise<string | null> {
  const relPath = path.relative(KB_DIR, fsPath);
  if (!relPath || relPath.startsWith("..") || path.isAbsolute(relPath)) {
    throw new Error("Refusing to commit a file outside the knowledge base.");
  }

  const rel = relPath.split(path.sep).join("/");
  const { stdout: status } = await execFileAsync(
    "git",
    ["status", "--porcelain", "--", rel],
    { cwd: KB_DIR }
  );
  if (!status.trim()) return null;

  const message = `Update ${rel} via web`;

  if (status
    .split("\n")
    .filter(Boolean)
    .some((line) => line.startsWith("??"))) {
    await execFileAsync("git", ["add", "--", rel], { cwd: KB_DIR });
    await execFileAsync("git", ["commit", "-m", message, "--", rel], { cwd: KB_DIR });
  } else {
    await execFileAsync("git", ["commit", "--only", "-m", message, "--", rel], {
      cwd: KB_DIR,
    });
  }

  const { stdout } = await execFileAsync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: KB_DIR,
  });
  return stdout.trim() || null;
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

async function renderPage(slug: string): Promise<{ status: number; html: string }> {
  const [tree, titles] = await Promise.all([content.tree(), content.titleIndex()]);
  const page = await content.load(slug);

  if (!page) {
    return {
      status: 404,
      html: notFound(SITE_TITLE, slug.replace(/^\/+/, ""), tree, AUTH_USERNAME),
    };
  }

  const md = createRenderer((s) => titles.get(s));
  const contentHtml = md.render(page.body);
  const updated = await gitUpdated(page.fsPath);

  const html = layout({
    siteTitle: SITE_TITLE,
    tree,
    activeSlug: page.slug,
    titles,
    title: page.data.title,
    tags: page.data.tags,
    contentHtml,
    updated,
    username: AUTH_USERNAME,
  });
  return { status: 200, html };
}

async function renderEditPage(
  slug: string,
  options: { raw?: string; error?: string; notice?: string } = {}
): Promise<{ status: number; html: string }> {
  const [tree, titles, page] = await Promise.all([
    content.tree(),
    content.titleIndex(),
    content.loadRaw(slug),
  ]);

  if (!page) {
    return {
      status: 404,
      html: notFound(SITE_TITLE, slug.replace(/^\/+/, ""), tree, AUTH_USERNAME),
    };
  }

  const fallbackTitle = page.slug.split("/").pop() || "Home";
  const html = editLayout({
    siteTitle: SITE_TITLE,
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

// Home: a real root index.md if present, else the first top-level page.
app.get("/", async (_req, reply) => {
  const rootPage = await content.resolve("");
  if (rootPage) {
    const { status, html } = await renderPage("");
    return reply.code(status).type("text/html").send(html);
  }
  const tree = await content.tree();
  const first = tree[0];
  if (first) return reply.redirect("/" + first.slug);
    return reply
      .code(200)
      .type("text/html")
      .send(notFound(SITE_TITLE, "", tree, AUTH_USERNAME));
});

app.get("/_edit/*", async (req, reply) => {
  const slug = (req.params as { "*": string })["*"] ?? "";
  const { status, html } = await renderEditPage(slug);
  return reply.code(status).type("text/html").send(html);
});

app.post("/_edit/*", async (req, reply) => {
  const slug = (req.params as { "*": string })["*"] ?? "";
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
    const tree = await content.tree();
    return reply
      .code(404)
      .type("text/html")
      .send(notFound(SITE_TITLE, slug.replace(/^\/+/, ""), tree, AUTH_USERNAME));
  }

  try {
    await gitCommitPage(page.fsPath);
  } catch (err) {
    const { html } = await renderEditPage(slug, {
      raw: markdown,
      error: `Saved, but Git commit failed: ${errorMessage(err)}`,
    });
    return reply.code(500).type("text/html").send(html);
  }

  return reply.redirect(pagePath(page.slug));
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
