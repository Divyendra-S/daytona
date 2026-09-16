import { isProjectId } from "./project-paths";
import { readProjectMetadata } from "./project-storage";
import type { ProjectMetadata } from "./project-types";

/**
 * Local mode has one user — the API only answers this machine (see proxy.ts)
 * — so a project may be acted on when it exists. The id is checked first,
 * since it becomes both a path here and a folder name in the sandbox. Returns
 * the metadata so callers do not read it twice.
 */
export const authorizeProject = async (
  projectId: string,
): Promise<ProjectMetadata | null> => {
  if (!isProjectId(projectId)) return null;
  return readProjectMetadata(projectId).catch(() => null);
};
