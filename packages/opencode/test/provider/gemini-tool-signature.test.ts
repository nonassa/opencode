import { describe, expect, test } from "bun:test"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import type { LanguageModelV3Prompt } from "@ai-sdk/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { MessageV2 } from "@/session/message-v2"
import { ProviderTransform } from "@/provider/transform"
import type { Provider } from "@/provider/provider"
import { MessageID, PartID, SessionID } from "@/session/schema"

const sessionID = SessionID.make("session-gemini-signature")
const providerID = ProviderV2.ID.make("stratcraft-integrated")

const geminiModel: Provider.Model = {
  id: ModelV2.ID.make("gemini-3.5-flash-lite"),
  providerID,
  api: {
    id: "gemini-3.5-flash-lite",
    url: "https://generativelanguage.googleapis.com/v1beta/openai",
    npm: "@ai-sdk/openai-compatible",
  },
  name: "Gemini 3.5 Flash Lite",
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 1_000_000, input: 1_000_000, output: 65_536 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-09-01",
}

function basePart(messageID: string, id: string) {
  return {
    id: PartID.make(`prt_${id}`),
    sessionID,
    messageID: MessageID.make(`msg_${messageID}`),
  }
}

function restoredHistory(
  toolMetadata: Array<Record<string, Record<string, unknown>> | undefined>,
): SessionV1.WithParts[] {
  const userID = "user"
  const assistantID = "assistant"
  return [
    {
      info: {
        id: MessageID.make(`msg_${userID}`),
        sessionID,
        role: "user",
        time: { created: 0 },
        agent: "user",
        model: { providerID, modelID: geminiModel.id },
        tools: {},
        mode: "",
      } as unknown as SessionV1.User,
      parts: [{ ...basePart(userID, "user-text"), type: "text", text: "Use the tools" }] as SessionV1.Part[],
    },
    {
      info: {
        id: MessageID.make(`msg_${assistantID}`),
        sessionID,
        role: "assistant",
        time: { created: 0 },
        parentID: MessageID.make(`msg_${userID}`),
        modelID: geminiModel.id,
        providerID,
        mode: "",
        agent: "build",
        path: { cwd: "/workspace", root: "/workspace" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      } as unknown as SessionV1.Assistant,
      parts: [
        {
          ...basePart(assistantID, "successful-tool"),
          type: "tool",
          callID: "call-success",
          tool: "read",
          state: {
            status: "completed",
            input: { path: "README.md" },
            output: "contents",
            title: "Read",
            metadata: {},
            time: { start: 1, end: 2 },
          },
          metadata: toolMetadata[0],
        },
        {
          ...basePart(assistantID, "failed-tool"),
          type: "tool",
          callID: "call-failure",
          tool: "skill",
          state: {
            status: "error",
            input: { name: "missing-skill" },
            error: "Skill not found",
            metadata: {},
            time: { start: 3, end: 4 },
          },
          metadata: toolMetadata[1],
        },
        {
          ...basePart(assistantID, "unsigned-tool"),
          type: "tool",
          callID: "call-unsigned",
          tool: "read",
          state: {
            status: "completed",
            input: { path: "package.json" },
            output: "{}",
            title: "Read",
            metadata: {},
            time: { start: 5, end: 6 },
          },
        },
      ] as SessionV1.Part[],
    },
  ]
}

async function receiveToolCallMetadata() {
  const sdk = createOpenAICompatible({
    name: providerID,
    baseURL: geminiModel.api.url,
    apiKey: "synthetic-api-key",
    fetch: (async () =>
      new Response(
        JSON.stringify({
          id: "tool-response-id",
          created: 0,
          model: geminiModel.api.id,
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call-success",
                    type: "function",
                    function: { name: "read", arguments: '{"path":"README.md"}' },
                    extra_content: { google: { thought_signature: "synthetic-signature-success" } },
                  },
                  {
                    id: "call-failure",
                    type: "function",
                    function: { name: "skill", arguments: '{"name":"missing-skill"}' },
                    extra_content: { google: { thought_signature: "synthetic-signature-failure" } },
                  },
                  {
                    id: "call-unsigned",
                    type: "function",
                    function: { name: "read", arguments: '{"path":"package.json"}' },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch,
  })
  const response = await sdk.chatModel(geminiModel.api.id).doGenerate({
    prompt: [{ role: "user", content: [{ type: "text", text: "Use the tools" }] }],
  })
  return response.content
    .filter((part) => part.type === "tool-call")
    .map((part) => part.providerMetadata as Record<string, Record<string, unknown>> | undefined)
}

async function serializeRestoredHistory(model: Provider.Model) {
  let requestBody: Record<string, any> | undefined
  const sdk = createOpenAICompatible({
    name: providerID,
    baseURL: geminiModel.api.url,
    apiKey: "synthetic-api-key",
    fetch: (async (_url, init) => {
      requestBody = JSON.parse(String(init?.body))
      return new Response(
        JSON.stringify({
          id: "response-id",
          created: 0,
          model: model.api.id,
          choices: [{ message: { role: "assistant", content: "continued" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }) as typeof fetch,
  })
  const toolMetadata = await receiveToolCallMetadata()
  const restored = await MessageV2.toModelMessages(restoredHistory(toolMetadata), model)
  const prompt = ProviderTransform.message(restored, model, {})
  await sdk.chatModel(model.api.id).doGenerate({ prompt: prompt as LanguageModelV3Prompt })
  return { prompt, requestBody }
}

describe("integrated Gemini tool signature continuation", () => {
  test("serializes each restored signed tool call with its exact matching signature", async () => {
    const { prompt, requestBody } = await serializeRestoredHistory(geminiModel)
    const toolCalls = requestBody?.messages[1].tool_calls

    expect(toolCalls).toEqual([
      {
        id: "call-success",
        type: "function",
        function: { name: "read", arguments: '{"path":"README.md"}' },
        extra_content: { google: { thought_signature: "synthetic-signature-success" } },
      },
      {
        id: "call-failure",
        type: "function",
        function: { name: "skill", arguments: '{"name":"missing-skill"}' },
        extra_content: { google: { thought_signature: "synthetic-signature-failure" } },
      },
      {
        id: "call-unsigned",
        type: "function",
        function: { name: "read", arguments: '{"path":"package.json"}' },
      },
    ])
    expect(requestBody?.messages.slice(2).map((message: { content: string }) => message.content)).toEqual([
      "contents",
      "Skill not found",
      "{}",
    ])
    expect((prompt[1].content as any[]).slice(0, 2).map((part) => part.providerOptions[providerID])).toEqual([
      { thoughtSignature: "synthetic-signature-success" },
      { thoughtSignature: "synthetic-signature-failure" },
    ])
  })

  test("does not project Gemini signatures for a non-Gemini compatible model", async () => {
    const { requestBody } = await serializeRestoredHistory({
      ...geminiModel,
      id: ModelV2.ID.make("gpt-5.4"),
      api: { ...geminiModel.api, id: "gpt-5.4" },
    })

    expect(
      requestBody?.messages[1].tool_calls.every(
        (call: { extra_content?: unknown }) => call.extra_content === undefined,
      ),
    ).toBe(true)
  })

  test("does not carry compatible-provider signatures across a native provider switch", async () => {
    const nativeModel: Provider.Model = {
      ...geminiModel,
      providerID: ProviderV2.ID.make("google"),
      api: { ...geminiModel.api, npm: "@ai-sdk/google" },
    }
    const restored = await MessageV2.toModelMessages(restoredHistory(await receiveToolCallMetadata()), nativeModel)
    const prompt = ProviderTransform.message(restored, nativeModel, {}) as any[]

    expect(prompt[1].content.every((part: { providerOptions?: unknown }) => part.providerOptions === undefined)).toBe(
      true,
    )
  })
})
