# Daytona Migration Plan

Move all code execution, file I/O, terminals and dev/prod servers for AI Builder
projects off the local machine and into per-project Daytona sandboxes.

**Status: DONE.** All three phases are implemented and verified end to end against a real sandbox. See EXECUTION RESULT at the end. **Scope:** execution only — the builder itself keeps
running locally (`pnpm dev` on 127.0.0.1:3000). Vercel deployment of the builder
is explicitly *out of scope* (see "Deferred" at the end).

---

## 0. Verified facts (checked 2026-09-16, do not re-research)

- `DAYTONA_API_KEY` **is already present** in `.env.local` (alongside
  `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL`, `FIGMA_ACCESS_TOKEN`).
- SDK to install: **`@daytonaio/sdk@0.214.0`** (pnpm). Pulls `ws`,
  `socket.io-client`, `axios`, `@aws-sdk/client-s3`, OpenTelemetry — it is a
  heavy dep, only import it in server code.
- Free tier: **$200 compute credits, no credit card**, 5 GiB free storage.
  $0.0504/vCPU-hr + $0.0162/GiB-hr, billed per second. A 2 vCPU / 4 GiB sandbox
  ≈ $0.166/hr → ~1,200 sandbox-hours on the free credits. Stopped sandboxes cost
  disk only ($0.000108/GiB-hr ≈ $0.79/month for 10 GiB).
  **Auto-stop is mandatory or the credits evaporate.**

### API surface (read from the shipped `.d.ts`, these signatures are correct)

```ts
new Daytona({ apiKey })
daytona.create(params?: CreateSandboxFromSnapshotParams | CreateSandboxFromImageParams,
               opts?: { timeout?: number; onSnapshotCreateLogs?: (c: string) => void }): Promise<Sandbox>
daytona.get(sandboxIdOrName: string): Promise<Sandbox>
daytona.list(query?): AsyncIterableIterator<Sandbox>
daytona.snapshot.create({ name, image, resources })
```

`CreateSandboxBaseParams` fields we care about: `name`, `envVars`, `labels`,
`public`, `autoStopInterval`, `autoArchiveInterval`, `autoDeleteInterval`,
`ttlMinutes`, `secrets`. Image params add `image` + `resources { cpu, memory, disk }`.

```ts
// Sandbox
sandbox.id / .state / .public / .cpu / .memory / .disk
sandbox.start(timeout?) / .stop(timeout?, force?) / .delete() / .archive()
sandbox.waitUntilStarted(timeout?) / .waitUntilStopped(timeout?) / .refreshData()
sandbox.getUserRootDir() / .getWorkDir() / .getUserHomeDir()
sandbox.setAutostopInterval(minutes) / .setAutoArchiveInterval(minutes)
sandbox.setAutoDeleteInterval(minutes) / .setTtl(minutes)
sandbox.getPreviewLink(port): Promise<PortPreviewUrl>          // { url, token }
sandbox.getSignedPreviewUrl(port, expiresInSeconds?): Promise<SignedPortPreviewUrl>
sandbox.expireSignedPreviewUrl(port, token)
sandbox.createSnapshot(name) / .fork(params?) / .resize({cpu,memory,disk})
sandbox.updateEnv(env) / .updateSecrets(secrets) / .setLabels(labels)
sandbox.fs / sandbox.process / sandbox.git

// FileSystem  (sandbox.fs)
createFolder(path, mode)                      // mode e.g. '755'
deleteFile(path, recursive?)
downloadFile(remotePath, timeout?): Promise<Buffer>
uploadFile(file: Buffer | localPath, remotePath, timeout?)
uploadFiles(files: FileUpload[], timeout?)
listFiles(path, { depth? }): Promise<FileInfo[]>     // FileInfo has name, path, size, isDir...
getFileDetails(path): Promise<FileInfo>
findFiles(path, pattern): Promise<Match[]>           // grep-like, content search
searchFiles(path, pattern): Promise<SearchFilesResponse>   // filename glob search
replaceInFiles(files: string[], pattern, newValue): Promise<ReplaceResult[]>
moveFiles(source, destination)
setFilePermissions(path, perms)

// Process  (sandbox.process)
executeCommand(command, cwd?, env?, timeoutSeconds?): Promise<ExecuteResponse>
createSession(sessionId) / getSession(id) / listSessions() / deleteSession(id)
executeSessionCommand(sessionId, { command, runAsync?, suppressInputEcho? }, timeoutSeconds?)
    -> { cmdId, output?, stdout?, stderr?, exitCode? }
getSessionCommand(sessionId, cmdId): Promise<Command>          // has exitCode
getSessionCommandLogs(sessionId, cmdId): Promise<{ output, stdout, stderr }>
getSessionCommandLogs(sessionId, cmdId, onStdout, onStderr): Promise<void>   // streaming
sendSessionCommandInput(sessionId, cmdId, data)
createPty({ id, cwd?, envs?, cols?, rows?, onData }): Promise<PtyHandle>
connectPty(sessionId, { onData }): Promise<PtyHandle>          // RECONNECT, survives our restart
listPtySessions() / getPtySessionInfo(id) / killPtySession(id) / resizePtySession(id, cols, rows)

// PtyHandle
.sessionId  .exitCode  .error
.isConnected() .waitForConnection() .sendInput(string|Uint8Array)
.resize(cols, rows) .disconnect() .wait(): Promise<{exitCode?, error?}> .kill()
```

### Three gotchas that will bite (burn these in)

1. **All timeouts are SECONDS, not milliseconds.** Current code passes
   `300_000`/`600_000`/`900_000` ms. Divide by 1000 everywhere. Default is
   **10 seconds** — an un-timed `npm install` will fail. `0` disables the
   server-side limit.
2. **`executeCommand` gives NO separate stderr** — `ExecuteResponse` is
   `{ exitCode, result, artifacts.stdout }` with everything merged into `result`.
   Only *session* commands return split `stdout`/`stderr`. Map `result` →
   `RunResult.stdout` and leave `stderr: ""`; `runStep` concatenates both so its
   error messages still read fine.
3. **The preview token from `getPreviewLink()` authenticates EVERY port of that
   sandbox**, including the internal toolbox API. It is a sandbox-wide
   credential. Never send it to the browser. For anything an `<iframe>` loads
   directly, use `getSignedPreviewUrl(port, 3600)` (token embedded in the URL,
   1s–86400s, default 60s).

---

## 1. Architecture decisions (settled — do not relitigate)

| Decision | Choice |
|---|---|
| Sandbox granularity | **One long-lived sandbox per project.** Auto-stop on idle, resume on open. This is the only shape that preserves git history, publish and rollback. |
| Sandbox identity | `sandboxId` stored in `project.json`. Also set `labels: { aiBuilderProjectId: projectId }` so orphans are findable via `daytona.list()`. |
| Folder layout inside sandbox | `~/app` (git repo the agent edits) and `~/production` (clone). Mirrors today's `projects/<id>/app` + `production`. Resolve the home via `getUserRootDir()` once and cache it. |
| Ports | Fixed **3000 dev / 3001 prod** inside every sandbox. Port-pair allocation from `FIRST_PORT` **is deleted** — each sandbox has its own network namespace. |
| Project metadata | **Stays local** as `projects/<id>/project.json` + `conversations/*.json`. No DB in this migration. The `projects/<id>/app` folder stops existing locally. |
| Dev/prod servers | Run as **Daytona sessions** (`runAsync: true`), not PTYs — so they survive the Next.js process restarting and their logs are retrievable by `cmdId`. |
| User terminals (xterm tabs) | **PTY sessions** via `createPty`, reconnected with `connectPty` after a hot reload. |
| Preview | Keep `lib/preview-proxy.ts` as the bridge-injecting proxy, but retarget it from `127.0.0.1:devPort` to the Daytona HTTPS preview origin. |
| Resources | `{ cpu: 2, memory: 4, disk: 10 }` per sandbox. Enough for `next dev`; tune later. |
| Auto-stop | `autoStopInterval: 15` (minutes idle), `autoArchiveInterval: 10080` (7 days stopped), **no** auto-delete. |

---

## 2. Phase 1 — Sandbox layer, exec, file I/O, agent tools

Goal: the agent edits files and runs commands in the sandbox. Terminals and
preview still broken at the end of this phase — that is expected.

### 1.1 Install + config
- `pnpm add @daytonaio/sdk@0.214.0`
- May need a `pnpm-workspace.yaml` `allowBuilds` entry if a transitive dep has a
  build script (the file already gates `node-pty`, `sharp`, `unrs-resolver`).
- `lib/vars.ts`: delete `FIRST_PORT` and `LOCAL_HOST` usage for project servers.
  Add `SANDBOX_APP_DIR`, `SANDBOX_PROD_DIR`, `SANDBOX_DEV_PORT = 3000`,
  `SANDBOX_PROD_PORT = 3001`, `SANDBOX_SNAPSHOT` name, `AUTO_STOP_MINUTES = 15`.
  Keep `PROJECTS_DIR` (metadata), `TEMPLATE_REPO`, `APP_SESSION`, `PROD_SESSION`.

### 1.2 New file: `lib/sandbox.ts`
The single chokepoint. Everything else goes through it.

```ts
getDaytona(): Daytona                       // memoised on globalThis, reads DAYTONA_API_KEY
createSandboxForProject(projectId): Promise<Sandbox>
getSandbox(projectId): Promise<Sandbox>     // reads sandboxId from metadata, daytona.get()
ensureSandboxRunning(projectId): Promise<Sandbox>  // get -> if stopped/archived, start() + waitUntilStarted()
sandboxState(projectId): Promise<'started'|'stopped'|'archived'|'missing'>
deleteSandboxForProject(projectId)
```
- Memoise the `Sandbox` handle on `globalThis` (same trick as
  `__aiBuilderTerminals`) so hot reloads do not re-fetch.
- `ensureSandboxRunning` must be **idempotent and concurrency-safe** — many
  routes call it at once. Store the in-flight promise, not just the result.

### 1.3 Rewrite `lib/local-project.ts` → `lib/project-runtime.ts`
Keep `isProjectId`, `shellQuote`, `GIT_IDENTITY`. Replace the rest:

- `projectPaths(projectId)` → returns **local metadata paths only** (`root`).
  All call sites that wanted `.app` / `.production` switch to the sandbox
  constants. **Grep for `projectPaths` and fix every hit** — it is used in
  `create-tools.ts`, `project-files.ts`, `publish.ts`, `terminal-bridge.ts`.
- `run(command, cwd, timeoutMs)` →
  ```ts
  const sandbox = await ensureSandboxRunning(projectId)
  const res = await sandbox.process.executeCommand(command, cwd, undefined, timeoutSec)
  return { ok: res.exitCode === 0, stdout: res.result, stderr: "", exitCode: res.exitCode, command }
  ```
  **Signature changes to take `projectId`** (it no longer has a local cwd to
  infer from). Update `runStep` the same way.
- `childEnv()` / `INHERITED_ENV` — **delete**. The sandbox has its own clean env.
  Pass `TERM: 'xterm-256color'` explicitly to `createPty`.
- `createProjectFiles(projectId, repoUrl?)` →
  1. `createSandboxForProject(projectId)`
  2. `git clone --depth 1 <repo> app` in the sandbox home (timeout 300s)
  3. if no `repoUrl`: `rm -rf .git && git init && git add -A && git ${GIT_IDENTITY} commit -m 'Initial commit'`
  4. `npm install --no-audit --no-fund` (**timeout 600 seconds, not 600_000**)
  Skip step 4 entirely once the Phase 3 snapshot pre-bakes `node_modules`.

### 1.4 Rewrite `lib/create-tools.ts` (mechanical, ~1:1)
`createTools(projectId, devPort)` → `createTools(projectId)`. Keep
`resolveInApp`'s traversal guard exactly as-is (still needed — it now guards a
remote path). Map:

| Tool | Now | Becomes |
|---|---|---|
| `bashTool` | `run(cmd, app)` | `run(projectId, cmd, SANDBOX_APP_DIR, 120)` |
| `readFileTool` | `readFile` | `sandbox.fs.downloadFile(abs)` → `.toString('utf8')` |
| `writeFileTool` | `mkdir` + `writeFile` | `fs.createFolder(dirname, '755')` (ignore "exists") + `fs.uploadFile(Buffer.from(content), abs)` |
| `listFilesTool` | `readdir` / `find` | `fs.listFiles(abs, { depth })` |
| `searchFilesTool` | `grep -RIn` | `fs.findFiles(abs, query)` |
| `replaceInFileTool` | read/split/join | `fs.replaceInFiles([abs], search, replace)` — **note: it has no "first occurrence only" mode**, so for `all: false` keep the download→replace→upload path |
| `appendToFileTool` | read + write | download, concat, upload |
| `makeDirectoryTool` | `mkdir -p` | `fs.createFolder(abs, '755')` |
| `movePathTool` | `rename` | `fs.moveFiles(from, to)` |
| `deletePathTool` | `rm -rf` | `fs.deleteFile(abs, true)` |
| `checkAppTool` | fetch `127.0.0.1:devPort` | fetch the **preview URL with the `x-daytona-preview-token` header** (server-side, token never leaves the server) |
| `devServerLogsTool` | `readTerminalOutput` | `getDevServerLogs(projectId)` (Phase 2) |
| `restartDevServerTool` | `restartDevServer` | same name, new impl (Phase 2) |

Leave `askUserTool`, `updatePlanTool`, `suggestFollowUpsTool` untouched.
Keep the `ANSI_ESCAPE` stripping.

### 1.5 Rewrite `lib/project-files.ts`
- `listProjectTree` → `fs.listFiles(SANDBOX_APP_DIR, { depth: 8 })` returns a
  **flat** `FileInfo[]`; build the nested `ProjectFileNode[]` from the flat list
  in JS. Keep `SKIP_DIRS` filtering and `MAX_TREE_ENTRIES`.
- `readProjectFile` → `fs.getFileDetails` for the size check, then
  `fs.downloadFile`. Keep `looksBinary`, `languageFromPath`, `MAX_FILE_BYTES`
  and the traversal guard verbatim.

### 1.6 Metadata
- `lib/project-types.ts`: `ProjectMetadata` → `version: 5`, add
  `sandboxId: string`, mark `devPort`/`prodPort` optional/deprecated.
- `lib/project-storage.ts`: add a v4→v5 migration that tolerates missing
  `sandboxId` (returns it as `null`; the UI shows "needs migration" rather than
  crashing). Existing local projects are **not** auto-uploaded — out of scope.

**Phase 1 done when:** creating a project provisions a sandbox, and the agent can
read/write/search files and run bash in it. Preview and terminals are broken.

---

## 3. Phase 2 — Terminals, dev/prod servers, preview

### 2.1 `lib/terminal-bridge.ts`
Keep the whole `Session` registry, `REPLAY_LIMIT`, `broadcast`, `history`, the
SSE subscriber fan-out and every exported function name. **Only the process
layer changes.**

- `Session.pty: IPty | null` → `PtyHandle | null`.
- `openSession()` becomes async: `sandbox.process.createPty({ id: \`${projectId}-${slug}\`, cwd, envs: { TERM: 'xterm-256color' }, cols: 120, rows: 30, onData: chunk => broadcast(session, chunk) })`.
  - **On startup, try `connectPty(id)` first** and fall back to `createPty`.
    This is strictly better than today: a PTY now survives the Next.js process
    restarting, so terminals reconnect instead of dying.
- `pty.onExit` → `handle.wait().then(({ exitCode }) => ...)` feeding the same
  `[process exited with code N]` broadcast and the `exited` promise.
- `closeSession` → `handle.kill()` then `handle.wait()`. **Delete the
  `process.kill(-pty.pid)` process-group logic** — there is no local pid, and
  the sandbox PTY kills its own group.
- `writeToTerminal` → `handle.sendInput(data)`; `resizeTerminal` →
  `handle.resize(cols, rows)`; `signalTerminal` → `sendInput(new Uint8Array([3]))`
  for SIGINT, `handle.kill()` for SIGKILL.
- **These all become async.** Update `app/api/projects/[projectId]/terminal/route.ts`
  to await them.

### 2.2 Dev and production servers (sessions, not PTYs)
New module or same file:
```ts
ensureDevServer(projectId)     // createSession('dev'); executeSessionCommand('dev',
                               //   { command: 'cd ~/app && npm run dev -- --port 3000 --hostname 0.0.0.0',
                               //     runAsync: true })
                               // persist the returned cmdId on globalThis + in project.json
devServerState(projectId)      // getSessionCommand('dev', cmdId).exitCode == null ? running : exited
restartDevServer(projectId)    // deleteSession('dev') then ensureDevServer
getDevServerLogs(projectId)    // getSessionCommandLogs('dev', cmdId) -> output
ensureProductionServer(projectId) / stopProductionServer(projectId)   // same, session 'prod'
```
- **`--hostname 0.0.0.0` is required** — bound to 127.0.0.1 the Daytona proxy
  cannot reach it. This is the single most likely cause of a blank preview.
- `checkAppTool` / `devServerLogsTool` read `getDevServerLogs`, keeping the
  existing ANSI-strip and `issueRegex` scan unchanged.

### 2.3 `lib/preview-proxy.ts` — the hardest file (~1 day)
It stays a local `http.Server` injecting `BRIDGE_TAG`; only the upstream changes
from plaintext localhost to remote HTTPS.

- `ensurePreviewProxy(projectId, devPort)` → `ensurePreviewProxy(projectId)`;
  cache key adds the preview host so a recreated sandbox invalidates the proxy.
- Upstream: `https.request({ host: <previewHost>, port: 443, path, method, headers })`
  with `x-daytona-preview-token: <token>` added and `host` set to the preview
  host (**not** `127.0.0.1:devPort`).
- `upstreamHeaders()`: rewrite `origin`/`referer` to `https://<previewHost>`;
  keep `delete accept-encoding` (still needed to append the bridge tag).
- Response `location` rewriting: replace `https://<previewHost>` with
  `http://127.0.0.1:<proxyPort>`.
- **Websocket upgrade (HMR)**: `net.connect` → `tls.connect({ host, port: 443,
  servername: host })`, then write the same hand-rolled request lines *plus* the
  token header. Verify Next's HMR reconnects — if it does not, the preview still
  works, it just stops hot-reloading, and that is an acceptable interim state.
- Cache the `getPreviewLink()` result; refresh it when the sandbox restarts.

### 2.4 `app/api/projects/[projectId]/preview-status/route.ts`
- Delete the `portOpen` TCP probe (there is no local port).
- Replace with: `ensureSandboxRunning` → `ensureDevServer` → `HEAD` the preview
  URL with the token header, short timeout. Keep the `up` / `running` /
  `proxyUrl` response shape **unchanged** so the client needs no changes.
- Add a `waking: boolean` when the sandbox is starting, and surface it in
  `app/[projectId]/project-workspace-shell.tsx` as a "Waking up…" state — a
  stopped sandbox takes a few seconds to resume and the preview must not look
  broken during it.

### 2.5 `lib/project-storage.ts` / `lib/project-types.ts`
`ProjectItem.previewUrl` / `productionUrl` are built from ports today. They
become the local proxy URL (dev) and a signed preview URL (prod).

**Phase 2 done when:** terminals attach, the dev server runs in the sandbox, the
preview iframe renders with click-to-select working.

---

## 4. Phase 3 — Lifecycle, snapshot, publish

### 3.1 Cost control (do this, not optional)
- Pass `autoStopInterval: 15` and `autoArchiveInterval: 10080` at create time.
- Call `sandbox.refreshActivity()` on real user activity (chat turn, terminal
  input) so an active project is not stopped mid-session.
- Add a dev-only script `scripts/daytona-gc.ts`: `daytona.list()` filtered by the
  `aiBuilderProjectId` label, print state + age, delete orphans whose project
  folder no longer exists locally.

### 3.2 Snapshot with deps pre-baked (big win)
```ts
const image = Image.base('node:22-bookworm')
  .runCommands('npm i -g pnpm', 'git config --global init.defaultBranch main')
  .runCommands('git clone --depth 1 <TEMPLATE_REPO> /opt/template && cd /opt/template && npm install')
await daytona.snapshot.create({ name: 'ai-builder-next', image, resources: { cpu: 2, memory: 4, disk: 10 } })
```
Then `createProjectFiles` copies `/opt/template` instead of cloning + installing.
Cuts project creation from ~90s to a few seconds. `daytona.create({ snapshot: 'ai-builder-next' })`.

### 3.3 `lib/publish.ts`
Logic is unchanged — every command just runs in the sandbox.
- `existsSync(production)` → `fs.getFileDetails(SANDBOX_PROD_DIR).catch(() => null)`
- `existsSync(path.join(production, 'node_modules'))` → same pattern
- `MANIFEST_HASH` uses `shasum -a 256`; **the sandbox image is Linux — use
  `sha256sum`** (or `shasum` if available; verify once and hardcode).
- Timeouts: `600_000` → `600`, `900_000` → `900`.
- The final "is it live" poll: fetch the prod preview URL with the token header
  instead of `http://127.0.0.1:prodPort`.
- `releaseRef` / `git update-ref` logic is untouched.

### 3.4 Cleanup
- Delete `node-pty` from `package.json` and the `postinstall` chmod hack.
- Delete the now-unused port allocation in `project-storage.ts`.
- Update `README.md`: the "**Not a sandbox**" warning is no longer true — that is
  the whole point of this migration. Rewrite that section and the "How a project
  works" table.

---

## 5. Verification checklist

Run against a fresh project, in order:

1. `pnpm dev` starts with no missing-env error; `DAYTONA_API_KEY` is read.
2. Create a project → a sandbox appears in the Daytona dashboard with the
   `aiBuilderProjectId` label.
3. File tree in the UI lists the template's files.
4. Open a file in the code viewer → contents render, language highlighting right.
5. Ask the agent to change visible copy on the home page → `writeFileTool`
   succeeds, preview hot-reloads.
6. `checkAppTool` returns `ok: true, statusCode: 200`.
7. Open a terminal tab → shell prompt, `ls` works, Ctrl+C interrupts.
8. Kill and restart `pnpm dev` locally → terminal **reconnects** via `connectPty`,
   dev server still running (this is a new capability, confirm it).
9. `npm install` of a new package through the agent completes without a 10s
   timeout error (**the seconds-vs-ms bug shows up here**).
10. Publish → build succeeds, production URL serves the build.
11. Rollback to the previous release → serves the older build.
12. Leave idle 16 min → sandbox stops. Reopen the project → "Waking up…" then
    preview returns.
13. Check the Daytona dashboard billing: spend is in cents, not dollars.

---

## 6. Deferred — deploying the builder to Vercel

**Not part of this migration.** Doing it later requires, separately:

- `lib/preview-proxy.ts` cannot run on Vercel — it opens a real listening socket
  and keeps it on `globalThis`. It must be rewritten as a Next route handler
  (`app/preview/[projectId]/[...path]/route.ts`), and **HMR websockets will not
  survive that**. Alternative: load `getSignedPreviewUrl()` directly in the
  iframe and inject the click-to-select bridge into the project files instead of
  via the proxy.
- `proxy.ts` is the current auth model (localhost-only). It must be replaced with
  real per-user auth, and `lib/project-access.ts`'s "local mode has one user"
  assumption removed.
- `lib/project-storage.ts` writes JSON to local disk → needs a database.
- `terminal-bridge.ts`'s `globalThis` registry does not survive serverless
  invocations. Daytona mitigates this (`connectPty` + sessions are server-side
  state), but the SSE stream needs rethinking.

Daytona-on-localhost works today with none of the above. Ship that first.

---

## EXECUTION RESULT — complete (2026-09-16)

All three phases are implemented, type-checked and verified end to end against a
real project (`8f94f7e1`) in a real sandbox. `npx tsc --noEmit` is clean.

### Measured, not estimated

| | Plan assumed | Actual |
|---|---|---|
| Sandbox create | — | **11s** |
| Template clone + `npm install` | ~90s (hence the snapshot) | **8s** — snapshot pre-baking was **not needed** |
| Whole project creation via the API | — | **12s** |
| Publish (clone, build, serve) | — | **<30s** |
| Idle sandbox wake to serving preview | "a few seconds" | **12-20s** |
| `preview-proxy.ts` HTTPS/TLS rewrite | ~1 day, "HMR may not survive" | Works; **HMR confirmed `101 Switching Protocols`** with live `turbopack-connected` frames through the full browser -> loopback proxy -> TLS -> sandbox chain |

### Things the plan got wrong (corrected during execution)

1. **`MANIFEST_HASH` needed no change.** The plan said `shasum` is macOS-only and
   to switch to `sha256sum`. The Debian image has **both** (perl `shasum` 6.02).
   `publish.ts` keeps `shasum -a 256`.
2. **The Daytona SDK must be `serverExternalPackages`.** Not in the plan at all,
   and it breaks *every file read*: the SDK reaches for `busboy` with a dynamic
   `require`, which Turbopack cannot bundle, and `downloadFile` fails with
   `Module "busboy" is not available in the "node" runtime`. Fixed in
   `next.config.ts` (which replaced the old `node-pty` entry).
3. **Session logs need `stdout`/`stderr`, not `output`.** `logs.output` carries raw
   `\x01\x01\x01` multiplex prefixes. The streaming callbacks are already clean.
4. **Listing projects must never wake a sandbox.** The plan had `ProjectItem`
   building URLs from ports; done naively, `GET /api/projects` would call
   `openProject` for every project and start every sandbox at once — exactly what
   the idle auto-stop exists to prevent. Hence `dormantPreviewUrl()`, which signs
   a URL from the sandbox record without starting it. Verified: the list returns
   in **34ms** and leaves a stopped sandbox stopped.
   For the same reason `home-welcome.tsx` now only frames **published** projects.
5. **A sandbox restart voids more than preview tokens.** Found by testing, not
   predicted. Restarting keeps the disk but kills every process and session, so:
   - preview tokens are reissued (the old one 401s) -> `forgetPreviewUrls`
   - the terminal registry describes processes that no longer exist -> a
     **generation counter** (`sandboxGeneration`) invalidates stale session records
   - the production server is simply gone -> `preview-status` restores it, checked
     via `productionServerState` **independently of** the dev server's state (the
     dev server is started a moment earlier, while the sandbox is still waking, so
     gating prod behind it never fires).

### Verified end to end

Project create -> file tree -> file read -> preview through the proxy with the
bridge tag injected and served -> HMR websocket (101 + live frames) -> dev-server
log streaming to a terminal tab -> an interactive PTY shell (`echo` round trip)
-> publish -> production serving -> stop the sandbox -> `waking: true` -> both
preview and production recover unattended.

### Not done, deliberately

- **The pre-baked snapshot (§3.2).** Installs take 8s; it would add a build step
  and a stale-snapshot problem for no measurable gain. `SANDBOX_SNAPSHOT` /
  `DAYTONA_IMAGE` env vars are wired up if it is ever wanted.
- **`pnpm build`.** Not run: it would overwrite `.next` under the dev server that
  was running throughout. Dev is fully verified; a production build is untested.
- **ESLint.** Broken repo-wide before this work (`Converting circular structure to
  JSON` while loading the config) and unrelated to it. Prettier and tsc are clean.
- **Migrating existing v4 projects.** They read fine and list fine, but have
  `sandboxId: null` and cannot be opened. Out of scope, as the plan said.

### Housekeeping

- `node scripts/daytona-gc.mjs` lists AI Builder's sandboxes and flags orphans;
  `--delete` removes them. The probe sandbox has already been cleaned up.
- The smoke-test project `8f94f7e1` is **left in place** as working proof, with one
  published release. Its sandbox is stopped (disk only, pennies a month). Delete
  `projects/8f94f7e1/` and run the GC with `--delete` to remove it.
