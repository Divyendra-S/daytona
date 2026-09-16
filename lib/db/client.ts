import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const onCloudflare = () =>
  typeof navigator !== "undefined" &&
  navigator.userAgent === "Cloudflare-Workers";

/** The Hyperdrive binding's connection string, when one is bound. */
const hyperdriveUrl = () =>
  (globalThis as { HYPERDRIVE?: { connectionString?: string } }).HYPERDRIVE
    ?.connectionString;

/** Node keeps one connection: none of the Worker's rules apply, and a pool is worth having. */
const local: { client?: ReturnType<typeof postgres> } = {};

/**
 * A database handle for the request being served.
 *
 * Deliberately not cached on a Worker: it may not use a socket opened while
 * serving a different request, so a connection kept on `globalThis` works for
 * the first request an isolate handles and hangs on every one after it.
 * Connecting per request is what Hyperdrive exists to make cheap — bind one as
 * `HYPERDRIVE` and Cloudflare pools them on its side.
 */
export const getDb = () => {
  const connectionString = hyperdriveUrl() ?? process.env["DATABASE_URL"] ?? "";

  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set — add your Postgres connection string to .env.local, or bind a HYPERDRIVE config.",
    );
  }

  // Supabase's transaction-mode pooler does not support prepared statements,
  // and `fetch_types` would spend a round trip per connection asking about
  // types this app never uses.
  const client = onCloudflare()
    ? postgres(connectionString, { prepare: false, fetch_types: false, max: 5 })
    : (local.client ??= postgres(connectionString, { prepare: false }));

  return drizzle(client, { schema, casing: "snake_case" });
};
