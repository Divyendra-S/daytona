import { BRIDGE_PATH, BRIDGE_SCRIPT } from "./preview-bridge";
import {
  PREVIEW_HOST_COOKIE,
  PREVIEW_HOST_PARAM,
  PREVIEW_SKIP_WARNING_HEADER,
} from "./vars";

/**
 * The preview proxy for a deployment that has nothing but the deployment: no
 * DNS zone for a wildcard hostname, no Cloudflare. It does what
 * `workers/preview-proxy` does, from inside the app.
 *
 * Daytona shows a "Preview URL Warning" page to a browser visiting a sandbox's
 * preview host, and remembers the click-through in a cookie on that host — a
 * cookie the browser refuses inside a cross-site iframe, so the workspace's
 * preview would show the warning on every load. The header that skips it can
 * only be sent by a server, so this one sends it, the way `lib/preview-proxy.ts`
 * does on a developer's own machine. Like that proxy, it appends the
 * click-to-select bridge to every page, which a deployed preview otherwise lacks.
 *
 * The Worker gets the sandbox host from *its* hostname, one per sandbox. A
 * deployment has a single hostname, so here the sandbox host rides in the URL
 * the app hands out (`?__preview=<host>`) and is then remembered in a cookie,
 * because the page inside soon navigates on its own — a link, client routing —
 * to plain paths that carry nothing. Resolution, in order:
 *
 *   1. the request's own `__preview` parameter — the URL the workspace loads;
 *   2. the same parameter on the request's referer — the page's own assets,
 *      before any cookie has arrived;
 *   3. the cookie — everything after the page has moved.
 *
 * The cookie is `Partitioned`: the proxy is a third party to the workspace, and
 * a partitioned cookie is the one kind a browser keeps for an iframe without
 * asking. It holds only the signed host the browser was already given, scoped
 * to one port and expiring, so this proxy has no secret and, like the Worker,
 * can be reached by anyone who has the URL — exactly like the signed URL itself.
 */

/** A sandbox preview host: `<port>-<token>.<daytona proxy domain>`, never an address. */
const UPSTREAM_HOST = /^\d+-[a-z0-9]+(\.[a-z0-9-]*[a-z][a-z0-9-]*)+$/i;

const BRIDGE_TAG = `<script src="${BRIDGE_PATH}" async></script>`;

/** Signed hosts live an hour; so does a cookie holding one. */
const COOKIE_SECONDS = 3600;

/**
 * Next's dev server guards its internals (and the HMR websocket) against an
 * origin it does not know; it knows `localhost`. Everything else keeps the
 * preview host as its origin, because a Server Action checks that `origin` and
 * `host` agree. Mirrors `isDevInternal` in `lib/preview-proxy.ts`.
 */
const isDevInternal = (pathname: string) =>
  (pathname.startsWith("/_next") || pathname.startsWith("/__nextjs")) &&
  !pathname.startsWith("/_next/image") &&
  !pathname.startsWith("/_next/static/media");

const parseUrl = (value: string | null) => {
  try {
    return value ? new URL(value) : null;
  } catch {
    return null;
  }
};

/** The `name` cookie in a `Cookie` header, or null. */
const cookieValue = (header: string | null, name: string) => {
  for (const part of (header ?? "").split(";")) {
    const [key, ...rest] = part.split("=");
    if (key?.trim() === name) return decodeURIComponent(rest.join("=").trim());
  }
  return null;
};

/** The `Cookie` header without `name`, so the proxy's own cookie stays here. */
const withoutCookie = (header: string, name: string) =>
  header
    .split(";")
    .filter((part) => part.split("=")[0]?.trim() !== name)
    .join(";")
    .trim();

/** Headers that describe the hop to this server, not the request itself. */
const HOP_HEADERS = [
  "host",
  "connection",
  "keep-alive",
  "content-length",
  "transfer-encoding",
  "forwarded",
  "x-real-ip",
];
const HOP_PREFIXES = [
  "x-forwarded-",
  "x-vercel-",
  "x-middleware-",
  "x-invoke-",
];

/** Which sandbox host this request is for, by the order documented above. */
export const upstreamHostFor = (request: Request): string | null => {
  const own = new URL(request.url).searchParams.get(PREVIEW_HOST_PARAM);
  const referer = parseUrl(request.headers.get("referer"));
  const cookie = cookieValue(
    request.headers.get("cookie"),
    PREVIEW_HOST_COOKIE,
  );
  for (const candidate of [
    own,
    referer?.searchParams.get(PREVIEW_HOST_PARAM),
    cookie,
  ]) {
    const host = (candidate ?? "").trim().toLowerCase();
    if (UPSTREAM_HOST.test(host)) return host;
  }
  return null;
};

/**
 * Relay one request to the sandbox behind it.
 *
 * Called from `proxy.ts` for every request on `PREVIEW_PROXY_HOST`. The
 * response is the sandbox's, streamed, with the bridge appended to HTML and
 * redirects pointed back at this proxy.
 */
export const relayPreview = async (
  request: Request,
  publicPath: string,
): Promise<Response> => {
  const requestUrl = new URL(request.url);
  const publicHost = request.headers.get("host") ?? requestUrl.host;
  const protocol =
    request.headers.get("x-forwarded-proto") ??
    requestUrl.protocol.replace(/:$/, "");
  const publicOrigin = `${protocol}://${publicHost}`;

  if (publicPath === BRIDGE_PATH) {
    return new Response(BRIDGE_SCRIPT, {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  const upstreamHost = upstreamHostFor(request);
  if (!upstreamHost) {
    return new Response(
      "This is AI Builder's preview proxy, and this request does not say which project's preview it is for. Open the preview from the workspace — and if it still lands here, the browser is refusing the cookie the proxy needs.",
      {
        status: 400,
        headers: { "content-type": "text/plain; charset=utf-8" },
      },
    );
  }
  const upstreamOrigin = `https://${upstreamHost}`;

  const url = new URL(publicPath + requestUrl.search, upstreamOrigin);
  url.searchParams.delete(PREVIEW_HOST_PARAM);

  const headers = new Headers(request.headers);
  for (const name of HOP_HEADERS) headers.delete(name);
  for (const name of [...headers.keys()]) {
    if (HOP_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      headers.delete(name);
    }
  }
  // Uncompressed, so HTML can be appended to.
  headers.set("accept-encoding", "identity");
  headers.set(PREVIEW_SKIP_WARNING_HEADER, "true");
  if (headers.has("origin")) {
    headers.set(
      "origin",
      isDevInternal(url.pathname) ? "http://localhost" : upstreamOrigin,
    );
  }
  const referer = headers.get("referer");
  if (referer) {
    headers.set("referer", referer.replace(publicOrigin, upstreamOrigin));
  }
  const cookie = headers.get("cookie");
  if (cookie) {
    const rest = withoutCookie(cookie, PREVIEW_HOST_COOKIE);
    if (rest) headers.set("cookie", rest);
    else headers.delete("cookie");
  }

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      redirect: "manual",
      cache: "no-store",
      // A streamed request body needs this, and TypeScript's fetch does not know it yet.
      ...({ duplex: "half" } as object),
    });
  } catch {
    return new Response("The sandbox did not answer.", {
      status: 502,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const out = new Headers(upstream.headers);
  // The body arrives decoded, whatever the sandbox said about it.
  for (const name of [
    "content-encoding",
    "content-length",
    "transfer-encoding",
    "connection",
    "keep-alive",
  ]) {
    out.delete(name);
  }
  const location = out.get("location");
  if (location) {
    out.set("location", location.replace(upstreamOrigin, publicOrigin));
  }
  if (
    cookieValue(request.headers.get("cookie"), PREVIEW_HOST_COOKIE) !==
    upstreamHost
  ) {
    out.append(
      "set-cookie",
      `${PREVIEW_HOST_COOKIE}=${upstreamHost}; Path=/; Max-Age=${COOKIE_SECONDS}; HttpOnly; Secure; SameSite=None; Partitioned`,
    );
  }

  const status = upstream.status;
  const bodiless =
    request.method === "HEAD" || status === 204 || status === 304;
  if (bodiless || !upstream.body) {
    return new Response(null, { status, headers: out });
  }

  const html =
    (out.get("content-type") ?? "").includes("text/html") &&
    status >= 200 &&
    status < 300;
  if (!html) return new Response(upstream.body, { status, headers: out });

  // Appended at the end rather than into <head>: the page keeps streaming as it
  // arrives, and a script after </html> is still parsed into the body and run.
  const tag = new TextEncoder().encode(BRIDGE_TAG);
  const body = upstream.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      flush: (controller) => controller.enqueue(tag),
    }),
  );
  return new Response(body, { status, headers: out });
};
