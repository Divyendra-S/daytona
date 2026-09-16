import { NextResponse } from "next/server";
import { authorizeProject } from "@/lib/project-access";
import { listProjectTree, readProjectFile } from "@/lib/project-files";

/** List the project file tree, or read one file when `?path=` is set. */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  if (!(await authorizeProject(projectId))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const filePath = new URL(req.url).searchParams.get("path");
  if (filePath) {
    const result = await readProjectFile(projectId, filePath);
    if (!result.ok) {
      const status = result.binary ? 415 : result.error.includes("not found") ? 404 : 400;
      return NextResponse.json(
        { error: result.error, binary: result.binary ?? false },
        { status },
      );
    }
    return NextResponse.json(result);
  }

  const tree = await listProjectTree(projectId);
  return NextResponse.json({ tree });
}
