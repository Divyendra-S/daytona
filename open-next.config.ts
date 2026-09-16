import { defineCloudflareConfig } from "@opennextjs/cloudflare";

/**
 * Nothing is cached between requests on purpose: every page here is dynamic,
 * built from the database and the project's sandbox, so an incremental cache
 * would only be a second store to keep in sync.
 */
export default defineCloudflareConfig();
