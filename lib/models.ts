/**
 * The models a conversation can run on: OpenRouter ids that support tool calls, checked against
 * https://openrouter.ai/api/v1/models. The composer's picker lists them and the chat route accepts
 * nothing else. `contextTokens` is the top provider's context length there; the history budget
 * in lib/llm-provider.ts follows it. Kept free of imports so the client can load it.
 */
export const MODELS = [
  {
    id: "qwen/qwen3.8-flash",
    name: "Qwen3.8 Flash",
    tag: "Default",
    // Listed at 1,000,000, but its provider (Alibaba) has rejected requests over 262,144 tokens
    // ("The input … is longer than the model's context length (262144 tokens)"); budget to that.
    contextTokens: 262_144,
  },
  {
    id: "anthropic/claude-sonnet-5",
    name: "Claude Sonnet 5",
    tag: "Anthropic",
    contextTokens: 1_000_000,
  },
  {
    id: "openai/gpt-5.5",
    name: "GPT-5.5",
    tag: "OpenAI",
    contextTokens: 1_050_000,
  },
  {
    id: "google/gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    tag: "Google",
    contextTokens: 1_048_576,
  },
  {
    id: "google/gemini-3.5-flash-lite",
    name: "Gemini 3.5 Flash Lite",
    tag: "Google",
    contextTokens: 1_048_576,
  },
  {
    id: "deepseek/deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    tag: "DeepSeek",
    contextTokens: 1_024_000,
  },
  {
    id: "moonshotai/kimi-k3",
    name: "Kimi K3",
    tag: "Moonshot",
    contextTokens: 1_048_576,
  },
] as const;

export type ModelOption = (typeof MODELS)[number];
export type ModelId = ModelOption["id"];

export const DEFAULT_MODEL: ModelId = "qwen/qwen3.8-flash";

/** The allowlisted model with this id, if it is one. */
export const findModel = (id: unknown): ModelOption | undefined =>
  MODELS.find((model) => model.id === id);
