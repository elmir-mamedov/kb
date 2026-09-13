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

Commit as you work. Every significant change — a feature, a fix, a refactor, a docs or content update — lands as its own commit once `npm run typecheck` and `npm test` pass. Do not leave finished work sitting uncommitted for someone else to stage, and do not roll unrelated changes into one commit. Stage deliberately with explicit paths (`git add app/src/views.ts`), not `git add -A`, so the diff matches the message. If the change belongs on a branch, branch first and then commit. Committing is expected; pushing is not — push only when asked.

Write messages as [Conventional Commits](https://www.conventionalcommits.org): `<type>(<scope>): <description>`. Commits made before this convention was adopted do not follow it; leave them alone and apply it going forward.

- **Type:** one of `feat`, `fix`, `docs`, `refactor`, `test`, `perf`, `chore`, `build`, `ci`, `revert`. Pick by what the change does to the product, not by which files it touches — a fix that only edits a test is still `test` if the behaviour did not change.
- **Scope:** optional but preferred, and it names the module or area rather than a path: `server`, `content`, `markdown`, `frontmatter`, `views`, `mcp`, `kb`.
- **Description:** imperative mood, lowercase, no trailing period, and keep the whole subject line under 72 characters. `feat(markdown): add =WxH image size syntax`, not `feat(markdown): Added =WxH image size syntax.`
- **Body:** separated from the subject by a blank line and wrapped at 72 characters. Say why the change was needed and what it does about it; the diff already shows how. Omit the body only when the subject genuinely says everything.
- **Breaking changes:** mark them with `!` before the colon (`feat(mcp)!: rename the token parameter`) and describe the break in a `BREAKING CHANGE:` footer.
- **Trailers:** none otherwise. Never add `Co-Authored-By`, `Generated with`, or any other attribution or tooling footer.

For knowledge-base auto-commits, `kb/README.md` documents the pattern `Update engineering/runbooks/deploy.md via web`.

Pull requests should include a short summary, verification steps, affected paths, and screenshots for UI changes. Link relevant issues or planning docs when applicable.

## Security & Configuration Tips

Configuration is via environment variables: `KB_DIR`, `PORT`, `HOST`, `SITE_TITLE`, the required `AUTH_USERNAME` / `AUTH_PASSWORD` / `AUTH_SESSION_SECRET`, and the optional `TRUST_PROXY`. The default `HOST=localhost` binds loopback only, so the viewer is reachable from this machine and nowhere else; keep it there. Sign-in is one static credential pair behind a failed-attempt cooldown, so a wider bind publishes a guessable form, in cleartext unless something in front of it terminates TLS. Do not commit secrets from `.env`.
