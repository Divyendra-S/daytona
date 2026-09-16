# TODO

Outstanding work in this codebase. Written 2026-09-16.
Each item says **what**, **why**, **where**, **done when**, and a rough size (S ≈ under an hour,
M ≈ half a day, L ≈ a day or more).

Status of the two features most recently worked on:

- **Token efficiency** — the first pass is in (stale reasoning dropped, tool output capped, stable
  cached prefix, cache breakpoint + `session_id`). Measured on the largest saved conversation the
  provider-bound payload fell ~84% (≈1.25M → ≈196k estimated tokens). What remains is verification
  and the follow-ups below.
- **Publish → shareable subdomain** — researched, not built. Today `publishProject` only serves the
  built app on `127.0.0.1:<prodPort>`; nothing leaves the machine.

---

## 0. Decisions needed (block the items that reference them)

- [ ] **Default model.** Stay on `qwen/qwen3.8-flash` or switch to `deepseek/deepseek-v4-flash`?
      DeepSeek is 1.7× cheaper in / 2.7× cheaper out (OpenRouter pricing, 2026-09-16), has a real
      1M context vs Qwen's 262k practical cap, and its prompt caching is both documented and priced
      — Qwen's is not (docs omit it, the API prices it). Affects `lib/models.ts` only.
- [ ] **Publish route.** A domain on Cloudflare (stable `*.apps.<domain>` links) or the no-account
      quick-tunnel fallback (random URL per restart, 200 concurrent requests, no SSE)?

---

## 1. Token efficiency & response speed

- [ ] **Confirm prompt caching actually hits.** (S, needs one live chat turn)
      Send two messages in one conversation on a caching model (Claude Sonnet 5 / Gemini / DeepSeek)
      and read the per-message footer: on the second, cost should fall sharply while input tokens
      stay similar. OpenRouter returns `prompt_tokens_details.cached_tokens`; surface it in
      `turnMetadata` (`lib/llm-provider.ts`) so the footer can show "cached" explicitly.
      *Done when* a follow-up turn shows a cached-token count > 0 and the lower price.
- [ ] **Test Qwen caching, then decide its gate.** (S)
      Caching is currently disabled for `qwen/` in `CACHING_PROVIDERS` because the docs and the
      pricing API disagree. One live request with `cache_control` on a Qwen turn settles it: if the
      provider accepts it, add the prefix; if it errors, leave the gate and note why in the comment.
- [ ] **Count `providerOptions` in the context budget.** (S)
      `charsOf` in `lib/llm-provider.ts` measures `message.content` only. Settled turns no longer
      carry `reasoning_details`, but the in-flight turn's are still unbudgeted, so a very long single
      turn can exceed the real limit. Include a serialised size of `providerOptions` per message.
- [ ] **Summarise instead of dropping, for long conversations.** (M)
      `fitContext` currently trims the middle. For very long sessions, replace the dropped span with
      a short model-written summary (one cheap call, cached with the conversation) so the agent keeps
      the thread of what it already did. Only worth it if you hit the budget regularly.
- [ ] **Re-measure after any of the above.** (S)
      Keep the measurement script pattern: load a real conversation from
      `projects/*/conversations/*.json`, run `toProviderMessages` + `fitContext`, print the per-bucket
      split. Consider committing it as `scripts/measure-context.mjs` so numbers stay comparable.
- [ ] **Perceived speed.** (S)
      Nothing in the current stack makes tokens arrive sooner (`smoothStream` deliberately delays
      them). The real wins left are fewer steps per turn and a faster model; revisit
      `stopWhen: stepCountIs(100)` in `lib/llm-provider.ts` once you see typical step counts in the
      footer.

## 2. Publish → shareable subdomain link

Primary plan (needs the Cloudflare decision above). One named tunnel with a wildcard hostname
serves every project, so publishing needs no per-project API call and links survive restarts.

- [ ] **One-time setup, scripted.** (M)
      `cloudflared tunnel login` → create tunnel → ingress `*.apps.<domain>` → one proxied wildcard
      CNAME. Store tunnel name/id and base domain in `.env.local`; document it in `README.md`.
      Run `cloudflared` as one more `terminal-bridge` session on boot (`lib/terminal-bridge.ts`),
      so it restarts with the app and its output is visible in a terminal tab.
- [ ] **Give each project a subdomain.** (S)
      Add `subdomain: string` to `ProjectMetadata` (`lib/project-types.ts`), set at creation in
      `app/api/projects/route.ts` (e.g. `<name-slug>-<id>`), and expose `publicUrl` next to
      `productionUrl` in `toProjectItem`. Keep it stable for the life of the project.
- [ ] **Host-header router.** (M)
      One local HTTP server that maps `sub.apps.<domain>` → that project's `prodPort`, reusing the
      proxy already written in `lib/preview-proxy.ts` (it forwards requests and websockets and
      rewrites Host). The tunnel points at this router, not at any project port directly.
- [ ] **Show the link on publish.** (S)
      In `components/assistant-ui/publish-dialog.tsx`, show the public URL with a copy button and an
      "opens for anyone" note once a release is live. The URL exists before the build finishes, so it
      can appear immediately with a "building…" state.
- [ ] **Unpublish / teardown.** (S)
      Stop serving a subdomain when the project is deleted or unpublished — the router simply stops
      mapping it; no DNS call needed. Make sure `stopProductionServer` and the router agree.
- [ ] **Fallback: quick tunnel.** (M)
      With no domain configured, run `cloudflared tunnel --url http://127.0.0.1:<prodPort>` per
      published project, scrape the `https://*.trycloudflare.com` URL from its output, store it in
      `project.json`, and close the session on unpublish. Document the limits: new URL each restart,
      200 concurrent requests, no server-sent events, "testing and development only" per Cloudflare.

## 3. Security before anything is public

- [ ] **Never expose Adorable's own port.** (S — do this with §2)
      Only the project's production port may be tunnelled. Port 3000 hosts
      `/api/projects/[projectId]/terminal`, an unauthenticated shell guarded solely by an 8-hex id
      and `proxy.ts`'s localhost Host check. Add a comment/assertion at the tunnel call site.
- [ ] **Strip secrets from the production clone.** (S)
      `shipToProduction` (`lib/publish.ts`) clones the project repo; any `.env*` the agent wrote
      would ship with it. Exclude `.env*` from the production checkout and fail loudly if
      `NEXT_PUBLIC_*` contains anything that looks like a key.
- [ ] **Protect published apps by default.** (M)
      Put a Cloudflare Access policy (or at least a shared-secret header) in front of published
      subdomains, with a deliberate "make public" action in the publish dialog.
- [ ] **Publish scratch folders stay out of releases.** (S)
      `lib/git-exclude.ts` excludes `.figma/` and `.adorable/` going forward, but
      `projects/70d192c9/app` already has 3 committed `.figma/` files. Remove them with
      `git rm --cached` in that project repo so they don't ship.

## 4. Correctness and robustness

- [ ] **ESLint is broken repo-wide.** (S)
      `npx eslint` dies with a circular-structure `TypeError` while loading the config, on untouched
      files. Nothing is being linted today. Fix `eslint.config.mjs` / `@eslint/eslintrc` versions, or
      drop the legacy config path.
- [ ] **No tests at all.** (M)
      The riskiest logic is pure and easy to cover: `fitContext` / `toProviderMessages`
      (`lib/llm-provider.ts`), `editsBrief` (`lib/edit-queue.ts`), the design route's section
      detection and SVG placeholder round-trip, and `snapshotOf` (`components/figma-canvas.tsx`).
      Node's built-in test runner is enough; add a `test` script.
- [ ] **Browser-verify this session's UI work.** (M)
      Built but never clicked through: click-to-select on the preview, the queued-changes flow
      (Steer / remove / one-by-one sending), the @ file picker, / commands, dictation, the model
      picker, Approval Card questions, Task Rows plans and follow-up chips.
- [ ] **Figma images need a valid token.** (S)
      `FIGMA_ACCESS_TOKEN` in `.env.local` is rejected by Figma ("Invalid token"), so pasted designs
      get placeholder images. Generate a personal access token with *File content: Read-only* and
      replace it; re-run a Replace/prompt to pull the images in.
- [ ] **Preview proxy backpressure.** (S)
      `lib/preview-proxy.ts` writes upstream chunks without honouring backpressure (noted in a
      `ponytail:` comment). Fine locally; fix if previews ever serve anything large.
- [ ] **Publish depends on the project's own git repo.** (S)
      `publishProject` commits in `projects/<id>/app`. After the recent folder rename, confirm each
      project still has its `.git` and that `git -C projects/<id>/app status` is clean enough to
      publish.

## 5. Housekeeping

- [ ] **Commit the current working tree.** (S)
      `package.json` is untracked after being restored (a bb auto-commit recorded its deletion);
      `lib/llm-provider.ts`, `lib/create-tools.ts`, `app/api/chat/route.ts` and others are modified.
- [ ] **Delete the empty `~/Documents/Adorable` folder** left behind by the rename to `runobi`. (S)
- [ ] **Finish or park the Postgres migration.** (M — started outside this session)
      `drizzle.config.ts`, `drizzle/`, `lib/db/{client,schema}.ts`,
      `components/assistant-ui/project-history.tsx` and the `db:push` / `db:import` scripts are
      untracked work in progress. Decide whether project/conversation storage moves off
      `project.json` + `conversations/*.json` (`lib/project-storage.ts`), and keep usage totals and
      per-message metadata working through the move.
- [ ] **README** — document the new pieces: model picker and allowlist, per-message usage footer,
      canvas (Figma paste, extension captures), Design actions (redesign / critique / polish),
      click-to-select editing, and the env vars (`OPENROUTER_API_KEY`, `FIGMA_ACCESS_TOKEN`, and
      whatever publishing ends up needing). (S)
