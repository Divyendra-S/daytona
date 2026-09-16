import { sql } from "drizzle-orm";
import {
  bigint,
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { type UIMessage } from "ai";
import type { ProjectRelease } from "../project-types";

const createdAt = () =>
  timestamp({ withTimezone: true }).notNull().defaultNow();

/**
 * A project's state. Its code lives in its Daytona sandbox — only what the app
 * reads back (name, sandbox, history, usage) lives here.
 */
export const projects = pgTable("projects", {
  id: text().primaryKey(),
  name: text().notNull(),
  createdAt: createdAt(),
  /**
   * The Daytona sandbox holding this project's code, git history and servers.
   * Null for a project created before the move to Daytona, which cannot be
   * opened until it is recreated.
   */
  sandboxId: text(),
  /** The release production is currently serving. */
  liveReleaseId: text(),
  inputTokens: bigint({ mode: "number" }).notNull().default(0),
  outputTokens: bigint({ mode: "number" }).notNull().default(0),
  /** USD, as reported by OpenRouter's usage accounting. */
  cost: doublePrecision().notNull().default(0),
  requests: integer().notNull().default(0),
  /** When the first usage was recorded; earlier calls were never counted. */
  usageSince: timestamp({ withTimezone: true }),
  /**
   * The signed preview URL in use for each of the project's ports, and when it
   * expires. Kept so the browser keeps seeing one hostname: Daytona's warning
   * page is acknowledged per host, so signing a fresh URL on every poll put the
   * preview back behind that page seconds after it was dismissed.
   */
  previewUrls: jsonb()
    .$type<Record<string, { url: string; expiresAt: string }>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
});

/** Every publish, kept so the history view can show what shipped when. */
export const releases = pgTable(
  "releases",
  {
    projectId: text()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    id: text().notNull(),
    message: text().notNull(),
    /** The commit in the project's app repo this release was cut from. */
    commit: text().notNull(),
    state: text().$type<ProjectRelease["state"]>().notNull(),
    error: text(),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.id] })],
);

/** One row per conversation, its messages kept whole as they are saved. */
export const conversations = pgTable(
  "conversations",
  {
    projectId: text()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    id: text().notNull(),
    title: text().notNull(),
    createdAt: createdAt(),
    updatedAt: createdAt(),
    messages: jsonb()
      .$type<UIMessage[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.id] })],
);
