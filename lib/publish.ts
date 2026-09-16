import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  GIT_IDENTITY,
  projectPaths,
  run,
  runStep,
  shellQuote,
} from "./local-project";
import {
  addRelease,
  readProjectMetadata,
  updateRelease,
} from "./project-storage";
import type { ProjectRelease } from "./project-types";
import {
  ensureProductionServer,
  stopProductionServer,
} from "./terminal-bridge";
import { LOCAL_HOST } from "./vars";

/** Each release pins its commit with a ref in the app repo, which production fetches by name. */
const releaseRef = (releaseId: string) =>
  `refs/ai-builder/releases/${releaseId}`;

/** What decides whether production has to reinstall its dependencies. */
const MANIFEST_HASH =
  "cat package.json package-lock.json 2>/dev/null | shasum -a 256";

/**
 * Put one release into the project's production folder: check its commit
 * out, reinstall dependencies if they changed, build, and serve the build on
 * the production port. The running server is stopped for the build, since
 * `next build` rewrites the `.next` it serves from.
 */
const shipToProduction = async (
  projectId: string,
  release: ProjectRelease,
  prodPort: number,
) => {
  const { root, app, production } = projectPaths(projectId);

  if (!existsSync(production)) {
    await runStep(
      "Clone",
      `git clone --quiet ${shellQuote(app)} production`,
      root,
    );
  }

  const before = (await run(MANIFEST_HASH, production)).stdout;
  await runStep(
    "Checkout",
    `git fetch --quiet origin ${releaseRef(release.id)} && git checkout --quiet --force ${release.commit} && git clean -fdq -e node_modules -e .next`,
    production,
  );
  const after = (await run(MANIFEST_HASH, production)).stdout;

  if (before !== after || !existsSync(path.join(production, "node_modules"))) {
    await runStep(
      "Install",
      "npm install --no-audit --no-fund",
      production,
      600_000,
    );
  }

  await stopProductionServer(projectId);
  await runStep("Build", "npm run build", production, 900_000);
  ensureProductionServer(projectId, prodPort);

  // Not live until it actually serves.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const status = await fetch(`http://${LOCAL_HOST}:${prodPort}`, {
      redirect: "manual",
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
  const metadata = await readProjectMetadata(projectId);
  const { app } = projectPaths(projectId);
  const releaseId = randomUUID();

  // Commit first: the commit is what a later rollback restores.
  await runStep(
    "Commit",
    `git add -A && git ${GIT_IDENTITY} commit --quiet --allow-empty -m ${shellQuote(message)}`,
    app,
  );
  const commit = (
    await runStep("Commit", "git rev-parse HEAD", app)
  ).stdout.trim();
  await runStep(
    "Commit",
    `git update-ref ${releaseRef(releaseId)} ${commit}`,
    app,
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

  settleRelease(
    projectId,
    releaseId,
    shipToProduction(projectId, release, metadata.prodPort),
  );

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

  settleRelease(
    projectId,
    releaseId,
    shipToProduction(projectId, release, metadata.prodPort),
  );
};
