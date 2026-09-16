import { connect } from "node:net";
import { NextResponse } from "next/server";
import { authorizeProject } from "@/lib/project-access";
import { ensurePreviewProxy } from "@/lib/preview-proxy";
import { devServerState, ensureDevServer } from "@/lib/terminal-bridge";
import { LOCAL_HOST } from "@/lib/vars";

/**
 * Whether the project's dev server is accepting connections.
 *
 * A TCP connect rather than an HTTP request: the preview polls this every few seconds, and
 * requesting a page would make the dev server render and log it every time.
 */
const portOpen = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = connect({ host: LOCAL_HOST, port, timeout: 500 });
    const done = (up: boolean) => {
      socket.destroy();
      resolve(up);
    };
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });

/**
 * `up`: the port answers. `running`: a dev server process is alive, so a closed port means it is
 * still starting rather than stopped. `proxyUrl`: where the preview should load the app from —
 * the preview proxy, which adds the click-to-select bridge.
 *
 * Servers do not survive AI Builder restarting, so one this process has never started is started
 * here — the preview must not depend on the terminal tab having connected first. One that
 * started and then exited is only reported: restarting a crash on every poll would loop.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  const metadata = await authorizeProject(projectId);
  if (!metadata) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let state = devServerState(projectId);
  if (state === "never") {
    ensureDevServer(projectId, metadata.devPort);
    state = "running";
  }
  const [up, proxyPort] = await Promise.all([
    portOpen(metadata.devPort),
    ensurePreviewProxy(projectId, metadata.devPort).catch(() => null),
  ]);
  return NextResponse.json({
    up,
    running: up || state === "running",
    // Without the proxy the preview still works, just without click-to-select.
    proxyUrl: proxyPort
      ? `http://${LOCAL_HOST}:${proxyPort}`
      : `http://${LOCAL_HOST}:${metadata.devPort}`,
  });
}

/** Start the dev server again after it stopped — the preview's "Start dev server" button. */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  const metadata = await authorizeProject(projectId);
  if (!metadata) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  ensureDevServer(projectId, metadata.devPort);
  return NextResponse.json({ ok: true });
}
