import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { type UIMessage } from "ai";
import { isProjectId, projectPaths } from "./project-paths";
import {
  EMPTY_USAGE,
  type ProjectConversationSummary,
  type ProjectMetadata,
  type ProjectRelease,
  type ProjectUsage,
} from "./project-types";
import { PROJECTS_DIR } from "./vars";

/**
 * A project's state is JSON in its folder, next to its app: `project.json`
 * for metadata and `conversations/<id>.json` for each conversation.
 */
const metadataPath = (projectId: string) =>
  path.join(projectPaths(projectId).root, "project.json");

/** Conversation ids are generated UUIDs, and become file names. */
const CONVERSATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const conversationPath = (projectId: string, conversationId: string) => {
  if (!CONVERSATION_ID.test(conversationId)) {
    throw new Error("Invalid conversation id.");
  }
  return path.join(
    projectPaths(projectId).root,
    "conversations",
    `${conversationId}.json`,
  );
};

/** Write through a temp file and rename, so a reader never sees half a file. */
const writeJson = async (file: string, value: unknown) => {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2));
  await rename(temp, file);
};

/**
 * A project's metadata, brought up to the current shape.
 *
 * Version 4 kept the project's code on this machine and addressed its servers
 * by port. Version 5 keeps the code in a Daytona sandbox instead. A v4 project
 * is readable — so it still lists, and its conversations still open — but it
 * has no sandbox, and anything that needs to run its code says so rather than
 * failing obscurely.
 */
const migrate = (
  stored: ProjectMetadata & { version: number },
): ProjectMetadata =>
  stored.version >= 5
    ? stored
    : { ...stored, version: 5, sandboxId: stored.sandboxId ?? null };

export const readProjectMetadata = async (
  projectId: string,
): Promise<ProjectMetadata> =>
  migrate(
    JSON.parse(
      await readFile(metadataPath(projectId), "utf8"),
    ) as ProjectMetadata & { version: number },
  );

export const writeProjectMetadata = async (
  projectId: string,
  metadata: ProjectMetadata,
) => {
  await writeJson(metadataPath(projectId), metadata);
  return metadata;
};

/** Every project, newest first. */
export const listProjects = async () => {
  const entries = await readdir(PROJECTS_DIR).catch(() => [] as string[]);
  const projects = await Promise.all(
    entries.filter(isProjectId).map(async (id) => {
      const metadata = await readProjectMetadata(id).catch(() => null);
      return metadata ? { id, metadata } : null;
    }),
  );
  return projects
    .filter((project) => project !== null)
    .sort((a, b) => b.metadata.createdAt.localeCompare(a.metadata.createdAt));
};

/**
 * One queue per project, so concurrent read-transform-writes — a chat saving
 * while a release settles — cannot overwrite each other.
 */
const metadataQueues = new Map<string, Promise<unknown>>();

const updateProjectMetadata = (
  projectId: string,
  update: (metadata: ProjectMetadata) => ProjectMetadata,
) => {
  const next = (metadataQueues.get(projectId) ?? Promise.resolve()).then(
    async () =>
      writeProjectMetadata(
        projectId,
        update(await readProjectMetadata(projectId)),
      ),
  );
  metadataQueues.set(
    projectId,
    next.catch(() => {}),
  );
  return next;
};

const deriveConversationTitle = (
  messages: UIMessage[],
  fallback: string,
): string => {
  const userMessage = messages.find((message) => message.role === "user");
  const textPart = userMessage?.parts?.find((part) => part.type === "text");
  const text = textPart && "text" in textPart ? textPart.text : "";
  const clean = text.trim().replace(/\s+/g, " ");
  return clean ? clean.slice(0, 60) : fallback;
};

export const createConversation = async (
  projectId: string,
  conversationId: string,
  initialTitle?: string,
) => {
  const file = conversationPath(projectId, conversationId);
  const now = new Date().toISOString();

  const [metadata] = await Promise.all([
    updateProjectMetadata(projectId, (current) => ({
      ...current,
      conversations: [
        {
          id: conversationId,
          title:
            initialTitle?.trim().replace(/\s+/g, " ").slice(0, 60) ||
            `Conversation ${current.conversations.length + 1}`,
          createdAt: now,
          updatedAt: now,
        },
        ...current.conversations,
      ],
    })),
    writeJson(file, []),
  ]);

  return metadata;
};

export const readConversationMessages = async (
  projectId: string,
  conversationId: string,
): Promise<UIMessage[]> =>
  JSON.parse(
    await readFile(conversationPath(projectId, conversationId), "utf8"),
  ) as UIMessage[];

export const saveConversationMessages = async (
  projectId: string,
  conversationId: string,
  messages: UIMessage[],
) => {
  const file = conversationPath(projectId, conversationId);
  const now = new Date().toISOString();

  const [metadata] = await Promise.all([
    updateProjectMetadata(projectId, (current) => {
      const existing = current.conversations.find(
        (conversation) => conversation.id === conversationId,
      );
      const summary: ProjectConversationSummary = {
        id: conversationId,
        title: deriveConversationTitle(
          messages,
          existing?.title ?? `Conversation ${current.conversations.length + 1}`,
        ),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };

      return {
        ...current,
        conversations: [
          summary,
          ...current.conversations.filter(
            (conversation) => conversation.id !== conversationId,
          ),
        ],
      };
    }),
    writeJson(file, messages),
  ]);

  return metadata;
};

export const addRelease = (projectId: string, release: ProjectRelease) =>
  updateProjectMetadata(projectId, (current) => ({
    ...current,
    releases: [release, ...current.releases].slice(0, 50),
  }));

export const updateRelease = (
  projectId: string,
  releaseId: string,
  patch: Partial<ProjectRelease>,
) =>
  updateProjectMetadata(projectId, (current) => ({
    ...current,
    releases: current.releases.map((release) =>
      release.id === releaseId ? { ...release, ...patch } : release,
    ),
    liveReleaseId: patch.state === "live" ? releaseId : current.liveReleaseId,
  }));

export const renameProject = (projectId: string, name: string) =>
  updateProjectMetadata(projectId, (current) => ({ ...current, name }));

/** Add one model call's tokens and cost to the project's running total. */
export const addUsage = (
  projectId: string,
  usage: Omit<ProjectUsage, "since">,
) =>
  updateProjectMetadata(projectId, (current) => {
    const total = current.usage ?? EMPTY_USAGE;
    return {
      ...current,
      usage: {
        inputTokens: total.inputTokens + usage.inputTokens,
        outputTokens: total.outputTokens + usage.outputTokens,
        cost: total.cost + usage.cost,
        requests: total.requests + usage.requests,
        since: total.since ?? new Date().toISOString(),
      },
    };
  });
