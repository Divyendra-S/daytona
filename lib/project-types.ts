export type ProjectRelease = {
  id: string;
  message: string;
  createdAt: string;
  /** The commit in the project's app repo this release was cut from. */
  commit: string;
  state: "publishing" | "live" | "failed";
  error: string | null;
};

export type ProjectConversationSummary = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

/** Model usage summed over every chat turn and canvas replace in a project. */
export type ProjectUsage = {
  inputTokens: number;
  outputTokens: number;
  /** USD, as reported by OpenRouter's usage accounting. */
  cost: number;
  /** Model requests made (a chat turn with tool calls makes several). */
  requests: number;
  /** When the first usage was recorded; earlier calls were never counted. */
  since: string | null;
};

export const EMPTY_USAGE: ProjectUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cost: 0,
  requests: 0,
  since: null,
};

/** A project's state, stored as `project.json` in its folder under `projects/`. */
export type ProjectMetadata = {
  version: 4;
  name: string;
  createdAt: string;
  /** The dev server's port: the preview is http://127.0.0.1:devPort. */
  devPort: number;
  /** The production server's port, serving the live release once published. */
  prodPort: number;
  conversations: ProjectConversationSummary[];
  releases: ProjectRelease[];
  /** The release production is currently serving. */
  liveReleaseId: string | null;
  /** Absent until the project's first recorded model call. */
  usage?: ProjectUsage;
};

export type ProjectItem = {
  id: string;
  name: string;
  previewUrl: string;
  productionUrl: string;
  conversations: ProjectConversationSummary[];
  releases: ProjectRelease[];
  liveReleaseId: string | null;
  usage: ProjectUsage;
};

/** Nested file entry for the read-only project code preview. */
export type ProjectFileNode = {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: ProjectFileNode[];
};
