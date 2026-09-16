# AI Builder

An open-source AI app builder. Describe what you want, and AI Builder builds it for you in real time — complete with a live preview, terminals, and one-click publishing.

Everything runs on your own machine. Every project is a folder under `projects/`: a Next.js app the agent edits, served by a hot-reloading dev server on its own port, and a production copy that publishing builds and serves on the next port.

> **Not a sandbox.** The agent's commands and the terminals run directly on your computer, as you. Only run AI Builder on a machine you're comfortable giving an AI shell access to.

## Features

- **Conversational app building** — Chat with an AI that writes, edits, and runs code in the project folder
- **Live preview & terminals** — Watch the app update as it is built, and open as many shells as you want
- **Publish and roll back** — Build the current code into a production copy; every release is a git commit to roll back to
- **Persistent projects** — Code, conversations and history stay in the project folder between sessions
- **Import from GitHub** — Start a project from any public repository

## Tech Stack

- **Framework:** [Next.js](https://nextjs.org) (App Router, TypeScript, Turbopack)
- **AI:** [Vercel AI SDK](https://sdk.vercel.ai) via [OpenRouter](https://openrouter.ai)
- **Chat UI:** [assistant-ui](https://github.com/Yonom/assistant-ui)
- **Terminals:** [node-pty](https://github.com/microsoft/node-pty) + [xterm.js](https://xtermjs.org)
- **Styling:** Tailwind CSS + shadcn/ui

## Getting Started

Needs Node.js, pnpm, npm and git.

`.env`:

```
# OpenRouter key (optional — visitors can add their own in the UI)
OPENROUTER_API_KEY=sk-or-...
```

```bash
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) to start building. AI Builder only listens on `127.0.0.1`, and its API refuses requests from other sites.

## How a project works

| | Dev | Production |
|---|---|---|
| Folder | `projects/<id>/app` (a git repo) | `projects/<id>/production` (a clone of it) |
| Exists | from the moment the project does | created by the first publish |
| Runs | `npm run dev` | `npm run build`, then `npm run start` |
| Address | `http://127.0.0.1:<devPort>` | `http://127.0.0.1:<devPort + 1>` |
| Edited by | the agent | nothing — only publishes |

**Creating** a project clones the [Next.js + shadcn template](https://github.com/freestyle-sh/freestyle-base-nextjs-shadcn) (or a GitHub repo), runs `npm install`, and starts the dev server. Ports are handed out in pairs from 4000.

**Publishing** commits everything in `app/`, checks that commit out in `production/`, reinstalls dependencies only if `package.json` or the lockfile changed, builds, and serves the build. **Rolling back** does the same with an earlier release's commit.

**Servers** run in terminal sessions held by AI Builder, so they stop when AI Builder stops. Opening a project starts its dev server again — and its production server, if it has been published.

**State** — a project's metadata is `projects/<id>/project.json`, and each conversation is `projects/<id>/conversations/<id>.json`. There is no database.

## Key files

- `lib/vars.ts` — the projects folder, template, ports and session names
- `lib/local-project.ts` — project folders, running commands, creating a project
- `lib/project-storage.ts` — project metadata and conversations, stored as JSON files
- `lib/terminal-bridge.ts` — pty sessions fanned out to browser tabs, and the dev/production servers
- `lib/publish.ts` — building a release into production, and rolling back
- `lib/create-tools.ts` — the agent's tools; `lib/system-prompt.ts` — its instructions
- `lib/llm-provider.ts` — OpenRouter model setup
- `proxy.ts` — keeps the API to this machine's own pages
- `app/api/chat/route.ts` — chat endpoint
- `app/assistant.tsx` — chat interface and assistant runtime
- `app/[projectId]/project-workspace-shell.tsx` — preview, terminals, and publishing
