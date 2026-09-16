import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { projectPaths } from "./local-project";
import type { ProjectFileNode } from "./project-types";

export type { ProjectFileNode };

/** Directories skipped when building the code preview tree. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".cache",
  "out",
]);

const MAX_FILE_BYTES = 1_000_000;
const MAX_TREE_ENTRIES = 2_000;

/**
 * Resolve an app-relative path to an absolute one, rejecting anything that
 * would escape the app folder.
 */
export const resolveInApp = (
  projectId: string,
  rawPath: string,
): string | null => {
  const { app } = projectPaths(projectId);
  const value = rawPath.trim();
  if (!value || value.includes("\0")) return null;
  if (value.startsWith("/")) return null;

  const segments = value
    .replace(/^\.\//, "")
    .split("/")
    .filter((segment) => segment && segment !== ".");
  if (segments.some((segment) => segment === "..")) return null;

  return path.join(app, ...segments);
};

const compareNodes = (a: ProjectFileNode, b: ProjectFileNode) => {
  if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
};

/** Walk the project app folder into a nested tree for the code preview. */
export const listProjectTree = async (
  projectId: string,
): Promise<ProjectFileNode[]> => {
  const { app } = projectPaths(projectId);
  let remaining = MAX_TREE_ENTRIES;

  const walk = async (
    dir: string,
    relative: string,
  ): Promise<ProjectFileNode[]> => {
    if (remaining <= 0) return [];

    const entries = await readdir(dir, { withFileTypes: true });
    const nodes: ProjectFileNode[] = [];

    for (const entry of entries) {
      if (remaining <= 0) break;
      if (entry.name === "." || entry.name === "..") continue;
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;

      remaining -= 1;
      const childRelative = relative
        ? `${relative}/${entry.name}`
        : entry.name;
      const absolute = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        nodes.push({
          name: entry.name,
          path: childRelative,
          type: "directory",
          children: await walk(absolute, childRelative),
        });
        continue;
      }

      if (entry.isFile()) {
        nodes.push({
          name: entry.name,
          path: childRelative,
          type: "file",
        });
      }
    }

    return nodes.sort(compareNodes);
  };

  return walk(app, "");
};

export type ProjectFileContent =
  | { ok: true; path: string; content: string; language: string }
  | { ok: false; error: string; binary?: boolean };

const languageFromPath = (filePath: string): string => {
  const base = path.basename(filePath).toLowerCase();
  const ext = path.extname(base).slice(1);

  if (
    base === "dockerfile" ||
    base === "makefile" ||
    base === ".gitignore" ||
    base === ".env" ||
    base.startsWith(".env.")
  ) {
    return "plaintext";
  }

  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    mjs: "javascript",
    cjs: "javascript",
    json: "json",
    css: "css",
    scss: "css",
    html: "html",
    md: "markdown",
    mdx: "markdown",
    yml: "yaml",
    yaml: "yaml",
    toml: "toml",
    sh: "shell",
    bash: "shell",
    svg: "xml",
    xml: "xml",
    py: "python",
    rs: "rust",
    go: "go",
    sql: "sql",
  };

  return map[ext] ?? "plaintext";
};

const looksBinary = (buffer: Buffer): boolean => {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8_000));
  if (sample.includes(0)) return true;
  let suspicious = 0;
  for (const byte of sample) {
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return suspicious / sample.length > 0.1;
};

/** Read a text file from the project app folder for the code preview. */
export const readProjectFile = async (
  projectId: string,
  filePath: string,
): Promise<ProjectFileContent> => {
  const target = resolveInApp(projectId, filePath);
  if (!target) return { ok: false, error: "Invalid file path." };

  const { app } = projectPaths(projectId);
  const relative = path.relative(app, target);
  if (!relative || relative.startsWith("..")) {
    return { ok: false, error: "Invalid file path." };
  }

  const info = await stat(target).catch(() => null);
  if (!info || !info.isFile()) return { ok: false, error: "File not found." };
  if (info.size > MAX_FILE_BYTES) {
    return { ok: false, error: "File is too large to preview." };
  }

  const buffer = await readFile(target);
  if (looksBinary(buffer)) {
    return { ok: false, error: "Binary file cannot be previewed.", binary: true };
  }

  return {
    ok: true,
    path: relative.split(path.sep).join("/"),
    content: buffer.toString("utf8"),
    language: languageFromPath(relative),
  };
};
