import { type UIMessage } from "ai";
import { cookies } from "next/headers";
import { createTools } from "@/lib/create-tools";
import { streamLlmResponse, turnMetadata } from "@/lib/llm-provider";
import { authorizeProject } from "@/lib/project-access";
import { touchProject } from "@/lib/sandbox";
import { addUsage, saveConversationMessages } from "@/lib/project-storage";
import { systemPrompt } from "@/lib/system-prompt";

export async function POST(req: Request) {
  const payload = (await req.json()) as {
    messages?: UIMessage[];
    projectId?: string;
    conversationId?: string;
    /** The model picked in the composer; streamLlmResponse only runs allowlisted ones. */
    model?: unknown;
  };

  const { projectId, conversationId } = payload;
  const messages = payload.messages;

  if (!projectId || !conversationId) {
    return Response.json(
      { error: "projectId and conversationId are required." },
      { status: 400 },
    );
  }

  if (!Array.isArray(messages)) {
    return Response.json(
      { error: "messages must be an array." },
      { status: 400 },
    );
  }

  const metadata = await authorizeProject(projectId);
  if (!metadata) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  await saveConversationMessages(projectId, conversationId, messages);

  // A turn can run for minutes without touching the sandbox; tell Daytona the
  // project is in use so its idle timer does not stop it mid-answer.
  void touchProject(projectId);

  const jar = await cookies();
  const userApiKey = jar.get("user-api-key")?.value;

  const hasGlobalKey = !!process.env["OPENROUTER_API_KEY"];

  if (!hasGlobalKey && !userApiKey) {
    return Response.json(
      { error: "No API key configured. Please add your API key in settings." },
      { status: 401 },
    );
  }

  // Started before the first request, so the message's own time covers the whole turn.
  const messageMetadata = turnMetadata(payload.model);

  const result = await streamLlmResponse({
    system: systemPrompt(),
    messages,
    tools: createTools(projectId),
    // Only fall back to the visitor's own key when the server has none.
    apiKey: hasGlobalKey ? undefined : userApiKey,
    onUsage: (usage) => addUsage(projectId, usage),
    model: payload.model,
  });

  return result.toUIMessageStreamResponse({
    sendReasoning: true,
    originalMessages: messages,
    generateMessageId: () => crypto.randomUUID(),
    // Per-message time, tokens and cost; the saved messages keep it, so a reload still shows it.
    messageMetadata,
    onFinish: async ({ messages: finalMessages }) => {
      await saveConversationMessages(projectId, conversationId, finalMessages);
    },
  });
}
