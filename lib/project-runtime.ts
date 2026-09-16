import { setProjectSandbox } from "./project-storage";
import {
  createProjectSandbox,
  openProject,
  type ProjectSandbox,
} from "./sandbox";
import { TEMPLATE_REPO } from "./vars";

export { isProjectId, safeSegments } from "./project-paths";

export const shellQuote = (value: string): string =>
  `'${value.replace(/'/g, `'\\''`)}'`;

/** Commits made on the user's behalf, independent of any git config in the sandbox. */
export const GIT_IDENTITY =
  "-c user.name='AI Builder' -c user.email=ai-builder@localhost";

export type RunResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  command: string;
};

/** The default for a command that does not say how long it may take, in seconds. */
const DEFAULT_TIMEOUT = 300;

/**
 * Run a shell command to completion in the project's sandbox.
 *
 * `timeoutSeconds` is SECONDS, not milliseconds — Daytona's own unit, and its
 * default is a 10-second limit that a dependency install would trip over.
 *
 * Daytona merges the command's stderr into its output rather than returning
 * the two separately, so `stderr` is always empty here and everything lands in
 * `stdout`. Callers already read both, so nothing is lost.
 */
export const run = async (
  projectId: string,
  command: string,
  cwd?: string,
  timeoutSeconds = DEFAULT_TIMEOUT,
): Promise<RunResult> => {
  const project = await openProject(projectId);
  try {
    const result = await project.sandbox.process.executeCommand(
      command,
      cwd ?? project.app,
      undefined,
      timeoutSeconds,
    );
    return {
      ok: result.exitCode === 0,
      stdout: result.result ?? "",
      stderr: "",
      exitCode: result.exitCode,
      command,
    };
  } catch (error) {
    return {
      ok: false,
      stdout: "",
      stderr: error instanceof Error ? error.message : "Command failed.",
      exitCode: null,
      command,
    };
  }
};

/** Run a step that has to succeed, failing with the tail of its output. */
export const runStep = async (
  step: string,
  projectId: string,
  command: string,
  cwd?: string,
  timeoutSeconds?: number,
) => {
  const result = await run(projectId, command, cwd, timeoutSeconds);
  if (!result.ok) {
    const detail = `${result.stdout}\n${result.stderr}`.trim().slice(-500);
    throw new Error(`${step} failed${detail ? `: ${detail}` : "."}`);
  }
  return result;
};

/**
 * The home page a template project starts with.
 *
 * The template's own `app/page.tsx` is a Freestyle logo — a cloud shape — at
 * 10% opacity on an otherwise empty page. In the preview that reads as a
 * broken or still-loading frame showing "some cloud icon", not as a running
 * app, and nothing tells the user the sandbox is fine. This page says so in
 * words, and is replaced the moment the agent builds something.
 */
export const STARTER_PAGE = `export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 p-8 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">Your app is running</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        This is the starter home page. Describe what you want to build in the
        chat and it will take shape here.
      </p>
    </main>
  );
}
`;

/**
 * Put the starter home page in place of the template's placeholder, and drop
 * the logo it rendered so nothing else references it. Runs before the initial
 * commit, so the project's history starts from the page the user sees.
 */
export const installStarterPage = async (
  projectId: string,
  sandbox: ProjectSandbox,
) => {
  const { writeSandboxFile } = await import("./project-files");
  await writeSandboxFile(
    projectId,
    `${sandbox.app}/app/page.tsx`,
    STARTER_PAGE,
  );
  await sandbox.sandbox.fs
    .deleteFile(`${sandbox.app}/public/placeholder-freestyle-logo.svg`)
    .catch(() => {
      // A template without the logo has nothing to remove.
    });
};

/**
 * Give a new project a sandbox and fill it: the template as a fresh repo, or a
 * public git project with its history kept, then its dependencies.
 *
 * Returns the sandbox's id for the caller to store — without it there is no way
 * back to the project's code.
 */
export const createProjectFiles = async (
  projectId: string,
  repoUrl?: string,
) => {
  const { sandboxId, sandbox } = await createProjectSandbox(projectId);

  // Before a single step runs: each one opens the sandbox by project id, which
  // reads this, and a creation that fails from here on can only clean up the
  // sandbox it made if the row names it.
  await setProjectSandbox(projectId, sandboxId);

  await runStep(
    "Clone",
    projectId,
    `git clone --quiet --depth 1 ${shellQuote(repoUrl ?? TEMPLATE_REPO)} app`,
    sandbox.root,
    300,
  );

  if (!repoUrl) {
    await installStarterPage(projectId, sandbox);
    await runStep(
      "Repository setup",
      projectId,
      `rm -rf .git && git init --quiet && git add -A && git ${GIT_IDENTITY} commit --quiet -m 'Initial commit'`,
      sandbox.app,
      120,
    );
  }

  await runStep(
    "Dependency install",
    projectId,
    "npm install --no-audit --no-fund",
    sandbox.app,
    900,
  );

  return sandboxId;
};
