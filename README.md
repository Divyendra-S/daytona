# AI Builder

An open-source AI app builder. Describe what you want, and AI Builder builds it for you in real time — complete with a live preview, terminals, and one-click publishing.

AI Builder runs on your machine; your projects do not. Every project gets its own [Daytona](https://daytona.io) sandbox — a private Linux container holding a Next.js app the agent edits, a hot-reloading dev server, and a production copy that publishing builds and serves. Your computer runs the chat, the UI and the preview proxy; each project's metadata, conversations and releases are rows in Postgres.

> **The agent works in a sandbox, not on your computer.** Its commands, its file edits and your terminal tabs all run inside the project's own container, so an agent mistake cannot touch your machine. Sandboxes stop themselves after 15 minutes idle and cost disk only while stopped.

## Features

- **Conversational app building** — Chat with an AI that writes, edits, and runs code in the project folder
- **Live preview & terminals** — Watch the app update as it is built, and open as many shells as you want
- **Publish and roll back** — Build the current code into a production copy; every release is a git commit to roll back to
- **Persistent projects** — Code, git history and conversations survive between sessions; an idle sandbox stops and resumes where it left off
- **Isolated execution** — Every project runs in its own container, so nothing the agent does reaches your machine
- **Import from GitHub** — Start a project from any public repository

## Tech Stack

- **Framework:** [Next.js](https://nextjs.org) (App Router, TypeScript, Turbopack)
- **AI:** [Vercel AI SDK](https://sdk.vercel.ai) via [OpenRouter](https://openrouter.ai)
- **Chat UI:** [assistant-ui](https://github.com/Yonom/assistant-ui)
- **Sandboxes:** [Daytona](https://daytona.io) (`@daytonaio/sdk`)
- **Terminals:** Daytona PTY sessions + [xterm.js](https://xtermjs.org)
- **Styling:** Tailwind CSS + shadcn/ui

## Getting Started

Needs Node.js, pnpm and git. Projects need a [Daytona](https://app.daytona.io) account — the free tier comes with $200 of credits and no credit card.

`.env.local`:

```
# Required: projects have nowhere to run without it
DAYTONA_API_KEY=dtn_...

# OpenRouter key (optional — visitors can add their own in the UI)
OPENROUTER_API_KEY=sk-or-...

# Postgres (Supabase) — where projects, conversations and releases are stored
DATABASE_URL=postgresql://...

# Deployed builds only: the hosts the API answers on, comma-separated.
# The API has no login of its own, so a deployed build must sit behind real
# access control. Unset, AI Builder answers this machine only.
APP_HOSTS=builder.example.com

# Deployed builds only: the domain the preview proxy in workers/preview-proxy
# is served on. Without it the preview loads Daytona's own host, which greets
# every load in an iframe with a warning page.
PREVIEW_PROXY_DOMAIN=preview.example.com
```

**Deploying to Cloudflare** — the app is a Worker, built by the OpenNext adapter. Locally, `pnpm deploy` builds and uploads it. In Cloudflare's own Workers Builds, set the **build command** to `pnpm run cf:build` and the **deploy command** to `npx wrangler deploy`: `opennextjs-cloudflare deploy` only uploads what a previous build produced, so running it alone fails with "Could not find compiled Open Next config". Note that `cf:build` is its own script because the adapter's build runs `pnpm run build` itself — pointing `build` at the adapter would call it in a loop.

**Deploying** needs one more piece than running locally: the preview proxy. Locally, `lib/preview-proxy.ts` fronts each sandbox from `127.0.0.1`; a browser elsewhere cannot reach that, and Daytona's own preview host shows a warning page that an iframe can never click past. `workers/preview-proxy` is the same proxy as a Cloudflare Worker on a wildcard hostname — `<sandbox>.preview.example.com` — that needs no secret, because the sandbox host it forwards to is already a signed, expiring one. Put the zone on Cloudflare, set the route in `workers/preview-proxy/wrangler.jsonc`, run `wrangler deploy` there, and set `PREVIEW_PROXY_DOMAIN` in the deployment.

```bash
pnpm install
pnpm db:push   # create the tables
pnpm dev
```

Projects that predate the database are brought in with `pnpm db:import`, which reads the `project.json` files still on disk.

Open [http://localhost:3000](http://localhost:3000) to start building. AI Builder only listens on `127.0.0.1`, and its API refuses requests from other sites.

## How a project works

Both folders live inside the project's sandbox, and both ports are the sandbox's own — every project uses the same two, because every project has its own network.

|           | Dev                              | Production                                         |
| --------- | -------------------------------- | -------------------------------------------------- |
| Folder    | `~/app` (a git repo)             | `~/production` (a clone of it)                     |
| Exists    | from the moment the project does | created by the first publish                       |
| Runs      | `npm run dev` on port 3000       | `npm run build`, then `npm run start` on port 3001 |
| Edited by | the agent                        | nothing — only publishes                           |

**Creating** a project provisions a sandbox, clones the [Next.js + shadcn template](https://github.com/freestyle-sh/freestyle-base-nextjs-shadcn) (or a GitHub repo), runs `npm install`, and starts the dev server — about ten seconds altogether.

**Publishing** commits everything in `app/`, checks that commit out in `production/`, reinstalls dependencies only if `package.json` or the lockfile changed, builds, and serves the build. **Rolling back** does the same with an earlier release's commit.

**Servers and terminals** live in the sandbox, not in AI Builder, so they survive AI Builder restarting: a dev server keeps running and a terminal tab reconnects to the shell it had. Opening a project wakes its sandbox if it went idle, which takes a few seconds and shows as "Waking the sandbox up…".

**The preview** is served through a small proxy on `127.0.0.1` rather than loaded from the sandbox directly. The proxy injects the click-to-select bridge, and it keeps the sandbox's preview token — which authenticates _every_ port of that sandbox — on the server, where the browser cannot reach it.

**State** — a project's metadata (including the id of its sandbox), its conversations and its releases are rows in Postgres (Supabase). The code itself lives in the sandbox, and nothing else lives on this machine.

**Sandbox housekeeping** — `node scripts/daytona-gc.mjs` lists every sandbox AI Builder has created and flags the ones no project points at any more; add `--delete` to remove them.

## Key files

- `lib/vars.ts` — the projects folder, template, sandbox ports, image and idle limits
- `lib/sandbox.ts` — the one way in to a project's sandbox: create, open, wake, preview URLs
- `lib/project-runtime.ts` — running commands in a sandbox, and creating a project
- `lib/project-storage.ts` — project metadata, conversations and releases, read and written in Postgres; `lib/db/schema.ts` — the tables
- `lib/terminal-bridge.ts` — sandbox ptys and server sessions, fanned out to browser tabs over SSE
- `lib/preview-proxy.ts` — the loopback proxy that fronts the sandbox and injects the preview bridge
- `lib/publish.ts` — building a release into production, and rolling back
- `lib/create-tools.ts` — the agent's tools; `lib/system-prompt.ts` — its instructions
- `lib/llm-provider.ts` — OpenRouter model setup
- `proxy.ts` — keeps the API to this machine's own pages (the entire auth model)
- `app/api/chat/route.ts` — chat endpoint
- `app/assistant.tsx` — chat interface and assistant runtime
- `app/[projectId]/project-workspace-shell.tsx` — preview, terminals, and publishing
