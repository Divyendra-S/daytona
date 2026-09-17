import { NextResponse } from "next/server";
import { authorizeProject } from "@/lib/project-access";
import { publishProject } from "@/lib/publish";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  if (!(await authorizeProject(projectId))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const payload = (await req.json().catch(() => ({}))) as { message?: string };
  const message = payload.message?.trim() || "Publish";

  let release: Awaited<ReturnType<typeof publishProject>>;
  try {
    release = await publishProject(projectId, message);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Publish failed." },
      { status: 500 },
    );
  }
  const { releaseId, settled } = release;

  // The response stays open until the release settles, with a space now and
  // then so nothing in between gives up on it. A Worker is stopped shortly
  // after it answers, and a build outlasts that by minutes; while the client
  // is still connected there is no such limit. The outcome itself is on the
  // release, which the client polls — this body only has to end.
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          // The client left; the release settles without it.
        }
      };
      const beat = setInterval(() => write(" "), 15_000);
      void settled.then(() => {
        clearInterval(beat);
        write(JSON.stringify({ releaseId }));
        try {
          controller.close();
        } catch {
          // Already closed by the client.
        }
      });
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}
