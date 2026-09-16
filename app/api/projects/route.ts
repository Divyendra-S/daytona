import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { NextResponse } from "next/server";
import { createProjectFiles, projectPaths } from "@/lib/local-project";
import {
  createConversation,
  listProjects,
  writeProjectMetadata,
} from "@/lib/project-storage";
import {
  EMPTY_USAGE,
  type ProjectItem,
  type ProjectMetadata,
} from "@/lib/project-types";
import { ensureDevServer } from "@/lib/terminal-bridge";
import { FIRST_PORT, LOCAL_HOST } from "@/lib/vars";

const toProjectItem = (id: string, metadata: ProjectMetadata): ProjectItem => ({
  id,
  name: metadata.name,
  previewUrl: `http://${LOCAL_HOST}:${metadata.devPort}`,
  productionUrl: `http://${LOCAL_HOST}:${metadata.prodPort}`,
  conversations: metadata.conversations,
  releases: metadata.releases,
  liveReleaseId: metadata.liveReleaseId,
  usage: metadata.usage ?? EMPTY_USAGE,
});

export async function GET() {
  const projects = await listProjects();
  return NextResponse.json({
    projects: projects.map(({ id, metadata }) => toProjectItem(id, metadata)),
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

  // ponytail: ports only avoid other projects' ports, not other programs on
  // this machine; change FIRST_PORT in lib/vars.ts if one collides.
  const devPort =
    Math.max(
      FIRST_PORT - 2,
      ...(await listProjects()).map(({ metadata }) => metadata.devPort),
    ) + 2;

  const projectId = randomUUID().slice(0, 8);
  const metadata: ProjectMetadata = {
    version: 4,
    name,
    createdAt: new Date().toISOString(),
    devPort,
    prodPort: devPort + 1,
    conversations: [],
    releases: [],
    liveReleaseId: null,
  };

  // Recorded before the slow clone and install, so a project created
  // meanwhile is not handed the same ports.
  await writeProjectMetadata(projectId, metadata);

  try {
    await createProjectFiles(projectId, sourceRepoUrl);
  } catch (error) {
    await rm(projectPaths(projectId).root, { recursive: true, force: true });
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

  ensureDevServer(projectId, devPort);

  const conversationId = randomUUID();
  const next = await createConversation(
    projectId,
    conversationId,
    payload.conversationTitle?.trim(),
  );

  return NextResponse.json({
    id: projectId,
    conversationId,
    project: toProjectItem(projectId, next),
  });
}
