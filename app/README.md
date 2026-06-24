# KB Viewer (Step 2)

A lean read-only web viewer for the markdown knowledge base in `../kb`.
Node + TypeScript + Fastify. No build step — TypeScript runs directly via `tsx`.

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

```bash
KB_DIR=/path/to/kb PORT=8080 SITE_TITLE="Team Wiki" npm start
```

## What it does

- Walks `kb/` and builds the sidebar tree (folder + `index.md` = a section).
- Renders each `.md` page: frontmatter title + tags, markdown body, `[[wiki-links]]`,
  code highlighting.
- Shows the page's last-updated date from `git log` (falls back gracefully).
- Serves attachments from `kb/_assets/` at `/_assets/...`.

## Scripts

- `npm run dev` — watch + reload.
- `npm start` — run once.
- `npm run typecheck` — type-check with `tsc --noEmit`.

## Not yet (later steps)

Editing in the browser, auth, search, and the MCP server. This step is read-only.
