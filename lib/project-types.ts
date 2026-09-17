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
  version: 5;
  name: string;
  createdAt: string;
  /**
   * The Daytona sandbox holding this project's code, git history and servers.
   * Null only for a project created before the move to Daytona, whose code is
   * still on this machine and which cannot be opened until it is recreated.
   */
  sandboxId: string | null;
  conversations: ProjectConversationSummary[];
  releases: ProjectRelease[];
  /** The release production is currently serving. */
  liveReleaseId: string | null;
  /** The label the project is published under; null means its id is used. */
  subdomain: string | null;
  /** Absent until the project's first recorded model call. */
  usage?: ProjectUsage;
};

export type ProjectItem = {
  id: string;
  name: string;
  /**
   * A signed, expiring URL to the sandbox's dev port, through the deployment's
   * preview proxy when it has one — what the address bar shows, and where
   * "open in a new tab" goes. Not where the preview frame loads from: that is
   * the `proxyUrl` from `preview-status`, which carries the click-to-select
   * bridge. Empty when signing fails, so never a URL base.
   */
  previewUrl: string;
  /** Where the project is published, live or not yet. Empty when no `SITES_DOMAIN` is set. */
  productionUrl: string;
  /** The first label of `productionUrl`'s hostname: the user's choice, or the project id. */
  subdomain: string;
  /** False for a pre-Daytona project, which has no sandbox and cannot be opened. */
  hasSandbox: boolean;
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
