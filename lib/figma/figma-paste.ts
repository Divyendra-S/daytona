/**
 * What Figma puts on the clipboard, turned into something a browser can render.
 *
 * Three flavours come off a copied frame, and only two of them are worth anything here:
 *
 * - **⌘⇧C (Copy as PNG)** — a real image file. Exact pixels, no Figma session needed, dead
 *   flat. Handled by the caller, which has the `File`; nothing to parse.
 * - **⌘L (Copy link to selection)** — a figma.com URL carrying `?node-id`. The only flavour
 *   that names one frame, so the only one that can be embedded *as that frame*.
 * - **⌘C (plain copy)** — an HTML blob: a `(figmeta)` comment naming the file, and a
 *   `(figma)` comment holding the whole scene kiwi-encoded. The frame's own id is in that
 *   binary buffer, so plain copy identifies the file and stops there.
 *
 * The rendering is Figma's own, in an embed iframe. A parser could decode the buffer, but
 * decoding is the easy half — the hard half is a renderer, and Figma already ships one.
 */

/** Identifies this host to Figma. Required on every embed URL. */
import { fitScript } from "./fit-text";

export const EMBED_HOST = "figma-to-code";

export type Pasted =
  | { kind: "embed"; url: string; title: string; note?: string }
  /** A frame the plugin uploaded: the design itself, rendered, with its layers. */
  | { kind: "session"; id: string }
  | { kind: "hint"; message: string };

const FIGMA_URL = /https?:\/\/(?:[\w-]+\.)?figma\.com\/[^\s"'<>]+/i;
const FIGMETA = /\(figmeta\)([A-Za-z0-9+/=\s]+)\(\/figmeta\)/;

const embed = (path: string, nodeId?: string | null) => {
  const url = new URL(path, "https://embed.figma.com");
  if (nodeId) url.searchParams.set("node-id", nodeId);
  url.searchParams.set("embed-host", EMBED_HOST);
  url.searchParams.set("footer", "false");
  url.searchParams.set("page-selector", "false");
  return url.toString();
};

/** A pasted Figma link → the same file on the embed host, focused on the linked node. */
export const linkToEmbed = (
  input: string,
): { url: string; title: string } | null => {
  const match = input.match(FIGMA_URL);
  if (!match) return null;

  let source: URL;
  try {
    source = new URL(match[0]);
  } catch {
    return null;
  }
  // /design/<key>/<slug> — anything shorter is a file list or a profile, not a design.
  const [, kind, key, slug] = source.pathname.split("/");
  if (!kind || !key) return null;

  return {
    url: embed(source.pathname, source.searchParams.get("node-id")),
    title: slug ? decodeURIComponent(slug).replace(/-/g, " ") : "Figma",
  };
};

/** The `(figmeta)` comment is plain base64 JSON: `{ fileKey, pasteID, dataType }`. */
export const fileKeyOf = (html: string): string | null => {
  const match = html.match(FIGMETA);
  if (!match) return null;
  try {
    const meta = JSON.parse(atob(match[1].replace(/\s/g, "")));
    return typeof meta?.fileKey === "string" ? meta.fileKey : null;
  } catch {
    // A blob from an older Figma build, or not Figma at all. Either way: not a file key.
    return null;
  }
};

/** The link the plugin's copy button writes: `…/canvas#paste=<session>`. */
export const sessionOf = (input: string): string | null =>
  input.match(/\/canvas#paste=([\w-]+)/)?.[1] ?? null;

/**
 * Everything a bare iframe needs to render a frame the way Figma does.
 *
 * The fonts are the reason this is not just the HTML. The converter writes the family Figma
 * reports and nothing loads it, so a design set in Inter renders in Times and every measured
 * line wraps somewhere else. One link per family, deliberately: Google Fonts fails the whole
 * stylesheet when one family in it is unknown, and most designs use a family it does know.
 */
const GENERIC = new Set([
  "sans-serif",
  "serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
  "inherit",
  "initial",
  "unset",
]);

export type UsedFont = {
  family: string;
  weight: number;
  italic: boolean;
  /**
   * A face the user uploaded, as a `data:` URL — see `fontFaces`.
   *
   * Set only by the properties panel's font upload. Its presence is what takes the family out
   * of `fontUrls`, which is load-bearing three times over: no `<link>` that 404s, no "not on
   * Google Fonts" note from the paste's own probe, and `GOOGLE_ALIAS` cannot rewrite an
   * uploaded family into Google's idea of it.
   */
  src?: string;
};

/** What the picker hands back when a file is chosen, and all `onStyle` needs to store it. */
export type CustomFace = { family: string; src: string };

/**
 * A family name that is safe to write into CSS, or `""`.
 *
 * The one free-text string in this pipeline. Every other family comes from Figma and is bounded
 * by what Figma allows; this one is a file name or something typed, and it lands inside a
 * single-quoted CSS value in the frame document *and* in exported code. An apostrophe alone
 * breaks the declaration; a brace and a `src:url(…)` after it is a stylesheet somebody else
 * wrote. Whitelisted rather than escaped: there is no font whose name needs anything else.
 */
export const safeFamily = (name: string): string =>
  name
    .replace(/[^A-Za-z0-9 _-]/g, "")
    .trim()
    .slice(0, 64);

/**
 * A family that may be written into CSS **as it is**.
 *
 * `safeFamily` is for a name this app *invents* — from a file name, or typed. It must not be
 * used on a family that came out of the design, and it was: stripping a character renames the
 * face, and a face whose name is not the one the markup declares is a font that loads and is
 * used by nothing. `Söhne` became `Shne`, `Hagrid Trial (Trial)` lost its parentheses, and the
 * upload looked like it had done nothing at all.
 *
 * So the design's own spelling is kept, and the only characters refused are the three that can
 * end the quoted string it is written into — `'`, `"`, `\` — and the control characters. A
 * brace or a semicolon is inert inside quotes and belongs to plenty of real font names.
 */
const CSS_FAMILY = /^[^"'\\\x00-\x1f]{1,64}$/;
export const cssFamily = (name: string): string => {
  const family = name.trim();
  return CSS_FAMILY.test(family) ? family : "";
};

/**
 * The only `src` a custom face may carry.
 *
 * The bytes are read and re-encoded by the picker, which is where the sfnt magic is checked, so
 * the MIME here is ours rather than the file's. Re-checked at the point the CSS is written
 * because that is the boundary that matters: a node arriving from a stale `localStorage`, a
 * workspace row or a plugin upload goes through the same emit.
 */
const DATA_FONT = /^data:font\/(?:woff2|woff|ttf|otf);base64,[A-Za-z0-9+/]+={0,2}$/;

/**
 * The other shape, and the only other one: the file a zip export writes beside the markup.
 *
 * `splitFonts` (`lib/export-bundle.ts`) takes the bytes out of the stylesheet and puts them in
 * `assets/`, which is where a person reading the folder expects a font to be — and a megabyte
 * of base64 on one line of `index.html` is the bulk that export exists to remove. Named to the
 * letter rather than "a relative path", for the same reason `safeFamily` is a whitelist: this
 * string is written into a `url()` and nothing else may reach it.
 */
const ASSET_FONT = /^assets\/font-\d+\.(?:woff2|woff|ttf|otf)$/;

/** Whether a face's `src` is one this build will write into CSS. */
export const usableSrc = (src: string): boolean =>
  DATA_FONT.test(src) || ASSET_FONT.test(src);

/**
 * The uploaded faces, as CSS.
 *
 * `local()` first, so somebody with the licensed font installed renders the real thing and the
 * data URL is never touched. No `format()`: with a data URL the browser sniffs the bytes, and a
 * hint that disagrees makes it *skip* the source instead of correcting it. `font-weight: 100
 * 900` claims the whole range from one static file, which stops Chrome synthesising a bold —
 * a fake bold measures wider, `fitText` squashes it back with `scaleX`, and the result is
 * distorted glyphs rather than a layout fix.
 *
 * ponytail: one upright file per family. An italic slot is the upgrade if a design needs one.
 */
export const fontFaces = (fonts: UsedFont[] | undefined): string => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const font of fonts ?? []) {
    if (!font.src || !usableSrc(font.src)) continue;
    // Verbatim, or the face is named something no node in the document asks for.
    const family = cssFamily(font.family);
    if (!family || seen.has(family)) continue;
    seen.add(family);
    out.push(
      `@font-face{font-family:'${family}';font-weight:100 900;font-style:normal;` +
        `src:local('${family}'),url(${font.src})}`,
    );
  }
  return out.join("\n");
};

/**
 * One stylesheet per family, asking for exactly the faces the design uses.
 *
 * Google Fonts fails the **whole** request when one axis value is unavailable — asking for
 * `wght@100..900` on Phudu, which starts at 300, returns 400 and the heading silently falls
 * back to a wider system face, re-wrapping every line. So the weights come from the design.
 */
/**
 * Families Figma names differently from the only place we can fetch them.
 *
 * `Inter Display` is Inter's display optical size and is not a family Google Fonts serves — the
 * link 404s and the headline silently falls back to the system sans, which is the single largest
 * pixel difference against Figma's own render of a page set in it.
 */
const GOOGLE_ALIAS: Record<string, string> = { "Inter Display": "Inter" };

export const googleFamily = (family: string): string =>
  GOOGLE_ALIAS[family] ?? family;

/**
 * One stylesheet per family, asking for exactly the faces the design uses.
 *
 * Exported because the URL is also the test: Google answers 400 for a family it does not have
 * *and* for a weight it does not cut, and a 400 takes the whole stylesheet with it — so the
 * face never arrives and the text re-wraps in a fallback. Fetching these is how a paste finds
 * that out; the `<link>` itself fails silently.
 */
export const fontUrls = (
  fonts: UsedFont[],
): { family: string; url: string }[] => {
  const byFamily = new Map<string, Set<string>>();
  for (const font of fonts) {
    // An uploaded face is already in the document — see `fontFaces`. Asking Google for it gets
    // a 404 that takes the whole stylesheet with it, and a "no such family" note besides.
    if (font.src) continue;
    if (GENERIC.has(font.family.toLowerCase())) continue;
    const axis = font.italic ? `1,${font.weight}` : `0,${font.weight}`;
    const family = googleFamily(font.family);
    const set = byFamily.get(family) ?? new Set<string>();
    set.add(axis);
    byFamily.set(family, set);
  }

  return [...byFamily].slice(0, 12).map(([family, axes]) => {
    const spec = `ital,wght@${[...axes].sort().join(";")}`;
    return {
      family,
      url: `https://fonts.googleapis.com/css2?family=${encodeURIComponent(
        family,
      ).replace(/%20/g, "+")}:${spec}&display=swap`,
    };
  });
};

const fontLinks = (fonts: UsedFont[]): string =>
  fontUrls(fonts)
    .map(({ url }) => `<link rel="stylesheet" href="${url}">`)
    .join("");

/**
 * The page the design is laid out on.
 *
 * Every node in a scene is `position:absolute`, so nothing is in flow and the body measures
 * **zero high** — a document that cannot scroll however tall the design is, which is only
 * invisible while it sits in an iframe cut to the frame's exact size. Given the size, the body
 * is told to be that big and the page scrolls like any other. Without one, the old behaviour:
 * clipped, because a scrollbar inside a canvas frame is noise.
 *
 * **`background:transparent`, and it has to be said out loud.** It used to paint `#fff`, which
 * is the colour 18 of the 19 fixtures' root frames carry as a *fill* anyway — the root element
 * paints it, so the page's copy sat under a design that already covered it. The nineteenth has
 * no fill at all, and a frame with no fill is transparent: Figma shows the canvas behind it,
 * and here it came out as a white band around a dark design. Deleting the declaration is not
 * the fix, because a document with no background of its own gets the browser's default canvas,
 * which is white — an iframe is only see-through when its document says it is. Said, what shows
 * through is the card's own `#2d2e2f`, which is what a frame with nothing in it is, and the
 * same reason the iframe element in `frame-card.tsx` carries no `bg-white`.
 */
const page = (size?: { width: number; height: number }) =>
  `<style>html,body{margin:0;padding:0;background:transparent${
    size
      ? `;width:${Math.ceil(size.width)}px;height:${Math.ceil(size.height)}px`
      : ";overflow:hidden"
  }}` +
  /**
   * Figma antialiases text in greyscale and does not darken stems. Chrome does both by default,
   * which draws the *same* face at the *same* weight visibly heavier — the heading of one design
   * came out looking like the 700 of a family whose payload plainly says 500, and no counter can
   * see it because nothing about the text was approximated. It is the largest single difference
   * left on a text-heavy frame, and worst on light-on-dark, where stem darkening adds most.
   */
  `*{-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-rendering:optimizeLegibility}` +
  // Stops iOS enlarging the text when the phone is turned, which would break every measured box.
  `html{-webkit-text-size-adjust:100%}` +
  // A field's placeholder *is* the design's own text, so it keeps the design's own colour
  // rather than the browser's grey. See the `inside.field` branch in `figma-scene.ts`.
  `input::placeholder{color:inherit;opacity:1}` +
  /**
   * The input is `all:unset`, which takes the browser's focus ring with it — so one is put
   * back. `box-shadow`, not `outline`: Safari before 16.4 draws an outline square across a
   * rounded corner, and these boxes are rounded. `:focus-visible` so a pointer click does not
   * ring it, only the keyboard.
   */
  `input:focus-visible{box-shadow:0 0 0 2px rgba(0,122,255,0.6);border-radius:2px}</style>`;

export const frameDocument = (
  html: string,
  fonts?: UsedFont[],
  size?: { width: number; height: number },
): string => {
  if (fonts?.length) {
    const faces = fontFaces(fonts);
    return `<!doctype html><meta charset="utf-8">${fontLinks(fonts)}${
      // Its own block, and never inside a `style="…"`: a data URL is thousands of characters
      // of base64 and the attribute has an invariant about quotes to keep.
      faces ? `<style>${faces}</style>` : ""
    }${page(size)}${html}${fitScript()}`;
  }

  const families = new Set<string>();
  // Stops at a double quote as well as `;` and `}`: that quote is the end of the `style`
  // attribute the declaration lives in. Single quotes are inside the value and stay.
  for (const [, value] of html.matchAll(/font-family:\s*([^;}"]+)/gi)) {
    const first = value.split(",")[0].replace(/["']/g, "").trim();
    if (first && !GENERIC.has(first.toLowerCase()))
      families.add(googleFamily(first));
  }

  const links = [...families]
    .slice(0, 8)
    .map(
      (family) =>
        `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=${encodeURIComponent(
          family,
        ).replace(
          /%20/g,
          "+",
        )}:wght@100;200;300;400;500;600;700;800;900&display=swap">`,
    )
    .join("");

  return `<!doctype html><meta charset="utf-8">${links}${page(size)}${html}${fitScript()}`;
};

export const readPaste = ({
  text = "",
  html = "",
}: {
  text?: string;
  html?: string;
}): Pasted => {
  // The plugin's own link first: it carries the design, not a picture of it.
  const session = sessionOf(text) ?? sessionOf(html);
  if (session) return { kind: "session", id: session };

  const link = linkToEmbed(text) ?? linkToEmbed(html);
  if (link) return { kind: "embed", ...link };

  const fileKey = fileKeyOf(html);
  if (fileKey) {
    return {
      kind: "embed",
      url: embed(`/design/${fileKey}`),
      title: "Figma file",
      note: "⌘C names the file, not the frame — this opens where the file was left. ⌘L in Figma copies a link to the selection and lands on it exactly.",
    };
  }

  return {
    kind: "hint",
    message:
      "Not Figma content. Copy the frame from the plugin for the design itself; from Figma, ⌘L copies a link to the selection and ⌘⇧C copies it as a PNG. All three paste here.",
  };
};
