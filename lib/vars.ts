/** The template new projects start from. */
export const TEMPLATE_REPO =
  "https://github.com/freestyle-sh/freestyle-base-nextjs-shadcn";

/** The named session a project's dev server runs in. */
export const APP_SESSION = "dev";

/**
 * The address the preview proxy binds to on *this* machine. Not "localhost":
 * Node may resolve that to IPv6 only, while browsers try IPv4 first.
 */
export const LOCAL_HOST = "127.0.0.1";

/* ------------------------------------------------------------------ */
/*  The sandbox a project's code lives and runs in                     */
/* ------------------------------------------------------------------ */

/**
 * Fixed ports inside every sandbox. Each sandbox has its own network
 * namespace, so unlike local mode there is nothing to allocate around: every
 * project's dev server is on 3000. A published site is served from outside
 * the sandbox (see `lib/site-hosting.ts`), so it needs no port here.
 */
export const SANDBOX_DEV_PORT = 3000;

/**
 * What a project's sandbox is built from. A snapshot is used when one is
 * configured — it boots faster because its dependencies are pre-installed
 * (see `scripts/daytona-snapshot.ts`) — and the plain image otherwise.
 */
export const SANDBOX_SNAPSHOT = process.env["DAYTONA_SNAPSHOT"] || null;
export const SANDBOX_IMAGE = process.env["DAYTONA_IMAGE"] || "node:22-bookworm";

/** Enough for `next dev`. Sandboxes are billed per second while running. */
export const SANDBOX_RESOURCES = { cpu: 2, memory: 4, disk: 10 };

/** Stamped on every sandbox so orphans are findable without our metadata. */
export const SANDBOX_LABEL = "aiBuilderProjectId";

/**
 * Idle minutes before Daytona stops a sandbox, and stopped days before it
 * archives one. Stopping is what keeps the bill to cents: a stopped sandbox
 * costs disk only, and its files, git history and installed dependencies all
 * survive. Nothing is ever auto-deleted.
 */
export const AUTO_STOP_MINUTES = 15;
export const AUTO_ARCHIVE_MINUTES = 7 * 24 * 60;

/**
 * Authenticates a request to a sandbox's preview proxy.
 *
 * SECURITY: this token is sandbox-wide — it authenticates every port,
 * including the sandbox's own toolbox API. It must never reach the browser.
 * Anything an iframe loads directly gets a signed URL instead
 * (`dormantPreviewUrl`), which is scoped to one port and expires.
 */
export const PREVIEW_TOKEN_HEADER = "x-daytona-preview-token";

/**
 * Suppresses the interstitial Daytona shows before a preview URL.
 *
 * That page exists because the preview domain is shared by every Daytona
 * customer, so a browser landing there is warned it may not be the owner's.
 * It is served on anything that looks like a browser navigation — which
 * includes the preview iframe reaching the sandbox through our own proxy, so
 * without this header the preview renders the warning instead of the app.
 */
export const PREVIEW_SKIP_WARNING_HEADER = "x-daytona-skip-preview-warning";

/* ------------------------------------------------------------------ */
/*  The hosted preview proxy (a deployment with no DNS of its own)     */
/* ------------------------------------------------------------------ */

/**
 * The hostname a deployed build serves the preview proxy on — a second
 * hostname of the same deployment, such as an extra `.vercel.app` name.
 * Every request arriving on it is relayed to a sandbox, so it must not be
 * the hostname the app itself is used on. Unset, and with no
 * `PREVIEW_PROXY_DOMAIN` either, the preview loads Daytona's own host.
 */
export const PREVIEW_PROXY_HOST = (process.env["PREVIEW_PROXY_HOST"] ?? "")
  .trim()
  .toLowerCase()
  .replace(/^[a-z]+:\/\//, "")
  .replace(/\/.*$/, "");

/**
 * How the browser tells the hosted proxy which sandbox host to reach: a query
 * parameter on the URL the app hands out, and a cookie the proxy sets from
 * it, for the requests that follow once the page has navigated on its own.
 */
export const PREVIEW_HOST_PARAM = "__preview";
export const PREVIEW_HOST_COOKIE = "__preview_host";
