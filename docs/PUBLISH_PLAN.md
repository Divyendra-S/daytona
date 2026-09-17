# Publish: static export to Cloudflare R2

Every project is published to `<project id>.SITES_DOMAIN`. The project is built
as a static Next.js export inside its Daytona sandbox, the files go to R2, and
one Cloudflare Worker (`workers/sites`) serves every site by looking the
request's hostname up in KV.

Status (2026-09-17): **code done, not yet run against a real Cloudflare
account.** Checked so far: the app type-checks and `pnpm cf:build` bundles; the
forced static export builds the stock template into `out/`; the tarball
unpacking reads a real export; the Worker was run locally (`wrangler dev`)
against seeded R2 and KV — pages, 404 page, `_next/static` caching, 304s, Range
requests, unknown host and non-GET all behave. Not checked: a real publish end
to end, which needs Part A.

## Why this shape

- "Publish" used to run `next start` on sandbox port 3001, which died when the
  sandbox auto-stopped after 15 idle minutes. A static export needs no server,
  so a published site stays up and costs almost nothing (R2 $0.015/GB-month, no
  egress; Workers free tier 100k requests/day, $5/month for 10M).
- Trade-off: no API routes, server actions, middleware, `cookies()`,
  `headers()`, ISR, or dynamic routes without `generateStaticParams`. The
  publish fails with the build's own error if a project uses them. The agent's
  system prompt now says so. Backends go through Supabase or external APIs.
- A domain on Cloudflare is required: `workers.dev` has no wildcard hostnames.
  Prefer a domain separate from the builder's own, for cookie isolation and
  reputation.

## Part A — Cloudflare setup (Owner: user, one time)

1. **Add the domain.** Dashboard → Add a domain → Free plan. Set the two
   nameservers Cloudflare shows at the registrar. Wait for **Active**.
2. **Wildcard DNS.** DNS → Records → Add: type `AAAA`, name `*`, content
   `100::`, proxy ON. `100::` is a dummy; the Worker answers everything. Free
   SSL covers `*.domain`. Existing specific records still win over the wildcard.
3. **R2 bucket.** R2 → Create bucket `published-sites`. Leave Custom Domains
   empty and the Public Development URL disabled — the bucket stays private.
   R2 → Manage API tokens → Create token, "Object Read & Write", limited to
   that bucket. Save Access Key ID, Secret Access Key, Account ID.
4. **KV namespace.** Storage & Databases → KV → Create `SITE_ROUTES`. Save the
   Namespace ID. Values are `projectId/releaseId`, keyed by hostname.
5. **API token.** My Profile → API Tokens → Create Custom Token with
   Account → Workers KV Storage → Edit (and, for Part C later,
   Zone → SSL and Certificates → Edit on the zone).
6. **Deploy the serving Worker.** In `workers/sites/wrangler.jsonc` replace
   `example.com` (twice) with the domain and `PASTE_KV_NAMESPACE_ID` with the
   namespace id. Then, with Node 22 or newer:
   `cd workers/sites && npm install && npx wrangler login && npx wrangler deploy`.
7. **Give the app its settings.** In `.env.local` for local use, and as
   Secrets on the builder Worker (Workers & Pages → runobi → Settings →
   Variables and Secrets) for the deployed one:

   ```
   SITES_DOMAIN=yourdomain.com
   CF_ACCOUNT_ID=
   CF_KV_API_TOKEN=
   CF_KV_NAMESPACE_ID=
   R2_ACCESS_KEY_ID=
   R2_SECRET_ACCESS_KEY=
   ```

   `R2_BUCKET` is optional and defaults to `published-sites`. Then restart
   `pnpm dev` / redeploy the builder. No database migration is needed.

## Part B — What the code does (Owner: Claude, done)

- **`workers/sites/`** — the serving Worker. Hostname → KV → `sites/<value>/`
  in R2. Tries `path/index.html` then `path.html`, so a project works with or
  without `trailingSlash`. Falls back to the export's `404.html`. Immutable
  caching for `_next/static`, revalidation for everything else; ETag/304 and
  Range handled. GET and HEAD only.
- **`lib/site-hosting.ts`** — `uploadSite` (gunzip + untar in memory, PUT each
  file to R2 through its S3 API with `aws4fetch`, six at a time),
  `routeHost` (one KV write through Cloudflare's REST API),
  `releaseIsUploaded`, `deleteSite`, `siteHost`/`siteUrl`, and
  `assertSiteHosting`, which fails a publish up front naming the missing
  settings. HTTP rather than Worker bindings so publishing works the same from
  `next dev` and from the deployed Worker. `aws4fetch` instead of the AWS SDK
  to keep the Worker bundle small.
- **`lib/publish.ts`** — after checkout and install, the production clone's
  `next.config.*` is renamed and wrapped by a generated config that forces
  `output: "export"` and `images.unoptimized`. This replaced the plan to fork
  the template: it needs no fork, and it also covers projects that already
  exist and projects imported from GitHub. The untouched fork
  `Divyendra-S/freestyle-base-nextjs-shadcn` is unused and can be deleted.
  Then `npm run build`, `tar` of `out/`, a fetch of the tarball through
  `sandbox.downloadUrl()` (the SDK's `downloadFile` is multipart and does not
  survive bundling for a Worker), `uploadSite`, `routeHost`.
- **Rollback** no longer rebuilds: it checks the release's files are in R2 and
  repoints the hostname. Releases from before this change were never uploaded
  and answer "Publish again instead", shown in the dialog.
- **Subdomain** is the project id (unique, lowercase, a valid DNS label), so
  there is no schema change. A renameable `subdomain` column is a later step.
- **The publish request stays open** until the release settles, sending a
  space every 15 s. A Worker is stopped about 30 s after it answers, and a
  build takes minutes; while the client is connected there is no such limit.
  The client refreshes the project 3 s in, so the release shows as "Building"
  straight away, and polls as before. If the tab closes mid-publish on the
  deployed builder the work is cut off: a release still `publishing` after 30
  minutes is reported as failed ("Publishing was interrupted") so it cannot
  block the next publish. A Queue or Workflow would remove that limit.
- **The sandbox production server is gone** (`ensureProductionServer`,
  `PROD_SESSION`, `SANDBOX_PROD_PORT` and their callers).
- **Deleting a project** removes its KV route and its files in R2.
- **`productionUrl`** is `https://<project id>.SITES_DOMAIN`; the publish
  dialog and home screen already render it.

Known limits:

- A Worker request may make 50 subrequests on the Free plan and 1,000 on Paid.
  Each uploaded file is one, and a small export is 60–80 files, so the
  deployed builder needs Workers Paid to publish. Local `pnpm dev` has no limit.
- The whole tarball is held in memory while uploading (Workers: 128 MB).
- Old releases' files are never pruned.

## Part C — Users' own domains (later, not built)

1. Zone → SSL/TLS → Custom Hostnames → enable. Add DNS `sites` AAAA `100::`
   proxied; set it as the **fallback origin**. First 100 hostnames are free,
   then $0.10/month each.
2. Add route `{ "pattern": "*/*", "zone_name": "yourdomain.com" }` to
   `workers/sites/wrangler.jsonc` so custom hostnames reach the Worker. Keep
   more specific routes for the main app and preview Worker.
3. `domains` table: `hostname`, `projectId`, `cfHostnameId`, `status`. API
   route calls `POST /zones/{zone_id}/custom_hostnames` with
   `{ hostname, ssl: { method: "http", type: "dv" } }`. User adds
   `CNAME www → sites.yourdomain.com` (apex needs CNAME flattening/ALIAS at
   their DNS host; otherwise use `www` and redirect the apex). Poll
   `GET /custom_hostnames/{id}` until `status` and `ssl.status` are `active`,
   then `routeHost(hostname, projectId, liveReleaseId)`.
4. Every publish and rollback calls `routeHost` for the subdomain and each
   custom domain. The Worker needs no change.

## Security notes (from `docs/TODO.md`)

- Never expose sandbox port 3000; it serves the unauthenticated terminal API.
- The production copy is a git clone, so it carries no `.env*` unless the
  project committed one. With a static export, anything a project reads from
  env at build time ends up in public files.
- R2 and Cloudflare credentials stay on the platform; never in the sandbox,
  where user code runs.
