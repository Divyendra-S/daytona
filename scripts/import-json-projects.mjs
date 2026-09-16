/**
 * One-off: copy the JSON state of existing projects into Postgres.
 *
 *   node --env-file=.env.local scripts/import-json-projects.mjs
 *
 * Safe to re-run — rows that already exist are left alone. The project folders
 * themselves are untouched; only their `project.json` and conversations move.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";

const PROJECTS_DIR = path.join(process.cwd(), "projects");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set — add it to .env.local.");
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL, { prepare: false });
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));

const entries = await readdir(PROJECTS_DIR).catch(() => []);
let imported = 0;

for (const id of entries.filter((name) => /^[0-9a-f]{8}$/.test(name))) {
  const root = path.join(PROJECTS_DIR, id);
  const metadata = await readJson(path.join(root, "project.json")).catch(
    () => null,
  );
  if (!metadata) continue;

  const usage = metadata.usage ?? {};
  // A project written before the move to Daytona has no sandbox: it lists, and
  // its conversations open, but it cannot run until it is recreated.
  await sql`
    insert into projects (id, name, created_at, sandbox_id, live_release_id,
                          input_tokens, output_tokens, cost, requests, usage_since)
    values (${id}, ${metadata.name}, ${metadata.createdAt},
            ${metadata.sandboxId ?? null}, ${metadata.liveReleaseId ?? null},
            ${usage.inputTokens ?? 0}, ${usage.outputTokens ?? 0},
            ${usage.cost ?? 0}, ${usage.requests ?? 0}, ${usage.since ?? null})
    on conflict (id) do nothing`;

  for (const release of metadata.releases ?? []) {
    await sql`
      insert into releases (project_id, id, message, commit, state, error, created_at)
      values (${id}, ${release.id}, ${release.message}, ${release.commit},
              ${release.state}, ${release.error ?? null}, ${release.createdAt})
      on conflict (project_id, id) do nothing`;
  }

  const files = await readdir(path.join(root, "conversations")).catch(() => []);
  for (const file of files.filter((name) => name.endsWith(".json"))) {
    const conversationId = file.replace(/\.json$/, "");
    const summary = (metadata.conversations ?? []).find(
      (conversation) => conversation.id === conversationId,
    );
    const messages = await readJson(
      path.join(root, "conversations", file),
    ).catch(() => []);
    const now = new Date().toISOString();

    await sql`
      insert into conversations (project_id, id, title, created_at, updated_at, messages)
      values (${id}, ${conversationId}, ${summary?.title ?? "Untitled conversation"},
              ${summary?.createdAt ?? now}, ${summary?.updatedAt ?? now},
              ${sql.json(messages)})
      on conflict (project_id, id) do nothing`;
  }

  imported += 1;
  console.log(`imported ${id} — ${metadata.name}`);
}

console.log(`${imported} project(s) imported.`);
await sql.end();
