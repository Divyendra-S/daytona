/**
 * Project ids reach a database query and a sandbox label, so anything that is
 * not one is turned away before it gets there.
 */
const PROJECT_ID = /^[0-9a-f]{8}$/;

export const isProjectId = (value: string) => PROJECT_ID.test(value);

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
