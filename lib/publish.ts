import { randomUUID } from "node:crypto";
import { GIT_IDENTITY, run, runStep, shellQuote } from "./project-runtime";
import {
  addRelease,
  readProjectMetadata,
  updateRelease,
} from "./project-storage";
import type { ProjectRelease } from "./project-types";
import { openProject, previewOrigin } from "./sandbox";
import {
  ensureProductionServer,
  stopProductionServer,
} from "./terminal-bridge";
import { PREVIEW_TOKEN_HEADER, SANDBOX_PROD_PORT } from "./vars";

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
 * Put one release into the project's production folder: check its commit
 * out, reinstall dependencies if they changed, build, and serve the build on
 * the production port. The running server is stopped for the build, since
 * `next build` rewrites the `.next` it serves from.
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
    `git fetch --quiet origin ${releaseRef(release.id)} && git checkout --quiet --force ${release.commit} && git clean -fdq -e node_modules -e .next`,
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

  await stopProductionServer(projectId);
  await runStep("Build", projectId, "npm run build", production, 900);
  await ensureProductionServer(projectId);

  // Not live until it actually serves.
  const { url, token } = await previewOrigin(projectId, SANDBOX_PROD_PORT);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const status = await fetch(url, {
      redirect: "manual",
      headers: { [PREVIEW_TOKEN_HEADER]: token },
      signal: AbortSignal.timeout(10_000),
    }).then(
      (response) => response.status,
      () => null,
    );
    if (status !== null && status >= 200 && status < 400) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Production server never responded.");
};

/**
 * Run a release to completion in the background and record how it ended. The
 * build takes a while, so nothing waits on this: the release is already stored
 * as `publishing` and the client polls the project for the outcome.
 */
const settleRelease = (
  projectId: string,
  releaseId: string,
  work: Promise<void>,
) => {
  void work
    .then(() => updateRelease(projectId, releaseId, { state: "live" }))
    .catch(async (error: unknown) => {
      console.error("Release failed:", error);
      await updateRelease(projectId, releaseId, {
        state: "failed",
        error: error instanceof Error ? error.message : "Publish failed.",
      });
    });
};

/** Commit the app's current code and build it into production, as a new release. */
export const publishProject = async (projectId: string, message: string) => {
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

  settleRelease(projectId, releaseId, shipToProduction(projectId, release));

  return releaseId;
};

/** Put production back on an earlier release, by building its commit again. */
export const rollbackToRelease = async (
  projectId: string,
  releaseId: string,
) => {
  const metadata = await readProjectMetadata(projectId);
  const release = metadata.releases.find((entry) => entry.id === releaseId);
  if (!release) throw new Error("Release not found.");

  await updateRelease(projectId, releaseId, {
    state: "publishing",
    error: null,
  });

  settleRelease(projectId, releaseId, shipToProduction(projectId, release));
};
