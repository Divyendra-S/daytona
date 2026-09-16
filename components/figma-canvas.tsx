"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2Icon, PencilIcon, WandSparklesIcon, XIcon } from "lucide-react";
import { hasPayload, UnsupportedPayload } from "@/lib/figma/figma-clipboard";
import { frameDocument, readPaste } from "@/lib/figma/figma-paste";
import { buildScene, type FrameData } from "@/lib/figma/paste-scene";

/**
 * Paste a Figma frame, then put it into the project in place of one of its sections.
 *
 * The pipeline is the one from the canvas app (`lib/figma/*`): Figma's ⌘C payload is decoded
 * and mapped to absolutely-positioned DOM. Replacing a section happens on the server — see
 * `app/api/projects/[projectId]/design/route.ts` — which converts the design to the project's
 * own framework and has the model rebuild the section from it. A Figma link lands as an embed
 * and ⌘⇧C as an image; neither carries a design to convert.
 */

type Frame = FrameData & {
  id: string;
  /** A Figma embed URL, from a link paste. */
  url?: string;
  /** An object URL, from an image paste. */
  image?: string;
  /** A captured page's own HTML document, from the snapshot extension's default capture. */
  document?: string;
};

type Section = { name: string; file: string };

type DesignInfo = {
  framework: { id: string; label: string };
  sections: Section[];
};

const DEFAULT_SIZE = { width: 900, height: 620 };

const unescapeAttr = (value: string) =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/**
 * A section captured with the Canvas Snapshot extension (`snapshot-extension`), which copies it
 * as `<x-canvas-snapshot>` HTML.
 *
 * Its ⌥-click box capture is the same absolutely-positioned shape the Figma mapper emits, so it
 * is a design like any other. Its default capture is the page's own document with its
 * stylesheets, rendered as it is. Only the desktop width is kept: the narrower variants reuse its
 * assets by token and mean nothing on their own. Found by string search, not DOMParser — the
 * wrapped document has its own doctype and `<html>`, which a parse would flatten.
 */
const snapshotOf = (html: string): Omit<Frame, "id"> | null => {
  const open = html.match(/<x-canvas-snapshot\b([^>]*)>/i);
  if (!open || open.index === undefined) return null;
  const attr = (name: string) => {
    const value = open[1].match(new RegExp(`\\b${name}="([^"]*)"`, "i"))?.[1];
    return value === undefined ? undefined : unescapeAttr(value);
  };
  const start = open.index + open[0].length;
  const ends = [
    html.indexOf("<x-canvas-variant", start),
    html.lastIndexOf("</x-canvas-snapshot>"),
  ].filter((index) => index > start);
  const body = html.slice(start, ends.length ? Math.min(...ends) : undefined);

  let host: string | null = null;
  try {
    host = new URL(attr("data-source") ?? "").hostname;
  } catch {}
  const frame = {
    title: attr("data-title") || "Captured section",
    size: {
      width: Number(attr("data-width")) || DEFAULT_SIZE.width,
      height: Number(attr("data-height")) || DEFAULT_SIZE.height,
    },
    note: host ? `Captured from ${host}` : "Captured section",
  };
  return attr("data-mode") === "document"
    ? { ...frame, document: body }
    : { ...frame, html: body };
};

const isEditable = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement);

export function FigmaCanvas({
  projectId,
  active,
  onReplaced,
}: {
  projectId: string;
  active: boolean;
  /** A section was rewritten; `anchor` is its element id, when it has one, to scroll the preview to. */
  onReplaced?: (anchor: string | null) => void;
}) {
  const [frames, setFrames] = useState<Frame[]>([]);
  const [hint, setHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<DesignInfo | null>(null);
  /** The chat agent is mid-turn; a prompt handed to it now would collide with that turn. */
  const [agentBusy, setAgentBusy] = useState(false);

  useEffect(() => {
    const onThreadState = (event: Event) => {
      const detail = (
        event as CustomEvent<{ projectId: string | null; isRunning: boolean }>
      ).detail;
      if (detail && (!detail.projectId || detail.projectId === projectId))
        setAgentBusy(Boolean(detail.isRunning));
    };
    window.addEventListener("ai-builder:thread-state", onThreadState);
    return () =>
      window.removeEventListener("ai-builder:thread-state", onThreadState);
  }, [projectId]);

  // Re-read on every visit: the agent may have added or renamed sections since.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    fetch(`/api/projects/${projectId}/design`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: DesignInfo | null) => {
        if (!cancelled && data) setInfo(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [active, projectId]);

  const add = useCallback((frame: Omit<Frame, "id">) => {
    setFrames((prev) => [
      { ...frame, id: `frame-${Date.now().toString(36)}` },
      ...prev,
    ]);
    setHint(null);
  }, []);

  const consume = useCallback(
    async (source: { html: string; text: string; image?: File }) => {
      setBusy(true);
      try {
        const snapshot = snapshotOf(source.html);
        if (snapshot) return add(snapshot);
        if (hasPayload(source.html)) {
          // ponytail: decoded on the main thread; move to a worker (canvas lib/paste.worker.ts) if big frames freeze the UI.
          const built = await buildScene(source.html);
          if (!built) return setHint("That paste decoded to no nodes.");
          return add(built.data);
        }
        if (source.image) {
          const bitmap = await createImageBitmap(source.image);
          const size = { width: bitmap.width, height: bitmap.height };
          bitmap.close();
          return add({
            title: source.image.name || "Pasted image",
            image: URL.createObjectURL(source.image),
            size,
          });
        }
        const pasted = readPaste(source);
        if (pasted.kind === "hint") return setHint(pasted.message);
        if (pasted.kind === "session")
          return setHint(
            "Plugin links are not supported here — copy the frame in Figma with ⌘C.",
          );
        add({
          title: pasted.title,
          url: pasted.url,
          note: pasted.note,
          size: DEFAULT_SIZE,
        });
      } catch (error) {
        console.error("[figma-canvas]", error);
        setHint(
          error instanceof UnsupportedPayload
            ? `This paste is not a format this build reads: ${error.message}`
            : `This Figma payload did not decode (${error instanceof Error ? error.message : String(error)}).`,
        );
      } finally {
        setBusy(false);
      }
    },
    [add],
  );

  useEffect(() => {
    if (!active) return;
    const onPaste = (event: ClipboardEvent) => {
      // A paste into the chat box is the chat box's.
      if (isEditable(event.target) || !event.clipboardData) return;
      const clipboard = event.clipboardData;
      event.preventDefault();
      void consume({
        html: clipboard.getData("text/html"),
        text: clipboard.getData("text/plain"),
        image: Array.from(clipboard.files).find((f) =>
          f.type.startsWith("image/"),
        ),
      });
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [active, consume]);

  const remove = (frame: Frame) => {
    if (frame.image) URL.revokeObjectURL(frame.image);
    setFrames((prev) => prev.filter((f) => f.id !== frame.id));
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-muted/30">
      {(busy || hint) && (
        <div className="flex shrink-0 items-center gap-2 border-b bg-background px-3 py-2 text-xs text-muted-foreground">
          {busy ? (
            <>
              <Loader2Icon className="size-3.5 animate-spin" />
              Pasting from Figma…
            </>
          ) : (
            <>
              <span className="flex-1">{hint}</span>
              <button
                type="button"
                onClick={() => setHint(null)}
                className="rounded p-0.5 hover:bg-muted"
                aria-label="Dismiss"
              >
                <XIcon className="size-3" />
              </button>
            </>
          )}
        </div>
      )}

      {frames.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
          <p className="text-sm font-medium">
            Paste a Figma frame or a captured section
          </p>
          <p className="max-w-sm text-xs text-muted-foreground">
            Select a frame in Figma and press ⌘C — or capture a section of any
            site with the Canvas Snapshot extension — then press ⌘V here. Pick
            the section it should replace, and it is converted
            {info ? ` to ${info.framework.label}` : ""} and built into your app.
          </p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {frames.map((frame) => (
            <FrameCard
              key={frame.id}
              frame={frame}
              projectId={projectId}
              info={info}
              onRemove={() => remove(frame)}
              onReplaced={onReplaced}
              agentBusy={agentBusy}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FrameCard({
  frame,
  projectId,
  info,
  onRemove,
  onReplaced,
  agentBusy,
}: {
  frame: Frame;
  projectId: string;
  info: DesignInfo | null;
  onRemove: () => void;
  onReplaced?: (anchor: string | null) => void;
  agentBusy: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [picked, setPicked] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [status, setStatus] = useState<{
    text: string;
    tone: "info" | "ok" | "error";
  } | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(entry.contentRect.width),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /** The pen's prompt popover, for a design with no section to replace. */
  const [promptOpen, setPromptOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const promptBox = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!promptOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!promptBox.current?.contains(event.target as Node))
        setPromptOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPromptOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [promptOpen]);

  const natural = frame.size ?? DEFAULT_SIZE;
  // Shrink to fit the column, never enlarge: the design is measured in its own pixels.
  const scale = width ? Math.min(1, width / natural.width) : 1;
  const srcDoc = useMemo(
    () =>
      frame.document ??
      (frame.html
        ? frameDocument(frame.html, frame.fonts, frame.size)
        : undefined),
    [frame.document, frame.html, frame.fonts, frame.size],
  );
  /** Something the routes can turn into code: a Figma scene or box capture, or a captured document. */
  const hasDesign = Boolean(frame.html || frame.document);

  const sections = info?.sections ?? [];
  const section =
    sections.find((s) => s.name === picked) ?? sections[0] ?? null;

  const replace = async () => {
    if (!section || !hasDesign) return;
    setReplacing(true);
    setStatus({
      text: `Converting to ${info?.framework.label} and rebuilding ${section.name} — this can take a minute or two…`,
      tone: "info",
    });
    try {
      const response = await fetch(`/api/projects/${projectId}/design`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: section.name,
          file: section.file,
          design: {
            title: frame.title,
            html: frame.html,
            document: frame.document,
            fonts: frame.fonts,
            size: frame.size,
          },
        }),
      });
      const data = (await response.json().catch(() => null)) as {
        error?: string;
        anchor?: string | null;
        missingImages?: number;
        imageError?: string | null;
      } | null;
      if (!response.ok) {
        setStatus({
          text: data?.error ?? `Failed (${response.status})`,
          tone: "error",
        });
        return;
      }
      const missing = data?.missingImages ?? 0;
      setStatus({
        text: `${section.name} replaced in ${section.file}.${
          missing
            ? ` ${missing} image${missing === 1 ? "" : "s"} ${missing === 1 ? "is a placeholder" : "are placeholders"}: ${(data?.imageError ?? "the pixels could not be fetched from Figma").replace(/\.$/, "")}. Fix that and replace again to bring them in.`
            : ""
        }`,
        tone: missing ? "error" : "ok",
      });
      onReplaced?.(data?.anchor ?? null);
    } catch (error) {
      setStatus({
        text: error instanceof Error ? error.message : "Replace failed",
        tone: "error",
      });
    } finally {
      setReplacing(false);
    }
  };

  /**
   * No section to replace: export the design into the project and hand it, with the user's
   * prompt, to the chat agent — which can read files, write them and check the app, so the
   * prompt can ask for anything (a new section, a new page, a restyle).
   */
  const runPrompt = async () => {
    const text = prompt.trim();
    if (!text || !hasDesign || agentBusy) return;
    setPromptOpen(false);
    setReplacing(true);
    setStatus({
      text: `Converting to ${info?.framework.label} and handing the design to the chat agent…`,
      tone: "info",
    });
    try {
      const response = await fetch(`/api/projects/${projectId}/design`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "export",
          design: {
            title: frame.title,
            html: frame.html,
            document: frame.document,
            fonts: frame.fonts,
            size: frame.size,
          },
        }),
      });
      const data = (await response.json().catch(() => null)) as {
        error?: string;
        file?: string;
        kind?: "figma" | "capture";
        framework?: string;
        missingImages?: number;
        imageError?: string | null;
        missingMarker?: string;
      } | null;
      if (!response.ok || !data?.file) {
        setStatus({
          text: data?.error ?? `Failed (${response.status})`,
          tone: "error",
        });
        return;
      }

      const missing = data.missingImages ?? 0;
      const size = frame.size
        ? `${Math.round(frame.size.width)}×${Math.round(frame.size.height)}`
        : "its original size";
      window.dispatchEvent(
        new CustomEvent("ai-builder:send-message", {
          detail: {
            projectId,
            text: [
              data.kind === "capture"
                ? `I captured a section ("${frame.title}") from a live website and pasted it into the canvas. Its HTML document, with the page's own styles, is in \`${data.file}\`; its images and fonts are saved under public/captures/.`
                : `I pasted a Figma design ("${frame.title}") into the canvas. Its code is in \`${data.file}\` — a ${data.framework} export made of absolutely positioned boxes at ${size}; its images are saved under public/figma/.`,
              "Use that file as the exact visual reference (text, colours, fonts, spacing, images, SVG artwork), but write clean, responsive code that fits this project, and do not import the export file itself.",
              missing
                ? `\`${data.missingMarker}\` marks ${missing} image${missing === 1 ? "" : "s"} whose pixels could not be fetched — draw a neutral placeholder there.`
                : "",
              "",
              text,
            ]
              .filter((line, index) => line || index > 2)
              .join("\n"),
          },
        }),
      );
      setPrompt("");
      setStatus({
        text: `Sent to the chat — the agent is working from ${data.file}.${
          missing
            ? ` ${missing} image${missing === 1 ? " is a placeholder" : "s are placeholders"}: ${(data.imageError ?? "the pixels could not be fetched from Figma").replace(/\.$/, "")}.`
            : ""
        }`,
        tone: missing ? "error" : "ok",
      });
    } catch (error) {
      setStatus({
        text:
          error instanceof Error ? error.message : "Could not send the design",
        tone: "error",
      });
    } finally {
      setReplacing(false);
    }
  };

  return (
    <div className="overflow-hidden rounded-lg border bg-background">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{frame.title}</p>
          {frame.note && (
            <p
              className="truncate text-xs text-muted-foreground"
              title={frame.note}
            >
              {frame.note}
            </p>
          )}
        </div>
        {hasDesign && sections.length > 0 && section && (
          <>
            <select
              value={section.name}
              onChange={(e) => {
                setPicked(e.target.value);
                setStatus(null);
              }}
              disabled={replacing}
              className="h-7 rounded-md border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
              aria-label="Section to replace"
            >
              {sections.map((s) => (
                <option key={s.name} value={s.name} title={s.file}>
                  {s.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={replace}
              disabled={replacing}
              className="inline-flex h-7 items-center gap-1.5 rounded-md bg-foreground px-2.5 text-xs font-medium text-background transition-colors hover:bg-foreground/90 disabled:opacity-60"
            >
              {replacing ? (
                <Loader2Icon className="size-3 animate-spin" />
              ) : (
                <WandSparklesIcon className="size-3" />
              )}
              Replace section
            </button>
          </>
        )}
        {hasDesign && info && sections.length === 0 && (
          <div ref={promptBox} className="relative">
            <button
              type="button"
              onClick={() => setPromptOpen((open) => !open)}
              disabled={replacing || agentBusy}
              aria-label="Tell the AI what to do with this design"
              aria-expanded={promptOpen}
              title={
                agentBusy
                  ? "The chat agent is busy — wait for it to finish"
                  : "Use this design with a prompt"
              }
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              {replacing ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                <PencilIcon className="size-3.5" />
              )}
            </button>
            {promptOpen && (
              <div className="absolute top-full right-0 z-20 mt-2 w-80 rounded-lg border bg-background p-2 shadow-lg">
                <textarea
                  autoFocus
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      (event.metaKey || event.ctrlKey)
                    ) {
                      event.preventDefault();
                      void runPrompt();
                    }
                  }}
                  rows={4}
                  placeholder="What should the AI do with this design? e.g. Add it as a pricing section below the hero"
                  aria-label="Prompt for this design"
                  className="w-full resize-none rounded-md border bg-background px-2.5 py-2 text-xs outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
                />
                <div className="mt-2 flex items-center justify-between">
                  <span className="text-[11px] text-muted-foreground">
                    ⌘↵ to send
                  </span>
                  <button
                    type="button"
                    onClick={runPrompt}
                    disabled={!prompt.trim()}
                    className="inline-flex h-7 items-center gap-1.5 rounded-md bg-foreground px-2.5 text-xs font-medium text-background transition-colors hover:bg-foreground/90 disabled:opacity-50"
                  >
                    <WandSparklesIcon className="size-3" />
                    Send
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
        <button
          type="button"
          onClick={onRemove}
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title="Remove frame"
        >
          <XIcon className="size-3.5" />
        </button>
      </div>

      {status && (
        <div
          role="status"
          className={`flex items-start gap-2 border-b px-3 py-2 text-xs ${
            status.tone === "error"
              ? "bg-destructive/10 text-destructive"
              : status.tone === "ok"
                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "bg-muted/50 text-muted-foreground"
          }`}
        >
          {replacing && (
            <Loader2Icon className="mt-px size-3.5 shrink-0 animate-spin" />
          )}
          <span>{status.text}</span>
        </div>
      )}

      <div
        ref={box}
        className="relative overflow-hidden bg-white"
        style={{ height: natural.height * scale }}
      >
        {frame.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={frame.image}
            alt={frame.title}
            className="h-full w-full object-contain"
          />
        ) : (
          <iframe
            title={frame.title}
            srcDoc={srcDoc}
            src={frame.url}
            className="absolute top-0 left-0 border-0"
            style={{
              width: natural.width,
              height: natural.height,
              transform: `scale(${scale})`,
              transformOrigin: "0 0",
            }}
          />
        )}
      </div>
    </div>
  );
}
