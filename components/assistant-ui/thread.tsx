import {
  ComposerAddAttachment,
  ComposerAttachments,
  UserMessageAttachments,
} from "@/components/assistant-ui/attachment";
import { MarkdownText } from "@/components/assistant-ui/markdown-text";
import {
  AskUserToolUI,
  FollowUps,
  groupTurn,
  PlanToolUI,
  TurnGroup,
} from "@/components/assistant-ui/tool-calls";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { Button } from "@/components/atoms/Button";
import LoadingState from "@/components/primitives/LoadingState";
import {
  editsBrief,
  moveEditToFront,
  removeEdit,
  useQueuedEdits,
  type QueuedEdit,
} from "@/lib/edit-queue";
import { cn } from "@/lib/utils";
import {
  ActionBarMorePrimitive,
  ActionBarPrimitive,
  AssistantIf,
  BranchPickerPrimitive,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { MODELS, findModel, type ModelId } from "@/lib/models";
import type { ProjectFileNode } from "@/lib/project-types";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  AtSignIcon,
  ChevronDownIcon,
  FileTextIcon,
  MicIcon,
  XIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  CornerDownRightIcon,
  ListEndIcon,
  MoreHorizontalIcon,
  PencilIcon,
  RefreshCwIcon,
  SquareIcon,
  Trash2Icon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FC,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";

type ComposerProps = {
  /** The project the chat belongs to; without one there are no files or commands to offer. */
  projectId?: string | null;
  model: ModelId;
  onModelChange: (model: ModelId) => void;
};

export const Thread: FC<{ welcome?: ReactNode } & ComposerProps> = ({
  welcome,
  ...composer
}) => {
  return (
    <ThreadPrimitive.Root
      className="aui-root aui-thread-root @container flex h-full flex-col bg-page"
      style={{
        ["--thread-max-width" as string]: "44rem",
      }}
    >
      <ThreadPrimitive.Viewport className="aui-thread-viewport relative flex flex-1 flex-col overflow-x-hidden overflow-y-scroll px-4 pt-4">
        {welcome && (
          <AssistantIf condition={({ thread }) => thread.isEmpty}>
            {welcome}
          </AssistantIf>
        )}

        <ThreadPrimitive.Messages
          components={{
            UserMessage,
            EditComposer,
            AssistantMessage,
          }}
        />

        <ThreadPrimitive.ViewportFooter className="aui-thread-viewport-footer sticky bottom-0 mx-auto mt-auto flex w-full max-w-(--thread-max-width) flex-col gap-4 overflow-visible rounded-t-[14px] bg-page pb-4 md:pb-6">
          <ThreadScrollToBottom />
          <Composer {...composer} />
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
};

const ThreadScrollToBottom: FC = () => {
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <button
        type="button"
        aria-label="Scroll to bottom"
        className="aui-thread-scroll-to-bottom absolute -top-11 z-10 flex size-8 items-center justify-center self-center rounded-full bg-surface text-ink-2 shadow-raised transition-colors duration-100 hover:bg-hover hover:text-ink disabled:invisible"
      >
        <ArrowDownIcon className="size-4" />
      </button>
    </ThreadPrimitive.ScrollToBottom>
  );
};

const emit = (name: string, detail?: object) =>
  window.dispatchEvent(new CustomEvent(name, { detail }));

/**
 * Slash commands, each a real action elsewhere in the workspace. They go out as window events
 * that the workspace shell, DesignActions and PublishDialog listen for.
 */
const COMMANDS: { name: string; desc: string; run: () => void }[] = [
  {
    name: "/preview",
    desc: "Show the live preview",
    run: () => emit("ai-builder:panel-view", { view: "preview" }),
  },
  {
    name: "/canvas",
    desc: "Show the design canvas",
    run: () => emit("ai-builder:panel-view", { view: "canvas" }),
  },
  {
    name: "/code",
    desc: "Browse the code",
    run: () => emit("ai-builder:panel-view", { view: "code" }),
  },
  {
    name: "/select",
    desc: "Pick an element in the preview to change",
    run: () => emit("ai-builder:toggle-select"),
  },
  {
    name: "/redesign",
    desc: "Redesign from a website",
    run: () => emit("ai-builder:open-design", { mode: "redesign" }),
  },
  {
    name: "/critique",
    desc: "Critique the design into DESIGN.md",
    run: () => emit("ai-builder:open-design", { mode: "critique" }),
  },
  {
    name: "/polish",
    desc: "Bring every section into one design",
    run: () => emit("ai-builder:open-design", { mode: "polish" }),
  },
  {
    name: "/publish",
    desc: "Publish to production",
    run: () => emit("ai-builder:open-publish"),
  },
];

/** The @file or /command being typed: @ after a space or at the start, / only as the whole draft. */
const parseToken = (text: string) => {
  const slash = /^\/([\w-]*)$/.exec(text);
  if (slash)
    return { kind: "slash" as const, query: slash[1].toLowerCase(), start: 0 };
  const at = /(^|\s)@([^\s@]*)$/.exec(text);
  return at
    ? {
        kind: "at" as const,
        query: at[2].toLowerCase(),
        start: at.index + at[1].length,
      }
    : null;
};

const flattenFiles = (nodes: ProjectFileNode[]): string[] =>
  nodes.flatMap((node) =>
    node.type === "file" ? [node.path] : flattenFiles(node.children ?? []),
  );

/** The project's file paths for the @ picker, read each time it opens: the agent adds files as it works. */
const useProjectFiles = (
  projectId: string | null | undefined,
  open: boolean,
) => {
  const [files, setFiles] = useState<string[] | null>(null);
  useEffect(() => {
    if (!open || !projectId) return;
    let cancelled = false;
    fetch(`/api/projects/${projectId}/files`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : { tree: [] }))
      .then((data: { tree?: ProjectFileNode[] }) => {
        if (!cancelled) setFiles(flattenFiles(data.tree ?? []));
      })
      .catch(() => {
        if (!cancelled) setFiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, projectId]);
  return files;
};

/** Files picked with @ go with the message as paths for the agent to read — never their contents. */
const withSources = (text: string, sources: string[]) =>
  sources.length
    ? [
        text.trim(),
        "",
        "Read these project files for context:",
        ...sources.map((file) => `- \`${file}\``),
      ]
        .join("\n")
        .trim()
    : text;

type Recognition = {
  continuous: boolean;
  lang: string;
  onresult:
    | ((event: {
        resultIndex: number;
        results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
      }) => void)
    | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

const recognitionConstructor = () => {
  const scope = window as unknown as Record<
    string,
    (new () => Recognition) | undefined
  >;
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
};

/**
 * Dictation with the browser's Web Speech API: each finished phrase goes to `onPhrase` until the
 * user stops or the browser ends the session. Where it is unsupported there is no button.
 */
const useDictation = (onPhrase: (phrase: string) => void) => {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const recognition = useRef<Recognition | null>(null);
  const onPhraseRef = useRef(onPhrase);
  useEffect(() => {
    onPhraseRef.current = onPhrase;
  });
  // After mount: the server render cannot know the browser.
  useEffect(() => {
    setSupported(Boolean(recognitionConstructor()));
    return () => recognition.current?.stop();
  }, []);

  const toggle = () => {
    if (recognition.current) return recognition.current.stop();
    const Constructor = recognitionConstructor();
    if (!Constructor) return;
    const next = new Constructor();
    next.continuous = true;
    next.lang = navigator.language;
    next.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (result.isFinal) onPhraseRef.current(result[0].transcript.trim());
      }
    };
    next.onend = () => {
      recognition.current = null;
      setListening(false);
    };
    recognition.current = next;
    next.start();
    setListening(true);
  };

  return { supported, listening, toggle };
};

const WithTooltip: FC<{ label: string; children: ReactElement }> = ({
  label,
  children,
}) => (
  <Tooltip>
    <TooltipTrigger asChild>{children}</TooltipTrigger>
    <TooltipContent side="top">{label}</TooltipContent>
  </Tooltip>
);

/**
 * Beautiful UI's Prompt Bar (Rounded) on the thread's composer: one card holding queued changes,
 * attachments, picked files, input and actions. Type @ to hand the agent project files, / at the
 * start for workspace commands; ↑↓ and Enter pick.
 */
const Composer: FC<ComposerProps> = ({ projectId, model, onModelChange }) => {
  const aui = useAui();
  const edits = useQueuedEdits();
  const isRunning = useAuiState(({ thread }) => thread.isRunning);
  const lastStatus = useAuiState(
    ({ thread }) => thread.messages.at(-1)?.status?.type,
  );
  const text = useAuiState(({ composer }) => composer.text);

  const [sources, setSources] = useState<string[]>([]);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [active, setActive] = useState(0);
  const [modelOpen, setModelOpen] = useState(false);

  const token = projectId && !menuDismissed ? parseToken(text) : null;
  const files = useProjectFiles(projectId, token?.kind === "at");
  const rows =
    token?.kind === "at"
      ? (files ?? [])
          .filter((file) => file.toLowerCase().includes(token.query))
          .slice(0, 30)
          .map((file) => ({
            key: file,
            name: file.split("/").pop() ?? file,
            desc: file.includes("/")
              ? file.slice(0, file.lastIndexOf("/"))
              : "",
          }))
      : token?.kind === "slash"
        ? COMMANDS.filter((command) =>
            command.name.slice(1).startsWith(token.query),
          ).map(({ name, desc }) => ({ key: name, name, desc }))
        : [];

  useEffect(() => {
    setActive(0);
  }, [token?.kind, token?.query]);
  useEffect(() => {
    setMenuDismissed(false);
  }, [text]);

  // A click anywhere outside the model menu closes it.
  useEffect(() => {
    if (!modelOpen) return;
    const close = (event: PointerEvent) => {
      if (!(event.target as Element).closest("[data-model-menu]"))
        setModelOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [modelOpen]);

  const dictation = useDictation((phrase) => {
    const composer = aui.composer();
    const current = composer.getState().text;
    composer.setText(
      current.trim() ? `${current.trimEnd()} ${phrase}` : phrase,
    );
  });

  const pick = (row: { key: string }) => {
    if (!token) return;
    const composer = aui.composer();
    if (token.kind === "at") {
      setSources((current) =>
        current.includes(row.key) ? current : [...current, row.key],
      );
      composer.setText(text.slice(0, token.start));
    } else {
      composer.setText("");
      COMMANDS.find((command) => command.name === row.key)?.run();
    }
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!token) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setMenuDismissed(true);
      return;
    }
    if (!rows.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : rows.length - 1;
      setActive((current) => (current + step) % rows.length);
    } else if (
      (event.key === "Enter" && !event.shiftKey) ||
      event.key === "Tab"
    ) {
      // Handled before the composer's own Enter, which would send the half-typed token.
      event.preventDefault();
      pick(rows[active] ?? rows[0]);
    }
  };

  // ponytail: character-count guess at wrapping; measure the text like PromptBar if it misjudges.
  const wide = text.includes("\n") || text.length > 60;
  const chosen = findModel(model) ?? MODELS[0];

  /**
   * Queued preview changes go to the agent one message at a time, each after the previous turn
   * finishes. One change per turn keeps every request to one change's worth of HTML and tool
   * output — all of them in a single turn is how a conversation outgrows the model's context.
   * Appended to the thread rather than typed into the composer, so a draft is never overwritten.
   * The queue stops when a turn ends without completing: an error, or the user pressing Stop.
   */
  const [draining, setDraining] = useState(false);
  const awaitingStart = useRef(false);
  const ranOne = useRef(false);

  const sendEdit = useCallback(
    (edit: QueuedEdit, note = "") => {
      removeEdit(edit.id);
      awaitingStart.current = true;
      aui.thread().append(editsBrief([edit], note));
    },
    [aui],
  );

  useEffect(() => {
    if (!draining) return;
    if (isRunning) {
      awaitingStart.current = false;
      ranOne.current = true;
      return;
    }
    // The turn just appended has not started yet.
    if (awaitingStart.current) return;
    const next = edits[0];
    // A turn waiting on the user's answers has not finished either.
    const stopped =
      lastStatus === "incomplete" || lastStatus === "requires-action";
    if ((ranOne.current && stopped) || !next) {
      setDraining(false);
      ranOne.current = false;
      return;
    }
    sendEdit(next);
  }, [draining, isRunning, lastStatus, edits, sendEdit]);

  /** Enter or the send arrow with changes queued: start on them, typed text and picked files riding with the first. */
  const startQueue = () => {
    const composer = aui.composer();
    const note = withSources(composer.getState().text.trim(), sources);
    if (note && edits[0]) {
      composer.setText("");
      setSources([]);
      sendEdit(edits[0], note);
    }
    setDraining(true);
  };

  /** Steer: this change goes next — and right now, if the agent is idle. */
  const steer = (id: string) => {
    moveEditToFront(id);
    if (!isRunning) setDraining(true);
  };

  return (
    <ComposerPrimitive.Root
      className="aui-composer-root relative flex w-full flex-col"
      // Enter submits the form; with changes queued it starts on them, even with nothing typed.
      // Picked files are added to the text just before it is sent.
      onSubmit={(event) => {
        if (edits.length) {
          event.preventDefault();
          startQueue();
          return;
        }
        if (!sources.length) return;
        event.preventDefault();
        const composer = aui.composer();
        composer.setText(withSources(composer.getState().text, sources));
        composer.send();
        setSources([]);
      }}
    >
      {/* @ files / slash commands — grows up from the composer's top edge */}
      {token && (
        <div
          role="listbox"
          aria-label={token.kind === "at" ? "Project files" : "Commands"}
          className="absolute inset-x-0 bottom-full z-10 mb-2 rounded-[10px] bg-surface p-1 shadow-raised"
          style={{
            animation: "pop-in 180ms cubic-bezier(0.23,1,0.32,1) both",
            transformOrigin: "bottom center",
          }}
        >
          <div className="max-h-64 overflow-y-auto">
            {rows.map((row, index) => (
              <button
                key={row.key}
                type="button"
                role="option"
                aria-selected={index === active}
                ref={(element) => {
                  if (index === active)
                    element?.scrollIntoView({ block: "nearest" });
                }}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => pick(row)}
                className={cn(
                  "flex h-9 w-full items-center gap-2.5 rounded-[6px] px-2 text-left transition-colors duration-100",
                  index === active && "bg-hover",
                )}
              >
                {token.kind === "at" && (
                  <FileTextIcon className="size-3.5 shrink-0 text-ink-3" />
                )}
                <span className="max-w-[60%] shrink-0 truncate text-[12.5px] font-medium text-ink">
                  {row.name}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-ink-3">
                  {row.desc}
                </span>
              </button>
            ))}
            {rows.length === 0 && (
              <div className="flex h-9 items-center px-2 text-[12px] text-ink-3">
                {token.kind === "at" && files === null
                  ? "Loading files…"
                  : `No matches for “${token.query}”`}
              </div>
            )}
          </div>
          <div className="mt-1 border-t border-line px-2 pt-1.5 pb-1 text-[11px] text-ink-3">
            {token.kind === "at"
              ? "Pick files for the agent to read"
              : "Type to search commands"}
          </div>
        </div>
      )}

      {modelOpen && (
        <div
          data-model-menu
          role="menu"
          className="absolute right-0 bottom-full z-10 mb-2 w-56 rounded-[10px] bg-surface p-1 shadow-raised"
          style={{
            animation: "pop-in 180ms cubic-bezier(0.23,1,0.32,1) both",
            transformOrigin: "bottom right",
          }}
        >
          {MODELS.map((option) => (
            <button
              key={option.id}
              type="button"
              role="menuitemradio"
              aria-checked={option.id === chosen.id}
              onClick={() => {
                onModelChange(option.id);
                setModelOpen(false);
              }}
              className="flex h-7.5 w-full items-center gap-2 rounded-[6px] px-2 text-left transition-colors duration-100 hover:bg-hover"
            >
              <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">
                {option.name}
              </span>
              <span className="shrink-0 text-[11px] text-ink-3">
                {option.tag}
              </span>
              <CheckIcon
                className={cn(
                  "size-3.5 shrink-0 text-ink",
                  option.id !== chosen.id && "invisible",
                )}
                strokeWidth={2.5}
              />
            </button>
          ))}
        </div>
      )}

      <ComposerPrimitive.AttachmentDropzone className="aui-composer-attachment-dropzone flex w-full flex-col gap-1.5 overflow-hidden rounded-[14px] border border-line bg-surface p-1.5 shadow-card transition-[border-color,background-color] duration-150 focus-within:border-line-strong data-[dragging=true]:border-dashed data-[dragging=true]:border-accent data-[dragging=true]:bg-accent-tint">
        {edits.length > 0 && <QueuedEdits edits={edits} onSteer={steer} />}
        <ComposerAttachments />
        {sources.length > 0 && (
          <div
            className="flex flex-wrap gap-1.5 px-0.5 pt-0.5"
            aria-label="Files for the agent to read"
          >
            {sources.map((file) => (
              <span
                key={file}
                title={file}
                className="flex h-6.5 items-center gap-1.5 rounded-chip bg-field py-1 pr-1 pl-1.5 text-[11.5px] text-ink-2 shadow-hairline"
                style={{
                  animation: "pop-in 200ms cubic-bezier(0.23,1,0.32,1) both",
                }}
              >
                <AtSignIcon className="size-3 shrink-0" />
                <span className="max-w-44 truncate font-mono">{file}</span>
                <button
                  type="button"
                  aria-label={`Remove ${file}`}
                  onClick={() =>
                    setSources((current) =>
                      current.filter((item) => item !== file),
                    )
                  }
                  className="-my-1 flex size-6 items-center justify-center rounded-[5px] text-ink-3 transition-colors duration-100 hover:bg-line/70 hover:text-ink"
                >
                  <XIcon className="size-2.5" strokeWidth={2.5} />
                </button>
              </span>
            ))}
          </div>
        )}
        {/* Long drafts take the full width, with the controls on their own row below. */}
        <div
          className={cn(
            "grid items-end gap-x-1 gap-y-1.5",
            wide
              ? "grid-cols-[28px_auto_minmax(0,1fr)_auto_28px]"
              : "grid-cols-[28px_minmax(0,1fr)_auto_auto_28px]",
          )}
        >
          <div
            className={
              wide ? "col-start-1 row-start-2" : "col-start-1 row-start-1"
            }
          >
            <ComposerAddAttachment />
          </div>
          <ComposerPrimitive.Input
            placeholder={
              dictation.listening
                ? "Listening…"
                : edits.length
                  ? "Press Enter to apply the queued changes one by one…"
                  : projectId
                    ? "Send a message, @ a file, / for commands…"
                    : "Send a message..."
            }
            className={cn(
              "aui-composer-input max-h-32 min-h-7 w-full resize-none bg-transparent px-1 py-[5px] text-[13px] leading-[18px] [overflow-wrap:anywhere] text-ink outline-none placeholder:text-ink-3",
              wide ? "col-span-full row-start-1" : "col-start-2 row-start-1",
            )}
            rows={1}
            aria-label="Message input"
            onKeyDown={onInputKeyDown}
          />
          <button
            type="button"
            data-model-menu
            aria-haspopup="menu"
            aria-expanded={modelOpen}
            aria-label={`Model: ${chosen.name}`}
            onClick={() => setModelOpen((open) => !open)}
            className={cn(
              "flex h-7 shrink-0 items-center gap-1 rounded-[8px] px-1.5 text-[12px] font-medium text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-ink",
              wide
                ? "col-start-2 row-start-2 justify-self-start"
                : "col-start-3 row-start-1",
            )}
          >
            <span className="max-w-28 truncate">{chosen.name}</span>
            <ChevronDownIcon className="size-3 text-ink-3" strokeWidth={2.4} />
          </button>
          {dictation.supported && (
            <WithTooltip
              label={dictation.listening ? "Stop dictation" : "Dictate"}
            >
              <button
                type="button"
                aria-label={
                  dictation.listening ? "Stop dictation" : "Start dictation"
                }
                aria-pressed={dictation.listening}
                onClick={dictation.toggle}
                className={cn(
                  "col-start-4 flex size-7 shrink-0 items-center justify-center rounded-[8px] transition-[background-color,color,transform] duration-150 active:scale-[0.94]",
                  wide ? "row-start-2" : "row-start-1",
                  dictation.listening
                    ? "bg-accent-tint text-accent-ink"
                    : "text-ink-3 hover:bg-hover hover:text-ink",
                )}
              >
                <MicIcon className="size-4" strokeWidth={2} />
              </button>
            </WithTooltip>
          )}
          <div
            className={
              wide ? "col-start-5 row-start-2" : "col-start-5 row-start-1"
            }
          >
            <ComposerAction
              onSendEdits={edits.length && !draining ? startQueue : undefined}
            />
          </div>
        </div>
      </ComposerPrimitive.AttachmentDropzone>
    </ComposerPrimitive.Root>
  );
};

/** The changes picked in the preview, in the order they will be sent. */
const QueuedEdits: FC<{
  edits: QueuedEdit[];
  onSteer: (id: string) => void;
}> = ({ edits, onSteer }) => (
  <ul
    className="flex flex-col gap-0.5 border-b border-line pb-1.5"
    aria-label="Queued changes"
  >
    {edits.map((edit) => (
      <li
        key={edit.id}
        className="flex h-8 items-center gap-2 rounded-control px-1.5 transition-colors duration-100 hover:bg-hover"
        style={{ animation: "fade-up 300ms cubic-bezier(0.23,1,0.32,1) both" }}
      >
        <ListEndIcon className="size-3.5 shrink-0 text-ink-3" />
        <span
          className="inline-flex h-5.5 max-w-20 shrink-0 items-center truncate rounded-chip bg-field px-1.5 font-mono text-[11px] text-ink-2 shadow-hairline"
          title={edit.element.path}
        >
          {edit.element.tag}
        </span>
        <span
          className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink"
          title={`${edit.element.path} — ${edit.instruction}`}
        >
          {edit.instruction}
        </span>
        <button
          type="button"
          onClick={() => onSteer(edit.id)}
          className="flex h-6 shrink-0 items-center gap-1 rounded-[6px] px-1.5 text-[12px] font-medium text-ink-3 transition-colors duration-100 hover:bg-hover-2 hover:text-ink"
          title="Send this change next"
        >
          <CornerDownRightIcon className="size-3.5" />
          Steer
        </button>
        <button
          type="button"
          onClick={() => removeEdit(edit.id)}
          className="flex size-6 shrink-0 items-center justify-center rounded-[6px] text-ink-3 transition-colors duration-100 hover:bg-hover-2 hover:text-red"
          aria-label="Remove this change"
        >
          <Trash2Icon className="size-3.5" />
        </button>
      </li>
    ))}
  </ul>
);

/** Prompt Bar's tactile square: ink when it can act, muted while the composer's Send is disabled. */
const actionButton =
  "flex size-7 shrink-0 items-center justify-center rounded-[8px] bg-ink text-surface transition-[background-color,color,transform] duration-200 enabled:active:scale-[0.94] disabled:bg-line-strong disabled:text-ink-2";

const ComposerAction: FC<{ onSendEdits?: () => void }> = ({ onSendEdits }) => {
  return (
    <>
      <AssistantIf condition={({ thread }) => !thread.isRunning}>
        {onSendEdits ? (
          // The composer's own Send is disabled while the input is empty; queued changes are
          // enough to send.
          <WithTooltip label="Apply these changes">
            <button
              type="button"
              className={cn("aui-composer-send", actionButton)}
              aria-label="Send changes"
              onClick={onSendEdits}
            >
              <ArrowUpIcon className="size-4" strokeWidth={2.4} />
            </button>
          </WithTooltip>
        ) : (
          <WithTooltip label="Send">
            <ComposerPrimitive.Send asChild>
              <button
                type="submit"
                className={cn("aui-composer-send", actionButton)}
                aria-label="Send message"
              >
                <ArrowUpIcon className="size-4" strokeWidth={2.4} />
              </button>
            </ComposerPrimitive.Send>
          </WithTooltip>
        )}
      </AssistantIf>

      <AssistantIf condition={({ thread }) => thread.isRunning}>
        <WithTooltip label="Stop">
          <ComposerPrimitive.Cancel asChild>
            <button
              type="button"
              className={cn("aui-composer-cancel", actionButton)}
              aria-label="Stop generating"
            >
              <SquareIcon className="size-3 fill-current" />
            </button>
          </ComposerPrimitive.Cancel>
        </WithTooltip>
      </AssistantIf>
    </>
  );
};

const MessageError: FC = () => {
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="aui-message-error-root mt-2 rounded-card bg-red-tint px-3 py-2 text-[13px] text-red">
        <ErrorPrimitive.Message className="aui-message-error-message line-clamp-2" />
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
};

/** Stable, so the grouped parts are not rebuilt on every render. */
const ASSISTANT_PARTS = {
  Text: MarkdownText,
  Group: TurnGroup,
  // The tools that render outside runs (see groupTurn).
  tools: {
    by_name: { askUserTool: AskUserToolUI, updatePlanTool: PlanToolUI },
  },
};

/**
 * What the turn that wrote this message took and cost, as `turnMetadata` in lib/llm-provider.ts
 * attached it. assistant-ui keeps a UIMessage's metadata under `metadata.custom`, so that is
 * where it lands — both while streaming and after a reload from the saved conversation.
 */
type TurnUsage = Partial<{
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  modelId: string;
}>;

const compactTokens = (tokens: number) =>
  tokens < 1_000 ? `${tokens}` : `${(tokens / 1_000).toFixed(1)}k`;

/** Sub-cent turns are the common case, and read as nothing at two decimals. */
const formatTurnCost = (cost: number) =>
  `$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}`;

/** Messages from before this was recorded carry no metadata; they show nothing rather than zeroes. */
const TurnStats: FC = () => {
  const turn = useAuiState(
    ({ message }) => message.metadata.custom["turn"] as TurnUsage | undefined,
  );
  if (!turn) return null;
  const stats = [
    turn.durationMs ? `${(turn.durationMs / 1_000).toFixed(1)}s` : null,
    turn.inputTokens ? `${compactTokens(turn.inputTokens)} in` : null,
    turn.outputTokens ? `${compactTokens(turn.outputTokens)} out` : null,
    turn.cost ? formatTurnCost(turn.cost) : null,
    (turn.modelId && findModel(turn.modelId)?.name) || null,
  ].filter(Boolean);
  if (!stats.length) return null;
  return (
    <div className="aui-assistant-message-stats self-center px-1 text-[11px] text-ink-3 tabular-nums">
      {stats.join(" \u00b7 ")}
    </div>
  );
};

const AssistantMessage: FC = () => {
  return (
    <MessagePrimitive.Root
      className="aui-assistant-message-root relative mx-auto w-full max-w-(--thread-max-width) animate-in py-3 duration-150 fade-in slide-in-from-bottom-1"
      data-role="assistant"
    >
      <div className="aui-assistant-message-content px-2 leading-relaxed wrap-break-word text-ink">
        {/* Runs of reasoning and tool calls as one block each; prose between them as itself. */}
        <MessagePrimitive.Unstable_PartsGrouped
          groupingFunction={groupTurn}
          components={ASSISTANT_PARTS}
        />
        {/* A working run shows its own progress; this covers the start and the gaps after prose. */}
        <AssistantIf
          condition={({ message }) =>
            message.status?.type === "running" &&
            (message.parts.at(-1)?.type ?? "text") === "text"
          }
        >
          <div className="mt-3">
            <LoadingState label="Working" />
          </div>
        </AssistantIf>
        <MessageError />
        <FollowUps />
      </div>

      <div className="aui-assistant-message-footer mt-1 ml-2 flex">
        <BranchPicker />
        <AssistantActionBar />
        <TurnStats />
      </div>
    </MessagePrimitive.Root>
  );
};

const AssistantActionBar: FC = () => {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      autohideFloat="single-branch"
      className="aui-assistant-action-bar-root col-start-3 row-start-2 -ml-1 flex gap-0.5 text-ink-3 data-floating:absolute data-floating:rounded-card data-floating:bg-surface data-floating:p-1 data-floating:shadow-raised"
    >
      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton tooltip="Copy">
          <AssistantIf condition={({ message }) => message.isCopied}>
            <CheckIcon />
          </AssistantIf>
          <AssistantIf condition={({ message }) => !message.isCopied}>
            <CopyIcon />
          </AssistantIf>
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>
      <ActionBarPrimitive.Reload asChild>
        <TooltipIconButton tooltip="Refresh">
          <RefreshCwIcon />
        </TooltipIconButton>
      </ActionBarPrimitive.Reload>
      <ActionBarMorePrimitive.Root>
        <ActionBarMorePrimitive.Trigger asChild>
          <TooltipIconButton
            tooltip="More"
            className="data-[state=open]:bg-hover-2 data-[state=open]:text-ink"
          >
            <MoreHorizontalIcon />
          </TooltipIconButton>
        </ActionBarMorePrimitive.Trigger>
        <ActionBarMorePrimitive.Content
          side="bottom"
          align="start"
          className="aui-action-bar-more-content z-50 min-w-36 overflow-hidden rounded-card bg-surface p-1 text-ink shadow-overlay"
        >
          <ActionBarPrimitive.ExportMarkdown asChild>
            <ActionBarMorePrimitive.Item className="aui-action-bar-more-item flex cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1.5 text-[13px] outline-none select-none hover:bg-hover focus:bg-hover">
              <DownloadIcon className="size-3.5 text-ink-3" />
              Export as Markdown
            </ActionBarMorePrimitive.Item>
          </ActionBarPrimitive.ExportMarkdown>
        </ActionBarMorePrimitive.Content>
      </ActionBarMorePrimitive.Root>
    </ActionBarPrimitive.Root>
  );
};

const UserMessage: FC = () => {
  return (
    <MessagePrimitive.Root
      className="aui-user-message-root mx-auto grid w-full max-w-(--thread-max-width) animate-in auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 py-3 duration-150 fade-in slide-in-from-bottom-1 [&:where(>*)]:col-start-2"
      data-role="user"
    >
      <UserMessageAttachments />

      <div className="aui-user-message-content-wrapper relative col-start-2 min-w-0">
        <div className="aui-user-message-content rounded-xl bg-field px-3.5 py-2 wrap-break-word text-ink">
          <MessagePrimitive.Parts />
        </div>
        <div className="aui-user-action-bar-wrapper absolute top-1/2 left-0 -translate-x-full -translate-y-1/2 pr-2">
          <UserActionBar />
        </div>
      </div>

      <BranchPicker className="aui-user-branch-picker col-span-full col-start-1 row-start-3 -mr-1 justify-end" />
    </MessagePrimitive.Root>
  );
};

const UserActionBar: FC = () => {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-user-action-bar-root flex flex-col items-end"
    >
      <ActionBarPrimitive.Edit asChild>
        <TooltipIconButton tooltip="Edit" className="aui-user-action-edit">
          <PencilIcon />
        </TooltipIconButton>
      </ActionBarPrimitive.Edit>
    </ActionBarPrimitive.Root>
  );
};

const EditComposer: FC = () => {
  return (
    <MessagePrimitive.Root className="aui-edit-composer-wrapper mx-auto flex w-full max-w-(--thread-max-width) flex-col px-2 py-3">
      <ComposerPrimitive.Root className="aui-edit-composer-root ml-auto flex w-full max-w-[85%] flex-col rounded-[14px] border border-line bg-surface shadow-card transition-[border-color] duration-150 focus-within:border-line-strong">
        <ComposerPrimitive.Input
          className="aui-edit-composer-input min-h-14 w-full resize-none bg-transparent px-3 pt-3 pb-1 text-[13px] leading-[18px] text-ink outline-none"
          autoFocus
        />
        <div className="aui-edit-composer-footer flex items-center justify-end gap-1.5 p-2">
          <ComposerPrimitive.Cancel asChild>
            <Button variant="quiet" size="sm">
              Cancel
            </Button>
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send asChild>
            <Button variant="primary" size="sm">
              Update
            </Button>
          </ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </MessagePrimitive.Root>
  );
};

const BranchPicker: FC<BranchPickerPrimitive.Root.Props> = ({
  className,
  ...rest
}) => {
  return (
    <BranchPickerPrimitive.Root
      hideWhenSingleBranch
      className={cn(
        "aui-branch-picker-root mr-2 -ml-2 inline-flex items-center text-[12px] text-ink-3",
        className,
      )}
      {...rest}
    >
      <BranchPickerPrimitive.Previous asChild>
        <TooltipIconButton tooltip="Previous">
          <ChevronLeftIcon />
        </TooltipIconButton>
      </BranchPickerPrimitive.Previous>
      <span className="aui-branch-picker-state font-medium tabular-nums">
        <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
      </span>
      <BranchPickerPrimitive.Next asChild>
        <TooltipIconButton tooltip="Next">
          <ChevronRightIcon />
        </TooltipIconButton>
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  );
};
