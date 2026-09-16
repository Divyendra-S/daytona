#!/usr/bin/env node
/**
 * List the sandboxes AI Builder has created, and delete the ones no project
 * points at any more.
 *
 * A sandbox costs money while it runs and disk while it is stopped, so one left
 * behind by a project folder that was deleted by hand is a bill for nothing.
 * Every sandbox is labelled with its project id when it is created, which is
 * what makes them findable without the metadata that has already gone.
 *
 * Usage:
 *   node scripts/daytona-gc.mjs            # list, delete nothing
 *   node scripts/daytona-gc.mjs --delete   # delete the orphans it found
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { Daytona } from "@daytonaio/sdk";
import postgres from "postgres";

const ROOT = path.resolve(import.meta.dirname, "..");
const LABEL = "aiBuilderProjectId";

// The app reads .env.local through Next; a plain script has to do it itself.
for (const line of readFileSync(path.join(ROOT, ".env.local"), "utf8").split(
  "\n",
)) {
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (match && !process.env[match[1]]) {
    process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, "");
  }
}

const apiKey = process.env["DAYTONA_API_KEY"];
if (!apiKey) {
  console.error("DAYTONA_API_KEY is not set in .env.local.");
  process.exit(1);
}

if (!process.env["DATABASE_URL"]) {
  console.error("DATABASE_URL is not set in .env.local.");
  process.exit(1);
}

const shouldDelete = process.argv.includes("--delete");
const daytona = new Daytona({ apiKey });

/**
 * Which sandbox each project still claims. Read once, up front: a project that
 * is gone from the database has nothing pointing at its sandbox any more, and
 * that is exactly what makes the sandbox an orphan.
 */
const sql = postgres(process.env["DATABASE_URL"], { prepare: false });
const claimedBy = new Map(
  (await sql`select id, sandbox_id from projects`).map((row) => [
    row.id,
    row.sandbox_id,
  ]),
);
await sql.end();

const orphans = [];
let total = 0;

for await (const sandbox of daytona.list({ labels: { [LABEL]: undefined } })) {
  const projectId = sandbox.labels?.[LABEL];
  if (!projectId) continue;
  total += 1;

  const claimed = claimedBy.get(projectId) === sandbox.id;
  const age = sandbox.createdAt
    ? `${Math.round((Date.now() - Date.parse(sandbox.createdAt)) / 86_400_000)}d`
    : "?";

  console.log(
    `${claimed ? "keep " : "ORPHAN"}  ${sandbox.id}  project=${projectId}  ` +
      `state=${sandbox.state}  age=${age}  ${sandbox.cpu}cpu/${sandbox.memory}gb/${sandbox.disk}gb`,
  );
  if (!claimed) orphans.push(sandbox);
}

console.log(`\n${total} AI Builder sandbox(es), ${orphans.length} orphaned.`);

if (!orphans.length) process.exit(0);
if (!shouldDelete) {
  console.log(
    "Re-run with --delete to remove the orphans. Nothing was changed.",
  );
  process.exit(0);
}

for (const sandbox of orphans) {
  process.stdout.write(`deleting ${sandbox.id}... `);
  await sandbox.delete().then(
    () => console.log("done"),
    (error) => console.log(`failed: ${error.message}`),
  );
}
