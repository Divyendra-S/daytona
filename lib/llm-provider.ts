import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
  generateText,
  hasToolCall,
  stepCountIs,
  streamText,
  type ModelMessage,
  type TextStreamPart,
  type UIMessage,
  type ToolSet,
  convertToModelMessages,
} from "ai";

import { DEFAULT_MODEL, findModel, type ModelId } from "./models";
import type { ProjectUsage } from "./project-types";

type OnUsage = (usage: Omit<ProjectUsage, "since">) => Promise<unknown> | void;

const model = (apiKey?: string, modelId: ModelId = DEFAULT_MODEL) =>
  createOpenRouter({
    apiKey: apiKey ?? process.env["OPENROUTER_API_KEY"],
  }).chat(modelId, {
    reasoning: { effort: "low" },
    // OpenRouter's usage accounting: each response carries its own cost.
    usage: { include: true },
  });

/** What OpenRouter billed for one step, in USD; 0 when it reported nothing. */
const stepCost = (providerMetadata: unknown) =>
  Number(
    (
      providerMetadata as
        | { openrouter?: { usage?: { cost?: number } } }
        | undefined
    )?.openrouter?.usage?.cost,
  ) || 0;

/**
 * Hand one finished call's tokens and cost to `onUsage`.
 *
 * Cost is summed per step, because each step is its own request with its own bill. A failure
 * to record is logged, never thrown: losing a usage count must not fail the user's request.
 */
const reportUsage = async (
  onUsage: OnUsage | undefined,
  steps: { providerMetadata?: unknown }[],
  totalUsage: { inputTokens?: number; outputTokens?: number },
) => {
  if (!onUsage) return;
  try {
    await onUsage({
      inputTokens: totalUsage.inputTokens ?? 0,
      outputTokens: totalUsage.outputTokens ?? 0,
      cost: steps.reduce((sum, step) => sum + stepCost(step.providerMetadata), 0),
      requests: steps.length,
    });
  } catch (error) {
    console.error("[usage] could not record model usage", error);
  }
};

/** What one finished turn took and cost, shown under its assistant message. */
export type TurnUsage = {
  /** Wall time from before the first request to the finish part, tool calls included. */
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  /** USD, summed per step from OpenRouter's usage accounting. */
  cost: number;
  /** Model requests the turn made. */
  requests: number;
  /** The model that actually ran, so the message keeps its own even after the picker moves on. */
  modelId: ModelId;
};

/**
 * A `messageMetadata` callback for `toUIMessageStreamResponse`, which runs it on every stream
 * part: cost and requests add up across `finish-step` parts, and `finish` — the only part
 * carrying `totalUsage` — closes the turn out. Returning undefined anywhere else keeps the
 * stream free of metadata chunks until then.
 *
 * Nested under `custom` because that is the one key assistant-ui carries from a UIMessage's
 * metadata onto the thread message (fromThreadMessageLike drops everything it does not know).
 *
 * Call it before the request starts: the clock runs from the call to the finish part.
 */
export const turnMetadata = (requestedModel: unknown) => {
  const modelId = findModel(requestedModel)?.id ?? DEFAULT_MODEL;
  const startedAt = Date.now();
  let cost = 0;
  let requests = 0;
  return ({
    part,
  }: {
    part: TextStreamPart<ToolSet>;
  }): { custom: { turn: TurnUsage } } | undefined => {
    if (part.type === "finish-step") {
      cost += stepCost(part.providerMetadata);
      requests += 1;
      return undefined;
    }
    if (part.type !== "finish") return undefined;
    return {
      custom: {
        turn: {
          durationMs: Date.now() - startedAt,
          inputTokens: part.totalUsage.inputTokens ?? 0,
          outputTokens: part.totalUsage.outputTokens ?? 0,
          cost,
          requests,
          modelId,
        },
      },
    };
  };
};

/**
 * The conversation, in a shape every provider behind OpenRouter accepts.
 *
 * OpenRouter falls back to another provider when the first is rate-limited, and some of them
 * (Alibaba) reject an assistant message whose `content` is null — which is exactly what the
 * OpenRouter provider sends for a step that only called tools (`content: text || null`). So a
 * text-less assistant step gets a single space of text. A failed or aborted turn also leaves an
 * assistant message with no parts, or tool calls that never finished; those are dropped rather
 * than sent, or the conversation would fail on every message after them.
 */
export const toProviderMessages = async (
  messages: UIMessage[],
): Promise<ModelMessage[]> => {
  const converted = await convertToModelMessages(
    messages.filter((message) => message.parts?.length),
    { ignoreIncompleteToolCalls: true },
  );
  return converted.flatMap((message): ModelMessage[] => {
    if (message.role !== "assistant") return [message];
    if (typeof message.content === "string") {
      return message.content.trim() ? [message] : [];
    }
    if (
      message.content.some((part) => part.type === "text" && part.text.trim())
    ) {
      return [message];
    }
    const rest = message.content.filter((part) => part.type !== "text");
    if (!rest.length) return [];
    return [{ ...message, content: [{ type: "text", text: " " }, ...rest] }];
  });
};

/**
 * A long agent conversation outgrows the model's context: every request resends the whole
 * history, tool output included — file reads, dev-server logs, pasted designs. Estimated at ~3
 * characters a token (code and JSON run denser than prose), the history is kept under budget:
 * first old tool payloads are shortened, then the oldest turns are dropped — never the request
 * being worked on. The newest messages are left alone; they are the work in hand.
 */
// ponytail: character estimate, not a tokenizer; lower the share if a model counts denser.
/** Three quarters of the model's context for history, leaving room for system prompt, tools and reply. */
export const contextChars = (modelId: ModelId) =>
  Math.floor((findModel(modelId)?.contextTokens ?? 262_144) * 0.75) * 3;
const KEEP_RECENT = 8;
const PAYLOAD_PREVIEW = 1_500;

const TRIMMED_NOTE: ModelMessage = {
  role: "user",
  content:
    "[Earlier parts of this conversation were trimmed to fit the model's context window.]",
};

const charsOf = (messages: ModelMessage[]) =>
  messages.reduce(
    (sum, message) => sum + JSON.stringify(message.content).length,
    0,
  );

const preview = (text: string) =>
  text.length > PAYLOAD_PREVIEW
    ? `${text.slice(0, PAYLOAD_PREVIEW)}\n… [${text.length - PAYLOAD_PREVIEW} characters trimmed to fit the context window]`
    : text;

/** A message with its bulky payloads — tool output, tool arguments, reasoning — cut to a preview. */
const trimPayloads = (message: ModelMessage): ModelMessage => {
  if (message.role === "tool") {
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type !== "tool-result") return part;
        if (part.output.type === "text")
          return {
            ...part,
            output: {
              type: "text" as const,
              value: preview(part.output.value),
            },
          };
        if (part.output.type === "json") {
          const text = JSON.stringify(part.output.value);
          return text.length > PAYLOAD_PREVIEW
            ? {
                ...part,
                output: { type: "text" as const, value: preview(text) },
              }
            : part;
        }
        return part;
      }),
    };
  }
  if (message.role === "assistant" && typeof message.content !== "string") {
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type === "reasoning")
          return { ...part, text: preview(part.text) };
        if (part.type === "tool-call") {
          const text = JSON.stringify(part.input);
          return text.length > PAYLOAD_PREVIEW
            ? { ...part, input: { trimmed: preview(text) } }
            : part;
        }
        return part;
      }),
    };
  }
  return message;
};

export const fitContext = (
  messages: ModelMessage[],
  budget = contextChars(DEFAULT_MODEL),
): ModelMessage[] => {
  if (charsOf(messages) <= budget) return messages;

  const recent = Math.max(0, messages.length - KEEP_RECENT);
  let fitted = messages.map((message, index) =>
    index < recent ? trimPayloads(message) : message,
  );

  // Drop the oldest messages, up to the request being worked on. A tool result never outlives
  // the call it answers, or the provider rejects the history.
  let lastUser = fitted.findLastIndex((message) => message.role === "user");
  let dropped = false;
  while (charsOf(fitted) > budget && lastUser > 0) {
    fitted = fitted.slice(1);
    lastUser -= 1;
    dropped = true;
    while (fitted[0]?.role === "tool" && lastUser > 0) {
      fitted = fitted.slice(1);
      lastUser -= 1;
    }
  }

  // The current turn alone is still too big: shorten its older payloads as well.
  if (charsOf(fitted) > budget)
    fitted = fitted.map((message, index) =>
      index < fitted.length - 2 ? trimPayloads(message) : message,
    );

  return dropped ? [TRIMMED_NOTE, ...fitted] : fitted;
};

type StreamLlmResponseParams = {
  system: string;
  messages: UIMessage[];
  tools: ToolSet;
  /** Visitor's own key; falls back to OPENROUTER_API_KEY when omitted. */
  apiKey?: string;
  /** Called once the whole turn has finished, with its tokens and cost. */
  onUsage?: OnUsage;
  /** The conversation's chosen model, as the client sent it; anything off the allowlist runs the default. */
  model?: unknown;
};

export const streamLlmResponse = async ({
  system,
  messages,
  tools,
  apiKey,
  onUsage,
  model: requestedModel,
}: StreamLlmResponseParams) => {
  const modelId = findModel(requestedModel)?.id ?? DEFAULT_MODEL;
  const budget = contextChars(modelId);
  return streamText({
    system,
    model: model(apiKey, modelId),
    messages: fitContext(await toProviderMessages(messages), budget),
    tools,
    // Suggested follow-ups close the answer; another step would write past them.
    stopWhen: [stepCountIs(100), hasToolCall("suggestFollowUpsTool")],
    // A turn grows with every tool call it makes; each step is fitted again before it is sent.
    prepareStep: ({ messages: stepMessages }) => ({
      messages: fitContext(stepMessages, budget),
    }),
    onFinish: ({ steps, totalUsage }) =>
      reportUsage(onUsage, steps, totalUsage),
  });
};

/** One prompt, one reply, no tools — for a single rewrite the caller applies itself. */
export const generateLlmText = async ({
  system,
  prompt,
  apiKey,
  onUsage,
}: {
  system: string;
  prompt: string;
  /** Visitor's own key; falls back to OPENROUTER_API_KEY when omitted. */
  apiKey?: string;
  /** Awaited before returning, so the total is current by the time the caller responds. */
  onUsage?: OnUsage;
}) => {
  const result = await generateText({ system, model: model(apiKey), prompt });
  await reportUsage(onUsage, result.steps, result.totalUsage);
  return result.text;
};
