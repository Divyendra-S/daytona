"use client";

import { useEffect, useState } from "react";
import { Loader2Icon, SparklesIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * Whole-design actions for the chat agent: redesign the project from a live URL, critique the
 * current design into DESIGN.md, or polish a patchwork of sections into one design.
 *
 * All go through the chat agent, because all need what it already has — reading the project,
 * writing files, checking the app — and the user watches it work in the thread. The routes only
 * prepare what the agent reads: the fetched page, or the rules it scores against.
 */

type Mode = "redesign" | "critique" | "polish";

type Section = { name: string; file: string };

export const sendToAgent = (projectId: string, text: string) =>
  window.dispatchEvent(
    new CustomEvent("ai-builder:send-message", {
      detail: { projectId, text },
    }),
  );

/** Whether the project's chat agent is mid-turn; a message sent now would collide with it. */
export function useAgentBusy(projectId: string) {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const onThreadState = (event: Event) => {
      const detail = (
        event as CustomEvent<{ projectId: string | null; isRunning: boolean }>
      ).detail;
      if (detail && (!detail.projectId || detail.projectId === projectId))
        setBusy(Boolean(detail.isRunning));
    };
    window.addEventListener("ai-builder:thread-state", onThreadState);
    return () =>
      window.removeEventListener("ai-builder:thread-state", onThreadState);
  }, [projectId]);
  return busy;
}

const redesignBrief = (
  file: string,
  url: string,
  title: string | null,
  notes: string,
) =>
  [
    `Redesign this project from the website at ${url}${title ? ` ("${title}")` : ""}. Its page HTML, with scripts and styles stripped, is saved at \`${file}\`.`,
    "- Keep the page's content, information architecture and section order, but give it a fresh, modern visual design: clear hierarchy, a consistent type scale and spacing, a restrained palette, and fully responsive layouts.",
    "- Reuse the text. Don't copy logos or brand imagery — use neutral placeholders unless I say the site is mine.",
    "- Build it in this project's stack as the home page, keep everything else working, and check the app before you finish.",
    notes ? `\nDirection: ${notes}` : "",
  ]
    .filter(Boolean)
    .join("\n");

const critiqueBrief = (rulesFile: string) =>
  [
    `Critique the current design of this app against the rules in \`${rulesFile}\`. Read that file first, then the pages, components and global styles.`,
    "1. Write `DESIGN.md` at the project root: the design rules this design actually follows — colour tokens, typography, spacing and layout, radii/borders/shadows, components, motion, imagery, accessibility — with real values taken from the code, plus a short do/don't list.",
    "2. Add a **Critique** section to DESIGN.md: score each rule category 1–5 and list the most important issues with file paths.",
    "Do not change any code other than DESIGN.md.",
  ].join("\n");

/**
 * Sections pasted in from Figma, captures and redesigns each bring their own look. Polish picks
 * one of them as the reference, writes its design language down as DESIGN.md, and brings every
 * other section in line with it — styling only, one section at a time.
 */
const polishBrief = (
  rulesFile: string,
  reference: Section | string,
  others: Section[],
) => {
  const named = typeof reference !== "string";
  return [
    "Unify this site's design. Its sections came from different sources and each has its own look; make the whole site one consistent design.",
    named
      ? `Follow the design of the \`${reference.name}\` section (\`${reference.file}\`).`
      : `Follow the design of this part of the page: ${reference}`,
    "",
    `1. Read the reference and extract its design language: colour palette and how colour is used, typography (families, sizes, weights, line heights), spacing scale and section padding, container width, radii, borders, shadows, buttons and links, cards, icons, imagery treatment, and motion.`,
    "2. Write `DESIGN.md` at the project root with those rules, using the real values from the reference.",
    others.length
      ? `3. Restyle every other section to follow DESIGN.md, one at a time in page order: ${others.map((section) => `\`${section.name}\` (\`${section.file}\`)`).join(", ")}.`
      : "3. Restyle every other part of the page to follow DESIGN.md, one section at a time from top to bottom.",
    `   Change styling only — keep each section's content, structure and behaviour. Leave the reference ${named ? "section" : "part"} as it is.`,
    `4. Where the reference has no rule for something, stay consistent with it, and keep the basics from \`${rulesFile}\`: contrast, focus states, tap targets and responsive layout.`,
    "5. Check the app when you are done.",
  ].join("\n");
};

const TABS: [Mode, string][] = [
  ["redesign", "Redesign from URL"],
  ["critique", "Critique"],
  ["polish", "Polish"],
];

const RUN_LABEL: Record<Mode, string> = {
  redesign: "Redesign",
  critique: "Critique",
  polish: "Polish",
};

export function DesignActions({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("redesign");
  const [url, setUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const agentBusy = useAgentBusy(projectId);

  // The composer's /redesign, /critique and /polish open the dialog on their tab.
  useEffect(() => {
    const onOpen = (event: Event) => {
      const next = (event as CustomEvent<{ mode?: Mode }>).detail?.mode;
      if (next && next in RUN_LABEL) setMode(next);
      setError(null);
      setOpen(true);
    };
    window.addEventListener("ai-builder:open-design", onOpen);
    return () => window.removeEventListener("ai-builder:open-design", onOpen);
  }, []);

  /** Polish: the page's sections, and which one's design the rest should follow. */
  const [sections, setSections] = useState<Section[] | null>(null);
  const [reference, setReference] = useState<string | null>(null);
  const [referenceText, setReferenceText] = useState("");

  // Read fresh each time the tab opens: the agent may have added or renamed sections since.
  useEffect(() => {
    if (!open || mode !== "polish") return;
    let cancelled = false;
    setSections(null);
    fetch(`/api/projects/${projectId}/design`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : { sections: [] }))
      .then((data: { sections?: Section[] }) => {
        if (cancelled) return;
        const list = data.sections ?? [];
        setSections(list);
        setReference((current) =>
          list.some((section) => section.file === current) ? current : null,
        );
      })
      .catch(() => {
        if (!cancelled) setSections([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, mode, projectId]);

  const post = async <T,>(route: string, body: unknown): Promise<T> => {
    const response = await fetch(`/api/projects/${projectId}/${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await response.json().catch(() => null)) as
      | (T & { error?: string })
      | null;
    if (!response.ok || !data)
      throw new Error(data?.error ?? `Failed (${response.status})`);
    return data;
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      if (mode === "redesign") {
        const input = url.trim();
        const data = await post<{
          file: string;
          url: string;
          title: string | null;
        }>("redesign", {
          url: /^https?:\/\//i.test(input) ? input : `https://${input}`,
        });
        sendToAgent(
          projectId,
          redesignBrief(data.file, data.url, data.title, notes.trim()),
        );
      } else {
        // Both need the rules file: critique scores against it, polish keeps its basics.
        const { rulesFile } = await post<{ rulesFile: string }>("critique", {});
        if (mode === "critique") {
          sendToAgent(projectId, critiqueBrief(rulesFile));
        } else {
          const picked = sections?.find(
            (section) => section.file === reference,
          );
          sendToAgent(
            projectId,
            polishBrief(
              rulesFile,
              picked ?? referenceText.trim(),
              (sections ?? []).filter((section) => section !== picked),
            ),
          );
        }
      }
      setOpen(false);
      setUrl("");
      setNotes("");
      setReferenceText("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const ready =
    mode === "redesign"
      ? Boolean(url.trim())
      : mode === "polish"
        ? sections?.length
          ? Boolean(reference)
          : Boolean(referenceText.trim())
        : true;
  const canRun = !busy && !agentBusy && ready;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setError(null);
      }}
    >
      <DialogTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
          title="Redesign from a URL, critique the design, or polish it into one"
        >
          <SparklesIcon className="size-3" />
          Design
        </button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Design</DialogTitle>
          <DialogDescription>
            The chat agent does the work — you can follow it in the thread.
          </DialogDescription>
        </DialogHeader>

        <div className="flex rounded-md border p-0.5">
          {TABS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => {
                setMode(id);
                setError(null);
              }}
              className={cn(
                "flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors",
                mode === id
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {mode === "redesign" && (
          <div className="space-y-3">
            <Input
              autoFocus
              value={url}
              onChange={(event) => {
                setUrl(event.target.value);
                setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && canRun) {
                  event.preventDefault();
                  void run();
                }
              }}
              placeholder="https://example.com"
              aria-label="Website URL"
            />
            <textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              rows={3}
              placeholder="Direction (optional) — e.g. darker, editorial, more whitespace"
              aria-label="Redesign direction"
              className="w-full resize-none rounded-md border bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
            />
          </div>
        )}

        {mode === "critique" && (
          <p className="text-sm text-muted-foreground">
            Reviews the app against built-in design rules, scores each area and
            lists the issues, and writes{" "}
            <code className="text-foreground">DESIGN.md</code> with the
            design&apos;s rules — colours, type, spacing, components, motion. It
            changes no code.
          </p>
        )}

        {mode === "polish" && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Brings every section into one design. Pick the section whose
              design the rest should follow — its look is written to{" "}
              <code className="text-foreground">DESIGN.md</code> and the other
              sections are restyled to match. Content stays as it is.
            </p>
            {sections === null ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2Icon className="size-3.5 animate-spin" />
                Finding the page&apos;s sections…
              </p>
            ) : sections.length ? (
              <fieldset className="max-h-56 space-y-1 overflow-y-auto">
                <legend className="mb-1.5 text-xs font-medium text-foreground">
                  Follow the design of
                </legend>
                {sections.map((section) => (
                  <label
                    key={section.file}
                    className={cn(
                      "flex cursor-pointer items-center gap-2.5 rounded-md border px-3 py-2 text-sm transition-colors",
                      reference === section.file
                        ? "border-ring bg-muted"
                        : "hover:bg-muted/60",
                    )}
                  >
                    <input
                      type="radio"
                      name="polish-reference"
                      checked={reference === section.file}
                      onChange={() => setReference(section.file)}
                    />
                    <span className="font-medium text-foreground">
                      {section.name}
                    </span>
                    <span className="ml-auto truncate font-mono text-[11px] text-muted-foreground">
                      {section.file}
                    </span>
                  </label>
                ))}
              </fieldset>
            ) : (
              <div className="space-y-1.5">
                <p className="text-xs text-muted-foreground">
                  No separate section components were found on the home page.
                  Describe the part whose design everything should follow.
                </p>
                <textarea
                  value={referenceText}
                  onChange={(event) => setReferenceText(event.target.value)}
                  rows={2}
                  placeholder="e.g. the hero at the top, with the dark panel and yellow buttons"
                  aria-label="Part of the page to follow"
                  className="w-full resize-none rounded-md border bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
                />
              </div>
            )}
          </div>
        )}

        {error && <p className="text-[13px] text-destructive">{error}</p>}
        {agentBusy && (
          <p className="text-[13px] text-muted-foreground">
            The chat agent is busy — wait for it to finish.
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={run} disabled={!canRun}>
            {busy && <Loader2Icon className="size-3.5 animate-spin" />}
            {RUN_LABEL[mode]}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
