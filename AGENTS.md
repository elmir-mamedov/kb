# Repository Guidelines

## Project Structure & Module Organization

This repository contains a lean Markdown knowledge-base viewer. Application code lives in `app/src/` and is organized by responsibility: `server.ts` wires Fastify routes and configuration, `content.ts` reads the knowledge-base tree, `frontmatter.ts` parses page metadata, `markdown.ts` renders Markdown, and `views.ts` builds HTML. Runtime package files are in `app/`.

Knowledge-base content lives in `kb/`. Each top-level folder under `kb/` is a **space** and its own git repo (`kb/<space>/.git`); `kb/` itself is not versioned. Folders are navigation sections, `index.md` files are section landing pages, and leaf pages use lowercase hyphenated filenames such as `kb/engineering/runbooks/deploy.md`. Assets belong under each space's own `kb/<space>/_assets/` and are referenced with the portable relative form `_assets/file.png` (rewritten to `/<space>/_assets/file.png` at render time). Root files such as `first-step.md` and `knowledge-base-plan.md` are planning/spec notes.

## Build, Test, and Development Commands

Run commands from `app/`:

- `npm install` installs runtime and TypeScript tooling.
- `npm run dev` starts the viewer with `tsx watch` at `http://localhost:4000`.
- `npm start` runs the server once without watch mode.
- `npm run typecheck` runs `tsc --noEmit`; use this as the primary verification step.

There is no separate build step; TypeScript runs directly through `tsx`.

## Coding Style & Naming Conventions

Use TypeScript ES modules, strict types, semicolons, double quotes, and two-space indentation to match the existing code. Keep modules small and focused. Prefer Node standard-library APIs and existing local helpers before adding dependencies.

For content, use lowercase hyphenated Markdown filenames because paths become URLs. Put display titles and optional tags in YAML frontmatter; do not encode human-readable titles in filenames.

## Testing Guidelines

Tests use Node's built-in runner (`node:test`) executed through `tsx`; run them with `npm test` from `app/`. Test files live next to the code they cover as `src/*.test.ts`, and shared setup (throwaway KB dirs, git identity) is in `src/test-helpers.ts`. No extra dependencies are required. Before submitting code, run `npm run typecheck` and `npm test`, and manually smoke-test key routes with `npm run dev`.

## Commit & Pull Request Guidelines

No root Git history is available in this checkout, so no repository-wide commit convention can be inferred. Use concise, imperative commit messages, for example `Add markdown link rendering`. For knowledge-base auto-commits, `kb/README.md` documents the pattern `Update engineering/runbooks/deploy.md via web`.

Pull requests should include a short summary, verification steps, affected paths, and screenshots for UI changes. Link relevant issues or planning docs when applicable.

## Security & Configuration Tips

Configuration is via environment variables: `KB_DIR`, `PORT`, `HOST`, and `SITE_TITLE`. The default `HOST=0.0.0.0` is LAN-visible; use `HOST=127.0.0.1` for local-only work. Do not commit secrets from `.env`.
