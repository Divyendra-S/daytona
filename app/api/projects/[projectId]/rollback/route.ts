import { NextResponse } from "next/server";
import { authorizeProject } from "@/lib/project-access";
import { rollbackToRelease } from "@/lib/publish";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  if (!(await authorizeProject(projectId))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const payload = (await req.json().catch(() => ({}))) as {
    releaseId?: string;
  };
  const releaseId = payload.releaseId?.trim();
  if (!releaseId) {
    return NextResponse.json(
      { error: "releaseId is required" },
      { status: 400 },
    );
  }

  try {
    await rollbackToRelease(projectId, releaseId);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Rollback failed." },
      { status: 500 },
    );
  }

  return NextResponse.json({ releaseId, state: "live" });
}
