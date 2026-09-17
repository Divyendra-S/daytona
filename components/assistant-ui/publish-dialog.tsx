"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  ExternalLinkIcon,
  Loader2Icon,
  RocketIcon,
  RotateCcwIcon,
} from "lucide-react";
import { CustomDomains } from "@/components/assistant-ui/custom-domains";
import type { ProjectItem, ProjectRelease } from "@/lib/project-types";

const formatRelativeTime = (dateString: string) => {
  const diffSeconds = Math.floor(
    (Date.now() - new Date(dateString).getTime()) / 1000,
  );
  if (diffSeconds < 60) return "just now";
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
};

const ReleaseState = ({
  release,
  isLive,
}: {
  release: ProjectRelease;
  isLive: boolean;
}) => {
  if (release.state === "publishing") {
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <Loader2Icon className="size-3 animate-spin" />
        Building
      </span>
    );
  }

  if (release.state === "failed") {
    return (
      <span className="flex items-center gap-1 text-xs text-destructive">
        <AlertCircleIcon className="size-3" />
        Failed
      </span>
    );
  }

  // A built release stays built after it is superseded; only one is serving.
  if (!isLive) {
    return <span className="text-xs text-muted-foreground">Built</span>;
  }

  return (
    <span className="flex items-center gap-1 text-xs text-emerald-500">
      <CheckCircle2Icon className="size-3" />
      Live
    </span>
  );
};

/**
 * Publishing commits the current code, builds it as a static site and serves
 * it on the project's own hostname. Every release keeps its files, so
 * production can be rolled back to any of them.
 */
export function PublishDialog({
  project,
  onPublish,
  onRollback,
}: {
  project: ProjectItem;
  onPublish: (
    projectId: string,
    message: string,
    subdomain: string,
  ) => Promise<void>;
  onRollback: (projectId: string, releaseId: string) => Promise<void>;
}) {
  const [message, setMessage] = React.useState("");
  const [subdomain, setSubdomain] = React.useState(project.subdomain);
  const [isPublishing, setIsPublishing] = React.useState(false);
  const [publishError, setPublishError] = React.useState<string | null>(null);
  const [rollingBackId, setRollingBackId] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState(false);

  // The composer's /publish opens this dialog.
  React.useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener("ai-builder:open-publish", onOpen);
    return () => window.removeEventListener("ai-builder:open-publish", onOpen);
  }, []);

  // Another project, or a publish that settled on a different name.
  React.useEffect(() => {
    setSubdomain(project.subdomain);
  }, [project.id, project.subdomain]);

  const releases = project.releases;
  const isBuilding = releases.some((release) => release.state === "publishing");
  const productionHost = (() => {
    try {
      return new URL(project.productionUrl).host;
    } catch {
      // Nothing published yet, so there is no production URL to show.
      return "";
    }
  })();

  // Everything after the project's own label: the domain all sites share.
  const sitesDomain = productionHost.split(".").slice(1).join(".");

  const publish = async () => {
    setIsPublishing(true);
    setPublishError(null);
    try {
      await onPublish(
        project.id,
        message.trim() || "Publish",
        subdomain.trim().toLowerCase() || project.subdomain,
      );
      setMessage("");
    } catch (error) {
      setPublishError(
        error instanceof Error ? error.message : "Failed to publish",
      );
    } finally {
      setIsPublishing(false);
    }
  };

  const rollback = async (releaseId: string) => {
    setRollingBackId(releaseId);
    setPublishError(null);
    try {
      await onRollback(project.id, releaseId);
    } catch (error) {
      setPublishError(
        error instanceof Error ? error.message : "Failed to roll back",
      );
    } finally {
      setRollingBackId(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background transition-colors hover:bg-foreground/90"
        >
          {isBuilding ? (
            <Loader2Icon className="size-3 animate-spin" />
          ) : (
            <RocketIcon className="size-3" />
          )}
          Publish
        </button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Publish</DialogTitle>
          <DialogDescription>
            Commits the current code, builds it, and puts the build live on the
            address below.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {/* Production address */}
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">
              Production
            </p>
            {sitesDomain && (
              <div className="flex items-center rounded-md border focus-within:ring-1 focus-within:ring-ring">
                <input
                  value={subdomain}
                  onChange={(event) =>
                    setSubdomain(
                      event.target.value
                        .toLowerCase()
                        .replace(/[^a-z0-9-]/g, ""),
                    )
                  }
                  maxLength={63}
                  spellCheck={false}
                  aria-label="Subdomain"
                  placeholder="your-site"
                  disabled={isPublishing || isBuilding}
                  className="min-w-0 flex-1 bg-transparent px-3 py-2 text-sm outline-none disabled:opacity-60"
                />
                <span className="shrink-0 pr-3 text-sm text-muted-foreground">
                  .{sitesDomain}
                </span>
              </div>
            )}
            <div className="flex items-center gap-2 rounded-md border px-3 py-2">
              {project.liveReleaseId ? (
                <a
                  href={project.productionUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-sm hover:underline"
                >
                  <span className="truncate">{productionHost}</span>
                  <ExternalLinkIcon className="size-3 shrink-0 text-muted-foreground" />
                </a>
              ) : (
                <span className="truncate text-sm text-muted-foreground">
                  {productionHost} · not published yet
                </span>
              )}
            </div>
          </div>

          <CustomDomains projectId={project.id} open={open} />

          {/* New release */}
          <div className="space-y-2">
            <Input
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="What changed in this release?"
              onKeyDown={(event) => {
                if (event.key === "Enter" && !isPublishing) void publish();
              }}
            />
            {publishError && (
              <p className="text-xs text-destructive">{publishError}</p>
            )}
            <Button
              className="w-full"
              onClick={publish}
              disabled={isPublishing || isBuilding}
            >
              {isPublishing || isBuilding ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                <RocketIcon className="size-3.5" />
              )}
              {isBuilding ? "Building…" : "Publish to production"}
            </Button>
          </div>

          {/* History */}
          {releases.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">
                Releases
              </p>
              <div className="max-h-56 divide-y divide-border/50 overflow-y-auto rounded-md border">
                {releases.map((release) => {
                  const isLive = release.id === project.liveReleaseId;
                  return (
                    <div
                      key={release.id}
                      className="flex items-center gap-3 px-3 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm">{release.message}</p>
                        <p className="text-xs text-muted-foreground">
                          {formatRelativeTime(release.createdAt)}
                        </p>
                        {release.error && (
                          <p className="mt-0.5 truncate text-xs text-destructive">
                            {release.error}
                          </p>
                        )}
                      </div>

                      <ReleaseState release={release} isLive={isLive} />

                      {!isLive && release.state !== "publishing" && (
                        <button
                          type="button"
                          onClick={() => void rollback(release.id)}
                          disabled={rollingBackId === release.id}
                          className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                          title="Roll production back to this release"
                        >
                          {rollingBackId === release.id ? (
                            <Loader2Icon className="size-3 animate-spin" />
                          ) : (
                            <RotateCcwIcon className="size-3" />
                          )}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
