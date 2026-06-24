import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { Content } from "./content.js";
import { createRenderer } from "./markdown.js";
import { layout, notFound } from "./views.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- config ---------------------------------------------------------------
const KB_DIR = path.resolve(
  process.env.KB_DIR ?? path.join(__dirname, "..", "..", "kb")
);
const HOST = process.env.HOST ?? "0.0.0.0"; // bind for LAN access
const PORT = Number(process.env.PORT ?? 4000);
const SITE_TITLE = process.env.SITE_TITLE ?? "Knowledge Base";

const content = new Content(KB_DIR);
const app = Fastify({ logger: false });

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

async function renderPage(slug: string): Promise<{ status: number; html: string }> {
  const [tree, titles] = await Promise.all([content.tree(), content.titleIndex()]);
  const page = await content.load(slug);

  if (!page) {
    return { status: 404, html: notFound(SITE_TITLE, slug.replace(/^\/+/, ""), tree) };
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
  });
  return { status: 200, html };
}

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
    .send(notFound(SITE_TITLE, "", tree));
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
