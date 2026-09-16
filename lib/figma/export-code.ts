/**
 * The scene, in a language other than HTML.
 *
 * `/canvas` renders one thing — the absolutely-positioned document `figma-scene.ts` builds —
 * and copying it hands over exactly what the frame shows. Every target here is a rewrite of
 * *that document*, not a second pass over the Figma payload: the mapper's masks, gradients,
 * blend modes, vector networks and text baselines took real work to get right, and running a
 * different pipeline against the same nodes would throw all of it away.
 *
 * So the split that matters is not by language, it is by **rendering model**:
 *
 * - `jsx`, `vue`, `svelte`, `css` and `html` keep the DOM. They are a mechanical rewrite —
 *   same tree, same declarations, same SVG — and lose nothing.
 * - `tailwind` keeps the DOM but not every declaration: anything with a space or a comma in
 *   its value (a gradient, a shadow, a transform) has no arbitrary-value spelling that
 *   survives, and stays in a `style` prop beside the classes.
 * - `swiftui`, `flutter` and `compose` do not keep the DOM. Inline SVG, `mask-image`,
 *   `mix-blend-mode`, `backdrop-filter` and layered backgrounds have no equivalent at all.
 *   Those targets report what they dropped, per node — the same contract the mapper itself
 *   follows, because a native file that is quietly missing the artwork looks like working code.
 */

import { unguarded } from "./css-parts";
import { fontFaces, fontUrls, type UsedFont } from "./figma-paste";
import { fitScript } from "./fit-text";

export type TargetId =
  | "html"
  | "jsx"
  | "tailwind"
  | "vue"
  | "svelte"
  | "css"
  | "swiftui"
  | "flutter"
  | "compose";

export type Target = {
  id: TargetId;
  label: string;
  /** The target's cost, where it has one. On the menu row's tooltip. */
  hint: string;
  group: "Web" | "Native";
  /** Whether image fills should be inlined as data URIs before the rewrite. */
  inlineImages: boolean;
};

export const TARGETS: Target[] = [
  {
    id: "html",
    label: "HTML / CSS",
    hint: "One self-contained document, with the images and fonts folded in.",
    group: "Web",
    inlineImages: true,
  },
  {
    id: "css",
    label: "HTML / CSS Classes",
    hint: "One document, with the declarations lifted into classes in a <style> block.",
    group: "Web",
    inlineImages: true,
  },
  {
    id: "jsx",
    label: "React (JSX)",
    hint: "A React component, styled with inline style objects.",
    group: "Web",
    inlineImages: true,
  },
  {
    id: "tailwind",
    label: "React + Tailwind",
    hint: "A React component in Tailwind classes, using arbitrary values.",
    group: "Web",
    inlineImages: true,
  },
  {
    id: "vue",
    label: "Vue (SFC)",
    hint: "One Vue single-file component, template and styles together.",
    group: "Web",
    inlineImages: true,
  },
  {
    id: "svelte",
    label: "Svelte",
    hint: "One Svelte single-file component, markup and styles together.",
    group: "Web",
    inlineImages: true,
  },
  {
    id: "swiftui",
    label: "Swift UI",
    hint: "SwiftUI views. No SVG, masks or blend modes — what is dropped is reported.",
    group: "Native",
    inlineImages: false,
  },
  {
    id: "flutter",
    label: "Flutter",
    hint: "Flutter widgets. No SVG, masks or blend modes — what is dropped is reported.",
    group: "Native",
    inlineImages: false,
  },
  {
    id: "compose",
    label: "Jetpack Compose",
    hint: "Compose composables. No SVG, masks or blend modes — what is dropped is reported.",
    group: "Native",
    inlineImages: false,
  },
];

export const targetOf = (id: TargetId): Target =>
  TARGETS.find((t) => t.id === id) ?? TARGETS[0];

/* ------------------------------------------------------------------ parsing */

export type El = {
  /**
   * As authored, **not** lowercased. HTML tag names are case-insensitive and SVG's are not:
   * `<linearGradient>` folded to `<lineargradient>` is a different element that nothing
   * references, so every gradient, `clipPath` and `feGaussianBlur` in the artwork stopped
   * resolving and the shapes they painted came back flat. Match with `lower()`, never by
   * normalising the stored name.
   */
  tag: string;
  attrs: Record<string, string>;
  /** The inline `style` attribute, split into declarations. Order is preserved. */
  style: [string, string][];
  kids: Node[];
};
export type Node = El | { text: string };

export const isEl = (node: Node): node is El => "tag" in node;

/** For the case-insensitive lookups only — see `El.tag`. */
const lower = (tag: string) => tag.toLowerCase();

/**
 * Elements HTML closes for you. `path`, `rect`, `stop` and friends are written self-closing by
 * the mapper, so they never reach the void list, but `img`, `br` and `input` do.
 */
const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/** Elements whose content is text, not markup: `<style>@import url(…)</style>` is not a tag. */
const RAW_TEXT = new Set(["style", "script"]);

/**
 * Inline-level elements, where the whitespace *between* children is drawn.
 *
 * This is the one place indentation is not free. `<span>a</span><span>b</span>` pretty-printed
 * onto two lines renders as "a b", because the newline and the indent between them are a text
 * node — so a text run split into segments (a bold word, a link, a superscript) silently gains
 * a space at every boundary. Caught by rendering the extracted-CSS target beside the HTML one:
 * identical on every fixture except the one with segmented text in it.
 */
const INLINE = new Set([
  "span",
  "a",
  "b",
  "i",
  "em",
  "strong",
  "sub",
  "sup",
  "u",
  "s",
  "small",
  "code",
  "br",
  "label",
  "abbr",
  "mark",
  "q",
]);

/** Children that must stay on one line with their parent, whitespace and all. */
const isTight = (node: El) =>
  node.kids.some((kid) => !isEl(kid) || INLINE.has(lower(kid.tag)));

/**
 * `white-space` inherits, and under a preserving value the newline between two *block* children
 * is drawn too — the nav row of one fixture sits inside a `pre-wrap` subtree and every row below
 * it moved by a line. So the flag is carried down rather than read off the element.
 */
const PRESERVES = new Set(["pre", "pre-wrap", "pre-line", "break-spaces"]);

const preservesWhitespace = (node: El, inherited: boolean) => {
  const own = styleOf(node, "white-space");
  return own === undefined ? inherited : PRESERVES.has(own);
};

const ATTR =
  /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

const decode = (text: string) =>
  text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#123;/g, "{")
    .replace(/&#125;/g, "}")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");

/** `a:1;b:2` → `[["a","1"],["b","2"]]`, splitting only on separators outside `(…)`. */
export const declarations = (style: string): [string, string][] => {
  const out: [string, string][] = [];
  let depth = 0;
  let start = 0;
  const push = (chunk: string) => {
    const at = chunk.indexOf(":");
    if (at <= 0) return;
    const prop = chunk.slice(0, at).trim();
    const value = chunk.slice(at + 1).trim();
    if (prop && value) out.push([prop, value]);
  };
  for (let i = 0; i < style.length; i += 1) {
    const c = style[i];
    if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    // A `;` inside `url(data:…;base64,…)` or a gradient's own argument list is not a separator.
    else if (c === ";" && depth === 0) {
      push(style.slice(start, i));
      start = i + 1;
    }
  }
  push(style.slice(start));
  return out;
};

/**
 * The scene markup, as a tree.
 *
 * ponytail: a tokenizer, not a parser — no error recovery, no implied end tags, no `<p>`
 * auto-closing. That is sound here and only here: the only input is `figma-scene.ts`'s own
 * output, which is built by concatenation, always closes what it opens and escapes its text.
 * Point this at a page off the web and it will mis-nest. If that ever becomes the job, swap in
 * `DOMParser` on the browser side rather than growing this.
 */
export const parseScene = (html: string): Node[] => {
  const roots: Node[] = [];
  const stack: El[] = [];
  const top = () => (stack.length ? stack[stack.length - 1].kids : roots);
  let at = 0;

  while (at < html.length) {
    const lt = html.indexOf("<", at);
    if (lt === -1) break;
    if (lt > at) {
      const text = html.slice(at, lt);
      if (text.trim()) top().push({ text: decode(text) });
    }

    // Comments and doctype carry nothing the targets need.
    if (html.startsWith("<!--", lt)) {
      at = html.indexOf("-->", lt);
      at = at === -1 ? html.length : at + 3;
      continue;
    }
    if (html.startsWith("<!", lt)) {
      at = html.indexOf(">", lt);
      at = at === -1 ? html.length : at + 1;
      continue;
    }

    if (html[lt + 1] === "/") {
      const end = html.indexOf(">", lt);
      const name = html
        .slice(lt + 2, end === -1 ? undefined : end)
        .trim()
        .toLowerCase();
      // Close the nearest matching open tag, so a stray `</div>` cannot unwind the whole stack.
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (lower(stack[i].tag) === name) {
          stack.length = i;
          break;
        }
      }
      at = end === -1 ? html.length : end + 1;
      continue;
    }

    const end = html.indexOf(">", lt);
    if (end === -1) break;
    const source = html.slice(lt + 1, end);
    const space = source.search(/[\s/]/);
    const tag = space === -1 ? source : source.slice(0, space);
    if (!tag) {
      at = end + 1;
      continue;
    }

    const attrs: Record<string, string> = {};
    let style: [string, string][] = [];
    ATTR.lastIndex = space === -1 ? source.length : space;
    for (let m = ATTR.exec(source); m; m = ATTR.exec(source)) {
      const name = m[1];
      const value = decode(m[2] ?? m[3] ?? m[4] ?? "");
      if (name.toLowerCase() === "style") style = declarations(value);
      else attrs[name] = value;
    }

    const el: El = { tag, attrs, style, kids: [] };
    top().push(el);
    at = end + 1;

    if (source.endsWith("/") || VOID.has(lower(tag))) continue;

    if (RAW_TEXT.has(lower(tag))) {
      const close = html.toLowerCase().indexOf(`</${lower(tag)}`, at);
      const body = html.slice(at, close === -1 ? html.length : close);
      if (body) el.kids.push({ text: body });
      at = close === -1 ? html.length : html.indexOf(">", close) + 1;
      continue;
    }

    stack.push(el);
  }

  return roots;
};

/* ------------------------------------------------------------------ shared */

const px = (value: string): number | null => {
  /**
   * `clamp(44.64px,8vw,72px)` is a fluid size, and the design's own number is the last of the
   * three. There is no viewport here to resolve the middle against — SwiftUI, Flutter and
   * Compose are handed a fixed layout — so the ceiling, which is what the design was drawn at,
   * is the honest reading. Without it `parseFloat` stops at `clamp` and the box inherits
   * whatever its parent was set in.
   */
  const fluid = value.startsWith("clamp(")
    ? value.slice(6, -1).split(",").pop()
    : value;
  const n = Number.parseFloat(fluid ?? value);
  return Number.isFinite(n) ? n : null;
};

const round = (n: number) =>
  Number.isInteger(n)
    ? `${n}`
    : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");

const styleOf = (el: El, prop: string): string | undefined => {
  // Last wins, as in CSS.
  for (let i = el.style.length - 1; i >= 0; i -= 1) {
    if (el.style[i][0] === prop) return el.style[i][1];
  }
  return undefined;
};

const textOf = (node: Node): string =>
  isEl(node) ? node.kids.map(textOf).join("") : node.text;

/**
 * Text, back into markup.
 *
 * A newline becomes `&#10;` rather than staying literal, and that is the whole point: the text
 * runs here sit under `white-space: pre`, where every space is drawn. Left literal, the newline
 * survives but so does whatever indentation the serialiser puts after it, and every wrapped
 * heading gains a ragged left edge. As an entity it cannot be indented, cannot be collapsed by
 * Vue's `condense` and cannot be re-wrapped — it is the character, not whitespace in the source.
 */
const escapeText = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    // A brace is a template delimiter in two of the targets that share this serialiser: Svelte
    // reads `{` as the start of an expression and Vue reads `{{`, so a design with `{ }` in its
    // text — a code sample, a placeholder like `{name}` — produced a component that would not
    // compile. As an entity it is the character in every one of them, and `decode` above is
    // what reads it back. HTML and CSS draw `&#123;` as `{`, so nothing else changes.
    .replace(/\{/g, "&#123;")
    .replace(/\}/g, "&#125;")
    .replace(/\n/g, "&#10;");

/**
 * The same text for JSX, where a `{` opens an expression and a bare newline is folded away by
 * the compiler's own whitespace rules. Anything with a character JSX reads goes back as a
 * string expression, which has none of those rules.
 */
const jsxText = (text: string) =>
  /[{}<>&\n]/.test(text) ? `{${JSON.stringify(text)}}` : text;

/** Prefixes the first line only — interior newlines are content, not layout. */
const pad = (text: string, by: number) => " ".repeat(by) + text;

/** `rgba(0.5,…)` is never emitted — the mapper writes 0–255 — so a plain parse is enough. */
export const parseColor = (
  value: string,
): { r: number; g: number; b: number; a: number } | null => {
  const rgb = value.match(
    /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.%]+))?\s*\)/i,
  );
  if (rgb) {
    const alpha = rgb[4];
    return {
      r: Math.round(Number(rgb[1])),
      g: Math.round(Number(rgb[2])),
      b: Math.round(Number(rgb[3])),
      a:
        alpha === undefined
          ? 1
          : alpha.endsWith("%")
            ? Number.parseFloat(alpha) / 100
            : Number(alpha),
    };
  }
  const hex = value.trim().match(/^#([0-9a-f]{3,8})$/i);
  if (!hex) return null;
  let h = hex[1];
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
  const n = (i: number) => Number.parseInt(h.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
};

/**
 * The reset and the font links, as a stylesheet rather than a document.
 *
 * Every target below a whole HTML page needs the same two things `frameDocument` puts in the
 * head — the faces the design uses, and a body that is not zero-high because every node in it
 * is absolutely positioned.
 */
const globalCss = (
  fonts: UsedFont[] | undefined,
  size?: { width: number; height: number },
  /**
   * A whole document links its stylesheets from the head; a component has nowhere to put a
   * `<link>` and has to `@import`. Worth the branch: an `@import` is only discovered once the
   * sheet that holds it has parsed, so the faces arrive a round trip later and text renders
   * once in a fallback before swapping to the real family.
   */
  linked = false,
) =>
  [
    ...(linked
      ? []
      : fontUrls(fonts ?? []).map(({ url }) => `@import url("${url}");`)),
    /**
     * The uploaded faces, carried out with the design.
     *
     * **After** the `@import`s, never before: an `@import` is only honoured while nothing but
     * `@charset` and `@layer` precedes it, so a `@font-face` above one silently voids every
     * Google family in the file. The bytes ride along as base64, which is what makes an export
     * of a design set in an uploaded font render anywhere at all — there is no URL to point at.
     */
    fontFaces(fonts),
    `html, body { margin: 0; padding: 0; background: #fff;${
      size
        ? ` width: ${Math.ceil(size.width)}px; height: ${Math.ceil(size.height)}px;`
        : " overflow: hidden;"
    } }`,
    `* { -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; text-rendering: optimizeLegibility; }`,
    `input::placeholder { color: inherit; opacity: 1; }`,
  ]
    // `fontFaces` is "" for a design with no uploaded face, which would otherwise be a blank
    // line in the middle of every exported stylesheet.
    .filter(Boolean)
    .join("\n");

/**
 * A whole page, which is what two of these targets are.
 *
 * The head is the same for both — charset, viewport, title, the faces the design uses, the
 * reset — and only the stylesheet's body differs. The plain HTML target used to hand back the
 * canvas's own `srcDoc` instead: correct markup, no `<html>`, no `<head>`, no title, and every
 * node of the design on one 63,000-character line.
 */
const htmlDocument = ({
  title,
  fonts,
  size,
  style = [],
  body,
  tail = [],
}: {
  title: string;
  fonts?: UsedFont[];
  size?: { width: number; height: number };
  style?: string[];
  body: string;
  tail?: string[];
}) =>
  [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    `  <title>${escapeText(title)}</title>`,
    ...fontUrls(fonts ?? []).map(
      ({ url }) => `  <link rel="stylesheet" href="${url}">`,
    ),
    "  <style>",
    indent(globalCss(fonts, size, true), 4),
    ...style,
    "  </style>",
    "</head>",
    "<body>",
    body,
    ...tail,
    "</body>",
    "</html>",
  ].join("\n");

/**
 * Where an open tag stops fitting on one line — Prettier's own default.
 *
 * It earns its place here more than in most files: one absolutely-positioned box carries a
 * dozen declarations, so unwrapped tags ran to 1,300 characters and the copied file was a
 * horizontal scroll with no diff worth reading.
 */
const WIDTH = 100;

const wrapsAt = (depth: number, flat: string, count: number) =>
  count > 0 && depth * 2 + flat.length > WIDTH;

/**
 * An open tag, one attribute per line once it stops fitting.
 *
 * Safe wherever the text around it is preserved: whitespace *inside* a tag is not content in
 * either HTML or JSX, and the tag still ends on the same line its children begin.
 */
const openTagOf = (
  tag: string,
  attrs: string[],
  depth: number,
  close: ">" | " />" = ">",
  wrap = wrapsAt(depth, `<${tag}${attrs.join("")}${close}`, attrs.length),
) =>
  wrap
    ? [
        indent(`<${tag}`, depth * 2),
        // `pad`, not `indent`: an attribute can already be several lines — a broken-up style
        // object — and those lines carry their own indent.
        ...attrs.map((attr) => pad(attr.trimStart(), (depth + 1) * 2)),
        indent(close.trim(), depth * 2),
      ].join("\n")
    : indent(`<${tag}${attrs.join("")}${close}`, depth * 2);

/**
 * A subtree put back on one line, without joining two things that were never adjacent.
 *
 * A node whose whitespace is preserved cannot carry the serialiser's own newlines — under
 * `white-space: pre` an indent is content — so its children are flattened. Stripping every
 * `\n` and the indent after it is right *between* nodes and wrong **inside a tag**: an open
 * tag long enough to wrap puts each attribute on its own line, and collapsing that gave
 * `<inputtype="text"placeholder="…">`. Which is not an `<input>` with attributes, it is an
 * element called `inputtype` — silently, in every DOM target, and fatally in Svelte, whose
 * parser stops at `tag_invalid_name`. Five of the eighteen corpus fixtures produced a
 * component that would not compile.
 *
 * So: nothing where a `>` ends or a `<` begins, and a single space anywhere else, which is the
 * separator the newline was standing in for. Never content — a newline that is content is
 * written `&#10;` by `escapeText`, precisely so this cannot reach it.
 */
const flatten = (markup: string): string =>
  markup.replace(/\n[ \t]*/g, (run, at: number, whole: string) =>
    whole[at - 1] === ">" || whole[at + run.length] === "<" ? "" : " ",
  );

const indent = (text: string, by: number) =>
  text
    .split("\n")
    .map((line) => (line ? " ".repeat(by) + line : line))
    .join("\n");

/** A note collector with the mapper's own habit: one line per kind, counted, never a list. */
const reporter = () => {
  const counts = new Map<string, number>();
  return {
    note: (what: string) => counts.set(what, (counts.get(what) ?? 0) + 1),
    notes: () =>
      [...counts].map(([what, n]) => (n === 1 ? what : `${what} ×${n}`)),
  };
};

/* --------------------------------------------------------------- DOM targets */

const serializeHtml = (
  nodes: Node[],
  depth: number,
  preserve = false,
): string =>
  nodes
    .map((node) => {
      if (!isEl(node)) return pad(escapeText(node.text), depth * 2);
      const keeps = preservesWhitespace(node, preserve);
      const attrs = Object.entries(node.attrs).map(
        ([k, v]) => ` ${k}="${v.replace(/"/g, "&quot;")}"`,
      );
      if (node.style.length)
        attrs.push(
          ` style="${node.style.map(([p, v]) => `${p}: ${v}`).join("; ")}"`,
        );
      // Already indented, and already ending in the `>` its children follow.
      const open = openTagOf(node.tag, attrs, depth);
      if (VOID.has(lower(node.tag))) return open;
      if (!node.kids.length) return `${open}</${node.tag}>`;
      if (node.kids.every((k) => !isEl(k))) {
        // `style` holds CSS, not markup: escaping it would turn `>` in a selector into `&gt;`.
        const text = node.kids.map(textOf).join("");
        return `${open}${RAW_TEXT.has(lower(node.tag)) ? text : escapeText(text)}</${node.tag}>`;
      }
      if (isTight(node) || keeps) {
        return `${open}${flatten(serializeHtml(node.kids, 0, keeps))}</${node.tag}>`;
      }
      return `${open}\n${serializeHtml(node.kids, depth + 1, keeps)}\n${indent(`</${node.tag}>`, depth * 2)}`;
    })
    .join("\n");

/** JSX renames every kebab attribute except the two families that stay as authored. */
const jsxAttr = (name: string): string => {
  const key = name.toLowerCase();
  if (key === "class") return "className";
  if (key === "for") return "htmlFor";
  if (key.startsWith("data-") || key.startsWith("aria-")) return name;
  if (key === "xmlns" || !name.includes("-")) return name;
  return name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
};

/**
 * A style object, broken one declaration per line once it stops fitting.
 *
 * `depth` is the indent of the `style=` attribute itself, and passing none keeps it on one
 * line: the caller decides, because whether the tag wrapped is what settles where this sits.
 */
const jsxStyle = (style: [string, string][], depth?: number): string => {
  const entries = style.map(([prop, value]) => {
    const key = prop.startsWith("-")
      ? // `-webkit-mask-image` is `WebkitMaskImage`: the leading dash capitalises too.
        prop
          .slice(1)
          .replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
          .replace(/^./, (c) => c.toUpperCase())
      : prop.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    return `${/^[A-Za-z_$][\w$]*$/.test(key) ? key : `"${key}"`}: ${JSON.stringify(value)}`;
  });
  const flat = `{{ ${entries.join(", ")} }}`;
  if (depth === undefined || depth * 2 + flat.length <= WIDTH) return flat;
  return [
    "{{",
    ...entries.map((entry) => indent(`${entry},`, (depth + 1) * 2)),
    indent("}}", depth * 2),
  ].join("\n");
};

const serializeJsx = (nodes: Node[], depth: number): string =>
  nodes
    .map((node) => {
      // `{` and `}` in text open an expression in JSX; the mapper's own escaping is undone by
      // the parser, so it has to go back on here rather than being left to survive the trip.
      if (!isEl(node)) return pad(jsxText(node.text), depth * 2);
      const attrs = Object.entries(node.attrs).map(
        ([k, v]) => ` ${jsxAttr(k)}=${JSON.stringify(v)}`,
      );
      const empty = VOID.has(lower(node.tag)) || !node.kids.length;
      const close = empty ? " />" : ">";
      // Measured flat first: whether the tag wraps is what tells the style object where it sits,
      // and the object's own line breaks would otherwise be measured as part of the tag.
      const flat = `<${node.tag}${attrs.join("")}${node.style.length ? ` style=${jsxStyle(node.style)}` : ""}${close}`;
      const wrap = wrapsAt(
        depth,
        flat,
        attrs.length + (node.style.length ? 1 : 0),
      );
      const parts = node.style.length
        ? [
            ...attrs,
            ` style=${jsxStyle(node.style, wrap ? depth + 1 : undefined)}`,
          ]
        : attrs;
      const open = openTagOf(node.tag, parts, depth, close, wrap);
      if (empty) return open;
      if (node.kids.every((k) => !isEl(k))) {
        return `${open}${jsxText(node.kids.map(textOf).join(""))}</${node.tag}>`;
      }
      if (isTight(node)) {
        return `${open}${flatten(serializeJsx(node.kids, 0))}</${node.tag}>`;
      }
      return `${open}\n${serializeJsx(node.kids, depth + 1)}\n${indent(`</${node.tag}>`, depth * 2)}`;
    })
    .join("\n");

/**
 * Inline styles, lifted into classes.
 *
 * Keyed on the declarations themselves, so the hundred boxes of a repeating tile that carry the
 * same rule share one class instead of a hundred identical ones.
 */
const extractCss = (nodes: Node[]) => {
  const classOf = new Map<string, string>();
  const rules: string[] = [];

  const walk = (list: Node[]) => {
    for (const node of list) {
      if (!isEl(node)) continue;
      if (node.style.length) {
        const key = node.style.map(([p, v]) => `${p}:${v}`).join(";");
        let name = classOf.get(key);
        if (!name) {
          name = `f${classOf.size}`;
          classOf.set(key, name);
          rules.push(
            `.${name} {\n${node.style.map(([p, v]) => `  ${p}: ${v};`).join("\n")}\n}`,
          );
        }
        node.attrs.class = node.attrs.class
          ? `${node.attrs.class} ${name}`
          : name;
        node.style = [];
      }
      walk(node.kids);
    }
  };

  walk(nodes);
  return rules;
};

/* ---------------------------------------------------------- Tailwind target */

const TW_KEYWORD: Record<string, Record<string, string>> = {
  position: {
    absolute: "absolute",
    relative: "relative",
    fixed: "fixed",
    static: "static",
  },
  display: {
    flex: "flex",
    block: "block",
    none: "hidden",
    "inline-block": "inline-block",
    grid: "grid",
  },
  "flex-direction": {
    row: "flex-row",
    column: "flex-col",
    "row-reverse": "flex-row-reverse",
    "column-reverse": "flex-col-reverse",
  },
  "align-items": {
    "flex-start": "items-start",
    center: "items-center",
    "flex-end": "items-end",
    stretch: "items-stretch",
    baseline: "items-baseline",
  },
  "justify-content": {
    "flex-start": "justify-start",
    center: "justify-center",
    "flex-end": "justify-end",
    "space-between": "justify-between",
    "space-around": "justify-around",
  },
  "text-align": {
    left: "text-left",
    center: "text-center",
    right: "text-right",
    justify: "text-justify",
  },
  overflow: {
    hidden: "overflow-hidden",
    visible: "overflow-visible",
    auto: "overflow-auto",
    scroll: "overflow-scroll",
  },
  "white-space": {
    pre: "whitespace-pre",
    nowrap: "whitespace-nowrap",
    "pre-wrap": "whitespace-pre-wrap",
    normal: "whitespace-normal",
  },
  "font-style": { italic: "italic", normal: "not-italic" },
  "pointer-events": {
    none: "pointer-events-none",
    auto: "pointer-events-auto",
  },
  "text-decoration": {
    underline: "underline",
    "line-through": "line-through",
    none: "no-underline",
  },
  // `flex: none` and `box-sizing: border-box` are on every child of an inferred stack.
  flex: { none: "flex-none" },
  "box-sizing": { "border-box": "box-border", "content-box": "box-content" },
};

/** Properties whose value goes straight into `prefix-[value]`. */
const TW_ARBITRARY: Record<string, string> = {
  left: "left",
  top: "top",
  right: "right",
  bottom: "bottom",
  width: "w",
  height: "h",
  gap: "gap",
  opacity: "opacity",
  "border-radius": "rounded",
  "font-size": "text",
  "font-weight": "font",
  "line-height": "leading",
  "letter-spacing": "tracking",
  color: "text",
  "z-index": "z",
  "mix-blend-mode": "mix-blend",
  padding: "p",
  margin: "m",
  "margin-top": "mt",
};

const toTailwind = (style: [string, string][]) => {
  const classes: string[] = [];
  const left: [string, string][] = [];

  for (const [prop, value] of style) {
    const keyword = TW_KEYWORD[prop]?.[value];
    if (keyword) {
      classes.push(keyword);
      continue;
    }
    // `rgba(255, 255, 255, 1)` has spaces and an arbitrary value may not, but the spaces are
    // not part of the colour. Squeezed out it is the same paint and a legal class; left in, the
    // background of every frame in the design fell through to a style prop.
    const colour = parseColor(value) ? value.replace(/\s+/g, "") : value;
    const prefix = TW_ARBITRARY[prop];
    // An arbitrary value cannot hold a space and a `_` is not always the same thing (it is a
    // literal underscore inside a `url()`), so anything with one keeps its declaration. That is
    // every gradient, every shadow and every transform — by design, not by omission.
    if (prefix && !/[\s;]/.test(colour)) {
      classes.push(`${prefix}-[${colour}]`);
      continue;
    }
    if (
      (prop === "background" || prop === "background-color") &&
      !/[\s;]/.test(colour)
    ) {
      classes.push(`bg-[${colour}]`);
      continue;
    }
    left.push([prop, value]);
  }

  return { classes, left };
};

const serializeTailwind = (
  nodes: Node[],
  depth: number,
  stats: { moved: number; kept: number },
): string =>
  nodes
    .map((node) => {
      if (!isEl(node)) return pad(jsxText(node.text), depth * 2);
      // Inside an `<svg>` the attributes are geometry and `fill`/`stroke` are SVG paint, not
      // CSS — Tailwind has nothing to say about any of it, so the subtree passes through as JSX.
      const inSvg = lower(node.tag) === "svg";
      const { classes, left } = inSvg
        ? { classes: [], left: node.style }
        : toTailwind(node.style);
      stats.moved += classes.length;
      stats.kept += left.length;

      const attrs = Object.entries(node.attrs)
        .filter(([k]) => k.toLowerCase() !== "class")
        .map(([k, v]) => ` ${jsxAttr(k)}=${JSON.stringify(v)}`);
      const existing = node.attrs.class ? `${node.attrs.class} ` : "";
      if (classes.length || existing)
        attrs.push(` className="${existing}${classes.join(" ")}"`);
      const empty = VOID.has(lower(node.tag)) || !node.kids.length;
      const close = empty ? " />" : ">";
      const flat = `<${node.tag}${attrs.join("")}${left.length ? ` style=${jsxStyle(left)}` : ""}${close}`;
      const wrap = wrapsAt(depth, flat, attrs.length + (left.length ? 1 : 0));
      const parts = left.length
        ? [...attrs, ` style=${jsxStyle(left, wrap ? depth + 1 : undefined)}`]
        : attrs;
      const open = openTagOf(node.tag, parts, depth, close, wrap);

      if (inSvg) {
        return node.kids.length
          ? `${openTagOf(node.tag, parts, depth, ">", wrap)}\n${serializeJsx(node.kids, depth + 1)}\n${indent(`</${node.tag}>`, depth * 2)}`
          : openTagOf(node.tag, parts, depth, " />", wrap);
      }
      if (empty) return open;
      if (node.kids.every((k) => !isEl(k))) {
        return `${open}${jsxText(node.kids.map(textOf).join(""))}</${node.tag}>`;
      }
      if (isTight(node)) {
        return `${open}${flatten(serializeTailwind(node.kids, 0, stats))}</${node.tag}>`;
      }
      return `${open}\n${serializeTailwind(node.kids, depth + 1, stats)}\n${indent(`</${node.tag}>`, depth * 2)}`;
    })
    .join("\n");

/* ----------------------------------------------------------- native targets */

/**
 * What a native target cannot carry.
 *
 * Named individually rather than as "unsupported CSS", because which one it is decides whether
 * the result is usable: a dropped `letter-spacing` is a rounding error and a dropped
 * `mask-image` is the artwork.
 */
const UNSUPPORTED: [RegExp, string][] = [
  [/^mask-image$|^-webkit-mask-image$/, "mask dropped — no equivalent"],
  [
    /^mix-blend-mode$|^background-blend-mode$/,
    "blend mode dropped — no equivalent",
  ],
  [/^backdrop-filter$/, "backdrop blur dropped — no equivalent"],
  [/^filter$/, "filter dropped — no equivalent"],
  [/^clip-path$/, "clip path dropped — no equivalent"],
];

/**
 * The properties CSS inherits, carried down by hand.
 *
 * A text run is a `<span>` with no style of its own inside a box that carries the whole type
 * spec — so reading `font-size` off the element that holds the characters finds nothing, and
 * every heading came out at the 16pt default. There is no cascade here to do it for us.
 */
type Inherited = {
  fontSize: number | null;
  fontWeight: number | null;
  color: { r: number; g: number; b: number; a: number } | null;
};

type Pad = { top: number; right: number; bottom: number; left: number };

/**
 * One node, in the vocabulary the native targets share.
 *
 * `layout` is the field that matters. `figma-scene` writes an inferred auto-layout frame as a
 * flex container whose children are `position: relative` with **no** `left` or `top` — the
 * browser works those out. Read as absolute they are all (0, 0), so every stack in the design
 * collapsed into a pile at its own origin: the first SwiftUI render of a bento grid came out as
 * one card with two paragraphs written over each other, and every other card missing. A stack
 * has to stay a stack.
 */
type Box = {
  x: number;
  y: number;
  w: number | null;
  h: number | null;
  fill: { r: number; g: number; b: number; a: number } | null;
  radius: number;
  opacity: number;
  text: string;
  fontSize: number | null;
  fontWeight: number | null;
  color: { r: number; g: number; b: number; a: number } | null;
  /** `none` places children by coordinate; `row`/`column` let the stack do it. */
  layout: "none" | "row" | "column";
  gap: number;
  pad: Pad;
  /** `align-items`, the cross axis. */
  align: string;
  /** `justify-content`, the main axis. */
  justify: string;
  /** Out of flow: drawn over its parent's stack rather than in it. */
  absolute: boolean;
  kids: Box[];
};

/** `padding: 8px 12px` and its one-, three- and four-value forms. */
const padding = (value: string | undefined): Pad => {
  if (!value) return { top: 0, right: 0, bottom: 0, left: 0 };
  const n = value
    .trim()
    .split(/\s+/)
    .map((part) => px(part) ?? 0);
  if (!n.length) return { top: 0, right: 0, bottom: 0, left: 0 };
  const [a, b = a, c = a, d = b] = n;
  return { top: a, right: b, bottom: c, left: d };
};

const hasPad = (pad: Pad) => pad.top || pad.right || pad.bottom || pad.left;


/**
 * A responsive box, back to the pixel it resolves to.
 *
 * `figma-scene` states a child the way the design stated it — pinned to the right edge,
 * stretched between two, centred on the parent's midline, grown to fill a row — and each of
 * those is a number the *browser* works out. SwiftUI, Flutter and Compose have no such box:
 * they want x, y, w and h, and there is nothing downstream of here that could find them again.
 *
 * The parent's own resolved size is all it takes, and it is already being walked. Without this
 * a right-pinned node reads `left` as absent and lands at zero, and the design's own frame
 * reads `width:100%` as a hundred pixels — `parseFloat` stops at the digits and says nothing.
 */
const resolveAxis = (
  el: El,
  startProp: string,
  endProp: string,
  sizeProp: string,
  whole: number | null,
  /** The parent's padding on this axis: what a stretched child is sized to, less its own box. */
  inset = 0,
  /** `margin-inline` or `margin-block` — `auto` there is what centres an over-constrained box. */
  marginProp = "margin-inline",
): { at: number; size: number | null } => {
  const relative = (value: string): number | null =>
    whole === null ? null : (Number.parseFloat(value) / 100) * whole;

  const raw = styleOf(el, sizeProp);
  let size =
    raw === undefined || raw === "auto"
      ? null
      : raw.endsWith("%")
        ? relative(raw)
        : px(raw);
  // `auto` beside `align-self:stretch` is the mapper saying "as wide as the parent lets you",
  // which here is a number: the containing box, less the padding this axis sits between.
  if (size === null && raw === "auto" && whole !== null) size = whole - inset;
  // The root carries `width:100%` over the width it was drawn at; that is the width. A
  // percentage cap is not one: `max-width:100%` is on nearly every box and means "no wider
  // than what holds you", and `parseFloat` reads it as a hundred pixels.
  if (size === null) {
    const cap = styleOf(el, `max-${sizeProp}`);
    size = cap === undefined || cap.endsWith("%") ? null : px(cap);
  }

  /**
   * The design's own offset, out of the guard around it — `unguarded` in `lib/css-parts.ts`.
   *
   * `figma-scene` writes `min(378px, max(0px, calc(100% - 684px)))` so a left-pinned box slides
   * back rather than off the edge of a phone, and `max(0px, calc(50% - 342px))` so a centred
   * one does not go negative. Both resolve to the design's number at the design's width, and
   * there is no viewport here to work either of them out — `parseFloat` stops at the letter
   * `m`. The properties panel needs the same read, which is why it is one function and not two.
   */
  const unguard = unguarded;

  const start = styleOf(el, startProp);
  const end = px(styleOf(el, endProp) ?? "");
  let at: number | null = null;
  if (start !== undefined) {
    const bare = unguard(start);
    const centred = /^calc\(\s*50%\s*([+-])\s*([\d.]+)px\s*\)$/.exec(bare);
    if (centred && whole !== null) {
      at = whole / 2 + Number.parseFloat(`${centred[1]}${centred[2]}`);
    } else if (bare.endsWith("%")) {
      at = relative(bare);
    } else {
      at = px(bare);
    }
  }
  // Two edges and no size is a stretch; one edge and a size is a pin to the far side.
  if (size === null && at !== null && end !== null && whole !== null) {
    size = whole - at - end;
  } else if (at === null && end !== null && size !== null && whole !== null) {
    at = whole - end - size;
  } else if (
    at !== null &&
    end !== null &&
    size !== null &&
    whole !== null &&
    /auto/.test(styleOf(el, marginProp) ?? "")
  ) {
    // Both edges, a width, and an auto margin: over-constrained on purpose, and the margin is
    // what resolves it. That is how a centred box is written so a clamp keeps it centred, and
    // read as `left: 0` it lands hard against the edge instead of in the middle.
    at += (whole - at - end - size) / 2;
  }
  return { at: at ?? 0, size };
};

const toBoxes = (
  nodes: Node[],
  report: (what: string) => void,
  from: Inherited = { fontSize: null, fontWeight: null, color: null },
  /** The parent's own resolved size, which is what a percentage or a far-edge pin needs. */
  within: { w: number | null; h: number | null; pad?: Pad } = {
    w: null,
    h: null,
  },
): Box[] =>
  nodes.flatMap((node) => {
    if (!isEl(node)) return [];
    const tag = lower(node.tag);
    if (tag === "style" || tag === "link" || tag === "meta") return [];
    if (tag === "svg") {
      report("inline SVG dropped — vector artwork has no equivalent");
      return [];
    }
    if (tag === "img") {
      report("image left as a placeholder — bundle the asset yourself");
    }

    for (const [prop, value] of node.style) {
      for (const [pattern, what] of UNSUPPORTED) {
        if (pattern.test(prop)) report(what);
      }
      // A gradient or a texture is a paint the box model here cannot express as one colour.
      if (
        (prop === "background" || prop === "background-image") &&
        /gradient|url\(/i.test(value)
      ) {
        report("gradient or image fill flattened to a solid colour");
      }
    }

    const background =
      styleOf(node, "background") ?? styleOf(node, "background-color") ?? "";
    const own = textOf(node).trim();
    const hasElementKids = node.kids.some(isEl);

    const inherited: Inherited = {
      fontSize: px(styleOf(node, "font-size") ?? "") ?? from.fontSize,
      fontWeight: px(styleOf(node, "font-weight") ?? "") ?? from.fontWeight,
      color: parseColor(styleOf(node, "color") ?? "") ?? from.color,
    };

    // A text box is a flex container in the markup too — that is how the mapper centres a line
    // in its own box — but it holds characters, not children, and turning it into a stack would
    // wrap the string in an empty VStack.
    const flex = styleOf(node, "display") === "flex" && hasElementKids;

    /**
     * A CSS grid, back into the rows these targets can actually build.
     *
     * There is no grid in SwiftUI's, Flutter's or Compose's vocabulary here — only a row and a
     * column — and a grid's members have given their coordinates up to the tracks, so read as
     * absolute they all land on the origin. `data-grid-columns` says how wide the lattice is;
     * chunking by it gives a column of rows, which is the same picture. `order` is what the
     * mapper writes when the payload's z-order is not the reading order, so it is the sort.
     */
    const parsed = Number.parseInt(node.attrs["data-grid-columns"] ?? "", 10);
    // Not `NaN`: every comparison against it is false, so a plain flex row would read as
    // "not fewer than two columns" and stop being a stack at all.
    const columns = Number.isFinite(parsed) ? parsed : 0;

    const across = resolveAxis(
      node,
      "left",
      "right",
      "width",
      within.w,
      (within.pad?.left ?? 0) + (within.pad?.right ?? 0),
    );
    const down = resolveAxis(
      node,
      "top",
      "bottom",
      "height",
      within.h,
      (within.pad?.top ?? 0) + (within.pad?.bottom ?? 0),
      "margin-block",
    );
    const ownPad = padding(styleOf(node, "padding"));

    return [
      {
        x: across.at,
        y: down.at,
        w: across.size,
        h: down.size,
        fill: parseColor(background),
        radius: px(styleOf(node, "border-radius") ?? "0") ?? 0,
        opacity: px(styleOf(node, "opacity") ?? "1") ?? 1,
        text: hasElementKids ? "" : own,
        ...inherited,
        // A grid stays `none`: its members carry the coordinates `placed` just gave them back,
        // which is the same picture the absolute path drew and needs no stack to hold it.
        layout:
          flex && columns < 2 && !("data-column" in node.attrs)
            ? styleOf(node, "flex-direction") === "column"
              ? ("column" as const)
              : ("row" as const)
            : ("none" as const),
        gap: px(styleOf(node, "gap") ?? "0") ?? 0,
        pad: ownPad,
        align: styleOf(node, "align-items") ?? "flex-start",
        justify: styleOf(node, "justify-content") ?? "flex-start",
        absolute: styleOf(node, "position") === "absolute",
        kids: (() => {
          const kids = toBoxes(node.kids, report, inherited, {
            w: across.size,
            h: down.size,
            pad: ownPad,
          });
          return "data-column" in node.attrs
            ? stacked(kids, node.kids)
            : placed(
                kids,
                columns,
                gaps(styleOf(node, "gap")),
                node.kids,
                across.size,
              );
        })(),
      },
    ];
  });

/** `gap: 20px 24px` — the row gap then the column gap, and one value means both. */
const gaps = (value: string | undefined): [row: number, col: number] => {
  const parts = (value ?? "").trim().split(/\s+/).map((part) => px(part) ?? 0);
  return [parts[0] ?? 0, parts[1] ?? parts[0] ?? 0];
};

/**
 * The grid's members, back on the coordinates the tracks took off them.
 *
 * The lattice is fully described by what is already in the markup — how many columns, the two
 * gaps, and each member's own size — so the cell every member landed in is arithmetic, and the
 * arithmetic gives back exactly the `left`/`top` the absolute path used to write. `order` is
 * the reading order where the payload's z-order was not it, and the centring is the wrapper's
 * `padding-inline`, which is a `max(0px,calc(…))` no parser here is going to read: the same
 * number falls out of the tracks.
 */
const placed = (
  kids: Box[],
  columns: number,
  [rowGap, colGap]: [number, number],
  source: Node[],
  within: number | null,
): Box[] => {
  if (columns < 2 || !kids.length) return kids;
  const els = source.filter(isEl);
  const order = kids.map(
    (_, index) => px(styleOf(els[index], "order") ?? "") ?? index,
  );
  const cellW = kids[0].w ?? 0;
  const cellH = kids[0].h ?? 0;
  const inset = Math.max(
    0,
    ((within ?? 0) - (columns * cellW + (columns - 1) * colGap)) / 2,
  );
  return kids.map((box, index) => ({
    ...box,
    x: inset + (order[index] % columns) * (cellW + colGap),
    y: Math.floor(order[index] / columns) * (cellH + rowGap),
  }));
};

/**
 * A recovered column, back into coordinates.
 *
 * `figma-scene` writes a run of hand-stacked siblings as a flex column whose members carry
 * their offsets as margins — which is the design said as a layout, and unreadable to a target
 * with no flow in it: read as absolute every member lands on the wrapper's origin. The gaps
 * are not one number (that is the whole difference from a grid), so they are walked: each box
 * starts where the one before it ended, plus the air the mapper measured.
 */
const stacked = (kids: Box[], source: Node[]): Box[] => {
  const els = source.filter(isEl);
  let y = 0;
  return kids.map((box, index) => {
    const top = px(styleOf(els[index], "margin-top") ?? "") ?? 0;
    const at = y + top;
    y = at + (box.h ?? 0);
    return {
      ...box,
      x: px(styleOf(els[index], "margin-left") ?? "") ?? 0,
      y: at,
    };
  });
};

/** In-flow children go in the stack; the rest are drawn over it. */
const split = (box: Box) =>
  box.layout === "none"
    ? { flow: [] as Box[], over: box.kids }
    : {
        flow: box.kids.filter((kid) => !kid.absolute),
        over: box.kids.filter((kid) => kid.absolute),
      };

const MAIN: Record<string, string> = {
  "flex-start": "start",
  center: "center",
  "flex-end": "end",
  "space-between": "start",
};
const CROSS: Record<string, string> = {
  "flex-start": "start",
  center: "center",
  "flex-end": "end",
  stretch: "start",
  baseline: "start",
};

/* ------------------------------------------------------------------- SwiftUI */

const swiftColor = (c: { r: number; g: number; b: number; a: number }) =>
  `Color(red: ${(c.r / 255).toFixed(3)}, green: ${(c.g / 255).toFixed(3)}, blue: ${(
    c.b / 255
  ).toFixed(3)}${c.a < 1 ? `, opacity: ${c.a.toFixed(3)}` : ""})`;

const SWIFT_CROSS: Record<string, Record<string, string>> = {
  column: {
    "flex-start": ".leading",
    center: ".center",
    "flex-end": ".trailing",
  },
  row: { "flex-start": ".top", center: ".center", "flex-end": ".bottom" },
};

const SWIFT_ALIGN: Record<string, string> = {
  "top-leading": ".topLeading",
  "top-center": ".top",
  "top-trailing": ".topTrailing",
  "center-leading": ".leading",
  "center-center": ".center",
  "center-trailing": ".trailing",
  "bottom-leading": ".bottomLeading",
  "bottom-center": ".bottom",
  "bottom-trailing": ".bottomTrailing",
};

/**
 * `justify-content` and `align-items` together, as a `frame` alignment.
 *
 * A stack sizes itself to its content, so what decides where that content sits inside a box of
 * the design's own dimensions is the alignment on the `frame` around it — main axis from
 * `justify-content`, cross axis from `align-items`.
 */
const swiftFrameAlign = (box: Box): string => {
  if (box.layout === "none") return ".topLeading";
  const main = MAIN[box.justify] ?? "start";
  const cross = CROSS[box.align] ?? "start";
  const pick = (side: string, a: string, b: string) =>
    side === "start" ? a : side === "end" ? b : "center";
  const [v, h] =
    box.layout === "column"
      ? [pick(main, "top", "bottom"), pick(cross, "leading", "trailing")]
      : [pick(cross, "top", "bottom"), pick(main, "leading", "trailing")];
  return SWIFT_ALIGN[`${v}-${h}`] ?? ".topLeading";
};

/**
 * A `ViewBuilder` block takes at most ten children.
 *
 * An eleventh is not a warning, it is "extra argument in call" — and a hero frame with fourteen
 * layers in it is ordinary. `Group` is itself a view, so nesting them raises the ceiling without
 * changing what is drawn or how it is laid out.
 */
const swiftList = (views: string[]): string => {
  if (views.length <= 10) return views.join("\n");
  const groups: string[] = [];
  for (let i = 0; i < views.length; i += 10) {
    groups.push(`Group {\n${indent(views.slice(i, i + 10).join("\n"), 2)}\n}`);
  }
  return swiftList(groups);
};

/**
 * Every node as its own `View`, rather than one expression the depth of the design.
 *
 * SwiftUI's builders are generic in each of their children, so a nested body's type is the whole
 * subtree written out — and inference over it is superlinear. Inlined, one 1,400-node fixture did
 * not finish type-checking in **nine minutes**; the error a real project sees is "unable to
 * type-check this expression in reasonable time", which names no line worth reading. Split into
 * a struct per node every body is three or four views deep and the same file builds in seconds.
 */
const swiftProgram = (
  boxes: Box[],
  root: string,
  size?: { width: number; height: number },
): string => {
  const structs: string[] = [];
  let next = 0;

  const emit = (box: Box): string => {
    const id = `Node${next++}`;
    const { flow, over } = split(box);
    const lines: string[] = [];

    if (box.text) {
      const weight =
        (box.fontWeight ?? 400) >= 700
          ? ".bold"
          : (box.fontWeight ?? 400) >= 500
            ? ".medium"
            : ".regular";
      lines.push(`Text(${JSON.stringify(box.text)})`);
      lines.push(
        `  .font(.system(size: ${round(box.fontSize ?? 16)}, weight: ${weight}))`,
      );
      if (box.color) lines.push(`  .foregroundColor(${swiftColor(box.color)})`);
      lines.push(`  .fixedSize(horizontal: false, vertical: true)`);
    } else if (box.layout === "none") {
      const body = box.kids.length
        ? indent(swiftList(box.kids.map(emit)), 2)
        : "";
      lines.push(
        `ZStack(alignment: .topLeading) {${body ? `\n${body}\n` : ""}}`,
      );
    } else {
      // `space-between` is Spacers, not an alignment: it is the *gaps* that grow, and a frame
      // alignment can only move the block as a whole.
      const parts = flow.map(emit);
      const spread = box.justify === "space-between" && parts.length > 1;
      const body = indent(
        swiftList(
          spread
            ? parts.flatMap((part, i) =>
                i ? ["Spacer(minLength: 0)", part] : [part],
              )
            : parts,
        ),
        2,
      );
      const stack = box.layout === "column" ? "VStack" : "HStack";
      const cross =
        SWIFT_CROSS[box.layout][box.align] ??
        SWIFT_CROSS[box.layout]["flex-start"];
      lines.push(
        `${stack}(alignment: ${cross}, spacing: ${round(
          spread ? 0 : box.gap,
        )}) {${body ? `\n${body}\n` : ""}}`,
      );
    }

    if (hasPad(box.pad)) {
      lines.push(
        `  .padding(EdgeInsets(top: ${round(box.pad.top)}, leading: ${round(
          box.pad.left,
        )}, bottom: ${round(box.pad.bottom)}, trailing: ${round(box.pad.right)}))`,
      );
    }
    if (box.w !== null || box.h !== null) {
      const parts = [
        box.w !== null ? `width: ${round(box.w)}` : "",
        box.h !== null ? `height: ${round(box.h)}` : "",
        `alignment: ${swiftFrameAlign(box)}`,
      ].filter(Boolean);
      lines.push(`  .frame(${parts.join(", ")})`);
    }
    if (box.fill && box.fill.a > 0)
      lines.push(`  .background(${swiftColor(box.fill)})`);
    if (box.radius > 0) lines.push(`  .cornerRadius(${round(box.radius)})`);
    if (box.opacity < 1) lines.push(`  .opacity(${box.opacity})`);
    // The out-of-flow children ride on top, positioned against this box's own corner.
    if (box.layout !== "none" && over.length) {
      lines.push(
        `  .overlay(alignment: .topLeading) {\n${indent(
          swiftList(over.map(emit)),
          4,
        )}\n  }`,
      );
    }
    /**
     * `.offset` only where a coordinate is what places it.
     *
     * A stack's child is placed by the stack. Offsetting it as well shifts it out of the slot the
     * stack just gave it — and a flex child carries no `left`/`top` at all, so what it would be
     * offset by is the CSS default rather than where the browser put it. `.offset` after
     * `.frame` besides: SwiftUI applies modifiers outwards, so offsetting first would move the
     * box and then size the moved result from the origin again.
     */
    if (box.absolute || box.x || box.y) {
      lines.push(`  .offset(x: ${round(box.x)}, y: ${round(box.y)})`);
    }

    structs.push(
      `private struct ${id}: View {\n  var body: some View {\n${indent(
        lines.join("\n"),
        4,
      )}\n  }\n}`,
    );
    return `${id}()`;
  };

  const top = swiftList(boxes.map(emit));

  return [
    // SwiftUI is macOS 10.15 / iOS 13, and SwiftPM still defaults a package to macOS 10.13
    // — where the module resolves to nothing and the error names the import rather than the
    // deployment target. One line here is cheaper than that diagnosis.
    "// Requires macOS 10.15+ / iOS 13+.",
    "// In a Swift package add: platforms: [.macOS(.v14)] — without it SwiftPM targets",
    "// macOS 10.13 and this fails with \"no such module 'SwiftUI'\".",
    "import SwiftUI",
    "",
    `struct ${root}: View {`,
    "  var body: some View {",
    "    ZStack(alignment: .topLeading) {",
    indent(top, 6),
    "    }",
    size
      ? `    .frame(width: ${round(size.width)}, height: ${round(
          size.height,
        )}, alignment: .topLeading)`
      : "",
    "  }",
    "}",
    "",
    structs.join("\n\n"),
  ]
    .filter((line) => line !== "")
    .join("\n");
};

/* -------------------------------------------------------------------- Flutter */

const dartColor = (c: { r: number; g: number; b: number; a: number }) =>
  `Color(0x${Math.round(c.a * 255)
    .toString(16)
    .padStart(2, "0")}${[c.r, c.g, c.b]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("")})`;

const DART_MAIN: Record<string, string> = {
  "flex-start": "MainAxisAlignment.start",
  center: "MainAxisAlignment.center",
  "flex-end": "MainAxisAlignment.end",
  "space-between": "MainAxisAlignment.spaceBetween",
  "space-around": "MainAxisAlignment.spaceAround",
  "space-evenly": "MainAxisAlignment.spaceEvenly",
};
const DART_CROSS: Record<string, string> = {
  "flex-start": "CrossAxisAlignment.start",
  center: "CrossAxisAlignment.center",
  "flex-end": "CrossAxisAlignment.end",
  stretch: "CrossAxisAlignment.stretch",
  baseline: "CrossAxisAlignment.baseline",
};

const flutterBody = (box: Box): string => {
  const { flow, over } = split(box);

  if (box.text) {
    return `Text(\n  ${JSON.stringify(box.text)},\n  style: TextStyle(\n    fontSize: ${round(
      box.fontSize ?? 16,
    )},\n    fontWeight: FontWeight.w${
      Math.round((box.fontWeight ?? 400) / 100) * 100
    },${box.color ? `\n    color: ${dartColor(box.color)},` : ""}\n  ),\n)`;
  }

  if (box.layout === "none") {
    return box.kids.length
      ? `Stack(\n  children: [\n${indent(flutterBoxes(box.kids), 4)}\n  ],\n)`
      : "";
  }

  const widget = box.layout === "column" ? "Column" : "Row";
  // Flutter has no `gap`, so the spacing is a widget between every pair.
  const spacer =
    box.gap > 0
      ? box.layout === "column"
        ? `SizedBox(height: ${round(box.gap)}),`
        : `SizedBox(width: ${round(box.gap)}),`
      : "";
  const parts = flow.flatMap((kid, i) =>
    i && spacer ? [spacer, `${flutterBox(kid)},`] : [`${flutterBox(kid)},`],
  );
  const stack = [
    `${widget}(`,
    `  mainAxisSize: MainAxisSize.min,`,
    `  mainAxisAlignment: ${DART_MAIN[box.justify] ?? DART_MAIN["flex-start"]},`,
    `  crossAxisAlignment: ${DART_CROSS[box.align] ?? DART_CROSS["flex-start"]},`,
    `  children: [`,
    indent(parts.join("\n"), 4),
    `  ],`,
    `)`,
  ].join("\n");

  return over.length
    ? `Stack(\n  children: [\n${indent(`${stack},`, 4)}\n${indent(
        flutterBoxes(over),
        4,
      )}\n  ],\n)`
    : stack;
};

const flutterBox = (box: Box): string => {
  const child = flutterBody(box);

  const decoration = [
    box.fill && box.fill.a > 0 ? `color: ${dartColor(box.fill)}` : "",
    box.radius > 0
      ? `borderRadius: BorderRadius.circular(${round(box.radius)})`
      : "",
  ].filter(Boolean);

  const container = [
    "Container(",
    box.w !== null ? `  width: ${round(box.w)},` : "",
    box.h !== null ? `  height: ${round(box.h)},` : "",
    hasPad(box.pad)
      ? `  padding: EdgeInsets.only(top: ${round(box.pad.top)}, right: ${round(
          box.pad.right,
        )}, bottom: ${round(box.pad.bottom)}, left: ${round(box.pad.left)}),`
      : "",
    decoration.length
      ? `  decoration: BoxDecoration(${decoration.join(", ")}),`
      : "",
    child ? `  child: ${indent(child, 2).trimStart()},` : "",
    ")",
  ]
    .filter(Boolean)
    .join("\n");

  const wrapped =
    box.opacity < 1
      ? `Opacity(\n  opacity: ${box.opacity},\n  child: ${indent(
          container,
          2,
        ).trimStart()},\n)`
      : container;

  // Only an out-of-flow box is `Positioned`; inside a Row or Column that widget is illegal and
  // the framework throws at build time rather than laying it out wrongly.
  return box.absolute
    ? `Positioned(\n  left: ${round(box.x)},\n  top: ${round(
        box.y,
      )},\n  child: ${indent(wrapped, 2).trimStart()},\n)`
    : wrapped;
};

const flutterBoxes = (boxes: Box[]) =>
  boxes.map((box) => `${flutterBox(box)},`).join("\n");

/* -------------------------------------------------------------------- Compose */

const composeColor = (c: { r: number; g: number; b: number; a: number }) =>
  `Color(0x${Math.round(c.a * 255)
    .toString(16)
    .padStart(2, "0")}${[c.r, c.g, c.b]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("")})`;

const KT_MAIN: Record<string, string> = {
  "flex-start": "Arrangement.Start",
  center: "Arrangement.Center",
  "flex-end": "Arrangement.End",
  "space-between": "Arrangement.SpaceBetween",
  "space-around": "Arrangement.SpaceAround",
  "space-evenly": "Arrangement.SpaceEvenly",
};
const KT_CROSS: Record<string, Record<string, string>> = {
  column: {
    "flex-start": "Alignment.Start",
    center: "Alignment.CenterHorizontally",
    "flex-end": "Alignment.End",
  },
  row: {
    "flex-start": "Alignment.Top",
    center: "Alignment.CenterVertically",
    "flex-end": "Alignment.Bottom",
  },
};

const composeBox = (box: Box): string => {
  const { flow, over } = split(box);

  const modifier = [
    box.absolute || box.x || box.y
      ? `Modifier.offset(x = ${round(box.x)}.dp, y = ${round(box.y)}.dp)`
      : "Modifier",
    box.w !== null && box.h !== null
      ? `  .size(width = ${round(box.w)}.dp, height = ${round(box.h)}.dp)`
      : box.w !== null
        ? `  .width(${round(box.w)}.dp)`
        : box.h !== null
          ? `  .height(${round(box.h)}.dp)`
          : "",
    box.opacity < 1 ? `  .alpha(${box.opacity}f)` : "",
    // The shape rides on `background`, because a clip after it would round the box and leave
    // the fill square underneath.
    box.fill && box.fill.a > 0
      ? `  .background(${composeColor(box.fill)}${
          box.radius > 0 ? `, RoundedCornerShape(${round(box.radius)}.dp)` : ""
        })`
      : box.radius > 0
        ? `  .clip(RoundedCornerShape(${round(box.radius)}.dp))`
        : "",
    // Padding goes inside the background, as it does in CSS.
    hasPad(box.pad)
      ? `  .padding(start = ${round(box.pad.left)}.dp, top = ${round(
          box.pad.top,
        )}.dp, end = ${round(box.pad.right)}.dp, bottom = ${round(
          box.pad.bottom,
        )}.dp)`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  if (box.text) {
    return `Text(\n  text = ${JSON.stringify(box.text)},\n  fontSize = ${round(
      box.fontSize ?? 16,
    )}.sp,\n  fontWeight = FontWeight(${Math.round(box.fontWeight ?? 400)}),${
      box.color ? `\n  color = ${composeColor(box.color)},` : ""
    }\n  modifier = ${indent(modifier, 2).trimStart()}\n)`;
  }

  if (box.layout === "none") {
    return `Box(modifier = ${indent(modifier, 2).trimStart()}) {${
      box.kids.length ? `\n${indent(composeBoxes(box.kids), 2)}\n` : ""
    }}`;
  }

  const widget = box.layout === "column" ? "Column" : "Row";
  const arrange =
    box.layout === "column" ? "verticalArrangement" : "horizontalArrangement";
  const cross =
    box.layout === "column" ? "horizontalAlignment" : "verticalAlignment";
  // `spacedBy` carries the gap, unless the arrangement is already spreading the children out.
  const spread =
    box.justify === "space-between" ||
    box.justify === "space-around" ||
    box.justify === "space-evenly";
  const main = spread
    ? KT_MAIN[box.justify]
    : box.gap > 0
      ? `Arrangement.spacedBy(${round(box.gap)}.dp, ${
          KT_MAIN[box.justify] ?? KT_MAIN["flex-start"]
        })`
      : (KT_MAIN[box.justify] ?? KT_MAIN["flex-start"]);

  const stack = [
    `${widget}(`,
    `  modifier = ${indent(modifier, 2).trimStart()},`,
    `  ${arrange} = ${main},`,
    `  ${cross} = ${
      KT_CROSS[box.layout][box.align] ?? KT_CROSS[box.layout]["flex-start"]
    },`,
    `) {`,
    indent(composeBoxes(flow), 2),
    `}`,
  ].join("\n");

  return over.length
    ? `Box {\n${indent(stack, 2)}\n${indent(composeBoxes(over), 2)}\n}`
    : stack;
};

const composeBoxes = (boxes: Box[]) => boxes.map(composeBox).join("\n");

/* ------------------------------------------------------------------ exports */

export type Exported = {
  code: string;
  /** What the rewrite could not carry. Empty for every DOM-preserving target. */
  notes: string[];
};

const componentName = (title: string) => {
  const name = title
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  return /^[A-Za-z]/.test(name) ? name : `Frame${name}`;
};

/**
 * What a target's file is called on disk.
 *
 * Only a download needs it — the clipboard has no filename — so it sits beside `TARGETS`
 * rather than inside them: nine more lines in the array to say what nine short strings say
 * here. `css` and `html` are both one document; the difference is where the declarations live.
 */
const FILE: Record<TargetId, string> = {
  html: "index.html",
  css: "index.html",
  jsx: "$.jsx",
  tailwind: "$.jsx",
  vue: "$.vue",
  svelte: "$.svelte",
  swiftui: "$.swift",
  flutter: "$.dart",
  compose: "$.kt",
};

/** `Frame.vue` — the component's own name, or the fixed one for the whole-document targets. */
export const entryName = (target: TargetId, title: string) =>
  FILE[target].replace("$", componentName(title || "Frame"));

export const exportAs = (
  target: TargetId,
  scene: {
    html: string;
    fonts?: UsedFont[];
    size?: { width: number; height: number };
    title?: string;
  },
): Exported => {
  const name = componentName(scene.title || "Frame");

  const tree = parseScene(scene.html);
  const css = globalCss(scene.fonts, scene.size);

  const page = scene.title || name;

  switch (target) {
    case "html":
      return {
        code: htmlDocument({
          title: page,
          fonts: scene.fonts,
          size: scene.size,
          body: serializeHtml(tree, 1),
          // The fitter the canvas runs over every frame. A design's own face is not always
          // fetchable — a foundry trial, a licensed family — and every consequence of the
          // substitution is a layout bug rather than a typographic one. See `lib/fit-text.ts`.
          tail: [indent(fitScript(), 2)],
        }),
        notes: [],
      };

    case "css": {
      const rules = extractCss(tree);
      return {
        code: htmlDocument({
          title: page,
          fonts: scene.fonts,
          size: scene.size,
          style: ["", indent(rules.join("\n\n"), 4)],
          body: serializeHtml(tree, 1),
        }),
        notes: [],
      };
    }

    case "jsx":
      return {
        code: [
          `const styles = \`\n${indent(css, 2)}\n\`;`,
          "",
          `export default function ${name}() {`,
          "  return (",
          // A fragment, not two roots: the reset has to ship with the markup, and a component
          // returning a `<style>` beside a `<div>` is a syntax error.
          "    <>",
          "      <style>{styles}</style>",
          indent(serializeJsx(tree, 0), 6),
          "    </>",
          "  );",
          "}",
        ].join("\n"),
        notes: [],
      };

    case "tailwind": {
      const stats = { moved: 0, kept: 0 };
      const body = serializeTailwind(tree, 0, stats);
      return {
        code: [
          `const styles = \`\n${indent(css, 2)}\n\`;`,
          "",
          `export default function ${name}() {`,
          "  return (",
          "    <>",
          "      <style>{styles}</style>",
          indent(body, 6),
          "    </>",
          "  );",
          "}",
        ].join("\n"),
        notes: stats.kept
          ? [
              `${stats.kept} declaration${stats.kept === 1 ? "" : "s"} kept in a style prop — a gradient, shadow or transform has no arbitrary-value spelling`,
            ]
          : [],
      };
    }

    case "vue":
      return {
        code: [
          "<template>",
          serializeHtml(tree, 1),
          "</template>",
          "",
          "<style>",
          css,
          "</style>",
        ].join("\n"),
        notes: [],
      };

    case "svelte":
      return {
        code: [
          serializeHtml(tree, 0),
          "",
          "<style>",
          // Svelte scopes every selector to the component and prunes what it thinks is unused,
          // which would drop `html`, `body` and `*` outright. `:global` is the only way these
          // survive the compiler.
          indent(
            css
              .split("\n")
              .map((line) =>
                line.startsWith("@import") || !line.includes("{")
                  ? line
                  : line.replace(
                      /^([^{]+)\{/,
                      (_, sel: string) => `:global(${sel.trim()}) {`,
                    ),
              )
              .join("\n"),
            2,
          ),
          "</style>",
        ].join("\n"),
        notes: [],
      };

    case "swiftui": {
      const { note, notes } = reporter();
      return {
        code: swiftProgram(toBoxes(tree, note), name, scene.size),
        notes: notes(),
      };
    }

    case "flutter": {
      const { note, notes } = reporter();
      const boxes = toBoxes(tree, note);
      return {
        code: [
          "import 'package:flutter/material.dart';",
          "",
          `class ${name} extends StatelessWidget {`,
          `  const ${name}({super.key});`,
          "",
          "  @override",
          "  Widget build(BuildContext context) {",
          "    return SizedBox(",
          scene.size ? `      width: ${round(scene.size.width)},` : "",
          scene.size ? `      height: ${round(scene.size.height)},` : "",
          "      child: Stack(",
          "        children: [",
          indent(flutterBoxes(boxes), 10),
          "        ],",
          "      ),",
          "    );",
          "  }",
          "}",
        ]
          .filter(Boolean)
          .join("\n"),
        notes: notes(),
      };
    }

    case "compose": {
      const { note, notes } = reporter();
      const boxes = toBoxes(tree, note);
      return {
        code: [
          "import androidx.compose.foundation.background",
          "import androidx.compose.foundation.layout.*",
          "import androidx.compose.foundation.shape.RoundedCornerShape",
          "import androidx.compose.material3.Text",
          "import androidx.compose.runtime.Composable",
          "import androidx.compose.ui.Modifier",
          "import androidx.compose.ui.draw.alpha",
          "import androidx.compose.ui.draw.clip",
          "import androidx.compose.ui.graphics.Color",
          "import androidx.compose.ui.text.font.FontWeight",
          "import androidx.compose.ui.unit.dp",
          "import androidx.compose.ui.unit.sp",
          "",
          "@Composable",
          `fun ${name}() {`,
          scene.size
            ? `  Box(modifier = Modifier.size(width = ${round(scene.size.width)}.dp, height = ${round(scene.size.height)}.dp)) {`
            : "  Box {",
          indent(composeBoxes(boxes), 4),
          "  }",
          "}",
        ].join("\n"),
        notes: notes(),
      };
    }
  }
};
