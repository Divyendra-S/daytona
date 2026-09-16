import path from "node:path";
import { safeSegments } from "./project-paths";
import { run, runStep, shellQuote } from "./project-runtime";
import { openProject } from "./sandbox";
import type { ProjectFileNode } from "./project-types";

export type { ProjectFileNode };

/** Directories skipped when building the code preview tree. */
const SKIP_DIRS = [
  "node_modules",
  ".next",
  ".git",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".cache",
  "out",
];

const MAX_FILE_BYTES = 1_000_000;
const MAX_TREE_ENTRIES = 2_000;
const MAX_TREE_DEPTH = 8;

/**
 * Resolve an app-relative path to an absolute one inside the project's
 * sandbox, rejecting anything that would escape the app folder.
 *
 * The guard still matters: the path is about to be handed to the sandbox's
 * file API, which is as happy to read `/etc/shadow` as a project file.
 */
export const resolveInApp = async (
  projectId: string,
  rawPath: string,
): Promise<string | null> => {
  const segments = safeSegments(rawPath);
  if (!segments) return null;
  const { app } = await openProject(projectId);
  return segments.length ? `${app}/${segments.join("/")}` : app;
};

const compareNodes = (a: ProjectFileNode, b: ProjectFileNode) => {
  if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
};

/**
 * Build the nested tree the code preview renders from a flat list of paths.
 * Directories are created on the way down, so a file always has its parents
 * even if `find` listed it first.
 */
const toTree = (entries: { type: string; path: string }[]) => {
  const roots: ProjectFileNode[] = [];
  const directories = new Map<string, ProjectFileNode[]>([["", roots]]);

  const childrenOf = (dirPath: string): ProjectFileNode[] => {
    const existing = directories.get(dirPath);
    if (existing) return existing;

    const slash = dirPath.lastIndexOf("/");
    const parent = slash === -1 ? "" : dirPath.slice(0, slash);
    const node: ProjectFileNode = {
      name: dirPath.slice(slash + 1),
      path: dirPath,
      type: "directory",
      children: [],
    };
    childrenOf(parent).push(node);
    directories.set(dirPath, node.children!);
    return node.children!;
  };

  for (const entry of entries) {
    if (entry.type === "d") {
      childrenOf(entry.path);
      continue;
    }
    const slash = entry.path.lastIndexOf("/");
    childrenOf(slash === -1 ? "" : entry.path.slice(0, slash)).push({
      name: entry.path.slice(slash + 1),
      path: entry.path,
      type: "file",
    });
  }

  const sort = (nodes: ProjectFileNode[]): ProjectFileNode[] => {
    for (const node of nodes) if (node.children) sort(node.children);
    return nodes.sort(compareNodes);
  };
  return sort(roots);
};

/**
 * The project's files, as a nested tree for the code preview.
 *
 * One `find` rather than a walk over the sandbox's file API: a recursive
 * listing would be a round trip per directory, and this is a remote machine.
 * `-printf '%y\t%P'` gives the type and the path relative to the app folder,
 * which is exactly the shape the tree needs.
 */
export const listProjectTree = async (
  projectId: string,
): Promise<ProjectFileNode[]> => {
  const prune = SKIP_DIRS.map((dir) => `-name ${dir}`).join(" -o ");
  const result = await run(
    projectId,
    `find . -maxdepth ${MAX_TREE_DEPTH} \\( -type d \\( ${prune} \\) \\) -prune -o -printf '%y\\t%P\\n' | head -n ${MAX_TREE_ENTRIES + 1}`,
    undefined,
    60,
  );
  if (!result.ok) return [];

  const entries = result.stdout
    .split("\n")
    .flatMap((line) => {
      const tab = line.indexOf("\t");
      if (tab === -1) return [];
      const type = line.slice(0, tab);
      const filePath = line.slice(tab + 1);
      // The starting point itself prints an empty path; symlinks are not walked.
      if (!filePath || (type !== "f" && type !== "d")) return [];
      return [{ type, path: filePath }];
    })
    .slice(0, MAX_TREE_ENTRIES);

  return toTree(entries);
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

/** Read a text file from the project for the code preview. */
export const readProjectFile = async (
  projectId: string,
  filePath: string,
): Promise<ProjectFileContent> => {
  const segments = safeSegments(filePath);
  const target = await resolveInApp(projectId, filePath);
  if (!segments || !segments.length || !target) {
    return { ok: false, error: "Invalid file path." };
  }

  const { sandbox } = await openProject(projectId);

  const info = await sandbox.fs.getFileDetails(target).catch(() => null);
  if (!info || info.isDir) return { ok: false, error: "File not found." };
  if (info.size > MAX_FILE_BYTES) {
    return { ok: false, error: "File is too large to preview." };
  }

  const buffer = await readSandboxFile(projectId, target);
  if (!buffer) return { ok: false, error: "File not found." };
  if (looksBinary(buffer)) {
    return {
      ok: false,
      error: "Binary file cannot be previewed.",
      binary: true,
    };
  }

  return {
    ok: true,
    path: segments.join("/"),
    content: buffer.toString("utf8"),
    language: languageFromPath(filePath),
  };
};

/**
 * Write a file into the project, creating its parent directories. Used by the
 * design routes, which put captured assets and reference files in the project
 * without going through the agent's tools.
 */
export const writeProjectFile = async (
  projectId: string,
  filePath: string,
  content: Buffer | string,
) => {
  const target = await resolveInApp(projectId, filePath);
  if (!target) throw new Error("Invalid file path.");

  await writeSandboxFile(projectId, target, content);
  return target;
};

/**
 * Write a file at an absolute path in the sandbox, parent directories and all.
 *
 * Through the shell rather than the SDK's `uploadFile`, which sends multipart
 * and reaches for `form-data` with a dynamic require: a bundler cannot trace
 * that, and a Worker has no `node_modules` to fall back on, so bundled it fails
 * every write. Base64 down a pipe needs nothing but the shell.
 *
 * ponytail: the content travels inside a command line, which suits the files an
 * agent writes; chunk it if this ever has to carry megabytes.
 */
export const readSandboxFile = async (projectId: string, target: string) => {
  // Base64 out through the shell, for the same reason writes go in that way:
  // the SDK's download is multipart, and its parser is reached for with a
  // dynamic require that does not survive bundling.
  const result = await run(
    projectId,
    `base64 -w0 ${shellQuote(target)} 2>/dev/null || base64 ${shellQuote(target)}`,
    undefined,
    120,
  );
  if (!result.ok) return null;
  return Buffer.from(result.stdout.replace(/\s/g, ""), "base64");
};

export const writeSandboxFile = async (
  projectId: string,
  target: string,
  content: Buffer | string,
) => {
  const encoded = (
    typeof content === "string" ? Buffer.from(content, "utf8") : content
  ).toString("base64");
  const directory = target.slice(0, target.lastIndexOf("/"));

  await runStep(
    "Write",
    projectId,
    `mkdir -p ${shellQuote(directory)} && printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(target)}`,
    undefined,
    120,
  );
};
