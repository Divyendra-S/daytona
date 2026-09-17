"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { GripVerticalIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { sendToAgent, useAgentBusy } from "@/components/design-actions";
import { editsBrief, type PickedElement } from "@/lib/edit-queue";
import {
  cssOverrides,
  describeChanges,
  type StyleChange,
  type StyleProp,
} from "@/lib/style-edit";
import { FONT_FAMILIES, fontHref } from "@/lib/style-fonts";

/**
 * The properties of a picked element, changed by hand — no agent.
 *
 * A change shows at once as an inline override inside the preview (`style` to the bridge), then
 * is saved: `POST /api/projects/:id/style` rewrites the element's Tailwind classes in the source,
 * and hot reload brings them back as the real thing. Sliders preview while they move and save on
 * release, saves go one at a time with whatever piled up meanwhile merged per property, and the
 * overrides come off once the new classes have arrived and nothing is left to save.
 *
 * When the source cannot be pinned down the panel says why and offers to hand the exact values to
 * the agent; that is the user's call, never automatic. While the agent is working the panel is
 * off: both would be writing the same file.
 */

/** The shell re-dispatches the bridge's `class-changed` as this window event. */
export const CLASS_CHANGED_EVENT = "ai-builder:preview-class-changed";

const GAP = 8;
/** Between the change box and the panel under it. */
const PANEL_GAP = 12;
const MAX_HEIGHT = 440;
/** Less room than this under the change box, and the panel opens above it instead. */
const MIN_HEIGHT = 200;

const REFUSALS: Record<string, string> = {
  "not-found": "Couldn't find this element's classes in the source.",
  ambiguous: "Several places in the source match this element.",
  "shared-component":
    "These styles come from a shared component; changing them would restyle every use of it.",
  "no-class": "This element has no classes in the source to edit.",
  dynamic: "This element's classes are built in code.",
  stale: "The source changed underneath. Try again.",
};

type Kind = { text: boolean; box: boolean; media: boolean };

const TEXT_TAGS =
  /^(h[1-6]|p|span|a|button|label|li|strong|em|b|i|small|blockquote|figcaption|td|th|dt|dd|code)$/;
const MEDIA_TAGS = /^(img|video|svg|picture|canvas|iframe)$/;

const kindOf = (element: PickedElement): Kind => {
  const media = MEDIA_TAGS.test(element.tag);
  const text = !media && (TEXT_TAGS.test(element.tag) || !!element.textOnly);
  const box = !media && (!text || /^(a|button|li|td|th)$/.test(element.tag));
  return { text, box, media };
};

/** Any CSS colour as `#rrggbb`, by painting it: computed colours may be `oklch(…)` or `lab(…)`. */
const toHex = (() => {
  let context: CanvasRenderingContext2D | null | undefined;
  return (color: string | undefined): string | null => {
    if (!color) return null;
    if (context === undefined) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      context = canvas.getContext("2d", { willReadFrequently: true });
    }
    if (!context) return null;
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = "#000";
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
    if (a === 0) return null;
    return `#${[r, g, b].map((part) => part.toString(16).padStart(2, "0")).join("")}`;
  };
})();

const px = (value: string | undefined) => {
  const number = parseFloat(value ?? "");
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : 0;
};

/** `__Geist_a1b2c3, "Geist Fallback"` → `Geist`: next/font hashes the family it serves. */
const familyOf = (value: string | undefined) =>
  (value ?? "")
    .split(",")[0]
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/^_+/, "")
    .replace(/_[0-9a-f]{6}$/i, "")
    .replace(/_/g, " ");

const SHADOW_MARKS: [string, string][] = [
  ["0px 25px 50px -12px", "2xl"],
  ["0px 20px 25px -5px", "xl"],
  ["0px 10px 15px -3px", "lg"],
  ["0px 4px 6px -1px", "md"],
];

/** What the controls show, read from the computed styles the bridge sent. */
const readValues = (
  styles: Record<string, string>,
): Partial<Record<StyleProp, string>> => {
  const size = px(styles["font-size"]) || 16;
  const leading = styles["line-height"];
  const radius = styles["border-top-left-radius"] ?? "";
  const shadow = styles["box-shadow"] ?? "none";
  return {
    fontFamily: familyOf(styles["font-family"]),
    fontSize: `${size}px`,
    fontWeight: String(
      Math.round(px(styles["font-weight"]) / 100) * 100 || 400,
    ),
    color: toHex(styles.color) ?? "",
    textAlign:
      { start: "left", end: "right" }[styles["text-align"]] ??
      styles["text-align"],
    lineHeight:
      leading === "normal" || !leading
        ? "1.5"
        : String(Math.round((px(leading) / size) * 100) / 100),
    letterSpacing: `${Math.round((px(styles["letter-spacing"]) / size) * 1000) / 1000}em`,
    paddingX: `${px(styles["padding-left"])}px`,
    paddingY: `${px(styles["padding-top"])}px`,
    gap: `${px(styles["column-gap"]) || px(styles["row-gap"])}px`,
    direction: styles["flex-direction"],
    background: toHex(styles["background-color"]) ?? "",
    borderWidth:
      styles["border-top-style"] === "none"
        ? "0px"
        : `${px(styles["border-top-width"])}px`,
    borderColor: toHex(styles["border-top-color"]) ?? "",
    radius:
      radius.endsWith("%") || px(radius) > 999 ? "9999px" : `${px(radius)}px`,
    shadow:
      shadow === "none"
        ? "none"
        : (SHADOW_MARKS.find(([mark]) => shadow.includes(mark))?.[1] ?? ""),
    opacity: String(px(styles.opacity || "1")),
    objectFit: styles["object-fit"],
  };
};

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-8 items-center gap-2">
      <span className="w-[84px] shrink-0 text-[12px] text-ink-2">{label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">{children}</div>
    </div>
  );
}

const FIELD =
  "h-7 rounded-chip bg-inset text-[12px] text-ink outline-none focus-visible:ring-1 focus-visible:ring-line-strong";

function Segmented({
  value,
  options,
  onChange,
}: {
  value: string | undefined;
  options: [value: string, label: string][];
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex h-7 flex-1 rounded-chip bg-inset p-0.5">
      {options.map(([option, label]) => (
        <button
          key={option}
          type="button"
          aria-pressed={option === value}
          onClick={() => onChange(option)}
          className={cn(
            "min-w-0 flex-1 truncate rounded-[4px] px-1 text-[11.5px] text-ink-3 transition-colors duration-100",
            option === value ? "bg-hover-2 text-ink" : "hover:text-ink",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** A slider with its number: the slider previews while it moves, both save when let go. */
function RangeNumber({
  value,
  min = 0,
  max,
  step = 1,
  onPreview,
  onCommit,
}: {
  value: number;
  min?: number;
  max: number;
  step?: number;
  onPreview: (value: number) => void;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commitDraft = () => {
    const number = parseFloat(draft ?? "");
    setDraft(null);
    if (Number.isFinite(number)) onCommit(Math.max(min, number));
  };
  return (
    <>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={Math.min(value, max)}
        onChange={(event) => onPreview(Number(event.target.value))}
        onPointerUp={(event) => onCommit(Number(event.currentTarget.value))}
        onKeyUp={(event) => onCommit(Number(event.currentTarget.value))}
        className="h-7 min-w-0 flex-1 accent-[var(--ink-2)]"
      />
      <input
        type="number"
        min={min}
        step={step}
        value={draft ?? value}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commitDraft}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        className={cn(FIELD, "w-12 shrink-0 px-1.5 text-right tabular-nums")}
      />
    </>
  );
}

function ColorField({
  value,
  onPreview,
  onCommit,
}: {
  value: string;
  onPreview: (value: string) => void;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <div className={cn(FIELD, "flex flex-1 items-center gap-1.5 pr-1.5 pl-1")}>
      <input
        type="color"
        value={/^#[0-9a-f]{6}$/i.test(value) ? value : "#000000"}
        onInput={(event) => onPreview(event.currentTarget.value)}
        // `change` — React's onChange is `input` — fires once, when the picker closes.
        ref={(node) => {
          if (node) node.onchange = () => onCommit(node.value);
        }}
        className="size-5 shrink-0 cursor-pointer rounded-[4px] border-0 bg-transparent p-0"
      />
      <input
        value={draft ?? (value ? value.toUpperCase() : "")}
        placeholder="none"
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          const next = draft?.trim() ?? "";
          setDraft(null);
          if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(next)) onCommit(next);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        className="min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none placeholder:text-ink-3"
      />
    </div>
  );
}

function Select({
  value,
  options,
  onChange,
}: {
  value: string | undefined;
  options: [value: string, label: string][];
  onChange: (value: string) => void;
}) {
  const known = options.some(([option]) => option === value);
  return (
    <select
      value={value ?? ""}
      onChange={(event) => onChange(event.target.value)}
      className={cn(FIELD, "min-w-0 flex-1 px-1.5")}
    >
      {!known && (
        <option value={value ?? ""} disabled>
          {value || "—"}
        </option>
      )}
      {options.map(([option, label]) => (
        <option key={option} value={option}>
          {label}
        </option>
      ))}
    </select>
  );
}

const WEIGHT_OPTIONS: [string, string][] = [
  ["100", "Thin"],
  ["200", "Extra light"],
  ["300", "Light"],
  ["400", "Regular"],
  ["500", "Medium"],
  ["600", "Semibold"],
  ["700", "Bold"],
  ["800", "Extra bold"],
  ["900", "Black"],
];

type Failure = { reason: string; changes: StyleChange[] };

export function ElementInspector({
  element,
  projectId,
  anchor,
  tell,
  onClose,
}: {
  element: PickedElement;
  projectId: string;
  /** The change box, in the preview frame's coordinates: the panel opens beside it, never over it. */
  anchor: { left: number; top: number; width: number; height: number };
  tell: (message: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const busy = useAgentBusy(projectId);
  const kind = useMemo(() => kindOf(element), [element]);
  const computed = useMemo(
    () => readValues(element.styles ?? {}),
    [element.styles],
  );

  // What the user set since the last sync with the page; shown over the computed values.
  const [local, setLocal] = useState<Partial<Record<StyleProp, string>>>({});
  useEffect(() => setLocal({}), [element.styles]);
  const values = { ...computed, ...local };

  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [notes, setNotes] = useState<string[]>([]);

  const pending = useRef(new Map<StyleProp, string | null>());
  const inFlight = useRef(false);
  const classes = useRef(element.classes);
  const hint = useRef<{ file: string; literal: string } | null>(null);
  const classChanged = useRef(false);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const elementRef = useRef(element);
  elementRef.current = element;

  const preview = useCallback(
    (change: StyleChange) => {
      if (change.value !== null)
        setLocal((current) => ({ ...current, [change.prop]: change.value! }));
      tell({ type: "style", styles: cssOverrides(change) });
    },
    [tell],
  );

  const flush = useCallback(async () => {
    if (inFlight.current || !pending.current.size) return;
    const changes = [...pending.current].map(([prop, value]) => ({
      prop,
      value,
    }));
    pending.current.clear();
    inFlight.current = true;
    setSaving(true);
    if (settle.current) clearTimeout(settle.current);

    const { tag, text, page } = elementRef.current;
    const response = await fetch(`/api/projects/${projectId}/style`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        element: { tag, text, page, classes: classes.current },
        changes,
        hint: hint.current ?? undefined,
      }),
    }).catch(() => null);
    const body = (await response?.json().catch(() => null)) as {
      file?: string;
      literal?: string;
      classes?: string;
      shadowedBy?: string[];
      warnings?: string[];
      reason?: string;
    } | null;

    if (response?.ok && body?.file && typeof body.literal === "string") {
      hint.current = { file: body.file, literal: body.literal };
      classes.current = body.classes ?? classes.current;
      setFailure(null);
      setNotes([
        ...(body.shadowedBy?.length
          ? [
              `${body.shadowedBy.join(", ")} still applies at some sizes or states.`,
            ]
          : []),
        ...(body.warnings?.includes("font-not-imported")
          ? ["No global stylesheet found to import the font into."]
          : []),
      ]);
    } else {
      // Nothing was written: the overrides would show a change that is not there.
      changes.forEach(({ prop }) =>
        tell({ type: "style", styles: cssOverrides({ prop, value: null }) }),
      );
      setLocal((current) => {
        const next = { ...current };
        changes.forEach(({ prop }) => delete next[prop]);
        return next;
      });
      setFailure((current) => ({
        reason: body?.reason ?? "error",
        changes: [
          ...(current?.changes.filter(
            (old) => !changes.some((change) => change.prop === old.prop),
          ) ?? []),
          ...changes,
        ],
      }));
    }

    inFlight.current = false;
    if (pending.current.size) return void flush();
    setSaving(false);
    // Hot reload usually lands after the response; if it already has, nothing more will say so.
    if (classChanged.current)
      settle.current = setTimeout(() => {
        classChanged.current = false;
        tell({ type: "clear-styles" });
      }, 2000);
  }, [projectId, tell]);

  const commit = useCallback(
    (change: StyleChange) => {
      preview(change);
      pending.current.set(change.prop, change.value);
      void flush();
    },
    [flush, preview],
  );

  useEffect(() => {
    const onClassChanged = () => {
      if (inFlight.current || pending.current.size) {
        classChanged.current = true;
        return;
      }
      if (settle.current) clearTimeout(settle.current);
      classChanged.current = false;
      tell({ type: "clear-styles" });
    };
    window.addEventListener(CLASS_CHANGED_EVENT, onClassChanged);
    return () => {
      window.removeEventListener(CLASS_CHANGED_EVENT, onClassChanged);
      if (settle.current) clearTimeout(settle.current);
    };
  }, [tell]);

  // Placement: right under the change box with a gap, as tall as the room left below it and
  // scrolling inside — above it only when there is next to no room below. It follows the box
  // as the page scrolls, until the panel is dragged somewhere by hand.
  const panel = useRef<HTMLDivElement>(null);
  const dragged = useRef(false);
  const [position, setPosition] = useState<{
    left: number;
    top?: number;
    bottom?: number;
    maxHeight: number;
  } | null>(null);
  const clamp = useCallback((left: number, top: number) => {
    const box = panel.current;
    const frame = box?.parentElement;
    if (!box || !frame) return { left, top };
    return {
      left: Math.max(
        GAP,
        Math.min(left, frame.clientWidth - box.offsetWidth - GAP),
      ),
      top: Math.max(
        GAP,
        Math.min(top, frame.clientHeight - box.offsetHeight - GAP),
      ),
    };
  }, []);
  useLayoutEffect(() => {
    const box = panel.current;
    const frame = box?.parentElement;
    if (!box || !frame || dragged.current) return;
    const left = clamp(anchor.left, 0).left;
    const under = anchor.top + anchor.height + PANEL_GAP;
    const below = frame.clientHeight - under - GAP;
    const above = anchor.top - PANEL_GAP - GAP;
    setPosition(
      below >= MIN_HEIGHT || below >= above
        ? { left, top: under, maxHeight: Math.min(MAX_HEIGHT, below) }
        : {
            left,
            bottom: frame.clientHeight - anchor.top + PANEL_GAP,
            maxHeight: Math.min(MAX_HEIGHT, above),
          },
    );
  }, [anchor.left, anchor.top, anchor.height, clamp]);

  // Captured, so the preview iframe underneath cannot swallow the moves.
  const onDragStart = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!position || (event.target as HTMLElement).closest("button")) return;
    const handle = event.currentTarget;
    dragged.current = true;
    handle.setPointerCapture(event.pointerId);
    const start = {
      x: event.clientX,
      y: event.clientY,
      left: position.left,
      top: handle.parentElement?.offsetTop ?? 0,
    };
    const onMove = (move: PointerEvent) =>
      setPosition({
        ...clamp(
          start.left + move.clientX - start.x,
          start.top + move.clientY - start.y,
        ),
        maxHeight: MAX_HEIGHT,
      });
    const onEnd = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onEnd);
      handle.removeEventListener("pointercancel", onEnd);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onEnd);
    handle.addEventListener("pointercancel", onEnd);
  };

  const number = (prop: StyleProp) => px(values[prop]);
  const range = (
    prop: StyleProp,
    max: number,
    unit: string,
    step = 1,
    min = 0,
  ) => (
    <RangeNumber
      value={number(prop)}
      min={min}
      max={max}
      step={step}
      onPreview={(value) => preview({ prop, value: `${value}${unit}` })}
      onCommit={(value) => commit({ prop, value: `${value}${unit}` })}
    />
  );
  const color = (prop: StyleProp) => (
    <ColorField
      value={values[prop] ?? ""}
      onPreview={(value) => preview({ prop, value })}
      onCommit={(value) => commit({ prop, value })}
    />
  );

  const flexible = /flex|grid/.test(element.styles?.display ?? "");
  const hasImage = (element.styles?.["background-image"] ?? "none") !== "none";
  const bordered = number("borderWidth") > 0;
  const fonts: [string, string][] = FONT_FAMILIES.map((family) => [
    family,
    family,
  ]);

  return (
    <div
      ref={panel}
      role="dialog"
      aria-label="Element properties"
      className="absolute z-30 flex w-[320px] max-w-[calc(100%-16px)] flex-col overflow-hidden rounded-card bg-surface shadow-raised"
      style={{
        left: position?.left ?? 0,
        top: position?.top,
        bottom: position?.bottom,
        maxHeight: position?.maxHeight,
        visibility: position ? "visible" : "hidden",
        animation: "pop-in 180ms cubic-bezier(0.23,1,0.32,1) both",
      }}
    >
      <div
        onPointerDown={onDragStart}
        className="flex h-9 shrink-0 cursor-grab touch-none items-center gap-1.5 border-b border-line pr-1.5 pl-2 select-none active:cursor-grabbing"
      >
        <GripVerticalIcon className="size-3.5 shrink-0 text-ink-3" />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink">
          {element.tag.toUpperCase()} • {Math.round(element.rect.width)}px
        </span>
        {saving && <span className="text-[11px] text-ink-3">Saving…</span>}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close properties"
          className="flex size-6 items-center justify-center rounded-chip text-ink-3 transition-colors hover:bg-hover hover:text-ink"
        >
          <XIcon className="size-3.5" />
        </button>
      </div>

      {/* The scrolling is the div's: a fieldset will not shrink below its content as a flex item. */}
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
        <fieldset
          disabled={busy}
          className={cn("min-w-0 px-3 py-1.5", busy && "opacity-50")}
        >
          {(element.instances ?? 1) > 1 && (
            <p className="pb-1 text-[11px] text-ink-3">
              Applies to {element.instances} matching elements.
            </p>
          )}

          {kind.text && (
            <>
              <Row label="Font">
                <Select
                  value={values.fontFamily}
                  options={fonts}
                  onChange={(value) => {
                    tell({ type: "font", href: fontHref(value) });
                    commit({ prop: "fontFamily", value });
                  }}
                />
              </Row>
              <Row label="Size">{range("fontSize", 128, "px", 1, 8)}</Row>
              <Row label="Weight">
                <Select
                  value={values.fontWeight}
                  options={WEIGHT_OPTIONS}
                  onChange={(value) => commit({ prop: "fontWeight", value })}
                />
              </Row>
              <Row label="Color">{color("color")}</Row>
              <Row label="Align">
                <Segmented
                  value={values.textAlign}
                  options={[
                    ["left", "Left"],
                    ["center", "Center"],
                    ["right", "Right"],
                  ]}
                  onChange={(value) => commit({ prop: "textAlign", value })}
                />
              </Row>
              <Row label="Line height">
                {range("lineHeight", 3, "", 0.05, 0.8)}
              </Row>
              <Row label="Spacing">
                {range("letterSpacing", 0.3, "em", 0.005, -0.1)}
              </Row>
            </>
          )}

          {kind.box && (
            <>
              <Row label="Padding X">{range("paddingX", 128, "px")}</Row>
              <Row label="Padding Y">{range("paddingY", 128, "px")}</Row>
              {flexible && <Row label="Gap">{range("gap", 96, "px")}</Row>}
              {flexible && element.styles?.display?.includes("flex") && (
                <Row label="Direction">
                  <Segmented
                    value={values.direction}
                    options={[
                      ["row", "Row"],
                      ["column", "Column"],
                    ]}
                    onChange={(value) => commit({ prop: "direction", value })}
                  />
                </Row>
              )}
              <Row label="Fill">
                {hasImage ? (
                  <span className="text-[11.5px] text-ink-3">
                    Has a background image
                  </span>
                ) : (
                  color("background")
                )}
              </Row>
            </>
          )}

          {(kind.box || kind.media) && (
            <>
              <Row label="Border">
                <Segmented
                  value={bordered ? "yes" : "no"}
                  options={[
                    ["yes", "Yes"],
                    ["no", "No"],
                  ]}
                  onChange={(value) =>
                    commit({
                      prop: "borderWidth",
                      value: value === "yes" ? "1px" : "0px",
                    })
                  }
                />
              </Row>
              {bordered && (
                <>
                  <Row label="Width">
                    {range("borderWidth", 16, "px", 1, 1)}
                  </Row>
                  <Row label="Stroke">{color("borderColor")}</Row>
                </>
              )}
              <Row label="Radius">{range("radius", 64, "px")}</Row>
              <Row label="Shadow">
                <Segmented
                  value={values.shadow}
                  options={[
                    ["none", "No"],
                    ["md", "M"],
                    ["lg", "L"],
                    ["xl", "XL"],
                    ["2xl", "2XL"],
                  ]}
                  onChange={(value) => commit({ prop: "shadow", value })}
                />
              </Row>
              {kind.media && (
                <Row label="Fit">
                  <Select
                    value={values.objectFit}
                    options={[
                      ["cover", "Cover"],
                      ["contain", "Contain"],
                      ["fill", "Fill"],
                      ["none", "None"],
                      ["scale-down", "Scale down"],
                    ]}
                    onChange={(value) => commit({ prop: "objectFit", value })}
                  />
                </Row>
              )}
              <Row label="Opacity">{range("opacity", 1, "", 0.01)}</Row>
            </>
          )}
        </fieldset>
      </div>

      {(busy || failure || notes.length > 0) && (
        <div className="shrink-0 space-y-1.5 border-t border-line px-3 py-2 text-[11.5px] leading-snug text-ink-3">
          {busy && (
            <p>The agent is working — properties unlock when it is done.</p>
          )}
          {notes.map((note) => (
            <p key={note}>{note}</p>
          ))}
          {failure && (
            <>
              <p className="text-orange">
                {REFUSALS[failure.reason] ?? "Couldn't save the change."}
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  sendToAgent(
                    projectId,
                    editsBrief(
                      [
                        {
                          id: crypto.randomUUID(),
                          element: elementRef.current,
                          instruction: describeChanges(failure.changes),
                        },
                      ],
                      "",
                    ),
                  );
                  setFailure(null);
                }}
                className="h-6.5 rounded-chip bg-hover px-2 text-[11.5px] font-medium text-ink transition-colors hover:bg-hover-2 disabled:opacity-40"
              >
                Send to agent instead
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
