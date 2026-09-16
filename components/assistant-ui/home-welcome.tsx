"use client";

import { Button } from "@/components/atoms/Button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useProjects } from "@/lib/projects-context";
import type { ProjectItem } from "@/lib/project-types";
import { type FC, useState } from "react";
import { useRouter } from "next/navigation";
import { GithubIcon } from "lucide-react";

/**
 * What a visitor would see, for the card thumbnail: the published app.
 *
 * Only published projects get a live frame. Every project's sandbox sleeps when
 * it goes idle, and framing a dev preview here would wake every sandbox at once
 * just to draw the home screen — which is exactly what the idle timer exists to
 * avoid. An unpublished project shows a placeholder until it is opened.
 */
function getPreviewUrl(project: ProjectItem): string | null {
  if (project.liveReleaseId) return project.productionUrl || null;
  return null;
}

export const HomeWelcome: FC = () => {
  const { projects, isLoading, onSelectProject } = useProjects();
  const router = useRouter();
  const [githubDialogOpen, setGithubDialogOpen] = useState(false);
  const [githubRepoInput, setGithubRepoInput] = useState("");
  const [githubRepoError, setGithubRepoError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const handleUseGithubRepo = () => {
    const githubRepoName = githubRepoInput.trim();
    if (!githubRepoName.includes("/")) {
      setGithubRepoError("Repository must be in owner/repo format");
      return;
    }

    setGithubRepoError(null);
    window.dispatchEvent(
      new CustomEvent("ai-builder:create-from-github", {
        detail: { githubRepoName },
      }),
    );
    setGithubDialogOpen(false);
    setGithubRepoInput("");
  };

  /**
   * Delete a project, sandbox and all. Confirmed first because none of it comes
   * back: the code lives in the sandbox, and the conversations in its rows.
   */
  const handleDelete = async (project: ProjectItem) => {
    if (deletingId) return;
    if (
      !window.confirm(
        `Delete “${project.name}”? Its sandbox, the code inside it and its conversations go too, and this cannot be undone.`,
      )
    ) {
      return;
    }

    setDeletingId(project.id);
    try {
      const response = await fetch(`/api/projects/${project.id}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const failure = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(failure?.error ?? `Request failed (${response.status})`);
      }
      window.dispatchEvent(new Event("ai-builder:projects-updated"));
    } catch (error) {
      window.alert(
        `Could not delete the project: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    } finally {
      setDeletingId(null);
    }
  };

  const hasProjects = projects.length > 0;
  const showProjects = isLoading || hasProjects;

  return (
    <div className="aui-thread-welcome-root mx-auto flex w-full max-w-(--thread-max-width) grow flex-col items-center justify-center">
      <div className="flex w-full flex-col gap-8 px-2">
        {/* Hero */}
        <div className="flex animate-in flex-col items-center gap-2 pt-8 text-center duration-500 fill-mode-both fade-in">
          <svg
            viewBox="0 0 347 280"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className="mb-2 h-10 w-auto"
          >
            <path
              d="M70 267V235.793C37.4932 229.296 13 200.594 13 166.177C13 134.93 33.1885 108.399 61.2324 98.9148C61.9277 51.3467 100.705 13 148.438 13C183.979 13 214.554 34.2582 228.143 64.7527C234.182 63.4301 240.454 62.733 246.89 62.733C295.058 62.733 334.105 101.781 334.105 149.949C334.105 182.845 315.893 211.488 289 226.343V267"
              className="stroke-foreground/15"
              strokeWidth="25"
              strokeLinecap="round"
            />
            <path
              d="M146 237V267"
              className="stroke-foreground/15"
              strokeWidth="25"
              strokeLinecap="round"
            />
            <path
              d="M215 237V267"
              className="stroke-foreground/15"
              strokeWidth="25"
              strokeLinecap="round"
            />
          </svg>
          <h1 className="text-[26px] font-semibold tracking-tight text-ink">
            What do you want to build?
          </h1>
          <p className="text-[13px] text-ink-3">
            Describe an app or pick up where you left off
          </p>
        </div>

        {/* Project cards with previews */}
        <div
          className={cn(
            "flex w-full flex-col gap-3 transition-opacity duration-500",
            showProjects ? "opacity-100" : "opacity-0",
          )}
        >
          {isLoading ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="overflow-hidden rounded-card bg-surface shadow-card"
                >
                  <Skeleton className="aspect-16/10 w-full" />
                  <div className="px-3 py-2.5">
                    <Skeleton className="mb-1.5 h-3.5 w-3/4 rounded" />
                    <Skeleton className="h-2.5 w-1/2 rounded" />
                  </div>
                </div>
              ))}
            </div>
          ) : hasProjects ? (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {projects.map((project, index) => {
                  const previewUrl = getPreviewUrl(project);
                  return (
                    <button
                      key={project.id}
                      type="button"
                      onClick={() => onSelectProject(project.id)}
                      className="group animate-in overflow-hidden rounded-card bg-surface text-left shadow-card transition-shadow duration-200 fill-mode-both fade-in hover:shadow-raised"
                      style={
                        {
                          "--tw-animation-delay": `${index * 75}ms`,
                          "--tw-animation-duration": "400ms",
                        } as React.CSSProperties
                      }
                    >
                      {/* Preview thumbnail */}
                      <div className="relative aspect-16/10 w-full overflow-hidden border-b border-line bg-inset">
                        {previewUrl ? (
                          <iframe
                            src={previewUrl}
                            title={`${project.name} preview`}
                            className="pointer-events-none absolute inset-0 h-[200%] w-[200%] origin-top-left scale-50 border-0"
                            tabIndex={-1}
                            loading="lazy"
                            sandbox="allow-scripts allow-same-origin"
                          />
                        ) : (
                          <div className="flex h-full items-center justify-center">
                            <span className="text-[12px] text-ink-3">
                              No preview
                            </span>
                          </div>
                        )}
                        {/* Status dot */}
                        <div className="absolute top-2 right-2">
                          <div
                            className={cn(
                              "h-2 w-2 rounded-full ring-2 ring-surface",
                              project.liveReleaseId
                                ? "bg-green"
                                : project.releases.some(
                                      (release) =>
                                        release.state === "publishing",
                                    )
                                  ? "bg-orange"
                                  : "bg-ink-3",
                            )}
                          />
                        </div>
                      </div>
                      {/* Info */}
                      <div className="px-3 py-2.5">
                        <p className="truncate text-[13px] font-medium text-ink">
                          {project.name}
                        </p>
                        <p className="mt-0.5 text-[12px] text-ink-3 tabular-nums">
                          {project.conversations.length} chat
                          {project.conversations.length !== 1 ? "s" : ""}
                          {project.releases.length > 0 && (
                            <>
                              {" · "}
                              {project.releases.length} release
                              {project.releases.length !== 1 ? "s" : ""}
                            </>
                          )}
                        </p>
                        {/* A span, not a button: this card is itself a button. */}
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={(event) => {
                            event.stopPropagation();
                            router.push(`/${project.id}?view=history`);
                          }}
                          onKeyDown={(event) => {
                            if (event.key !== "Enter" && event.key !== " ")
                              return;
                            event.stopPropagation();
                            event.preventDefault();
                            router.push(`/${project.id}?view=history`);
                          }}
                          className="mt-1 -ml-1 inline-flex cursor-pointer rounded-control px-1 py-0.5 text-[12px] text-ink-3 transition-colors hover:bg-hover hover:text-ink"
                        >
                          History
                        </span>
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleDelete(project);
                          }}
                          onKeyDown={(event) => {
                            if (event.key !== "Enter" && event.key !== " ")
                              return;
                            event.stopPropagation();
                            event.preventDefault();
                            void handleDelete(project);
                          }}
                          aria-disabled={deletingId === project.id}
                          className="mt-1 ml-1 inline-flex cursor-pointer rounded-control px-1 py-0.5 text-[12px] text-ink-3 transition-colors hover:bg-hover hover:text-red aria-disabled:pointer-events-none aria-disabled:opacity-50"
                        >
                          {deletingId === project.id ? "Deleting…" : "Delete"}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
              {/* Import from GitHub — subtle link below the grid */}
              <button
                type="button"
                onClick={() => setGithubDialogOpen(true)}
                className="mx-auto flex animate-in items-center gap-2 rounded-full px-3 py-1.5 text-[12px] text-ink-3 transition-colors fill-mode-both fade-in hover:bg-hover hover:text-ink-2"
                style={
                  {
                    "--tw-animation-delay": `${projects.length * 75}ms`,
                    "--tw-animation-duration": "400ms",
                  } as React.CSSProperties
                }
              >
                <GithubIcon className="h-3 w-3" />
                Import from GitHub
              </button>
            </>
          ) : null}
        </div>
      </div>

      <Dialog open={githubDialogOpen} onOpenChange={setGithubDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Use GitHub Project</DialogTitle>
            <DialogDescription>
              Enter a public repository in owner/repo format.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              value={githubRepoInput}
              onChange={(event) => {
                setGithubRepoInput(event.target.value);
                setGithubRepoError(null);
              }}
              placeholder="owner/repo"
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  handleUseGithubRepo();
                }
              }}
            />
            {githubRepoError && (
              <p className="text-[13px] text-red">{githubRepoError}</p>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="quiet"
              size="sm"
              onClick={() => setGithubDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={handleUseGithubRepo}
            >
              Create Project
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
