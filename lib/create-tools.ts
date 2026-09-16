import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { projectPaths, run, shellQuote } from "./local-project";
import {
  ensureDevServer,
  readTerminalOutput,
  restartDevServer,
} from "./terminal-bridge";
import { APP_SESSION, LOCAL_HOST } from "./vars";

/** Terminal control sequences, stripped so the model reads log text. */
const ANSI_ESCAPE = /\[[0-?]*[ -/]*[@-~]/g;

export const createTools = (projectId: string, devPort: number) => {
  const { app } = projectPaths(projectId);

  /**
   * Resolve an app-relative path to an absolute one, rejecting anything that
   * would escape the app folder.
   */
  const resolveInApp = (rawPath: string): string | null => {
    const value = rawPath.trim();
    if (!value || value.includes("\0") || value.startsWith("/")) return null;

    const segments = value
      .replace(/^\.\//, "")
      .split("/")
      .filter((s) => s && s !== ".");
    if (segments.some((segment) => segment === "..")) return null;

    return path.join(app, ...segments);
  };

  /** A resolved path relative to the app folder, for commands run there. */
  const relativeToApp = (target: string) => path.relative(app, target) || ".";

  const runInApp = (command: string) => run(command, app);

  /** The dev server's output, kept by its terminal session. */
  const readDevServerLogs = () =>
    readTerminalOutput(projectId, APP_SESSION)
      .replace(ANSI_ESCAPE, "")
      .replace(/\r/g, "");

  const bashTool = tool({
    description:
      "Run a bash command in the project folder and return its output.",
    inputSchema: z.object({
      command: z.string().min(1).describe("The bash command to execute."),
    }),
    execute: ({ command }) => runInApp(command),
  });

  const readFileTool = tool({
    description:
      "Read the content of a file in the project. Input is the file path relative to the project folder.",
    inputSchema: z.object({
      file: z.string().min(1).describe("The path of the file to read."),
    }),
    execute: async ({ file }) => {
      const target = resolveInApp(file);
      if (!target) return { ok: false, error: "Invalid file path." };
      return { ok: true, content: await readFile(target, "utf8") };
    },
  });

  const writeFileTool = tool({
    description:
      "Write content to a file in the project. Creates the file if it does not exist. Input is the file path relative to the project folder and the content to write.",
    inputSchema: z.object({
      file: z.string().min(1).describe("The path of the file to write."),
      content: z.string().describe("The content to write to the file."),
    }),
    execute: async ({ file, content }) => {
      const target = resolveInApp(file);
      if (!target) return { ok: false, error: "Invalid file path." };
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
      return { ok: true, file };
    },
  });

  const listFilesTool = tool({
    description:
      "List files or directories from a given path. Prefer this over bash for discovery.",
    inputSchema: z.object({
      path: z.string().default(".").describe("Path to list."),
      recursive: z
        .boolean()
        .default(false)
        .describe("Whether to list recursively."),
      maxDepth: z
        .number()
        .int()
        .min(1)
        .max(8)
        .default(3)
        .describe("Maximum recursion depth when recursive is true."),
    }),
    execute: async ({ path: listPath, recursive, maxDepth }) => {
      const target = resolveInApp(listPath ?? ".");
      if (!target) return { ok: false, error: "Invalid path." };

      if (!recursive) {
        const entries = await readdir(target, { withFileTypes: true });
        return {
          ok: true,
          path: listPath,
          entries: entries.map((entry) => ({
            name: entry.name,
            type: entry.isDirectory() ? "directory" : "file",
          })),
        };
      }

      return {
        ...(await runInApp(
          `find ${shellQuote(relativeToApp(target))} -maxdepth ${maxDepth} -not -path '*/node_modules/*' -not -path '*/.next/*' -not -path '*/.git/*'`,
        )),
        path: listPath,
        recursive,
        maxDepth,
      };
    },
  });

  const searchFilesTool = tool({
    description:
      "Search for text within files. Prefer this over bash grep for code/text lookup.",
    inputSchema: z.object({
      query: z.string().min(1).describe("Text to search for."),
      path: z.string().default(".").describe("Path to search under."),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(100)
        .describe("Maximum number of matching lines to return."),
    }),
    execute: async ({ query, path: searchPath, maxResults }) => {
      const target = resolveInApp(searchPath ?? ".");
      if (!target) return { ok: false, error: "Invalid path." };

      return {
        ...(await runInApp(
          `grep -RIn --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.git -- ${shellQuote(query)} ${shellQuote(relativeToApp(target))} | head -n ${maxResults}`,
        )),
        query,
        path: searchPath,
      };
    },
  });

  const replaceInFileTool = tool({
    description:
      "Replace text in a file without using bash. Supports replacing first or all occurrences.",
    inputSchema: z.object({
      file: z.string().min(1).describe("Path of the file to edit."),
      search: z.string().min(1).describe("Text to find."),
      replace: z.string().describe("Replacement text."),
      all: z
        .boolean()
        .default(true)
        .describe("Replace all matches when true, otherwise first match."),
    }),
    execute: async ({ file, search, replace, all }) => {
      const target = resolveInApp(file);
      if (!target) return { ok: false, error: "Invalid file path." };

      const content = await readFile(target, "utf8");
      if (!content.includes(search)) {
        return { ok: false, file, replacements: 0, error: "No matches found." };
      }

      const next = all
        ? content.split(search).join(replace)
        : content.replace(search, replace);
      const replacements = all ? content.split(search).length - 1 : 1;

      await writeFile(target, next);
      return { ok: true, file, replacements };
    },
  });

  const appendToFileTool = tool({
    description:
      "Append text content to an existing file (or create it) without bash.",
    inputSchema: z.object({
      file: z.string().min(1).describe("Path of the file to append to."),
      content: z.string().describe("Text content to append."),
    }),
    execute: async ({ file, content }) => {
      const target = resolveInApp(file);
      if (!target) return { ok: false, error: "Invalid file path." };

      const existing = await readFile(target, "utf8").catch(() => "");
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, `${existing}${content}`);
      return { ok: true, file, appendedBytes: content.length };
    },
  });

  const makeDirectoryTool = tool({
    description: "Create a directory path using mkdir -p semantics.",
    inputSchema: z.object({
      path: z.string().min(1).describe("Directory path to create."),
    }),
    execute: async ({ path: dirPath }) => {
      const target = resolveInApp(dirPath);
      if (!target) return { ok: false, error: "Invalid path." };
      await mkdir(target, { recursive: true });
      return { ok: true, path: dirPath };
    },
  });

  const movePathTool = tool({
    description: "Move or rename a file or directory.",
    inputSchema: z.object({
      from: z.string().min(1).describe("Source path."),
      to: z.string().min(1).describe("Destination path."),
    }),
    execute: async ({ from, to }) => {
      const source = resolveInApp(from);
      const destination = resolveInApp(to);
      if (!source || !destination) {
        return { ok: false, error: "Invalid source or destination path." };
      }
      await mkdir(path.dirname(destination), { recursive: true });
      await rename(source, destination);
      return { ok: true, from, to };
    },
  });

  const deletePathTool = tool({
    description: "Delete a file or directory path.",
    inputSchema: z.object({
      path: z.string().min(1).describe("File or directory path to delete."),
    }),
    execute: async ({ path: deletePath }) => {
      const target = resolveInApp(deletePath);
      if (!target || target === app) {
        return { ok: false, error: "Invalid path." };
      }
      await rm(target, { recursive: true, force: true });
      return { ok: true, path: deletePath };
    },
  });

  const checkAppTool = tool({
    description:
      "Check that the app is running correctly by requesting the dev server and scanning its logs for compile or runtime errors. You MUST call this before telling the user a task is finished. If the status code is not 200 or the logs show errors, fix them before reporting completion.",
    inputSchema: z.object({
      path: z
        .string()
        .default("/")
        .describe("The URL path to check (e.g. '/' or '/about')."),
    }),
    execute: async ({ path: checkPath }) => {
      const urlPath = checkPath?.startsWith("/")
        ? checkPath
        : `/${checkPath ?? ""}`;
      const url = `http://${LOCAL_HOST}:${devPort}${urlPath}`;

      ensureDevServer(projectId, devPort);

      // A server that was just started refuses connections for a few seconds.
      let statusCode: number | null = null;
      for (let attempt = 0; attempt < 30 && statusCode === null; attempt += 1) {
        statusCode = await fetch(url, {
          redirect: "manual",
          signal: AbortSignal.timeout(60_000),
        }).then(
          (response) => response.status,
          () => null,
        );
        if (statusCode === null) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }

      const issueRegex =
        /(error -|failed to compile|module not found|unhandled runtime error|referenceerror|typeerror|syntaxerror|cannot find module)/i;
      const issues = readDevServerLogs()
        .split("\n")
        .filter((line) => issueRegex.test(line))
        .slice(-20);

      const httpOk =
        statusCode !== null && statusCode >= 200 && statusCode < 400;
      const ok = httpOk && issues.length === 0;

      return {
        ok,
        statusCode,
        url,
        issues,
        ...(ok
          ? {}
          : {
              error: httpOk
                ? "App is reachable, but the dev server logs show issues."
                : statusCode === null
                  ? "The dev server is not responding. Check its logs."
                  : `App returned HTTP ${statusCode}. Investigate before reporting completion.`,
            }),
      };
    },
  });

  const devServerLogsTool = tool({
    description:
      "Fetch recent dev server output. Use this to debug build or runtime issues.",
    inputSchema: z.object({
      maxLines: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .default(200)
        .describe("Maximum number of log lines to return."),
    }),
    execute: async ({ maxLines }) => {
      ensureDevServer(projectId, devPort);
      const lines = readDevServerLogs().split("\n");
      return {
        ok: true,
        logs: lines.slice(-maxLines).join("\n"),
        totalLines: lines.length,
      };
    },
  });

  const restartDevServerTool = tool({
    description:
      "Restart the dev server. Only needed after changing config the dev server reads at startup (next.config, env files, or newly installed dependencies) — ordinary file edits hot-reload on their own.",
    inputSchema: z.object({}),
    execute: async () => {
      await restartDevServer(projectId, devPort);
      return { ok: true };
    },
  });

  /**
   * Questions for the user, answered in the chat. No `execute`: the turn pauses on the call, the
   * client sends the answers back as its result, and the run continues from there.
   */
  const askUserTool = tool({
    description:
      "Ask the user one to four multiple-choice questions and wait for the answers. Use it before a big change when the request is ambiguous and the answer changes what you build. Never use it for trivial choices you can make yourself, or for anything you can find out by reading the project. Each answer comes back as the chosen options, the user's own text, or nothing if they skipped.",
    inputSchema: z.object({
      questions: z
        .array(
          z.object({
            q: z.string().min(1).describe("The question, short and specific."),
            type: z
              .enum(["radio", "check"])
              .describe("radio: the user picks one option; check: any number."),
            options: z
              .array(z.string().min(1))
              .min(2)
              .max(6)
              .describe(
                "The choices, a few words each. The user can also type their own answer.",
              ),
          }),
        )
        .min(1)
        .max(4),
    }),
  });

  /** The agent's plan for multi-step work; the chat shows its latest version as a task list. */
  const updatePlanTool = tool({
    description:
      "Show the user your plan for multi-step work as an ordered task list. Call it once you know the tasks, then again whenever a task starts or finishes — always with the whole list.",
    inputSchema: z.object({
      tasks: z
        .array(
          z.object({
            title: z.string().min(1).describe("The task, in a few words."),
            status: z.enum(["pending", "in_progress", "done"]),
          }),
        )
        .min(1)
        .max(12),
    }),
    execute: async () => ({ ok: true }),
  });

  /** Next requests offered under the finished answer; the turn ends with this call. */
  const suggestFollowUpsTool = tool({
    description:
      "Offer the user two or three short follow-up requests they are likely to want next, shown as buttons under your answer. Call it last, after your final summary: the turn ends with it.",
    inputSchema: z.object({
      prompts: z
        .array(z.string().min(1).max(80))
        .min(2)
        .max(3)
        .describe(
          'Requests written as the user would send them, e.g. "Add a dark mode toggle".',
        ),
    }),
    execute: async () => ({ ok: true }),
  });

  return {
    askUserTool,
    updatePlanTool,
    suggestFollowUpsTool,
    bashTool,
    readFileTool,
    writeFileTool,
    listFilesTool,
    searchFilesTool,
    replaceInFileTool,
    appendToFileTool,
    makeDirectoryTool,
    movePathTool,
    deletePathTool,
    checkAppTool,
    devServerLogsTool,
    restartDevServerTool,
  };
};
