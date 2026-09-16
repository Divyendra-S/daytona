import { mkdir } from "node:fs/promises";
import { projectPaths } from "./project-paths";
import { createProjectSandbox, openProject } from "./sandbox";
import { TEMPLATE_REPO } from "./vars";

export { isProjectId, projectPaths, safeSegments } from "./project-paths";

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
  // The project's local folder holds its JSON state; its code lives in the sandbox.
  await mkdir(projectPaths(projectId).root, { recursive: true });

  const { sandboxId, sandbox } = await createProjectSandbox(projectId);

  await runStep(
    "Clone",
    projectId,
    `git clone --quiet --depth 1 ${shellQuote(repoUrl ?? TEMPLATE_REPO)} app`,
    sandbox.root,
    300,
  );

  if (!repoUrl) {
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
