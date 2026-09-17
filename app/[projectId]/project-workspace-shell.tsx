"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import type { ProjectItem } from "@/lib/project-types";
import { VmTerminal } from "@/components/assistant-ui/vm-terminal";
import { ProjectConversationsProvider } from "@/lib/project-conversations-context";
import { ProjectsProvider } from "@/lib/projects-context";
import { PublishDialog } from "@/components/assistant-ui/publish-dialog";
import { CodePreview } from "@/components/assistant-ui/code-preview";
import { FigmaCanvas } from "@/components/figma-canvas";
import {
  DesignActions,
  sendToAgent,
  useAgentBusy,
} from "@/components/design-actions";
import {
  CLASS_CHANGED_EVENT,
  ElementInspector,
} from "@/components/element-inspector";
import {
  addEdit,
  clearEdits,
  editsBrief,
  type PickedElement,
} from "@/lib/edit-queue";
import { PREVIEW_HOST_PARAM } from "@/lib/vars";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronUpIcon,
  CodeIcon,
  FrameIcon,
  InfoIcon,
  ListPlusIcon,
  Loader2Icon,
  MonitorIcon,
  MousePointerClickIcon,
  PlayIcon,
  PlusIcon,
  RotateCwIcon,
  SendHorizontalIcon,
  SlidersHorizontalIcon,
  XIcon,
} from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";

type TerminalTab = {
  id: string;
  label: string;
  /** The named terminal session on the server this tab is attached to. */
  session: string;
  closable: boolean;
};

/** The session the project's app server runs in. Matches APP_SESSION in lib/vars.ts. */
const APP_SESSION = "dev";

/** Chat column's share of the desktop width: 2fr / 3fr by default, never squeezing either side below a fifth. */
const DEFAULT_SPLIT = 0.4;
const MIN_SPLIT = 0.2;
const MAX_SPLIT = 0.8;
const clampSplit = (value: number) =>
  Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, value));

type OptimisticMetadataDetail = {
  projectId: string;
  conversationId: string;
  projectName: string;
  conversationTitle: string;
};

type ThreadStateDetail = {
  projectId: string | null;
  isRunning: boolean;
};

export function ProjectWorkspaceShell({
  projectId,
  children,
  selectedConversationIdOverride,
}: {
  projectId: string | null;
  children: React.ReactNode;
  selectedConversationIdOverride?: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const selectedConversationId =
    selectedConversationIdOverride ??
    pathname.split("/").filter(Boolean)[1] ??
    null;

  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [threadIsRunning, setThreadIsRunning] = useState(false);
  const hasPublishingProject = projects.some((project) =>
    project.releases.some((release) => release.state === "publishing"),
  );

  const loadProjects = useCallback(async () => {
    const response = await fetch("/api/projects", { cache: "no-store" });
    if (response.ok) {
      const data = (await response.json()) as { projects?: ProjectItem[] };
      setProjects(data.projects ?? []);
    }
    setProjectsLoading(false);
  }, []);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    if (!projectId) return;
    loadProjects();
  }, [loadProjects, projectId]);

  useEffect(() => {
    if (!threadIsRunning && !hasPublishingProject) return;
    const interval = window.setInterval(() => {
      void loadProjects();
    }, 10000);
    return () => {
      window.clearInterval(interval);
    };
  }, [loadProjects, threadIsRunning, hasPublishingProject]);

  useEffect(() => {
    const handleProjectsUpdated = () => {
      void loadProjects();
    };

    window.addEventListener(
      "ai-builder:projects-updated",
      handleProjectsUpdated,
    );
    return () => {
      window.removeEventListener(
        "ai-builder:projects-updated",
        handleProjectsUpdated,
      );
    };
  }, [loadProjects]);

  useEffect(() => {
    const handleThreadState = (event: Event) => {
      const customEvent = event as CustomEvent<ThreadStateDetail>;
      const detail = customEvent.detail;
      if (!detail) return;
      if (projectId && detail.projectId && detail.projectId !== projectId)
        return;
      setThreadIsRunning(Boolean(detail.isRunning));
    };

    window.addEventListener(
      "ai-builder:thread-state",
      handleThreadState as EventListener,
    );
    return () => {
      window.removeEventListener(
        "ai-builder:thread-state",
        handleThreadState as EventListener,
      );
    };
  }, [projectId]);

  useEffect(() => {
    const handleOptimisticMetadata = (event: Event) => {
      const customEvent = event as CustomEvent<OptimisticMetadataDetail>;
      const detail = customEvent.detail;
      if (!detail?.projectId || !detail?.conversationId) return;

      const now = new Date().toISOString();

      setProjects((previous) =>
        previous.map((project) => {
          if (project.id !== detail.projectId) return project;

          const hasConversation = project.conversations.some(
            (conversation) => conversation.id === detail.conversationId,
          );

          const nextConversations = hasConversation
            ? project.conversations.map((conversation) =>
                conversation.id === detail.conversationId
                  ? {
                      ...conversation,
                      title: detail.conversationTitle,
                      updatedAt: now,
                    }
                  : conversation,
              )
            : [
                {
                  id: detail.conversationId,
                  title: detail.conversationTitle,
                  createdAt: now,
                  updatedAt: now,
                },
                ...project.conversations,
              ];

          return {
            ...project,
            name:
              project.name === "Untitled Project"
                ? detail.projectName
                : project.name,
            conversations: nextConversations,
          };
        }),
      );
    };

    window.addEventListener(
      "ai-builder:metadata-optimistic",
      handleOptimisticMetadata as EventListener,
    );
    return () => {
      window.removeEventListener(
        "ai-builder:metadata-optimistic",
        handleOptimisticMetadata as EventListener,
      );
    };
  }, []);

  const handleSelectProject = useCallback(
    (nextProjectId: string) => {
      router.push(`/${nextProjectId}`);
    },
    [router],
  );

  const selectedProject = projectId
    ? (projects.find((project) => project.id === projectId) ?? null)
    : null;
  const showWorkspacePanel = Boolean(projectId);
  const isMobile = useIsMobile();
  const [mobileView, setMobileView] = useState<"chat" | "preview">("chat");
  const [panelView, setPanelView] = useState<PanelView>("preview");

  // Reset to chat view when navigating away
  useEffect(() => {
    if (!projectId) setMobileView("chat");
  }, [projectId]);

  /** The chat column's share of the width on desktop; the preview panel gets the rest. */
  const [split, setSplit] = useState(DEFAULT_SPLIT);
  const [dragging, setDragging] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);

  // On mobile, compute which panel to show
  const gridColumns = (() => {
    if (!showWorkspacePanel) return "1fr 0fr";
    if (isMobile) return mobileView === "chat" ? "1fr 0fr" : "0fr 1fr";
    return `${split}fr ${1 - split}fr`;
  })();

  const conversationsContextValue = useMemo(
    () => ({
      projectId,
      conversations: selectedProject?.conversations ?? [],
      onSelectConversation: (conversationId: string) => {
        if (projectId) {
          router.push(`/${projectId}/${conversationId}`);
        }
      },
    }),
    [projectId, selectedProject?.conversations, router],
  );

  /** Commit the current code and publish it as a new release. */
  const onPublish = useCallback(
    async (nextProjectId: string, message: string, subdomain: string) => {
      // The request stays open until the release is live or has failed, so the
      // release is picked up — as "publishing" — without waiting for it.
      const showRelease = window.setTimeout(() => void loadProjects(), 3000);
      const response = await fetch(`/api/projects/${nextProjectId}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, subdomain }),
      }).finally(() => window.clearTimeout(showRelease));

      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(data?.error ?? "Failed to publish");
      }

      await loadProjects();
    },
    [loadProjects],
  );

  /** Put production back on an earlier release. */
  const onRollback = useCallback(
    async (nextProjectId: string, releaseId: string) => {
      const response = await fetch(`/api/projects/${nextProjectId}/rollback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ releaseId }),
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(data?.error ?? "Failed to roll back");
      }

      await loadProjects();
    },
    [loadProjects],
  );

  const projectsContextValue = useMemo(
    () => ({
      projects,
      isLoading: projectsLoading,
      onSelectProject: handleSelectProject,
    }),
    [projects, projectsLoading, handleSelectProject],
  );

  const iframeRef = useRef<HTMLIFrameElement>(null);

  /**
   * Click-to-select on the live preview. The bridge inside the preview does the picking and
   * reports here; this holds whether picking is on, what was picked, and the page's path.
   */
  const [selecting, setSelecting] = useState(false);
  const [selection, setSelection] = useState<PickedElement | null>(null);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const selectingRef = useRef(false);

  useEffect(() => {
    selectingRef.current = selecting;
    tellPreview(iframeRef.current, { type: "select", on: selecting });
    if (!selecting) setSelection(null);
  }, [selecting]);

  // Picking belongs to the preview of this project: leaving either ends it.
  useEffect(() => {
    setSelecting(false);
  }, [panelView, projectId]);

  // Queued changes describe this project's elements; another project's chat must not get them.
  useEffect(() => {
    clearEdits();
  }, [projectId]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const iframe = iframeRef.current;
      if (!iframe || event.source !== iframe.contentWindow) return;
      const data = event.data as {
        source?: string;
        type?: string;
        path?: string;
        element?: PickedElement;
        rect?: PickedElement["rect"];
        classes?: string;
        styles?: PickedElement["styles"];
      } | null;
      if (data?.source !== "adorable-bridge") return;
      // A reload replaces the bridge, which starts with picking off and nothing picked.
      if (data.type === "ready") {
        tellPreview(iframe, { type: "select", on: selectingRef.current });
        setSelection(null);
      }
      if (data.type === "location" && data.path)
        setPreviewPath(displayPath(data.path));
      if (data.type === "selected" && data.element) setSelection(data.element);
      // The picked element scrolled or the preview resized: the change box follows it.
      if (data.type === "selection-rect" && data.rect) {
        const rect = data.rect;
        setSelection((current) => (current ? { ...current, rect } : current));
      }
      if (data.type === "select-cancelled") setSelecting(false);
      // The property inspector's traffic: new classes arrived by hot reload, the overrides came
      // off and these are the element's styles now, or the element is gone from the page.
      if (data.type === "class-changed")
        window.dispatchEvent(new CustomEvent(CLASS_CHANGED_EVENT));
      if (data.type === "styles-synced" && data.styles) {
        const { classes = "", styles } = data;
        setSelection((current) =>
          current ? { ...current, classes, styles } : current,
        );
      }
      if (data.type === "selection-lost") setSelection(null);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  /**
   * The composer's slash commands drive the panel through window events, so the chat needs none
   * of this state passed down to it.
   */
  useEffect(() => {
    const onView = (event: Event) => {
      const view = (event as CustomEvent<{ view?: PanelView }>).detail?.view;
      if (view !== "preview" && view !== "canvas" && view !== "code") return;
      setPanelView(view);
      setMobileView("preview");
    };
    const onToggleSelect = () => {
      setPanelView("preview");
      setMobileView("preview");
      // A frame later: leaving another view ends picking, in an effect of the same commit.
      requestAnimationFrame(() => setSelecting((on) => !on));
    };
    window.addEventListener("ai-builder:panel-view", onView);
    window.addEventListener("ai-builder:toggle-select", onToggleSelect);
    return () => {
      window.removeEventListener("ai-builder:panel-view", onView);
      window.removeEventListener("ai-builder:toggle-select", onToggleSelect);
    };
  }, []);

  return (
    <ProjectsProvider value={projectsContextValue}>
      <ProjectConversationsProvider value={conversationsContextValue}>
        <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
          {/* Unified top bar */}
          {projectId && selectedProject && (
            <div
              className={cn(
                "shrink-0 border-b bg-background",
                // The column animation would trail the pointer while resizing.
                !dragging &&
                  "transition-[grid-template-columns] duration-500 ease-in-out",
                isMobile ? "flex h-11 items-center" : "grid h-11",
              )}
              style={
                isMobile ? undefined : { gridTemplateColumns: gridColumns }
              }
            >
              {/* Left: back button */}
              {(!isMobile || mobileView === "chat") && (
                <div className="flex items-center px-3">
                  <button
                    type="button"
                    onClick={() => {
                      if (selectedConversationId) {
                        window.dispatchEvent(
                          new CustomEvent("ai-builder:go-to-project", {
                            detail: { projectId },
                          }),
                        );
                        router.push(`/${projectId}`);
                      } else {
                        window.dispatchEvent(new Event("ai-builder:go-home"));
                        router.push("/");
                      }
                    }}
                    className="flex items-center gap-1 rounded-md px-1.5 py-1 text-muted-foreground transition-colors hover:bg-hover hover:text-ink"
                    title={
                      selectedConversationId ? "All conversations" : "All apps"
                    }
                  >
                    <ChevronLeftIcon className="size-3.5" />
                    <span className="text-sm font-medium">
                      {selectedConversationId
                        ? "All Conversations"
                        : "All Apps"}
                    </span>
                  </button>
                </div>
              )}

              {/* Mobile preview top bar: back to chat + publish */}
              {isMobile && mobileView === "preview" && (
                <div className="flex flex-1 items-center gap-1 px-2">
                  <button
                    type="button"
                    onClick={() => setMobileView("chat")}
                    className="flex items-center gap-1 rounded-md px-1.5 py-1 text-muted-foreground transition-colors hover:bg-hover hover:text-ink"
                  >
                    <ChevronLeftIcon className="size-3.5" />
                    <span className="text-sm font-medium">Chat</span>
                  </button>
                  <div className="ml-auto flex items-center gap-1.5">
                    {selectedProject.hasSandbox && (
                      <ViewToggle view={panelView} onChange={setPanelView} />
                    )}
                    {selectedProject.hasSandbox && (
                      <PublishDialog
                        project={selectedProject}
                        onPublish={onPublish}
                        onRollback={onRollback}
                      />
                    )}
                  </div>
                </div>
              )}

              {/* Right: browser controls + publish (desktop only) */}
              {!isMobile && (
                <div
                  className={cn(
                    "flex items-center gap-1 px-2 transition-opacity duration-500",
                    showWorkspacePanel
                      ? "opacity-100"
                      : "pointer-events-none opacity-0",
                  )}
                >
                  {showWorkspacePanel && selectedProject.hasSandbox && (
                    <BrowserControls
                      previewUrl={selectedProject.previewUrl}
                      iframeRef={iframeRef}
                      project={selectedProject}
                      onPublish={onPublish}
                      onRollback={onRollback}
                      view={panelView}
                      onViewChange={setPanelView}
                      selecting={selecting}
                      onSelectingChange={setSelecting}
                      previewPath={previewPath}
                    />
                  )}
                </div>
              )}
            </div>
          )}

          {/* Main content grid */}
          <div
            ref={gridRef}
            className={cn(
              "relative grid min-h-0 flex-1 pb-2",
              !isMobile &&
                !dragging &&
                "transition-[grid-template-columns] duration-500 ease-in-out",
            )}
            style={isMobile ? undefined : { gridTemplateColumns: gridColumns }}
          >
            {/* Drag handle between chat and preview. Absolutely positioned, so it takes no grid cell. */}
            {!isMobile && showWorkspacePanel && (
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize preview panel"
                aria-valuemin={MIN_SPLIT * 100}
                aria-valuemax={MAX_SPLIT * 100}
                aria-valuenow={Math.round(split * 100)}
                tabIndex={0}
                onPointerDown={(event) => {
                  event.preventDefault();
                  // Captured, so the preview iframe cannot swallow the moves.
                  event.currentTarget.setPointerCapture(event.pointerId);
                  setDragging(true);
                }}
                onPointerMove={(event) => {
                  if (!dragging) return;
                  const rect = gridRef.current?.getBoundingClientRect();
                  if (!rect) return;
                  setSplit(
                    clampSplit((event.clientX - rect.left) / rect.width),
                  );
                }}
                onPointerUp={() => setDragging(false)}
                onPointerCancel={() => setDragging(false)}
                onDoubleClick={() => setSplit(DEFAULT_SPLIT)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowLeft")
                    setSplit((value) => clampSplit(value - 0.02));
                  if (event.key === "ArrowRight")
                    setSplit((value) => clampSplit(value + 0.02));
                }}
                title="Drag to resize · double-click to reset"
                className="group absolute inset-y-0 z-20 w-3 -translate-x-1/2 cursor-col-resize touch-none outline-none"
                style={{ left: `${split * 100}%` }}
              >
                <div
                  className={cn(
                    "mx-auto h-full w-px bg-border transition-colors group-hover:w-0.5 group-hover:bg-foreground/40 group-focus-visible:w-0.5 group-focus-visible:bg-ring",
                    dragging && "w-0.5 bg-foreground/60",
                  )}
                />
              </div>
            )}
            <div
              className={cn(
                "relative min-w-0 overflow-hidden",
                isMobile && mobileView === "preview" && "hidden",
              )}
            >
              {children}
            </div>
            <div
              className={cn(
                "min-w-0 overflow-hidden",
                !isMobile && "transition-opacity duration-500",
                showWorkspacePanel && (!isMobile || mobileView === "preview")
                  ? "opacity-100"
                  : !isMobile && "pointer-events-none opacity-0",
                isMobile && mobileView === "chat" && "hidden",
              )}
            >
              {showWorkspacePanel &&
                (selectedProject?.hasSandbox ? (
                  <>
                    {/* Stay mounted so switching keeps preview state, canvas frames, and code selection. */}
                    <div
                      className={cn(
                        "h-full",
                        panelView !== "preview" && "hidden",
                      )}
                    >
                      <AppPreview
                        project={selectedProject}
                        iframeRef={iframeRef}
                        selection={selection}
                        // The change is queued (or dismissed); picking stays on for the next one.
                        onSelectionDone={() => {
                          setSelection(null);
                          tellPreview(iframeRef.current, {
                            type: "clear-selection",
                          });
                        }}
                      />
                    </div>
                    <div
                      className={cn(
                        "h-full",
                        panelView !== "canvas" && "hidden",
                      )}
                    >
                      <FigmaCanvas
                        key={selectedProject.id}
                        projectId={selectedProject.id}
                        active={panelView === "canvas"}
                        onReplaced={(anchor) => {
                          // Show the result where it landed: a section below the fold otherwise
                          // looks like nothing happened.
                          setPanelView("preview");
                          const iframe = iframeRef.current;
                          // No `src` yet means the preview never came up, so
                          // there is nowhere to jump to. `previewUrl` is not a
                          // fallback: it is empty whenever signing failed.
                          const base = iframe?.src;
                          if (!base || !anchor) return;
                          const url = new URL(base);
                          url.hash = anchor;
                          iframe.src = url.toString();
                        }}
                      />
                    </div>
                    <div
                      className={cn("h-full", panelView !== "code" && "hidden")}
                    >
                      <CodePreview
                        projectId={selectedProject.id}
                        active={panelView === "code"}
                      />
                    </div>
                  </>
                ) : (
                  <PreviewPlaceholder />
                ))}
            </div>
          </div>

          {/* Mobile floating toggle button */}
          {isMobile && showWorkspacePanel && (
            <button
              type="button"
              onClick={() =>
                setMobileView((v) => (v === "chat" ? "preview" : "chat"))
              }
              className="fixed right-4 bottom-20 z-50 flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform active:scale-95"
              title={mobileView === "chat" ? "Show preview" : "Show chat"}
            >
              {mobileView === "chat" ? (
                <MonitorIcon className="size-5" />
              ) : (
                <CodeIcon className="size-5" />
              )}
            </button>
          )}
        </div>
      </ProjectConversationsProvider>
    </ProjectsProvider>
  );
}

function PreviewPlaceholder() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b bg-muted/20 px-2">
        <div className="size-6 rounded bg-muted-foreground/8" />
        <div className="size-6 rounded bg-muted-foreground/8" />
        <div className="size-6 rounded bg-muted-foreground/8" />
        <div className="ml-1 h-7 flex-1 rounded-md bg-muted/50" />
      </div>

      <div className="h-[70%] overflow-hidden p-8">
        <div className="mx-auto max-w-md space-y-8">
          <div className="flex items-center justify-between">
            <div className="h-4 w-20 animate-pulse rounded bg-muted/60" />
            <div className="flex gap-4">
              <div className="h-3 w-12 animate-pulse rounded bg-muted/40" />
              <div className="h-3 w-12 animate-pulse rounded bg-muted/40" />
              <div className="h-3 w-12 animate-pulse rounded bg-muted/40" />
            </div>
          </div>

          <div className="flex flex-col items-center gap-4 py-6">
            <div className="h-6 w-56 animate-pulse rounded bg-muted/50" />
            <div className="h-4 w-40 animate-pulse rounded bg-muted/30" />
            <div className="mt-2 h-9 w-28 animate-pulse rounded-lg bg-muted/40" />
          </div>

          <div className="grid grid-cols-3 gap-3">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="space-y-2 rounded-lg border border-muted/30 p-3"
              >
                <div className="h-3 w-full animate-pulse rounded bg-muted/40" />
                <div className="h-2 w-3/4 animate-pulse rounded bg-muted/25" />
                <div className="h-2 w-1/2 animate-pulse rounded bg-muted/20" />
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="flex h-[30%] min-h-0 flex-col border-t">
        <div className="flex h-8 shrink-0 items-center bg-muted/20 px-3">
          <div className="h-3.5 w-20 animate-pulse rounded bg-muted-foreground/10" />
        </div>
        <div className="flex-1 p-3">
          <div className="space-y-2">
            <div className="h-2.5 w-48 animate-pulse rounded bg-muted-foreground/8" />
            <div className="h-2.5 w-32 animate-pulse rounded bg-muted-foreground/6" />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * A preview path as the address bar shows it. The hosted preview proxy is told
 * which sandbox to reach by a parameter on the URL the frame loads, and the
 * bridge reports the page's URL as it is; the parameter is the proxy's, not
 * the page's.
 */
const displayPath = (path: string) => {
  try {
    const url = new URL(path, "http://preview.invalid");
    url.searchParams.delete(PREVIEW_HOST_PARAM);
    return url.pathname + url.search + url.hash;
  } catch {
    return path;
  }
};

/** A message for the bridge inside the preview; it only listens to its parent window. */
const tellPreview = (
  iframe: HTMLIFrameElement | null,
  message: Record<string, unknown>,
) =>
  iframe?.contentWindow?.postMessage({ source: "adorable", ...message }, "*");

/** Clearance between the change box, the element it belongs to, and the preview's edges. */
const CARD_GAP = 8;

/**
 * The change box for a picked element: a textarea, and what to do with what was typed.
 *
 * Placed just below the element — above it when there is no room — and kept inside the preview;
 * the frame fills its container, so the element's rect from the bridge is already in these
 * coordinates. Measured before it is shown, so it never flashes in the corner.
 *
 * Two ways out. Add to chat (Enter) does not start the agent: the change joins the chat input,
 * after any added before it. Send now (⌘/Ctrl+Enter) hands this one change to the agent straight
 * away — unless it is mid-turn, when the change is queued instead so the text is never lost.
 * The sliders button opens the property inspector, which needs neither.
 */
function SelectionPrompt({
  element,
  projectId,
  tell,
  onDone,
}: {
  element: PickedElement;
  projectId: string;
  tell: (message: Record<string, unknown>) => void;
  onDone: () => void;
}) {
  const [instruction, setInstruction] = useState("");
  const [inspecting, setInspecting] = useState(false);
  const busy = useAgentBusy(projectId);
  const card = useRef<HTMLFormElement>(null);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);

  useLayoutEffect(() => {
    const box = card.current;
    const frame = box?.parentElement;
    if (!box || !frame) return;
    const bounds = frame.getBoundingClientRect();
    const { width, height } = box.getBoundingClientRect();
    const { x, y, height: elementHeight } = element.rect;
    const below = y + elementHeight + CARD_GAP;
    const above = y - height - CARD_GAP;
    const top =
      below + height <= bounds.height - CARD_GAP
        ? below
        : above >= CARD_GAP
          ? above
          : Math.max(
              CARD_GAP,
              Math.min(below, bounds.height - height - CARD_GAP),
            );
    const left = Math.max(
      CARD_GAP,
      Math.min(x, bounds.width - width - CARD_GAP),
    );
    setPosition({ left, top, width, height });
  }, [element.rect]);

  const submit = () => {
    const text = instruction.trim();
    if (!text) return;
    addEdit(element, text);
    onDone();
  };

  const sendNow = () => {
    const text = instruction.trim();
    if (!text) return;
    if (busy) return submit();
    sendToAgent(
      projectId,
      editsBrief([{ id: crypto.randomUUID(), element, instruction: text }], ""),
    );
    onDone();
  };

  return (
    <>
      <form
        ref={card}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        className="absolute z-20 flex w-[340px] max-w-[calc(100%-16px)] items-end gap-1.5 rounded-lg border bg-background p-1.5 shadow-lg"
        style={{
          left: position?.left ?? 0,
          top: position?.top ?? 0,
          visibility: position ? "visible" : "hidden",
        }}
      >
        <button
          type="button"
          onClick={() => setInspecting((open) => !open)}
          aria-pressed={inspecting}
          aria-label="Edit properties"
          title="Edit properties"
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-md transition-colors",
            inspecting
              ? "bg-indigo-500/15 text-indigo-500"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          <SlidersHorizontalIcon className="size-3.5" />
        </button>
        <textarea
          autoFocus
          rows={1}
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              if (event.metaKey || event.ctrlKey) sendNow();
              else submit();
            }
            if (event.key === "Escape") onDone();
          }}
          placeholder="Describe the change…"
          aria-label={`Change for ${element.path}`}
          className="max-h-24 min-h-7 flex-1 resize-none bg-transparent px-1.5 py-1 text-xs outline-none placeholder:text-muted-foreground"
        />
        <button
          type="submit"
          disabled={!instruction.trim()}
          aria-label="Add this change to the chat"
          title="Add to chat (Enter)"
          className="flex size-7 shrink-0 items-center justify-center rounded-md border text-foreground transition-colors hover:bg-muted disabled:opacity-40"
        >
          <ListPlusIcon className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={sendNow}
          disabled={!instruction.trim() || busy}
          aria-label="Send this change to the agent now"
          title={
            busy
              ? "Agent is working — add to chat instead"
              : "Send to agent now (⌘↵)"
          }
          className="flex size-7 shrink-0 items-center justify-center rounded-md bg-foreground text-background transition-colors hover:bg-foreground/90 disabled:opacity-40"
        >
          <SendHorizontalIcon className="size-3.5" />
        </button>
      </form>
      {inspecting && position && (
        <ElementInspector
          element={element}
          projectId={projectId}
          anchor={position}
          tell={tell}
          onClose={() => setInspecting(false)}
        />
      )}
    </>
  );
}

function AppPreview({
  project,
  iframeRef,
  selection,
  onSelectionDone,
}: {
  project: ProjectItem;
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  selection: PickedElement | null;
  onSelectionDone: () => void;
}) {
  const [extraTerminals, setExtraTerminals] = useState<TerminalTab[]>([]);
  const [activeTab, setActiveTab] = useState("dev-server");
  const [counter, setCounter] = useState(1);
  const [iframeLoaded, setIframeLoaded] = useState(false);
  /**
   * Hiding only collapses the panel: every terminal stays mounted and connected, and the dev
   * server's session lives on the server regardless, so it keeps running and logging.
   */
  const [terminalOpen, setTerminalOpen] = useState(true);

  const tell = useCallback(
    (message: Record<string, unknown>) =>
      tellPreview(iframeRef.current, message),
    [iframeRef],
  );

  useEffect(() => {
    setIframeLoaded(false);
  }, [project.previewUrl]);

  /**
   * Whether the dev server's port is open.
   *
   * A frame that loads while the server is starting or restarting gets the browser's "refused
   * to connect" page — and still fires `load`, so nothing would ever retry it. So the frame is
   * only pointed at the server once it is up, and reloaded when it comes back after going down.
   */
  const [serverUp, setServerUp] = useState<boolean | null>(null);
  /** A dev server process is alive; with the port closed that means starting, not stopped. */
  const [serverRunning, setServerRunning] = useState(true);
  const [everUp, setEverUp] = useState(false);
  const [starting, setStarting] = useState(false);
  /** The sandbox itself is asleep or booting — a few seconds, and not a failure. */
  const [waking, setWaking] = useState(false);
  /** Something the preview cannot wait out, such as a sandbox that is gone. */
  const [fatal, setFatal] = useState<string | null>(null);
  /** Where the frame loads the app from: the preview proxy, which carries the select bridge. */
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    let wasUp: boolean | null = null;
    // Switching projects: the last project's server says nothing about this one's.
    setServerUp(null);
    setServerRunning(true);
    setEverUp(false);
    setPreviewSrc(null);
    setWaking(false);
    setFatal(null);

    const check = async () => {
      const {
        up,
        running,
        proxyUrl,
        waking: sandboxWaking,
        error,
      } = await fetch(`/api/projects/${project.id}/preview-status`, {
        cache: "no-store",
      })
        .then((response) =>
          response.ok ? response.json() : { up: false, running: true },
        )
        .then(
          (data: {
            up?: boolean;
            running?: boolean;
            proxyUrl?: string;
            waking?: boolean;
            error?: string;
          }) => ({
            up: Boolean(data.up),
            running: data.running !== false,
            proxyUrl: data.proxyUrl ?? null,
            waking: Boolean(data.waking),
            error: data.error ?? null,
          }),
          // AI Builder itself unreachable: keep waiting rather than claim the server stopped.
          () => ({
            up: false,
            running: true,
            proxyUrl: null,
            waking: false,
            error: null,
          }),
        );
      if (cancelled) return;

      const iframe = iframeRef.current;
      if (up && wasUp === false && iframe?.getAttribute("src")) {
        setIframeLoaded(false);
        iframe.src = iframe.src;
      }
      wasUp = up;
      setServerUp(up);
      setServerRunning(running);
      setWaking(sandboxWaking);
      setFatal(error);
      if (proxyUrl) setPreviewSrc(proxyUrl);
      if (up) setEverUp(true);
      // Quick while waiting for it, slow once it is up: only a restart needs catching then.
      timer = window.setTimeout(check, up ? 3000 : 1000);
    };

    void check();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [project.id, iframeRef]);

  const startDevServer = async () => {
    setStarting(true);
    await fetch(`/api/projects/${project.id}/preview-status`, {
      method: "POST",
    }).catch(() => {});
    setServerRunning(true);
    setStarting(false);
  };

  /**
   * Terminal sessions are named on the server, so a tab's name is all the
   * state a new terminal needs: the server starts the shell on first connect
   * and keeps it alive afterwards.
   */
  const addTerminal = useCallback(() => {
    const id = `terminal-${counter}`;
    setExtraTerminals((previous) => [
      ...previous,
      {
        id,
        label: `Terminal ${counter}`,
        session: `shell-${counter}`,
        closable: true,
      },
    ]);
    setActiveTab(id);
    setTerminalOpen(true);
    setCounter((current) => current + 1);
  }, [counter]);

  const closeTerminal = useCallback(
    (id: string) => {
      setExtraTerminals((previous) => previous.filter((tab) => tab.id !== id));
      if (activeTab === id) setActiveTab("dev-server");
    },
    [activeTab],
  );

  const allTabs: TerminalTab[] = [
    {
      id: "dev-server",
      label: "Dev Server",
      session: APP_SESSION,
      closable: false,
    },
    ...extraTerminals,
  ];

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div
        className={cn(
          "relative flex min-h-0 flex-col",
          terminalOpen ? "h-[70%]" : "flex-1",
        )}
      >
        <div className="relative min-h-0 flex-1 bg-muted/30">
          {(!everUp || !iframeLoaded || serverUp === false) && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-background">
              {fatal ? (
                <div className="flex flex-col items-center gap-3 px-6 text-center">
                  <p className="text-sm text-muted-foreground">{fatal}</p>
                  <p className="max-w-xs text-xs text-muted-foreground/70">
                    Its files lived in that sandbox, so there is nothing to
                    restart. Create a new project to start again.
                  </p>
                </div>
              ) : serverUp === false && !serverRunning && !waking ? (
                <div className="flex flex-col items-center gap-3 px-6 text-center">
                  <p className="text-sm text-muted-foreground">
                    The dev server is not running.
                  </p>
                  <p className="max-w-xs text-xs text-muted-foreground/70">
                    It stopped or crashed — the Dev Server terminal shows why.
                  </p>
                  <button
                    type="button"
                    onClick={startDevServer}
                    disabled={starting}
                    className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background transition-colors hover:bg-foreground/90 disabled:opacity-60"
                  >
                    {starting ? (
                      <Loader2Icon className="size-3 animate-spin" />
                    ) : (
                      <PlayIcon className="size-3" />
                    )}
                    Start dev server
                  </button>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-3">
                  <Loader2Icon className="size-6 animate-spin text-muted-foreground/40" />
                  <p className="text-sm text-muted-foreground/40">
                    {waking
                      ? "Waking the sandbox up…"
                      : serverUp === false
                        ? everUp
                          ? "Dev server restarting…"
                          : "Starting dev server…"
                        : "Loading preview…"}
                  </p>
                </div>
              )}
            </div>
          )}
          <iframe
            ref={iframeRef}
            src={everUp && previewSrc ? previewSrc : undefined}
            className={cn(
              "h-full w-full transition-opacity duration-300",
              iframeLoaded ? "opacity-100" : "opacity-0",
            )}
            // A frame with no src yet still fires `load` for its blank page; that is not the preview.
            onLoad={(event) => {
              if (event.currentTarget.getAttribute("src"))
                setIframeLoaded(true);
            }}
          />
          {selection && (
            <SelectionPrompt
              // Per pick, not per element state: the inspector updates the selection in place.
              key={selection.pick ?? selection.path}
              element={selection}
              projectId={project.id}
              tell={tell}
              onDone={onSelectionDone}
            />
          )}
        </div>
      </div>

      <div
        className={cn(
          "flex min-h-0 flex-col",
          terminalOpen ? "h-[30%]" : "shrink-0",
        )}
      >
        <div className="flex shrink-0 items-center gap-0 border-y bg-[rgb(43,43,43)] px-1">
          {allTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => {
                setActiveTab(tab.id);
                setTerminalOpen(true);
              }}
              className={`group flex items-center gap-1 px-2 py-1.5 text-xs transition-colors ${
                activeTab === tab.id
                  ? "border-b-2 border-foreground bg-[rgb(43,43,43)] text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <span>{tab.label}</span>
              {tab.closable && (
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTerminal(tab.id);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.stopPropagation();
                      closeTerminal(tab.id);
                    }
                  }}
                  className="ml-0.5 rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-muted"
                >
                  <XIcon className="size-3" />
                </span>
              )}
            </button>
          ))}

          <button
            type="button"
            onClick={addTerminal}
            className="ml-1 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title="New terminal"
          >
            <PlusIcon className="size-3.5" />
          </button>

          <button
            type="button"
            onClick={() => setTerminalOpen((open) => !open)}
            className="ml-auto rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title={
              terminalOpen ? "Hide terminal (keeps running)" : "Show terminal"
            }
            aria-label={terminalOpen ? "Hide terminal" : "Show terminal"}
            aria-expanded={terminalOpen}
          >
            {terminalOpen ? (
              <ChevronDownIcon className="size-3.5" />
            ) : (
              <ChevronUpIcon className="size-3.5" />
            )}
          </button>
        </div>

        <div
          className={cn(
            "relative min-h-0 flex-1 bg-[rgb(30,30,30)]",
            // `hidden`, not unmounted: the terminals stay connected while out of sight.
            !terminalOpen && "hidden",
          )}
        >
          {allTabs.map((tab) => (
            <VmTerminal
              key={tab.id}
              projectId={project.id}
              session={tab.session}
              className="absolute inset-0 h-full w-full p-1"
              // Kept mounted so a background terminal keeps receiving output.
              style={{ display: activeTab === tab.id ? "block" : "none" }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function BrowserControls({
  previewUrl,
  iframeRef,
  project,
  onPublish,
  onRollback,
  view,
  onViewChange,
  selecting,
  onSelectingChange,
  previewPath,
}: {
  previewUrl: string;
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  project: ProjectItem;
  onPublish: (
    projectId: string,
    message: string,
    subdomain: string,
  ) => Promise<void>;
  onRollback: (projectId: string, releaseId: string) => Promise<void>;
  view: PanelView;
  onViewChange: (view: PanelView) => void;
  selecting: boolean;
  onSelectingChange: (on: boolean) => void;
  /** The page the preview is on, as the bridge reports it. */
  previewPath: string | null;
}) {
  const [urlValue, setUrlValue] = useState(() => {
    try {
      return new URL(previewUrl).pathname;
    } catch {
      return "/";
    }
  });

  useEffect(() => {
    try {
      setUrlValue(new URL(previewUrl).pathname);
    } catch {
      setUrlValue("/");
    }
  }, [previewUrl]);

  // Navigating inside the preview (links, client routing) keeps the address bar in step.
  useEffect(() => {
    if (previewPath) setUrlValue(previewPath);
  }, [previewPath]);

  const navigate = (path: string) => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    setUrlValue(normalizedPath);
    // The frame's own origin — the preview proxy — rather than the dev server behind it. A
    // hosted proxy is told which sandbox by a parameter on the URL, so that stays too.
    const base = iframe.src || previewUrl;
    let target: URL;
    try {
      target = new URL(normalizedPath, base);
    } catch {
      return;
    }
    const host = new URL(base).searchParams.get(PREVIEW_HOST_PARAM);
    if (host) target.searchParams.set(PREVIEW_HOST_PARAM, host);
    iframe.src = target.toString();
  };

  const handleReload = () => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    iframe.src = iframe.src;
  };

  // A cross-origin frame's history cannot be driven from here; the bridge does it on request.
  const handleBack = () =>
    tellPreview(iframeRef.current, { type: "history", direction: "back" });

  const handleForward = () =>
    tellPreview(iframeRef.current, { type: "history", direction: "forward" });

  return (
    <>
      {view === "preview" ? (
        <>
          <button
            type="button"
            onClick={handleBack}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title="Back"
          >
            <ArrowLeftIcon className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={handleForward}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title="Forward"
          >
            <ArrowRightIcon className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={handleReload}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title="Reload"
          >
            <RotateCwIcon className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onSelectingChange(!selecting)}
            aria-pressed={selecting}
            className={cn(
              "flex size-7 items-center justify-center rounded-md transition-colors",
              selecting
                ? "bg-indigo-500/15 text-indigo-500"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
            title={
              selecting
                ? "Stop selecting (Esc)"
                : "Select an element in the preview to edit it"
            }
          >
            <MousePointerClickIcon className="size-3.5" />
          </button>
          <form
            className="ml-1 flex-1"
            onSubmit={(e) => {
              e.preventDefault();
              navigate(urlValue);
            }}
          >
            <input
              type="text"
              value={urlValue}
              onChange={(e) => setUrlValue(e.target.value)}
              className="h-7 w-full rounded-md bg-muted/50 px-2.5 text-xs text-foreground transition-colors outline-none focus:bg-muted focus:ring-1 focus:ring-ring"
              aria-label="URL path"
            />
          </form>
        </>
      ) : (
        <div className="flex flex-1 items-center gap-2 px-1">
          {view === "code" ? (
            <CodeIcon className="size-3.5 text-muted-foreground" />
          ) : (
            <FrameIcon className="size-3.5 text-muted-foreground" />
          )}
          <span className="text-sm font-medium text-foreground">
            {view === "code" ? "Code" : "Canvas"}
          </span>
          {view === "code" && (
            <span className="rounded-full border px-2 py-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
              Read only
            </span>
          )}
        </div>
      )}
      <div className="ml-1.5 flex items-center gap-1.5">
        {/* Beside the view switch rather than a panel title, so it shows in every view. */}
        <DesignActions projectId={project.id} />
        <UsageInfo usage={project.usage} />
        <ViewToggle view={view} onChange={onViewChange} />
        <PublishDialog
          project={project}
          onPublish={onPublish}
          onRollback={onRollback}
        />
      </div>
    </>
  );
}

const formatCost = (cost: number) =>
  `$${cost > 0 && cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}`;

/** The project's combined AI usage so far — chat and canvas — on hover. */
function UsageInfo({ usage }: { usage: ProjectItem["usage"] }) {
  const rows: [string, string][] = [
    ["Input tokens", usage.inputTokens.toLocaleString()],
    ["Output tokens", usage.outputTokens.toLocaleString()],
    ["Model requests", usage.requests.toLocaleString()],
  ];

  return (
    <Tooltip
      // Re-read the totals when opened: a chat turn or replace may have finished since.
      onOpenChange={(open) => {
        if (open)
          window.dispatchEvent(new Event("ai-builder:projects-updated"));
      }}
    >
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="AI usage and cost"
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <InfoIcon className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        align="end"
        sideOffset={6}
        className="w-60 px-3 py-2.5 text-left"
      >
        <p className="font-medium">AI usage in this project</p>
        <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 tabular-nums">
          <dt className="font-medium">Total tokens</dt>
          <dd className="text-right font-medium">
            {(usage.inputTokens + usage.outputTokens).toLocaleString()}
          </dd>
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="opacity-70">{label}</dt>
              <dd className="text-right">{value}</dd>
            </div>
          ))}
          <dt className="font-medium">Cost</dt>
          <dd className="text-right font-medium">{formatCost(usage.cost)}</dd>
        </dl>
        <p className="mt-2 opacity-70">
          {usage.since
            ? `Chat and canvas combined, since ${new Date(usage.since).toLocaleDateString()}.`
            : "Nothing recorded yet — totals start with the next chat or canvas replace."}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

type PanelView = "preview" | "canvas" | "code";

/** Switches the right panel between live preview, Figma canvas, and code. */
function ViewToggle({
  view,
  onChange,
}: {
  view: PanelView;
  onChange: (view: PanelView) => void;
}) {
  const options: { id: PanelView; label: string; icon: React.ReactNode }[] = [
    {
      id: "preview",
      label: "Preview",
      icon: <MonitorIcon className="size-3" />,
    },
    { id: "canvas", label: "Canvas", icon: <FrameIcon className="size-3" /> },
    { id: "code", label: "Code", icon: <CodeIcon className="size-3" /> },
  ];

  return (
    <div
      className="inline-flex items-center rounded-md border p-0.5"
      role="group"
      aria-label="Panel view"
    >
      {options.map((option) => {
        const isActive = view === option.id;
        return (
          <button
            key={option.id}
            type="button"
            onClick={() => onChange(option.id)}
            aria-pressed={isActive}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-[5px] px-2.5 py-1 text-xs font-medium transition-colors",
              isActive
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.icon}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
