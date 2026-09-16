import { run, shellQuote } from "./project-runtime";

/**
 * Keep an Adorable-made scratch folder out of the project's commits.
 *
 * Publishing runs `git add -A`, so a reference file written for the agent — a pasted design, a
 * fetched page, the design rules — would otherwise be committed and shipped with the app.
 * `.git/info/exclude` is the repo-local ignore list: it never lands in a commit itself and
 * leaves the project's `.gitignore` alone. A file that was already committed stays tracked.
 */
export const excludeFromGit = async (projectId: string, entry: string) => {
  const quoted = shellQuote(entry);
  await run(
    projectId,
    `mkdir -p .git/info && touch .git/info/exclude && grep -qxF -- ${quoted} .git/info/exclude || printf '%s\\n' ${quoted} >> .git/info/exclude`,
    undefined,
    30,
  );
};
