import { and, eq } from "drizzle-orm";
import { getDb } from "./db/client";
import { domains } from "./db/schema";
import { readProjectMetadata } from "./project-storage";
import type { ProjectDomain } from "./project-types";
import { routeHost, unrouteHost } from "./site-hosting";

/**
 * Users' own domains, through Cloudflare for SaaS. A domain is registered on
 * the zone as a custom hostname, which has Cloudflare issue its certificate
 * and hand its traffic to `workers/sites`; the user points a CNAME at
 * `cnameTarget()`. From there it is one more hostname in KV, routed to the
 * project's live release like its subdomain is.
 */

const setting = (name: string) => (process.env[name] ?? "").trim();

const sitesDomain = () => setting("SITES_DOMAIN").toLowerCase();

/** What the user's CNAME points at: the zone's fallback origin. */
export const cnameTarget = () => `sites.${sitesDomain()}`;

/**
 * Whether this deployment offers custom domains. `CUSTOM_DOMAINS=off` is the
 * switch until there is a paid plan to check instead.
 */
export const customDomainsEnabled = () =>
  setting("CUSTOM_DOMAINS").toLowerCase() !== "off" &&
  Boolean(sitesDomain() && setting("CF_ZONE_ID") && setting("CF_KV_API_TOKEN"));

const assertEnabled = () => {
  if (!customDomainsEnabled()) {
    throw new Error("Custom domains are not set up.");
  }
};

/** A hostname as the user typed it — pasted URLs included — made safe to register. */
export const parseHostname = (raw: string) => {
  const hostname = raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/[/:?#].*$/, "")
    .replace(/\.$/, "");

  const label = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
  if (
    hostname.length > 253 ||
    !new RegExp(`^(?:${label}\\.)+[a-z]{2,63}$`).test(hostname)
  ) {
    throw new Error("That is not a domain name. Try www.yourdomain.com.");
  }
  if (hostname === sitesDomain() || hostname.endsWith(`.${sitesDomain()}`)) {
    throw new Error(
      "Choose a subdomain above instead; this is for a domain of your own.",
    );
  }
  // A root domain cannot carry a CNAME at most DNS hosts.
  if (hostname.split(".").length < 3) {
    throw new Error(
      `Connect www.${hostname} instead, and forward ${hostname} to it at your domain provider.`,
    );
  }
  return hostname;
};

type CloudflareHostname = {
  id: string;
  status: string;
  verification_errors?: string[];
  ssl?: { status?: string; validation_errors?: { message?: string }[] };
};

const cloudflare = async (path: string, init?: RequestInit) => {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${setting("CF_ZONE_ID")}/custom_hostnames${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${setting("CF_KV_API_TOKEN")}`,
        "content-type": "application/json",
      },
    },
  );
  const body = (await response.json().catch(() => null)) as {
    success?: boolean;
    result?: CloudflareHostname;
    errors?: { message?: string }[];
  } | null;
  if (!response.ok || !body?.success) {
    throw new Error(
      body?.errors?.map((error) => error.message).join(" ") ||
        `Cloudflare answered ${response.status}.`,
    );
  }
  return body.result;
};

/** Hostname states Cloudflare will not recover from on its own. */
const DEAD = new Set(["blocked", "moved", "deleted"]);

const toState = (
  result: CloudflareHostname,
): Pick<ProjectDomain, "status" | "error"> => {
  if (result.status === "active" && result.ssl?.status === "active") {
    return { status: "active", error: null };
  }
  const error =
    [
      ...(result.verification_errors ?? []),
      ...(result.ssl?.validation_errors ?? []).map((entry) => entry.message),
    ]
      .filter(Boolean)
      .join(" ") || null;
  return { status: DEAD.has(result.status) ? "failed" : "pending", error };
};

const toDomain = (row: typeof domains.$inferSelect): ProjectDomain => ({
  hostname: row.hostname,
  status: row.status,
  error: row.error,
});

const domainRows = (projectId: string) =>
  getDb()
    .select()
    .from(domains)
    .where(eq(domains.projectId, projectId))
    .orderBy(domains.createdAt);

/** The custom domains a project is served on right now, for publish and rollback to route. */
export const activeDomainHosts = async (projectId: string) =>
  (await domainRows(projectId))
    .filter((row) => row.status === "active")
    .map((row) => row.hostname);

/**
 * A project's domains, asking Cloudflare about each one that is not active
 * yet. The one that just became active starts serving the live release here.
 */
export const listDomains = async (
  projectId: string,
): Promise<ProjectDomain[]> => {
  const rows = await domainRows(projectId);
  if (!customDomainsEnabled()) return rows.map(toDomain);

  return Promise.all(
    rows.map(async (row) => {
      if (row.status === "active") return toDomain(row);

      const result = await cloudflare(`/${row.cfHostnameId}`).catch(() => null);
      if (!result) return toDomain(row);

      const state = toState(result);
      if (state.status === "active") {
        const { liveReleaseId } = await readProjectMetadata(projectId);
        if (liveReleaseId) {
          await routeHost(row.hostname, projectId, liveReleaseId);
        }
      }
      await getDb()
        .update(domains)
        .set(state)
        .where(eq(domains.hostname, row.hostname));
      return { hostname: row.hostname, ...state };
    }),
  );
};

/** Register a domain for a project. It serves nothing until `listDomains` sees it active. */
export const connectDomain = async (projectId: string, raw: string) => {
  assertEnabled();
  const hostname = parseHostname(raw);

  const [taken] = await getDb()
    .select({ projectId: domains.projectId })
    .from(domains)
    .where(eq(domains.hostname, hostname));
  if (taken) {
    throw new Error(
      taken.projectId === projectId
        ? "That domain is already connected."
        : "That domain is connected to another project.",
    );
  }

  const result = await cloudflare("", {
    method: "POST",
    body: JSON.stringify({ hostname, ssl: { method: "http", type: "dv" } }),
  });
  if (!result) throw new Error("Cloudflare did not register the domain.");

  try {
    await getDb()
      .insert(domains)
      .values({
        hostname,
        projectId,
        cfHostnameId: result.id,
        ...toState(result),
      });
  } catch (error) {
    // Lost a race for the hostname: leave nothing registered for the loser.
    await cloudflare(`/${result.id}`, { method: "DELETE" }).catch(() => {});
    throw error;
  }
};

const release = async (row: typeof domains.$inferSelect) => {
  await unrouteHost(row.hostname);
  await cloudflare(`/${row.cfHostnameId}`, { method: "DELETE" }).catch(() => {
    // Already gone at Cloudflare; the row is what is left to remove.
  });
};

export const removeDomain = async (projectId: string, hostname: string) => {
  const [row] = await getDb()
    .select()
    .from(domains)
    .where(
      and(eq(domains.projectId, projectId), eq(domains.hostname, hostname)),
    );
  if (!row) return;

  await release(row);
  await getDb().delete(domains).where(eq(domains.hostname, hostname));
};

/** Before a project is deleted: its rows go with it, its hostnames would not. */
export const releaseProjectDomains = async (projectId: string) => {
  await Promise.all((await domainRows(projectId)).map(release));
};
