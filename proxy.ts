import { NextResponse, type NextRequest } from "next/server";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The API drives this machine's projects — their sandboxes, their code and the
 * preview proxy's loopback port — with no login in front of it, so it only
 * answers pages served by this machine: a request from another site (CSRF), or
 * arriving through a hostname that was pointed at 127.0.0.1 (DNS rebinding), is
 * refused. This is the whole auth model; a deployed build needs a real one.
 */
export function proxy(request: NextRequest) {
  const host = (request.headers.get("host") ?? "").replace(/:\d+$/, "");
  const site = request.headers.get("sec-fetch-site");

  if (
    !LOCAL_HOSTS.has(host) ||
    (site !== null && site !== "same-origin" && site !== "none")
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return NextResponse.next();
}

export const config = { matcher: "/api/:path*" };
