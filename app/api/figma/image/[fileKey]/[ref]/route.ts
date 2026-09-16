/**
 * The pixels a pasted Figma frame does not carry.
 *
 * An image fill in a clipboard payload is a 20-byte content hash; the bytes live on Figma's
 * servers. `GET /v1/files/:key/images` returns the whole ref → URL map for a file, so one call
 * covers every image on the page. Proxied rather than redirected: a CSS `mask-image` must be
 * same-origin, and a cross-origin mask silently masks everything away.
 *
 * Needs `FIGMA_TOKEN` (or `FIGMA_ACCESS_TOKEN`), a personal access token with
 * `file_content:read`. Without one this 404s and the placeholder stays painted.
 */

const CACHE_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; refs: Record<string, string> }>();

const authHeaders = (token: string): Record<string, string> =>
  token.startsWith("figd_")
    ? { "X-Figma-Token": token }
    : { Authorization: `Bearer ${token}` };

const refsFor = async (fileKey: string, token: string) => {
  const hit = cache.get(fileKey);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.refs;

  const response = await fetch(
    `https://api.figma.com/v1/files/${encodeURIComponent(fileKey)}/images`,
    { headers: authHeaders(token) },
  );
  if (!response.ok) {
    // Figma's own reason: a bad token and a file the token cannot open are both 403.
    const err = await response
      .json()
      .then((body: { err?: string }) => body.err)
      .catch(() => undefined);
    throw new Error(
      err === "Invalid token"
        ? "Figma rejected FIGMA_ACCESS_TOKEN as invalid — generate a new personal access token."
        : response.status === 403
          ? `This server's Figma token cannot open that file${err ? ` (${err})` : ""}.`
          : `Figma answered ${response.status} for that file${err ? `: ${err}` : ""}`,
    );
  }
  const body = (await response.json()) as {
    meta?: { images?: Record<string, string> };
  };
  const refs = body.meta?.images ?? {};
  cache.set(fileKey, { at: Date.now(), refs });
  return refs;
};

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ fileKey: string; ref: string }> },
) {
  const { fileKey, ref } = await params;
  if (!/^[0-9a-f]{40}$/.test(ref)) {
    return Response.json({ error: "Not an image ref" }, { status: 400 });
  }

  const token = process.env.FIGMA_TOKEN ?? process.env.FIGMA_ACCESS_TOKEN;
  if (!token) {
    return Response.json(
      {
        error:
          "Set FIGMA_TOKEN to load this design's image fills — the clipboard carries only a hash per image.",
      },
      { status: 404 },
    );
  }

  try {
    const url = (await refsFor(fileKey, token))[ref];
    if (!url) {
      return Response.json(
        { error: "That file has no image with this ref" },
        { status: 404 },
      );
    }
    const image = await fetch(url);
    if (!image.ok || !image.body) {
      return Response.json(
        { error: `Figma answered ${image.status} for those pixels` },
        { status: 502 },
      );
    }
    return new Response(image.body, {
      headers: {
        "Content-Type": image.headers.get("Content-Type") ?? "image/png",
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
