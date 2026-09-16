import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = process.env["DATABASE_URL"];

if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set — add your Supabase connection string to .env.local.",
  );
}

/** Kept on globalThis so a hot reload does not leave a pool behind every time. */
const client =
  ((globalThis as Record<string, unknown>)["__aiBuilderSql"] as
    | ReturnType<typeof postgres>
    | undefined) ??
  ((globalThis as Record<string, unknown>)["__aiBuilderSql"] = postgres(
    connectionString,
    // Supabase's transaction-mode pooler does not support prepared statements.
    { prepare: false },
  ));

export const db = drizzle(client, { schema, casing: "snake_case" });
