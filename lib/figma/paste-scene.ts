/**
 * A clipboard paste, from Figma's HTML flavour to a scene the canvas can show.
 *
 * Everything between "here is the clipboard" and "here is the frame": decode, assemble, map,
 * tally what was approximated. It touches no DOM, which is the point of it being a file of its
 * own — `paste.worker.ts` runs it off the main thread, and `use-paste.ts` runs it inline where
 * there is no Worker. One implementation, two threads.
 *
 * Relative imports with the extension, like `workspace.ts`: node's test runner resolves neither
 * the alias nor a tsconfig path, and this is tested.
 */
import {
  assembleTree,
  decodeClipboard,
  fillStylesOf,
  selectedGuids,
  symbolsOf,
} from "./figma-clipboard";
import { relayout, sceneToHtml } from "./figma-scene";
import type { UsedFont } from "./figma-paste";
export type Note = { level: "error" | "warn"; text: string; kind?: string; nodes?: number };
export type FrameData = { title: string; html?: string; size?: { width: number; height: number }; fonts?: UsedFont[]; note?: string; report?: Note[] };

export type PasteScene = {
  data: FrameData;
  size: { width: number; height: number };
  /** One image fill's URL, for the probe that asks whether fills resolve at all. */
  anyImage: string | null;
};

/**
 * The size to lay the design out at, when it is not the size it was copied at.
 *
 * This is the whole of "resize the frame and watch it reflow": a Figma instance resized by its
 * handle is not scaled, it is a frame whose children answer with their constraints, and
 * `resizeByConstraints` in `figma-scene.ts` already does that arithmetic. What it needs is the
 * payload, which is why a frame keeps one — the markup is baked at one width and cannot be
 * asked about another.
 *
 * Only a lone root. A multi-frame selection is a row of boxes with no single box to resize, and
 * stretching each of them to the same size is not what dragging one edge means.
 */
export type SceneSize = { width: number; height: number };

/** `null` when the payload decoded to nothing worth placing — the caller says so. */
export const buildScene = async (
  html: string,
  at?: SceneSize,
): Promise<PasteScene | null> => {
  const decoded = await decodeClipboard(html);
  const roots = assembleTree(
    decoded?.message.nodeChanges ?? [],
    // What Figma says was selected. Without it the roots are the document, the page it was
    // on, and every colour style in the file as a 100×100 swatch.
    selectedGuids(decoded?.meta ?? null),
  );
  if (!roots.length) return null;

  /**
   * Not `{ ...root, size }` — that changes the box and tells nothing inside it.
   *
   * A 1512-wide page narrowed to 979 kept its 1492-wide body: the hero clipped mid-word and the
   * side panel went off the edge, and widened it left the extra width empty. `relayout` is the
   * frame re-running its own layout the way Figma does when you drag the handle — a child set
   * to fill takes the new measure, the free space goes to the children set to grow, and a frame
   * with no auto layout answers with its constraints.
   */
  const sized =
    at && roots.length === 1
      ? [relayout(roots[0], { w: at.width, h: at.height })]
      : roots;

  const fileKey = decoded?.meta?.fileKey;
  // The resolver is handed every ref anyway; keeping one is cheaper than returning them.
  let anyImage: string | null = null;
  const scene = sceneToHtml(sized, {
    blobs: decoded?.message.blobs,
    // An instance's content lives in a component elsewhere in the payload.
    symbols: symbolsOf(decoded?.message.nodeChanges ?? []),
    styles: fillStylesOf(decoded?.message.nodeChanges ?? []),
    // The pixels are not in the payload; this is the only route to them.
    image: fileKey
      ? (ref) => {
          const url = `/api/figma/image/${encodeURIComponent(fileKey)}/${ref}`;
          anyImage ??= url;
          return url;
        }
      : undefined,
  });

  const unmapped = Object.entries(scene.unmapped);
  const approximated = Object.entries(scene.counts).sort((a, b) => b[1] - a[1]);
  const nodes = approximated.reduce((sum, [, n]) => sum + n, 0);
  const counts = [
    unmapped.length &&
      `${unmapped.map(([type, n]) => `${n} ${type}`).join(", ")} not drawn`,
    nodes && `${nodes} approximated`,
  ].filter(Boolean);

  const report: Note[] = [
    ...unmapped.map(([type, n]): Note => ({
      level: "error",
      kind: `${type} not drawn`,
      nodes: n,
      text: `${n} ${type} node${n === 1 ? "" : "s"} have no mapping in this build — each is placed at its real bounds, and whatever is inside it is drawn in its place.`,
    })),
    ...approximated.map(([what, n]): Note => ({
      level: "warn",
      kind: what,
      nodes: n,
      text: `${what} ×${n}`,
    })),
  ];

  // Trimmed: a Figma layer named " Features Section" is a card titled with a leading space.
  const title =
    roots.length === 1
      ? (roots[0].name ?? "").trim() || "Figma"
      : `${roots.length} layers`;

  return {
    data: {
      title,
      html: scene.html,
      size: { width: scene.width, height: scene.height },
      fonts: scene.fonts,
      note: counts.join(" · ") || undefined,
      report,
    },
    size: { width: scene.width, height: scene.height },
    anyImage,
  };
};
