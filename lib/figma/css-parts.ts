/**
 * The two shorthands the properties panel edits as fields rather than as text.
 *
 * `box-shadow` and `border` are the only rows where a designer thinks in *parts* — an offset,
 * a blur, a weight, a colour — and CSS stores them as one string. Everything else in the panel
 * is one value with one meaning, and a parser for those would be a parser for nothing.
 *
 * Both return `null` rather than guessing. A value this cannot take apart is handed back to the
 * panel as a plain text field, which is the honest fallback: a design can carry four stacked
 * shadows or a `var()`, and quietly showing the first layer's numbers would let somebody edit
 * one shadow and destroy three.
 */

/**
 * Split on the spaces *between* parts — `rgba(0, 0, 0, .2)` is one part, not four.
 *
 * Depth-counted rather than regex: `color-mix(in srgb, rgb(0 0 0), white)` nests, and a regex
 * that handles one level is a regex that is wrong on the second.
 */
export const parts = (value: string): string[] => {
  const out: string[] = [];
  let depth = 0;
  let token = "";
  for (const char of value.trim()) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (/\s/.test(char) && depth === 0) {
      if (token) out.push(token);
      token = "";
      continue;
    }
    token += char;
  }
  if (token) out.push(token);
  return out;
};

/** A top-level comma means more than one layer, which these editors do not speak for. */
export const layered = (value: string): boolean => {
  let depth = 0;
  for (const char of value) {
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) return true;
  }
  return false;
};

const LENGTH = /^-?[\d.]+(px|r?em|%|vh|vw|pt)?$/;

export type Shadow = {
  inset: boolean;
  x: string;
  y: string;
  blur: string;
  spread: string;
  colour: string;
};

/**
 * `[inset] <x> <y> [blur] [spread] [colour]` in any of the orders CSS allows the colour in.
 *
 * The lengths are positional and the colour is not, so the colour is taken out first and the
 * rest read in order — which is what the spec says and what every other parser gets wrong by
 * assuming the colour is last.
 */
export const parseShadow = (value: string): Shadow | null => {
  const raw = value.trim();
  if (!raw || layered(raw)) return null;
  const all = parts(raw);
  if (!all.length) return null;
  const inset = all.includes("inset");
  const rest = all.filter((token) => token !== "inset");
  const lengths = rest.filter((token) => LENGTH.test(token));
  const colour = rest.filter((token) => !LENGTH.test(token));
  if (lengths.length < 2 || colour.length > 1) return null;
  return {
    inset,
    x: lengths[0] ?? "0",
    y: lengths[1] ?? "0",
    blur: lengths[2] ?? "0",
    spread: lengths[3] ?? "0",
    colour: colour[0] ?? "rgba(0, 0, 0, 0.25)",
  };
};

/** Always all four lengths: a field somebody can type into must have a value to show. */
export const formatShadow = (shadow: Shadow): string =>
  [
    shadow.inset ? "inset" : "",
    shadow.x || "0",
    shadow.y || "0",
    shadow.blur || "0",
    shadow.spread || "0",
    shadow.colour,
  ]
    .filter(Boolean)
    .join(" ");

export type Border = { width: string; style: string; colour: string };

const STYLES = new Set([
  "none",
  "hidden",
  "solid",
  "dashed",
  "dotted",
  "double",
  "groove",
  "ridge",
  "inset",
  "outset",
]);

/** `<width> <style> <colour>`, in any order — CSS does not fix one for `border`. */
export const parseBorder = (value: string): Border | null => {
  const raw = value.trim();
  if (!raw || layered(raw)) return null;
  const all = parts(raw);
  if (!all.length) return null;
  const style = all.find((token) => STYLES.has(token));
  const width = all.find((token) => LENGTH.test(token));
  const colour = all.find(
    (token) => token !== style && token !== width && !STYLES.has(token),
  );
  return {
    width: width ?? "1px",
    style: style ?? "solid",
    colour: colour ?? "#000000",
  };
};

export const formatBorder = (border: Border): string =>
  `${border.width || "1px"} ${border.style || "solid"} ${border.colour || "#000000"}`;

/**
 * One number and the unit stuck to it, stepped — `12px` → `13px`, `0` → `1`.
 *
 * The whole string in and the whole string out, because that is what the panel holds: every
 * field here reads a CSS value and writes one back, and a stepper that returned a number would
 * put `13` where `13px` belongs. Anything that is not a single number — `auto`, `50%` of a
 * shorthand, a colour — comes back untouched, so a field can offer the arrows without first
 * proving what is in it.
 */
export function stepped(raw: string, dir: 1 | -1): string {
  const parts = /^\s*(-?\d*\.?\d+)([a-z%]*)\s*$/i.exec(raw);
  if (!parts) return raw;
  // Rounded, or `0.1 + 1` arrives as `1.1000000000000001` in the field.
  return `${Number((Number(parts[1]) + dir).toFixed(4))}${parts[2]}`;
}

/**
 * A four-part shorthand — `padding`, `border-radius`, `margin` — as its four parts.
 *
 * CSS's own fill rule, which is not obvious and is wrong in both directions if you guess: one
 * value is all four, two are the axes, three leave the fourth to mirror the second. Written out
 * here once because the panel edits these as four boxes and every one of them has to read the
 * same value the same way.
 *
 * The order is CSS's: **top, right, bottom, left** for `padding`; for `border-radius` it is the
 * four corners from the top-left, which fills identically.
 */
export const fourOf = (
  value: string,
  empty = "0",
): [string, string, string, string] => {
  const parts = (value.trim() || empty).split(/\s+/);
  const at = (i: number) =>
    parts[i] ?? parts[i - 2] ?? parts[i - 3] ?? parts[0] ?? empty;
  return [at(0), at(1), at(2), at(3)];
};

/**
 * The four back as the shortest shorthand that means them.
 *
 * `10px 10px 10px 10px` and `10px` are the same padding, and only one of them can be read at a
 * glance — in the panel, in a copied export, and in the `Other` group's raw text. The panel
 * collapses on the way out for the same reason it expands on the way in.
 */
export const shorthand = ([top, right, bottom, left]: [
  string,
  string,
  string,
  string,
]): string => {
  if (top === right && right === bottom && bottom === left) return top;
  if (top === bottom && right === left) return `${top} ${right}`;
  if (right === left) return `${top} ${right} ${bottom}`;
  return `${top} ${right} ${bottom} ${left}`;
};

/**
 * The design's own number, out of the responsive form it was written in.
 *
 * `figma-scene` states a box as the rule the design gave rather than the pixel it resolves to:
 * a left-pinned one is `min(378px,max(0px,calc(100% - 684px)))` so it slides back rather than
 * off the edge of a phone, a centred one is `max(0px,calc(50% - 342px))`, and type is
 * `clamp(29.76px,3.3334vw,48px)`. Every one of them is exactly the design's own value at the
 * design's own width — which is the number a properties panel is asking about, and the one
 * thing a 90px well cannot show: the Offset field read `min(0px,`.
 *
 * So: `min` opens with it, `max` guards it with a floor and ends with it, and a `clamp` caps at
 * it. Anything else is handed straight back, including `calc(50% - 342px)` — half of *what* is
 * the parent's width, and a panel that resolved it would be guessing.
 *
 * `export-code.ts` needs the same read for the native targets, which have no viewport to
 * resolve any of this against.
 */
export const unguarded = (value: string): string => {
  const call = /^(min|max|clamp)\(([\s\S]*)\)$/.exec(value.trim());
  if (!call) return value;
  const args = parts(call[2].replace(/,/g, " , ")).filter((p) => p !== ",");
  if (!args.length) return value;
  // `min` and `clamp` open and close on the design's number respectively; `max` floors first.
  const pick = call[1] === "min" ? args[0] : args[args.length - 1];
  return unguarded(pick);
};
