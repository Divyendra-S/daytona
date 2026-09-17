import { randomUUID } from "node:crypto";
import { GIT_IDENTITY, run, runStep, shellQuote } from "./project-runtime";
import {
  addRelease,
  readProjectMetadata,
  updateRelease,
} from "./project-storage";
import type { ProjectRelease } from "./project-types";
import { openProject } from "./sandbox";
import {
  assertSiteHosting,
  releaseIsUploaded,
  routeHost,
  siteHost,
  uploadSite,
} from "./site-hosting";

/** Each release pins its commit with a ref in the app repo, which production fetches by name. */
const releaseRef = (releaseId: string) =>
  `refs/ai-builder/releases/${releaseId}`;

/** What decides whether production has to reinstall its dependencies. */
const MANIFEST_HASH =
  "cat package.json package-lock.json 2>/dev/null | shasum -a 256";

/** Whether a path exists in the sandbox. */
const exists = async (projectId: string, path: string) => {
  const { sandbox } = await openProject(projectId);
  return sandbox.fs
    .getFileDetails(path)
    .then(() => true)
    .catch(() => false);
};

/**
 * Make whatever `next.config` the release has build a static export, by
 * renaming it and putting a config in its place that wraps it. Done to the
 * production copy only, and undone by the next checkout, so the project's own
 * config — and its dev server — are left as the user and the agent wrote them.
 *
 * `images.unoptimized` goes with it: the default image loader needs a server,
 * and `next build` refuses to export a page that uses it.
 */
const FORCE_STATIC_EXPORT = `
const fs = require("fs");
const ext = ["ts", "mjs", "js", "cjs"].find((e) => fs.existsSync("next.config." + e));
const wrap = "async (...args) => {\\n  const config = typeof base === 'function' ? await base(...args) : base;\\n  return { ...config, output: 'export', images: { ...config.images, unoptimized: true } };\\n}";
if (!ext) {
  fs.writeFileSync("next.config.mjs", "const base = {};\\nexport default " + wrap + ";\\n");
} else {
  fs.renameSync("next.config." + ext, "next.config.base." + ext);
  const esm = ext === "ts" || ext === "mjs" ||
    (ext === "js" && JSON.parse(fs.readFileSync("package.json", "utf8")).type === "module");
  const from = JSON.stringify(ext === "ts" ? "./next.config.base" : "./next.config.base." + ext);
  fs.writeFileSync(
    "next.config." + ext,
    "// @ts-nocheck\\n" + (esm
      ? "import base from " + from + ";\\nexport default " + wrap + ";\\n"
      : "const base = require(" + from + ");\\nmodule.exports = " + wrap + ";\\n"),
  );
}
`;

/** Where the build is packed for the trip out of the sandbox. */
const SITE_ARCHIVE = "/tmp/site.tgz";

/**
 * Publish one release: check its commit out into the project's production
 * folder, reinstall dependencies if they changed, build the static export,
 * and hand its files to `site-hosting`, which serves them on the project's
 * hostname. Nothing keeps running in the sandbox afterwards, so the site
 * stays up when the sandbox goes idle.
 *
 * Every command runs in the project's sandbox. Timeouts are seconds, which is
 * Daytona's unit — its own default is ten, which an install or a build would
 * trip over immediately.
 */
const shipToProduction = async (projectId: string, release: ProjectRelease) => {
  const { root, app, production } = await openProject(projectId);

  if (!(await exists(projectId, production))) {
    await runStep(
      "Clone",
      projectId,
      `git clone --quiet ${shellQuote(app)} production`,
      root,
      300,
    );
  }

  const before = (await run(projectId, MANIFEST_HASH, production, 60)).stdout;
  await runStep(
    "Checkout",
    projectId,
    `git fetch --quiet origin ${releaseRef(release.id)} && git checkout --quiet --force ${release.commit} && git clean -fdq -e node_modules -e .next -e out`,
    production,
    300,
  );
  const after = (await run(projectId, MANIFEST_HASH, production, 60)).stdout;

  if (
    before !== after ||
    !(await exists(projectId, `${production}/node_modules`))
  ) {
    await runStep(
      "Install",
      projectId,
      "npm install --no-audit --no-fund",
      production,
      600,
    );
  }

  await runStep(
    "Configure",
    projectId,
    `node -e ${shellQuote(FORCE_STATIC_EXPORT)}`,
    production,
    60,
  );

  // The production copy is a clone, so it has no `.env*` of its own — and must
  // not get one: whatever a static build reads from env ends up in public files.
  await runStep(
    "Build",
    projectId,
    "rm -rf out && npm run build",
    production,
    900,
  );
  if (!(await exists(projectId, `${production}/out/index.html`))) {
    throw new Error(
      "The build produced no static site. A published app cannot use API routes, server actions or middleware.",
    );
  }

  await runStep(
    "Pack",
    projectId,
    `tar -czf ${SITE_ARCHIVE} -C out .`,
    production,
    120,
  );

  // A signed URL and a plain fetch, not the SDK's `downloadFile`: that one is
  // multipart, and its parser does not survive bundling for a Worker.
  const { sandbox } = await openProject(projectId);
  const archive = await fetch(await sandbox.downloadUrl(SITE_ARCHIVE, 600));
  if (!archive.ok) {
    throw new Error(`Could not fetch the build (${archive.status}).`);
  }
  await uploadSite(
    projectId,
    release.id,
    new Uint8Array(await archive.arrayBuffer()),
  );

  // Live from this write on: the serving Worker reads the hostname's release from here.
  await routeHost(siteHost(projectId), projectId, release.id);
};

/**
 * Run a release to completion and record how it ended. The release is already
 * stored as `publishing` and the client polls the project for the outcome; the
 * returned promise never rejects, and is only there so the route can keep its
 * request open — a Worker is stopped once it has answered.
 */
const settleRelease = (
  projectId: string,
  releaseId: string,
  work: Promise<void>,
) =>
  work
    .then(() => updateRelease(projectId, releaseId, { state: "live" }))
    .catch(async (error: unknown) => {
      console.error("Release failed:", error);
      await updateRelease(projectId, releaseId, {
        state: "failed",
        error: error instanceof Error ? error.message : "Publish failed.",
      });
    })
    .catch((error: unknown) => {
      console.error("Could not record the release's outcome:", error);
    });

/**
 * Commit the app's current code and publish it as a new release. Returns once
 * the release is recorded; `settled` resolves when it is live or has failed.
 */
export const publishProject = async (projectId: string, message: string) => {
  assertSiteHosting();
  await readProjectMetadata(projectId);
  const { app } = await openProject(projectId);
  const releaseId = randomUUID();

  // Commit first: the commit is what a later rollback restores.
  await runStep(
    "Commit",
    projectId,
    `git add -A && git ${GIT_IDENTITY} commit --quiet --allow-empty -m ${shellQuote(message)}`,
    app,
    120,
  );
  const commit = (
    await runStep("Commit", projectId, "git rev-parse HEAD", app, 30)
  ).stdout.trim();
  await runStep(
    "Commit",
    projectId,
    `git update-ref ${releaseRef(releaseId)} ${commit}`,
    app,
    30,
  );

  const release: ProjectRelease = {
    id: releaseId,
    message,
    createdAt: new Date().toISOString(),
    commit,
    state: "publishing",
    error: null,
  };
  await addRelease(projectId, release);

  return {
    releaseId,
    settled: settleRelease(
      projectId,
      releaseId,
      shipToProduction(projectId, release),
    ),
  };
};

/**
 * Put production back on an earlier release. Its files are still in the
 * bucket, so this only repoints the hostname — no build, and done in a moment.
 */
export const rollbackToRelease = async (
  projectId: string,
  releaseId: string,
) => {
  assertSiteHosting();
  const metadata = await readProjectMetadata(projectId);
  const release = metadata.releases.find((entry) => entry.id === releaseId);
  if (!release) throw new Error("Release not found.");
  if (
    release.state !== "live" ||
    !(await releaseIsUploaded(projectId, releaseId))
  ) {
    throw new Error("This release was never uploaded. Publish again instead.");
  }

  await routeHost(siteHost(projectId), projectId, releaseId);
  await updateRelease(projectId, releaseId, { state: "live" });
};
