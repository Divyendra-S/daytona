import { NextResponse, type NextRequest } from "next/server";
import { relayPreview } from "@/lib/hosted-preview-proxy";
import { PREVIEW_PROXY_HOST } from "@/lib/vars";

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/** A host as the `Host` header gives it: no scheme, no port, no path, lowercase. */
const bareHost = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "");

/**
 * The hosts the API answers on: this machine, whatever `APP_HOSTS` names
 * (comma-separated, e.g. `APP_HOSTS=builder.example.com`), and — on Vercel —
 * the deployment's own hostnames, so production and previews work unattended.
 *
 * Vercel sets its own three on every deployment, so a deployment answers on its
 * own hostname whether or not anyone remembered `APP_HOSTS` — which is what
 * made the first deployed build refuse every API request.
 *
 * SECURITY: naming a host here does NOT authenticate anyone. The API runs the
 * agent's commands in this deployment's sandboxes and spends its OpenRouter
 * credits, with no login of its own — so a deployed build must sit behind real
 * access control (an identity proxy, password protection, or a sign-in of its
 * own). Left unset off Vercel, the app stays local-only, as it was designed.
 */
const ALLOWED_HOSTS = new Set([
  ...LOCAL_HOSTS,
  ...[
    process.env.APP_HOSTS,
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
    process.env.VERCEL_URL,
    process.env.VERCEL_BRANCH_URL,
  ]
    .flatMap((value) => (value ?? "").split(","))
    .map(bareHost)
    .filter(Boolean),
]);

/**
 * A request from another site (CSRF), or arriving through a hostname pointed at
 * this app that it does not answer on (DNS rebinding), is refused.
 */
export function proxy(request: NextRequest) {
  const host = (request.headers.get("host") ?? "")
    .replace(/:\d+$/, "")
    .toLowerCase();
  const { pathname } = request.nextUrl;

  // The preview proxy's hostname is not this app's: everything arriving on it
  // — pages, assets, the sandbox app's own API — is a sandbox's, and is relayed
  // from right here. Not rewritten to a route of the app: a route is a path,
  // and a path exists on the app's own hostname too, where sandbox content
  // must never be served — it would share the app's origin, and everything
  // the browser holds for it.
  if (PREVIEW_PROXY_HOST && host === PREVIEW_PROXY_HOST) {
    return relayPreview(request, pathname);
  }
  if (!pathname.startsWith("/api/")) return NextResponse.next();

  const site = request.headers.get("sec-fetch-site");

  if (
    !ALLOWED_HOSTS.has(host) ||
    (site !== null && site !== "same-origin" && site !== "none")
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return NextResponse.next();
}

/**
 * Everything, not just the API: on the preview proxy's hostname every path is
 * a sandbox's, the sandbox app's `/_next/static` included, and a matcher
 * cannot tell hostnames apart. On the app's own hostname a request that is
 * not for the API passes straight through.
 */
export const config = { matcher: "/:path*" };
