import { Daytona, type Sandbox } from "@daytonaio/sdk";
import {
  readPreviewUrl,
  readProjectMetadata,
  savePreviewUrl,
} from "./project-storage";
import {
  AUTO_ARCHIVE_MINUTES,
  AUTO_STOP_MINUTES,
  PREVIEW_HOST_PARAM,
  PREVIEW_PROXY_HOST,
  SANDBOX_IMAGE,
  SANDBOX_LABEL,
  SANDBOX_RESOURCES,
  SANDBOX_SNAPSHOT,
} from "./vars";

/**
 * A project's Daytona sandbox: where its code lives, where every command runs,
 * and where its dev and production servers listen.
 *
 * Everything that touches a project's code goes through this module. A sandbox
 * is long-lived and one-per-project, so git history, installed dependencies and
 * published releases survive between sessions; Daytona stops it when it goes
 * idle and starts it again on the next request, which is what `openProject`
 * quietly waits for.
 */

/** Resolved once per sandbox: which absolute paths its code lives at. */
export type ProjectSandbox = {
  sandbox: Sandbox;
  /** The sandbox user's home directory, e.g. `/root`. */
  root: string;
  /** The git repo the agent edits and the dev server serves. */
  app: string;
  /** A clone of `app` that publishing builds and serves. */
  production: string;
};

type Entry = ProjectSandbox & {
  /** When this entry's sandbox was last confirmed to be running. */
  verifiedAt: number;
  /** Preview origins by port, cached because each one is an API round trip. */
  previews: Map<number, { url: string; token: string }>;
};

/**
 * How long a "the sandbox is running" check is trusted for. Daytona can stop
 * an idle sandbox behind our back, so this is re-checked — but not on every
 * request, which would add a round trip to each one.
 */
const FRESH_MS = 20_000;

/** How long to wait for a stopped or archived sandbox to come back, in seconds. */
const START_TIMEOUT = 180;

const globals = globalThis as Record<string, unknown>;

/**
 * Whether a resolved sandbox may be kept for the next request.
 *
 * On a Worker it may not: an entry holds the connections its handle opened, and
 * a Worker cannot use those while serving anyone else — the second request to
 * reach a cached entry hangs instead of answering. Node keeps them, where
 * re-resolving every sandbox on every request would be pure waste.
 */
const REUSABLE =
  typeof navigator === "undefined" ||
  navigator.userAgent !== "Cloudflare-Workers";

/** Kept on globalThis so a hot reload of this module does not re-resolve every sandbox. */
const cache: Map<string, Promise<Entry>> = (globals[
  "__aiBuilderSandboxes"
] as Map<string, Promise<Entry>>) ??
(globals["__aiBuilderSandboxes"] = new Map());

/**
 * The key as this process loaded it, described without revealing it: enough
 * to compare against the machine where it works (length, first characters).
 */
export const keyShape = () => {
  const key = process.env["DAYTONA_API_KEY"] ?? "";
  return `${key.length} characters, starting "${key.slice(0, 4)}"`;
};

/** What Daytona said — plus the key's shape when it was the key Daytona refused. */
export const explainDaytonaError = (error: unknown) => {
  const failure = error as {
    statusCode?: number;
    status?: number;
    response?: { status?: number };
  };
  const status =
    failure?.statusCode ?? failure?.status ?? failure?.response?.status;
  const message = error instanceof Error ? error.message : String(error);
  const refused = status === 401 || /invalid credentials/i.test(message);
  return {
    status,
    message: refused
      ? `${message} (DAYTONA_API_KEY as this deployment loaded it: ${keyShape()})`
      : message,
  };
};

/**
 * A client for the request being served. Not cached: a Worker may not reuse a
 * connection opened while serving a different request, and this client holds
 * them — cached, it serves one request per isolate and hangs on the rest.
 */
export const getDaytona = (): Daytona => {
  const apiKey = process.env["DAYTONA_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "DAYTONA_API_KEY is not set. Add it to .env.local — projects cannot run without a sandbox.",
    );
  }
  // A key that works on one machine and reads "Invalid credentials" on another
  // was almost always pasted there with its name, quotes or a stray space.
  if (/[\s"'=]/.test(apiKey)) {
    throw new Error(
      `DAYTONA_API_KEY looks mangled (${keyShape()}): it should be the bare key and nothing else — no name, quotes or spaces.`,
    );
  }
  return new Daytona({ apiKey });
};

/**
 * Bring a sandbox back if Daytona stopped or archived it while we were away.
 * Returns whether it had to be started, which invalidates anything derived from
 * the sandbox's old run.
 */
const ensureStarted = async (sandbox: Sandbox) => {
  await sandbox.refreshData();
  if (sandbox.state === "started") return false;

  if (
    sandbox.state === "stopped" ||
    sandbox.state === "archived" ||
    sandbox.state === "paused"
  ) {
    await sandbox.start(START_TIMEOUT);
  }
  await sandbox.waitUntilStarted(START_TIMEOUT);
  return true;
};

const toEntry = async (sandbox: Sandbox): Promise<Entry> => {
  const root = (await sandbox.getUserRootDir()) ?? "/root";
  return {
    sandbox,
    root,
    app: `${root}/app`,
    production: `${root}/production`,
    verifiedAt: Date.now(),
    previews: new Map(),
  };
};

const openFromMetadata = async (projectId: string): Promise<Entry> => {
  const { sandboxId } = await readProjectMetadata(projectId);
  if (!sandboxId) {
    throw new Error(
      "This project has no sandbox. It was created before the move to Daytona and its code is still only on this machine.",
    );
  }
  const sandbox = await getDaytona().get(sandboxId);
  await ensureStarted(sandbox);
  return toEntry(sandbox);
};

/**
 * The project's sandbox, running and ready.
 *
 * Idempotent and safe to call concurrently — many routes call it at once, and
 * they share one in-flight promise rather than each starting the sandbox. A
 * cached sandbox is re-checked once its liveness goes stale, and re-opened from
 * scratch if that check fails, so a sandbox deleted or recreated out from under
 * us recovers instead of wedging.
 */
export const openProject = (projectId: string): Promise<ProjectSandbox> => {
  if (!REUSABLE) return openFromMetadata(projectId);

  const current = cache.get(projectId);

  const next = (
    current
      ? current.then(async (entry) => {
          if (Date.now() - entry.verifiedAt < FRESH_MS) return entry;
          // A sandbox that had to be restarted issues new preview tokens, and
          // the old ones now answer 401 — so everything derived from the
          // previous run is dropped rather than served as a broken preview.
          if (await ensureStarted(entry.sandbox)) forgetPreviewUrls(projectId);
          entry.verifiedAt = Date.now();
          return entry;
        })
      : Promise.reject(new Error("not cached"))
  ).catch(() => openFromMetadata(projectId));

  cache.set(projectId, next);
  next.catch(() => {
    // A failed open must not be cached, or the project never recovers.
    if (cache.get(projectId) === next) cache.delete(projectId);
  });
  return next;
};

/** The project's sandbox paths, without the handle. */
export const sandboxPaths = async (projectId: string) => {
  const { root, app, production } = await openProject(projectId);
  return { root, app, production };
};

/**
 * Create a project's sandbox. Returns its id, which the caller stores in the
 * project's metadata — that id is the only way back to it.
 *
 * The new sandbox is cached immediately, so the clone and install that follow
 * do not have to read metadata that has not been written yet.
 */
export const createProjectSandbox = async (projectId: string) => {
  const params = {
    labels: { [SANDBOX_LABEL]: projectId },
    autoStopInterval: AUTO_STOP_MINUTES,
    autoArchiveInterval: AUTO_ARCHIVE_MINUTES,
  };

  const sandbox = await (
    SANDBOX_SNAPSHOT
      ? getDaytona().create(
          { ...params, snapshot: SANDBOX_SNAPSHOT },
          { timeout: START_TIMEOUT },
        )
      : getDaytona().create(
          { ...params, image: SANDBOX_IMAGE, resources: SANDBOX_RESOURCES },
          { timeout: START_TIMEOUT },
        )
  ).catch((error: unknown) => {
    throw new Error(explainDaytonaError(error).message);
  });

  const entry = await toEntry(sandbox);
  cache.set(projectId, Promise.resolve(entry));
  return { sandboxId: sandbox.id, sandbox: entry as ProjectSandbox };
};

/** Forget a project's cached sandbox, so the next call re-reads its metadata. */
export const forgetProjectSandbox = (projectId: string) => {
  cache.delete(projectId);
  forgetPreviewUrls(projectId);
};

/**
 * How many times a project's sandbox has been seen to start. Anything derived
 * from a sandbox's previous run — preview tokens, terminal sessions, running
 * servers — is void once this changes, because a restarted sandbox keeps its
 * disk but not a single running process.
 */
const generations: Map<string, number> =
  (globals["__aiBuilderSandboxRuns"] as Map<string, number>) ??
  (globals["__aiBuilderSandboxRuns"] = new Map());

export const sandboxGeneration = (projectId: string) =>
  generations.get(projectId) ?? 0;

/** Drop everything cached from a project's previous sandbox run. */
const forgetPreviewUrls = (projectId: string) => {
  generations.set(projectId, sandboxGeneration(projectId) + 1);
  void cache
    .get(projectId)
    ?.then((entry) => entry.previews.clear())
    .catch(() => {});
  for (const id of signedUrls.keys()) {
    if (id.startsWith(`${projectId}:`)) signedUrls.delete(id);
  }
};

/** Delete a project's sandbox and everything in it. There is no undo. */
export const deleteProjectSandbox = async (projectId: string) => {
  const { sandboxId } = await readProjectMetadata(projectId).catch(() => ({
    sandboxId: null,
  }));
  forgetProjectSandbox(projectId);
  if (!sandboxId) return;
  await getDaytona()
    .get(sandboxId)
    .then((sandbox) => sandbox.delete())
    .catch(() => {
      // Already gone, or never created.
    });
};

/**
 * Where a port inside the sandbox is reachable from here, and the token that
 * authenticates it.
 *
 * SECURITY: the token authenticates every port of the sandbox, including its
 * own toolbox API. It is server-side only — never put it in a response body, a
 * redirect, or anything the browser can read. Use `dormantPreviewUrl` for that.
 */
export const previewOrigin = async (projectId: string, port: number) => {
  const entry = (await openProject(projectId)) as Entry;
  const cached = entry.previews.get(port);
  if (cached) return cached;

  const { url, token } = await entry.sandbox.getPreviewLink(port);
  const link = { url: url.replace(/\/$/, ""), token };
  entry.previews.set(port, link);
  return link;
};

/**
 * The URL the browser loads for a signed preview. Daytona's own preview host
 * greets a browser with a warning page it remembers in a cookie — which an
 * iframe cannot keep — so a deployed build fronts it with a preview proxy of
 * its own, one of two:
 *
 * - `workers/preview-proxy`, on the domain `PREVIEW_PROXY_DOMAIN` names. The
 *   upstream host travels in the hostname (`.` as `--`), so the proxy stores
 *   nothing.
 * - `lib/hosted-preview-proxy.ts`, on `PREVIEW_PROXY_HOST` — a second
 *   hostname of the deployment itself, for a deployment with no DNS to put a
 *   wildcard on. The upstream host travels in the query, and the proxy keeps
 *   it in a cookie from there.
 *
 * Neither set, the signed URL is used as is.
 */
const publicPreviewUrl = (signedUrl: string) => {
  if (!signedUrl) return signedUrl;
  const domain = process.env["PREVIEW_PROXY_DOMAIN"];
  if (domain) {
    const url = new URL(signedUrl);
    url.hostname = `${url.hostname.replace(/\./g, "--")}.${domain}`;
    return url.toString();
  }
  if (PREVIEW_PROXY_HOST) {
    const signed = new URL(signedUrl);
    const url = new URL(
      signed.pathname + signed.search,
      `https://${PREVIEW_PROXY_HOST}`,
    );
    url.searchParams.set(PREVIEW_HOST_PARAM, signed.hostname);
    return url.toString();
  }
  return signedUrl;
};

/**
 * A preview URL the browser may load directly: scoped to one port, carrying
 * its own short-lived token, and safe to hand out.
 */
export const signedPreviewUrl = (projectId: string, port: number) =>
  stableSignedUrl(projectId, port, async () => {
    const { sandbox } = await openProject(projectId);
    const { url } = await sandbox.getSignedPreviewUrl(port, SIGNED_URL_SECONDS);
    return url;
  });

/**
 * The project's signed URL for a port, signing a new one only when there is no
 * usable one left.
 *
 * Daytona shows a browser a warning page the first time it visits a preview
 * host and remembers the click-through against that host — so a URL signed per
 * request, each with a hostname of its own, put the preview back behind that
 * page seconds after it was dismissed. The URL is kept in the project's row
 * rather than in memory because a Worker isolate is short-lived, and a new
 * isolate signing its own URL would bring the warning back just the same.
 */
const stableSignedUrl = async (
  projectId: string,
  port: number,
  sign: () => Promise<string>,
) => {
  const id = `${projectId}:${port}`;
  const now = Date.now();

  const remembered = signedUrls.get(id);
  if (remembered && remembered.expiresAt > now) {
    return publicPreviewUrl(remembered.url);
  }

  const stored = await readPreviewUrl(projectId, port).catch(() => null);
  const storedUntil = stored ? Date.parse(stored.expiresAt) - RESIGN_MARGIN : 0;
  if (stored && storedUntil > now) {
    signedUrls.set(id, { url: stored.url, expiresAt: storedUntil });
    return publicPreviewUrl(stored.url);
  }

  const url = await sign().catch(() => "");
  if (!url) return "";

  const expiresAt = now + SIGNED_URL_SECONDS * 1000;
  signedUrls.set(id, { url, expiresAt: expiresAt - RESIGN_MARGIN });
  await savePreviewUrl(projectId, port, {
    url,
    expiresAt: new Date(expiresAt).toISOString(),
  }).catch(() => {
    // Worth a slower path, not a failed preview: without the row this signs
    // again next time, which costs a warning page rather than the preview.
  });

  return publicPreviewUrl(url);
};

/** Signed URLs by `projectId:port`, so listing projects is not a burst of signing calls. */
const signedUrls: Map<string, { url: string; expiresAt: number }> =
  (globals["__aiBuilderSignedUrls"] as Map<
    string,
    { url: string; expiresAt: number }
  >) ?? (globals["__aiBuilderSignedUrls"] = new Map());

/** Daytona's maximum. The longer this is, the rarer the warning page. */
const SIGNED_URL_SECONDS = 86_400;

/** Re-signed this long before expiry, so a URL handed out now outlives the page. */
const RESIGN_MARGIN = 10 * 60 * 1000;

/**
 * A signed preview URL for a project that may well be asleep — **without
 * waking it**.
 *
 * Listing projects must not start sandboxes: the home screen shows every
 * project at once, and starting all of them would undo the idle auto-stop that
 * keeps the bill near zero. Signing a URL only needs the sandbox record, not a
 * running sandbox, so this asks Daytona for the sandbox and signs. A URL for a
 * stopped sandbox simply does not answer until something starts it.
 *
 * Cached, and the cache is the point as much as the saving: every signing
 * gives a different host, and a preview frame pointed at a URL that changed
 * reloads. The workspace asks for this URL every few seconds.
 */
export const dormantPreviewUrl = (projectId: string, port: number) =>
  stableSignedUrl(projectId, port, async () => {
    const { sandboxId } = await readProjectMetadata(projectId).catch(() => ({
      sandboxId: null,
    }));
    if (!sandboxId) return "";

    const sandbox = await getDaytona().get(sandboxId);
    const { url } = await sandbox.getSignedPreviewUrl(port, SIGNED_URL_SECONDS);
    return url;
  });

/**
 * Tell Daytona the project is in use, so its idle timer does not stop the
 * sandbox out from under someone who is still working. Best-effort.
 */
export const touchProject = async (projectId: string) => {
  await openProject(projectId)
    .then(({ sandbox }) => sandbox.refreshActivity())
    .catch(() => {
      // Keeping a sandbox awake is never worth failing a request over.
    });
};

/**
 * What state a project's sandbox is in, without starting it. `detail` carries
 * what Daytona said when it could not be asked, which is the difference
 * between "check your key" and an hour of guessing.
 */
export const projectSandboxState = async (
  projectId: string,
): Promise<{ state: string; detail?: string }> => {
  const { sandboxId } = await readProjectMetadata(projectId).catch(() => ({
    sandboxId: null,
  }));
  if (!sandboxId) return { state: "missing" as const };
  return getDaytona()
    .get(sandboxId)
    .then((sandbox) => ({ state: sandbox.state ?? ("unknown" as const) }))
    .catch((error: unknown) => {
      // Only a 404 means the sandbox is gone. Anything else — a key belonging
      // to another Daytona account, an outage, a rate limit — must not be
      // reported as deleted: that tells the user their work is unrecoverable
      // when it is still there, one environment variable away.
      // Carried back so the workspace can say what went wrong instead of
      // leaving the operator to guess at someone else's environment.
      const { status, message } = explainDaytonaError(error);
      const detail = [status ? `HTTP ${status}` : null, message]
        .filter(Boolean)
        .join(": ")
        .slice(0, 300);

      return status === 404
        ? { state: "missing" as const, detail }
        : { state: "unreachable" as const, detail };
    });
};
