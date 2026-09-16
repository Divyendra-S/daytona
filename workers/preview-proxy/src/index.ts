/**
 * The preview proxy for a deployed AI Builder: a hostname you control, in front
 * of Daytona's.
 *
 * Daytona shows a "Preview URL Warning" page to a browser visiting a sandbox's
 * preview host, and remembers the click-through in a cookie on that host — a
 * cookie the browser refuses inside a cross-site iframe, so the workspace's
 * preview would show the warning on every load. The header that skips it can
 * only be sent by a server, so this one sends it, the way `lib/preview-proxy.ts`
 * does on a developer's own machine.
 *
 * Which sandbox to reach is in the hostname, so nothing has to be stored:
 * `3000-abc--daytonaproxy01--eu.preview.example.com` forwards to
 * `https://3000-abc.daytonaproxy01.eu`. That upstream host is the *signed*
 * preview host the app mints for the browser — scoped to one port and expiring —
 * so this proxy holds no token and can be reached by anyone who has the URL,
 * exactly like the signed URL itself.
 */

const UPSTREAM_HOST = /^\d+-[a-z0-9]+\.[a-z0-9.-]+$/i;

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

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // The `Host` header is what the browser asked for; `request.url` agrees on
    // Cloudflare, but `wrangler dev` reports `localhost` there.
    const publicHost = request.headers.get("host") ?? url.host;
    const upstreamHost = publicHost.split(".")[0]!.replace(/--/g, ".");
    if (!UPSTREAM_HOST.test(upstreamHost)) {
      return new Response(`Not a preview host: ${publicHost}`, { status: 404 });
    }

    const publicOrigin = `${url.protocol}//${publicHost}`;
    const upstreamOrigin = `https://${upstreamHost}`;
    url.protocol = "https:";
    url.hostname = upstreamHost;
    url.port = "";

    const headers = new Headers(request.headers);
    headers.set("X-Daytona-Skip-Preview-Warning", "true");
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

    const upstream = await fetch(url.toString(), {
      method: request.method,
      headers,
      body: request.body,
      redirect: "manual",
    });

    // A websocket (the dev server's HMR) is handed back as the socket itself.
    if (upstream.status === 101) {
      return new Response(null, {
        status: 101,
        webSocket: (upstream as Response & { webSocket: WebSocket }).webSocket,
      });
    }

    const out = new Headers(upstream.headers);
    const location = out.get("location");
    if (location) {
      out.set("location", location.replace(upstreamOrigin, publicOrigin));
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: out,
    });
  },
} satisfies ExportedHandler;
