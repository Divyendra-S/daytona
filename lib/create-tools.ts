import type { FileInfo } from "@daytonaio/sdk";
import { tool } from "ai";
import { z } from "zod";
import { resolveInApp } from "./project-files";
import { run, shellQuote } from "./project-runtime";
import { openProject, previewOrigin } from "./sandbox";
import {
  ensureDevServer,
  readDevServerLogs,
  restartDevServer,
} from "./terminal-bridge";
import { PREVIEW_TOKEN_HEADER, SANDBOX_DEV_PORT } from "./vars";

/** Terminal control sequences, stripped so the model reads log text. */
const ANSI_ESCAPE = /\[[0-?]*[ -/]*[@-~]/g;

/**
 * Tool output is about two fifths of what a long conversation resends on every request, and a
 * command's own output is the bulk of it. Capping it here, where it is produced, keeps it out of
 * the saved conversation and out of every later request — trimming it downstream only helps the
 * requests that have already outgrown the context window.
 *
 * Head and tail are kept because that is where the answer almost always is: what the command
 * started doing and the error it ended on. The marker says how much went missing, so the agent
 * knows to narrow its command instead of assuming it saw everything.
 */
const MAX_TOOL_OUTPUT = 2_000;

/**
 * A larger cap for the two tools whose whole point is to hand over a complete text — a file to
 * edit, a log to debug. Cutting those to 2,000 characters would cost more in re-reads than it
 * saves, and a half-read file is how a search-and-replace edit goes wrong.
 */
const MAX_TEXT_OUTPUT = 20_000;

const capOutput = (text: string, limit = MAX_TOOL_OUTPUT) => {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  return `${text.slice(0, half)}\n… ${text.length - limit} characters trimmed; re-run with a narrower command, path or range to see them …\n${text.slice(-half)}`;
};

/** A command result with both its streams capped; every other field is left alone. */
const capRun = <T extends { stdout: string; stderr: string }>(
  result: T,
): T => ({
  ...result,
  stdout: capOutput(result.stdout),
  stderr: capOutput(result.stderr),
});

export const createTools = (projectId: string) => {
  const sandboxFs = async () => (await openProject(projectId)).sandbox.fs;

  /** A resolved path relative to the app folder, for commands run there. */
  const relativeToApp = async (target: string) => {
    const { app } = await openProject(projectId);
    return target === app ? "." : target.slice(app.length + 1) || ".";
  };

  const runInApp = (command: string, timeoutSeconds = 300) =>
    run(projectId, command, undefined, timeoutSeconds);

  /** The dev server's output, cleaned up for the model. */
  const devServerLogs = async () =>
    (await readDevServerLogs(projectId))
      .replace(ANSI_ESCAPE, "")
      .replace(/\r/g, "");

  const bashTool = tool({
    description:
      "Run a bash command in the project folder and return its output.",
    inputSchema: z.object({
      command: z.string().min(1).describe("The bash command to execute."),
    }),
    execute: async ({ command }) => capRun(await runInApp(command)),
  });

  const readFileTool = tool({
    description:
      "Read the content of a file in the project. Input is the file path relative to the project folder.",
    inputSchema: z.object({
      file: z.string().min(1).describe("The path of the file to read."),
    }),
    execute: async ({ file }) => {
      const target = await resolveInApp(projectId, file);
      if (!target) return { ok: false, error: "Invalid file path." };
      const buffer = await (await sandboxFs())
        .downloadFile(target)
        .catch(() => null);
      if (!buffer) return { ok: false, error: "File not found." };
      return {
        ok: true,
        content: capOutput(buffer.toString("utf8"), MAX_TEXT_OUTPUT),
      };
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
      const target = await resolveInApp(projectId, file);
      if (!target) return { ok: false, error: "Invalid file path." };
      const fs = await sandboxFs();
      await fs
        .createFolder(target.slice(0, target.lastIndexOf("/")), "755")
        .catch(() => {
          // Already there.
        });
      await fs.uploadFile(Buffer.from(content, "utf8"), target);
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
      const target = await resolveInApp(projectId, listPath ?? ".");
      if (!target) return { ok: false, error: "Invalid path." };

      if (!recursive) {
        const entries = await (await sandboxFs())
          .listFiles(target)
          .catch(() => null);
        if (!entries) return { ok: false, error: "Path not found." };
        return {
          ok: true,
          path: listPath,
          entries: entries.map((entry: FileInfo) => ({
            name: entry.name,
            type: entry.isDir ? "directory" : "file",
          })),
        };
      }

      return {
        ...capRun(
          await runInApp(
            `find ${shellQuote(await relativeToApp(target))} -maxdepth ${maxDepth} -not -path '*/node_modules/*' -not -path '*/.next/*' -not -path '*/.git/*'`,
            60,
          ),
        ),
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
      const target = await resolveInApp(projectId, searchPath ?? ".");
      if (!target) return { ok: false, error: "Invalid path." };

      return {
        ...capRun(
          await runInApp(
            `grep -RIn --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.git -- ${shellQuote(query)} ${shellQuote(await relativeToApp(target))} | head -n ${maxResults}`,
            60,
          ),
        ),
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
      const target = await resolveInApp(projectId, file);
      if (!target) return { ok: false, error: "Invalid file path." };

      // Read-modify-write rather than the sandbox's own replace call, which
      // has no first-occurrence-only mode and cannot report a miss.
      const fs = await sandboxFs();
      const buffer = await fs.downloadFile(target).catch(() => null);
      if (!buffer) return { ok: false, error: "File not found." };

      const content = buffer.toString("utf8");
      if (!content.includes(search)) {
        return { ok: false, file, replacements: 0, error: "No matches found." };
      }

      const next = all
        ? content.split(search).join(replace)
        : content.replace(search, replace);
      const replacements = all ? content.split(search).length - 1 : 1;

      await fs.uploadFile(Buffer.from(next, "utf8"), target);
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
      const target = await resolveInApp(projectId, file);
      if (!target) return { ok: false, error: "Invalid file path." };

      const fs = await sandboxFs();
      const existing = await fs
        .downloadFile(target)
        .then((buffer: Buffer) => buffer.toString("utf8"))
        .catch(() => "");
      await fs
        .createFolder(target.slice(0, target.lastIndexOf("/")), "755")
        .catch(() => {
          // Already there.
        });
      await fs.uploadFile(Buffer.from(`${existing}${content}`, "utf8"), target);
      return { ok: true, file, appendedBytes: content.length };
    },
  });

  const makeDirectoryTool = tool({
    description: "Create a directory path using mkdir -p semantics.",
    inputSchema: z.object({
      path: z.string().min(1).describe("Directory path to create."),
    }),
    execute: async ({ path: dirPath }) => {
      const target = await resolveInApp(projectId, dirPath);
      if (!target) return { ok: false, error: "Invalid path." };
      await (await sandboxFs()).createFolder(target, "755").catch(() => {
        // Already there.
      });
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
      const source = await resolveInApp(projectId, from);
      const destination = await resolveInApp(projectId, to);
      if (!source || !destination) {
        return { ok: false, error: "Invalid source or destination path." };
      }
      const fs = await sandboxFs();
      await fs
        .createFolder(destination.slice(0, destination.lastIndexOf("/")), "755")
        .catch(() => {
          // Already there.
        });
      await fs.moveFiles(source, destination);
      return { ok: true, from, to };
    },
  });

  const deletePathTool = tool({
    description: "Delete a file or directory path.",
    inputSchema: z.object({
      path: z.string().min(1).describe("File or directory path to delete."),
    }),
    execute: async ({ path: deletePath }) => {
      const target = await resolveInApp(projectId, deletePath);
      const { app } = await openProject(projectId);
      if (!target || target === app) {
        return { ok: false, error: "Invalid path." };
      }
      await (await sandboxFs()).deleteFile(target, true).catch(() => {
        // Already gone.
      });
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

      await ensureDevServer(projectId);
      const { url, token } = await previewOrigin(projectId, SANDBOX_DEV_PORT);
      const target = `${url}${urlPath}`;

      // A server that was just started refuses connections for a few seconds.
      let statusCode: number | null = null;
      for (let attempt = 0; attempt < 30 && statusCode === null; attempt += 1) {
        statusCode = await fetch(target, {
          redirect: "manual",
          headers: { [PREVIEW_TOKEN_HEADER]: token },
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
      const issues = (await devServerLogs())
        .split("\n")
        .filter((line) => issueRegex.test(line))
        .slice(-20)
        // A bundler stack trace arrives as one enormous line, and twenty of them would outweigh
        // the rest of the request; each line gets a twentieth of the debug budget.
        .map((line) => capOutput(line, MAX_TEXT_OUTPUT / 20));

      const httpOk =
        statusCode !== null && statusCode >= 200 && statusCode < 400;
      const ok = httpOk && issues.length === 0;

      return {
        ok,
        statusCode,
        // The preview token authenticates the whole sandbox, so the model is
        // shown the path it checked rather than a URL carrying a credential.
        url: urlPath,
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
      await ensureDevServer(projectId);
      const lines = (await devServerLogs()).split("\n");
      return {
        ok: true,
        logs: capOutput(lines.slice(-maxLines).join("\n"), MAX_TEXT_OUTPUT),
        totalLines: lines.length,
      };
    },
  });

  const restartDevServerTool = tool({
    description:
      "Restart the dev server. Only needed after changing config the dev server reads at startup (next.config, env files, or newly installed dependencies) — ordinary file edits hot-reload on their own.",
    inputSchema: z.object({}),
    execute: async () => {
      await restartDevServer(projectId);
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
