/**
 * Property edits on a picked element, as Tailwind classes — no agent involved.
 *
 * The inspector changes hard properties (a size, a colour, a padding), and a generated project
 * styles with Tailwind, so a change is a rewrite of one class string: the utilities that set the
 * property go, the new one is appended. Only unprefixed utilities are touched — `md:px-8` or
 * `hover:bg-…` are somebody's deliberate choice for another state — and the ones that still
 * decide the property are reported back as `shadowedBy`.
 *
 * What is written is the same under Tailwind 3 and 4: a scale name only where both agree on it,
 * an arbitrary value otherwise. Radius is always arbitrary, because shadcn remaps the named
 * radius scale, and the shadow names offered are the ones that did not shift between versions.
 *
 * Pure and free of imports: the panel uses it for the live preview, the route for the source.
 */

export const STYLE_PROPS = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "color",
  "textAlign",
  "lineHeight",
  "letterSpacing",
  "paddingX",
  "paddingY",
  "gap",
  "direction",
  "background",
  "borderWidth",
  "borderColor",
  "radius",
  "shadow",
  "opacity",
  "objectFit",
] as const;

export type StyleProp = (typeof STYLE_PROPS)[number];

/** `value` is a CSS value in the prop's one accepted shape; `null` takes the utilities away. */
export type StyleChange = { prop: StyleProp; value: string | null };

export const SHADOWS: Record<string, string> = {
  none: "none",
  md: "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
  lg: "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)",
  xl: "0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)",
  "2xl": "0 25px 50px -12px rgb(0 0 0 / 0.25)",
};

const PX = /^\d{1,4}(\.\d{1,2})?px$/;
const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const oneOf =
  (...values: string[]) =>
  (value: string) =>
    values.includes(value);

/** The only values that may become part of a class string written into someone's source. */
const VALID: Record<StyleProp, (value: string) => boolean> = {
  fontFamily: (value) => /^[A-Za-z0-9][A-Za-z0-9 ]{0,39}$/.test(value),
  fontSize: (value) => PX.test(value),
  fontWeight: (value) => /^[1-9]00$/.test(value),
  color: (value) => HEX.test(value),
  textAlign: oneOf("left", "center", "right", "justify"),
  lineHeight: (value) => /^\d(\.\d{1,3})?$/.test(value),
  letterSpacing: (value) => /^-?\d(\.\d{1,3})?em$/.test(value),
  paddingX: (value) => PX.test(value),
  paddingY: (value) => PX.test(value),
  gap: (value) => PX.test(value),
  direction: oneOf("row", "column", "row-reverse", "column-reverse"),
  background: (value) => HEX.test(value),
  borderWidth: (value) => PX.test(value),
  borderColor: (value) => HEX.test(value),
  radius: (value) => PX.test(value),
  shadow: (value) => Object.keys(SHADOWS).includes(value),
  opacity: (value) => /^(0(\.\d{1,2})?|1(\.0{1,2})?)$/.test(value),
  objectFit: oneOf("contain", "cover", "fill", "none", "scale-down"),
};

export const validChange = (change: unknown): change is StyleChange => {
  if (!change || typeof change !== "object") return false;
  const { prop, value } = change as { prop?: unknown; value?: unknown };
  if (!(STYLE_PROPS as readonly unknown[]).includes(prop)) return false;
  return (
    value === null ||
    (typeof value === "string" && VALID[prop as StyleProp](value))
  );
};

const WEIGHTS: Record<string, string> = {
  "100": "thin",
  "200": "extralight",
  "300": "light",
  "400": "normal",
  "500": "medium",
  "600": "semibold",
  "700": "bold",
  "800": "extrabold",
  "900": "black",
};
const WEIGHT_NAMES = Object.values(WEIGHTS);

/** Named sizes and the line height each brings along, as a ratio of the size. */
const SIZES: Record<string, [px: number, leading: string]> = {
  xs: [12, "1.333"],
  sm: [14, "1.429"],
  base: [16, "1.5"],
  lg: [18, "1.556"],
  xl: [20, "1.4"],
  "2xl": [24, "1.333"],
  "3xl": [30, "1.2"],
  "4xl": [36, "1.111"],
  "5xl": [48, "1"],
  "6xl": [60, "1"],
  "7xl": [72, "1"],
  "8xl": [96, "1"],
  "9xl": [128, "1"],
};
const LEADINGS: Record<string, string> = {
  "1": "none",
  "1.25": "tight",
  "1.375": "snug",
  "1.5": "normal",
  "1.625": "relaxed",
  "2": "loose",
};
const TRACKINGS: Record<string, string> = {
  "-0.05": "tighter",
  "-0.025": "tight",
  "0": "normal",
  "0.025": "wide",
  "0.05": "wider",
  "0.1": "widest",
};
/** The default spacing scale of Tailwind 3, in quarter-rems; Tailwind 4 accepts all of these. */
const SPACING = new Set([
  0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 20, 24,
  28, 32, 36, 40, 44, 48, 52, 56, 60, 64, 72, 80, 96,
]);

const spacing = (value: string) => {
  const px = parseFloat(value);
  if (px === 1) return "px";
  return SPACING.has(px / 4) ? String(px / 4) : `[${px}px]`;
};

const SIZE_TOKEN = /^text-(xs|sm|base|lg|xl|[2-9]xl)(\/.+)?$/;
const isFontSize = (base: string) =>
  SIZE_TOKEN.test(base) ||
  /^text-\[(length:|\.?\d|calc\(|clamp\(|min\(|max\()/.test(base);
const isTextAlign = (base: string) =>
  /^text-(left|center|right|justify|start|end)$/.test(base);
const isFontWeight = (base: string) =>
  base.startsWith("font-") &&
  (WEIGHT_NAMES.includes(base.slice(5)) ||
    /^font-\[(\d+|weight:.+)\]$/.test(base));
const isBorderWidth = (base: string) =>
  /^border(-\d+|-\[(length:|\.?\d).*)?$/.test(base);
const isSideBorder = (base: string) => /^border-[xytrblse]($|-)/.test(base);
const isSideWidth = (base: string) =>
  /^border-[xytrblse](-\d+|-\[(length:|\.?\d).*)?$/.test(base);
const startsSpacing = "(\\d|\\[|px$)";
const PADDING_X = new RegExp(`^(p|px|pl|pr|ps|pe)-${startsSpacing}`);
const PADDING_Y = new RegExp(`^(p|py|pt|pb)-${startsSpacing}`);

/** Whether an unprefixed utility sets the property, and so has to make way for the new one. */
const CONFLICTS: Record<StyleProp, (base: string) => boolean> = {
  fontFamily: (base) =>
    base.startsWith("font-") &&
    !isFontWeight(base) &&
    !base.startsWith("font-stretch-") &&
    !/^font-\[\d/.test(base),
  fontSize: isFontSize,
  fontWeight: isFontWeight,
  color: (base) =>
    base.startsWith("text-") &&
    !isFontSize(base) &&
    !isTextAlign(base) &&
    !/^text-(wrap|nowrap|balance|pretty|ellipsis|clip|shadow)/.test(base),
  textAlign: isTextAlign,
  lineHeight: (base) => base.startsWith("leading-"),
  letterSpacing: (base) => base.startsWith("tracking-"),
  paddingX: (base) => PADDING_X.test(base),
  paddingY: (base) => PADDING_Y.test(base),
  gap: (base) => /^(gap|gap-x|gap-y|space-x|space-y)-/.test(base),
  direction: (base) => /^flex-(row|col)(-reverse)?$/.test(base),
  background: (base) =>
    base.startsWith("bg-") &&
    !/^bg-(fixed|local|scroll|clip-|origin-|repeat|no-repeat|auto$|cover$|contain$|center$|top$|bottom$|left|right|none$|gradient-|linear-|radial|conic|blend-|\[(url\(|image:|length:|position:))/.test(
      base,
    ),
  borderWidth: isBorderWidth,
  borderColor: (base) =>
    base.startsWith("border-") &&
    !isBorderWidth(base) &&
    !isSideBorder(base) &&
    !/^border-(solid|dashed|dotted|double|hidden|none|collapse|separate|spacing-)/.test(
      base,
    ),
  radius: (base) => /^rounded($|-)/.test(base),
  shadow: (base) =>
    /^shadow(-(2xs|xs|sm|md|lg|xl|2xl|none|inner))?$/.test(base) ||
    /^shadow-\[(?!#|rgb|hsl|color:|var\()/.test(base),
  opacity: (base) => base.startsWith("opacity-"),
  objectFit: (base) =>
    /^object-(contain|cover|fill|none|scale-down)$/.test(base),
};

/** The utility that sets the property to the value. Values have passed `validChange`. */
const UTILITY: Record<StyleProp, (value: string) => string> = {
  fontFamily: (value) => `font-['${value.replace(/ /g, "_")}']`, // quotes: see `editClasses`
  fontSize: (value) => {
    const px = parseFloat(value);
    const named = Object.keys(SIZES).find((name) => SIZES[name][0] === px);
    return named ? `text-${named}` : `text-[${px}px]`;
  },
  fontWeight: (value) => `font-${WEIGHTS[value]}`,
  color: (value) => `text-[${value}]`,
  textAlign: (value) => `text-${value}`,
  lineHeight: (value) => {
    const ratio = String(parseFloat(value));
    return `leading-${LEADINGS[ratio] ?? `[${ratio}]`}`;
  },
  letterSpacing: (value) => {
    const em = String(parseFloat(value));
    return `tracking-${TRACKINGS[em] ?? `[${em}em]`}`;
  },
  paddingX: (value) => `px-${spacing(value)}`,
  paddingY: (value) => `py-${spacing(value)}`,
  gap: (value) => `gap-${spacing(value)}`,
  direction: (value) => `flex-${value.replace("column", "col")}`,
  background: (value) => `bg-[${value}]`,
  borderWidth: (value) => {
    const px = parseFloat(value);
    if (px === 1) return "border";
    return [0, 2, 4, 8].includes(px) ? `border-${px}` : `border-[${px}px]`;
  },
  borderColor: (value) => `border-[${value}]`,
  radius: (value) => {
    const px = parseFloat(value);
    if (px === 0) return "rounded-none";
    return px >= 9999 ? "rounded-full" : `rounded-[${px}px]`;
  },
  shadow: (value) => `shadow-${value}`,
  opacity: (value) => {
    const percent = Math.round(parseFloat(value) * 100);
    return percent % 5 === 0
      ? `opacity-${percent}`
      : `opacity-[${percent / 100}]`;
  },
  objectFit: (value) => `object-${value}`,
};

type Token = {
  raw: string;
  variant: string;
  base: string;
  important: "" | "pre" | "post";
};

/** `md:hover:!px-4` → variant `md:hover:`, base `px-4`. A colon inside brackets is not a variant. */
const parseToken = (raw: string): Token => {
  let depth = 0;
  let cut = 0;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === "[" || char === "(") depth += 1;
    else if (char === "]" || char === ")") depth -= 1;
    else if (char === ":" && depth === 0) cut = index + 1;
  }
  const rest = raw.slice(cut);
  const important = rest.startsWith("!")
    ? "pre"
    : rest.endsWith("!")
      ? "post"
      : "";
  const base =
    important === "pre"
      ? rest.slice(1)
      : important === "post"
        ? rest.slice(0, -1)
        : rest;
  return { raw, variant: raw.slice(0, cut), base, important };
};

const withImportant = (utility: string, important: Token["important"]) =>
  important === "pre"
    ? `!${utility}`
    : important === "post"
      ? `${utility}!`
      : utility;

/**
 * The class string with the changes made. `shadowedBy` lists the variant utilities left alone
 * that set the same properties, which may be why a change shows nothing at this viewport.
 * `quote` is what a font family is quoted with: the other one, inside a `'…'` literal.
 */
export const editClasses = (
  classes: string,
  changes: StyleChange[],
  quote: "'" | '"' = "'",
) => {
  let tokens = classes.split(/\s+/).filter(Boolean).map(parseToken);
  const shadowedBy: string[] = [];
  const changed = new Set(changes.map((change) => change.prop));

  for (const { prop, value } of changes) {
    const conflicts = CONFLICTS[prop];
    const removed: Token[] = [];
    const added: string[] = [];

    tokens = tokens.flatMap((token) => {
      if (!conflicts(token.base)) {
        // `text-sm/6` carries a line height on the size; a new line height takes it off.
        if (
          prop === "lineHeight" &&
          !token.variant &&
          SIZE_TOKEN.test(token.base)
        ) {
          const size = token.base.split("/")[0];
          return [parseToken(withImportant(size, token.important))];
        }
        return [token];
      }
      if (token.variant) {
        shadowedBy.push(token.raw);
        return [token];
      }
      removed.push(token);
      return [];
    });

    const important = removed.find((token) => token.important)?.important ?? "";

    for (const token of removed) {
      // `p-4` sets both axes: the one not being changed keeps its value.
      const all = /^p-(.+)$/.exec(token.base);
      if (all && prop === "paddingX" && !changed.has("paddingY"))
        added.push(`py-${all[1]}`);
      if (all && prop === "paddingY" && !changed.has("paddingX"))
        added.push(`px-${all[1]}`);

      // A named size brings its line height; keep it unless something else sets one.
      const size = prop === "fontSize" ? SIZE_TOKEN.exec(token.base) : null;
      const keepsLeading =
        size &&
        !changed.has("lineHeight") &&
        !tokens.some(
          (other) => !other.variant && other.base.startsWith("leading-"),
        );
      if (size && keepsLeading) {
        const next = value === null ? null : UTILITY.fontSize(value);
        if (size[2]) added.push(`leading-${size[2].slice(1)}`);
        else if (!next || !SIZE_TOKEN.test(next))
          added.push(UTILITY.lineHeight(SIZES[size[1]][1]));
      }
    }

    // Turning a border off has to beat the side widths too.
    if (prop === "borderWidth" && value !== null && parseFloat(value) === 0)
      tokens = tokens.filter(
        (token) => token.variant || !isSideWidth(token.base),
      );

    if (value !== null) added.push(UTILITY[prop](value).replace(/'/g, quote));
    tokens.push(
      ...added.map((utility) => parseToken(withImportant(utility, important))),
    );
  }

  return {
    classes: tokens.map((token) => token.raw).join(" "),
    shadowedBy: [...new Set(shadowedBy)],
  };
};

/**
 * The inline declarations that show a change in the preview before the source catches up.
 * `null` takes an override off again.
 */
export const cssOverrides = (
  change: StyleChange,
): Record<string, string | null> => {
  const { prop, value } = change;
  switch (prop) {
    case "fontFamily":
      return {
        "font-family":
          value && `"${value}", ui-sans-serif, system-ui, sans-serif`,
      };
    case "fontSize":
      return { "font-size": value };
    case "fontWeight":
      return { "font-weight": value };
    case "color":
      return { color: value };
    case "textAlign":
      return { "text-align": value };
    case "lineHeight":
      return { "line-height": value };
    case "letterSpacing":
      return { "letter-spacing": value };
    case "paddingX":
      return { "padding-left": value, "padding-right": value };
    case "paddingY":
      return { "padding-top": value, "padding-bottom": value };
    case "gap":
      return { gap: value };
    case "direction":
      return { "flex-direction": value };
    case "background":
      return { "background-color": value };
    case "borderWidth":
      return { "border-width": value, "border-style": value && "solid" };
    case "borderColor":
      return { "border-color": value };
    case "radius":
      return { "border-radius": value };
    case "shadow":
      return { "box-shadow": value && SHADOWS[value] };
    case "opacity":
      return { opacity: value };
    case "objectFit":
      return { "object-fit": value };
  }
};

const LABELS: Record<StyleProp, string> = {
  fontFamily: "font family",
  fontSize: "font size",
  fontWeight: "font weight",
  color: "text colour",
  textAlign: "text alignment",
  lineHeight: "line height",
  letterSpacing: "letter spacing",
  paddingX: "horizontal padding",
  paddingY: "vertical padding",
  gap: "gap between children",
  direction: "flex direction",
  background: "background colour",
  borderWidth: "border width",
  borderColor: "border colour",
  radius: "corner radius",
  shadow: "box shadow",
  opacity: "opacity",
  objectFit: "object fit",
};

/** The changes in words, for when the source could not be edited and the user hands them to the agent. */
export const describeChanges = (changes: StyleChange[]) =>
  `Set these exact properties on it: ${changes
    .map(({ prop, value }) =>
      value === null
        ? `remove the ${LABELS[prop]}`
        : `${LABELS[prop]} ${prop === "shadow" ? `${value} (Tailwind shadow-${value})` : value}`,
    )
    .join("; ")}. Change nothing else.`;
