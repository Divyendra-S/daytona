"use client";

import { Suspense, type FC } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useProjectConversations } from "@/lib/project-conversations-context";
import { ProjectHistory } from "./project-history";

/** `useSearchParams` needs a boundary above it, and this is the whole screen. */
export const ProjectWelcome: FC = () => (
  <Suspense fallback={null}>
    <ProjectWelcomeBody />
  </Suspense>
);

const ProjectWelcomeBody: FC = () => {
  const { conversations, onSelectConversation, projectId } =
    useProjectConversations();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const showHistory =
    Boolean(projectId) && searchParams.get("view") === "history";

  const hasConversations = projectId && conversations.length > 0;

  return (
    <div className="aui-thread-welcome-root mx-auto my-auto flex w-full max-w-(--thread-max-width) grow flex-col">
      <div className="aui-thread-welcome-center flex w-full grow flex-col items-center justify-center">
        {!showHistory && (
          <div className="aui-thread-welcome-message flex flex-col items-center justify-center px-4 text-center">
            <h1 className="aui-thread-welcome-message-inner animate-in text-2xl font-semibold tracking-tight duration-300 fade-in slide-in-from-bottom-2 md:text-3xl">
              {""}
            </h1>
          </div>
        )}

        {(hasConversations || showHistory) && (
          <div className="mt-8 w-full max-w-(--thread-max-width) animate-in delay-100 duration-300 fade-in slide-in-from-bottom-2">
            <div className="mb-1.5 flex items-center justify-between px-2.5">
              <p className="text-[12px] font-medium text-ink-3">
                {showHistory ? "Project history" : "Previous conversations"}
              </p>
              <button
                type="button"
                onClick={() =>
                  router.replace(
                    showHistory ? pathname : `${pathname}?view=history`,
                  )
                }
                className="rounded-control px-1.5 py-0.5 text-[12px] text-ink-3 transition-colors duration-100 hover:bg-hover hover:text-ink"
              >
                {showHistory ? "Back" : "History"}
              </button>
            </div>

            {showHistory && projectId ? (
              <ProjectHistory
                projectId={projectId}
                onSelectConversation={onSelectConversation}
              />
            ) : (
              <div className="flex flex-col gap-0.5">
                {conversations.map((conversation) => {
                  const title = conversation.title?.trim();
                  return (
                    <button
                      key={conversation.id}
                      type="button"
                      onClick={() => onSelectConversation(conversation.id)}
                      className="flex h-8 w-full items-center rounded-control px-2.5 text-left text-[13px] text-ink-2 transition-colors duration-100 hover:bg-hover hover:text-ink"
                    >
                      <span className="truncate">
                        {title || "Untitled conversation"}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
