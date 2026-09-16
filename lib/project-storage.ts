import { and, desc, eq, sql } from "drizzle-orm";
import { type UIMessage } from "ai";
import { getDb } from "./db/client";
import { conversations, projects, releases } from "./db/schema";
import {
  type ProjectConversationSummary,
  type ProjectMetadata,
  type ProjectRelease,
  type ProjectUsage,
} from "./project-types";

/**
 * A project's state lives in Postgres (Supabase): one row per project, per
 * release and per conversation, the conversation's messages kept as JSON. The
 * code itself lives in the project's Daytona sandbox (see `lib/sandbox.ts`),
 * which the project row points at.
 */

type ProjectRow = typeof projects.$inferSelect;
type ReleaseRow = typeof releases.$inferSelect;

/** Conversations are listed without their messages, which are the bulk of a row. */
const summaryColumns = {
  projectId: conversations.projectId,
  id: conversations.id,
  title: conversations.title,
  createdAt: conversations.createdAt,
  updatedAt: conversations.updatedAt,
};

type ConversationSummaryRow = {
  [K in keyof typeof summaryColumns]: (typeof conversations.$inferSelect)[K];
};

/** Conversation ids are generated UUIDs; anything else never reaches a query. */
const CONVERSATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const assertConversationId = (conversationId: string) => {
  if (!CONVERSATION_ID.test(conversationId)) {
    throw new Error("Invalid conversation id.");
  }
};

const toSummary = (
  row: ConversationSummaryRow,
): ProjectConversationSummary => ({
  id: row.id,
  title: row.title,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const toRelease = (row: ReleaseRow): ProjectRelease => ({
  id: row.id,
  message: row.message,
  createdAt: row.createdAt.toISOString(),
  commit: row.commit,
  state: row.state,
  error: row.error,
});

const toMetadata = (
  project: ProjectRow,
  conversationRows: ConversationSummaryRow[],
  releaseRows: ReleaseRow[],
): ProjectMetadata => ({
  version: 5,
  name: project.name,
  createdAt: project.createdAt.toISOString(),
  sandboxId: project.sandboxId,
  conversations: conversationRows.map(toSummary),
  releases: releaseRows.map(toRelease),
  liveReleaseId: project.liveReleaseId,
  usage: {
    inputTokens: project.inputTokens,
    outputTokens: project.outputTokens,
    cost: project.cost,
    requests: project.requests,
    since: project.usageSince?.toISOString() ?? null,
  },
});

export const readProjectMetadata = async (
  projectId: string,
): Promise<ProjectMetadata> => {
  const [project] = await getDb()
    .select()
    .from(projects)
    .where(eq(projects.id, projectId));

  if (!project) throw new Error("Unknown project.");

  const [conversationRows, releaseRows] = await Promise.all([
    getDb()
      .select(summaryColumns)
      .from(conversations)
      .where(eq(conversations.projectId, projectId))
      .orderBy(desc(conversations.updatedAt)),
    getDb()
      .select()
      .from(releases)
      .where(eq(releases.projectId, projectId))
      .orderBy(desc(releases.createdAt)),
  ]);

  return toMetadata(project, conversationRows, releaseRows);
};

/**
 * Create or update a project's own row. Conversations and releases are rows of
 * their own, written by the functions below — this does not touch them.
 */
export const writeProjectMetadata = async (
  projectId: string,
  metadata: ProjectMetadata,
) => {
  const values = {
    id: projectId,
    name: metadata.name,
    createdAt: new Date(metadata.createdAt),
    sandboxId: metadata.sandboxId,
    liveReleaseId: metadata.liveReleaseId,
  };

  await getDb()
    .insert(projects)
    .values(values)
    .onConflictDoUpdate({ target: projects.id, set: values });

  return metadata;
};

/**
 * Forget a project: its conversations and releases go with it, through the
 * foreign keys. The sandbox holding its code is deleted separately, by the
 * caller, because the row has to outlive the sandbox long enough to name it.
 */
export const deleteProject = async (projectId: string) => {
  await getDb().delete(projects).where(eq(projects.id, projectId));
};

/**
 * Point a project at its sandbox, the moment there is one.
 *
 * Written before the sandbox is filled rather than after: every step of filling
 * it opens the sandbox by project id, which reads this column, and a cleanup
 * after a failed creation needs it too — without it the sandbox is orphaned,
 * running and unreachable, against the account's quota.
 */
export const setProjectSandbox = async (
  projectId: string,
  sandboxId: string,
) => {
  await getDb()
    .update(projects)
    .set({ sandboxId })
    .where(eq(projects.id, projectId));
};

/** The signed preview URL a project is currently handing out for a port. */
export const readPreviewUrl = async (projectId: string, port: number) => {
  const [row] = await getDb()
    .select({ previewUrls: projects.previewUrls })
    .from(projects)
    .where(eq(projects.id, projectId));

  return row?.previewUrls?.[String(port)] ?? null;
};

/** Merged into the column rather than written over it, so ports do not evict each other. */
export const savePreviewUrl = async (
  projectId: string,
  port: number,
  entry: { url: string; expiresAt: string },
) => {
  await getDb()
    .update(projects)
    .set({
      previewUrls: sql`coalesce(${projects.previewUrls}, '{}'::jsonb) || ${JSON.stringify(
        { [String(port)]: entry },
      )}::jsonb`,
    })
    .where(eq(projects.id, projectId));
};

/** Every project, newest first. */
export const listProjects = async () => {
  const [projectRows, conversationRows, releaseRows] = await Promise.all([
    getDb().select().from(projects).orderBy(desc(projects.createdAt)),
    getDb()
      .select(summaryColumns)
      .from(conversations)
      .orderBy(desc(conversations.updatedAt)),
    getDb().select().from(releases).orderBy(desc(releases.createdAt)),
  ]);

  // ponytail: rows filtered per project — fine for tens of projects, group
  // them into a Map if a user ever has hundreds.
  return projectRows.map((project) => ({
    id: project.id,
    metadata: toMetadata(
      project,
      conversationRows.filter((row) => row.projectId === project.id),
      releaseRows.filter((row) => row.projectId === project.id),
    ),
  }));
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

const countConversations = (projectId: string) =>
  getDb().$count(conversations, eq(conversations.projectId, projectId));

export const createConversation = async (
  projectId: string,
  conversationId: string,
  initialTitle?: string,
) => {
  assertConversationId(conversationId);

  const title =
    initialTitle?.trim().replace(/\s+/g, " ").slice(0, 60) ||
    `Conversation ${(await countConversations(projectId)) + 1}`;

  await getDb()
    .insert(conversations)
    .values({ projectId, id: conversationId, title })
    .onConflictDoNothing();

  return readProjectMetadata(projectId);
};

export const readConversationMessages = async (
  projectId: string,
  conversationId: string,
): Promise<UIMessage[]> => {
  assertConversationId(conversationId);

  const [row] = await getDb()
    .select({ messages: conversations.messages })
    .from(conversations)
    .where(
      and(
        eq(conversations.projectId, projectId),
        eq(conversations.id, conversationId),
      ),
    );

  if (!row) throw new Error("Unknown conversation.");
  return row.messages;
};

export const saveConversationMessages = async (
  projectId: string,
  conversationId: string,
  messages: UIMessage[],
) => {
  assertConversationId(conversationId);

  const [existing] = await getDb()
    .select({ title: conversations.title })
    .from(conversations)
    .where(
      and(
        eq(conversations.projectId, projectId),
        eq(conversations.id, conversationId),
      ),
    );

  const title = deriveConversationTitle(
    messages,
    existing?.title ??
      `Conversation ${(await countConversations(projectId)) + 1}`,
  );
  const updatedAt = new Date();

  await getDb()
    .insert(conversations)
    .values({ projectId, id: conversationId, title, messages, updatedAt })
    .onConflictDoUpdate({
      target: [conversations.projectId, conversations.id],
      set: { title, messages, updatedAt },
    });

  return readProjectMetadata(projectId);
};

export const addRelease = async (
  projectId: string,
  release: ProjectRelease,
) => {
  await getDb()
    .insert(releases)
    .values({
      projectId,
      id: release.id,
      message: release.message,
      commit: release.commit,
      state: release.state,
      error: release.error,
      createdAt: new Date(release.createdAt),
    });

  return readProjectMetadata(projectId);
};

export const updateRelease = async (
  projectId: string,
  releaseId: string,
  patch: Partial<ProjectRelease>,
) => {
  const set: Partial<typeof releases.$inferInsert> = {};
  if (patch.message !== undefined) set.message = patch.message;
  if (patch.commit !== undefined) set.commit = patch.commit;
  if (patch.state !== undefined) set.state = patch.state;
  if (patch.error !== undefined) set.error = patch.error;
  if (patch.createdAt !== undefined) set.createdAt = new Date(patch.createdAt);

  if (Object.keys(set).length > 0) {
    await getDb()
      .update(releases)
      .set(set)
      .where(
        and(eq(releases.projectId, projectId), eq(releases.id, releaseId)),
      );
  }

  // Production serves this release from the moment it goes live.
  if (patch.state === "live") {
    await getDb()
      .update(projects)
      .set({ liveReleaseId: releaseId })
      .where(eq(projects.id, projectId));
  }

  return readProjectMetadata(projectId);
};

/** Add one model call's tokens and cost to the project's running total. */
export const addUsage = async (
  projectId: string,
  usage: Omit<ProjectUsage, "since">,
) => {
  await getDb()
    .update(projects)
    .set({
      inputTokens: sql`${projects.inputTokens} + ${usage.inputTokens}`,
      outputTokens: sql`${projects.outputTokens} + ${usage.outputTokens}`,
      cost: sql`${projects.cost} + ${usage.cost}`,
      requests: sql`${projects.requests} + ${usage.requests}`,
      usageSince: sql`coalesce(${projects.usageSince}, now())`,
    })
    .where(eq(projects.id, projectId));
};
