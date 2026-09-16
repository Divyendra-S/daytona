import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
} from "node:http";
import https from "node:https";
import type net from "node:net";
import tls from "node:tls";
import { BRIDGE_PATH, BRIDGE_SCRIPT } from "./preview-bridge";
import { previewOrigin } from "./sandbox";
import {
  LOCAL_HOST,
  PREVIEW_SKIP_WARNING_HEADER,
  PREVIEW_TOKEN_HEADER,
  SANDBOX_DEV_PORT,
} from "./vars";

/**
 * A pass-through proxy in front of a project's dev server, so the preview can carry the bridge.
 *
 * The preview is another origin, and click-to-select needs a script inside it. Writing one into
 * the project would miss pages its layout does not render (a static `public/index.html`, an
 * imported repo of any shape), get edited by the agent, and get committed. This proxy writes
 * nothing: it forwards every request and websocket (HMR) to the dev server, serves the bridge at
 * `BRIDGE_PATH`, and appends a tag loading it to HTML responses. It listens on a port the OS
 * picks, so it cannot collide with anything.
 *
 * The dev server is now in the project's sandbox rather than on this machine, so "forward" means
 * an HTTPS request to the sandbox's preview origin carrying the preview token. The token stays
 * here: the browser only ever talks to this proxy, on loopback.
 */

/** `script`: the bridge this proxy serves — a changed bridge means a new proxy. */
type Proxy = {
  server: http.Server;
  port: number;
  /** The sandbox's preview host this proxy forwards to. */
  host: string;
  token: string;
  script: string;
  /**
   * This module's own identity, so editing the proxy replaces the running one.
   *
   * A proxy survives hot reloads on purpose, but that means a listening server
   * keeps the request handler it was created with: a change to how requests are
   * forwarded would otherwise not take effect until the whole app restarted.
   * Every reload of this module makes a new function, so comparing it catches
   * exactly that — and nothing else, so unrelated reloads keep their proxy.
   */
  impl: typeof upstreamHeaders;
};

/** Kept on globalThis so a hot reload of this module does not orphan listening servers. */
const proxies: Map<string, Promise<Proxy>> = ((
  globalThis as Record<string, unknown>
)["__aiBuilderPreviewProxies"] as Map<string, Promise<Proxy>> | undefined) ??
((globalThis as Record<string, unknown>)["__aiBuilderPreviewProxies"] =
  new Map());

const BRIDGE_TAG = `<script src="${BRIDGE_PATH}" async></script>`;

/**
 * Next's dev server guards its own internals — anything under `/_next` or `/__nextjs`, which
 * includes the HMR websocket — against requests from an origin it does not know. It knows
 * `localhost`, and the hostname it was started on; it cannot know the sandbox's preview host, so
 * it logs "Cross origin request detected ... configure allowedDevOrigins" and, in a future major
 * version, will refuse the request outright.
 *
 * Telling it `localhost` for exactly those URLs is enough, and is better than setting
 * `allowedDevOrigins` in each project: that config is per-project and would have to name a
 * preview host that differs per sandbox — and merely defining it flips Next from warning to
 * blocking, so one stale value there would break the preview instead of nagging about it.
 *
 * Every other request keeps the preview host as its origin, because Next validates a Server
 * Action by checking that its `origin` and `host` agree — rewriting those would break any form
 * the agent builds.
 */
const isDevInternal = (url = "") =>
  (url.includes("/_next") || url.includes("/__nextjs")) &&
  !url.includes("/_next/image") &&
  !url.includes("/_next/static/media");

/**
 * To the dev server every request must look like it came from its own origin: Next's dev server
 * refuses `/_next` and HMR from an origin it does not recognise. And uncompressed, so HTML can be
 * appended to.
 */
const upstreamHeaders = (
  headers: IncomingHttpHeaders,
  host: string,
  token: string,
  proxyPort: number,
  url?: string,
): IncomingHttpHeaders => {
  const next: IncomingHttpHeaders = { ...headers, host };
  if (next.origin) {
    next.origin = isDevInternal(url) ? "http://localhost" : `https://${host}`;
  }
  if (next.referer) {
    next.referer = next.referer.replace(
      new RegExp(`^http://(127\\.0\\.0\\.1|localhost):${proxyPort}`),
      `https://${host}`,
    );
  }
  delete next["accept-encoding"];
  next[PREVIEW_TOKEN_HEADER] = token;
  next[PREVIEW_SKIP_WARNING_HEADER] = "true";
  return next;
};

const start = (host: string, token: string) =>
  new Promise<Proxy>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.url === BRIDGE_PATH) {
        res.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(BRIDGE_SCRIPT);
        return;
      }

      const proxyPort = (server.address() as net.AddressInfo).port;
      const upstream = https.request(
        {
          host,
          port: 443,
          servername: host,
          method: req.method,
          path: req.url,
          headers: upstreamHeaders(
            req.headers,
            host,
            token,
            proxyPort,
            req.url,
          ),
        },
        (upstreamRes) => {
          const status = upstreamRes.statusCode ?? 502;
          const headers = { ...upstreamRes.headers };
          if (headers.location) {
            headers.location = headers.location.replace(
              `https://${host}`,
              `http://${LOCAL_HOST}:${proxyPort}`,
            );
          }
          const html =
            (headers["content-type"] ?? "").includes("text/html") &&
            req.method !== "HEAD" &&
            status >= 200 &&
            status < 300 &&
            status !== 204;
          if (html) delete headers["content-length"];
          res.writeHead(status, headers);
          if (!html) {
            upstreamRes.pipe(res);
            return;
          }
          // Appended at the end rather than into <head>: the page keeps streaming as it arrives,
          // and a script after </html> is still parsed into the body and run.
          // ponytail: no backpressure on this path; fine for a local dev page.
          upstreamRes.on("data", (chunk) => res.write(chunk));
          upstreamRes.on("end", () => res.end(BRIDGE_TAG));
          upstreamRes.on("error", () => res.destroy());
        },
      );
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.pipe(upstream);
    });

    // Websockets — the dev server's HMR — are replayed to the dev server and piped both ways.
    // Hand-rolled because the upgrade has to carry the preview token, and over TLS because the
    // sandbox's preview origin is HTTPS.
    server.on(
      "upgrade",
      (req: IncomingMessage, socket: net.Socket, head: Buffer) => {
        const proxyPort = (server.address() as net.AddressInfo).port;
        const upstream = tls.connect(
          { host, port: 443, servername: host },
          () => {
            const headers = upstreamHeaders(
              req.headers,
              host,
              token,
              proxyPort,
              req.url,
            );
            const lines = [
              `${req.method} ${req.url} HTTP/${req.httpVersion}`,
              ...Object.entries(headers).flatMap(([name, value]) =>
                value === undefined
                  ? []
                  : (Array.isArray(value) ? value : [value]).map(
                      (item) => `${name}: ${item}`,
                    ),
              ),
              "",
              "",
            ];
            upstream.write(lines.join("\r\n"));
            if (head.length) upstream.write(head);
            socket.pipe(upstream).pipe(socket);
          },
        );
        const close = () => {
          socket.destroy();
          upstream.destroy();
        };
        upstream.on("error", close);
        socket.on("error", close);
      },
    );

    server.on("error", reject);
    server.listen(0, LOCAL_HOST, () =>
      resolve({
        server,
        port: (server.address() as net.AddressInfo).port,
        host,
        token,
        script: BRIDGE_SCRIPT,
        impl: upstreamHeaders,
      }),
    );
  });

/**
 * The preview proxy's port for a project, started on first use and replaced if the sandbox it
 * points at changed.
 */
export const ensurePreviewProxy = async (projectId: string) => {
  const { url, token } = await previewOrigin(projectId, SANDBOX_DEV_PORT);
  const host = new URL(url).host;

  const existing = await proxies.get(projectId)?.catch(() => null);
  // A proxy outlives hot reloads of this module, and its handler keeps the bridge and the
  // upstream it started with; one serving an older bridge, or pointing at a sandbox the project
  // no longer has, is replaced.
  if (
    existing?.server.listening &&
    existing.host === host &&
    existing.token === token &&
    existing.script === BRIDGE_SCRIPT &&
    existing.impl === upstreamHeaders
  ) {
    return existing.port;
  }
  existing?.server.close();
  const next = start(host, token);
  proxies.set(projectId, next);
  return (await next).port;
};
