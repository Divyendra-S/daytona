import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { createProjectFiles } from "@/lib/project-runtime";
import {
  createConversation,
  deleteProject,
  listProjects,
  writeProjectMetadata,
} from "@/lib/project-storage";
import {
  EMPTY_USAGE,
  type ProjectItem,
  type ProjectMetadata,
} from "@/lib/project-types";
import { deleteProjectSandbox, dormantPreviewUrl } from "@/lib/sandbox";
import { siteUrl } from "@/lib/site-hosting";
import { ensureDevServer } from "@/lib/terminal-bridge";
import { SANDBOX_DEV_PORT } from "@/lib/vars";

/**
 * A project as the client sees it.
 *
 * `previewUrl` is signed: single-port and expiring, so unlike the sandbox-wide
 * preview token it is safe to hand to the browser. It does not start the
 * sandbox — the home screen lists every project, and waking them all would
 * undo the idle auto-stop that keeps the bill near zero. `productionUrl` is
 * the project's published site, which no sandbox is behind.
 *
 * The workspace does not load `previewUrl` directly: it loads the `proxyUrl`
 * that `preview-status` returns, which is this machine's proxy and carries the
 * click-to-select bridge. `previewUrl` is what the address bar shows.
 */
const toProjectItem = async (
  id: string,
  metadata: ProjectMetadata,
): Promise<ProjectItem> => ({
  id,
  name: metadata.name,
  previewUrl: metadata.sandboxId
    ? await dormantPreviewUrl(id, SANDBOX_DEV_PORT)
    : "",
  productionUrl: siteUrl(id),
  hasSandbox: Boolean(metadata.sandboxId),
  conversations: metadata.conversations,
  releases: metadata.releases,
  liveReleaseId: metadata.liveReleaseId,
  usage: metadata.usage ?? EMPTY_USAGE,
});

export async function GET() {
  const projects = await listProjects();
  return NextResponse.json({
    projects: await Promise.all(
      projects.map(({ id, metadata }) => toProjectItem(id, metadata)),
    ),
  });
}

export async function POST(req: Request) {
  const payload = (await req.json().catch(() => ({}))) as {
    name?: string;
    conversationTitle?: string;
    githubRepoName?: string;
  };

  const githubRepoName = payload.githubRepoName?.trim();
  const name =
    payload.name?.trim() ||
    githubRepoName?.split("/").pop()?.trim() ||
    "Untitled Project";

  const sourceRepoUrl = githubRepoName
    ? `https://github.com/${githubRepoName.replace(/^https?:\/\/github\.com\//, "")}`
    : undefined;

  const projectId = randomUUID().slice(0, 8);

  // Written before the sandbox exists, and rewritten with the sandbox's id as
  // soon as there is one — that id is the only way back to the project's code.
  const metadata: ProjectMetadata = {
    version: 5,
    name,
    createdAt: new Date().toISOString(),
    sandboxId: null,
    conversations: [],
    releases: [],
    liveReleaseId: null,
  };
  await writeProjectMetadata(projectId, metadata);

  try {
    metadata.sandboxId = await createProjectFiles(projectId, sourceRepoUrl);
    await writeProjectMetadata(projectId, metadata);
  } catch (error) {
    await deleteProjectSandbox(projectId).catch(() => {
      // A sandbox we cannot reach is left for the garbage collector.
    });
    // The row goes too: a half-created project nobody can open would otherwise
    // sit on the home screen, one card for every attempt that failed.
    await deleteProject(projectId);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not create the project.",
      },
      { status: 500 },
    );
  }

  await ensureDevServer(projectId).catch(() => {
    // The preview starts it again; a slow first boot must not fail creation.
  });

  const conversationId = randomUUID();
  const next = await createConversation(
    projectId,
    conversationId,
    payload.conversationTitle?.trim(),
  );

  return NextResponse.json({
    id: projectId,
    conversationId,
    project: await toProjectItem(projectId, next),
  });
}
