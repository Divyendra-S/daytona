import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { projectPaths } from "./local-project";

/**
 * Keep an Adorable-made scratch folder out of the project's commits.
 *
 * Publishing runs `git add -A`, so a reference file written for the agent — a pasted design, a
 * fetched page, the design rules — would otherwise be committed and shipped with the app.
 * `.git/info/exclude` is the repo-local ignore list: it never lands in a commit itself and
 * leaves the project's `.gitignore` alone. A file that was already committed stays tracked.
 */
export const excludeFromGit = async (projectId: string, entry: string) => {
  const file = path.join(
    projectPaths(projectId).app,
    ".git",
    "info",
    "exclude",
  );
  const current = await readFile(file, "utf8").catch(() => "");
  if (current.split("\n").some((line) => line.trim() === entry)) return;
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(
    file,
    `${current && !current.endsWith("\n") ? "\n" : ""}${entry}\n`,
  );
};
