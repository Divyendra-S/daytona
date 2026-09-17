/**
 * Serves every published project. The request's hostname is looked up in KV,
 * which names the release it serves as `projectId/releaseId`; the files of
 * that release are in R2 under `sites/<projectId>/<releaseId>/`. Publishing
 * and rolling back are writes to that one KV entry (lib/site-hosting.ts), so
 * this Worker is deployed once and never again per site.
 */
interface Env {
  BUCKET: R2Bucket;
  SITE_ROUTES: KVNamespace;
}

const notFound = (text: string) =>
  new Response(text, {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { allow: "GET, HEAD" },
      });
    }

    const url = new URL(request.url);
    const release = await env.SITE_ROUTES.get(url.hostname.toLowerCase());
    if (!release) return notFound("There is no site at this address.");

    let path: string;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      return notFound("Not found");
    }

    // A static export writes `/about` as `about.html`, or as `about/index.html`
    // when the project sets `trailingSlash`. Either is found from either URL.
    const bare = path.replace(/\/+$/, "");
    const hasExtension = (bare.split("/").pop() ?? "").includes(".");
    const candidates = hasExtension
      ? [bare]
      : [`${bare}/index.html`, ...(bare ? [`${bare}.html`] : [])];

    const base = `sites/${release}`;
    let status = 200;
    let object: R2ObjectBody | R2Object | null = null;
    for (const candidate of candidates) {
      object = await env.BUCKET.get(base + candidate, {
        onlyIf: request.headers,
        range: request.headers,
      });
      if (object) break;
    }
    if (!object) {
      object = await env.BUCKET.get(`${base}/404.html`);
      status = 404;
    }
    if (!object) return notFound("Not found");

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    // Next fingerprints everything under `_next/static`; the rest can change
    // with the next publish, so it is always revalidated.
    headers.set(
      "cache-control",
      path.startsWith("/_next/static/")
        ? "public, max-age=31536000, immutable"
        : "public, max-age=0, must-revalidate",
    );

    // No body means the `onlyIf` conditions failed: the browser's copy is current.
    if (!("body" in object))
      return new Response(null, { status: 304, headers });

    // Read loosely: R2 hands back every field of the range, the unused ones
    // undefined, so `in` cannot tell a suffix range from an offset one.
    const range = object.range as
      | { offset?: number; length?: number; suffix?: number }
      | undefined;
    if (status === 200 && range) {
      const offset =
        range.suffix !== undefined
          ? object.size - range.suffix
          : (range.offset ?? 0);
      const length = range.suffix ?? range.length ?? object.size - offset;
      if (length < object.size) {
        status = 206;
        headers.set(
          "content-range",
          `bytes ${offset}-${offset + length - 1}/${object.size}`,
        );
      }
    }

    return new Response(request.method === "HEAD" ? null : object.body, {
      status,
      headers,
    });
  },
};
