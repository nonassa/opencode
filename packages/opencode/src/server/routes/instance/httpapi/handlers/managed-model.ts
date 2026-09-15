import type { Model } from "@opencode-ai/llm"
import * as AnthropicMessages from "@opencode-ai/llm/protocols/anthropic-messages"
import { OpenAIChat } from "@opencode-ai/llm/protocols/openai-chat"
import * as OpenAICompatibleChat from "@opencode-ai/llm/protocols/openai-compatible-chat"
import { Auth } from "@opencode-ai/llm/route"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"

export type ManagedModelInput = Readonly<{
  providerID: ProviderV2.ID
  modelID: ModelV2.ID
  protocol: "openai-compatible" | "anthropic"
  baseURL: string
  apiKey?: string
}>

const OPENAI_PROVIDER_ID = "OPENAI"

export function managedModelTarget(input: ManagedModelInput): { readonly model: Model; readonly ref: ModelV2.Ref } {
  const endpoint = new URL(input.baseURL)
  if ((endpoint.protocol !== "http:" && endpoint.protocol !== "https:") || endpoint.username || endpoint.password)
    throw new Error("Managed model baseURL must be an HTTP(S) URL without embedded credentials")
  if (input.apiKey !== undefined && input.apiKey.length === 0) throw new Error("Managed model apiKey must not be empty")
  const route = input.protocol === "anthropic"
    ? AnthropicMessages.route
    : input.providerID === OPENAI_PROVIDER_ID
      ? OpenAIChat.route
      : OpenAICompatibleChat.route
  const auth = input.apiKey === undefined
    ? Auth.none
    : input.protocol === "anthropic"
      ? Auth.header("x-api-key", Auth.value(input.apiKey))
      : Auth.bearer(Auth.value(input.apiKey))
  return {
    model: route.with({ provider: input.providerID, endpoint: { baseURL: endpoint.href.replace(/\/$/, "") }, auth }).model({
      id: input.modelID,
    }),
    ref: { providerID: input.providerID, id: input.modelID },
  }
}
