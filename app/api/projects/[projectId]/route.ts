import { rm } from "node:fs/promises";
import { NextResponse } from "next/server";
import { authorizeProject } from "@/lib/project-access";
import { projectPaths } from "@/lib/project-paths";
import { deleteProject } from "@/lib/project-storage";
import { deleteProjectSandbox } from "@/lib/sandbox";

/**
 * Delete a project: its sandbox first, while the row still names it, then the
 * row itself — which takes its conversations and releases with it.
 */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  const metadata = await authorizeProject(projectId);
  if (!metadata) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  await deleteProjectSandbox(projectId).catch(() => {
    // A sandbox that cannot be reached is left to `scripts/daytona-gc.mjs`.
  });
  await deleteProject(projectId);
  await rm(projectPaths(projectId).root, { recursive: true, force: true });

  return NextResponse.json({ ok: true });
}
