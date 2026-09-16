"use client";

import {
  useAui,
  useAuiState,
  type ToolCallMessagePartComponent,
} from "@assistant-ui/react";
import {
  useEffect,
  useRef,
  useState,
  type FC,
  type PropsWithChildren,
} from "react";
import ApprovalCard, {
  type ApprovalQuestion,
} from "@/components/primitives/ApprovalCard";
import LoadingState from "@/components/primitives/LoadingState";
import TaskRows from "@/components/primitives/TaskRows";
import ToolChips, {
  type ToolDetailLine,
  type ToolDiff,
  type ToolDiffLine,
  type ToolStep,
} from "@/components/primitives/ToolChips";

type Obj = Record<string, unknown>;

const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});

const str = (v: unknown): string => (typeof v === "string" ? v : "");

const splitLines = (text: string) =>
  text ? text.replace(/\n$/, "").split("\n") : [];

/** A row's detail: the start of a file or listing, or the end of command output, where the verdict is. */
const excerpt = (
  lines: string[],
  from: "head" | "tail" = "head",
  max = 8,
): ToolDetailLine[] => {
  const kept = lines.filter((line) => line.trim());
  const shown = from === "head" ? kept.slice(0, max) : kept.slice(-max);
  const more = kept.length - shown.length;
  const note =
    more > 0 ? [{ text: `… ${more} more line${more === 1 ? "" : "s"}` }] : [];
  return from === "head"
    ? [...shown.map((text) => ({ text })), ...note]
    : [...note, ...shown.map((text) => ({ text }))];
};

type Described = Omit<ToolStep, "status"> & {
  edit?: { file: string; removed: string; added: string };
};

/** One tool call from lib/create-tools.ts as a row: the verb, the thing it acted on, and its output. */
const describe = (toolName: string, a: Obj, result: unknown): Described => {
  const r = obj(result);
  const base = { mono: true, detailMono: true, detail: [] as ToolDetailLine[] };

  switch (toolName) {
    case "bashTool":
      return {
        ...base,
        icon: "run",
        label: "Run",
        chip: str(a.command),
        detail: excerpt(splitLines(str(r.stdout) || str(r.stderr)), "tail"),
      };
    case "readFileTool":
      return {
        ...base,
        icon: "read",
        label: "Read",
        chip: str(a.file),
        detail: excerpt(splitLines(str(r.content))),
      };
    case "writeFileTool":
    case "appendToFileTool": {
      const content = str(a.content);
      const verb = toolName === "writeFileTool" ? "Write" : "Append";
      const count = splitLines(content).length;
      return {
        ...base,
        icon: "write",
        label: `${verb} ${count} line${count === 1 ? "" : "s"}`,
        chip: str(a.file),
        edit: { file: str(a.file), removed: "", added: content },
      };
    }
    case "replaceInFileTool": {
      const count = typeof r.replacements === "number" ? r.replacements : 0;
      return {
        ...base,
        icon: "write",
        label: "Edit",
        chip: str(a.file),
        detail: count
          ? [{ text: `${count} replacement${count === 1 ? "" : "s"}` }]
          : [],
        edit: {
          file: str(a.file),
          removed: str(a.search),
          added: str(a.replace),
        },
      };
    }
    case "listFilesTool": {
      const names = Array.isArray(r.entries)
        ? r.entries.map((entry) => {
            const e = obj(entry);
            return e.type === "directory" ? `${str(e.name)}/` : str(e.name);
          })
        : splitLines(str(r.stdout));
      return {
        ...base,
        icon: "folder",
        label: "List",
        chip: str(a.path) || ".",
        detail: excerpt(names),
      };
    }
    case "searchFilesTool":
      return {
        ...base,
        icon: "search",
        label: "Search",
        chip: str(a.query),
        mono: false,
        detail: excerpt(splitLines(str(r.stdout))),
      };
    case "makeDirectoryTool":
      return {
        ...base,
        icon: "folder",
        label: "Create folder",
        chip: str(a.path),
      };
    case "movePathTool":
      return {
        ...base,
        icon: "move",
        label: "Move",
        chip: `${str(a.from)} → ${str(a.to)}`,
      };
    case "deletePathTool":
      return { ...base, icon: "delete", label: "Delete", chip: str(a.path) };
    case "checkAppTool": {
      const statusCode =
        typeof r.statusCode === "number" ? `${r.statusCode} ` : "";
      const issues = Array.isArray(r.issues) ? r.issues.map(str) : [];
      return {
        ...base,
        icon: "check",
        label: "Check app",
        chip: `${statusCode}${str(a.path) || "/"}`,
        detail:
          r.ok === true
            ? [{ text: "No errors in the dev server logs" }]
            : excerpt(issues, "tail").map((line) => ({
                ...line,
                tone: "del" as const,
              })),
      };
    }
    case "devServerLogsTool":
      return {
        ...base,
        icon: "read",
        label: "Read dev logs",
        chip: `last ${typeof a.maxLines === "number" ? a.maxLines : 200} lines`,
        mono: false,
        detail: excerpt(splitLines(str(r.logs)), "tail"),
      };
    case "restartDevServerTool":
      return {
        ...base,
        icon: "run",
        label: "Restart",
        chip: "dev server",
        mono: false,
      };
    // No longer in lib/create-tools.ts; saved conversations can still contain it.
    case "commitTool": {
      const output = [str(r.stdout), str(r.stderr)].filter(Boolean).join("\n");
      const hash = /\[[^\]]*?\b([0-9a-f]{7,40})\]/.exec(output)?.[1];
      return {
        ...base,
        icon: "commit",
        label: hash ? `Commit ${hash.slice(0, 7)}` : "Commit",
        chip: str(a.message),
        mono: false,
        detail: excerpt(splitLines(output), "tail"),
      };
    }
    default:
      return {
        ...base,
        icon: "tool",
        label: toolName,
        chip: JSON.stringify(a),
        detail:
          result === undefined
            ? []
            : excerpt(
                splitLines(
                  typeof result === "string"
                    ? result
                    : JSON.stringify(result, null, 2),
                ),
              ),
      };
  }
};

/** Tools with a UI of their own, rendered where they were called rather than as a run row. */
const OWN_UI = new Set(["askUserTool"]);

/** Bookkeeping tools: part of a run, but no row — their result shows elsewhere. */
const QUIET = new Set(["updatePlanTool", "suggestFollowUpsTool"]);

type TurnPart = { type: string; toolName?: string; text?: string };

/**
 * An agent turn as runs of work between its answers. Every step is usually a thought followed by
 * a tool call, so grouping only back-to-back tool calls gave each step its own "Thought" block
 * and its own "1 tool call" block. Here everything from one piece of prose to the next —
 * reasoning, tool calls, and the blank text parts some models emit between them — is one run.
 * The first plan and every question keep their own place in the turn.
 */
export const groupTurn = (parts: readonly TurnPart[]) => {
  const groups: { groupKey: string | undefined; indices: number[] }[] = [];
  let run: number[] | null = null;
  let planShown = false;
  for (const [index, part] of parts.entries()) {
    const firstPlan = part.toolName === "updatePlanTool" && !planShown;
    if (firstPlan) planShown = true;
    const ownUi =
      part.type === "tool-call" &&
      (OWN_UI.has(part.toolName ?? "") || firstPlan);
    const work =
      !ownUi && (part.type === "reasoning" || part.type === "tool-call");
    if (work || (run && part.type === "text" && !part.text?.trim())) {
      if (!run) {
        run = [];
        groups.push({ groupKey: "run", indices: run });
      }
      run.push(index);
      continue;
    }
    run = null;
    groups.push({ groupKey: undefined, indices: [index] });
  }
  return groups;
};

/** Parts as grouped by `groupTurn`: a run as one block, anything else as itself. */
export const TurnGroup: FC<
  PropsWithChildren<{ groupKey: string | undefined; indices: number[] }>
> = ({ groupKey, indices, children }) =>
  groupKey === "run" ? <AgentRun indices={indices} /> : children;

const formatDuration = (ms: number) => {
  const seconds = Math.max(1, Math.round(ms / 1000));
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
};

/**
 * How long a run worked, measured while it is on screen. A run resumed after a question adds its
 * second stretch to the first; runs loaded from history were never watched, so they have no time.
 */
const useWorkedFor = (working: boolean) => {
  const startedAt = useRef<number | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  useEffect(() => {
    if (working) {
      startedAt.current ??= Date.now();
      return;
    }
    if (startedAt.current === null) return;
    const stretch = Date.now() - startedAt.current;
    startedAt.current = null;
    setElapsed((previous) => (previous ?? 0) + stretch);
  }, [working]);
  return elapsed;
};

/**
 * A run of agent work as one ToolChips block: a header that sums it up, and the steps in order —
 * tool calls as rows, the model's thoughts as dimmed lines between them. It reads the parts itself
 * instead of rendering `children`, because ToolChips takes the whole run as data. The run works
 * while the message runs and nothing follows it; a call without a result then is running, and was
 * cut off (Stop, an error) once the message is not.
 */
const AgentRun: FC<{ indices: number[] }> = ({ indices }) => {
  const parts = useAuiState(({ message }) => message.parts);
  const messageRunning = useAuiState(
    ({ message }) => message.status?.type === "running",
  );
  const lastIndex = indices.at(-1) ?? 0;
  const working = messageRunning && lastIndex >= parts.length - 1;
  const workedFor = useWorkedFor(working);

  const steps: ToolStep[] = [];
  const diffs = new Map<string, ToolDiff>();
  const diffLines: Record<string, ToolDiffLine[]> = {};

  for (const index of indices) {
    const part = parts[index];
    if (!part) continue;

    if (part.type === "reasoning") {
      // Bold markers are dropped: the rows are plain text. Empty or one-word reasoning adds nothing.
      const paragraphs = part.text
        .split(/\n{2,}/)
        .map((paragraph) => paragraph.replace(/\*\*/g, "").trim())
        .filter(Boolean);
      if (paragraphs.join(" ").length < 12) continue;
      steps.push({
        icon: "think",
        label: paragraphs[0],
        chip: "",
        mono: false,
        detailMono: false,
        thought: true,
        detail:
          paragraphs.length > 1 || paragraphs[0].length > 80
            ? paragraphs.map((text) => ({ text }))
            : [],
        status: working && index === parts.length - 1 ? "running" : undefined,
      });
      continue;
    }

    if (part.type !== "tool-call" || QUIET.has(part.toolName)) continue;
    const running = part.result === undefined && messageRunning;
    const failed =
      !running &&
      (part.isError === true ||
        part.result === undefined ||
        obj(part.result).ok === false);
    const { edit, ...step } = describe(
      part.toolName,
      obj(part.args),
      part.result,
    );
    steps.push({
      ...step,
      status: running ? "running" : failed ? "failed" : undefined,
    });

    if (!edit?.file || failed) continue;
    const removed = splitLines(edit.removed);
    const added = splitLines(edit.added);
    const diff = diffs.get(edit.file) ?? { file: edit.file, add: 0, del: 0 };
    diffs.set(edit.file, {
      file: edit.file,
      add: diff.add + added.length,
      del: diff.del + removed.length,
    });
    // The hover preview shows the first dozen changed lines of each file.
    diffLines[edit.file] = [
      ...(diffLines[edit.file] ?? []),
      ...removed.map((text) => ({ text, tone: "del" as const })),
      ...added.map((text) => ({ text, tone: "add" as const })),
    ].slice(0, 12);
  }

  if (!steps.length) return null;

  const calls = steps.filter((step) => !step.thought).length;
  const failed = steps.filter((step) => step.status === "failed").length;
  const current = steps.at(-1);

  return (
    <div className="my-2">
      <ToolChips
        steps={steps}
        diffs={[...diffs.values()]}
        diffLines={diffLines}
        working={working}
        labels={{
          header: working
            ? "Working…"
            : [
                workedFor !== null && `Worked for ${formatDuration(workedFor)}`,
                calls > 0 && `${calls} tool call${calls === 1 ? "" : "s"}`,
                failed > 0 && `${failed} failed`,
              ]
                .filter(Boolean)
                .join(" · ") || "Thought",
          current: current?.thought
            ? current.label
            : current && `${current.label} ${current.chip}`.trim(),
        }}
      />
    </div>
  );
};

type AskUserResult = { answers: { question: string; answer: string[] }[] };

/**
 * askUserTool's questions as Beautiful UI's Approval Card. The tool has no server side: the
 * answers go back as its result, which continues the run (`sendAutomaticallyWhen` in
 * app/assistant.tsx). Answered questions stay in the turn as a short record; a question left
 * unanswered when the user sent something else was cancelled.
 */
export const AskUserToolUI: ToolCallMessagePartComponent<
  { questions?: ApprovalQuestion[] },
  AskUserResult
> = ({ args, result, isError, status, addResult }) => {
  if (result?.answers) return <AnsweredQuestions answers={result.answers} />;
  if (status.type === "running")
    return (
      <div className="my-2">
        <LoadingState label="Writing questions" />
      </div>
    );
  const questions = (args.questions ?? []).filter(
    (question) => question?.q && question.options?.length > 0,
  );
  if (isError || !questions.length)
    return (
      <p className="my-2 text-[12.5px] text-ink-3">Questions not answered</p>
    );
  return (
    <div className="my-2">
      <ApprovalCard
        questions={questions}
        onSubmitted={(picked, typed) =>
          addResult({
            answers: questions.map((question, index) => ({
              question: question.q,
              answer: [
                ...(picked[index] ?? []).map(
                  (option) => question.options[option],
                ),
                ...(typed[index]?.trim() ? [typed[index].trim()] : []),
              ],
            })),
          })
        }
      />
    </div>
  );
};

const AnsweredQuestions: FC<AskUserResult> = ({ answers }) => (
  <div className="my-2 flex w-full max-w-80 flex-col gap-2 rounded-card bg-surface p-3 shadow-card">
    <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-green-tint py-0.5 pr-2 pl-1 text-[12px] font-medium text-green">
      <span className="flex size-4 items-center justify-center rounded-full bg-green text-white">
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M20 6L9 17l-5-5" />
        </svg>
      </span>
      Answers sent
    </span>
    {answers.map(({ question, answer }, index) => (
      <div key={index} className="text-[12.5px] leading-snug">
        <p className="text-ink-2">{question}</p>
        <p className="font-medium text-ink">
          {answer.length ? answer.join(", ") : "Skipped"}
        </p>
      </div>
    ))}
  </div>
);

type PlanTask = { title?: string; status?: string };

const lastCallArgs = (
  parts: readonly { type: string; toolName?: string; args?: unknown }[],
  toolName: string,
) =>
  parts.findLast(
    (part) => part.type === "tool-call" && part.toolName === toolName,
  )?.args as Record<string, unknown> | undefined;

/**
 * The agent's plan as Beautiful UI's Task Rows, shown where it was first made and always at its
 * latest version: later updatePlanTool calls only change it (they add no run rows). A task still
 * in progress when the message stopped is shown as not started rather than spinning forever.
 */
export const PlanToolUI: ToolCallMessagePartComponent = () => {
  const parts = useAuiState(({ message }) => message.parts);
  const messageRunning = useAuiState(
    ({ message }) => message.status?.type === "running",
  );
  const tasks = (
    (lastCallArgs(parts, "updatePlanTool")?.tasks as PlanTask[] | undefined) ??
    []
  ).filter((task) => task?.title);
  if (!tasks.length) return null;
  const done = tasks.filter((task) => task.status === "done").length;
  return (
    <div className="my-2 flex flex-col gap-1.5">
      <span className="text-[12.5px] text-ink-2 tabular-nums">
        Plan · {done}/{tasks.length} done
      </span>
      <TaskRows
        rows={tasks.map((task, index) => ({
          key: String(index),
          label: task.title ?? "",
          step: index + 1,
          status:
            task.status === "done"
              ? "done"
              : task.status === "in_progress" && messageRunning
                ? "running"
                : "pending",
        }))}
      />
    </div>
  );
};

/**
 * suggestFollowUpsTool's prompts under the finished answer, in Beautiful UI Streaming Text's
 * follow-ups style; picking one sends it. Only on the latest message, where they are still next.
 */
export const FollowUps: FC = () => {
  const aui = useAui();
  const parts = useAuiState(({ message }) => message.parts);
  const show = useAuiState(
    ({ message, thread }) =>
      message.status?.type !== "running" &&
      message.status?.type !== "incomplete" &&
      thread.messages.at(-1)?.id === message.id,
  );
  if (!show) return null;
  const prompts = (
    (lastCallArgs(parts, "suggestFollowUpsTool")?.prompts as unknown[]) ?? []
  )
    .filter(
      (prompt): prompt is string =>
        typeof prompt === "string" && !!prompt.trim(),
    )
    .slice(0, 3);
  if (!prompts.length) return null;

  return (
    <div className="mt-2.5">
      <p className="text-[12px] font-medium text-ink-2">Follow-ups</p>
      <div className="mt-0.5 flex flex-col">
        {prompts.map((text, index) => (
          <button
            key={index}
            type="button"
            onClick={() => aui.thread().append(text)}
            className="-mx-1.5 flex items-center gap-2 rounded-[7px] border-b border-line px-1.5 py-1.5 text-left text-[12.5px] text-ink transition-colors duration-100 hover:bg-hover-2"
            style={{
              animation: `fade-up 350ms cubic-bezier(0.23,1,0.32,1) ${index * 90}ms both`,
            }}
          >
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--ink-3)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="shrink-0"
            >
              <path d="M9 10l-5 5 5 5" />
              <path d="M20 4v7a4 4 0 0 1-4 4H4" />
            </svg>
            {text}
          </button>
        ))}
      </div>
    </div>
  );
};
