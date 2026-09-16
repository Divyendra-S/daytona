import { decompress as unzstd } from "fzstd";
import { compileSchema, decodeBinarySchema, type Schema } from "kiwi-schema";

/**
 * Figma's clipboard payload, decoded.
 *
 * ⌘C in Figma writes an HTML flavour with the copied scene hidden in a comment: a base64
 * `fig-kiwi` archive holding the same binary Kiwi encoding as a `.fig` file. This turns that
 * back into nodes.
 *
 * **The payload carries its own schema.** Chunk 0 of the archive is a binary Kiwi schema and
 * chunk 1 is the message encoded against it, so there is no vendored `fig.kiwi` to keep in step
 * with Figma and no version to gate on — every paste describes its own format. That matters
 * more than it sounds: Kiwi's decoder throws on a field id it does not know ("Attempted to
 * parse invalid message"), so decoding against a schema from a different build is not degraded,
 * it is dead. Reading the schema out of the payload is what makes this maintainable at all.
 *
 * Everything else about the format is proprietary and undocumented. It can change without
 * notice; the guarantee here is that it fails loudly when it does.
 */

const PAYLOAD = /\(figma\)([A-Za-z0-9+/=\s]+)\(\/figma\)/;
const META = /\(figmeta\)([A-Za-z0-9+/=\s]+)\(\/figmeta\)/;

/** Design files, FigJam boards and Slides decks each stamp their own. */
const MAGIC = ["fig-kiwi", "fig-jam.", "fig-deck"];

export class UnsupportedPayload extends Error {}

export type ClipboardMeta = {
  fileKey?: string;
  pasteID?: number;
  /** `"3134:9567|4|0|0"` — the guid of what was selected when ⌘C was pressed. */
  selectedNodeData?: string;
  dataType?: string;
  editorType?: string;
  [field: string]: unknown;
};

/** The guids named in `selectedNodeData`, which is what "what was copied" actually means. */
export const selectedGuids = (meta: ClipboardMeta | null): string[] =>
  (typeof meta?.selectedNodeData === "string"
    ? meta.selectedNodeData.match(/\d+:\d+/g)
    : null) ?? [];

/** A node exactly as the payload describes it — Figma's field names, not ours. */
export type NodeChange = {
  guid?: { sessionID: number; localID: number };
  parentIndex?: {
    guid: { sessionID: number; localID: number };
    /** A fractional index. Sort these as strings; parsing one as a number reorders siblings. */
    position: string;
  };
  name?: string;
  type?: string;
  size?: { x: number; y: number };
  transform?: {
    m00: number;
    m01: number;
    m02: number;
    m10: number;
    m11: number;
    m12: number;
  };
  [field: string]: unknown;
};

export type FigmaMessage = {
  type?: string;
  nodeChanges?: NodeChange[];
  blobs?: { bytes: Uint8Array }[];
  [field: string]: unknown;
};

const bytesOf = (base64: string): Uint8Array => {
  const binary = atob(base64.replace(/\s/g, ""));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
};

/**
 * Whether there is a payload at all — the question `use-paste` asks before deciding what a
 * paste is. A regex test and nothing else: `payloadOf` *decodes* the base64 to answer, a
 * `charCodeAt` loop over every byte of a multi-megabyte design, on the main thread, for a
 * yes-or-no — and then the worker decoded it again. Measured at 6× throttling: two seconds of
 * the paste frozen before anything had started.
 */
export const hasPayload = (html: string): boolean => PAYLOAD.test(html);

export const payloadOf = (html: string): Uint8Array | null => {
  const match = html.match(PAYLOAD);
  return match ? bytesOf(match[1]) : null;
};

export const metaOf = (html: string): ClipboardMeta | null => {
  const match = html.match(META);
  if (!match) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytesOf(match[1])));
  } catch {
    return null;
  }
};

/**
 * `[8 bytes magic][u32 version]` then `[u32 length][deflate-raw bytes]` until the end.
 *
 * Lengths are little-endian, which is the whole of the format's framing.
 */
export const parseArchive = (
  bytes: Uint8Array,
): { magic: string; version: number; chunks: Uint8Array[] } => {
  const magic = new TextDecoder().decode(bytes.subarray(0, 8));
  if (!MAGIC.includes(magic)) {
    throw new UnsupportedPayload(
      `Not a Figma payload: expected one of ${MAGIC.join(", ")}, got ${JSON.stringify(magic)}.`,
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: Uint8Array[] = [];
  let offset = 12;

  while (offset + 4 <= bytes.length) {
    const length = view.getUint32(offset, true);
    offset += 4;
    if (length === 0 || offset + length > bytes.length) break;
    chunks.push(bytes.subarray(offset, offset + length));
    offset += length;
  }

  return { magic, version: view.getUint32(8, true), chunks };
};

/** Zstandard's frame magic, little-endian 0xFD2FB528. */
const ZSTD = [0x28, 0xb5, 0x2f, 0xfd];

/**
 * The chunks are not compressed the same way, and sniffing beats assuming.
 *
 * Measured on a payload from a current Figma build: the schema chunk is deflate-raw and the
 * data chunk is **zstd** — which is why every parser written against the 2022 format now dies
 * with "invalid stored block lengths" on the second chunk. Older payloads are deflate-raw
 * throughout, and reading the magic handles both without a version table to maintain.
 *
 * zstd goes through fzstd rather than the platform: `DecompressionStream` does gzip, deflate
 * and deflate-raw, and no browser exposes zstd to it.
 *
 * A chunk that is not compressed at all comes back untouched rather than failing the paste.
 */
export const decompressChunk = async (
  bytes: Uint8Array,
): Promise<Uint8Array> => {
  if (ZSTD.every((byte, i) => bytes[i] === byte)) return unzstd(bytes);

  try {
    const stream = new Blob([bytes as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return bytes;
  }
};

export type Decoded = {
  meta: ClipboardMeta | null;
  message: FigmaMessage;
  /** The schema the payload shipped, kept because it is the only description of these fields. */
  schema: Schema;
  magic: string;
  version: number;
};

export const decodeClipboard = async (
  html: string,
): Promise<Decoded | null> => {
  const payload = payloadOf(html);
  if (!payload) return null;

  const { magic, version, chunks } = parseArchive(payload);
  if (chunks.length < 2) {
    throw new UnsupportedPayload(
      `Expected a schema chunk and a data chunk; this payload has ${chunks.length}.`,
    );
  }

  const [schemaChunk, dataChunk] = await Promise.all([
    decompressChunk(chunks[0]),
    decompressChunk(chunks[1]),
  ]);

  const schema = decodeBinarySchema(schemaChunk);
  const message = compileSchema(schema).decodeMessage(
    dataChunk,
  ) as FigmaMessage;

  return { meta: metaOf(html), message, schema, magic, version };
};

export type FigmaNode = NodeChange & { children: FigmaNode[] };

const keyOf = (guid?: { sessionID: number; localID: number }) =>
  guid ? `${guid.sessionID}:${guid.localID}` : "";

/**
 * The flat change list, back into a tree.
 *
 * A node whose parent is not in the payload is a root — that is the selection boundary, so one
 * copied frame gives one root and a multi-select gives several.
 */
/**
 * A copy carries the page it was copied from: the payload's own roots are DOCUMENT and CANVAS,
 * and the selection sits underneath them. They are structure, not content — rendering them
 * gives a root with no size wrapping everything that does have one.
 */
const WRAPPERS = new Set(["DOCUMENT", "CANVAS"]);

const unwrap = (nodes: FigmaNode[]): FigmaNode[] =>
  nodes.flatMap((node) =>
    WRAPPERS.has(node.type ?? "") ? unwrap(node.children) : [node],
  );

/**
 * A copy also carries the file's paint and text styles, as 100×100 swatches parked on an
 * "Internal Only Canvas" — 31 of them beside one frame, in the payload this was written
 * against. They are definitions the copied nodes refer to, not things that were copied.
 */
const isStyleDefinition = (node: FigmaNode) =>
  node.styleType !== undefined || node.isPublishable === true;

/**
 * Components, by guid.
 *
 * An INSTANCE in a payload carries no children — its content is a SYMBOL somewhere else in the
 * message, usually on a page that was never selected, and `symbolData.symbolID` points at it.
 * Without this an instance is an empty box, which is what every background texture in a design
 * built from components renders as.
 */
export const symbolsOf = (changes: NodeChange[]): Map<string, FigmaNode> => {
  const byId = new Map<string, FigmaNode>();
  for (const change of changes) {
    if (change.guid) byId.set(keyOf(change.guid), { ...change, children: [] });
  }
  for (const node of byId.values()) {
    const parent = node.parentIndex && byId.get(keyOf(node.parentIndex.guid));
    if (parent) parent.children.push(node);
  }
  for (const node of byId.values()) {
    node.children.sort((a, b) =>
      (a.parentIndex?.position ?? "") < (b.parentIndex?.position ?? "")
        ? -1
        : 1,
    );
  }

  const symbols = new Map<string, FigmaNode>();
  for (const [id, node] of byId) {
    if (node.type === "SYMBOL") symbols.set(id, node);
  }
  return symbols;
};

/**
 * Shared colour styles, by key.
 *
 * A copy carries every colour style the selection touches as its own swatch node — a
 * `styleType: "FILL"` rectangle holding the resolved paint. Nodes never need it: Figma writes
 * both the reference *and* the paint on a node, and all 100 references across this corpus
 * resolve without it. A **text run** does not. Its style override table stores only the delta,
 * so a run coloured from a style carries `styleIdForFill` and no paint at all, and one grey word
 * in a heading rendered in the heading's own colour.
 */
export const fillStylesOf = (changes: NodeChange[]): Map<string, unknown> => {
  const styles = new Map<string, unknown>();
  for (const change of changes) {
    const { styleType, key } = change as { styleType?: string; key?: string };
    if (styleType === "FILL" && key) styles.set(key, change.fillPaints);
  }
  return styles;
};

/** The guid an instance points at, as the key `symbolsOf` uses. */
export const symbolIdOf = (node: NodeChange): string | null => {
  const id = (
    node.symbolData as
      | { symbolID?: { sessionID: number; localID: number } }
      | undefined
  )?.symbolID;
  return id ? keyOf(id) : null;
};

export const assembleTree = (
  changes: NodeChange[],
  /** From `selectedNodeData`. Given, it decides the roots outright. */
  selected: string[] = [],
): FigmaNode[] => {
  const byId = new Map<string, FigmaNode>();
  for (const change of changes) {
    if (change.guid) byId.set(keyOf(change.guid), { ...change, children: [] });
  }

  const roots: FigmaNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentIndex && byId.get(keyOf(node.parentIndex.guid));
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  // Fractional indices, compared as strings: "a1" sorts before "a2" and both before "b".
  for (const node of byId.values()) {
    node.children.sort((a, b) =>
      (a.parentIndex?.position ?? "") < (b.parentIndex?.position ?? "")
        ? -1
        : 1,
    );
  }

  // What Figma says was selected beats anything inferred from the tree — a copy carries the
  // page, the styles and the document around what was actually picked.
  const picked = selected
    .map((guid) => byId.get(guid))
    .filter((node): node is FigmaNode => node !== undefined);
  if (picked.length) return picked;

  return unwrap(roots).filter((node) => !isStyleDefinition(node));
};
