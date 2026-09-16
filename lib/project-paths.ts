import path from "node:path";
import { PROJECTS_DIR } from "./vars";

/** Project ids become folder names, so anything else is rejected before it reaches a path. */
const PROJECT_ID = /^[0-9a-f]{8}$/;

export const isProjectId = (value: string) => PROJECT_ID.test(value);

/**
 * A project's folder on this machine. It holds the project's JSON state and
 * nothing else: the code, its git history and everything that runs live in the
 * project's sandbox (see `lib/sandbox.ts`).
 */
export const projectPaths = (projectId: string) => {
  if (!isProjectId(projectId)) throw new Error("Invalid project id.");
  return { root: path.join(PROJECTS_DIR, projectId) };
};

/**
 * Validate a project-relative path and split it into segments, rejecting
 * anything that would escape the project folder. Pure, so it can guard a path
 * before there is a sandbox to resolve it against.
 */
export const safeSegments = (rawPath: string): string[] | null => {
  const value = rawPath.trim();
  if (!value || value.includes("\0") || value.startsWith("/")) return null;

  const segments = value
    .replace(/^\.\//, "")
    .split("/")
    .filter((segment) => segment && segment !== ".");
  if (segments.some((segment) => segment === "..")) return null;
  return segments;
};
