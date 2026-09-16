import { NextResponse } from "next/server";
import { authorizeProject } from "@/lib/project-access";
import {
  ensureDevServer,
  ensureProductionServer,
  resizeTerminal,
  signalTerminal,
  subscribeToTerminal,
  writeToTerminal,
} from "@/lib/terminal-bridge";
import { APP_SESSION, PROD_SESSION } from "@/lib/vars";

/**
 * A terminal name the browser may ask for: the dev server, or an ad-hoc shell.
 * The production server's session is publishing's alone.
 */
const parseSession = (raw: string | null) => {
  const slug = (raw ?? APP_SESSION).trim();
  if (
    !/^[a-z0-9-]{1,60}$/.test(slug) ||
    /^\d+$/.test(slug) ||
    slug === PROD_SESSION
  ) {
    return null;
  }
  return slug;
};

/** Stream one terminal's output to the browser as server-sent events. */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  const metadata = await authorizeProject(projectId);
  if (!metadata) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const slug = parseSession(new URL(req.url).searchParams.get("session"));
  if (!slug) {
    return NextResponse.json(
      { error: "Invalid session name" },
      { status: 400 },
    );
  }

  if (slug === APP_SESSION) {
    // Servers do not survive AI Builder restarting, so opening a project
    // brings its dev server — and production, if published — back up.
    ensureDevServer(projectId, metadata.devPort);
    if (metadata.liveReleaseId) {
      ensureProductionServer(projectId, metadata.prodPort);
    }
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Terminal output is arbitrary bytes; base64 keeps it intact through SSE's
      // line-oriented framing.
      const send = (chunk: Uint8Array) => {
        try {
          const payload = Buffer.from(chunk).toString("base64");
          controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
        } catch {
          // The client went away mid-write; cleanup runs on abort.
        }
      };

      const unsubscribe = subscribeToTerminal(projectId, slug, send);

      req.signal.addEventListener("abort", () => {
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

/** Keystrokes, resizes and signals, on their way to the session's process. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  if (!(await authorizeProject(projectId))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const payload = (await req.json().catch(() => ({}))) as {
    session?: string;
    data?: string;
    cols?: number;
    rows?: number;
    signal?: "sigint" | "sigkill";
  };

  const slug = parseSession(payload.session ?? null);
  if (!slug) {
    return NextResponse.json(
      { error: "Invalid session name" },
      { status: 400 },
    );
  }

  if (typeof payload.data === "string") {
    writeToTerminal(projectId, slug, payload.data);
  }

  if (payload.cols && payload.rows) {
    resizeTerminal(projectId, slug, payload.cols, payload.rows);
  }

  if (payload.signal === "sigint" || payload.signal === "sigkill") {
    signalTerminal(projectId, slug, payload.signal);
  }

  return NextResponse.json({ ok: true });
}
