"use client";

import type { FC } from "react";
import { CheckCircle2Icon, CircleDashedIcon, XCircleIcon } from "lucide-react";
import { useProjects } from "@/lib/projects-context";
import type { ProjectItem, ProjectRelease } from "@/lib/project-types";

const dateTime = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

const count = (value: number) => value.toLocaleString();

/** Costs are fractions of a cent early on, and dollars later. */
const cost = (value: number) =>
  `$${value < 1 ? value.toFixed(4) : value.toFixed(2)}`;

const RELEASE_ICON: Record<
  ProjectRelease["state"],
  FC<{ className?: string }>
> = {
  live: CheckCircle2Icon,
  publishing: CircleDashedIcon,
  failed: XCircleIcon,
};

const Stat: FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="rounded-card bg-hover px-3 py-2">
    <p className="text-[11px] text-ink-3">{label}</p>
    <p className="mt-0.5 text-[15px] text-ink tabular-nums">{value}</p>
  </div>
);

const Section: FC<{ title: string; children: React.ReactNode }> = ({
  title,
  children,
}) => (
  <div className="mt-6">
    <p className="mb-1.5 px-2.5 text-[12px] font-medium text-ink-3">{title}</p>
    {children}
  </div>
);

const Empty: FC<{ children: string }> = ({ children }) => (
  <p className="px-2.5 py-1.5 text-[13px] text-ink-3">{children}</p>
);

/** Everything a project has done: what it cost, what shipped, what was said. */
export const ProjectHistory: FC<{
  projectId: string;
  onSelectConversation: (conversationId: string) => void;
}> = ({ projectId, onSelectConversation }) => {
  const { projects, isLoading } = useProjects();
  const project: ProjectItem | undefined = projects.find(
    (item) => item.id === projectId,
  );

  if (!project) {
    return (
      <Empty>{isLoading ? "Loading history…" : "This project is gone."}</Empty>
    );
  }

  const { usage, releases, conversations } = project;

  return (
    <div className="w-full">
      <div className="grid grid-cols-2 gap-1.5 md:grid-cols-4">
        <Stat label="Model requests" value={count(usage.requests)} />
        <Stat label="Input tokens" value={count(usage.inputTokens)} />
        <Stat label="Output tokens" value={count(usage.outputTokens)} />
        <Stat label="Cost" value={cost(usage.cost)} />
      </div>
      {usage.since && (
        <p className="mt-1.5 px-2.5 text-[11px] text-ink-3">
          Counted since {dateTime(usage.since)}
        </p>
      )}

      <Section title="Releases">
        {releases.length === 0 ? (
          <Empty>Nothing published yet.</Empty>
        ) : (
          <div className="flex flex-col gap-0.5">
            {releases.map((release) => {
              const Icon = RELEASE_ICON[release.state];
              const isLive = release.id === project.liveReleaseId;
              return (
                <div
                  key={release.id}
                  className="flex items-start gap-2 rounded-control px-2.5 py-1.5 text-[13px]"
                >
                  <Icon
                    className={
                      release.state === "failed"
                        ? "mt-0.5 size-3.5 shrink-0 text-red-400"
                        : "mt-0.5 size-3.5 shrink-0 text-ink-3"
                    }
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-ink-2">
                      {release.message || "Untitled release"}
                      {isLive && (
                        <span className="ml-2 text-[11px] text-ink-3">
                          live
                        </span>
                      )}
                    </p>
                    <p className="text-[11px] text-ink-3">
                      {dateTime(release.createdAt)} ·{" "}
                      {release.commit.slice(0, 7)}
                      {release.error ? ` · ${release.error}` : ""}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      <Section title="Conversations">
        {conversations.length === 0 ? (
          <Empty>No conversations yet.</Empty>
        ) : (
          <div className="flex flex-col gap-0.5">
            {conversations.map((conversation) => (
              <button
                key={conversation.id}
                type="button"
                onClick={() => onSelectConversation(conversation.id)}
                className="flex flex-col items-start rounded-control px-2.5 py-1.5 text-left transition-colors duration-100 hover:bg-hover"
              >
                <span className="w-full truncate text-[13px] text-ink-2">
                  {conversation.title?.trim() || "Untitled conversation"}
                </span>
                <span className="text-[11px] text-ink-3">
                  Last worked on {dateTime(conversation.updatedAt)}
                </span>
              </button>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
};
