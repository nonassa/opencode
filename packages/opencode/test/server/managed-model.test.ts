import { expect, test } from "bun:test"
import { createOpenAI } from "@ai-sdk/openai"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { LLM, LLMClient } from "@opencode-ai/llm"
import { managedModelTarget } from "@/server/routes/instance/httpapi/handlers/managed-model"
import { Effect } from "effect"
import { it } from "../lib/effect"

it.effect("selects OpenAI request semantics only for the canonical OpenAI provider", () =>
  Effect.gen(function* () {
    const openai = managedModelTarget({
      providerID: ProviderV2.ID.make("OPENAI"),
      modelID: ModelV2.ID.make("gpt-5.4-mini"),
      protocol: "openai-compatible",
      baseURL: "https://api.openai.com/v1",
      apiKey: "test-key",
    })
    const compatible = managedModelTarget({
      providerID: ProviderV2.ID.make("OPENROUTER"),
      modelID: ModelV2.ID.make("openai/gpt-5.4-mini"),
      protocol: "openai-compatible",
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: "test-key",
    })

    const openaiPrepared = yield* LLMClient.prepare(LLM.request({
      model: openai.model,
      prompt: "test",
      generation: { maxTokens: 64 },
    }))
    const compatiblePrepared = yield* LLMClient.prepare(LLM.request({
      model: compatible.model,
      prompt: "test",
      generation: { maxTokens: 64 },
    }))

    expect(openaiPrepared.body).toMatchObject({ max_completion_tokens: 64 })
    expect(openaiPrepared.body).not.toHaveProperty("max_tokens")
    expect(compatiblePrepared.body).toMatchObject({ max_tokens: 64 })
    expect(compatiblePrepared.body).not.toHaveProperty("max_completion_tokens")
  }),
)

test("serializes the integrated launch model through the OpenAI SDK without max_tokens", async () => {
  let requested = false
  const sdk = createOpenAI({
    name: "stratcraft-integrated",
    baseURL: "https://api.openai.test/v1",
    apiKey: "test-key",
    fetch: Object.assign(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        requested = true
        expect(input instanceof Request ? input.url : input.toString()).toBe("https://api.openai.test/v1/responses")
        if (typeof init?.body !== "string") throw new Error("Expected a serialized OpenAI request body")
        const body = JSON.parse(init.body)
        expect(body).toMatchObject({
          model: "gpt-5.4-mini",
          max_output_tokens: 64,
        })
        expect(body).not.toHaveProperty("max_tokens")
        return Response.json({ error: { message: "synthetic stop", type: "test_error" } }, { status: 400 })
      },
      { preconnect: fetch.preconnect },
    ),
  })

  const failure = await sdk
    .languageModel("gpt-5.4-mini")
    .doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "test" }] }],
      maxOutputTokens: 64,
    })
    .then(
      () => undefined,
      (reason: unknown) => reason,
    )
  if (!(failure instanceof Error)) throw new Error("Expected the synthetic OpenAI request to fail")
  expect(failure.message).toContain("synthetic stop")
  expect(requested).toBe(true)
})
