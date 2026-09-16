import { NextResponse } from "next/server";
import { authorizeProject } from "@/lib/project-access";
import { ensurePreviewProxy } from "@/lib/preview-proxy";
import {
  previewOrigin,
  projectSandboxState,
  signedPreviewUrl,
  touchProject,
} from "@/lib/sandbox";
import {
  devServerState,
  ensureDevServer,
  ensureProductionServer,
  productionServerState,
} from "@/lib/terminal-bridge";
import { LOCAL_HOST, PREVIEW_TOKEN_HEADER, SANDBOX_DEV_PORT } from "@/lib/vars";

/**
 * Whether the project's dev server is answering.
 *
 * A `HEAD` rather than a `GET`: the preview polls this every few seconds, and requesting a page
 * would make the dev server render and log it every time. (In local mode this was a bare TCP
 * connect, which is no longer possible — the server is in a sandbox, reachable only through an
 * authenticated HTTPS proxy.)
 */
const serverAnswers = async (projectId: string) => {
  const { url, token } = await previewOrigin(projectId, SANDBOX_DEV_PORT);
  return fetch(url, {
    method: "HEAD",
    redirect: "manual",
    headers: { [PREVIEW_TOKEN_HEADER]: token },
    signal: AbortSignal.timeout(5000),
  }).then(
    (response) => response.status < 500,
    () => false,
  );
};

/** The browser and this app share a machine only when the request arrives on one of these. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * `up`: the dev server answers. `running`: a dev server is alive, so no answer means it is still
 * starting rather than stopped. `waking`: the sandbox itself is asleep or starting, which takes
 * a few seconds and must not look like a broken preview. `proxyUrl`: where the preview should
 * load the app from — the preview proxy when it can be reached, the sandbox's own signed URL
 * when the browser is somewhere else.
 *
 * A project whose sandbox has gone idle is started here: the preview must not depend on a
 * terminal tab having connected first. A dev server that started and then exited is only
 * reported, since restarting a crash on every poll would loop.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  const metadata = await authorizeProject(projectId);
  if (!metadata) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!metadata.sandboxId) {
    return NextResponse.json({
      up: false,
      running: false,
      waking: false,
      proxyUrl: null,
      error: "This project has no sandbox.",
    });
  }

  // Cheap and does not start anything, so a sleeping sandbox can be reported as waking rather
  // than as a dev server that will not come up.
  const state = await projectSandboxState(projectId);

  // Daytona does not have this sandbox any more — deleted from its dashboard, or
  // swept up by `scripts/daytona-gc.mjs`. Nothing here can bring it back, since
  // the project's code lived inside it, and recreating one would silently hand
  // the user an empty scaffold in place of their work. Reporting it as `waking`
  // (which is what any non-started state used to mean) left the preview spinning
  // "Waking the sandbox up…" forever, so it is called what it is.
  if (state === "missing") {
    return NextResponse.json({
      up: false,
      running: false,
      waking: false,
      proxyUrl: null,
      error: "This project's sandbox no longer exists.",
    });
  }

  // The sandbox may well be fine — this deployment just cannot ask about it,
  // most often because its `DAYTONA_API_KEY` belongs to a different account
  // than the one that created the sandbox. Saying so beats reporting a
  // project's work as deleted when it is still sitting there.
  if (state === "unreachable") {
    return NextResponse.json({
      up: false,
      running: false,
      waking: false,
      proxyUrl: null,
      error:
        "Cannot reach this project's sandbox. Check DAYTONA_API_KEY — a key from another account cannot see it.",
    });
  }

  if (state !== "started") {
    // Starting is what `ensureDevServer` does on its way to the sandbox; this poll just says so.
    void ensureDevServer(projectId).catch(() => {});
    return NextResponse.json({
      up: false,
      running: true,
      waking: true,
      proxyUrl: null,
    });
  }

  let devState = devServerState(projectId);
  if (devState === "never") {
    await ensureDevServer(projectId).catch(() => {});
    devState = "running";
  }

  // A sandbox that went idle took the production server down with it, and
  // nothing else brings it back until someone opens a terminal tab. This poll
  // is the one thing the workspace always runs, so it restores production too.
  // Checked on its own terms: the dev server is started a moment earlier, while
  // the sandbox is still waking, so its state says nothing about production's.
  if (metadata.liveReleaseId && productionServerState(projectId) === "never") {
    void ensureProductionServer(projectId).catch(() => {});
  }

  // The proxy listens on this machine's loopback, so it is only a preview the
  // browser can load when the browser is on this machine too. A deployed build
  // hands out the sandbox's signed URL instead: one port, short-lived, safe in
  // an iframe — at the cost of the click-to-select bridge the proxy injects.
  const local = LOCAL_HOSTS.has(
    (req.headers.get("host") ?? "").replace(/:\d+$/, "").toLowerCase(),
  );

  const [up, previewSrc] = await Promise.all([
    serverAnswers(projectId).catch(() => false),
    local
      ? ensurePreviewProxy(projectId)
          .then((port) => (port ? `http://${LOCAL_HOST}:${port}` : null))
          .catch(() => null)
      : signedPreviewUrl(projectId, SANDBOX_DEV_PORT).catch(() => null),
  ]);

  // The user is watching the preview, so the sandbox is in use even if nothing else says so.
  void touchProject(projectId);

  return NextResponse.json({
    up,
    running: up || devState === "running",
    waking: false,
    // Named `proxyUrl` for the client, which only cares that it is where the preview loads.
    proxyUrl: previewSrc,
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
  await ensureDevServer(projectId);
  return NextResponse.json({ ok: true });
}
