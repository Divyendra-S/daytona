import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
} from "node:http";
import net from "node:net";
import { BRIDGE_PATH, BRIDGE_SCRIPT } from "./preview-bridge";
import { LOCAL_HOST } from "./vars";

/**
 * A pass-through proxy in front of a project's dev server, so the preview can carry the bridge.
 *
 * The preview is another origin, and click-to-select needs a script inside it. Writing one into
 * the project would miss pages its layout does not render (a static `public/index.html`, an
 * imported repo of any shape), get edited by the agent, and get committed. This proxy writes
 * nothing: it forwards every request and websocket (HMR) to the dev server, serves the bridge at
 * `BRIDGE_PATH`, and appends a tag loading it to HTML responses. It listens on a port the OS
 * picks, so it cannot collide with anything.
 */

/** `script`: the bridge this proxy serves — a changed bridge means a new proxy. */
type Proxy = {
  server: http.Server;
  port: number;
  devPort: number;
  script: string;
};

/** Kept on globalThis so a hot reload of this module does not orphan listening servers. */
const proxies: Map<string, Promise<Proxy>> = ((
  globalThis as Record<string, unknown>
)["__aiBuilderPreviewProxies"] as Map<string, Promise<Proxy>> | undefined) ??
((globalThis as Record<string, unknown>)["__aiBuilderPreviewProxies"] =
  new Map());

const BRIDGE_TAG = `<script src="${BRIDGE_PATH}" async></script>`;

/**
 * To the dev server every request must look like its own: Next's dev server refuses `/_next`
 * and HMR from an origin it does not recognise. And uncompressed, so HTML can be appended to.
 */
const upstreamHeaders = (
  headers: IncomingHttpHeaders,
  devPort: number,
  proxyPort: number,
): IncomingHttpHeaders => {
  const next: IncomingHttpHeaders = {
    ...headers,
    host: `${LOCAL_HOST}:${devPort}`,
  };
  if (next.origin) next.origin = `http://${LOCAL_HOST}:${devPort}`;
  if (next.referer)
    next.referer = next.referer.replace(`:${proxyPort}`, `:${devPort}`);
  delete next["accept-encoding"];
  return next;
};

const start = (devPort: number) =>
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
      const upstream = http.request(
        {
          host: LOCAL_HOST,
          port: devPort,
          method: req.method,
          path: req.url,
          headers: upstreamHeaders(req.headers, devPort, proxyPort),
        },
        (upstreamRes) => {
          const status = upstreamRes.statusCode ?? 502;
          const headers = { ...upstreamRes.headers };
          if (headers.location)
            headers.location = headers.location.replace(
              new RegExp(`(127\\.0\\.0\\.1|localhost):${devPort}`),
              `${LOCAL_HOST}:${proxyPort}`,
            );
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
    server.on(
      "upgrade",
      (req: IncomingMessage, socket: net.Socket, head: Buffer) => {
        const proxyPort = (server.address() as net.AddressInfo).port;
        const upstream = net.connect(devPort, LOCAL_HOST, () => {
          const headers = upstreamHeaders(req.headers, devPort, proxyPort);
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
        });
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
        devPort,
        script: BRIDGE_SCRIPT,
      }),
    );
  });

/** The preview proxy's port for a project, started on first use and replaced if the dev port changed. */
export const ensurePreviewProxy = async (
  projectId: string,
  devPort: number,
) => {
  const existing = await proxies.get(projectId)?.catch(() => null);
  // A proxy outlives hot reloads of this module, and its handler keeps the bridge it started
  // with; one serving an older bridge is replaced, so a changed bridge reaches the preview.
  if (
    existing?.server.listening &&
    existing.devPort === devPort &&
    existing.script === BRIDGE_SCRIPT
  )
    return existing.port;
  existing?.server.close();
  const next = start(devPort);
  proxies.set(projectId, next);
  return (await next).port;
};
