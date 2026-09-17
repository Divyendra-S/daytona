import { gunzipSync } from "node:zlib";
import { AwsClient } from "aws4fetch";
import mime from "mime-types";
import { extract } from "tar-stream";

/**
 * Where published sites live: their files in an R2 bucket, under
 * `sites/<projectId>/<releaseId>/`, and a KV entry per hostname naming the
 * release it serves. `workers/sites` answers every hostname from those two.
 *
 * Both are reached over HTTP — R2 through its S3 API, KV through Cloudflare's
 * REST API — rather than through Worker bindings, so publishing works the same
 * from `next dev` on a laptop as from the deployed Worker.
 *
 * SECURITY: these credentials stay here. The sandbox runs the user's code, so
 * it only ever hands the build over; it never uploads anything itself.
 */

const REQUIRED = [
  "SITES_DOMAIN",
  "CF_ACCOUNT_ID",
  "CF_API_TOKEN",
  "CF_KV_NAMESPACE_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
] as const;

const setting = (name: (typeof REQUIRED)[number]) =>
  (process.env[name] ?? "").trim();

/** Throws naming what is missing, so a publish fails before it builds anything. */
export const assertSiteHosting = () => {
  const missing = REQUIRED.filter((name) => !setting(name));
  if (missing.length > 0) {
    throw new Error(`Publishing is not set up: ${missing.join(", ")} missing.`);
  }
};

/** The domain every project gets a subdomain of, or "" when none is configured. */
const sitesDomain = () =>
  setting("SITES_DOMAIN")
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/\/.*$/, "");

/**
 * The hostname a project is published on. The project id is the subdomain: it
 * is already unique, lowercase and a valid DNS label.
 */
export const siteHost = (projectId: string) =>
  sitesDomain() ? `${projectId}.${sitesDomain()}` : "";

export const siteUrl = (projectId: string) =>
  siteHost(projectId) ? `https://${siteHost(projectId)}` : "";

const objectUrl = (key: string) =>
  `https://${setting("CF_ACCOUNT_ID")}.r2.cloudflarestorage.com/${
    (process.env["R2_BUCKET"] ?? "").trim() || "published-sites"
  }/${key.split("/").map(encodeURIComponent).join("/")}`;

const r2 = () =>
  new AwsClient({
    accessKeyId: setting("R2_ACCESS_KEY_ID"),
    secretAccessKey: setting("R2_SECRET_ACCESS_KEY"),
    service: "s3",
    region: "auto",
  });

const releasePrefix = (projectId: string, releaseId: string) =>
  `sites/${projectId}/${releaseId}`;

/** Run `task` over every item, a few at a time. */
const inBatches = async <T>(items: T[], task: (item: T) => Promise<void>) => {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        await task(item);
      }
    }),
  );
};

/** Unpack a gzipped tarball of the build's `out/` into R2, under this release's prefix. */
export const uploadSite = async (
  projectId: string,
  releaseId: string,
  tgz: Uint8Array,
) => {
  const files: { path: string; body: Buffer }[] = [];
  const unpack = extract();
  unpack.end(gunzipSync(tgz));
  for await (const entry of unpack) {
    const chunks: Buffer[] = [];
    for await (const chunk of entry) chunks.push(chunk as Buffer);
    if (entry.header.type !== "file") continue;
    const path = entry.header.name.replace(/^\.\//, "");
    // A static export has no business outside its own folder.
    if (path.split("/").includes("..")) continue;
    files.push({ path, body: Buffer.concat(chunks) });
  }

  if (!files.some((file) => file.path === "index.html")) {
    throw new Error("The build has no index.html to publish.");
  }

  const client = r2();
  await inBatches(files, async ({ path, body }) => {
    const response = await client.fetch(
      objectUrl(`${releasePrefix(projectId, releaseId)}/${path}`),
      {
        method: "PUT",
        body: new Uint8Array(body),
        headers: {
          "content-type": mime.lookup(path) || "application/octet-stream",
        },
      },
    );
    if (!response.ok) {
      throw new Error(`Upload of ${path} failed (${response.status}).`);
    }
  });
};

/** Whether a release's files are in the bucket, so it can be served again without a build. */
export const releaseIsUploaded = async (projectId: string, releaseId: string) =>
  (
    await r2().fetch(
      objectUrl(`${releasePrefix(projectId, releaseId)}/index.html`),
      { method: "HEAD" },
    )
  ).ok;

const routeUrl = (host: string) =>
  `https://api.cloudflare.com/client/v4/accounts/${setting("CF_ACCOUNT_ID")}/storage/kv/namespaces/${setting("CF_KV_NAMESPACE_ID")}/values/${encodeURIComponent(host)}`;

/** Point a hostname at a release. A rollback is the same call with an older release. */
export const routeHost = async (
  host: string,
  projectId: string,
  releaseId: string,
) => {
  const response = await fetch(routeUrl(host), {
    method: "PUT",
    headers: { Authorization: `Bearer ${setting("CF_API_TOKEN")}` },
    body: `${projectId}/${releaseId}`,
  });
  if (!response.ok) {
    throw new Error(`Could not route ${host}: ${await response.text()}`);
  }
};

/** Take a deleted project's site down: its hostname first, then every file of every release. */
export const deleteSite = async (projectId: string) => {
  if (REQUIRED.some((name) => !setting(name))) return;

  await fetch(routeUrl(siteHost(projectId)), {
    method: "DELETE",
    headers: { Authorization: `Bearer ${setting("CF_API_TOKEN")}` },
  });

  const client = r2();
  // A listing is a page of at most a thousand keys; deleting them empties the
  // page, so the next listing is the next thousand.
  for (let page = 0; page < 50; page += 1) {
    const listing = await client.fetch(
      `${objectUrl("")}?list-type=2&prefix=${encodeURIComponent(`sites/${projectId}/`)}`,
    );
    if (!listing.ok) return;
    const keys = [...(await listing.text()).matchAll(/<Key>([^<]+)<\/Key>/g)]
      .map((match) => match[1])
      .filter((key): key is string => Boolean(key))
      .map((key) =>
        key
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'"),
      );
    if (keys.length === 0) return;
    await inBatches(keys, async (key) => {
      await client.fetch(objectUrl(key), { method: "DELETE" });
    });
  }
};
