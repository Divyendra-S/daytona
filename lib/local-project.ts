import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { PROJECTS_DIR, TEMPLATE_REPO } from "./vars";

/** Project ids become folder names, so anything else is rejected before it reaches a path. */
const PROJECT_ID = /^[0-9a-f]{8}$/;

export const isProjectId = (value: string) => PROJECT_ID.test(value);

/**
 * A project's folders: `app/` is the git repo the agent edits and the dev
 * server serves, `production/` is a clone of it that publishing builds and
 * serves, and the root holds the project's JSON state.
 */
export const projectPaths = (projectId: string) => {
  if (!isProjectId(projectId)) throw new Error("Invalid project id.");
  const root = path.join(PROJECTS_DIR, projectId);
  return {
    root,
    app: path.join(root, "app"),
    production: path.join(root, "production"),
  };
};

export const shellQuote = (value: string): string =>
  `'${value.replace(/'/g, `'\\''`)}'`;

/** Commits made on the user's behalf, independent of their global git config. */
export const GIT_IDENTITY =
  "-c user.name='AI Builder' -c user.email=ai-builder@localhost";

/**
 * What a project's processes inherit from AI Builder: enough to find node, npm
 * and git — and none of AI Builder's own secrets or Next.js internals, which
 * would leak into the app, or break its own Next.js.
 */
const INHERITED_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TMPDIR",
];

export const childEnv = (): Record<string, string> => ({
  ...Object.fromEntries(
    INHERITED_ENV.flatMap((name) => {
      const value = process.env[name];
      return value ? [[name, value]] : [];
    }),
  ),
  TERM: "xterm-256color",
});

export type RunResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  command: string;
};

/** Run a shell command to completion in a directory. */
export const run = (command: string, cwd: string, timeoutMs = 300_000) =>
  new Promise<RunResult>((resolve) => {
    execFile(
      "/bin/bash",
      ["-c", command],
      {
        cwd,
        // Deliberately without NODE_ENV, which Next's types insist on.
        env: childEnv() as NodeJS.ProcessEnv,
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          stdout,
          stderr: stderr || (error && !stdout ? error.message : ""),
          exitCode: error
            ? typeof error.code === "number"
              ? error.code
              : null
            : 0,
          command,
        });
      },
    );
  });

/** Run a step that has to succeed, failing with the tail of its output. */
export const runStep = async (
  step: string,
  command: string,
  cwd: string,
  timeoutMs?: number,
) => {
  const result = await run(command, cwd, timeoutMs);
  if (!result.ok) {
    const detail = `${result.stdout}\n${result.stderr}`.trim().slice(-500);
    throw new Error(`${step} failed${detail ? `: ${detail}` : "."}`);
  }
  return result;
};

/**
 * Fill a new project's folder: the template as a fresh repo, or a public git
 * project with its history kept, then its dependencies.
 */
export const createProjectFiles = async (
  projectId: string,
  repoUrl?: string,
) => {
  const { root, app } = projectPaths(projectId);
  await mkdir(root, { recursive: true });

  await runStep(
    "Clone",
    `git clone --quiet --depth 1 ${shellQuote(repoUrl ?? TEMPLATE_REPO)} app`,
    root,
  );

  if (!repoUrl) {
    await runStep(
      "Repository setup",
      `rm -rf .git && git init --quiet && git add -A && git ${GIT_IDENTITY} commit --quiet -m 'Initial commit'`,
      app,
    );
  }

  await runStep(
    "Dependency install",
    "npm install --no-audit --no-fund",
    app,
    600_000,
  );
};
