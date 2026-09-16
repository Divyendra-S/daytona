/**
 * The contract between the Figma plugin and the editor.
 *
 * The plugin can read a Figma file without any local server; the editor can run a browser,
 * hold a key off the client, and take as long as it likes. Neither can do the other's half, so
 * the whole design is: the plugin reads, uploads once, and the editor's agent works against
 * what it uploaded.
 *
 * This package exists so the two cannot drift. Both import these types; a change that breaks
 * one fails to compile in the other, which is the only thing that reliably keeps a wire format
 * honest.
 */

/** Bumped when a field changes meaning. The editor refuses a snapshot it does not understand. */
export const PROTOCOL_VERSION = 3;

/**
 * One node of the frame, already normalised by the plugin's own serializer.
 *
 * Deliberately loose: this is the transpiler's IR, and pinning every Figma property here would
 * mean restating a 7,000-line type definition and updating it whenever Figma adds a field.
 * What the editor relies on is named below; everything else rides along untouched.
 */
export type SnapshotNode = {
  id: string;
  name: string;
  uniqueName?: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  children?: SnapshotNode[];
  [property: string]: unknown;
};

/**
 * Everything the agent needs about one frame, gathered in a single upload.
 *
 * One upload rather than the editor calling back into the plugin: a round trip through the
 * plugin sandbox costs a postMessage each way and can only happen while the plugin window is
 * open. With the tree already here, the agent's tools resolve against it locally — so it keeps
 * the node-by-node walk the playbook is built on, without any of the round trips.
 */
/**
 * A picture the design already contains, kept out of the prompt.
 *
 * The model cannot invent a photograph, and it must not be asked to: the artwork in a frame is
 * already pixel-exact in Figma. Inlining it as a data URI would cost more tokens than the rest
 * of the conversation put together, so it travels beside the tree and the editor serves it at
 * a URL — which is what the MCP server does, and why its output has the real images in it.
 */
export type SnapshotAsset =
  /** Vector art, kept as text so it stays legible and compresses. */
  | { mime: "image/svg+xml"; text: string }
  /** A raster fill, exported as PNG bytes and base64ed in the UI realm. */
  | { mime: "image/png"; base64: string };

export type FrameSnapshot = {
  version: typeof PROTOCOL_VERSION;
  frame: {
    id: string;
    name: string;
    width: number;
    height: number;
  };
  /** The normalised tree, as `nodesToJSON` produced it. */
  nodes: SnapshotNode[];
  /**
   * The frame as Figma renders it: **JPEG**, base64, no data-URL prefix.
   *
   * JPEG rather than PNG, and not enormous, because this is not sent once. It rides on the
   * first message and is therefore re-sent on every step of the walk — a multi-megabyte PNG
   * repeated a dozen times is minutes of upload and, in practice, a connection reset partway
   * through.
   */
  screenshot?: string;
  /** Design variables the frame binds, by name. */
  variables?: Record<string, { type: string; value: unknown }>;
  /** Keyed by the id the tree's `assetId` fields point at. */
  assets?: Record<string, SnapshotAsset>;
  /**
   * The frame as the plugin's own converter renders it: one self-contained block of HTML with
   * inline styles, images as data URIs and vectors as inline SVG.
   *
   * This is what the canvas pastes. It is not a target for the model and never enters a
   * prompt — it is a picture made of DOM, which is the one thing an image of the frame is not.
   */
  preview?: { html: string; width: number; height: number };
};

/**
 * The plugin uploads a frame and gets back a place to watch it being built.
 *
 * It deliberately carries no API key. The editor already has one in its own environment, which
 * is how its MCP flow has always worked — and a key that never leaves the machine it was
 * configured on is a better answer than one forwarded per request.
 */
export type SessionRequest = { snapshot: FrameSnapshot };
export type SessionResponse = { id: string };

/**
 * Progress the editor reports while it works.
 *
 * Kept because the plugin still shows a hand-off log; the run itself is now the editor's own
 * chat route, so nothing here crosses the wire during a generation.
 */

/** Progress, streamed back so the plugin can show what is happening rather than a spinner. */
export type GenerateEvent =
  | {
      type: "step";
      label: string;
      detail?: string;
      steps: number;
      cost: number;
    }
  | { type: "text"; delta: string }
  | { type: "done"; code: string; ms: number; cost: number; stopped?: string }
  | { type: "error"; message: string };

/** Where the plugin sends it. Overridable so a plugin build can point at another editor. */
export const EDITOR_ORIGIN = "http://localhost:3000";
export const SESSION_PATH = "/api/plugin/session";

/** Where the editor serves one uploaded asset. Must match the route directory. */
export const assetUrl = (sessionId: string, assetId: string) =>
  `/api/plugin/asset/${encodeURIComponent(sessionId)}/${encodeURIComponent(assetId)}`;

/**
 * Where the plugin sends the user once the frame is uploaded.
 *
 * The editor's own page, with the session named in the query — not a page of its own. A
 * separate page meant a separate layout, and with it went the sidebar, the click-to-edit, the
 * check loop and everything else that page already does.
 */
export const sessionUrl = (origin: string, id: string) =>
  `${origin}/?plugin=${encodeURIComponent(id)}`;

/**
 * Where a frame lands when it is pasted rather than generated from.
 *
 * A URL rather than a bare id because it is put on the clipboard: pasted onto the canvas it is
 * a frame, and pasted into an address bar it is the same frame on the same canvas.
 */
export const canvasUrl = (origin: string, id: string) =>
  `${origin}/canvas#paste=${encodeURIComponent(id)}`;
