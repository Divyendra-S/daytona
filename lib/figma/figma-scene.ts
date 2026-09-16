import type { SnapshotNode } from "./protocol";

import { symbolIdOf, type FigmaNode } from "./figma-clipboard";
import { networkToPaths, parseVectorNetwork } from "./figma-vector";
import { googleFamily } from "./figma-paste";

/**
 * The decoded payload, rendered.
 *
 * Absolute boxes, because that is what the payload already is: every node carries its own size
 * and a 2×3 affine relative to its parent, so there is no layout to run — the positions are
 * given. That is most of why a paste can be instant.
 *
 * Frames, rectangles, ellipses, solid fills, gradients, strokes, corner radii, single-style
 * text — and vector artwork, drawn from the network blobs the payload carries beside the tree
 * (see `figma-vector.ts`). Everything else is placed at its correct bounds and **reported**, never
 * dropped — a node that silently vanishes is the failure that destroys trust in every paste
 * before it, so `unmapped` and `approximated` come back with the HTML and belong on screen.
 */

type Color = { r: number; g: number; b: number; a: number };
type Paint = {
  type?: string;
  color?: Color;
  opacity?: number;
  visible?: boolean;
  /** A paint blends with the ones below it, which is `background-blend-mode` in CSS. */
  blendMode?: string;
  stops?: { color: Color; position: number }[];
  /** IMAGE paints: a 20-byte content hash, and how it fills the box. */
  image?: { hash?: Uint8Array };
  /** The same hash, and all the payload carries when the full paint was never loaded. */
  imageThumbnail?: { hash?: Uint8Array };
  imageScaleMode?: string;
  /** TILE paints: the tile is the source at this scale, not at its own size. */
  scale?: number;
  originalImageWidth?: number;
  originalImageHeight?: number;
  rotation?: number;
  /** GRADIENT paints: the 2×3 affine mapping gradient space into the shape's unit square. */
  transform?: {
    m00: number;
    m01: number;
    m02: number;
    m10: number;
    m11: number;
    m12: number;
  };
};

export type SceneOptions = {
  /** The payload's blob table: where vector geometry actually lives. */
  blobs?: { bytes: Uint8Array }[];
  /** Turns an image ref (the 40-hex content hash) into a URL. See `api/figma/image`. */
  image?: (ref: string) => string | null;
  /** Components by guid, so an instance can render what it is an instance of. */
  symbols?: Map<string, FigmaNode>;
  /** Shared colour styles by key, for a run that references one. See `fillStylesOf`. */
  styles?: Map<string, unknown>;
  /**
   * Lay an auto-layout frame out as flex rather than placing its children by coordinate.
   *
   * On by default: `stackOf` only returns a stack whose replay lands every child where Figma
   * already put it, so this describes the design rather than re-deriving it. Off is the plain
   * absolute path, kept because it is the thing being checked against.
   */
  flex?: boolean;
  /**
   * Say a box the way the design stated it — `flex:1` for a child set to fill, `right` for one
   * pinned to the right edge — rather than as the pixel it happens to land on.
   *
   * On by default, and for the same reason `flex` is: every declaration `responsiveBox` emits
   * is a translation of a field Figma wrote, not a guess about intent, and each one resolves to
   * the same pixel at the design's own width — which is what `diff-corpus` measures. Narrower
   * than that, the box moves the way Figma says it should. A field the mapper cannot state that
   * way keeps its coordinates.
   */
  responsive?: boolean;
  /** Set by `sceneToHtml`: this render is one root on its own, so the root box is the page. */
  sole?: boolean;
  /** Set by `sceneToHtml`: the width the design was drawn at, which every `vw` is relative to. */
  designWidth?: number;
};

export type Scene = {
  html: string;
  width: number;
  height: number;
  /** Node types this build has no mapping for, by count. */
  unmapped: Record<string, number>;
  /** Properties applied as an approximation — a gradient flattened, an image left empty. */
  approximated: string[];
  /** How many nodes each approximation covers. Ten logos reported once reads as one logo. */
  counts: Record<string, number>;
  /** Exactly the faces the design uses, so the stylesheet asks for nothing that 404s. */
  fonts: { family: string; weight: number; italic: boolean }[];
  /**
   * How many elements have been drawn, which doubles as the next `data-fid`.
   *
   * An editor has to find the node it is looking at back in this string, and nothing else here
   * can do that. `data-figma` is the designer's name and repeats — a hero with four stat cards
   * has four `data-figma="Card"`. The opening tag repeats with it, and inside an `<svg>` it does
   * not even survive a round trip: the browser reserialises `rgba(0,0,0,1)` as `rgba(0, 0, 0, 1)`,
   * so 45 of one paste's 83 SVG elements could not be found by their own markup. A counter is
   * unique by construction and byte-exact both ways.
   */
  count: number;
};

const num = (value: unknown, fallback = 0) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const round2 = (value: number) => Math.round(value * 100) / 100;

const px = (value: number) => `${round2(value)}px`;

const rgba = (color: Color, alpha = 1) => {
  const to255 = (channel: number) => Math.round(num(channel) * 255);
  const a = num(color.a, 1) * alpha;
  return `rgba(${to255(color.r)}, ${to255(color.g)}, ${to255(color.b)}, ${Math.round(a * 1000) / 1000})`;
};

/**
 * The style attribute, joined and made safe to sit inside `style="…"`.
 *
 * A double quote in a declaration ends the attribute early and silently drops every rule after
 * it — a font-family did it once and an image url did it again, each time looking like a
 * renderer problem rather than a quoting one. Single quotes mean the same thing to CSS and
 * nothing to the parser, so this converts rather than escapes.
 */
/**
 * Figma's name for the face, then the one Google actually serves it under. Without the second
 * the alias is pointless: the stylesheet loads `Inter` and the rule still asks for the family
 * that 404'd.
 */
const familyStack = (family: string): string => {
  const quoted = (name: string) => `'${name.replace(/'/g, "")}'`;
  const alias = googleFamily(family);
  return `${quoted(family)}${alias === family ? "" : `, ${quoted(alias)}`}, sans-serif`;
};

const styleAttr = (declarations: string[]) =>
  declarations.join(";").replace(/"/g, "'");

const escape = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const visiblePaint = (paints: unknown): Paint | null => {
  if (!Array.isArray(paints)) return null;
  return (paints as Paint[]).find((p) => p.visible !== false && p.type) ?? null;
};

/**
 * Colours are float 0–1 RGBA, not 0–255 — the single most common conversion bug in every
 * Figma importer, and one that looks like a rendering problem rather than a maths one.
 */
const paintCss = (
  paint: Paint,
  box: { width: number; height: number },
  report: (what: string) => void,
): string | null => {
  const alpha = num(paint.opacity, 1);

  if (paint.type === "SOLID" && paint.color) return rgba(paint.color, alpha);

  if (paint.type?.startsWith("GRADIENT") && paint.stops?.length) {
    if (paint.type === "GRADIENT_DIAMOND") {
      report("gradient_diamond drawn as the nearest CSS gradient");
    }
    if (paint.type === "GRADIENT_ANGULAR" && skewedSweep(paint)) {
      report("angular gradient sweep drawn evenly");
    }
    return gradientCss(paint, box.width, box.height, alpha);
  }

  return null;
};

/**
 * A gradient as the one colour a `box-shadow` can take.
 *
 * `box-shadow` takes a colour, and a gradient in that slot does not degrade — it makes the whole
 * declaration invalid, so the browser throws it away *along with every shadow beside it*: 45 of
 * the corpus's box-shadows died that way, and a glowing phone outline blurred over a hero was
 * simply not drawn. Averaging the stops in premultiplied alpha is the single colour nearest the
 * sweep, and unlike `stops[0]` it cannot come out invisible because the gradient began clear.
 */
const flatGradient = (paint: Paint, alpha: number): string | null => {
  const stops = paint.stops ?? [];
  if (!stops.length) return null;
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  for (const stop of stops) {
    const weight = num(stop.color?.a, 1);
    r += num(stop.color?.r) * weight;
    g += num(stop.color?.g) * weight;
    b += num(stop.color?.b) * weight;
    a += weight;
  }
  // Every stop clear: the sweep has no colour of its own, only an absence.
  if (!a) return rgba({ r: 0, g: 0, b: 0, a: 0 }, alpha);
  return rgba({ r: r / a, g: g / a, b: b / a, a: a / stops.length }, alpha);
};

/** The 40-hex content hash Figma calls an `imageRef`, from the 20 raw bytes on the paint. */
const imageRef = (paint: Paint): string | null => {
  // A paint that was never opened at full size in this session carries only `imageThumbnail`.
  // Same 20-byte content hash, same `/v1/files/:key/images` map — dropping it renders the paint
  // as nothing, and an image *mask* that resolves to nothing silently degrades to its bounding
  // box: a field of dots becomes one soft blob, with every counter reporting zero.
  const hash = (
    (paint.image ?? paint.imageThumbnail) as { hash?: Uint8Array } | undefined
  )?.hash;
  if (!hash || hash.length !== 20) return null;
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
};

/**
 * A resized instance's children, placed by their constraints.
 *
 * Dragging an instance's handle does not scale it — it resizes the frame, and every child
 * answers with the constraint it was given. That is the whole of Figma's behaviour here and it
 * is arithmetic, so it is done rather than approximated: a `STRETCH` child keeps both its
 * insets and takes the difference in its own width, a `MAX` child keeps its distance from the
 * far edge, a `CENTER` child keeps its offset from the middle, and a `SCALE` child takes the
 * ratio. `MIN` — the default, and most of any design — keeps its coordinates and does not move.
 *
 * Recursive, because a child that just changed size is itself a box its own children were
 * measured against. It rebuilds only what moved: a subtree that resolves to the same numbers is
 * returned by identity, so a design where nothing is resized allocates nothing and every
 * downstream `===` still holds.
 *
 * The alternative was drawing the component under a `transform: scale(w/W, h/H)`, which is what
 * this used to do whenever the component was not auto layout. On a breakpoint strip whose
 * component is 2013 wide placed at 1327, that was `scale(0.66, 0.86)` over all 210 instances:
 * six columns of a squashed page where Figma draws four at their own size, every avatar an
 * ellipse and every glyph a third too narrow.
 */
const resizeAxis = (
  constraint: unknown,
  start: number,
  size: number,
  from: number,
  to: number,
): { start: number; size: number } => {
  if (!(from > 0)) return { start, size };
  switch (constraint) {
    case "MAX":
      return { start: to - (from - start - size) - size, size };
    case "STRETCH":
      return { start, size: Math.max(0, to - start - (from - start - size)) };
    case "CENTER":
      return { start: to / 2 + (start + size / 2 - from / 2) - size / 2, size };
    case "SCALE":
      return { start: (start * to) / from, size: (size * to) / from };
    default:
      return { start, size };
  }
};

const resizeByConstraints = (
  node: FigmaNode,
  from: { w: number; h: number },
  to: { w: number; h: number },
): FigmaNode => {
  const x = num(node.transform?.m02);
  const y = num(node.transform?.m12);
  const w = num(node.size?.x);
  const h = num(node.size?.y);
  const across = resizeAxis(node.horizontalConstraint, x, w, from.w, to.w);
  const down = resizeAxis(node.verticalConstraint, y, h, from.h, to.h);

  const still =
    near(across.start, x) &&
    near(down.start, y) &&
    near(across.size, w) &&
    near(down.size, h);
  // Its own box did not move, so nothing under it can have — identity, and the caller's `===`
  // and every memo downstream still hold.
  if (still) return node;

  return {
    ...node,
    transform: { ...node.transform, m02: across.start, m12: down.start },
    size: { ...node.size, x: across.size, y: down.size },
    children: node.children.map((child) =>
      resizeByConstraints(child, { w, h }, { w: across.size, h: down.size }),
    ),
  } as FigmaNode;
};

/**
 * Auto layout, as flex.
 *
 * Figma calls it a stack, and it *is* a flex container — the fields map one for one, so this is
 * a translation rather than an inference. The absolute fallback stays for everything else, and
 * for a stack that cannot be one safely (below): a design is not obliged to use auto layout and
 * most of a decorative hero does not.
 *
 * Two defaults are not CSS's. Figma's cross-axis default is MIN and flex's is `stretch`, so
 * `align-items` is always written; and Figma's `size` is the outer box with the padding already
 * inside it, which is `border-box` — content-box would add the padding again and push every
 * child out by it.
 */
const STACK_JUSTIFY: Record<string, string> = {
  MIN: "flex-start",
  CENTER: "center",
  MAX: "flex-end",
  SPACE_BETWEEN: "space-between",
};

const STACK_ALIGN: Record<string, string> = {
  MIN: "flex-start",
  CENTER: "center",
  MAX: "flex-end",
  BASELINE: "baseline",
  STRETCH: "stretch",
};

/**
 * The design at a size it was not drawn at.
 *
 * Dragging a frame's edge is not a scale — it is Figma re-running the frame's own layout, and
 * the payload holds everything that takes to do. What it took before was one line overwriting
 * the root's `size`, and nothing under it heard: a 1512-wide page narrowed to 979 kept a
 * 1492-wide body, so the hero clipped mid-word and the side panel fell off the edge, and
 * widened to 2358 it kept the same 1492 and left 866px of ground. Figma, given the same drag,
 * stretches the body to the new width, and the row inside it hands the difference to the column
 * that was set to fill.
 *
 * Which is the whole of what this does, and it is two rules, not a layout engine:
 *
 * - **A stack re-runs.** A child set to fill the cross axis (`STRETCH`) takes the new inner
 *   measure; the free space along the main axis is split between the children set to grow;
 *   everything is then re-placed from the padding, with the gap and `justify-content` the
 *   container already had. Recursive, because a child that just changed size is the box its
 *   own children were measured against.
 * - **Anything else answers with its constraints**, which is `resizeByConstraints` and was
 *   already here — it was simply never reached from a resize, only from an instance drawn
 *   inside its component.
 *
 * The placement is `stackFits`'s, deliberately: that function decides whether a frame may be
 * emitted as flex at all by replaying the layout against Figma's own coordinates, so a writer
 * that placed children any other way would make every resized stack fail its own test and fall
 * back to absolute — which is the bug, drawn a second way.
 *
 * Identity-returning where nothing moved, so resizing a frame to the size it already has is the
 * same object and the same markup, byte for byte.
 */
export const relayout = (
  node: FigmaNode,
  to: { w: number; h: number },
): FigmaNode => {
  const from = { w: num(node.size?.x), h: num(node.size?.y) };
  if (near(from.w, to.w) && near(from.h, to.h)) return node;

  const mode = node.stackMode;
  const sized = { ...node, size: { ...node.size, x: to.w, y: to.h } };
  if (mode !== "HORIZONTAL" && mode !== "VERTICAL") {
    return {
      ...sized,
      children: node.children.map((child) =>
        resizeByConstraints(child, from, to),
      ),
    } as FigmaNode;
  }

  const row = mode === "HORIZONTAL";
  const padLeft = num(node.stackHorizontalPadding);
  const padTop = num(node.stackVerticalPadding);
  const padRight = num(node.stackPaddingRight, padLeft);
  const padBottom = num(node.stackPaddingBottom, padTop);
  const mainStart = row ? padLeft : padTop;
  const mainEnd = row ? padRight : padBottom;
  const crossStart = row ? padTop : padLeft;
  const crossEnd = row ? padBottom : padRight;
  const gap = Math.max(0, num(node.stackSpacing));
  const justify =
    STACK_JUSTIFY[node.stackPrimaryAlignItems as string] ?? "flex-start";
  const align =
    STACK_ALIGN[node.stackCounterAlignItems as string] ?? "flex-start";

  const innerMain = (row ? to.w : to.h) - mainStart - mainEnd;
  const innerCross = (row ? to.h : to.w) - crossStart - crossEnd;

  // The same two tests `stackFits` uses to decide who is in the flow at all.
  const inFlow = (child: FigmaNode) =>
    child.visible !== false && child.stackPositioning !== "ABSOLUTE";
  const kids = node.children.filter(inFlow);
  const mainOf = (n: FigmaNode) => num(row ? n.size?.x : n.size?.y);
  const crossOf = (n: FigmaNode) => num(row ? n.size?.y : n.size?.x);

  /**
   * The free space, to the children that asked for it.
   *
   * Equally, which is what a browser does and what Figma does where every grown child starts
   * from the same size. Where they do not, Figma's answer is not always equal — the same
   * caveat `flowSize` carries about growing from the measured size rather than from a basis of
   * zero — and the fit test below is what notices: a stack this gets wrong stops reproducing
   * its own coordinates and is drawn absolutely, which is where it started.
   */
  const growing = kids.filter(
    (child) => num(child.stackChildPrimaryGrow) === 1,
  );
  const content =
    kids.reduce((sum, k) => sum + mainOf(k), 0) + gap * (kids.length - 1);
  const share = growing.length ? (innerMain - content) / growing.length : 0;

  const resized = new Map<FigmaNode, FigmaNode>();
  for (const kid of kids) {
    const grows = num(kid.stackChildPrimaryGrow) === 1;
    const stretches =
      (STACK_ALIGN[kid.stackChildAlignSelf as string] ?? align) === "stretch";
    const main = mainOf(kid) + (grows ? share : 0);
    const cross = stretches ? innerCross : crossOf(kid);
    resized.set(
      kid,
      relayout(kid, row ? { w: main, h: cross } : { w: cross, h: main }),
    );
  }

  // Re-placed from the padding, with whatever free space is left after the growers took
  // theirs — `stackFits`'s own arithmetic, so the two cannot disagree about this frame.
  const laid = kids.map((kid) => resized.get(kid) ?? kid);
  const used =
    laid.reduce((sum, k) => sum + mainOf(k), 0) + gap * (laid.length - 1);
  const free = innerMain - used;
  let at = mainStart;
  let step = gap;
  if (justify === "center") at += free / 2;
  else if (justify === "flex-end") at += free;
  else if (justify === "space-between" && laid.length > 1 && free > 0)
    step += free / (laid.length - 1);

  const placed = new Map<FigmaNode, FigmaNode>();
  for (const [index, kid] of kids.entries()) {
    const child = laid[index];
    const self = STACK_ALIGN[kid.stackChildAlignSelf as string] ?? align;
    const off =
      self === "center"
        ? crossStart + (innerCross - crossOf(child)) / 2
        : self === "flex-end"
          ? crossStart + innerCross - crossOf(child)
          : crossStart;
    placed.set(kid, {
      ...child,
      transform: {
        ...child.transform,
        m02: row ? at : off,
        m12: row ? off : at,
      },
    } as FigmaNode);
    at += mainOf(child) + step;
  }

  return {
    ...sized,
    children: node.children.map(
      (child) =>
        placed.get(child) ??
        // Out of the flow, so it is placed against the frame's box — which is exactly what a
        // constraint is for, and the one thing Figma does with it here.
        (inFlow(child) ? child : resizeByConstraints(child, from, to)),
    ),
  } as FigmaNode;
};

/**
 * Does flex actually reproduce what Figma laid out?
 *
 * Usually, but not always, and the exceptions do not announce themselves. A fixed-size frame
 * whose content is taller than it is overflows *symmetrically* under `justify-content:center`
 * and gets clipped from the top by Figma — 24 stacked blur bars in one hero came out 782px
 * above their frame that way. Hug sizing, a wrapped row and a child grown to fill are the same
 * kind of disagreement: the fields say stack, and the stack Figma ran is not this one.
 *
 * So rather than trust the fields, the layout is replayed here against the coordinates Figma
 * already resolved for every child. Matching means flex is a description of this frame and can
 * be emitted; not matching means the absolute placement is the only honest one, and it stays.
 * The arithmetic is the whole of flex for a single line: pack along the main axis from the
 * padding, distribute the free space by `justify-content`, place each child on the cross axis
 * by its own `align-self` or the container's `align-items`.
 */
const stackFits = (node: FigmaNode, css: Stack): boolean => {
  const kids = node.children.filter(
    (child) => child.visible !== false && child.stackPositioning !== "ABSOLUTE",
  );
  if (!kids.length) return false;

  const row = css.mode === "HORIZONTAL";
  const main = (n: FigmaNode) => num(row ? n.size?.x : n.size?.y);
  const cross = (n: FigmaNode) => num(row ? n.size?.y : n.size?.x);
  const [padTop, padRight, padBottom, padLeft] = css.padding;
  const mainStart = row ? padLeft : padTop;
  const mainEnd = row ? padRight : padBottom;
  const crossStart = row ? padTop : padLeft;
  const crossEnd = row ? padBottom : padRight;

  const inner = num(row ? node.size?.x : node.size?.y) - mainStart - mainEnd;
  const content =
    kids.reduce((sum, k) => sum + main(k), 0) + css.gap * (kids.length - 1);
  const free = inner - content;
  css.overflowing = free < 0;
  css.exact = Math.abs(free) <= 0.5;
  const crossInner =
    num(row ? node.size?.y : node.size?.x) - crossStart - crossEnd;

  let at = mainStart;
  let gap = css.gap;
  // `center` and `flex-end` shift by negative free space too — that is what overflowing past
  // the start edge is. `space-between` does not: the spec makes it identical to `flex-start`
  // once the space runs out, and a 1440 bar holding 1521 of content is 281px of difference
  // between what Figma placed and what a browser would.
  if (css.justify === "center") at += free / 2;
  else if (css.justify === "flex-end") at += free;
  else if (css.justify === "space-between" && kids.length > 1 && free > 0)
    gap += free / (kids.length - 1);

  for (const kid of kids) {
    const align = STACK_ALIGN[kid.stackChildAlignSelf as string] ?? css.align;
    // Baseline is font metrics, not geometry — nothing here can predict where it lands.
    if (align === "baseline") return false;
    const off =
      align === "center"
        ? crossStart + (crossInner - cross(kid)) / 2
        : align === "flex-end"
          ? crossStart + crossInner - cross(kid)
          : crossStart;

    const wantMain = row ? num(kid.transform?.m02) : num(kid.transform?.m12);
    const wantCross = row ? num(kid.transform?.m12) : num(kid.transform?.m02);
    if (Math.abs(wantMain - at) > 0.5 || Math.abs(wantCross - off) > 0.5)
      return false;
    at += main(kid) + gap;
  }
  return true;
};

type Stack = {
  mode: string;
  gap: number;
  /**
   * The children already add up to more than the container holds, which is a line where
   * `flex-shrink` is the difference between the design and something else. Set by `stackFits`,
   * which is the only thing here that measures it.
   */
  overflowing?: boolean;
  /**
   * The children add up to exactly what the container holds — no free space along the main
   * axis. It is the licence to drop the box's own size and let the content say it instead.
   */
  exact?: boolean;
  /** top, right, bottom, left — the order the CSS shorthand wants. */
  padding: [number, number, number, number];
  justify: string;
  align: string;
  css: string[];
};

const stackOf = (node: FigmaNode): Stack | null => {
  const mode = node.stackMode;
  if (mode !== "HORIZONTAL" && mode !== "VERTICAL") return null;

  const css = ["display:flex", "box-sizing:border-box"];
  if (mode === "VERTICAL") css.push("flex-direction:column");

  // Clamped, because `gap` cannot be negative in CSS and Figma's spacing can: a row of avatars
  // overlapping by 6px is a stack with `stackSpacing: -6`. Replaying with the clamped value is
  // what makes the fit test notice, and such a row falls back to its exact coordinates.
  const gap = Math.max(0, num(node.stackSpacing));
  if (gap) css.push(`gap:${px(gap)}`);

  // Figma writes one field per side, but only when a side differs from the pair it belongs to:
  // `stackHorizontalPadding` is the left and `stackVerticalPadding` the top, and right and
  // bottom fall back to them.
  const left = num(node.stackHorizontalPadding);
  const top = num(node.stackVerticalPadding);
  const right = num(node.stackPaddingRight, left);
  const bottom = num(node.stackPaddingBottom, top);
  if (left || top || right || bottom)
    css.push(`padding:${px(top)} ${px(right)} ${px(bottom)} ${px(left)}`);

  const justify =
    STACK_JUSTIFY[node.stackPrimaryAlignItems as string] ?? "flex-start";
  if (justify !== "flex-start") css.push(`justify-content:${justify}`);
  const align =
    STACK_ALIGN[node.stackCounterAlignItems as string] ?? "flex-start";
  css.push(`align-items:${align}`);

  const stack: Stack = {
    mode,
    gap,
    padding: [top, right, bottom, left],
    justify,
    align,
    css,
  };
  return stackFits(node, stack) ? stack : null;
};

/**
 * The box this node is placed in — its parent's size, and the parent's stack mode if the flow
 * is what places it. Only the axes a constraint or a stack field can be resolved against.
 */
type ParentBox = {
  mode?: string;
  shrink?: boolean;
  w: number;
  h: number;
  /** The width a flow item is laid inside: the parent's box less its own padding. */
  inner?: number;
  /** The same on the other axis, which is what a row's `align-self:stretch` resolves to. */
  innerH?: number;
};

/**
 * A rule, in place of the pixel it resolves to.
 *
 * Figma stores both: the coordinates it already solved for, and the constraint or stack field
 * that produced them. The absolute path takes the first, which is exactly right and exactly
 * one width wide. This takes the second, which is the same design said in terms that survive a
 * narrower box — a fill child is `flex:1`, a right-pinned one is `right`, a stretched one has
 * two edges and no width.
 *
 * The discipline is `stackFits`'s: only what is a *translation* is emitted. `SCALE` — 90% of
 * the constraints in this corpus, because it is what Figma writes when nobody chose — is left
 * alone deliberately. As percentages it is faithful to Figma's own resize and useless as code:
 * the whole design shrinks, text included, which is the thing people mean when they say a page
 * is not responsive.
 */
const pinAxis = (
  constraint: unknown,
  start: number,
  size: number,
  parent: number,
  props: [start: string, end: string, size: string, margin: string],
): { pos: string; size: string | null; more?: string[] } => {
  const [startProp, endProp, sizeProp, marginProp] = props;
  /**
   * Where it starts, and never past where it would have to end.
   *
   * `left:378px` is exactly right at 1440 and off the side of a phone, and `max-width` does not
   * help: it narrows the box and leaves the offset where it was. `min(378px, 100% - 684px)`
   * keeps the design's own number wherever there is room for the whole box after it — which,
   * since the design fit it there, is every width down to the box's own — and slides it back
   * against the right edge below that. Inert at the design's own width by construction, which
   * is the property everything here is checked against.
   *
   * Horizontally only. A page scrolls down and does not scroll sideways, so there is nothing
   * to slide back from vertically — and `100%` there is the parent's *height*, which a grown
   * container (`.r-grow`) changes: the guard would drag every box in it upward.
   *
   * And only for a box that starts inside its parent and fits: a bleed is drawn at a negative
   * offset on purpose, and pulling it back to zero is moving the design rather than fitting it.
   */
  const at =
    marginProp === "inline" && start >= 0 && start + size <= parent
      ? `${startProp}:min(${px(start)},max(0px,calc(100% - ${px(size)})))`
      : `${startProp}:${px(start)}`;
  const fixed = { pos: at, size: `${sizeProp}:${px(size)}` };
  if (!(parent > 0)) return fixed;
  const end = parent - start - size;
  switch (constraint) {
    case "MAX":
      return { pos: `${endProp}:${px(end)}`, size: `${sizeProp}:${px(size)}` };
    case "STRETCH":
      return { pos: at, size: `${endProp}:${px(end)}` };
    case "CENTER": {
      /**
       * Both edges and an auto margin, when the box really is in the middle.
       *
       * `calc(50% - half)` is the same pixel and stops being centred the moment the box is
       * clamped: `max-width` takes width off the right and leaves the left where the design's
       * own half said, so a 684px heading in a 600px page hangs 42px off the left edge instead
       * of sitting in the middle of what is left. Two zero edges and `margin:auto` centre
       * whatever width survives.
       */
      const off = parent / 2 - start;
      /**
       * Only a box that fits, only horizontally, and only one that is centred to the pixel.
       *
       * `margin:auto` on an over-constrained box resolves to zero rather than to half the
       * negative space, so a hero drawn 53px wider than its frame — bleeding past both edges
       * on purpose — snaps to the left edge. Vertically there is nothing to gain: no height is
       * ever clamped here, so the auto margin only re-derives a number the design already
       * gave, half a pixel away from it. And the tolerance is tight for the same reason —
       * `CENTER` is Figma's word for the constraint, not a promise that the box sits exactly in
       * the middle, and re-centring one that does not is a move rather than a translation.
       */
      if (
        marginProp === "inline" &&
        size <= parent &&
        near(off, size / 2, 0.05)
      ) {
        return {
          pos: `${startProp}:0`,
          size: `${sizeProp}:${px(size)}`,
          more: [`${endProp}:0`, `margin-${marginProp}:auto`],
        };
      }
      // Off centre: the distance from the midline is what stays constant. Written as a sum
      // rather than a difference when it is negative — `calc(50% - -3px)` is not CSS.
      const sign = off < 0 ? "+" : "-";
      const middle = `calc(50% ${sign} ${px(Math.abs(off))})`;
      return {
        // Half of a narrow page is not half of the design's: a 684px heading centred on 1440
        // resolves to −147px at 390, and the box walks off the left edge instead of sitting
        // against it. Floored at zero, and only where the design's own number was not already
        // negative — that one is a bleed, and it is meant to hang off the edge.
        pos: `${startProp}:${start >= 0 ? `max(0px,${middle})` : middle}`,
        size: `${sizeProp}:${px(size)}`,
      };
    }
    default:
      return fixed;
  }
};

/**
 * Both axes, in the order the absolute path already wrote them.
 *
 * `left;top;width;height` rather than each axis in turn — the declarations mean the same thing
 * either way and every test, diff and reading of this markup was written against that order.
 */
const pinned = (
  node: FigmaNode,
  left: number,
  top: number,
  width: number,
  height: number,
  parent: ParentBox,
): string[] => {
  const h = pinAxis(node.horizontalConstraint, left, width, parent.w, [
    "left",
    "right",
    "width",
    "inline",
  ]);
  const v = pinAxis(node.verticalConstraint, top, height, parent.h, [
    "top",
    "bottom",
    "height",
    "block",
  ]);
  return [
    h.pos,
    v.pos,
    ...(h.size ? [h.size] : []),
    ...(v.size ? [v.size] : []),
    ...(h.more ?? []),
    ...(v.more ?? []),
  ];
};

/**
 * A run of siblings that tile a regular lattice — a card grid, a bento, a row of features.
 *
 * Auto layout is not how most of these are built. A designer drags four 360×300 cards into
 * place and Figma stores four sets of coordinates, so `stackOf` sees no stack and the absolute
 * path is right: at 1440 the cards are exactly where they belong. At 900 they are still exactly
 * where they belong, which is off the side of the page — and that is the whole of what "the
 * export is not responsive" means for a design like this.
 *
 * The lattice is recoverable from the coordinates, and only from them. Equal cells, one row of
 * distinct x positions and one of distinct y, every cell occupied exactly once, and one gap
 * between columns and one between rows. Anything that does not answer all of that keeps its
 * coordinates: a bento of unequal cards is not this, and guessing at it would move pixels the
 * design put somewhere on purpose.
 *
 * Centred in its parent is required, not preferred — `padding-inline` is what re-centres the
 * columns as the page narrows, and it is only the design's own margin when the two are equal.
 */
type Grid = {
  /** Where the run sits among its siblings, so the rest of them keep their paint order. */
  from: number;
  count: number;
  top: number;
  columns: number;
  cell: { w: number; h: number };
  gap: { row: number; col: number };
  /** The lattice's own width — what the columns are centred inside above the design width. */
  width: number;
  height: number;
  /**
   * Each member's row-major slot, which is the order CSS grid fills its cells in and is not
   * the order the payload lists them in.
   *
   * As `order`, never as a re-sorted DOM. Moving the elements would renumber every `data-fid`
   * after them — the counter is positional — and a fid is what the editor, the layers panel and
   * `setStyle` address a node by. A lattice cannot overlap, so `order` moving the paint order
   * with it costs nothing.
   */
  slot: Map<FigmaNode, number>;
};

const near = (a: number, b: number, tol = 0.5) => Math.abs(a - b) <= tol;

/** Narrower than this and there is no viewport left for a lattice to reflow into. */
const PHONE_PX = 380;

/**
 * Type that follows the page, with a floor.
 *
 * A heading is sized for the width it was drawn at, and re-wrapping it at a third of that
 * width is four lines where the design has one — which is a block three times as tall pushing
 * through whatever was under it. Shrinking it is what a designer would do, and `vw` says it in
 * one declaration: `<size>/<design width>` of the viewport is *exactly* the design's own size
 * at the design's own width, and proportionally less below it. No breakpoint needed; the
 * identity is what makes it inert where it has to be.
 *
 * The two floors are the whole of the judgement here and both are meant to be turned. Nothing
 * goes below 62% of what the designer chose, because past that the hierarchy they drew stops
 * being the hierarchy on the screen; and nothing goes below 12px at all, which also means body
 * copy — already near the floor — never moves.
 */
const MIN_TYPE_SCALE = 0.62;
const MIN_TYPE_PX = 12;

const fluidType = (size: number, designWidth: number): string => {
  if (!(designWidth > 0) || size <= MIN_TYPE_PX) return `font-size:${px(size)}`;
  const floor = Math.max(MIN_TYPE_PX, size * MIN_TYPE_SCALE);
  if (floor >= size) return `font-size:${px(size)}`;
  /**
   * Rounded **up**, and that is the whole of why the cap works.
   *
   * The identity this rests on is that the `vw` term equals the design's own size at the
   * design's own width — so the ceiling takes over from there and the text is never larger
   * than it was drawn. Rounded to the nearest, that term lands *under* the size as often as
   * over: 48/1440 is 3.333…, written 3.33vw, which is 47.952px at 1440. The clamp then has
   * nothing to cap and every heading in the design renders a twentieth of a pixel small, at
   * the one width where it is supposed to be exact. Up, the middle term is always a hair over
   * the ceiling at and above the design width, so the ceiling is what is drawn; four decimals
   * keep the hair small enough not to matter below it.
   */
  const vw = Math.ceil((size / designWidth) * 1e6) / 1e4;
  return `font-size:clamp(${px(floor)},${vw}vw,${px(size)})`;
};

/**
 * The two things a box is allowed to do, and only below the width the design was drawn at.
 *
 * Growth and re-wrapping cannot be written inline, because inline they also apply *at* the
 * design's own width — and there they are wrong. A browser sets the same string a few pixels
 * wider than Figma's engine does, so a column told to size to its content comes out 8px taller
 * than the frame Figma measured and every box under it moves. Under a media query the design
 * at its own width is untouched, which is the property this whole file is checked against, and
 * everything below it is free.
 *
 * `!important` because the mapper writes `height` and `white-space` inline on the same
 * elements, and an inline declaration outranks any stylesheet without it.
 */
const GROW = "r-grow";
const WRAP = "r-wrap";

const responsiveCss = (designWidth: number) =>
  `<style>/* Responsive behaviour, below the width this design was drawn at. Above it every box is where Figma put it. */ ` +
  `@media (max-width:${round2(designWidth - 0.02)}px){` +
  `.${GROW}{height:auto!important}` +
  `.${WRAP}{white-space:pre-wrap!important;overflow-wrap:break-word}` +
  // The fit scale belongs to the one line this was: `fitText` measures the substituted face
  // against the ink width Figma reported and stretches the line to it, and a line that has
  // just re-wrapped into two is not that line. Left on, a 684px heading in a 380px box lays
  // out correctly at 380 and is then blown back up to 683 by a `scaleX(1.8)` meant for it.
  `.${WRAP} span{transform:none!important}` +
  `}</style>`;

const classAttr = (classes: string[]) =>
  classes.length ? ` class="${classes.join(" ")}"` : "";

const latticeOf = (
  run: FigmaNode[],
  cell: { w: number; h: number },
  parentW: number,
  from: number,
): Grid | null => {
  const xOf = (n: FigmaNode) => num(n.transform?.m02);
  const yOf = (n: FigmaNode) => num(n.transform?.m12);
  const xs: number[] = [];
  const ys: number[] = [];
  const add = (into: number[], value: number) => {
    if (!into.some((seen) => near(seen, value))) into.push(value);
  };
  for (const node of run) {
    add(xs, xOf(node));
    add(ys, yOf(node));
  }
  xs.sort((a, b) => a - b);
  ys.sort((a, b) => a - b);
  // One column is already a stack of full-width blocks; there is nothing for it to collapse to.
  if (xs.length < 2 || xs.length * ys.length !== run.length) return null;

  const slot = new Map<FigmaNode, number>();
  const taken = new Set<number>();
  for (const node of run) {
    const col = xs.findIndex((x) => near(x, xOf(node)));
    const row = ys.findIndex((y) => near(y, yOf(node)));
    const cell = row * xs.length + col;
    if (taken.has(cell)) return null;
    taken.add(cell);
    slot.set(node, cell);
  }

  const spacing = (line: number[], size: number): number | null => {
    const gap = line[1] - line[0] - size;
    if (gap < 0) return null;
    for (let i = 1; i < line.length; i += 1) {
      if (!near(line[i] - line[i - 1] - size, gap)) return null;
    }
    return gap;
  };
  const col = spacing(xs, cell.w);
  const row = ys.length > 1 ? spacing(ys, cell.h) : 0;
  if (col === null || row === null) return null;
  /**
   * A gutter is smaller than what it separates. Past half a cell it is not a gutter — it is two
   * decorative groups pinned to opposite ends of a bar, or a pair of 24px icons 61px apart, and
   * both of those answer every other question here like a grid and reflow like nonsense.
   */
  if (col > cell.w / 2 || row > cell.h / 2) return null;

  const width = xs[xs.length - 1] + cell.w - xs[0];
  /**
   * A lattice that already fits on a phone has nothing to collapse, and the small ones are
   * never grids anyway: two 0.92px dots inside a 13px group answer every question above like a
   * card grid, and re-laying them out moves a vector by the pixel it was drawn at.
   */
  if (width < PHONE_PX) return null;
  // The design's own margin, and it has to be the same one on both sides for the re-centring
  // below to land the columns back where they started.
  if (!near(xs[0], parentW - xs[0] - width, 2)) return null;

  return {
    from,
    count: run.length,
    top: ys[0],
    columns: xs.length,
    cell,
    gap: { row, col },
    width,
    height: ys[ys.length - 1] + cell.h - ys[0],
    slot,
  };
};

/** The longest run of equal, consecutive siblings that turns out to be a lattice. */
const gridOf = (items: FigmaNode[], parentW: number): Grid | null => {
  const size = (n: FigmaNode) => ({ w: num(n.size?.x), h: num(n.size?.y) });
  let best: Grid | null = null;
  for (let i = 0; i < items.length; i += 1) {
    const cell = size(items[i]);
    if (cell.w <= 0 || cell.h <= 0 || items[i].visible === false) continue;
    let j = i + 1;
    while (
      j < items.length &&
      items[j].visible !== false &&
      near(size(items[j]).w, cell.w) &&
      near(size(items[j]).h, cell.h)
    ) {
      j += 1;
    }
    if (j - i >= 2) {
      const found = latticeOf(items.slice(i, j), cell, parentW, i);
      if (found && (!best || found.count > best.count)) best = found;
    }
    i = j - 1;
  }
  return best;
};

/**
 * The lattice, as a grid that drops a column rather than running off the page.
 *
 * `auto-fit` over tracks that are exactly one cell wide: at the design's own width the padding
 * leaves precisely the room the lattice had and the columns land back on their own coordinates,
 * and below it the padding runs out, a track no longer fits and the row re-wraps. `min(…,100%)`
 * is what lets the last column narrow rather than overflow on a phone.
 *
 * The height is the lattice's own, and `r-grow` is what lets go of it below the design width —
 * where a dropped column is an extra row, and a fixed height would clip the rows it just made.
 * Said out loud rather than left to `auto`, because the targets with no grid in them read this
 * box's size straight off the declaration.
 */
/**
 * The column count, on the element, for the readers that have no CSS grid to ask.
 *
 * `swiftui`, `flutter` and `compose` rebuild the layout from the boxes and know only rows and
 * columns; a grid is a `layout: none` to them and its members, having given up their
 * coordinates to the tracks, all land at the origin. One number is all it takes to chunk them
 * back into rows — see `toBoxes` in `export-code.ts`. It is on the synthetic wrapper, which
 * carries no `data-fid` and is nobody's node, so it says nothing about the design either way.
 */
const GRID_COLUMNS = "data-grid-columns";

const gridCss = (grid: Grid): string[] => [
  "position:absolute",
  "left:0",
  "right:0",
  `top:${px(grid.top)}`,
  `height:${px(grid.height)}`,
  "display:grid",
  `grid-template-columns:repeat(auto-fit,minmax(min(${px(grid.cell.w)},100%),${px(grid.cell.w)}))`,
  "justify-content:center",
  "align-content:start",
  `gap:${px(grid.gap.row)} ${px(grid.gap.col)}`,
  `padding-inline:max(0px,calc((100% - ${px(grid.width)}) / 2))`,
];

/**
 * A column somebody stacked by hand.
 *
 * `latticeOf` gives up at a single column — "there is nothing for it to collapse to" — and that
 * is true of the width and false of the height. A run of boxes down the page with clear air
 * between them is a column whether or not anybody reached for auto layout, and most of a design
 * never does: 89% of this corpus's elements are absolutely placed, against 93% of the frames
 * that *do* declare auto layout already coming out as flex. So the coordinates are where the
 * remaining structure is, and `gridOf` is the only thing here reading them.
 *
 * Two things follow from saying it. The export reads as a column instead of a field of `top:`s
 * — which is the half somebody has to edit. And the run can **grow**: a heading that re-wraps
 * into two lines on a phone pushes what is under it down the page instead of through it.
 * Measured at 390px across the corpus, 305 pairs of siblings overlap there that do not overlap
 * at the design's own width.
 *
 * The discipline is `stackFits`'s: only emitted where the flow lands on the coordinates Figma
 * already solved for. Each guard is one way it would not:
 *
 * - **Drawn in the order they are stacked.** A flow item's place *is* its position in the
 *   markup, so a run whose `y`s do not climb with the DOM would come out re-ordered. Never a
 *   re-sorted DOM to fix that — a fid is `scene.count++` and moving an element renumbers every
 *   one after it, which is what the editor and the layers panel address a node by.
 * - **Air between them.** Overlapping boxes are a layer over a layer — a badge on a card, a
 *   gradient over a photo — and no flow expresses that. Touching is allowed, sharing is not.
 * - **Upright.** A rotated box is placed by a matrix about its own centre and a margin is not
 *   that. The same 1e-4 the rest of the file calls identity.
 * - **Pinned by the default constraint.** A child pinned right, centred or stretched already
 *   has `pinned()` writing it a rule that follows the edge it was given; a margin would take
 *   that away and hand back a fixed offset. `MIN` and `SCALE` are the ones that resolve to a
 *   plain `left`, and they are ~90% of any design.
 * - **Big enough to be a layout.** Two 0.9px dots 4px apart answer every question above like a
 *   column and are a texture. `PHONE_PX` is the same floor the lattice uses.
 */
type Column = {
  from: number;
  count: number;
  top: number;
  height: number;
  /** Each member's `margin-top` — the air above it — and `margin-left`, its own offset. */
  margin: Map<FigmaNode, [top: number, left: number]>;
};

/** The smallest box worth flowing, and the shortest run worth calling a column. */
const MIN_SIDE = 4;
const MIN_COLUMN_PX = 24;

/** `ParentBox.mode` for a column this file recovered, which no Figma field spells. */
const COLUMN = "COLUMN";

/** A constraint that resolves to a plain `left`, which is the only one a margin can replace. */
const FLOWABLE = new Set(["MIN", "SCALE", undefined]);

const columnOf = (items: FigmaNode[], parentW: number): Column | null => {
  const xOf = (n: FigmaNode) => num(n.transform?.m02);
  const yOf = (n: FigmaNode) => num(n.transform?.m12);
  const upright = (n: FigmaNode) =>
    Math.abs(num(n.transform?.m01)) <= 1e-4 &&
    Math.abs(num(n.transform?.m10)) <= 1e-4;
  const usable = (n: FigmaNode) =>
    n.visible !== false &&
    upright(n) &&
    num(n.size?.x) >= MIN_SIDE &&
    num(n.size?.y) >= MIN_SIDE &&
    FLOWABLE.has(n.horizontalConstraint as string | undefined);

  let best: Column | null = null;
  for (let i = 0; i < items.length; i += 1) {
    if (!usable(items[i])) continue;
    let j = i + 1;
    while (
      j < items.length &&
      usable(items[j]) &&
      // Below the one before it, with the whole of its own box below it too. `-0.5` so two
      // boxes that touch to the rounding error still count as stacked rather than as overlapping.
      yOf(items[j]) >= yOf(items[j - 1]) + num(items[j - 1].size?.y) - 0.5
    ) {
      j += 1;
    }
    if (j - i >= 2) {
      const run = items.slice(i, j);
      const top = yOf(run[0]);
      const height = yOf(run[j - i - 1]) + num(run[j - i - 1].size?.y) - top;
      const width = Math.max(...run.map((n) => xOf(n) + num(n.size?.x)));
      /**
       * Big enough to be a layout rather than a texture.
       *
       * Not `PHONE_PX`, which is the lattice's floor and is about a *width* having room to
       * reflow into; a column has nothing to reflow and its floor is only "is this a thing
       * somebody arranged". A heading over a paragraph is 60px and is the case this exists
       * for — measured, the 380px floor found 30 columns in the whole corpus and left the
       * overlaps almost where they were. Two 0.9px dots 4px apart are what it is keeping out,
       * and `MIN_SIDE` does that on its own.
       */
      if (height >= MIN_COLUMN_PX && width <= parentW + 0.5) {
        const margin = new Map<FigmaNode, [number, number]>();
        for (let k = 0; k < run.length; k += 1) {
          const above =
            k === 0 ? top : yOf(run[k - 1]) + num(run[k - 1].size?.y);
          margin.set(run[k], [yOf(run[k]) - above, xOf(run[k])]);
        }
        if (!best || run.length > best.count) {
          best = { from: i, count: run.length, top, height, margin };
        }
      }
    }
    i = j - 1;
  }
  return best;
};

/**
 * The column, as a box that holds its members' own height until it has to hold more.
 *
 * `left:0;right:0` rather than the run's own width: the members carry their offsets as
 * `margin-left`, so the box only has to be the space they were measured in. `min-height` with
 * `r-grow` over it is the same pair a VERTICAL auto-layout frame gets — the design's own height
 * wherever the content still fits, and the content's wherever it no longer does.
 */
/**
 * The wrapper, for the readers that have no flow to ask.
 *
 * `swiftui`, `flutter` and `compose` rebuild the layout from boxes, and a flow item has given
 * its coordinates up to the margins — read as absolute every member of a column lands on the
 * wrapper's origin, in a pile. One attribute is enough to put them back: see `stacked` in
 * `export-code.ts`. It is on the synthetic wrapper, which carries no `data-fid` and is nobody's
 * node, so it says nothing about the design either way.
 */
const COLUMN_RUN = "data-column";

const columnCss = (column: Column): string[] => [
  "position:absolute",
  "left:0",
  "right:0",
  `top:${px(column.top)}`,
  `min-height:${px(column.height)}`,
  "display:flex",
  "flex-direction:column",
  "align-items:flex-start",
];

/**
 * A flow item's own size, from the stack fields rather than from its measured box.
 *
 * `stackChildPrimaryGrow` is fill-container along the main axis, and it is `flex-grow` **from
 * the size Figma measured**, never from a basis of zero. A zero basis redistributes the whole
 * line equally among the children set to fill, and Figma's own answer is not always equal: one
 * fixture's 226px menu column came out at 173.8 and another's 400px paragraph at 403.9, its
 * `white-space:pre` refusing to go under its own text. Growing from the measured size makes
 * the design width a fixed point — `stackFits` has already proved those sizes reproduce this
 * frame — and hands the *difference* to the children that asked for it. `min-width:0` is what
 * lets them give it back: a flex item will not shrink under its content without it, so a
 * narrower box would push the row out instead of reflowing it.
 *
 * `STRETCH` is fill along the cross axis, and the fixed size beside `align-self:stretch` is
 * what was stopping it: a declared width wins over the stretch every time, so the cross size
 * has to go for the alignment already emitted to mean anything.
 */
const flowSize = (
  node: FigmaNode,
  parent: ParentBox | undefined,
  width: number,
  height: number,
  rehug: boolean | undefined,
): string[] => {
  const row = parent?.mode !== "VERTICAL";
  const grow = num(node.stackChildPrimaryGrow) === 1;
  const stretch = node.stackChildAlignSelf === "STRETCH";
  let w: string | null = rehug ? "max-content" : px(width);
  let h: string | null = px(height);
  /**
   * A stretch is only a *translation* where the measured size already **is** what stretching
   * produces. A resized instance's child keeps the size it was measured at inside its component
   * — one masonry fixture's 126px `User` row sits in a 265.6px column, because
   * `resizeByConstraints` widened the column and Figma never re-measured the row — and dropping
   * the number for `align-self:stretch` lays it out at a width the design does not have. 157
   * boxes moved that way on `pinterest`, by up to 139px, at the design's own width.
   */
  const fills = (size: number, box: number | undefined) =>
    box !== undefined && Math.abs(size - box) < 0.5;
  if (row && stretch && fills(height, parent?.innerH)) h = "auto";
  if (!row && stretch && fills(width, parent?.inner)) w = "auto";
  // `flex-basis:auto`, with the measured size left in `width`/`height` where it was. The two
  // spell the same layout, and this one keeps the number in the markup: it is what the reader
  // sees and what the native targets — which have no flex box to resolve — measure from.
  // A grid item is placed by its track, not by the flow: no `flex`, and a width that is the
  // design's own number until the track it sits in gets smaller than that.
  if (parent?.mode === "GRID") {
    return [`width:${px(width)}`, "max-width:100%", `height:${px(height)}`];
  }
  /**
   * A recovered column's member is in a flow this file invented, so none of the stack fields
   * on it are about this box. They are about whatever auto layout it was drawn in — one
   * fixture's switch carries `stackChildAlignSelf: CENTER` from a row it is no longer part of,
   * and honoured here it centres in a column aligned to the start and lands 24px across.
   * `flex-grow` is the same trap on the other axis: it would hand the member the column's
   * spare height, which the coordinates already spent.
   */
  if (parent?.mode === COLUMN) {
    return [
      "flex:none",
      `width:${px(width)}`,
      ...(width <= (parent.inner ?? -1) ? ["max-width:100%"] : []),
      `height:${px(height)}`,
    ];
  }
  const axis = row ? "width" : "height";
  return [
    grow
      ? parent?.shrink === false
        ? "flex:1 0 auto"
        : `flex:1 1 auto;min-${axis}:0`
      : "flex:none",
    ...(w ? [`width:${w}`] : []),
    // Never wider than what holds it — and only where it already is not. At the design's own
    // width this is inert, and below it, it is the whole of how a clamp reaches the text: a
    // heading pinned to the middle of the page narrows with the page, and the stack between
    // the two would otherwise hold it at full width and hang it off both edges. A child drawn
    // deliberately wider than its container is a real thing (an image bleeding out of a card)
    // and keeps its size.
    ...(w && !rehug && width <= (parent?.inner ?? -1)
      ? ["max-width:100%"]
      : []),
    ...(h ? [`height:${h}`] : []),
  ];
};

/**
 * A dashed stroke, which CSS has no box property for.
 *
 * `box-shadow` is what draws every other stroke here — a border would change the box and every
 * coordinate in the payload is measured against a box without one — and a shadow cannot dash.
 * `border-style:dashed` can, but it takes the box back *and* picks its own dash length from the
 * weight, so Figma's pattern is gone either way. Drawn solid instead, a ring of 1.1px ticks
 * spaced 48px apart is a solid 17.5px band: the tick marks around one hero's dial came out as a
 * thick grey ring covering them.
 *
 * So it goes out as an SVG laid over the box, where `stroke-dasharray` is exactly this. It is
 * absolutely positioned, which also keeps it out of a flex container's flow — an SVG in the
 * normal flow would become the first flex item and push every real child along.
 *
 * `overflow:visible` because the outer half of a CENTER stroke, and all of an OUTSIDE one, fall
 * outside the box the SVG is sized to.
 */
const dashedStrokeSvg = (
  node: FigmaNode,
  width: number,
  height: number,
  colour: string,
  weight: number,
  /** Needed only to decode a shape that is not a box — see below. */
  options?: SceneOptions,
): string | null => {
  const dashes = (node.dashPattern as unknown[] | undefined) ?? [];
  if (!dashes.length || weight <= 0 || width <= 0 || height <= 0) return null;
  // Per-side weights are four separate borders; there is no one path to dash.
  if (node.borderStrokeWeightsIndependent) return null;

  const type = node.type ?? "";
  // A partial arc is already drawn as a path by `vectorSvg`, dashes and all.
  const arc = node.arcData as
    { startingAngle?: number; endingAngle?: number } | undefined;
  if (
    type === "ELLIPSE" &&
    arc &&
    Math.abs(num(arc.endingAngle) - num(arc.startingAngle) - Math.PI * 2) > 1e-3
  )
    return null;

  // Figma aligns the stroke to the box edge; SVG centres it on the path, so the path moves.
  const inset =
    node.strokeAlign === "INSIDE"
      ? weight / 2
      : node.strokeAlign === "OUTSIDE"
        ? -weight / 2
        : 0;

  /**
   * Anything that is not a box still has an outline, and `maskPathsOf` knows how to find it —
   * the same walk a mask and a boolean already use, which prefers real geometry over a bounding
   * box and handles the parametric shapes too. Without it a dashed star, polygon or vector fell
   * through to a solid ring: one paste reported 84 dashed strokes drawn solid, and a design of
   * dotted particles came out as continuous outlines.
   */
  if (type !== "ELLIPSE" && !BOXES.has(type)) {
    const paths = options
      ? maskPathsOf(node, options, [1, 0, 0, 1, 0, 0], false)
      : [];
    if (!paths.length) return null;
    const outline = paths
      .map(
        (path) =>
          `<path d="${path.d}" transform="matrix(${path.matrix
            .map((n) => Math.round(n * 10000) / 10000)
            .join(",")})" fill="none"/>`,
      )
      .join("");
    return `<svg aria-hidden="true" focusable="false" style="${styleAttr([
      "position:absolute",
      "left:0",
      "top:0",
      "overflow:visible",
      "pointer-events:none",
    ])}" width="${round2(width)}" height="${round2(height)}" viewBox="0 0 ${round2(
      width,
    )} ${round2(height)}" fill="none" stroke="${colour}" stroke-width="${round2(
      weight,
    )}" stroke-dasharray="${dashes.map((d) => round2(num(d))).join(" ")}"${
      node.strokeCap === "ROUND" ? ' stroke-linecap="round"' : ""
    } vector-effect="non-scaling-stroke">${outline}</svg>`;
  }

  const shape =
    type === "ELLIPSE"
      ? `<ellipse cx="${round2(width / 2)}" cy="${round2(height / 2)}" rx="${round2(
          width / 2 - inset,
        )}" ry="${round2(height / 2 - inset)}"`
      : `<rect x="${round2(inset)}" y="${round2(inset)}" width="${round2(
          width - inset * 2,
        )}" height="${round2(height - inset * 2)}"${
          num(node.cornerRadius) > 0
            ? ` rx="${round2(num(node.cornerRadius))}"`
            : ""
        }`;

  const cap = node.strokeCap === "ROUND" ? ' stroke-linecap="round"' : "";
  return `<svg aria-hidden="true" focusable="false" style="${styleAttr([
    "position:absolute",
    "left:0",
    "top:0",
    "overflow:visible",
    "pointer-events:none",
  ])}" width="${round2(width)}" height="${round2(height)}" viewBox="0 0 ${round2(
    width,
  )} ${round2(height)}" fill="none">${shape} stroke="${colour}" stroke-width="${round2(
    weight,
  )}" stroke-dasharray="${dashes.map((d) => round2(num(d))).join(" ")}"${cap}/></svg>`;
};

/** Every visible paint, bottom-first, the order Figma stacks them in. */
const visiblePaints = (paints: unknown): Paint[] =>
  Array.isArray(paints)
    ? (paints as Paint[]).filter((p) => p.visible !== false && p.type)
    : [];

const FIT: Record<string, string> = {
  FILL: "center/cover no-repeat",
  FIT: "center/contain no-repeat",
  STRETCH: "0 0/100% 100% no-repeat",
  TILE: "0 0 repeat",
};

/**
 * How an image paint sits in its box, as one `background` shorthand `position/size repeat`.
 *
 * `STRETCH` is not stretch — it is what Figma's UI calls **Crop**, and the crop is the paint's
 * `transform`: a 2×3 mapping the box's unit square into the image's, so the window on show runs
 * from `m02` to `m02+m00` across and `m12` to `m12+m11` down. Read as "fill the box", a logo
 * cropped to a fifth of its source is the whole source squashed into a 192×56 strip — a blur
 * where the wordmark was — and a laptop mockup loses a third of its height. Neither is
 * reported, because the mapper thought it had drawn the paint.
 *
 * The window becomes a scale of `1/m00 × 1/m11` and a background-position percentage, which CSS
 * defines as aligning P% of the image with P% of the box: `offset = P(boxW − imgW)`, and the
 * offset wanted is `−m02·imgW`, so `P = m02/(1 − m00)`. At `m00 = 1` the image is exactly as
 * wide as the box, every P gives the same zero offset, and the expression is 0/0.
 */
const imageFit = (paint: Paint, report: (what: string) => void): string => {
  const t = paint.transform;

  /**
   * A tile has a size of its own, and it is not the texture's.
   *
   * Figma stores `scale` beside the source dimensions, and every tiled paint in the corpus
   * carries one — 0.2 to 2.0. Ignored, the grain comes out at whatever the source happens to
   * be: a 1024px noise at scale 2 tiles twice as densely as the design, which is the
   * difference between a starfield you can barely see and a snowstorm across a hero.
   */
  if (paint.imageScaleMode === "TILE") {
    const scale = num(paint.scale, 1);
    const w = num(paint.originalImageWidth) * scale;
    const h = num(paint.originalImageHeight) * scale;
    // CSS cannot turn a background tile; the pattern is drawn upright and says so.
    if (num(paint.rotation)) report("tiled image rotation not applied");
    return w > 0 && h > 0 ? `0 0/${px(w)} ${px(h)} repeat` : FIT.TILE;
  }

  if (paint.imageScaleMode !== "STRETCH" || !t) {
    return FIT[paint.imageScaleMode as string] ?? FIT.FILL;
  }
  /**
   * A rotated or skewed crop needs a transform on the element, not a background-position — and
   * a **tolerance**, not `!== 0`. Figma writes a matrix for every paint and an unrotated one
   * arrives a rounding error from identity: `6.1e-17` is not a rotation, but it is truthy, and
   * every one of this corpus's three "rotated" crops was one of those. The same 1e-4 the node's
   * own identity test uses, where the worst it hides is a tenth of a pixel across a thousand.
   */
  if (Math.abs(num(t.m01)) > 1e-4 || Math.abs(num(t.m10)) > 1e-4) {
    report("rotated image crop drawn unrotated");
  }

  const axis = (scale: number, offset: number) => {
    if (!scale) return { size: "100%", pos: "50%" };
    const size = 100 / scale;
    return {
      size: `${round2(size)}%`,
      pos: `${round2(Math.abs(1 - scale) < 1e-6 ? 0 : (100 * offset) / (1 - scale))}%`,
    };
  };
  const x = axis(num(t.m00, 1), num(t.m02));
  const y = axis(num(t.m11, 1), num(t.m12));
  return `${x.pos} ${y.pos}/${x.size} ${y.size} no-repeat`;
};

/**
 * Every fill a node carries, not only the first.
 *
 * Figma stacks fills bottom-first and CSS stacks background layers top-first, so the list is
 * reversed. 60 nodes across the corpus carry more than one and 70 paints were being dropped
 * without a word: the gradient that fades a phone mockup out, the tint over a photograph, the
 * sheen on a button. A single paint keeps the old path, which can still fold its own opacity
 * into the colour and paint a placeholder for an image that will not resolve.
 *
 * A solid is not a background image, so it rides as a two-stop gradient of itself — the only
 * way CSS lets a colour sit above another layer.
 */
const backgroundLayers = (
  paints: Paint[],
  box: { width: number; height: number },
  options: SceneOptions,
  report: (what: string) => void,
  /**
   * Where a layer CSS cannot express goes instead. A background layer has no alpha of its own,
   * so a translucent image has to become an element — and only the **topmost** paint can, since
   * an overlay draws above every background layer. Peeling it keeps the order the design has.
   */
  overlay?: (own: { html: string; clip: boolean }) => void,
): string[] | null => {
  const layers: string[] = [];
  const blends: string[] = [];
  const layer = (paint: Paint, css: string) => {
    layers.push(css);
    const blend = paint.blendMode as string | undefined;
    blends.push(
      !blend || blend === "NORMAL" ? "normal" : (BLEND[blend] ?? "normal"),
    );
    if (blend && blend !== "NORMAL" && !BLEND[blend]) {
      report(`${blend.toLowerCase()} fill blend mode has no CSS equivalent`);
    }
  };
  const stack = [...paints].reverse();
  for (const [index, paint] of stack.entries()) {
    if (paint.type === "IMAGE") {
      const ref = imageRef(paint);
      const url = ref && options.image?.(ref);
      if (!url) {
        report("image fill unresolved — no file key on this paste");
        continue;
      }
      report("image fill fetched from Figma");

      /**
       * A background layer has no alpha of its own, so the layer below shows through it.
       *
       * CSS has no per-layer opacity: `opacity` on the element fades the whole stack, and
       * `background-blend-mode` cannot dim. So an image at 15% over a solid was drawn at full
       * strength — a pattern the design keeps to a whisper came out as bold ink over the top
       * of it.
       *
       * Where the paint directly beneath is an opaque solid there is an exact answer, and it
       * is the definition of what alpha means: put that solid back over the image at the
       * remainder. `0.85` of the base over the image *is* the image at `0.15` — nothing is
       * approximated, the arithmetic has only moved into a second layer.
       *
       * The scrim is pushed first because CSS stacks backgrounds top-first, and this one has
       * to sit above the image it is dimming.
       */
      const alpha = num(paint.opacity, 1);
      const under = stack[index + 1];
      const opaque =
        under?.type === "SOLID" &&
        num(under.color?.a, 1) >= 1 &&
        num(under.opacity, 1) >= 1
          ? under
          : null;
      if (alpha < 1 && opaque?.color) {
        const scrim = rgba(opaque.color, 1 - alpha);
        layer({ type: "SOLID" }, `linear-gradient(${scrim},${scrim})`);
      } else if (alpha < 1 && index === 0 && overlay) {
        const own = imageOverlay(paint, url, box.width, box.height, report);
        if (own) {
          overlay(own);
          continue;
        }
        report("image fill opacity not applied");
      } else if (alpha < 1) {
        report("image fill opacity not applied");
      }

      layer(paint, `url('${url}') ${imageFit(paint, report)}`);
      continue;
    }
    const css = paintCss(paint, box, report);
    if (!css) continue;
    layer(
      paint,
      paint.type === "SOLID" ? `linear-gradient(${css},${css})` : css,
    );
  }
  if (!layers.length) return null;

  const declarations = [`background:${layers.join(",")}`];
  /**
   * A paint carries its own blend mode, and `background-blend-mode` is exactly that list. It
   * only blends the layers with each other and with the element's own background-colour, never
   * with what is behind the element the way Figma's bottom fill does — but a swatch built from
   * a tiled noise at Difference under a solid at Color is otherwise just the solid, opaque and
   * covering everything below it.
   */
  if (blends.some((blend) => blend !== "normal")) {
    declarations.push(`background-blend-mode:${blends.join(",")}`);
  }
  return declarations;
};

/**
 * An image fill.
 *
 * The pixels are not in the payload — the paint carries a content hash and nothing else, and
 * the 187 blobs beside it are vector networks. So the hash becomes a URL through the REST API,
 * and a placeholder is painted underneath it: if the request fails, or no token is configured,
 * the element still reads as a picture that did not load rather than as an empty box.
 */
const imageCss = (
  paint: Paint,
  node: FigmaNode,
  resolve: SceneOptions["image"],
  report: (what: string) => void,
): string[] => {
  const ref = imageRef(paint);
  const url = ref && resolve?.(ref);

  if (!url) {
    report("image fill unresolved — no file key on this paste");
    // Only where nothing can even be attempted. Painted behind an image that *does* load, it
    // is not a fallback but a second fill — and a 5%-opacity texture across a whole hero comes
    // out as a full-strength hatch over the design.
    return [
      "background-color:rgba(120,130,150,0.10)",
      "background-image:repeating-linear-gradient(45deg,rgba(120,130,150,0.16) 0 6px,transparent 6px 12px)",
    ];
  }

  report("image fill fetched from Figma");
  const styles = [`background:url('${url}') ${imageFit(paint, report)}`];

  /**
   * The paint's own opacity, which a solid fill folds into its rgba and an image cannot: CSS
   * has no per-background-layer alpha. On a leaf that is exactly the element's opacity; with
   * children it would fade them too, so say so rather than do it.
   */
  const alpha = num(paint.opacity, 1);
  if (alpha < 1) {
    if (node.children.length) report("image fill opacity not applied");
    else styles.push(`opacity:${round2(alpha)}`);
  }

  return styles;
};

/** SVG `fill`/`stroke` take a colour, not a CSS gradient — so a gradient collapses to a stop. */
/**
 * A gradient as SVG actually draws one, rather than as the colour it happens to start on.
 *
 * Collapsing to `stops[0]` is not a dim approximation, it is a disappearance: a decorative rule
 * that fades in starts at alpha 0, and 407 of the 470 gradient paints in one design did. Every
 * one of them painted nothing. The handles come out of the same matrix inversion `gradientCss`
 * uses, projected into the `viewBox` so `userSpaceOnUse` can take them literally.
 *
 * `defs` is appended to; the id has to be document-unique because an `url(#…)` reference
 * resolves against the whole page, so two SVGs sharing an id both get the first one's gradient.
 */
const svgGradient = (
  paint: Paint,
  id: string,
  box: { x: number; y: number },
  alpha: number,
  report: (what: string) => void,
): string | null => {
  const stops = paint.stops ?? [];
  if (!stops.length) return null;

  const m = paint.transform;
  const det = m ? m.m00 * m.m11 - m.m01 * m.m10 : 0;
  if (!m || !det) return null;

  const inverse = (x: number, y: number) => ({
    x: ((m.m11 * (x - m.m02) - m.m01 * (y - m.m12)) / det) * box.x,
    y: ((m.m00 * (y - m.m12) - m.m10 * (x - m.m02)) / det) * box.y,
  });
  const start = inverse(0, 0);
  const end = inverse(1, 0);

  const to255 = (channel: number) => Math.round(num(channel) * 255);
  const marks = stops
    .map((stop) => {
      const colour = stop.color ?? { r: 0, g: 0, b: 0, a: 1 };
      return `<stop offset="${round2(num(stop.position) * 100)}%" stop-color="rgb(${to255(
        colour.r,
      )},${to255(colour.g)},${to255(colour.b)})" stop-opacity="${
        Math.round(num(colour.a, 1) * alpha * 1000) / 1000
      }"/>`;
    })
    .join("");

  if (paint.type === "GRADIENT_LINEAR") {
    return `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${round2(
      start.x,
    )}" y1="${round2(start.y)}" x2="${round2(end.x)}" y2="${round2(end.y)}">${marks}</linearGradient>`;
  }

  // Diamond and angular have no SVG equivalent; radial is the nearest sweep either can take.
  if (paint.type !== "GRADIENT_RADIAL") {
    report(
      `${String(paint.type).toLowerCase().replace(/_/g, " ")} drawn as a radial`,
    );
  }
  /**
   * Centred on the middle of the gradient's own space, not on its origin — the same handles a
   * linear reads for direction alone mean something absolute here, and read as a centre they
   * put the sweep in a corner at half again the radius. SVG, unlike CSS, can turn an ellipse:
   * the unit circle carried through the two semi-axes is the paint exactly, rotation and all.
   */
  const middle = inverse(0.5, 0.5);
  const ax = inverse(1, 0.5);
  const ay = inverse(0.5, 1);
  const unitCircle = [
    ax.x - middle.x,
    ax.y - middle.y,
    ay.x - middle.x,
    ay.y - middle.y,
    middle.x,
    middle.y,
  ];
  // A degenerate paint has no area to sweep over, and `gradientTransform` would be singular.
  if (!(unitCircle[0] * unitCircle[3] - unitCircle[2] * unitCircle[1]))
    return null;
  return `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="matrix(${unitCircle
    .map(round2)
    .join(",")})">${marks}</radialGradient>`;
};

const svgPaint = (
  paint: Paint | null,
  report: (what: string) => void,
  gradient?: { id: string; box: { x: number; y: number }; defs: string[] },
): string | null => {
  if (!paint) return null;
  const alpha = num(paint.opacity, 1);
  if (paint.type === "SOLID" && paint.color) return rgba(paint.color, alpha);
  if (paint.type?.startsWith("GRADIENT") && paint.stops?.length) {
    if (gradient) {
      const def = svgGradient(paint, gradient.id, gradient.box, alpha, report);
      if (def) {
        gradient.defs.push(def);
        return `url(#${gradient.id})`;
      }
    }
    // No transform to invert, or a degenerate one: the first stop is all there is to go on.
    report("vector gradient drawn as its first stop");
    return rgba(paint.stops[0].color, alpha);
  }
  if (paint.type === "IMAGE") {
    report("image fill not resolved");
    return null;
  }
  return null;
};

/**
 * Figma's blend modes are CSS's, name for name — except two that CSS has no equivalent for.
 * Dropping the rest would be silent, and they are one declaration each.
 */
const BLEND: Record<string, string> = {
  MULTIPLY: "multiply",
  SCREEN: "screen",
  OVERLAY: "overlay",
  DARKEN: "darken",
  LIGHTEN: "lighten",
  COLOR_DODGE: "color-dodge",
  COLOR_BURN: "color-burn",
  HARD_LIGHT: "hard-light",
  SOFT_LIGHT: "soft-light",
  DIFFERENCE: "difference",
  EXCLUSION: "exclusion",
  HUE: "hue",
  SATURATION: "saturation",
  COLOR: "color",
  LUMINOSITY: "luminosity",
  // Figma's Add and Subtract. `plus-lighter` is the same operation; without it a white glow
  // meant to add to a dark background paints as an opaque white block over the whole design.
  LINEAR_DODGE: "plus-lighter",
  LINEAR_BURN: "plus-darker",
};

type Effect = {
  type?: string;
  visible?: boolean;
  radius?: number;
  spread?: number;
  offset?: { x: number; y: number };
  color?: Color;
};

/**
 * Shadows and blurs, which were being dropped without a word until the corpus was counted:
 * sixteen nodes in one frame carried them.
 *
 * `box-shadow` follows the border-radius of the box it sits on, which is what Figma does for
 * everything except vector artwork — that gets `filter: drop-shadow`, which follows the paths.
 */
const effectsCss = (
  node: FigmaNode,
  isArtwork: boolean,
  isText: boolean,
  report: (what: string) => void,
): {
  shadows: string[];
  text: string[];
  filters: string[];
  backdrop: string[];
} => {
  const out = {
    shadows: [] as string[],
    text: [] as string[],
    filters: [] as string[],
    backdrop: [] as string[],
  };

  for (const effect of (node.effects as Effect[] | undefined) ?? []) {
    if (effect.visible === false) continue;
    const color = effect.color ? rgba(effect.color) : "rgba(0, 0, 0, 0.25)";
    const x = num(effect.offset?.x);
    const y = num(effect.offset?.y);
    const blur = num(effect.radius);

    switch (effect.type) {
      case "DROP_SHADOW":
        if (isText) {
          // `box-shadow` on a text node shadows its *box* — which is what drew a rectangle
          // around a headline that has three soft shadows on its letters.
          if (effect.spread) report("shadow spread dropped on text");
          out.text.push(`${px(x)} ${px(y)} ${px(blur)} ${color}`);
        } else if (isArtwork) {
          // No spread in `drop-shadow()`; the paths are the shape it follows.
          if (effect.spread) report("shadow spread dropped on vector artwork");
          out.filters.push(
            `drop-shadow(${px(x)} ${px(y)} ${px(blur / 2)} ${color})`,
          );
        } else {
          out.shadows.push(
            `${px(x)} ${px(y)} ${px(blur)} ${px(num(effect.spread))} ${color}`,
          );
        }
        break;
      case "INNER_SHADOW":
        /**
         * `inset` shadows the element's *box*, and on a node whose box is not its shape that
         * is a rectangle the design does not have. CSS has no inset counterpart to
         * `drop-shadow()` — the filter is outer-only — so there is nothing to fall back to.
         *
         * Painted anyway it is not a dim approximation but an addition: five 663px rings in
         * one design carry a white inner shadow at full alpha, and drawn on their bounding
         * boxes they are five hard white rectangles across the panel, over the soft arcs they
         * were supposed to trace. The same applies to text, where the box is the line box and
         * the shape is the glyphs — the trap `DROP_SHADOW` already avoids above.
         */
        // On artwork the shadow is drawn inside the SVG by `innerShadowFilter`, where it
        // follows the path. Text has no such escape: the box is the line box, the shape is the
        // glyphs, and CSS offers nothing that shadows inside them.
        if (isArtwork) break;
        if (isText) {
          report(
            "inner shadow dropped on text — it would shadow the box, not the glyphs",
          );
          break;
        }
        out.shadows.push(
          `inset ${px(x)} ${px(y)} ${px(blur)} ${px(num(effect.spread))} ${color}`,
        );
        break;
      case "FOREGROUND_BLUR":
        out.filters.push(`blur(${px(blur / 2)})`);
        break;
      case "BACKGROUND_BLUR":
        out.backdrop.push(`blur(${px(blur / 2)})`);
        break;
      case "NOISE":
      case "GRAIN":
        // Drawn as its own layer by `noiseOverlay`; nothing here can carry a texture.
        break;
      default:
        report(`${String(effect.type).toLowerCase()} effect not applied`);
    }
  }

  return out;
};

/**
 * Below this a box has no thickness at all — it is a rule, not a shape.
 *
 * Half of the smallest length `px()` can write: anything thinner rounds to `0px` and draws
 * nothing, whichever path it takes.
 */
const FLAT = 0.005;

/**
 * Which layers behave like controls, from what the designer called them.
 *
 * There is no better signal in the payload. `prototypeInteractions` sounds like one and is not:
 * across the corpus it appears on 72 nodes of one design, every one a hover *variant* of a
 * component rather than something you click. Names are what designers actually write, and they
 * write them consistently — "Button", "CTA", "Search Field", "Email Input".
 *
 * Word-bounded on purpose: a `\bbtn\b` that matched anywhere puts a pointer on "Subtn" and on
 * every "Buttons Container" wrapping the real ones. Nothing here changes a pixel — a cursor and
 * a caret are chrome, not paint — so a wrong guess costs a cursor, not a render.
 */
/**
 * The `type` a field's name asks for.
 *
 * `email` and `tel` bring the right keyboard on a phone and the browser's own validation;
 * `password` masks what is typed. Guessing from the name is the only signal there is, and the
 * cost of guessing wrong is a keyboard layout, not a render.
 */
const fieldType = (name: string) =>
  /password/i.test(name)
    ? "password"
    : /e-?mail/i.test(name)
      ? "email"
      : /phone|tel(ephone)?\b/i.test(name)
        ? "tel"
        : /search/i.test(name)
          ? "search"
          : "text";

const CLICKABLE =
  /(^|[^a-z])(button|btn|link|cta|tab|toggle|checkbox|radio)([^a-z]|$)/i;
const FIELD =
  /(^|[^a-z])(input|textfield|text ?field|search ?(bar|field|box)|email|password|placeholder)([^a-z]|$)/i;

const TAU = Math.PI * 2;

/**
 * Shapes Figma stores as parameters rather than geometry.
 *
 * A polygon is a side count, a star adds an inner radius ratio, and an ellipse with `arcData`
 * is a pie or a donut. None of them reference a vector network, so without this they are boxes.
 */
const parametricPath = (
  node: FigmaNode,
  width: number,
  height: number,
): string | null => {
  const cx = width / 2;
  const cy = height / 2;
  const rx = width / 2;
  const ry = height / 2;
  const at = (angle: number, scale = 1) =>
    `${round2(cx + Math.cos(angle) * rx * scale)} ${round2(cy + Math.sin(angle) * ry * scale)}`;

  if (node.type === "REGULAR_POLYGON" || node.type === "STAR") {
    const sides = Math.max(3, Math.round(num(node.count, 3)));
    const star = node.type === "STAR";
    const inner = star ? num(node.starInnerScale, 0.5) : 1;
    const steps = star ? sides * 2 : sides;
    const points: string[] = [];
    for (let i = 0; i < steps; i += 1) {
      // Figma points the first vertex up, and y grows downward here.
      const angle = -Math.PI / 2 + (i * TAU) / steps;
      points.push(at(angle, star && i % 2 ? inner : 1));
    }
    return `M${points.join("L")}Z`;
  }

  const arc = node.arcData as
    | { startingAngle?: number; endingAngle?: number; innerRadius?: number }
    | undefined;
  if (!arc) return null;

  const from = num(arc.startingAngle);
  const to = num(arc.endingAngle, TAU);
  const sweep = to - from;
  const inner = num(arc.innerRadius);
  // A full circle with no hole is just the ellipse the box already draws.
  if (Math.abs(sweep) >= TAU - 1e-3 && inner <= 0) return null;

  const large = Math.abs(sweep) > Math.PI ? 1 : 0;
  const dir = sweep >= 0 ? 1 : 0;
  const outer = `A${round2(rx)} ${round2(ry)} 0 ${large} ${dir} ${at(to)}`;

  /**
   * A closed ring, as two half arcs per circle.
   *
   * An arc whose endpoints coincide is not a full turn — the spec says it is dropped entirely,
   * "equivalent to omitting the elliptical arc segment". So a donut written the obvious way,
   * one arc from `from` all the way round to `to`, is a path with nothing in it: five 663px
   * rings across one design rendered as *exactly* black, and no counter saw it because the
   * geometry decoded perfectly and the paint was real. `shapePath` already draws a plain
   * ellipse this way for the same reason.
   *
   * The two circles are wound opposite ways so `nonzero` cuts the hole rather than filling it.
   */
  if (Math.abs(sweep) >= TAU - 1e-3 && inner > 0) {
    const circle = (scale: number, flag: number) => {
      const a = at(from, scale);
      const b = at(from + Math.PI, scale);
      const r = `${round2(rx * scale)} ${round2(ry * scale)}`;
      return `M${a}A${r} 0 1 ${flag} ${b}A${r} 0 1 ${flag} ${a}Z`;
    };
    return circle(1, dir) + circle(inner, dir ? 0 : 1);
  }

  if (inner > 0) {
    return `M${at(from)}${outer}L${at(to, inner)}A${round2(rx * inner)} ${round2(
      ry * inner,
    )} 0 ${large} ${dir ? 0 : 1} ${at(from, inner)}Z`;
  }
  return `M${round2(cx)} ${round2(cy)}L${at(from)}${outer}Z`;
};

/** A shape as a subpath in its parent's coordinates, for combining several into one path. */
const shapePath = (node: FigmaNode): string | null => {
  const x = num(node.transform?.m02);
  const y = num(node.transform?.m12);
  const w = num(node.size?.x);
  const h = num(node.size?.y);
  if (w <= 0 || h <= 0) return null;

  if (node.type === "ELLIPSE") {
    const rx = w / 2;
    const ry = h / 2;
    const cx = round2(x + rx);
    const cy = round2(y + ry);
    return `M${round2(cx - rx)} ${cy}A${round2(rx)} ${round2(ry)} 0 1 0 ${round2(
      cx + rx,
    )} ${cy}A${round2(rx)} ${round2(ry)} 0 1 0 ${round2(cx - rx)} ${cy}Z`;
  }

  if (node.type === "RECTANGLE" || node.type === "ROUNDED_RECTANGLE") {
    const r = Math.min(num(node.cornerRadius), w / 2, h / 2);
    if (!r) {
      return `M${round2(x)} ${round2(y)}H${round2(x + w)}V${round2(y + h)}H${round2(x)}Z`;
    }
    return `M${round2(x + r)} ${round2(y)}H${round2(x + w - r)}A${round2(r)} ${round2(
      r,
    )} 0 0 1 ${round2(x + w)} ${round2(y + r)}V${round2(y + h - r)}A${round2(r)} ${round2(
      r,
    )} 0 0 1 ${round2(x + w - r)} ${round2(y + h)}H${round2(x + r)}A${round2(r)} ${round2(
      r,
    )} 0 0 1 ${round2(x)} ${round2(y + h - r)}V${round2(y + r)}A${round2(r)} ${round2(
      r,
    )} 0 0 1 ${round2(x + r)} ${round2(y)}Z`;
  }

  return null;
};

/**
 * A boolean operation, actually performed.
 *
 * The result of the operation is not in the payload — only its operands are, and each still
 * carries whatever paint it had before the designer combined them. Figma paints the *result*,
 * so an operand's own fill and stroke are stale: the glass dome in the corpus is a blue
 * gradient on the union, over two leftover purple rectangles and a black-stroked ellipse.
 * Stacked as its operands that came out a purple slab with a hard black circle across the top.
 *
 * The shape is a `<mask>` rather than one merged path, because merging needs every operand to
 * wind the same way and an alpha mask does not care — white over white is white. That also
 * makes subtract exact (white base, black cutters) instead of the xor an even-odd fill of the
 * same subpaths actually gives, and it leaves each operand in its own coordinates: the
 * transform rides on the `<path>`, so no arc has to survive being multiplied by a matrix.
 *
 * Intersect is the one an alpha mask cannot express, and still stacks.
 */
/**
 * A boolean's shape as a CSS mask, so the box underneath can paint it.
 *
 * `booleanSvg` draws the result with SVG paint servers, and an image fill is not one — `fill`
 * takes a paint server, not a URL. So a card whose surface is a leather photograph came out as
 * a flat colour: measured, its body had a standard deviation of exactly 0 where the design has
 * 1.76 of grain, and with the texture gone the tab and the body read as two separate flat
 * shapes rather than one card.
 *
 * Handing the outline back as a mask instead puts the node back on the ordinary box path, where
 * `backgroundLayers` already stacks a solid under a photograph with each paint's own blend mode.
 * The shape is identical — it is the same `maskPathsOf` walk `booleanSvg` does — and CSS is
 * doing the clipping rather than SVG.
 */
/**
 * A shape's own outline as a CSS mask, so the box beneath can be painted normally.
 *
 * The trick `booleanMaskCss` uses is not specific to booleans: any node whose fill CSS can draw
 * but SVG cannot — which in practice means a photograph — can keep its real shape this way. The
 * paths come from the same `maskPathsOf` walk, and the mask is a data URI, so nothing is fetched
 * and no CORS applies.
 */
const shapeMaskCss = (
  paths: { d: string; evenOdd: boolean; matrix: Matrix }[],
  width: number,
  height: number,
): string[] | null => {
  const shapes = paths
    .map(
      (path) =>
        `<path d="${path.d}" transform="matrix(${path.matrix
          .map((n) => Math.round(n * 10000) / 10000)
          .join(",")})" fill="#fff"${
          path.evenOdd ? ` fill-rule="evenodd"` : ""
        }/>`,
    )
    .join("");
  if (!shapes || !(width > 0) || !(height > 0)) return null;

  const svg = encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${round2(
      width,
    )} ${round2(height)}">${shapes}</svg>`,
  );
  const url = `url('data:image/svg+xml,${svg}')`;
  return [
    `-webkit-mask-image:${url};mask-image:${url}`,
    "-webkit-mask-size:100% 100%;mask-size:100% 100%",
    "-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat",
  ];
};

const booleanMaskCss = (
  node: FigmaNode,
  options: SceneOptions,
  width: number,
  height: number,
): string[] | null => {
  if (String(node.booleanOperation ?? "UNION") !== "UNION") return null;
  if (!(width > 0) || !(height > 0)) return null;

  const kids = node.children.filter((child) => child.visible !== false);
  if (!kids.length) return null;
  const operands = kids.map((child) =>
    maskPathsOf(child, options, matrixOf(child), false),
  );
  if (operands.some((paths) => !paths.length)) return null;

  return shapeMaskCss(operands.flat(), width, height);
};

const booleanSvg = (
  node: FigmaNode,
  options: SceneOptions,
  width: number,
  height: number,
  report: (what: string) => void,
): string | null => {
  const operation = String(node.booleanOperation ?? "UNION");
  if (operation === "INTERSECT") return null;
  if (!(width > 0) || !(height > 0)) return null;

  const kids = node.children.filter((child) => child.visible !== false);
  if (!kids.length) return null;

  /**
   * Each operand's own geometry, in this node's box — the same walk a shaped mask does, which
   * already prefers `vectorNetworkBlob` over the bounding box and follows a wrapper down to the
   * shape inside it. An operand with no area comes back empty: a `LINE` is all stroke, and the
   * eight corner ticks in the corpus are two of them unioned, which have no region to fill and
   * whose bars the operand rendering already places pixel-exactly.
   */
  const operands = kids.map((child) =>
    maskPathsOf(child, options, matrixOf(child), false),
  );
  if (operands.some((paths) => !paths.length)) return null;

  const fills = ((node.fillPaints ?? []) as Paint[]).filter(
    (paint) => paint.visible !== false && paint.type,
  );
  const stroke = visiblePaint(node.strokePaints);
  const weight = num(node.strokeWeight);
  const stroked = Boolean(stroke) && weight > 0;
  if (!fills.length && !stroked) return null;

  const guid = `${node.guid?.sessionID ?? 0}-${node.guid?.localID ?? 0}`;
  const box = { x: width, y: height };
  const defs: string[] = [];

  const draw = (
    paths: { d: string; evenOdd: boolean; matrix: Matrix }[],
    colour: string,
  ) =>
    paths
      .map(
        (path) =>
          `<path d="${path.d}" transform="matrix(${path.matrix
            .map(round2)
            .join(",")})" fill="${colour}"${
            path.evenOdd ? ` fill-rule="evenodd"` : ""
          }/>`,
      )
      .join("");

  // Every mask is given its region explicitly and generously. The default is the object's own
  // bounding box grown by a tenth, which crops the outer half of a wide stroke.
  const region = `maskUnits="userSpaceOnUse" x="${round2(-width)}" y="${round2(
    -height,
  )}" width="${round2(width * 3)}" height="${round2(height * 3)}"`;
  const sheet = `<rect x="${round2(-width)}" y="${round2(-height)}" width="${round2(
    width * 3,
  )}" height="${round2(height * 3)}" fill="#fff"/>`;

  // Subtract takes the first operand and removes the rest; xor is that too when there are two,
  // and the honest thing to say when there are more.
  const cutting = operation !== "UNION";
  if (operation === "XOR" && kids.length > 2) {
    report("boolean exclude drawn as a subtract");
  }
  defs.push(
    `<mask id="b${guid}" ${region}>${operands
      .map((paths, index) =>
        draw(paths, cutting && index > 0 ? "#000" : "#fff"),
      )
      .join("")}</mask>`,
  );

  let body = "";

  if (fills.length) {
    /**
     * Every paint in the list, bottom first. Figma stacks them, and taking only the first left
     * the dome its 20% blue with neither the white top-fade nor the noise wash over it.
     */
    const layers = fills
      .map((paint, index) => {
        const colour = svgPaint(paint, report, {
          id: `f${guid}-${index}`,
          box,
          defs,
        });
        return colour
          ? `<rect x="0" y="0" width="${round2(width)}" height="${round2(
              height,
            )}" fill="${colour}"/>`
          : "";
      })
      .join("");
    if (layers) body += `<g mask="url(#b${guid})">${layers}</g>`;
  }

  if (stroked) {
    const colour = svgPaint(stroke, report, { id: `s${guid}`, box, defs });
    if (colour) {
      const inside = node.strokeAlign === "INSIDE";
      const outside = node.strokeAlign === "OUTSIDE";
      const dashes = (node.dashPattern ?? []) as number[];
      const dash = dashes.length
        ? ` stroke-dasharray="${dashes.map(round2).join(" ")}"`
        : "";
      /**
       * The outline of a union is not the outlines of its operands: where two overlap there is
       * a seam that is inside the silhouette and not on it. So each operand is stroked through
       * a mask of everything *but* the others, which erases exactly the seams.
       *
       * An inside stroke is a centred one of twice the weight clipped to the shape, and an
       * outside stroke the same with the shape knocked out — the two halves CSS gets from
       * `box-shadow` `inset`, which a path has no equivalent of.
       */
      body += operands
        .map((paths, index) => {
          /**
           * A subtracted operand's outline is the opposite case, and had the opposite mask.
           *
           * In a union every operand's edge is on the silhouette except where another covers
           * it, so knocking the others out is right. Subtracting inverts that for the shapes
           * doing the cutting: their edges are on the result exactly *where they lie inside
           * the base*, which is the region the union rule erases. A stamp is a rectangle minus
           * 54 circles around its rim, and stroked that way its border came back as a dashed
           * rectangle — the straight edge surviving between the bites, and not one scallop.
           *
           * So a cutter keeps the base and knocks out the other cutters, and its own interior
           * is what an inside stroke sits opposite: inside the *result* means outside the
           * cutter.
           */
          const cutter = cutting && index > 0;
          const rest = operands
            .filter((_, other) => other !== index && !(cutter && other === 0))
            .map((paths_) => draw(paths_, "#000"))
            .join("");
          const keep = cutter
            ? draw(operands[0], "#fff")
            : inside
              ? draw(paths, "#fff")
              : sheet;
          const self = cutter
            ? inside
              ? draw(paths, "#000")
              : ""
            : outside
              ? draw(paths, "#000")
              : "";
          defs.push(
            `<mask id="e${guid}-${index}" ${region}>${keep}${self}${rest}</mask>`,
          );
          const line = paths
            .map(
              (path) =>
                `<path d="${path.d}" transform="matrix(${path.matrix
                  .map(round2)
                  .join(
                    ",",
                  )})" fill="none" stroke="${colour}" stroke-width="${round2(
                  inside || outside ? weight * 2 : weight,
                )}"${dash} vector-effect="non-scaling-stroke"/>`,
            )
            .join("");
          return `<g mask="url(#e${guid}-${index})">${line}</g>`;
        })
        .join("");
    }
  }

  if (!body) return null;

  report(`boolean ${operation.toLowerCase()} drawn as one shape`);
  return `<svg viewBox="0 0 ${round2(width)} ${round2(
    height,
  )}" width="100%" height="100%" preserveAspectRatio="none" style="display:block;overflow:visible"><defs>${defs.join(
    "",
  )}</defs>${body}</svg>`;
};

const CAPS: Record<string, string> = { ROUND: "round", SQUARE: "square" };
const JOINS: Record<string, string> = { ROUND: "round", BEVEL: "bevel" };

/**
 * A vector node's artwork.
 *
 * The viewBox is the network's own `normalizedSize` and the element is sized to the node's box,
 * so the scaling Figma applies to a resized vector happens in the renderer rather than in
 * arithmetic here. `preserveAspectRatio="none"` because Figma's does not preserve it either.
 */
/**
 * An inner shadow that follows the shape rather than the shape's box.
 *
 * CSS has no inset counterpart to `drop-shadow()` — `box-shadow: inset` shadows the border box,
 * and on a node drawn as a path that is a rectangle the design does not have. SVG does have it,
 * as the standard five-primitive recipe: offset and blur the alpha, cut it out of the original
 * alpha to get everything *outside* the shape, flood that with the colour, and clip the result
 * back inside the shape.
 *
 * These rings are what the effect is for: five 663px annuli whose whole visible form is a white
 * inner shadow at 10% along their inner edge. As a box-shadow they were five hard rectangles;
 * dropped, the rings disappear entirely.
 *
 * The units are the `viewBox`'s, which is `normalizedSize` — the same space the paths are in and
 * the same one `strokeWeight` and `dashPattern` are already scaled to.
 */
const innerShadowFilter = (
  node: FigmaNode,
  id: string,
  scale: number,
): { def: string; ref: string } | null => {
  const shadows = ((node.effects as Effect[] | undefined) ?? []).filter(
    (effect) => effect.visible !== false && effect.type === "INNER_SHADOW",
  );
  if (!shadows.length) return null;

  const stages = shadows.map((effect, i) => {
    const dx = round2(num(effect.offset?.x) * scale);
    const dy = round2(num(effect.offset?.y) * scale);
    // Figma's radius is a diameter next to SVG's deviation, the same halving `effectsCss` does.
    const deviation = round2((num(effect.radius) * scale) / 2);
    const colour = effect.color ? rgba(effect.color) : "rgba(0, 0, 0, 0.25)";
    // `spread` has no primitive; a dilate before the blur is the nearest and is rarely set.
    return `<feOffset in="SourceAlpha" dx="${dx}" dy="${dy}" result="o${i}"/><feGaussianBlur in="o${i}" stdDeviation="${deviation}" result="b${i}"/><feComposite in="SourceAlpha" in2="b${i}" operator="out" result="c${i}"/><feFlood flood-color="${colour}" result="f${i}"/><feComposite in="f${i}" in2="c${i}" operator="in" result="s${i}"/>`;
  });

  const merge = shadows.map((_, i) => `<feMergeNode in="s${i}"/>`).join("");
  return {
    def: `<filter id="${id}" x="-25%" y="-25%" width="150%" height="150%">${stages.join(
      "",
    )}<feMerge><feMergeNode in="SourceGraphic"/>${merge}</feMerge></filter>`,
    ref: ` filter="url(#${id})"`,
  };
};

const vectorSvg = (
  node: FigmaNode,
  blobs: { bytes: Uint8Array }[] | undefined,
  width: number,
  height: number,
  report: (what: string) => void,
): string | null => {
  const data = node.vectorData as
    | {
        vectorNetworkBlob?: number;
        normalizedSize?: { x: number; y: number };
        /** Where a per-vertex corner radius lives — see `cornerStyles`. */
        styleOverrideTable?: { styleID?: number; cornerRadius?: number }[];
      }
    | undefined;

  let fills: { d: string; evenOdd: boolean }[] = [];
  let strokes: { d: string; closed: boolean }[] = [];
  let box = { x: width, y: height };
  /**
   * An arc, a ring, a rounded box: geometry built from the node's own fields rather than a
   * network, so its one path is the whole shape and carries the stroke itself. A network's
   * `fills` are regions, and a region's segments are stroked on their own — stroking the region
   * too both doubles the weight and draws the closing edge a region always has and an open run
   * of segments does not.
   */
  const parametric = data?.vectorNetworkBlob === undefined;

  if (data?.vectorNetworkBlob !== undefined) {
    const network = parseVectorNetwork(blobs?.[data.vectorNetworkBlob]?.bytes);
    if (!network) {
      report("vector geometry could not be decoded");
      return null;
    }
    box = {
      x: num(data.normalizedSize?.x, width) || width,
      y: num(data.normalizedSize?.y, height) || height,
    };
    // `cornerRadius` is in the node's own units and the network is drawn in `normalizedSize`,
    // so it crosses the same scale the `viewBox` does. Averaged because a circular fillet is an
    // ellipse under a non-uniform stretch, and it is clamped to the edges either way.
    const scale = (box.x / (width || box.x) + box.y / (height || box.y)) / 2;
    ({ fills, strokes } = networkToPaths(
      network,
      num(node.cornerRadius) * scale,
      cornerStyles(
        data as {
          styleOverrideTable?: { styleID?: number; cornerRadius?: number }[];
        },
        scale,
      ),
    ));
  } else {
    const d = parametricPath(node, width, height);
    if (!d) return null;
    fills = [{ d, evenOdd: false }];
  }

  /**
   * A `viewBox` with a zero side disables rendering of the whole SVG, and the box it sits in is
   * that flat too — so a rule stored as a line with geometry (Figma writes `normalizedSize`
   * `1440×0`) drew nothing at all. Every vertical rule on the page went that way. Handing it
   * back unclaimed lets the rule branch paint it as the bar it is.
   *
   * A **tolerance**, not `> 0`: Figma writes some of these as `1414 × 0.0000424` rather than a
   * clean zero, and `0.0000424 > 0` is true. Those slipped past into an SVG inside a box that
   * rounds to `height:0px`, which draws nothing and reports nothing — the dashed rules down
   * both sides of one page, each a horizontal line turned 90° by its own transform.
   */
  if (!(box.x > FLAT) || !(box.y > FLAT)) return null;

  /**
   * An image fill has no SVG paint to be: `fill` takes a paint server, not a URL, so a vector
   * carrying one used to resolve to nothing and the shape vanished — the two hatch columns down
   * the sides of a page are exactly that, a rectangle with a tiled texture. The box path already
   * draws image fills, and tiles them at the texture's own size, which is the one thing a
   * `<pattern>` cannot do here: the payload carries a content hash, never the tile's dimensions.
   * So hand the node back. A shape that is not a rectangle loses its outline, and says so.
   */
  if (visiblePaint(node.fillPaints)?.type === "IMAGE") {
    if (node.type !== "RECTANGLE" && node.type !== "ROUNDED_RECTANGLE") {
      report("image fill on a vector drawn as its box");
    }
    return null;
  }

  // Unique per node and per slot, so no two `<linearGradient>` in the page share an id.
  const guid = `${node.guid?.sessionID ?? 0}-${node.guid?.localID ?? 0}`;
  const defs: string[] = [];
  const fillColor = svgPaint(visiblePaint(node.fillPaints), report, {
    id: `f${guid}`,
    box,
    defs,
  });
  const strokeColor = svgPaint(visiblePaint(node.strokePaints), report, {
    id: `s${guid}`,
    box,
    defs,
  });

  /**
   * A closed outline with no region of its own is still a filled shape in Figma — 14 of them
   * in one design, every chart area among them. Drawn as strokes they come back as outlines of
   * something that should be solid.
   */
  if (!fills.length && fillColor) {
    // Closed runs only. Checked against Figma's own render of both fixtures: a chart area whose
    // outline comes back to its start is solid, and an open curve — the looping arrow on a
    // toggle — is not filled at all, however much fill paint the node carries.
    fills = strokes
      .filter((path) => path.closed)
      .map((path) => ({ d: `${path.d}Z`, evenOdd: false }));
    if (fills.length && !strokeColor) {
      strokes = strokes.filter((path) => !path.closed);
    }
  }
  const weight = num(node.strokeWeight, 1) || 1;
  const cap = CAPS[node.strokeCap as string] ?? "butt";
  const join = JOINS[node.strokeJoin as string] ?? "miter";
  /**
   * A stroke keeps its own thickness through a stretch.
   *
   * The `viewBox` is `normalizedSize` and the element is the node's `size`, and the two often
   * disagree — `preserveAspectRatio="none"` then scales x and y by different amounts, and SVG
   * scales a stroke by the geometric mean of the two. Figma does not: `strokeWeight` is a width
   * on screen and stays one. 222 of this corpus's 5344 stroked vectors are drawn under such a
   * stretch, and every one of them came out at the wrong thickness with nothing to say so —
   * curved rules on one hero read visibly heavier than the design's.
   *
   * `non-scaling-stroke` measures the width in the viewport instead, which is the node's own
   * pixels. Where the two sizes agree it is the same number it always was.
   */
  const rigid = ' vector-effect="non-scaling-stroke"';
  // The dash pattern is in the node's own units, the same space `viewBox` and `weight` are in.
  // Dropped, every dashed isometric guide in an illustration comes back as a solid rule.
  const dash =
    Array.isArray(node.dashPattern) && node.dashPattern.length
      ? ` stroke-dasharray="${(node.dashPattern as number[]).map((n) => round2(num(n))).join(" ")}"`
      : "";

  const paths = [
    // A region with no fill paint draws nothing, and is not the stroke either — dropping it
    // keeps a `fill="none"` path out of every stroked icon in the output.
    ...(fillColor || (parametric && strokeColor)
      ? fills.map(
          (path) =>
            `<path d="${path.d}" fill="${fillColor ?? "none"}" fill-rule="${
              path.evenOdd ? "evenodd" : "nonzero"
            }"${
              parametric && strokeColor
                ? ` stroke="${strokeColor}" stroke-width="${weight}" stroke-linejoin="${join}"${dash}${rigid}`
                : ""
            }/>`,
        )
      : []),
    // No fill-coloured fallback: an outline in the fill colour is what a missing fill looked
    // like, and it is indistinguishable from a shape that really is stroked.
    ...(strokeColor
      ? strokes.map(
          (path) =>
            `<path d="${path.d}" fill="none" stroke="${strokeColor}" stroke-width="${weight}" stroke-linecap="${cap}" stroke-linejoin="${join}"${dash}${rigid}/>`,
        )
      : []),
  ];
  if (!paths.length) return null;

  /**
   * The shadow is measured in the node's own units and drawn in `normalizedSize`, the same
   * crossing `cornerRadius` makes above. Averaged, because a circular blur under a non-uniform
   * stretch is an ellipse and SVG's `stdDeviation` is one number here.
   */
  const inner = innerShadowFilter(
    node,
    `i${guid}`,
    width > 0 && height > 0 ? (box.x / width + box.y / height) / 2 : 1,
  );
  if (inner) defs.push(inner.def);

  /**
   * Decorative, and said so.
   *
   * An illustration built out of markup otherwise announces its raw tree — a screen reader
   * walking "group, path, path, path" through a logo made of 40 of them. There is nothing here
   * a reader wants: the meaning of a design's artwork is never in its geometry. `focusable`
   * because IE-era SVG is still in the tab order in some engines.
   */
  return `<svg viewBox="0 0 ${round2(box.x)} ${round2(box.y)}" width="100%" height="100%" preserveAspectRatio="none" aria-hidden="true" focusable="false" style="display:block;overflow:visible">${
    defs.length ? `<defs>${defs.join("")}</defs>` : ""
  }${inner ? `<g${inner.ref}>${paths.join("")}</g>` : paths.join("")}</svg>`;
};

/**
 * A gradient's direction, from the matrix Figma ships with the paint.
 *
 * `paint.transform` maps the gradient's own space into the shape's unit square, so inverting it
 * gives the handles: (0,0) is the first stop and (1,0) the last. Everything until now flattened
 * that to a vertical sweep, which is right about as often as a design happens to use one.
 *
 * The stops are re-projected onto CSS's gradient line — which is centred on the box and as long
 * as the box's diagonal projection — so a gradient that spans only part of a shape stays where
 * the designer put it.
 */
/**
 * Whether an angular gradient's space is stretched or skewed enough for a conic to bunch it.
 * Its two half-axes are equal in length and square to each other under a plain rotation, which
 * is the case a conic reproduces exactly.
 */
const skewedSweep = (paint: Paint): boolean => {
  const m = paint.transform;
  if (!m) return false;
  const a = Math.hypot(num(m.m00, 1), num(m.m10));
  const b = Math.hypot(num(m.m01), num(m.m11, 1));
  if (!a || !b) return false;
  const dot = num(m.m00, 1) * num(m.m01) + num(m.m10) * num(m.m11, 1);
  return (
    Math.abs(a - b) / Math.max(a, b) > 0.02 || Math.abs(dot / (a * b)) > 0.02
  );
};

const gradientCss = (
  paint: Paint,
  width: number,
  height: number,
  alpha: number,
): string | null => {
  const stops = paint.stops ?? [];
  if (!stops.length) return null;

  const m = paint.transform;
  const colors = (positions: number[]) =>
    stops
      .map(
        (stop, i) =>
          `${rgba(stop.color, alpha)} ${round2(positions[i] * 100)}%`,
      )
      .join(", ");

  if (!m)
    return `linear-gradient(180deg, ${colors(stops.map((s) => num(s.position)))})`;

  const det = m.m00 * m.m11 - m.m01 * m.m10;
  if (!det)
    return `linear-gradient(180deg, ${colors(stops.map((s) => num(s.position)))})`;

  // The inverse of the 2×3 affine, applied to the gradient's unit handles.
  const inverse = (x: number, y: number) => ({
    x: (m.m11 * (x - m.m02) - m.m01 * (y - m.m12)) / det,
    y: (m.m00 * (y - m.m12) - m.m10 * (x - m.m02)) / det,
  });

  const start = inverse(0, 0);
  const end = inverse(1, 0);
  const from = { x: start.x * width, y: start.y * height };
  const to = { x: end.x * width, y: end.y * height };
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const span = Math.hypot(dx, dy);
  if (!span)
    return `linear-gradient(180deg, ${colors(stops.map((s) => num(s.position)))})`;

  if (paint.type !== "GRADIENT_LINEAR") {
    /**
     * A radial is centred on the middle of the gradient's own space, not on its origin.
     *
     * Figma writes one transform for every kind of gradient, and a linear reads only its
     * *direction* out of it — which is why (0,0)→(1,0) is right there and wrong here. Taken as
     * the centre, the origin lands in a corner of the box and the radius comes out half again
     * too large, so the first stop covers the whole shape: a hard-edged grey slab where the
     * design has a soft shadow behind a phone. Nothing reports it, because nothing about a
     * gradient was approximated — the handles were just read as the wrong gradient's.
     *
     * The two handles are the ellipse's semi-axes and Figma may turn them; CSS's cannot turn.
     * Their bounding half-extents are the closest axis-aligned ellipse, and exact whenever the
     * paint is upright or a quarter turn from it, which is very nearly all of them.
     */
    const middle = inverse(0.5, 0.5);
    const axis = (x: number, y: number) => {
      const handle = inverse(x, y);
      return {
        x: (handle.x - middle.x) * width,
        y: (handle.y - middle.y) * height,
      };
    };
    const ax = axis(1, 0.5);
    const ay = axis(0.5, 1);
    const centre = { x: round2(middle.x * 100), y: round2(middle.y * 100) };
    const rx = round2((Math.hypot(ax.x, ay.x) / (width || 1)) * 100);
    const ry = round2((Math.hypot(ax.y, ay.y) / (height || 1)) * 100);
    const spec = stops
      .map(
        (stop) =>
          `${rgba(stop.color, alpha)} ${round2(num(stop.position) * 100)}%`,
      )
      .join(", ");
    /**
     * A conic sweep is what an angular gradient *is* — the only thing CSS was dropping is where
     * it starts. `from 0deg` is the top, which is exactly right for an untransformed paint and
     * wrong by the rotation for every other one, so a sweep a designer turned by a third came
     * back upright. The rotation is the angle of gradient space's own +x half-axis measured in
     * the box, which is `0` under the identity — the case the old constant got right by
     * accident.
     *
     * What a conic still cannot do is a *non-uniform* space: CSS measures its angle circularly,
     * so a stretched sweep bunches its stops where Figma spreads them. That residual is what
     * gets reported now, rather than the whole gradient.
     */
    if (paint.type === "GRADIENT_ANGULAR") {
      const turn = round2((Math.atan2(ax.y, ax.x) * 180) / Math.PI);
      return `conic-gradient(from ${turn}deg at ${centre.x}% ${centre.y}%, ${spec})`;
    }
    return `radial-gradient(ellipse ${rx}% ${ry}% at ${centre.x}% ${centre.y}%, ${spec})`;
  }

  // CSS measures its angle from "to top", clockwise.
  const angle = (Math.atan2(dx, -dy) * 180) / Math.PI;
  const radians = (angle * Math.PI) / 180;
  const line =
    Math.abs(width * Math.sin(radians)) + Math.abs(height * Math.cos(radians));
  const unit = { x: dx / span, y: dy / span };
  const centre = { x: width / 2, y: height / 2 };
  const project = (position: number) => {
    const point = { x: from.x + dx * position, y: from.y + dy * position };
    const along = (point.x - centre.x) * unit.x + (point.y - centre.y) * unit.y;
    return 0.5 + along / (line || 1);
  };

  return `linear-gradient(${round2(angle)}deg, ${colors(stops.map((stop) => project(num(stop.position))))})`;
};

const lineHeightCss = (value: unknown, fontSize: number): string => {
  const height = value as { value?: number; units?: string } | undefined;
  if (!height || typeof height.value !== "number") return "normal";
  if (height.units === "PERCENT") return `${height.value}%`;
  if (height.units === "RAW") return `${height.value}`;
  return px(height.value || fontSize);
};

type TextData = {
  characters?: string;
  /** One style id per character, and shorter than the text when the tail is unstyled. */
  characterStyleIDs?: number[];
  styleOverrideTable?: (Paint & {
    styleID?: number;
    fillPaints?: Paint[];
    fontName?: { family?: string; style?: string };
    styleIdForFill?: { assetRef?: { key?: string } };
    /** A finished CSS paint value, put here by `foldTextOverlays`. */
    fillCss?: string;
    lineHeight?: { value?: number; units?: string };
    textCase?: string;
    fontSize?: number;
    textDecoration?: string;
  })[];
};

/**
 * Text with more than one style in it.
 *
 * `characterStyleIDs` is per character and stops early when the rest of the string is
 * unstyled, so a heading with one green word is `[0 × 12, 2 × 6]` over 36 characters. Rendered
 * as one style — which is what happened until this existed — the word is simply the wrong
 * colour, and nothing about the output says so.
 */
const textRuns = (
  data: TextData,
  /** Character offsets Figma broke a line before. */
  breaks: Set<number>,
  /** The node's own face, which a run's override is a difference from. */
  base: {
    family?: string;
    weight: number;
    italic: boolean;
    lineHeight?: { value?: number; units?: string };
    textCase?: string;
  },
  /** Faces the document must fetch. See `addFace`. */
  fonts: { family: string; weight: number; italic: boolean }[],
  /** Shared colour styles by key. See `fillStylesOf`. */
  styles: Map<string, unknown> | undefined,
  report: (what: string) => void,
): string => {
  const characters = data.characters ?? "";
  const ids = data.characterStyleIDs ?? [];
  const table = new Map(
    (data.styleOverrideTable ?? []).map((entry) => [entry.styleID ?? 0, entry]),
  );

  /**
   * The character as it should render, with Figma's break before it.
   *
   * A soft break consumes the space it broke at — leave it in and every wrapped line starts
   * with a stray indent.
   */
  const withBreaks = (text: string, at: number) => {
    if (!breaks.has(at) || at === 0 || characters[at - 1] === "\n") return text;
    return text === " " ? "\n" : `\n${text}`;
  };

  if (!table.size || !ids.length) {
    return escape(
      [...characters].map((character, i) => withBreaks(character, i)).join(""),
    );
  }

  const runs: { id: number; text: string }[] = [];
  for (let i = 0; i < characters.length; i += 1) {
    const id = ids[i] ?? 0;
    const character = withBreaks(characters[i], i);
    const last = runs[runs.length - 1];
    if (last && last.id === id) last.text += character;
    else runs.push({ id, text: character });
  }

  return runs
    .map((run) => {
      const override = table.get(run.id);
      if (!run.id || !override) return escape(run.text);

      const style: string[] = [];
      /**
       * A run's own paint, or the shared colour style it names. The override table stores only
       * what differs, so a run coloured from a style carries the reference and no paint — and
       * the swatch it points at travels with the copy.
       */
      const referenced = override.styleIdForFill?.assetRef?.key;
      const paint =
        visiblePaint(override.fillPaints) ??
        (referenced
          ? visiblePaint(styles?.get(referenced) as Paint[] | undefined)
          : undefined);

      /**
       * A run painted with a gradient, which is what a folded overlay is. The same trap the
       * node itself has: a gradient assigned to `color` is an invalid declaration and is
       * dropped, so the run renders in whatever it inherited. `display:inline-block` because a
       * background box on an inline that wraps is split across the lines.
       */
      if (override.fillCss?.includes("gradient(")) {
        style.push(
          `background-image:${override.fillCss}`,
          "-webkit-background-clip:text",
          "background-clip:text",
          "color:transparent",
          "display:inline-block",
        );
      } else if (override.fillCss) {
        style.push(`color:${override.fillCss}`);
      }
      if (!override.fillCss && paint?.type === "SOLID" && paint.color) {
        style.push(`color:${rgba(paint.color, num(paint.opacity, 1))}`);
      }
      if (override.fontSize) style.push(`font-size:${px(override.fontSize)}`);

      /**
       * A run's weight, which is the most common override there is and was being dropped: one
       * bold word in a sentence came back at the sentence's weight, and so did a whole heading
       * whose second half is the light one. The weight lives in `fontName.style` and nowhere
       * else, exactly as it does on the node — and the face has to be registered or Google
       * Fonts is never asked for it and the browser paints a synthetic bold instead.
       */
      const face = override.fontName;
      const family = face?.family ?? base.family;
      const weight = face?.style ? weightOf(face.style) : base.weight;
      const italic = face?.style
        ? /italic|oblique/i.test(face.style)
        : base.italic;
      if (face?.family) style.push(`font-family:${familyStack(face.family)}`);
      if (weight !== base.weight) style.push(`font-weight:${weight}`);
      if (italic !== base.italic)
        style.push(`font-style:${italic ? "italic" : "normal"}`);
      if (face?.family || face?.style) addFace(fonts, family, weight, italic);
      if (override.textDecoration === "UNDERLINE")
        style.push("text-decoration:underline");
      if (override.textCase !== base.textCase)
        style.push(...textCaseCss(override.textCase));
      /**
       * Only when something was genuinely left on the floor. Figma writes a run's inherited
       * values back into the override table as well as its changed ones, so a table entry
       * repeating the node's own line height renders nothing *because there is nothing to
       * render* — and both of this corpus's remaining reports were exactly that.
       */
      const lh = override.lineHeight;
      const inherited =
        !lh ||
        (lh.value === base.lineHeight?.value &&
          lh.units === base.lineHeight?.units);
      if (!style.length && !inherited)
        report("text style override carried nothing this renders");

      return `<span style="${styleAttr(style)}">${escape(run.text)}</span>`;
    })
    .join("");
};

/**
 * `fontName.style` is where the weight is — "Bold", "SemiBold", "Light" — and nothing else in
 * the payload carries it. Emitting only the family renders a heavy display face at 400.
 */
/**
 * A face the document has to fetch. Every emitted `font-family`/`font-weight` pair has to end up
 * here or Google Fonts is never asked for it and the browser fakes the weight — and asking for
 * one the design does not use 400s the whole stylesheet, so it is this list exactly.
 */
const addFace = (
  fonts: { family: string; weight: number; italic: boolean }[],
  family: string | undefined,
  weight: number,
  italic: boolean,
) => {
  if (!family) return;
  if (
    !fonts.some(
      (f) => f.family === family && f.weight === weight && f.italic === italic,
    )
  )
    fonts.push({ family, weight, italic });
};

const WEIGHTS: [RegExp, number][] = [
  [/extra[ -]?black|ultra[ -]?black/i, 950],
  [/black|heavy/i, 900],
  [/extra[ -]?bold|ultra[ -]?bold/i, 800],
  [/semi[ -]?bold|demi[ -]?bold/i, 600],
  [/bold/i, 700],
  [/medium/i, 500],
  [/extra[ -]?light|ultra[ -]?light/i, 200],
  [/thin|hairline/i, 100],
  [/light/i, 300],
];

const weightOf = (style: string | undefined): number => {
  if (!style) return 400;
  for (const [pattern, weight] of WEIGHTS)
    if (pattern.test(style)) return weight;
  return 400;
};

/**
 * Case is a *style* in Figma, not the characters.
 *
 * `textData.characters` is what was typed and `textCase` is how it draws, so a button whose
 * label was typed "get Started Free" and set to Title Case came back with a lowercase g. The
 * transform never changes the character count, so Figma's own line breaks — which are character
 * offsets into that same string — still land where they belong.
 */
const textCaseCss = (value: unknown): string[] => {
  switch (value) {
    case "UPPER":
      return ["text-transform:uppercase"];
    case "LOWER":
      return ["text-transform:lowercase"];
    case "TITLE":
      return ["text-transform:capitalize"];
    case "SMALL_CAPS":
      return ["font-variant:small-caps"];
    case "SMALL_CAPS_FORCED":
      return ["text-transform:uppercase", "font-variant:small-caps"];
    default:
      return [];
  }
};

const TEXT_ALIGN: Record<string, string> = {
  LEFT: "left",
  CENTER: "center",
  RIGHT: "right",
  JUSTIFIED: "justify",
};

const ALIGN: Record<string, string> = {
  LEFT: "flex-start",
  CENTER: "center",
  RIGHT: "flex-end",
  JUSTIFIED: "flex-start",
};

/** Types Phase 1 draws as a box. Anything else gets its bounds and a report. */
const BOXES = new Set([
  "LINE",
  "FRAME",
  "GROUP",
  "SYMBOL",
  "INSTANCE",
  "SECTION",
  "RECTANGLE",
  "ROUNDED_RECTANGLE",
  "ELLIPSE",
  "TEXT",
]);

/** The component an instance stands for, when it brought no children of its own. */
type Guid = { sessionID: number; localID: number };
type Override = Record<string, unknown> & {
  guidPath?: { guids?: Guid[] };
};

const guidKey = (guid?: Guid) =>
  guid ? `${guid.sessionID}:${guid.localID}` : "";

/**
 * What one instance changed about its component.
 *
 * A component is a default and an instance is that default with edits — the text retyped, a
 * layer hidden, a colour changed. Rendering the symbol alone gives the default, which is why a
 * signup form came out reading "Label", "Placeholder", "Button" and "Text" where the design
 * has the real copy: every string in it belongs to an instance, and the component they all
 * come from says "Label".
 *
 * The edits are `symbolData.symbolOverrides`, each a `guidPath` and the fields it replaces. The
 * path is **not** made of node guids — it is `overrideKey`, a separate identity Figma gives
 * every node inside a component, and matching on `guid` finds nothing at all: 0 of 149 in one
 * fixture, against 42 by `overrideKey` and every one of its 11 text overrides.
 *
 * A path longer than one segment addresses a node inside a *nested* instance, whose own symbol
 * is not resolved until that instance renders. Those are handed down: the first segment names
 * the nested instance, the rest travels with it as overrides of its own.
 */
const applyOverrides = (
  nodes: FigmaNode[],
  overrides: Map<string, Override>,
): FigmaNode[] => {
  if (!overrides.size) return nodes;

  return nodes.map((node) => {
    const key = guidKey(node.overrideKey as Guid | undefined);
    if (!key) return node;

    const own = overrides.get(key);
    // Everything addressed further down, with this segment stripped off the front.
    const deeper = new Map<string, Override>();
    for (const [path, override] of overrides) {
      if (path.startsWith(`${key}/`))
        deeper.set(path.slice(key.length + 1), override);
    }
    if (!own && !deeper.size) return node;

    const merged: FigmaNode = { ...node, ...own };
    // `guidPath` is the address, not a property of the node it addresses.
    delete (merged as Record<string, unknown>).guidPath;
    // Retyped text is broken into lines at the old string's offsets otherwise.
    const retyped = (own?.textData as { characters?: string } | undefined)
      ?.characters;
    if (
      retyped !== undefined &&
      retyped !==
        (node.textData as { characters?: string } | undefined)?.characters
    ) {
      delete (merged as Record<string, unknown>).derivedTextData;
      // Its `size` is the old string's too, and no new one is in the payload — see `rehug`.
      merged.retyped = true;
    }

    if (deeper.size) {
      merged.children = applyOverrides(node.children, deeper);
      /**
       * A nested instance resolves its own symbol later, so what is left of the path has to
       * travel with it. Appended, not prepended: the outer instance is editing what the inner
       * one already says, so it is the one that wins.
       */
      if (node.type === "INSTANCE") {
        const inherited = [...deeper].map(([path, override]) => ({
          ...override,
          guidPath: {
            guids: path.split("/").map((part) => {
              const [sessionID, localID] = part.split(":").map(Number);
              return { sessionID, localID };
            }),
          },
        }));
        const data = (merged.symbolData ?? {}) as Record<string, unknown>;
        merged.symbolData = {
          ...data,
          symbolOverrides: [
            ...((data.symbolOverrides as Override[] | undefined) ?? []),
            ...inherited,
          ],
        };
      }
    }
    return merged;
  });
};

/**
 * Component properties, which are the other way an instance differs from its component.
 *
 * An override addresses a node by path and replaces its fields. A *property* is indirect: the
 * component declares one, a node inside it says "my text comes from that property"
 * (`componentPropRefs`), and each instance supplies a value (`componentPropAssignments`). The
 * two are joined by `defID`. Modern component libraries are built almost entirely this way, so
 * a form whose every string is a text property renders as the component's own defaults —
 * "Label", "Placeholder", "Button" — with the design's real copy nowhere in the output.
 *
 * Three fields carry: the text itself, whether a layer shows at all, and which component a
 * nested instance points at (a swap property — an icon slot).
 */
/**
 * What one property assignment is worth, in whichever form it arrives.
 *
 * A plain assignment writes `value`; one bound to a variable writes `varValue.value` instead —
 * and *only* that, with no `value` beside it. They also disagree on names: text is `textValue`
 * in the first and `textDataValue` in the second. Reading one form gets the strings and leaves
 * every icon slot in the design pointing at its component's default.
 */
const propValue = (assignment: {
  value?: Override;
  varValue?: { value?: Override };
}) => {
  const plain = assignment.value ?? {};
  const bound = assignment.varValue?.value ?? {};
  const text = (plain.textValue ?? bound.textDataValue) as
    { characters?: string } | undefined;
  const bool = (plain.boolValue ?? bound.boolValue) as boolean | undefined;
  const symbol = (plain.symbolIdValue ?? bound.symbolIdValue) as
    { guid?: Guid } | undefined;
  return { text, bool, swap: symbol?.guid };
};

type PropValue = ReturnType<typeof propValue>;

const applyProps = (
  nodes: FigmaNode[],
  values: Map<string, PropValue>,
): FigmaNode[] =>
  nodes.map((node) => {
    const refs = node.componentPropRefs as
      { defID?: Guid; componentPropNodeField?: string }[] | undefined;
    const children = applyProps(node.children, values);
    if (!refs?.length) {
      return children === node.children ? node : { ...node, children };
    }

    const out: FigmaNode = { ...node, children };
    for (const ref of refs) {
      const value = values.get(guidKey(ref.defID));
      if (!value) continue;
      const { text, bool, swap } = value;

      if (ref.componentPropNodeField === "TEXT_DATA" && text) {
        out.textData = text;
        /**
         * `derivedTextData` is Figma's own line breaking, and it is the only description of
         * this text that is not a guess about font metrics — so it is dropped only when the
         * string it describes is no longer the string being drawn. A property that assigns
         * the same characters the component already had (which is most of them) keeps it.
         */
        if (
          text.characters !==
          (node.textData as { characters?: string } | undefined)?.characters
        ) {
          delete (out as Record<string, unknown>).derivedTextData;
        }
      } else if (
        ref.componentPropNodeField === "VISIBLE" &&
        bool !== undefined
      ) {
        out.visible = bool;
      } else if (
        ref.componentPropNodeField === "OVERRIDDEN_SYMBOL_ID" &&
        swap
      ) {
        // The same slot, reached through a property rather than a direct override.
        out.overriddenSymbolID = swap;
      }
    }
    return out;
  });

const componentOf = (
  node: FigmaNode,
  symbols: SceneOptions["symbols"],
): FigmaNode | null => {
  if (node.children.length || !symbols) return null;
  /**
   * A swap property points the instance at a *different* component.
   *
   * That is what an icon slot is: one nav row component whose icon is an instance, and each row
   * swaps it for Search, Notification, Menu or Add. `symbolData.symbolID` still names the slot's
   * default, so reading only that draws the same generic glyph down the whole menu — every icon
   * in one sidebar came out as the same rounded square. `applyOverrides` puts the swap on the
   * node; this is where it takes effect.
   */
  const swapped = node.overriddenSymbolID as Guid | undefined;
  const id = swapped ? guidKey(swapped) : symbolIdOf(node);
  const symbol = (id ? symbols.get(id) : null) ?? null;
  if (!symbol) return null;

  const overrides = (
    (node.symbolData as { symbolOverrides?: Override[] } | undefined)
      ?.symbolOverrides ?? []
  ).filter((override) => override.guidPath?.guids?.length);

  const assignments = (node.componentPropAssignments ?? []) as {
    defID?: Guid;
    value?: Override;
    varValue?: { value?: Override };
  }[];

  if (!overrides.length && !assignments.length) return symbol;

  let children = symbol.children;

  if (assignments.length) {
    const values = new Map<string, PropValue>();
    for (const assignment of assignments) {
      if (assignment.defID)
        values.set(guidKey(assignment.defID), propValue(assignment));
    }
    children = applyProps(children, values);
  }

  if (overrides.length) {
    const byPath = new Map<string, Override>();
    for (const override of overrides) {
      byPath.set(
        (override.guidPath?.guids ?? []).map(guidKey).join("/"),
        override,
      );
    }
    // After the properties: an override is the edit made on this instance directly, and it is
    // the more specific of the two.
    children = applyOverrides(children, byPath);
  }

  return { ...symbol, children };
};

/**
 * A mask that is really a picture.
 *
 * Figma masks by alpha, so a tiled texture used as a mask is exactly what CSS calls a
 * `mask-image` — no geometry to derive, and none available anyway when the mask is an instance
 * whose component is three levels of indirection away. Following that chain to the image is
 * what turns a grey slab back into a pattern.
 */
/**
 * A gradient mask, anchored anywhere.
 *
 * Figma masks by alpha, and a CSS gradient used as a `mask-image` is read by its alpha too
 * (`mask-mode: match-source` on an image means alpha), so the stops carry straight over — this
 * is the one mask kind CSS reproduces exactly rather than approximates. The bounding box turns
 * a fade into a hard edge at full strength: a starfield under a radial mask that should dim to
 * nothing at the corners covered its whole 896px square instead.
 *
 * `dx`/`dy` are where the element being masked sits, so the same mask can be put on a run's
 * wrapper (0, 0) or on one child of that run — see `blends` in `render`.
 */
const gradientMaskCss = (
  mask: FigmaNode,
  dx: number,
  dy: number,
): string[] | null => {
  const paint = visiblePaint(mask.fillPaints);
  if (!paint?.type?.startsWith("GRADIENT")) return null;

  const w = num(mask.size?.x);
  const h = num(mask.size?.y);
  if (!(w > 0) || !(h > 0)) return null;
  // The node's own opacity is part of the mask, the way `maskPathsOf` folds it in for paths.
  const css = gradientCss(paint, w, h, num(mask.opacity, 1));
  if (!css) return null;

  const x = px(num(mask.transform?.m02) - dx);
  const y = px(num(mask.transform?.m12) - dy);
  return [
    `-webkit-mask-image:${css};mask-image:${css}`,
    `-webkit-mask-position:${x} ${y};mask-position:${x} ${y}`,
    `-webkit-mask-size:${px(w)} ${px(h)};mask-size:${px(w)} ${px(h)}`,
    "-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat",
  ];
};

/**
 * A background blur that fades, because in Figma the layer's own alpha modulates it.
 *
 * `backdrop-filter` has no gradient: it is on or off across the whole element. So a rect whose
 * fill ramps from clear to opaque — which is how every progressive blur over an image is drawn
 * — came out fully blurred from its very first row. Measured against Figma on one design, our
 * local contrast fell from 8.42 to 0.80 in eight pixels where the design takes sixty to get
 * there.
 *
 * The ramp *is* the fill's alpha, so it becomes a CSS mask and the fill is painted opaque
 * underneath. Mask × opaque fill is the alpha the design asked for, exactly — nothing is
 * approximated, the alpha has only moved from the paint to the mask, where it can also govern
 * the blur.
 */
const fadedBackdrop = (
  paint: Paint,
  width: number,
  height: number,
): { mask: string[]; fill: Paint } | null => {
  const stops = paint.stops ?? [];
  if (!paint.type?.startsWith("GRADIENT") || stops.length < 2) return null;
  const alphas = stops.map((stop) => num(stop.color?.a, 1));
  // Uniform alpha needs no ramp: the blur is meant to be flat.
  if (Math.max(...alphas) - Math.min(...alphas) < 0.02) return null;

  const white = { r: 1, g: 1, b: 1 };
  const ramp = gradientCss(
    {
      ...paint,
      stops: stops.map((stop) => ({
        ...stop,
        color: { ...white, a: num(stop.color?.a, 1) },
      })),
    },
    width,
    height,
    1,
  );
  if (!ramp) return null;

  return {
    mask: [
      `-webkit-mask-image:${ramp};mask-image:${ramp}`,
      "-webkit-mask-size:100% 100%;mask-size:100% 100%",
      "-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat",
    ],
    fill: {
      ...paint,
      stops: stops.map((stop) => ({
        ...stop,
        color: { ...(stop.color ?? white), a: 1 },
      })),
    },
  };
};

/**
 * Declarations plus the angle the mask has to be turned by, which no declaration can say.
 *
 * Carried as a marker line rather than a second return value, because every mask path already
 * returns `string[]` and only one kind of mask can be rotated at all. `maskWrapper` reads it
 * back and strips it.
 */
const ROTATE = "--mask-rotate:";

const withRotation = (deg: number, declarations: string[]) =>
  deg ? [...declarations, `${ROTATE}${round2(deg)}`] : declarations;

/**
 * Per-vertex corner radii, from the table the vector data ships them in.
 *
 * A network's vertices carry a `styleID` and `vectorData.styleOverrideTable` says what each one
 * means — one bracket's two ends are 500 and 600 while every other corner is square, and the
 * node itself has no `cornerRadius` at all. Scaled the same way the node's own radius is,
 * because both are in the node's units and the paths are drawn in `normalizedSize`.
 */
const cornerStyles = (
  data:
    | { styleOverrideTable?: { styleID?: number; cornerRadius?: number }[] }
    | undefined,
  scale: number,
): Map<number, number> | undefined => {
  const table = data?.styleOverrideTable;
  if (!table?.length) return undefined;
  const out = new Map<number, number>();
  for (const style of table) {
    if (style.styleID !== undefined && num(style.cornerRadius) > 0)
      out.set(style.styleID, num(style.cornerRadius) * scale);
  }
  return out.size ? out : undefined;
};

/**
 * A stroke that is a gradient, drawn as one.
 *
 * Every other stroke here is a `box-shadow`, because a border changes the box and every
 * coordinate in the payload is measured against a box without one. A shadow takes a colour, so
 * a gradient stroke was averaged down to a single flat tone — 71 of them across this corpus,
 * every ring lit by a sweep reduced to the middle of it.
 *
 * The ring is an overlay instead: an element the size of the box with a transparent border, the
 * gradient painted across its border box, and a mask that keeps only the border. Its own box
 * carries the border, so the node's box does not move; `mask-composite` cuts the middle out.
 * The two mask layers are the same image — one clipped to the padding box, one to the border
 * box — and excluding one from the other is exactly the ring between them.
 */
const gradientRing = (
  gradient: string,
  weight: number,
  align: unknown,
  radius: string,
): string | null => {
  if (!(weight > 0)) return null;
  // How far the stroke sits outside the box: none, half, or all of it.
  const out =
    align === "OUTSIDE" ? weight : align === "CENTER" ? weight / 2 : 0;
  const grow = out * 2;
  const size = (side: string) =>
    grow ? `calc(100% + ${px(grow)})` : `100%${side ? "" : ""}`;
  const fill = "linear-gradient(#000,#000)";
  return `<div style="${styleAttr([
    "position:absolute",
    `left:${px(-out)}`,
    `top:${px(-out)}`,
    `width:${size("w")}`,
    `height:${size("h")}`,
    "box-sizing:border-box",
    `border:${px(weight)} solid transparent`,
    ...(radius ? [`border-radius:${radius === "50%" ? "50%" : radius}`] : []),
    `background:${gradient} border-box`,
    `-webkit-mask:${fill} padding-box,${fill};mask:${fill} padding-box,${fill}`,
    "-webkit-mask-composite:xor;mask-composite:exclude",
    "pointer-events:none",
  ])}"></div>`;
};

/**
 * Figma's grain, as SVG turbulence.
 *
 * `NOISE` is a generated texture rather than a paint: cells of `noiseSize`, a colour, and an
 * overall `opacity`. CSS has nothing that makes noise, but SVG does — `feTurbulence` is a
 * random field, and a colour matrix turns its alpha into grains of one colour. The whole thing
 * is a data URI, so it needs no request and cannot be blocked.
 *
 * `MONOTONE` is one colour over the shape. `DUOTONE` is two, which is two layers with different
 * seeds — Figma interleaves them, and at the alphas these carry (5% and 5%) the difference
 * between interleaved and stacked is not visible.
 */
const noiseOverlay = (node: FigmaNode, report: (what: string) => void) => {
  /**
   * `GRAIN` is the same family and the same struct — a generated texture with a size, a seed
   * and a colour — so it takes the same route. It reported "not applied" 15 times across three
   * pastes, which for a texture means nothing was drawn at all; a grain that is slightly the
   * wrong coarseness is much closer than a flat surface. If a field is missing the layer comes
   * back empty and the node is exactly where it was.
   */
  const effects = ((node.effects as Effect[] | undefined) ?? []).filter(
    (effect) =>
      effect.visible !== false &&
      (effect.type === "NOISE" || effect.type === "GRAIN"),
  );
  if (!effects.length) return "";

  const layer = (effect: Effect, colour: Color | undefined, seed: number) => {
    if (!colour) return "";
    const size = num(
      (effect as { noiseSize?: { x?: number } }).noiseSize?.x,
      1,
    );
    // A cell is a wavelength, so its size is the reciprocal of the frequency.
    const frequency = size > 0 ? round2(1 / size) : 1;
    const alpha = round2(num(colour.a, 1));
    const svg = encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140">` +
        `<filter id="n" x="0" y="0" width="100%" height="100%">` +
        `<feTurbulence type="fractalNoise" baseFrequency="${frequency}" numOctaves="1" seed="${Math.round(seed)}" stitchTiles="stitch"/>` +
        // RGB to the grain's own colour, alpha to the field itself.
        `<feColorMatrix type="matrix" values="0 0 0 0 ${round2(num(colour.r))} 0 0 0 0 ${round2(num(colour.g))} 0 0 0 0 ${round2(num(colour.b))} 0 0 0 ${alpha} 0"/>` +
        `</filter><rect width="140" height="140" filter="url(#n)"/></svg>`,
    );
    return `url('data:image/svg+xml,${svg}')`;
  };

  const images = effects
    .flatMap((effect) => {
      const seed = num((effect as { seed?: number }).seed, 1);
      const duotone =
        (effect as { noiseType?: string }).noiseType === "DUOTONE";
      return [
        layer(effect, effect.color, seed),
        duotone
          ? layer(
              effect,
              (effect as { secondaryColor?: Color }).secondaryColor,
              seed + 1,
            )
          : "",
      ];
    })
    .filter(Boolean);
  if (!images.length) return "";

  const opacity = round2(num((effects[0] as { opacity?: number }).opacity, 1));
  report(`${String(effects[0].type).toLowerCase()} effect drawn as turbulence`);
  return `<div style="${styleAttr([
    "position:absolute",
    "left:0",
    "top:0",
    "width:100%",
    "height:100%",
    `background-image:${images.join(",")}`,
    "background-repeat:repeat",
    ...(opacity < 1 ? [`opacity:${opacity}`] : []),
    "border-radius:inherit",
    "pointer-events:none",
  ])}"></div>`;
};

/**
 * A crop that is turned, which no `background-position` can express.
 *
 * Figma's `STRETCH` is Crop, and the crop is a 2×3 mapping the box's unit square into the
 * image's. Where it is axis-aligned that reduces to a size and an offset, which is what
 * `imageFit` writes. Where it is not — the paint carries a rotation or a skew — there is no
 * background property that can say it, and the crop was drawn upright: the right region at the
 * wrong angle, reported 9 times across 7 pastes.
 *
 * An element carrying the image and a `matrix()` can say it exactly. The image covers the
 * element, so element pixel `(x, y)` is image-unit `(x/W, y/H)`, and it has to land where the
 * inverse crop puts it. Working that through gives the six numbers below; `transform-origin` is
 * the corner because the algebra is in the element's own space.
 */
const imageOverlay = (
  paint: Paint,
  url: string,
  width: number,
  height: number,
  report: (what: string) => void,
): { html: string; clip: boolean } | null => {
  const alpha = num(paint.opacity, 1);
  const t = paint.transform;
  const turned =
    paint.imageScaleMode === "STRETCH" &&
    !!t &&
    (Math.abs(num(t.m01)) > 1e-4 || Math.abs(num(t.m10)) > 1e-4);

  // Nothing here a background layer cannot already do.
  if (!turned && alpha >= 1) return null;

  const fade = alpha < 1 ? [`opacity:${round2(alpha)}`] : [];
  /**
   * The box it covers is not always square. `overflow:hidden` on the parent would clip the
   * overlay to a rounded card, but it also clips the card's own drop shadow and anything a
   * child hangs outside — so only a turned image, whose pixels really do leave the box, asks
   * for that. A fade inherits the radius instead and costs nothing else.
   */
  const box = ["border-radius:inherit"];
  if (!turned) {
    report("image fill opacity drawn on its own layer");
    return {
      clip: false,
      html: `<div style="${styleAttr([
        "position:absolute",
        "left:0",
        "top:0",
        "width:100%",
        "height:100%",
        `background:url('${url}') ${imageFit(paint, report)}`,
        ...box,
        ...fade,
        "pointer-events:none",
      ])}"></div>`,
    };
  }
  report("rotated image crop drawn as a transform");

  if (!t || !(width > 0) || !(height > 0)) return null;
  const det = num(t.m00, 1) * num(t.m11, 1) - num(t.m01) * num(t.m10);
  if (!det) return null;

  // The inverse of the 2×2, which is what maps image space back onto the box.
  const a00 = num(t.m11, 1) / det;
  const a01 = -num(t.m01) / det;
  const a10 = -num(t.m10) / det;
  const a11 = num(t.m00, 1) / det;

  const matrix = [
    a00,
    a10 * (height / width),
    a01 * (width / height),
    a11,
    -width * (a00 * num(t.m02) + a01 * num(t.m12)),
    -height * (a10 * num(t.m02) + a11 * num(t.m12)),
  ].map((n) => Math.round(n * 10000) / 10000);

  return {
    clip: true,
    html: `<div style="${styleAttr([
      "position:absolute",
      "left:0",
      "top:0",
      "width:100%",
      "height:100%",
      `background:url('${url}') 0 0/100% 100% no-repeat`,
      `transform:matrix(${matrix.join(",")})`,
      "transform-origin:0 0",
      ...fade,
      "pointer-events:none",
    ])}"></div>`,
  };
};

const maskImageOf = (
  node: FigmaNode,
  options: SceneOptions,
  depth = 0,
): {
  url: string;
  tile: boolean;
  /** The tile's size, when the paint says what it is. */
  size: { x: number; y: number } | null;
} | null => {
  if (depth > 6) return null;

  const paint = visiblePaint(node.fillPaints);
  if (paint?.type === "IMAGE") {
    const ref = imageRef(paint);
    const url = ref && options.image?.(ref);
    if (!url) return null;
    if (paint.imageScaleMode !== "TILE")
      return { url, tile: false, size: null };

    /**
     * A tiled mask has a tile size, and it is not the image's own — it is the source at the
     * paint's `scale`, the same thing `imageFit` works out for a background. The mask path
     * never got that: tiled at the raw image size, a dot grid meant to repeat every 7.5px
     * repeated every 15, and the grey it cuts the dots out of came back flat — standard
     * deviation 0 across a region where the design has a grid.
     */
    const w = num(paint.originalImageWidth) * num(paint.scale, 1);
    const h = num(paint.originalImageHeight) * num(paint.scale, 1);
    // A payload that does not say how big the source is still tiles, at whatever it happens
    // to be — the old behaviour, and better than not repeating at all.
    return { url, tile: true, size: w > 0 && h > 0 ? { x: w, y: h } : null };
  }

  const children = node.children.length
    ? node.children
    : (componentOf(node, options.symbols)?.children ?? []);
  for (const child of children) {
    const found = maskImageOf(child, options, depth + 1);
    if (found) return found;
  }
  return null;
};

/** A node's own transform, as the six numbers SVG's `matrix()` takes them in. */
type Matrix = [number, number, number, number, number, number];

const matrixOf = (node: FigmaNode): Matrix => [
  num(node.transform?.m00, 1),
  num(node.transform?.m10),
  num(node.transform?.m01),
  num(node.transform?.m11, 1),
  num(node.transform?.m02),
  num(node.transform?.m12),
];

/** `q` mapped through `p` — the order a nested SVG `transform` composes in. */
const compose = (p: Matrix, q: Matrix): Matrix => [
  p[0] * q[0] + p[2] * q[1],
  p[1] * q[0] + p[3] * q[1],
  p[0] * q[2] + p[2] * q[3],
  p[1] * q[2] + p[3] * q[3],
  p[0] * q[4] + p[2] * q[5] + p[4],
  p[1] * q[4] + p[3] * q[5] + p[5],
];

/**
 * A mask that is really a shape.
 *
 * A mask carrying no fill of its own masks by the alpha of what is inside it, and a wrapper
 * frame holding one vector is what every clip path in an illustration and every Lottie layer
 * looks like — 21 of the 25 masks in the corpus. Their bounding box is a rectangle the design
 * never drew: it is what put a straight edge across eight isometric tiles and squared off four
 * circular ones. The geometry was in `vectorNetworkBlob` the whole time.
 *
 * A mask that *does* carry a fill masks by its own box, and the `inset`/`polygon` fallback
 * already draws that exactly — so this only claims the fill-less ones, and hands the rest back.
 *
 * `byFill` is that rule, and it is a mask's rule alone. A boolean operand is asked the same
 * question for its geometry, where a fill decides nothing: the operands of a subtract usually
 * carry no paint at all, since the result is what Figma paints.
 *
 * Paths come back in the coordinates of the masked wrapper, each with the matrix that takes it
 * there, so the caller can share the wrapper's own box as the SVG's `viewBox`.
 */
type MaskPath = {
  d: string;
  evenOdd: boolean;
  matrix: Matrix;
  /** How much of the masked layer this shape lets through — Figma masks by alpha. */
  alpha: number;
};

const maskPathsOf = (
  node: FigmaNode,
  options: SceneOptions,
  matrix: Matrix,
  byFill = true,
  depth = 0,
  out: MaskPath[] = [],
  inherited = 1,
): MaskPath[] => {
  if (depth > 6) return out;

  /**
   * A mask's own translucency is the mask, not a detail of it.
   *
   * Seven bars at 10% white inside a group at 50% are a 5% mask: what shows through them is a
   * hint. Painted opaque they pass everything, and one hero's grid of soft highlights came out
   * as hard stripes twenty times too strong, with the design between them blown to white.
   * Opacity multiplies down the tree the way it composites.
   */
  const opacity = inherited * num(node.opacity, 1);
  const paintAlpha = (paint: Paint | null) =>
    paint ? opacity * num(paint.opacity, 1) * num(paint.color?.a, 1) : opacity;

  const data = node.vectorData as
    | {
        vectorNetworkBlob?: number;
        normalizedSize?: { x: number; y: number };
        /** Where a per-vertex corner radius lives — see `cornerStyles`. */
        styleOverrideTable?: { styleID?: number; cornerRadius?: number }[];
      }
    | undefined;
  const width = num(node.size?.x);
  const height = num(node.size?.y);

  if (data?.vectorNetworkBlob !== undefined) {
    const network = parseVectorNetwork(
      options.blobs?.[data.vectorNetworkBlob]?.bytes,
    );
    const paths = network
      ? (() => {
          const scale =
            ((num(data.normalizedSize?.x, width) || width) / (width || 1) +
              (num(data.normalizedSize?.y, height) || height) / (height || 1)) /
            2;
          return networkToPaths(
            network,
            num(node.cornerRadius) * scale,
            cornerStyles(data, scale),
          );
        })()
      : null;
    // The same closed-outline rule `vectorSvg` uses: a closed run with no region of its own is
    // still a filled shape in Figma, and masking by nothing is a subtree that vanishes.
    const fills = !paths
      ? []
      : paths.fills.length
        ? paths.fills
        : paths.strokes
            .filter((path) => path.closed)
            .map((path) => ({ d: `${path.d}Z`, evenOdd: false }));
    // The network is drawn in `normalizedSize`; the node paints it at its own size.
    const nx = num(data.normalizedSize?.x, width) || width;
    const ny = num(data.normalizedSize?.y, height) || height;
    if (fills.length && nx > 0 && ny > 0) {
      const scaled = compose(matrix, [width / nx, 0, 0, height / ny, 0, 0]);
      const alpha = paintAlpha(visiblePaint(node.fillPaints));
      out.push(...fills.map((path) => ({ ...path, matrix: scaled, alpha })));
      return out;
    }
  }

  const children = node.children.length
    ? node.children
    : (componentOf(node, options.symbols)?.children ?? []);
  // A boolean's paint belongs to the *result* of the operation and never to its own box, so
  // the operands carry the shape however the node is filled. Concatenated under `nonzero`,
  // overlapping subpaths are a union — which is the operation itself when that is what it is.
  const isBoolean = node.type === "BOOLEAN_OPERATION";
  if (
    children.length &&
    (!byFill || isBoolean || !visiblePaint(node.fillPaints))
  ) {
    // Every child, not the first: 23 bars masking a meter come back as one bar otherwise.
    for (const child of children) {
      if (child.visible === false) continue;
      maskPathsOf(
        child,
        options,
        compose(matrix, matrixOf(child)),
        byFill,
        depth + 1,
        out,
        opacity,
      );
    }
    return out;
  }

  /**
   * A rectangle or an ellipse keeps its geometry in its own fields. Stripping the transform
   * leaves it at the origin, where the matrix this recursion carries is what places it.
   *
   * `parametricPath` covers the shapes Figma stores as numbers rather than geometry — a star's
   * point count, a polygon's sides, an ellipse's arc. Without it a star mask was applied as its
   * bounding box, which is a square where the design has a five-pointed cut-out.
   */
  const d =
    !byFill || visiblePaint(node.fillPaints)
      ? (shapePath({ ...node, transform: undefined }) ??
        parametricPath(node, width, height))
      : null;
  if (d) {
    out.push({
      d,
      evenOdd: false,
      matrix,
      alpha: paintAlpha(visiblePaint(node.fillPaints)),
    });
  }
  return out;
};

const render = (
  node: FigmaNode,
  scene: Scene,
  options: SceneOptions,
  origin?: { x: number; y: number },
  inherited?: Matrix,
  /** This node's parent is a flex container, so the flow places it and left/top would fight it. */
  flow?: boolean,
  /** Declarations the parent needs on this element itself — see `blends` below. */
  extra?: string[],
  /** What this node is inside, for the cursor and the caret. Neither moves a pixel. */
  within?: {
    clickable?: boolean;
    field?: { used: boolean; name: string };
  },
  /** Where this node is placed — see `ParentBox`. Absent when nothing can be resolved against it. */
  parent?: ParentBox,
): string => {
  if (node.visible === false) return "";

  const type = node.type ?? "NONE";

  const report = (what: string) => {
    scene.counts[what] = (scene.counts[what] ?? 0) + 1;
    const line = `${node.name ?? type}: ${what}`;
    if (!scene.approximated.includes(line)) scene.approximated.push(line);
  };

  const width = num(node.size?.x);
  const height = num(node.size?.y);
  const t = node.transform;
  // Translation is left/top's job, so what composes down the tree is rotation and scale only.
  const own: Matrix = [
    num(t?.m00, 1),
    num(t?.m10),
    num(t?.m01),
    num(t?.m11, 1),
    0,
    0,
  ];
  const matrix = inherited ? compose(inherited, own) : own;
  const localX = num(t?.m02) - (origin?.x ?? 0);
  const localY = num(t?.m12) - (origin?.y ?? 0);
  // A rotation handed down by a parent turns this box's position too, not only its own axes.
  const left = inherited
    ? inherited[0] * localX + inherited[2] * localY
    : localX;
  const top = inherited
    ? inherited[1] * localX + inherited[3] * localY
    : localY;

  // Before the box styling, which asks whether this node paints itself.
  /**
   * A boolean whose fill is a photograph cannot be drawn with SVG paint; its outline becomes a
   * CSS mask and the ordinary box painting fills it. Checked before `booleanSvg` runs, so the
   * node never reports an image it was never going to be able to draw.
   */
  const booleanMask =
    type === "BOOLEAN_OPERATION" &&
    visiblePaints(node.fillPaints).some((paint) => paint.type === "IMAGE")
      ? booleanMaskCss(node, options, width, height)
      : null;

  /**
   * A vector filled with a photograph keeps its outline, rather than becoming its box.
   *
   * `fill` takes a paint server and a URL is not one, so a vector carrying an image was handed
   * back to the box path — which draws the picture, correctly, in a rectangle. On a rectangle
   * that is the shape; on anything else the outline is simply gone, and it said so five times
   * across this corpus.
   *
   * The same answer as a boolean with a photograph in it: the outline becomes a CSS mask and
   * the ordinary box painting fills it. A rectangle needs none of this — its box already *is*
   * its shape, and one fewer mask is one fewer thing to composite.
   */
  const shapeMask =
    !booleanMask &&
    type !== "RECTANGLE" &&
    type !== "ROUNDED_RECTANGLE" &&
    type !== "TEXT" &&
    (node.vectorData as { vectorNetworkBlob?: number } | undefined)
      ?.vectorNetworkBlob !== undefined &&
    visiblePaint(node.fillPaints)?.type === "IMAGE"
      ? shapeMaskCss(
          maskPathsOf(node, options, [1, 0, 0, 1, 0, 0], false),
          width,
          height,
        )
      : null;

  const artwork =
    booleanMask || shapeMask
      ? null
      : ((type === "BOOLEAN_OPERATION"
          ? booleanSvg(node, options, width, height, report)
          : null) ?? vectorSvg(node, options.blobs, width, height, report));
  // An operation drawn as one path has already consumed its operands.
  // Either route consumes the operands: they are the shape, not layers to paint over it.
  const drawn =
    type === "BOOLEAN_OPERATION" && (artwork !== null || booleanMask !== null);

  /**
   * A flow item keeps its measured size and gives up its coordinates: the container's padding,
   * gap and alignment are what put it where it goes, and a `left` beside them would be applied
   * on top of that. `flex:none` because a flex item shrinks below its width by default and
   * Figma's does not — a row that overflows should overflow, the way it does in the design.
   */
  /**
   * A retyped label in a hugging box, whose stored width belongs to the string it replaced.
   *
   * An override carries `characters` and nothing else — no size for the text, no
   * `derivedTextData`, so there is no measurement of the new string anywhere in the payload.
   * Only the flow can hug it, and only the browser can measure it: `max-content` is that, and
   * it is the one place here where the design's own font not being fetchable moves a box rather
   * than a glyph. Absolutely placed the old width is still the best guess there is.
   */
  const rehug =
    flow &&
    type === "TEXT" &&
    node.retyped === true &&
    node.textAutoResize === "WIDTH_AND_HEIGHT";
  const responsive = options.responsive !== false;
  const classes: string[] = [];
  const style: string[] = flow
    ? [
        // `relative`, not nothing: dropping `absolute` also stops this box being the containing
        // block for its own absolutely-placed descendants, and they then measure from whichever
        // ancestor still is one. In one fixture that moved 342 of 353 nodes — a whole section
        // 753px up the page, with siblings that belong side by side landing on top of each other.
        "position:relative",
        ...(responsive
          ? flowSize(node, parent, width, height, rehug)
          : [
              "flex:none",
              rehug ? "width:max-content" : `width:${px(width)}`,
              `height:${px(height)}`,
            ]),
      ]
    : [
        "position:absolute",
        // A constraint is resolved against the box this node is actually placed in, so it is
        // only asked for when there is one: a rotation handed down by a parent turns these
        // coordinates, and a masked run wraps them in a layer that is not the parent's box.
        ...(responsive && parent && !inherited
          ? [
              ...pinned(node, left, top, width, height, parent),
              ...(width <= parent.w ? ["max-width:100%"] : []),
            ]
          : [
              `left:${px(left)}`,
              `top:${px(top)}`,
              `width:${px(width)}`,
              `height:${px(height)}`,
            ]),
      ];

  /**
   * The design's own frame, which is the page rather than a box on one.
   *
   * `width:100%` and **no cap**. It carried `max-width:<the design's width>` with `right:0` and
   * `margin-inline:auto` beside it, so the design was never drawn wider than it was made and
   * sat centred in a window bigger than itself. That was the mapper deciding something on its
   * own — a `max-width` nobody wrote in Figma, turning up in the properties panel and in every
   * export — and it is gone.
   *
   * **What that costs, plainly.** Above the design's own width the root now grows with the
   * window, and two things follow: absolutely-placed children stay at the coordinates Figma
   * measured, so content sits against the left edge with the background stretched past it; and
   * a pin written as a percentage or `calc(100% - N)` resolves against the *window* rather than
   * against the width the design was drawn at. At and below the design's own width nothing
   * changes, which is the property `scripts/responsive-check.mjs` measures.
   *
   * The centring went with the cap rather than being kept: `margin-inline:auto` and `right:0`
   * only did anything because the cap left free space, and a box already 100% wide has none.
   *
   * Only ever the sole root: a multi-frame selection is a row of boxes laid out beside each
   * other, and a full-width one would sit on top of its neighbour.
   */
  if (responsive && origin && options.sole) {
    /**
     * **One `width`, not two.** This used to be pushed on top of the `width:<design px>` the
     * box above already wrote, and the last declaration in an attribute wins, so the pixel one
     * was dead as CSS and alive as a trap: the properties panel reads the *first* `width` it
     * finds and `withProp` rewrites **every** one of them, so typing a number into the Size
     * well replaced the `100%` as well and the design was laid out at that width inside a card
     * that stayed the size it was — 979px of design in a 1512px frame, with the background
     * stretched past it. Nothing about the rendering changes by dropping it, because `100%` was
     * already what applied; the design's own number lives in `scene.width` and on the frame's
     * size badge, which is where the panel now reads it from.
     */
    const own = style.findIndex((d) => d.startsWith("width:"));
    if (own >= 0) style.splice(own, 1);
    style.push("width:100%");
  }

  if (booleanMask) style.push(...booleanMask);
  if (shapeMask) style.push(...shapeMask);

  const selfAlign = STACK_ALIGN[node.stackChildAlignSelf as string];
  if (flow && selfAlign && parent?.mode !== COLUMN)
    style.push(`align-self:${selfAlign}`);
  /**
   * A member of a recovered column may get taller, and may not get shorter.
   *
   * The same pair a VERTICAL auto-layout frame gets, for the same reason: `height` is what
   * keeps the design exact at its own width, where a browser sets the same string a few pixels
   * wider than Figma's engine does, and `r-grow` is what lets go of it below that width — which
   * is the whole point of recovering the column. Without it a heading that re-wraps overflows
   * its own box and the flow never hears about it, so nothing under it moves and the column is
   * an expensive way of writing the coordinates back down.
   */
  if (flow && parent?.mode === COLUMN && responsive) {
    style.push(`min-height:${px(height)}`);
    classes.push(GROW);
  }
  if (extra?.length) style.push(...extra);

  /**
   * A pasted design is a picture of an interface, and pointing at a button should say so.
   *
   * `cursor` is inherited, so it is written once on the outermost layer that names itself a
   * control and the whole subtree gets it — a button and its label are one thing to point at.
   * The frame runs with no scripts (its sandbox grants `allow-same-origin` and nothing else),
   * which rules out anything that needs a listener; a cursor and a caret need neither.
   */
  const name = node.name ?? "";
  /**
   * A field holds one input, and that is the rule that decides which text becomes it.
   *
   * Names alone cannot: in one design the email placeholder sits under a node called "Button"
   * and the submit label sits directly under "Input Field". Preferring the nearer name makes
   * the button an input and the field a label; preferring the outer one makes them both inputs.
   * Counting instead — the first text under a field frame is the field, the rest is furniture —
   * gets that design right and does not depend on the naming being consistent.
   *
   * The marker is created at the field's frame and passed down by reference, so every node in
   * that subtree shares one "already used" flag.
   */
  const isClickable = CLICKABLE.test(name);
  // The frame's name is what says `email` or `password`, not the placeholder's — carried down
  // with the marker so the input can ask for the right keyboard.
  const field = FIELD.test(name)
    ? (within?.field ?? { used: false, name })
    : within?.field;
  const inside = {
    clickable: isClickable || !!within?.clickable,
    field,
  };
  if (inside.field && !within?.field) style.push("cursor:text");
  else if (inside.clickable && !within?.clickable) {
    // Dragging across a button selects its label otherwise, which is never what the press meant.
    style.push(
      "cursor:pointer",
      "user-select:none",
      "-webkit-user-select:none",
    );
  }

  /**
   * The rotation/skew half of the affine. Translation is already in left/top, so the matrix is
   * applied about the top-left corner and carries no offset of its own.
   *
   * Compared against the identity with a tolerance, not `!== 1`, because Figma writes a matrix
   * for every node and an unrotated one arrives a rounding error away from identity. That is
   * not cosmetic: **any** transform forms a stacking context, and a stacking context confines a
   * descendant's `mix-blend-mode` to that subtree — so the layer blends against nothing instead
   * of against the design behind it. In a hero lit entirely by blend modes, 64 of the 97 groups
   * isolating the light were identity to four decimal places, and the whole bloom came back as
   * a grey smudge. At 1e-4 the worst error this hides is a tenth of a pixel across 1000.
   */
  const skewed =
    Math.abs(matrix[0] - 1) > 1e-4 ||
    Math.abs(matrix[3] - 1) > 1e-4 ||
    Math.abs(matrix[1]) > 1e-4 ||
    Math.abs(matrix[2]) > 1e-4;

  /**
   * A group that does nothing but turn its children hands the rotation to them instead.
   *
   * Figma's groups pass through by default: a layer inside one blends with the design *behind
   * the group*. CSS has no equivalent — any transform forms a stacking context, and a stacking
   * context confines a descendant's `mix-blend-mode` to its own subtree, where there is nothing
   * to blend with. Every glow in a hero lit by Add and Soft Light then composites against
   * transparency, which is the same as not blending at all: measured, changing all 160 blend
   * modes to `difference` moved the render by 0.13 of a channel. The light came back as a grey
   * smudge and the counters reported nothing, because nothing was approximated — it was CSS
   * semantics, not a missing feature.
   *
   * Only a group that paints nothing, clips nothing and carries no effect can do this, because
   * for anything else the transform is what puts its own box where it belongs. That is exactly
   * what a bare group is, and it is worth a third of the total error on such a design.
   */
  const passesThrough =
    skewed &&
    node.children.length > 0 &&
    !artwork &&
    type !== "TEXT" &&
    type !== "BOOLEAN_OPERATION" &&
    // The clip below is the parent's own box; pushed down, there is nothing left to clip with.
    (type === "GROUP" || node.frameMaskDisabled === true) &&
    node.mask !== true &&
    // A mask run is wrapped in a div measured in this node's space, which the rotation places.
    !node.children.some((child) => child.mask === true) &&
    !visiblePaint(node.fillPaints) &&
    !visiblePaint(node.strokePaints) &&
    !(node.effects as Effect[] | undefined)?.some((e) => e.visible !== false) &&
    !(typeof node.opacity === "number" && node.opacity < 1) &&
    (!node.blendMode ||
      node.blendMode === "NORMAL" ||
      node.blendMode === "PASS_THROUGH");

  if (skewed && !passesThrough) {
    style.push(
      `transform:matrix(${matrix[0]},${matrix[1]},${matrix[2]},${matrix[3]},0,0)`,
      "transform-origin:0 0",
    );
  }

  if (typeof node.opacity === "number" && node.opacity < 1) {
    style.push(`opacity:${node.opacity}`);
  }

  /**
   * Fills that had to become elements — a turned crop, a translucent image. See `imageOverlay`.
   * They are emitted *before* the children, because a fill is behind them.
   */
  const fillOverlays: string[] = [];
  let clipOverlay = false;
  const addOverlay = (own: { html: string; clip: boolean }) => {
    fillOverlays.push(own.html);
    clipOverlay ||= own.clip;
  };

  let fills = visiblePaints(node.fillPaints);
  /**
   * A background blur whose layer fades: the fill's alpha becomes the mask so the blur fades
   * with it, and the fill is painted opaque underneath. See `fadedBackdrop`.
   */
  const faded =
    fills.length === 1 &&
    !booleanMask &&
    /**
     * A leaf only. The mask governs the whole element, children included — and a card whose
     * own fill is a 10%-to-0 sheen would take its heading and its body copy down to nothing
     * with it. Measured: doing this to spacex's six cards cost 1.3 of a channel across the
     * whole design. A blur that fades is a bare rectangle over the thing it is blurring.
     */
    node.children.length === 0 &&
    (node.effects as Effect[] | undefined)?.some(
      (effect) => effect.visible !== false && effect.type === "BACKGROUND_BLUR",
    )
      ? fadedBackdrop(fills[0], width, height)
      : null;
  if (faded) fills = [faded.fill];

  const fill = fills[0] ?? null;
  /**
   * A boolean's fill belongs to the *result* of the operation, and when that result was not
   * computed the bounding box is not it — it is pushed down to the operands below instead.
   * Painted here as well, a `+` built from two hairlines came out as a solid 8×15 block.
   *
   * Unless the result *is* the box: a CSS mask carrying the outline makes it so, which is the
   * whole point of taking that route for a fill SVG cannot paint.
   */
  const boxIsNotTheShape =
    type === "BOOLEAN_OPERATION" && node.children.length > 0 && !booleanMask;
  const paintable = type !== "TEXT" && !artwork && !boxIsNotTheShape;

  /**
   * A blended top paint over nothing opaque has to reach the backdrop.
   *
   * `background-blend-mode` blends a node's own layers with each other and stops there, while
   * Figma's bottom fill blends into what is behind the node as well. That only shows when the
   * layers beneath do not cover: a cut-out portrait under a solid at Color painted the blue
   * against transparency, so every pixel the person did not occupy came out flat blue and hid
   * the patterned tile underneath it — measured, a standard deviation of 0 where the design
   * has 74.
   *
   * An overlay child with `mix-blend-mode` blends with the real backdrop and is clipped to
   * this node's box, which is what the paint is. Only where it is needed: with an opaque solid
   * at the bottom of the stack the layers do cover, `background-blend-mode` is exact, and one
   * fewer element is one fewer stacking context.
   */
  // Below the top paint only: an opaque paint cannot be its own backdrop.
  const covered = fills
    .slice(0, -1)
    .some(
      (paint) =>
        paint.type === "SOLID" &&
        num(paint.color?.a, 1) >= 1 &&
        num(paint.opacity, 1) >= 1,
    );
  const topPaint = fills[fills.length - 1];
  const blendedTop =
    fills.length > 1 &&
    paintable &&
    !covered &&
    topPaint?.blendMode &&
    topPaint.blendMode !== "NORMAL" &&
    BLEND[topPaint.blendMode]
      ? topPaint
      : null;
  if (blendedTop) fills = fills.slice(0, -1);

  const layered =
    fills.length > 1 && paintable
      ? backgroundLayers(fills, { width, height }, options, report, addOverlay)
      : null;
  // Only when the layers did not already claim it, so one paint is not reported twice. Text
  // never layers — it reads this back below, where a gradient has to become a clipped
  // background rather than a `color`.
  const background = layered
    ? null
    : fill && paintCss(fill, { width, height }, report);
  if (layered) {
    style.push(...layered);
  } else {
    if (fill?.type === "IMAGE" && !artwork) {
      /**
       * A rotated crop cannot be a background and a translucent one cannot be a background
       * layer, so either becomes a child carrying the image, its matrix and its alpha. Only as
       * the one fill: the overlay would otherwise have to sit under the layers above it, and a
       * child cannot. The box still clips a turned image to its own edges.
       */
      const ref = fills.length === 1 ? imageRef(fill) : null;
      const url = ref ? options.image?.(ref) : null;
      const own = url ? imageOverlay(fill, url, width, height, report) : null;
      if (own) addOverlay(own);
      else style.push(...imageCss(fill, node, options.image, report));
    }
    if (background && paintable) {
      style.push(`background:${background}`);
    }
  }
  // After both paths: either can have handed a fill to an element of its own.
  if (clipOverlay) style.push("overflow:hidden");

  const corners =
    type === "ELLIPSE"
      ? null
      : [
          num(node.rectangleTopLeftCornerRadius, num(node.cornerRadius)),
          num(node.rectangleTopRightCornerRadius, num(node.cornerRadius)),
          num(node.rectangleBottomRightCornerRadius, num(node.cornerRadius)),
          num(node.rectangleBottomLeftCornerRadius, num(node.cornerRadius)),
        ];
  /** The element's own outline, for anything that has to trace it. See `gradientRing`. */
  const radiusCss = !corners
    ? "50%"
    : corners.some((r) => r > 0)
      ? corners.map(px).join(" ")
      : "";

  if (type === "ELLIPSE") {
    // A partial arc is drawn as a path instead; a full circle is what this border-radius is.
    if (!artwork) style.push("border-radius:50%");
  } else if (radiusCss) {
    style.push(`border-radius:${radiusCss}`);
  }

  const stroke = visiblePaint(node.strokePaints);
  const strokeCss =
    stroke && !artwork ? paintCss(stroke, { width, height }, report) : null;
  const strokeColor = strokeCss;
  /**
   * The same stroke as the one colour a `box-shadow` can take.
   *
   * A `background` is happy with a gradient, so a rule drawn as a bar keeps its sweep and asks
   * for none of this. A shadow is not: the gradient makes the declaration invalid and the
   * browser drops it *with every real shadow beside it*. 45 strokes in this corpus went that
   * way, the glow around a phone mockup among them — drawn as nothing at all, and counted as
   * nothing either. Only called where a colour is what CSS will accept.
   */
  const strokeAsColour = (say = true) =>
    stroke && strokeCss?.includes("gradient(")
      ? (say && report("gradient stroke drawn as one colour"),
        flatGradient(stroke, num(stroke.opacity, 1)))
      : strokeCss;
  const weight = num(node.strokeWeight);
  const shadows: string[] = [];
  /** A dashed stroke drawn as SVG, laid over the box. See `dashedStrokeSvg`. */
  let dashOverlay: string | null = null;
  /** A gradient stroke drawn as a masked ring. See `gradientRing`. */
  let strokeOverlay: string | null = null;

  /**
   * A rule: a node with a length and no thickness, which Figma stores as a `LINE` or as a
   * `VECTOR` whose height rounds away. Either way there is no box to paint — only a bar of the
   * stroke's own weight, turned by the transform the node already carries.
   */
  const isRule = type === "LINE" || (width > FLAT && height <= FLAT);

  if (isRule && strokeColor) {
    // Figma stores a line as a width and a zero height, with the angle in the transform — so it
    // is a bar of the stroke's own weight, and this height wins over the 0 pushed above.
    /**
     * The band is painted *before* the node's origin, not after it — the decoded path is
     * `M0 -0.5 L… -0.5`, the stroke is centred on it, and Figma's own render of this frame puts
     * the pixel there. `transform-origin` is pinned back to the line itself, because the origin
     * otherwise travels with the shifted box and a rule rotated 90° slides along its own length
     * instead of across it: every vertical rule on the page landed a pixel to the left.
     */
    const bar = Math.max(weight, 1);
    style.push(
      `height:${px(bar)}`,
      `margin-top:${px(-bar)}`,
      `transform-origin:0 ${px(bar)}`,
    );
    const dashes = node.dashPattern as unknown[] | undefined;
    /**
     * A bar's dashes are a gradient along it. `border-style:dashed` would change the box and
     * pick its own dash length; this keeps Figma's.
     *
     * A gradient stroke has no single colour to repeat, so this used to give up and draw the
     * rule solid — which is not a dimmer version of a dashed line, it is a line where the
     * design has a row of ticks. One paste reported 84 of them. Flattening the sweep to its
     * average is the same trade `strokeAsColour` already makes for a shadow, and a dashed
     * average beats a solid gradient.
     */
    const dashed = Array.isArray(dashes) && dashes.length > 0;
    const repeatable = dashed
      ? strokeColor.startsWith("rgba(")
        ? strokeColor
        : strokeAsColour()
      : null;
    if (dashed && repeatable?.startsWith("rgba(")) {
      const on = num(dashes?.[0], 4) || 4;
      const off = num(dashes?.[1], on) || on;
      style.push(
        `background:repeating-linear-gradient(to right,${repeatable} 0 ${px(on)},transparent ${px(on)} ${px(on + off)})`,
      );
    } else {
      if (dashed) report("dashed stroke drawn solid");
      style.push(`background:${strokeColor}`);
    }
  } else if (strokeColor) {
    // box-shadow rather than border: a border changes the box, and every coordinate in this
    // payload is measured against a box that does not include it.
    const colour = strokeAsColour(false) ?? strokeColor;
    const flattened = () => {
      if (strokeCss?.includes("gradient(")) {
        report("gradient stroke drawn as one colour");
      }
    };
    const outside = node.strokeAlign === "OUTSIDE";
    const inset = outside ? "" : "inset ";

    if (node.borderStrokeWeightsIndependent) {
      // Each side carries its own weight and an unset side is **0**, not `strokeWeight` —
      // Figma leaves that at the last uniform value it had. An underlined input is exactly
      // this shape (`borderBottomWeight` alone), so a ring on all four sides is three borders
      // the design does not have. Offset rather than spread, so the box keeps its size.
      const dir = outside ? -1 : 1;
      const sides: [number, number, number][] = [
        [num(node.borderTopWeight), 0, dir],
        [num(node.borderBottomWeight), 0, -dir],
        [num(node.borderLeftWeight), dir, 0],
        [num(node.borderRightWeight), -dir, 0],
      ];
      for (const [w, x, y] of sides) {
        if (w > 0) {
          flattened();
          shadows.push(`${inset}${px(x * w)} ${px(y * w)} 0 0 ${colour}`);
        }
      }
    } else if (weight > 0) {
      dashOverlay = dashedStrokeSvg(
        node,
        width,
        height,
        colour,
        weight,
        options,
      );
      /**
       * A gradient stroke, drawn as a gradient.
       *
       * `box-shadow` is what draws every other stroke here, and it takes a colour — so a
       * gradient one was averaged down to a single flat tone, 71 of them across this corpus.
       * A ring cut out of the gradient says it properly: an overlay the size of the element
       * with a transparent border, painted with the gradient over its border box, and masked
       * down to just that border. It traces the element's own radius, and the element's box
       * does not move, which is the reason strokes are shadows here in the first place.
       *
       * A dashed one keeps its SVG, which can already carry a gradient of its own.
       */
      const ring =
        !dashOverlay && strokeCss?.includes("gradient(")
          ? gradientRing(strokeCss, weight, node.strokeAlign, radiusCss)
          : null;
      if (ring) strokeOverlay = ring;
      else if (!dashOverlay) {
        flattened();
        shadows.push(`${inset}0 0 0 ${px(weight)} ${colour}`);
      }
    }

    if (
      !dashOverlay &&
      Array.isArray(node.dashPattern) &&
      node.dashPattern.length
    ) {
      report("dashed stroke drawn solid");
    }
  }

  const effects = effectsCss(node, Boolean(artwork), type === "TEXT", report);
  shadows.push(...effects.shadows);
  if (effects.text.length) style.push(`text-shadow:${effects.text.join(",")}`);
  if (shadows.length) style.push(`box-shadow:${shadows.join(",")}`);
  if (effects.filters.length) style.push(`filter:${effects.filters.join(" ")}`);
  if (effects.backdrop.length) {
    style.push(`backdrop-filter:${effects.backdrop.join(" ")}`);
    if (faded) style.push(...faded.mask);
  }

  const blend = node.blendMode as string | undefined;
  if (blend && blend !== "NORMAL" && blend !== "PASS_THROUGH") {
    if (BLEND[blend]) style.push(`mix-blend-mode:${BLEND[blend]}`);
    else report(`${blend.toLowerCase()} blend mode has no CSS equivalent`);
  }

  // `frameMaskDisabled` is inverted, and absent means clipping is on.
  if (
    node.children.length &&
    node.frameMaskDisabled !== true &&
    type !== "GROUP"
  ) {
    style.push("overflow:hidden");
  }

  const operands = drawn
    ? []
    : type === "BOOLEAN_OPERATION" &&
        node.booleanOperation !== "UNION" &&
        node.children.length > 1
      ? node.children.slice(0, 1)
      : node.children;

  const component = componentOf(node, options.symbols);
  /**
   * An instance of an auto-layout component was not *resized* from it — it re-ran the layout.
   *
   * A component is a default and an instance is that default with edits, and an edit that
   * changes a string changes the width of every hugging box around it. A 76-wide button whose
   * label is retyped from "Export" to "Browse File" arrives 111 wide carrying the *component's*
   * child coordinates and no new measurement of anything inside it — the override says
   * `characters` and the instance's own `size`, and nothing else. Scaled to fit, the glyphs
   * stretch by 1.46 and run out of the pill. Laid out by the flow they land where Figma put
   * them, because the flow is what Figma ran.
   *
   * `stackOf` still has to agree with the component's own coordinates first: the fit test is
   * against the box those were measured in, which is the component's.
   *
   * And `uniformScaleFactor` is what says this is not the other thing. An instance dragged with
   * the *scale* tool really does scale its contents — one design here was drawn at 100% and then
   * scaled to 0.79 whole, and every instance in it carries that factor: a 28px nav button at
   * 22.12 whose 16px icon belongs at 12.6. Re-run as a flow it would pack 6+16+6 into a 22.12
   * box at full size. So a scaled instance keeps the scale, and only an unscaled one re-flows.
   */
  const componentStack =
    component && options.flex !== false ? stackOf(component) : null;
  /**
   * An axis that hugs cannot have been resized: whatever changed it changed the *content*, and
   * re-running the layout is the only way to find out where that content now goes. A fixed one
   * is the other story entirely — a 247-wide menu row placed at 226 was dragged narrower, and
   * what Figma did there was shrink the label to fit, which is a `fill` this mapper does not
   * model. Scaled, that row squashes by 8.5%; re-flowed, its label keeps its full width and
   * runs 19px past the row. So the fixed axes keep the scale and only the hugging ones re-flow.
   *
   * An axis that did not change needs no answer either way.
   */
  const row = componentStack?.mode === "HORIZONTAL";
  const wasX = num(component?.size?.x, width);
  const wasY = num(component?.size?.y, height);
  const hugged = (was: number, is: number, sizing: unknown) =>
    was === is || sizing !== "FIXED";
  const reflow =
    !!component &&
    !!componentStack &&
    (wasX !== width || wasY !== height) &&
    hugged(
      wasX,
      width,
      row ? component.stackPrimarySizing : component.stackCounterSizing,
    ) &&
    hugged(
      wasY,
      height,
      row ? component.stackCounterSizing : component.stackPrimarySizing,
    ) &&
    num(
      (node.symbolData as { uniformScaleFactor?: number } | undefined)
        ?.uniformScaleFactor,
      1,
    ) === 1 &&
    component.children.length > 0 &&
    !component.children.some((child) => child.mask === true) &&
    !passesThrough &&
    !artwork &&
    type !== "TEXT";
  /**
   * **`uniformScaleFactor` is Figma saying whether it scaled anything at all.**
   *
   * Dragging an instance's handle does not scale it. It resizes the frame, and the children
   * answer with their constraints and their auto layout — the same thing that happens to any
   * frame. Only the Scale tool scales, and when it has been used the factor is written down;
   * `1` means it has not.
   *
   * So an instance at `1` is a resized *frame*, and drawing it as its component under a
   * `transform` is not an approximation of that, it is a different picture. Measured on a
   * design built out of them — a breakpoint strip whose component is 2013 wide placed at
   * 1327 — every one of its 210 instances came out under a `scale(0.66, 0.86)`: six columns
   * of a squashed page where Figma draws four at their own size, every avatar an ellipse and
   * every glyph 34% narrow. Clipped instead, the four columns are the four columns.
   *
   * The fallback is still a scale, because a factor that is not `1` is Figma telling us it
   * really did scale this one — that is the `stardust` case, drawn at 100% and scaled whole.
   */
  const scaled =
    num(
      (node.symbolData as { uniformScaleFactor?: number } | undefined)
        ?.uniformScaleFactor,
      1,
    ) !== 1;
  const scale =
    component && !reflow && scaled
      ? {
          x: num(component.size?.x, width)
            ? width / num(component.size?.x, width)
            : 1,
          y: num(component.size?.y, height)
            ? height / num(component.size?.y, height)
            : 1,
        }
      : null;

  // The box the children are laid out in — the component's own when an instance scales them,
  // and its own when it is a resized frame, whose box is what does the clipping.
  const box = {
    width:
      component && !reflow && scaled ? num(component.size?.x, width) : width,
    height:
      component && !reflow && scaled ? num(component.size?.y, height) : height,
  };

  /**
   * A mask child clips the siblings **above** it, up to the next mask — not the whole parent.
   * Clipping the parent takes the unmasked siblings with it, and in an illustration that is
   * most of the drawing: one 145×145 mask inside a 280×189 group cropped the group to a square
   * and everything outside it vanished. Painted as an ordinary filled shape a mask does the
   * opposite — covers them — so it is never drawn itself either.
   *
   * The clip is the mask's bounding box: exact for the rectangle masks that make up nearly all
   * of them, an approximation for the rest.
   */
  const maskCss = (mask: FigmaNode): string[] => {
    /**
     * A gradient mask is a gradient, and CSS has the same one.
     *
     * Figma masks by alpha, and a CSS gradient used as a `mask-image` is read by its alpha too
     * (`mask-mode: match-source` on an image means alpha), so the stops carry straight over —
     * this is the one mask kind CSS reproduces exactly rather than approximates. Falling back
     * to the bounding box instead turns a fade into a hard edge at full strength: a starfield
     * under a radial mask that should dim to nothing at the corners covered its whole 896px
     * square, and both noise layers over it with it.
     *
     * Sized and placed within the wrapper, which is the parent's box — the mask has its own
     * position in there and is rarely the whole of it.
     */
    const gradientMask = gradientMaskCss(mask, 0, 0);
    if (gradientMask) return gradientMask;

    const image = maskImageOf(mask, options);
    if (image) {
      const tileSize = image.size
        ? `${px(image.size.x)} ${px(image.size.y)}`
        : image.tile
          ? ""
          : "100% 100%";
      const size = tileSize
        ? `;-webkit-mask-size:${tileSize};mask-size:${tileSize}`
        : "";
      const repeat = image.tile ? "repeat" : "no-repeat";

      /**
       * A mask image cannot be turned.
       *
       * `mask-image` has no counterpart to `background-position`'s companion for rotation —
       * there is no `mask-rotate`, and a transform on the element turns the *content* with the
       * mask. So a texture whose whole job is to be rotated comes back square: one page's
       * diagonal hatch is a horizontal-stripe tile on a mask node turned −30°, and drawn
       * upright it is horizontal bars where the design has 45° lines. Nothing else about it is
       * wrong — right texture, right tile, right opacity — so without this it is a silent one.
       */
      /**
       * A mask image cannot be turned by any property — there is no `mask-rotate`, and a
       * transform on the element turns the *content* along with the mask. One page's diagonal
       * hatch is a horizontal-stripe tile on a mask node rotated −30°; drawn upright it is
       * horizontal bars where the design has 45° lines, and nothing else about it is wrong —
       * right texture, right tile, right opacity — so it is a silent one.
       *
       * `rotate` hands the angle back to the caller, which builds the one structure that does
       * express it: see `maskWrapper`. Only for a *tiled* mask, whose size is in pixels and
       * whose phase does not matter — a mask stretched to `100% 100%` would be resized by the
       * oversized box that rotating needs.
       */
      const t = mask.transform;
      const turn =
        t && (Math.abs(num(t.m01)) > 1e-3 || Math.abs(num(t.m10)) > 1e-3)
          ? (Math.atan2(num(t.m10), num(t.m00, 1)) * 180) / Math.PI
          : 0;
      if (turn && !image.tile) {
        report(`image mask drawn unrotated (${Math.round(turn)}°)`);
      }
      const rotate = image.tile ? turn : 0;

      /**
       * A mask's own translucency *is* the mask — the rule `maskPathsOf` already follows for a
       * shaped one, which an image mask never got. The dot grid over one page is a texture at
       * 18%: taken as opaque its dots came back seven times too strong, a hard grid where the
       * design has a whisper.
       *
       * A second layer of flat alpha, intersected, multiplies it — the only way CSS has to
       * dim a mask image.
       */
      const alpha = num(mask.opacity, 1);
      if (alpha < 1) {
        const flat = `linear-gradient(rgba(0,0,0,${round2(alpha)}),rgba(0,0,0,${round2(alpha)}))`;
        return withRotation(rotate, [
          `-webkit-mask-image:url('${image.url}'),${flat};mask-image:url('${image.url}'),${flat}`,
          `-webkit-mask-repeat:${repeat},repeat;mask-repeat:${repeat},repeat`,
          `-webkit-mask-size:${tileSize || "auto"},100% 100%;mask-size:${tileSize || "auto"},100% 100%`,
          "-webkit-mask-composite:source-in;mask-composite:intersect",
        ]);
      }

      return withRotation(rotate, [
        `-webkit-mask-image:url('${image.url}');mask-image:url('${image.url}')${size}`,
        `-webkit-mask-repeat:${repeat};mask-repeat:${repeat}`,
      ]);
    }
    const t = mask.transform;
    const left = num(t?.m02);
    const top = num(t?.m12);
    const maskWidth = num(mask.size?.x);
    const maskHeight = num(mask.size?.y);
    const radius = num(mask.cornerRadius);
    const rotated = !!t && (num(t.m01) !== 0 || num(t.m10) !== 0);
    const rectangular =
      mask.type === "RECTANGLE" || mask.type === "ROUNDED_RECTANGLE";

    /**
     * The clip below is exact for an axis-aligned rectangle, and for a rotated one with square
     * corners. Those two are most masks and cost nothing; everything else is where a bounding
     * box stops being the shape, and is worth decoding the geometry for.
     */
    const paths =
      !rectangular || (rotated && radius)
        ? maskPathsOf(mask, options, matrixOf(mask))
        : [];
    if (paths.length) {
      // Only a union is exactly the operands laid over each other; the rest are the nearest
      // shape SVG will draw without a path solver, and say so.
      if (
        mask.type === "BOOLEAN_OPERATION" &&
        String(mask.booleanOperation ?? "UNION") !== "UNION"
      ) {
        report(
          `${String(mask.booleanOperation).toLowerCase()} mask drawn as the union of its operands`,
        );
      }

      /**
       * A blurred mask has soft edges, and that is usually the whole point of it: the grain
       * over one hero is a 20% Color Dodge texture behind a boolean union blurred by 113, and
       * with a hard edge that dodge covers the entire design instead of fading into it.
       * `feGaussianBlur` blurs alpha, which is exactly what a mask is made of.
       */
      const blurred = (mask.effects as Effect[] | undefined)?.find(
        (effect) =>
          effect.visible !== false && effect.type === "FOREGROUND_BLUR",
      );
      // Figma's radius is a diameter next to CSS's deviation, the same halving `effectsCss` does.
      const deviation = round2(num(blurred?.radius) / 2);
      // Sized to the wrapper, which is the parent's box, so every path keeps the coordinates it
      // was measured in. `encodeURIComponent` is also what keeps the double quotes out of the
      // style attribute — a raw one there closes it and drops every rule after it.
      const shapes = paths
        .map(
          (path) =>
            `<path d="${path.d}" fill="#fff" fill-opacity="${round2(
              path.alpha,
            )}" fill-rule="${
              path.evenOdd ? "evenodd" : "nonzero"
            }" transform="matrix(${path.matrix
              .map((n) => Math.round(n * 10000) / 10000)
              .join(",")})"/>`,
        )
        .join("");
      const svg = encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${round2(
          box.width,
        )} ${round2(box.height)}">${
          deviation > 0
            ? `<filter id="b" x="-25%" y="-25%" width="150%" height="150%"><feGaussianBlur stdDeviation="${deviation}"/></filter><g filter="url(#b)">${shapes}</g>`
            : shapes
        }</svg>`,
      );
      const url = `url('data:image/svg+xml,${svg}')`;
      return [
        `-webkit-mask-image:${url};mask-image:${url}`,
        "-webkit-mask-size:100% 100%;mask-size:100% 100%",
        "-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat",
      ];
    }
    if (!rectangular) {
      report(
        `${String(mask.type).toLowerCase()} mask applied as its bounding box`,
      );
    }

    /**
     * Every mask in an isometric illustration carries the same 30° matrix. Clipped to its
     * axis-aligned box the drawing is cut on a vertical edge that exists nowhere in the design
     * — which is what put a pale rectangle through the middle of three of four illustrations.
     * The four corners under the mask's own matrix are exact for a rectangle at any angle.
     */
    if (t && rotated) {
      const corner = (x: number, y: number) =>
        `${px(num(t.m00, 1) * x + num(t.m01) * y + left)} ${px(
          num(t.m10) * x + num(t.m11, 1) * y + top,
        )}`;
      // `polygon()` has no corners to round; a rotated rounded mask loses its radius.
      if (radius) report("rotated mask corner radius dropped");
      return [
        `clip-path:polygon(${[
          corner(0, 0),
          corner(maskWidth, 0),
          corner(maskWidth, maskHeight),
          corner(0, maskHeight),
        ].join(",")})`,
      ];
    }

    return [
      `clip-path:inset(${px(top)} ${px(box.width - left - maskWidth)} ${px(
        box.height - top - maskHeight,
      )} ${px(left)}${radius ? ` round ${px(radius)}` : ""})`,
    ];
  };

  // Children are ordered bottom-to-top, so everything before the first mask is unmasked and
  // each mask opens a run of its own.
  const runs: { mask: FigmaNode | null; items: FigmaNode[] }[] = [
    { mask: null, items: [] },
  ];
  /**
   * What this instance actually draws: the component's children, resized into *its* box.
   *
   * Only where the box really differs and Figma did not scale it — see `resizeByConstraints`
   * and `scaled`. A reflowed instance is laid out by its stack instead and wants the
   * component's own coordinates, which is what `stackOf(component)` was measured against.
   */
  const contents =
    component && !reflow && !scaled
      ? component.children.map((child) =>
          resizeByConstraints(
            child,
            { w: wasX, h: wasY },
            { w: width, h: height },
          ),
        )
      : component?.children;

  for (const child of contents ?? operands) {
    if (child.mask === true) runs.push({ mask: child, items: [] });
    else runs[runs.length - 1].items.push(child);
  }

  /**
   * Whether this node's children are laid out by the flow rather than by their coordinates.
   *
   * The stack itself is only half of it — the rest is whether anything between this box and its
   * children would break the flow:
   *
   * - a **mask child** splits the children into runs, and each run is wrapped in an absolutely
   *   positioned layer, so the flex items would be the wrappers rather than the design's nodes;
   * - a **resized instance** wraps them in a scaling layer, same problem;
   * - a **passing-through group** hands its matrix down for the children to apply to their own
   *   coordinates, which a flow item does not have.
   *
   * In all three the absolute path is still exactly right, so it keeps them. A child pinned with
   * `stackPositioning: ABSOLUTE` is excluded from the flow individually, which is what Figma
   * does with it too: its coordinates are relative to this box, and this box is positioned, so
   * the existing left/top land it in the same place.
   */
  const stack = reflow
    ? componentStack
    : options.flex === false
      ? null
      : stackOf(node);
  const flowChildren =
    !!stack &&
    (reflow || node.children.length > 0) &&
    runs.length === 1 &&
    !passesThrough &&
    // A node that paints its own vector emits the `<svg>` as a sibling of its children, and a
    // TEXT node emits its runs in a `<span>` the same way. In a flex container either becomes
    // the *first item* and pushes every real child along by its width.
    !artwork &&
    type !== "TEXT" &&
    !(component && scale && (scale.x !== 1 || scale.y !== 1));
  /**
   * A column may get taller, and may not get shorter.
   *
   * Without this, letting a heading wrap is worse than leaving it overflowing: the extra line
   * is drawn *over* the paragraph under it, because the box it grew inside is still the height
   * Figma measured for one line. `height:auto` beside `min-height` is the design's own height
   * wherever the content still fits in it — which is the whole of the design at its own width —
   * and the content's height wherever it no longer does. The floor is what keeps a frame that
   * Figma drew with room to spare from collapsing onto its own text.
   */
  if (flowChildren) {
    style.push(...stack.css);
    if (responsive && stack.mode === "VERTICAL") {
      style.push(`min-height:${px(height)}`);
      classes.push(GROW);
    }
  } else if (
    options.flex !== false &&
    node.children.length > 0 &&
    (node.stackMode === "HORIZONTAL" || node.stackMode === "VERTICAL")
  ) {
    // The frame says auto layout and the flow would not put its children where Figma did, so it
    // keeps its coordinates. Said out loud rather than left to be noticed: the markup is the
    // thing being read here, and "this one is absolute" is a fact about the design, not a bug.
    report("auto layout kept absolute — flex would move it");
  }

  const childNodes = runs
    .filter((run) => run.items.length)
    .map((run) => {
      /**
       * A masked run whose contents blend with what is behind them.
       *
       * The wrapper that normally carries the mask is a stacking context, and a stacking context
       * confines a descendant's `mix-blend-mode` to its own subtree — where the backdrop is
       * transparent, so the layer composites against nothing and lands at full strength. One
       * design's starfield is a noise texture at Soft Light over near-black, which should come
       * out as almost nothing and instead covered the hero: measured, it added 3.3 of the 4.6
       * channels there against Figma's 1.3.
       *
       * Put on the elements themselves the mask still masks and the blend still reaches the real
       * backdrop — an element's own stacking context does not isolate its own blend, only its
       * children's. Only for the gradient kind, whose position and size are absolute lengths and
       * so can be re-anchored per child; the others are sized to the wrapper.
       */
      const needsOwnMask = (child: FigmaNode) =>
        (child.blendMode &&
          child.blendMode !== "NORMAL" &&
          child.blendMode !== "PASS_THROUGH") ||
        /**
         * A backdrop blur has the same problem for a different reason: a mask makes its element
         * a **backdrop root**, and a `backdrop-filter` inside one samples only what is painted
         * within it — which, in a wrapper holding nothing but the blur, is nothing. Measured on
         * a stripe pattern: wrapped, the "blurred" band came back at a standard deviation of
         * 126.19, identical to the sharp stripes underneath. It was not blurring anything.
         *
         * That is how a progressive blur is built — one big rect with a large blur under a
         * gradient mask — so the whole ramp was silently absent and only a small unmasked rect
         * beside it showed, as a hard-edged band. With the mask on the blurring element the
         * same test ramps 22.9 to 107.4: strong at one end, gone at the other.
         */
        (child.effects as Effect[] | undefined)?.some(
          (effect) =>
            effect.visible !== false && effect.type === "BACKGROUND_BLUR",
        );

      const blends = run.mask && run.items.some(needsOwnMask) ? run.mask : null;

      /**
       * A card grid, drawn as one. Only where the coordinates prove it — see `gridOf` — and
       * only for a plain run: a masked or blended run is already wrapped in a layer of its own,
       * and two wrappers around the same children is a stacking context nobody asked for.
       */
      const grid =
        options.responsive !== false &&
        !flowChildren &&
        !run.mask &&
        !passesThrough &&
        runs.length === 1
          ? gridOf(run.items, width)
          : null;

      /**
       * A column, where the coordinates prove one and the lattice did not claim them first.
       *
       * After the grid, never beside it: a lattice of one column is a column, and the grid is
       * the better answer there because it also knows the cell width. Everything else is the
       * same run this walk already has in hand.
       */
      const column =
        options.responsive !== false &&
        !grid &&
        !flowChildren &&
        !run.mask &&
        !passesThrough &&
        runs.length === 1
          ? columnOf(run.items, width)
          : null;
      /**
       * The cell each member belongs in, when the payload does not already list them that way.
       *
       * All of them or none: `order` defaults to 0, so writing it on the two cards that moved
       * leaves the other two sharing that default and the row comes out shuffled a different
       * way. Skipped entirely for a lattice already in row-major order, which is most of them —
       * a declaration per card that says nothing is noise in the file somebody has to read.
       */
      const shuffled =
        !!grid &&
        run.items.some(
          (child, index) =>
            grid.slot.has(child) && grid.slot.get(child) !== index - grid.from,
        );
      const cellOrder = (child: FigmaNode): string[] | undefined => {
        const gap = column?.margin.get(child);
        // The air above it and its own offset across, which is the whole of what a flow item
        // needs to land where the design drew it. `0` margins are dropped rather than written:
        // the markup is what somebody reads, and `margin:0 0` says nothing.
        if (gap) {
          return [
            ...(gap[0] ? [`margin-top:${px(gap[0])}`] : []),
            ...(gap[1] ? [`margin-left:${px(gap[1])}`] : []),
          ];
        }
        const want = shuffled ? grid?.slot.get(child) : undefined;
        return want === undefined ? undefined : [`order:${want}`];
      };

      const pieces = run.items.map((child) =>
        render(
          // A boolean operation holds the paint and its operands hold none, so an operand
          // drawn on its own has nothing to paint with.
          type === "BOOLEAN_OPERATION" &&
            !visiblePaint(child.fillPaints) &&
            visiblePaint(node.fillPaints)
            ? {
                ...child,
                fillPaints: node.fillPaints,
                // Only when the operand has none of its own: a LINE has no fill at all, and
                // overwriting its stroke with the boolean's leaves nothing to draw the bar.
                strokePaints: visiblePaint(child.strokePaints)
                  ? child.strokePaints
                  : node.strokePaints,
              }
            : child,
          scene,
          options,
          undefined,
          // Not passing through means this node emitted the transform, so CSS already turns the
          // coordinate space its children are measured in.
          passesThrough ? matrix : undefined,
          (flowChildren && child.stackPositioning !== "ABSOLUTE") ||
            (!!grid && grid.slot.has(child)) ||
            (!!column && column.margin.has(child)),
          blends
            ? (gradientMaskCss(
                blends,
                num(child.transform?.m02),
                num(child.transform?.m12),
              ) ?? undefined)
            : cellOrder(child),
          inside,
          // Only when this element really is the box its children are placed in: a run
          // wrapped for a mask, or a resized instance's scaling layer, is not.
          runs.length === 1 &&
            !(component && scale && (scale.x !== 1 || scale.y !== 1))
            ? {
                mode: grid?.slot.has(child)
                  ? "GRID"
                  : column?.margin.has(child)
                    ? COLUMN
                    : flowChildren
                      ? stack.mode
                      : undefined,
                shrink: flowChildren ? !stack.overflowing : undefined,
                w: width,
                h: height,
                inner: flowChildren
                  ? width - stack.padding[1] - stack.padding[3]
                  : width,
                innerH: flowChildren
                  ? height - stack.padding[0] - stack.padding[2]
                  : height,
              }
            : undefined,
        ),
      );

      const wrap = (
        at: { from: number; count: number },
        open: string,
      ): string =>
        [
          ...pieces.slice(0, at.from),
          `${open}${pieces.slice(at.from, at.from + at.count).join("")}</div>`,
          ...pieces.slice(at.from + at.count),
        ].join("");

      const inner = grid
        ? wrap(
            grid,
            `<div style="${styleAttr(gridCss(grid))}" class="${GROW}" ${GRID_COLUMNS}="${grid.columns}">`,
          )
        : column
          ? wrap(
              column,
              `<div style="${styleAttr(columnCss(column))}" ${COLUMN_RUN}>`,
            )
          : pieces.join("");
      if (!run.mask) return inner;
      // Every item carries the mask itself, so the wrapper would only re-isolate them.
      if (blends && gradientMaskCss(blends, 0, 0)) return inner;

      const mask = maskCss(run.mask);
      const spin = mask.find((line) => line.startsWith(ROTATE));
      if (spin) {
        /**
         * A rotated mask, as three boxes.
         *
         * A mask is applied in its element's own coordinate space, so turning an ancestor turns
         * the mask *and* everything under it. Turning the content back by the same angle inside
         * leaves only the mask rotated — which is the one arrangement CSS has for this.
         *
         * The outer box is twice the parent and centred on it, because a rotated rectangle does
         * not cover the corners of the one it came from; at 200% no angle can leave a gap. Both
         * rotations are about their own centre and the centres coincide, so they cancel exactly
         * and the content lands where it was measured. The tile's phase shifts, which is
         * invisible in something that repeats.
         */
        const deg = Number(spin.slice(ROTATE.length));
        const declarations = mask.filter((line) => !line.startsWith(ROTATE));
        return `<div style="${styleAttr([
          "position:absolute",
          "left:-50%",
          "top:-50%",
          "width:200%",
          "height:200%",
          `transform:rotate(${deg}deg)`,
        ])}"><div style="${styleAttr([
          "position:absolute",
          "left:0",
          "top:0",
          "width:100%",
          "height:100%",
          ...declarations,
        ])}"><div style="${styleAttr([
          "position:absolute",
          "left:25%",
          "top:25%",
          "width:50%",
          "height:50%",
          `transform:rotate(${round2(-deg)}deg)`,
        ])}">${inner}</div></div></div>`;
      }

      // The wrapper fills the parent, so every child keeps the coordinates it was measured in.
      return `<div style="${styleAttr([
        "position:absolute",
        "left:0",
        "top:0",
        "width:100%",
        "height:100%",
        ...mask,
      ])}">${inner}</div>`;
    })
    .join("");

  /**
   * A component's contents are laid out in the component's own box, so an instance resized from
   * it has to scale them — a 500×500 component placed at 1717×1467 otherwise draws a fifth of
   * the area it should.
   */
  const children =
    component && scale && (scale.x !== 1 || scale.y !== 1)
      ? `<div style="position:absolute;left:0;top:0;width:${px(
          num(component.size?.x, width),
        )};height:${px(num(component.size?.y, height))};transform:scale(${round2(
          scale.x,
        )},${round2(scale.y)});transform-origin:0 0">${childNodes}</div>`
      : childNodes;

  const parsedGeometry =
    (node.vectorData as { vectorNetworkBlob?: number } | undefined)
      ?.vectorNetworkBlob !== undefined;
  /**
   * "Unmapped" means *nothing was drawn* — the node is a bare box at its real bounds. A boolean
   * whose operands render is not that: its children are drawn, in their own places, and for a
   * UNION that is the operation exactly. Counting it here reported the same four nodes twice on
   * one paste — once as `boolean union drawn as its operands`, which is true and minor, and once
   * as `BOOLEAN_OPERATION not drawn`, at error level, which is not true at all.
   */
  const operandsDrawn =
    type === "BOOLEAN_OPERATION" && node.children.length > 0;
  if (!artwork && !BOXES.has(type) && !parsedGeometry && !operandsDrawn) {
    scene.unmapped[type] = (scene.unmapped[type] ?? 0) + 1;
  }
  if (type === "BOOLEAN_OPERATION" && node.children.length && !drawn) {
    // The result of the operation is not in the payload — only its operands are. Stacking them
    // is a union: right for UNION, and for the others the closest thing without a path solver
    // is the base shape alone, since drawing what should have been cut away paints more than
    // the design has, not less. (A glow lit half a footer that way.)
    const operation = String(node.booleanOperation ?? "UNION").toLowerCase();
    report(
      operation === "union"
        ? "boolean union drawn as its operands"
        : `boolean ${operation} drawn as its base shape`,
    );
  }

  if (type === "TEXT") {
    const data = (node.textData ?? {}) as TextData;

    /**
     * Where Figma broke each line, taken from its own layout rather than re-derived.
     *
     * `derivedTextData.baselines` carries a character range per line — the only description of
     * this text that is not a guess about font metrics. Inter as Google serves it is not
     * Inter as Figma measured it, and on a heading sized to its box the difference is a
     * second line.
     */
    const baselines =
      (
        node.derivedTextData as
          | { baselines?: { firstCharacter?: number; width?: number }[] }
          | undefined
      )?.baselines ?? [];
    /**
     * The widest line, as Figma's own engine measured it in the design's own font. Carried onto
     * the element so the widths survive a face that could not be fetched. See `fitText`.
     */
    const inkWidth = baselines.reduce(
      (w, line) => Math.max(w, num(line.width)),
      0,
    );
    const lines = new Set(
      baselines
        .slice(1)
        .map((baseline) => num(baseline.firstCharacter, -1))
        .filter((at) => at > 0),
    );

    const fontSize = num(node.fontSize, 16);
    const font = node.fontName as
      { family?: string; style?: string } | undefined;
    const family = font?.family;
    const weight = weightOf(font?.style);
    const italic = /italic|oblique/i.test(font?.style ?? "");

    addFace(scene.fonts, family, weight, italic);
    const align = node.textAlignHorizontal as string | undefined;
    const mayWrap = options.responsive !== false;
    style.push(
      "display:flex",
      `justify-content:${ALIGN[align ?? ""] ?? "flex-start"}`,
      // Flex centres the block; this centres the lines *inside* it. Without it a two-line
      // centred paragraph is a centred box full of left-aligned text, which is what every
      // caption in a centred layout looked like.
      `text-align:${TEXT_ALIGN[align ?? ""] ?? "left"}`,
      `align-items:${node.textAlignVertical === "CENTER" ? "center" : node.textAlignVertical === "BOTTOM" ? "flex-end" : "flex-start"}`,
      fluidType(
        fontSize,
        options.responsive === false ? 0 : (options.designWidth ?? 0),
      ),
      `line-height:${lineHeightCss(node.lineHeight, fontSize)}`,
      /**
       * A box that auto-sizes in both directions hugs its text and never wraps — a label that
       * fits in Figma to the pixel wraps here the moment a face renders a hair wider. Figma's
       * own line breaks are inserted below, so nothing here may re-wrap: its text engine and a
       * browser's disagree by a few pixels, and a line that fits in Figma to within 5px of the
       * box wraps here into an extra line that shunts the whole block. Any baselines at all
       * means Figma laid this text out and its breaks are now in the string — including a
       * heading it fitted on one line that a browser would wrap.
       *
       * All of which is true **at the width the design was drawn at**, and that is exactly as
       * far as it goes. `r-wrap` lifts it below that width and nowhere else — see `GROW` — so
       * the reason to be conservative here is gone: what is left is a 684px heading painting
       * out over both edges of a 380px page, and its own baked breaks being kept while it
       * finds new ones is a worse phone layout than nothing only in theory. The `max-width`
       * above is what gives it somewhere narrower to go.
       */
      baselines.length || node.textAutoResize === "WIDTH_AND_HEIGHT"
        ? "white-space:pre"
        : "white-space:pre-wrap",
    );
    // A line it did not have has to go somewhere. The same floor-and-grow a column gets: the
    // design's own height wherever one line still fits, the text's height once it does not.
    if (mayWrap) {
      style.push(`min-height:${px(height)}`);
      classes.push(GROW, WRAP);
    }

    /**
     * A gradient cannot be a `color`. Assigned to one the declaration is simply invalid and
     * dropped, and the text renders in whatever it inherited — which is how a 1300px wordmark
     * filled with a dark-to-white sweep came out flat black on its own background.
     */
    if (background?.includes("gradient(")) {
      style.push(
        `background-image:${background}`,
        "-webkit-background-clip:text",
        "background-clip:text",
        "color:transparent",
      );
    } else {
      style.push(`color:${background ?? "#000"}`);
    }
    // Single quotes, not double: this lands inside style="…", and a double quote there ends
    // the attribute — taking every declaration after it with it. That is what turned a heading
    // set in Epilogue into the browser's default serif.
    style.push(
      family ? `font-family:${familyStack(family)}` : "font-family:sans-serif",
      `font-weight:${weight}`,
    );
    if (italic) style.push("font-style:italic");
    style.push(...textCaseCss(node.textCase));
    /**
     * Tracking is a *ratio* of the font size, not a length: Figma ships `-0.02` in
     * `textTracking` and the same figure as `letterSpacing {value:-2, units:"PERCENT"}`.
     * Written as `px` a -2% heading tracks by two hundredths of a pixel — nothing — and every
     * line of text on the page runs wide. `letterSpacing` carries its own unit, so prefer it.
     */
    const spacing = node.letterSpacing as
      { value?: number; units?: string } | undefined;
    const tracked = num(spacing?.value, num(node.textTracking) * 100);
    if (tracked) {
      style.push(
        spacing?.units === "PIXELS"
          ? `letter-spacing:${px(tracked)}`
          : `letter-spacing:${Math.round(tracked * 100) / 10000}em`,
      );
    }
    if (node.textCase === "UPPER") style.push("text-transform:uppercase");
    if (node.textDecoration === "UNDERLINE")
      style.push("text-decoration:underline");

    /**
     * The text of a field becomes a real one you can type into.
     *
     * No script is involved and none could be — the frame's sandbox grants `allow-same-origin`
     * and nothing else. An `<input>` needs neither: the caret, the selection and the placeholder
     * are the browser's. The design's own string is the placeholder, because that is what it is
     * on the screenshot, and `::placeholder` is normalised in the document shell so it renders
     * in the colour the design drew rather than the browser's grey.
     */
    if (inside.field && !inside.field.used) {
      inside.field.used = true;
      const placeholder = escape(String(data.characters ?? ""));
      return `<div style="${styleAttr(style)}" data-figma="${escape(
        node.name ?? "",
      )}" data-fid="${scene.count++}"><input type="${fieldType(
        `${inside.field.name} ${name}`,
      )}" placeholder="${placeholder}" autocomplete="off" spellcheck="false" style="${styleAttr(
        [
          // The box, the font and the colour are the parent's; the input only carries a caret.
          /**
           * Reset one property at a time rather than with `all:unset` — that resets `box-shadow`
           * too, at inline specificity, and takes the focus ring in the shell down with it. The
           * browser's own `outline` goes for the reason the guideline gives: Safari before 16.4
           * draws it square across a rounded corner, and these boxes are rounded.
           */
          "background:transparent",
          "border:0",
          "margin:0",
          "padding:0",
          "outline:0",
          "width:100%",
          "min-width:0",
          "font:inherit",
          "color:inherit",
          "letter-spacing:inherit",
          "text-align:inherit",
          "cursor:text",
        ],
      )}"/>${children}</div>`;
    }

    // One wrapper around the runs: the box is a flex container for alignment, and loose spans
    // in it become flex items — which lays a three-line heading out as three columns.
    return `<div style="${styleAttr(style)}"${classAttr(classes)} data-figma="${escape(
      node.name ?? "",
    )}"${inkWidth ? ` data-fit="${round2(inkWidth)}"` : ""} data-fid="${scene.count++}"><span>${textRuns(
      data,
      lines,
      {
        family,
        weight,
        italic,
        lineHeight: node.lineHeight as
          { value?: number; units?: string } | undefined,
        textCase: node.textCase as string | undefined,
      },
      scene.fonts,
      options.styles,
      report,
    )}</span>${children}</div>`;
  }

  /**
   * The blended top paint, as its own layer over everything this node draws. See `blendedTop`.
   * `pointer-events:none` because it is paint, not a target.
   */
  const blendLayer = (() => {
    if (!blendedTop) return "";
    const css = paintCss(blendedTop, { width, height }, report);
    if (!css) return "";
    return `<div style="${styleAttr([
      "position:absolute",
      "left:0",
      "top:0",
      "width:100%",
      "height:100%",
      `background:${css}`,
      `mix-blend-mode:${BLEND[blendedTop.blendMode as string]}`,
      "pointer-events:none",
    ])}"></div>`;
  })();

  return `<div style="${styleAttr(style)}"${classAttr(classes)} data-figma="${escape(node.name ?? "")}" data-fid="${scene.count++}">${artwork ?? ""}${fillOverlays.join("")}${children}${dashOverlay ?? ""}${strokeOverlay ?? ""}${noiseOverlay(node, report)}${blendLayer}</div>`;
};

/**
 * A phrase repeated on top of itself, folded back into one.
 *
 * Figma has no way to paint part of a text node with its own fill, so a designer who wants two
 * words of a heading in a gradient duplicates the node, trims it to those words and lays it over
 * the original. Figma draws both and the top one wins, so it looks like one line — and the
 * payload has no idea the two are related.
 *
 * Drawn as two elements that is a lie waiting to happen: the glyphs only coincide while both
 * boxes measure identically, and the moment the design's own face cannot be fetched they are
 * measured in something else, independently, and slide apart. That is the doubled heading —
 * "Banking Network" printed twice, dark and green, forty pixels out.
 *
 * So the duplicate becomes what Figma could not express: a **run** of the original, carrying the
 * gradient as its own fill. One set of glyphs, no second measurement, and nothing left to drift.
 *
 * The test is Figma's own arithmetic, not a guess. `derivedTextData.baselines` gives the ink
 * width of each node in the design's real font, so for a phrase sitting on the tail of another
 * the gap between their boxes must be exactly the width of the part not repeated:
 * `base.width - overlay.width === overlay.x - base.x`. One heading here is 667.86 and 369.45
 * against an offset of 298 — 298.41 against 298. A pair that does not satisfy it is two
 * different pieces of text that happen to overlap, and is left alone.
 */
const foldTextOverlays = (node: FigmaNode): FigmaNode => {
  const kids = node.children ?? [];
  const folded = new Set<FigmaNode>();
  /**
   * The base is replaced, never edited. `/canvas` holds the decoded tree and renders it again
   * on every zoom and every nudge, so folding in place would stack a second override onto the
   * same characters each time.
   */
  const rewritten = new Map<FigmaNode, FigmaNode>();

  for (let i = 0; i < kids.length; i += 1) {
    const over = kids[i];
    if (over.type !== "TEXT" || folded.has(over)) continue;
    const overText = String(
      (over.textData as TextData | undefined)?.characters ?? "",
    );
    const overLine = singleLine(over);
    if (!overText || !overLine) continue;

    // Earlier siblings only: the duplicate is the one painted on top.
    for (let j = i - 1; j >= 0; j -= 1) {
      const base = kids[j];
      if (base.type !== "TEXT" || folded.has(base)) continue;
      const baseText = String(
        (base.textData as TextData | undefined)?.characters ?? "",
      );
      const baseLine = singleLine(base);
      if (!baseLine || baseText === overText) continue;

      const at = baseText.indexOf(overText);
      // Once, or the run is ambiguous and the arithmetic below cannot say which.
      if (at < 0 || baseText.indexOf(overText, at + 1) >= 0) continue;
      if (!sameFace(base, over)) continue;

      const dy = num(over.transform?.m12) - num(base.transform?.m12);
      const dx = num(over.transform?.m02) - num(base.transform?.m02);
      // A prefix starts where the base does; anything else starts where the ink it follows ends.
      const expected = at === 0 ? 0 : baseLine.width - overLine.width;
      if (Math.abs(dy) > 1 || Math.abs(dx - expected) > 1.5) continue;

      const paints = visiblePaints(over.fillPaints);
      if (!paints.length) continue;

      const current = (rewritten.get(base) ?? base).textData as TextData;
      const table = [...(current.styleOverrideTable ?? [])];
      const ids = [...((current.characterStyleIDs ?? []) as number[])];
      while (ids.length < baseText.length) ids.push(0);
      const id = Math.max(0, ...table.map((e) => num(e.styleID))) + 1;
      for (let k = at; k < at + overText.length; k += 1) ids[k] = id;
      table.push({
        styleID: id,
        // Composited over the base's own fill, because that is what Figma drew: the duplicate's
        // gradient fades to 20% alpha and the dark heading reads through it. One set of glyphs
        // can only be one colour, so the blend has to happen in the stops.
        // Resolved here, not in `textRuns`: a gradient's CSS needs the box it was authored
        // for, and that is the duplicate's own — the very box being folded away.
        fillCss: paintCss(
          over3(
            paints[paints.length - 1],
            visiblePaint(base.fillPaints) ?? undefined,
          ),
          { width: num(over.size?.x), height: num(over.size?.y) },
          () => {},
        ),
      } as (typeof table)[number]);

      rewritten.set(base, {
        ...(rewritten.get(base) ?? base),
        textData: {
          ...current,
          characterStyleIDs: ids,
          styleOverrideTable: table,
        } as FigmaNode["textData"],
      });
      folded.add(over);
      break;
    }
  }

  if (!folded.size && !kids.length) return node;
  const kept = kids
    .filter((kid) => !folded.has(kid))
    .map((kid) => foldTextOverlays(rewritten.get(kid) ?? kid));
  return { ...node, children: kept };
};

/** The one line this node is, or nothing — the offsets below only hold for a single line. */
const singleLine = (node: FigmaNode): { width: number } | null => {
  const lines =
    (node.derivedTextData as { baselines?: { width?: number }[] } | undefined)
      ?.baselines ?? [];
  const width = num(lines[0]?.width);
  return lines.length === 1 && width > 0 ? { width } : null;
};

/** Two text nodes set in the same face at the same size, which is what lets them coincide. */
const sameFace = (a: FigmaNode, b: FigmaNode): boolean => {
  const fa = a.fontName as { family?: string; style?: string } | undefined;
  const fb = b.fontName as { family?: string; style?: string } | undefined;
  return (
    num(a.fontSize) === num(b.fontSize) &&
    fa?.family === fb?.family &&
    fa?.style === fb?.style &&
    String(a.textCase ?? "") === String(b.textCase ?? "")
  );
};

/** A paint composited over an opaque one, so a translucent overlay can be drawn as a colour. */
const over3 = (paint: Paint, under: Paint | undefined): Paint => {
  const base = under?.type === "SOLID" ? under.color : undefined;
  if (!base) return paint;
  const mix = (c: Color | undefined, a: number): Color => ({
    r: num(c?.r) * a + num(base.r) * (1 - a),
    g: num(c?.g) * a + num(base.g) * (1 - a),
    b: num(c?.b) * a + num(base.b) * (1 - a),
    a: 1,
  });
  const alpha = num(paint.opacity, 1);
  if (paint.type === "SOLID") {
    return {
      ...paint,
      opacity: 1,
      color: mix(paint.color, num(paint.color?.a, 1) * alpha),
    };
  }
  if (!paint.stops?.length) return paint;
  return {
    ...paint,
    opacity: 1,
    stops: paint.stops.map((stop) => ({
      ...stop,
      color: mix(stop.color, num(stop.color?.a, 1) * alpha),
    })),
  };
};

export const sceneToHtml = (
  roots: FigmaNode[],
  options: SceneOptions = {},
): Scene => {
  const scene: Scene = {
    html: "",
    width: 0,
    height: 0,
    unmapped: {},
    approximated: [],
    counts: {},
    fonts: [],
    count: 0,
  };
  if (!roots.length) return scene;

  // Roots carry page coordinates. Normalising to the top-left of the selection is what makes a
  // paste land where it was dropped rather than a thousand pixels down the canvas.
  const origin = {
    x: Math.min(...roots.map((r) => num(r.transform?.m02))),
    y: Math.min(...roots.map((r) => num(r.transform?.m12))),
  };

  /**
   * **On by default**, and it is one flag with the whole pass hanging from it: the constraint
   * pins and their clamps, the card lattice, the `.r-grow`/`.r-wrap` breakpoint, the fluid type,
   * the centred root. Every check downstream reads `options.responsive !== false`.
   *
   * It was parked here for a while, resolved to a hard `false`, because `pinterest` — a masonry
   * of resized instances — moved 157 boxes at the design's *own* width. That was `flowSize`
   * dropping a stretched child's measured size for a size the design does not have; see the
   * note there. `scripts/responsive-check.mjs` is what says it is back to a translation.
   */
  const opts = {
    ...options,
    responsive: options.responsive !== false,
    sole: roots.length === 1,
    designWidth: roots.length === 1 ? num(roots[0].size?.x) : 0,
  };
  scene.html = roots
    .map((root) => render(foldTextOverlays(root), scene, opts, origin))
    .join("");
  if (opts.responsive !== false && opts.sole && scene.html.includes(GROW)) {
    scene.html = responsiveCss(num(roots[0].size?.x)) + scene.html;
  }
  scene.width = Math.max(
    ...roots.map((r) => num(r.transform?.m02) - origin.x + num(r.size?.x)),
  );
  scene.height = Math.max(
    ...roots.map((r) => num(r.transform?.m12) - origin.y + num(r.size?.y)),
  );
  return scene;
};

/** The same tree, in the shape the layers panel draws. */
export const sceneLayers = (nodes: FigmaNode[]): SnapshotNode[] =>
  nodes.map((node) => ({
    id: `${node.guid?.sessionID ?? 0}:${node.guid?.localID ?? 0}`,
    name: node.name ?? node.type ?? "node",
    type: node.type ?? "NONE",
    x: num(node.transform?.m02),
    y: num(node.transform?.m12),
    width: num(node.size?.x),
    height: num(node.size?.y),
    ...(node.children.length ? { children: sceneLayers(node.children) } : {}),
  }));
