# KB Viewer

A lean web viewer/editor for the markdown knowledge base in `../kb`. Node +
TypeScript + Fastify. No build step — TypeScript runs directly via `tsx`.

## Run

```bash
cd app
npm install
npm run dev      # http://localhost:4000, auto-reloads on file changes
```

For the team on your LAN it already binds to `0.0.0.0`, so others reach it at
`http://<your-machine-ip>:4000`.

## Configuration (env vars)

| Var          | Default        | Meaning                                  |
|--------------|----------------|------------------------------------------|
| `KB_DIR`     | `../kb`        | Path to the content folder.              |
| `PORT`       | `4000`         | Port to listen on.                       |
| `HOST`       | `0.0.0.0`      | Bind address (`0.0.0.0` = LAN-visible).  |
| `SITE_TITLE` | `Knowledge Base` | Name shown in the sidebar/title.       |
| `AUTH_USERNAME` | required   | Username for browser sign-in.            |
| `AUTH_PASSWORD` | required   | Password for browser sign-in.            |
| `AUTH_SESSION_SECRET` | required | Secret used to sign session cookies. |

```bash
KB_DIR=/path/to/kb PORT=8080 SITE_TITLE="Team Wiki" npm start
```

## What it does

- Walks `kb/` and builds the sidebar tree (folder + `index.md` = a section).
- Requires sign-in before viewing or editing pages.
- Renders each `.md` page: frontmatter title + tags, markdown body, `[[wiki-links]]`,
  code highlighting.
- Shows the page's last-updated date from `git log` (falls back gracefully).
- Edits existing pages in the browser at `/_edit/<slug>`.
- Validates frontmatter before saving.
- Auto-commits saved page changes in the `kb/` Git repo as
  `Update <path>.md via web`.
- Serves attachments from `kb/_assets/` at `/_assets/...`.

## Scripts

- `npm run dev` — watch + reload.
- `npm start` — run once.
- `npm run typecheck` — type-check with `tsc --noEmit`.

## Not yet (later steps)

Search, page create/move/delete flows, and the MCP server.
