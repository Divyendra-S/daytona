import path from "node:path";

/**
 * Where projects live, one folder each — see `projectPaths` in
 * local-project.ts. Ignored by this app's git and TypeScript config.
 */
export const PROJECTS_DIR = path.join(process.cwd(), "projects");

/** The template new projects start from. */
export const TEMPLATE_REPO =
  "https://github.com/freestyle-sh/freestyle-base-nextjs-shadcn";

/**
 * Projects get consecutive ports from here, two each: the dev server on the
 * first, the production server on the second.
 */
export const FIRST_PORT = 4000;

/** The named terminal sessions a project's dev and production servers run in. */
export const APP_SESSION = "dev";
export const PROD_SESSION = "prod";

/**
 * The address project servers bind to and are reached at. Not "localhost":
 * Node may resolve that to IPv6 only, while browsers try IPv4 first.
 */
export const LOCAL_HOST = "127.0.0.1";
