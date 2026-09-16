/* Beautiful UI — Tool Chips. https://www.beautifului.dev
 * MIT License, Copyright (c) 2026 Shane Levine.
 *
 * Adapted for Adorable, where components/assistant-ui/tool-calls.tsx feeds it real tool
 * calls: no demo data or timed reveal (rows arrive as the agent calls tools), rows keyed
 * by position since labels repeat, `running` / `failed` steps, thought rows, more glyphs,
 * a `del` detail tone, the chat column's width, and the diff row only when files were
 * edited. A whole agent run is one block: open while `working`, folded once done, and
 * only its latest `limit` rows until "show earlier" is pressed. */
"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { Shimmer } from "@/components/atoms/Shimmer";

/* ─────────────────────────────────────────────────────────
 * TOOL CHIPS
 * An agent run as compact rows: tool calls with inline
 * chips, then file-diff chips summarizing the edits.
 * Hover a row to reveal its chevron; every row expands
 * to show what the tool actually did.
 * ───────────────────────────────────────────────────────── */

const stroked = (glyph: React.ReactNode) => (
  <g
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {glyph}
  </g>
);

const Icons: Record<string, React.ReactNode> = {
  think: <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />,
  write: stroked(<path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />),
  run: stroked(<path d="M4 17l6-5-6-5M12 19h8" />),
  read: stroked(
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </>,
  ),
  search: stroked(
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </>,
  ),
  folder: stroked(
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  ),
  move: stroked(<path d="M5 12h14M13 6l6 6-6 6" />),
  delete: stroked(<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />),
  commit: stroked(
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M3 12h6M15 12h6" />
    </>,
  ),
  check: stroked(<path d="M22 12h-4l-3 9L9 3l-3 9H2" />),
  tool: stroked(
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z" />,
  ),
};

export type ToolDetailLine = { text: string; tone?: "add" | "del" };

export type ToolStep = {
  icon: string;
  label: string;
  chip: string;
  mono: boolean;
  detailMono: boolean;
  detail: ToolDetailLine[];
  status?: "running" | "failed";
  /** the model's reasoning between calls: one dimmed line, its full text as the detail */
  thought?: boolean;
};

export type ToolDiff = { file: string; add: number; del: number };

export type ToolDiffLine = { text: string; tone: "add" | "del" | "ctx" };

export type ToolChipsLabels = {
  header: string;
  /** the step in progress, dimmed beside a working header */
  current?: string;
};

export default function ToolChips({
  steps,
  diffs = [],
  diffLines = {},
  labels,
  working = false,
  limit = 8,
}: {
  steps: ToolStep[];
  diffs?: ToolDiff[];
  diffLines?: Record<string, ToolDiffLine[]>;
  labels: ToolChipsLabels;
  /** the run is in progress: header shimmers, rows stay open until it finishes */
  working?: boolean;
  /** rows shown before "show earlier", newest kept */
  limit?: number;
}) {
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const open = manualOpen ?? working;
  const [showAll, setShowAll] = useState(false);
  const hidden = showAll ? 0 : Math.max(0, steps.length - limit);
  const [openRows, setOpenRows] = useState<Set<number>>(new Set());
  /* Rendered in a body portal so animated/translated reply wrappers cannot
   * redefine the fixed-position coordinate system. */
  const [preview, setPreview] = useState<{
    file: string;
    x: number;
    top?: number;
    bottom?: number;
  } | null>(null);
  const openPreview = (file: string) => (event: React.SyntheticEvent) => {
    const rect = (event.currentTarget as Element)
      .closest("[data-diffchip]")!
      .getBoundingClientRect();
    const previewHeight = 38 + (diffLines[file]?.length ?? 0) * 19;
    const fitsBelow =
      rect.bottom + 6 + previewHeight <= window.innerHeight - 12;
    setPreview({
      file,
      x: Math.max(12, Math.min(rect.left, window.innerWidth - 300)),
      ...(fitsBelow
        ? { top: rect.bottom + 6 }
        : { bottom: window.innerHeight - rect.top + 6 }),
    });
  };
  const closePreview = (file: string) => () =>
    setPreview((current) => (current?.file === file ? null : current));

  const toggleRow = (index: number) =>
    setOpenRows((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  return (
    <div className="w-full max-w-lg pb-1">
      {/* collapsed run header */}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setManualOpen(!open)}
        className="-mx-1.5 flex w-fit max-w-full min-w-0 items-center gap-1.5 rounded-control px-1.5 py-1 text-[12.5px] text-ink-2 transition-colors duration-100 hover:bg-hover-2"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="transition-transform duration-200"
          style={{ transform: open ? "rotate(0deg)" : "rotate(-90deg)" }}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
        <span className="shrink-0 tabular-nums" role="status">
          {working ? <Shimmer>{labels.header}</Shimmer> : labels.header}
        </span>
        {working && labels.current && (
          <span className="min-w-0 truncate text-ink-3">{labels.current}</span>
        )}
      </button>

      {/* tool call rows */}
      <div
        className="grid transition-[grid-template-rows,opacity] duration-300"
        style={{
          gridTemplateRows: open ? "1fr" : "0fr",
          opacity: open ? 1 : 0,
        }}
      >
        {/* -mx-1 + px-1.5 keeps content at the same x while giving the
            row hover pills room inside this overflow-hidden clip box */}
        <div className="-mx-1 overflow-hidden px-1.5 pb-1">
          <div className="mt-1.5 flex flex-col gap-1">
            {hidden > 0 && (
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className="-mx-[3px] flex h-7 items-center gap-2 rounded-control px-[3px] text-left text-[12px] text-ink-3 transition-colors duration-100 hover:bg-hover-2 hover:text-ink"
              >
                <span className="flex size-4 items-center justify-center">
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M18 15l-6-6-6 6" />
                  </svg>
                </span>
                Show {hidden} earlier step{hidden === 1 ? "" : "s"}
              </button>
            )}
            {steps.slice(hidden).map((row, offset) => {
              const index = hidden + offset;
              const rowOpen = openRows.has(index);
              const glyphClass = `transition-opacity duration-100 group-hover/row:opacity-0 ${rowOpen ? "opacity-0" : ""}`;
              return (
                <div
                  key={index}
                  style={{
                    animation: "fade-up 300ms cubic-bezier(0.23,1,0.32,1) both",
                  }}
                >
                  <button
                    type="button"
                    aria-expanded={rowOpen}
                    onClick={() => toggleRow(index)}
                    className="group/row -mx-[3px] flex h-7 w-[calc(100%+6px)] min-w-0 items-center gap-2 rounded-control px-[3px] text-left transition-colors duration-100 hover:bg-hover-2"
                  >
                    <span className="relative flex size-4 shrink-0 items-center justify-center text-ink-3">
                      {row.status === "running" ? (
                        <span
                          aria-hidden
                          className={`size-3 rounded-full border-[1.5px] border-line-strong border-t-ink-2 ${glyphClass}`}
                          style={{ animation: "spin 700ms linear infinite" }}
                        />
                      ) : (
                        <svg
                          width="13"
                          height="13"
                          viewBox="0 0 24 24"
                          fill={row.icon === "think" ? "currentColor" : "none"}
                          stroke="currentColor"
                          className={glyphClass}
                        >
                          {Icons[row.icon] ?? Icons.tool}
                        </svg>
                      )}
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className={`absolute transition-[opacity,transform] duration-150 group-hover/row:opacity-100 ${rowOpen ? "opacity-100" : "opacity-0"}`}
                        style={{
                          transform: rowOpen
                            ? "rotate(0deg)"
                            : "rotate(-90deg)",
                        }}
                      >
                        <path d="M6 9l6 6 6-6" />
                      </svg>
                    </span>
                    <span
                      className={`text-[12.5px] ${row.thought ? "min-w-0 flex-1 truncate text-ink-3" : `shrink-0 font-medium ${row.status === "failed" ? "text-red" : "text-ink"}`}`}
                    >
                      {row.status === "running" ? (
                        <Shimmer>{row.label}</Shimmer>
                      ) : (
                        row.label
                      )}
                    </span>
                    {row.chip && (
                      <span
                        className={`inline-flex h-5.5 min-w-0 flex-1 cursor-pointer items-center truncate rounded-chip bg-field px-1.5 text-[11.5px] text-ink-2 shadow-hairline transition-colors duration-100 hover:bg-hover-2 ${row.mono ? "font-mono" : ""}`}
                      >
                        {row.chip}
                      </span>
                    )}
                  </button>

                  {/* expanded detail */}
                  <div
                    className="grid transition-[grid-template-rows,opacity] duration-300"
                    style={{
                      gridTemplateRows: rowOpen ? "1fr" : "0fr",
                      opacity: rowOpen ? 1 : 0,
                      transitionTimingFunction:
                        "cubic-bezier(0.23, 1, 0.32, 1)",
                    }}
                  >
                    <div className="min-h-0 overflow-hidden">
                      <div className="mt-0.5 mb-1 ml-2 flex flex-col gap-0.5 border-l border-line py-0.5 pl-3.5">
                        {row.detail.map((line, lineIndex) => (
                          <span
                            key={lineIndex}
                            className={`${row.thought ? "whitespace-pre-wrap" : "truncate"} text-[11.5px] leading-[1.6] ${row.detailMono ? "font-mono" : ""} ${line.tone === "add" ? "text-green" : line.tone === "del" ? "text-red" : "text-ink-2"}`}
                          >
                            {line.text}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* file-diff chips */}
          {diffs.length > 0 && (
            <div className="mt-2.5 flex max-w-full flex-wrap gap-1.5 border-t border-line pt-2.5">
              {diffs.map((d, i) => (
                <span
                  key={d.file}
                  data-diffchip
                  className="relative max-w-full"
                  onMouseEnter={openPreview(d.file)}
                  onMouseLeave={closePreview(d.file)}
                >
                  <button
                    type="button"
                    aria-expanded={preview?.file === d.file}
                    aria-label={`Show diff for ${d.file}`}
                    onFocus={openPreview(d.file)}
                    onBlur={closePreview(d.file)}
                    className="inline-flex h-7 max-w-full items-center gap-2 rounded-chip bg-surface px-2 font-mono text-[11.5px] text-ink shadow-btn transition-colors duration-100 hover:bg-hover"
                    style={{
                      animation: `pop-in 250ms cubic-bezier(0.23,1,0.32,1) ${i * 80}ms both`,
                    }}
                  >
                    <span className="min-w-0 truncate">{d.file}</span>
                    <span className="shrink-0 text-green tabular-nums">
                      +{d.add}
                    </span>
                    {d.del > 0 && (
                      <span className="shrink-0 text-red tabular-nums">
                        −{d.del}
                      </span>
                    )}
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
      {preview &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="fixed z-50 w-72 overflow-hidden rounded-[10px] bg-surface shadow-overlay"
            style={{
              left: preview.x,
              top: preview.top,
              bottom: preview.bottom,
              animation: "pop-in 160ms cubic-bezier(0.23,1,0.32,1) both",
              transformOrigin:
                preview.top === undefined ? "bottom left" : "top left",
            }}
          >
            <div className="flex items-center justify-between border-b border-line px-2.5 py-1.5 font-mono text-[11px]">
              <span className="min-w-0 truncate text-ink-2">
                {preview.file}
              </span>
              <span className="shrink-0 tabular-nums">
                <span className="text-green">
                  +{diffs.find((diff) => diff.file === preview.file)?.add}
                </span>
                {(diffs.find((diff) => diff.file === preview.file)?.del ?? 0) >
                  0 && (
                  <span className="text-red">
                    {" "}
                    −{diffs.find((diff) => diff.file === preview.file)?.del}
                  </span>
                )}
              </span>
            </div>
            <div className="py-1 font-mono text-[11px] leading-[1.8]">
              {(diffLines[preview.file] ?? []).map((line, index) => (
                <div
                  key={index}
                  className={`flex gap-2 px-2.5 whitespace-pre ${
                    line.tone === "add"
                      ? "bg-green-tint text-green"
                      : line.tone === "del"
                        ? "bg-red-tint text-red"
                        : "text-ink-2"
                  }`}
                >
                  <span className="w-3 shrink-0 select-none">
                    {line.tone === "add"
                      ? "+"
                      : line.tone === "del"
                        ? "−"
                        : " "}
                  </span>
                  <span className="min-w-0 truncate">{line.text}</span>
                </div>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
