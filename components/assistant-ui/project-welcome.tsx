"use client";

import { useProjectConversations } from "@/lib/project-conversations-context";
import type { FC } from "react";

export const ProjectWelcome: FC = () => {
  const { conversations, onSelectConversation, projectId } =
    useProjectConversations();

  const hasConversations = projectId && conversations.length > 0;

  return (
    <div className="aui-thread-welcome-root mx-auto my-auto flex w-full max-w-(--thread-max-width) grow flex-col">
      <div className="aui-thread-welcome-center flex w-full grow flex-col items-center justify-center">
        <div className="aui-thread-welcome-message flex flex-col items-center justify-center px-4 text-center">
          <h1 className="aui-thread-welcome-message-inner animate-in text-2xl font-semibold tracking-tight duration-300 fade-in slide-in-from-bottom-2 md:text-3xl">
            {""}
          </h1>
        </div>

        {hasConversations && (
          <div className="mt-8 w-full max-w-(--thread-max-width) animate-in delay-100 duration-300 fade-in slide-in-from-bottom-2">
            <p className="mb-1.5 px-2.5 text-[12px] font-medium text-ink-3">
              Previous conversations
            </p>
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
          </div>
        )}
      </div>
    </div>
  );
};
