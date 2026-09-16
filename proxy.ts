import { NextResponse, type NextRequest } from "next/server";

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/**
 * The hosts the API answers on: this machine, plus whatever `APP_HOSTS` names
 * (comma-separated, e.g. `APP_HOSTS=builder.example.com`).
 *
 * SECURITY: naming a host here does NOT authenticate anyone. The API runs the
 * agent's commands in this deployment's sandboxes and spends its OpenRouter
 * credits, with no login of its own — so a deployed build must sit behind real
 * access control (an identity proxy, password protection, or a sign-in of its
 * own). Left unset, the app stays local-only, as it was designed.
 */
const ALLOWED_HOSTS = new Set([
  ...LOCAL_HOSTS,
  ...(process.env["APP_HOSTS"] ?? "")
    .split(",")
    .map((host) => host.trim().replace(/:\d+$/, "").toLowerCase())
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
  const site = request.headers.get("sec-fetch-site");

  if (
    !ALLOWED_HOSTS.has(host) ||
    (site !== null && site !== "same-origin" && site !== "none")
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return NextResponse.next();
}

export const config = { matcher: "/api/:path*" };
