import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Fiber, Queue } from "effect"
import { QuestionTool } from "../../src/tool/question"
import { Question } from "../../src/question"
import { SessionID, MessageID, PartID } from "../../src/session/schema"
import { MessageV2 } from "../../src/session/message-v2"
import type { Provider } from "../../src/provider/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { testEffect } from "../lib/effect"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { Config } from "@/config/config"

const ctx = {
  sessionID: SessionID.make("ses_test-session"),
  messageID: MessageID.make("msg_test-message"),
  callID: "test-call",
  agent: "test-agent",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const model: Provider.Model = {
  id: ModelV2.ID.make("test-model"), providerID: ProviderV2.ID.make("test"),
  api: { id: "test-model", url: "https://example.com", npm: "@ai-sdk/openai" },
  name: "Test model", status: "active", release_date: "2026-01-01", options: {}, headers: {},
  capabilities: {
    temperature: true, reasoning: false, attachment: false, toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false }, interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } }, limit: { context: 0, input: 0, output: 0 },
}

const it = testEffect(
  LayerNode.compile(LayerNode.group([Question.node, EventV2Bridge.node, Truncate.node, Agent.node, Config.node])),
)

const pending = Effect.fn("QuestionToolTest.pending")(function* (question: Question.Interface) {
  const events = yield* EventV2Bridge.Service
  const asked = yield* Queue.unbounded<void>()
  const off = yield* events.listen((event) => {
    if (event.type === Question.Event.Asked.type) Queue.offerUnsafe(asked, undefined)
    return Effect.void
  })
  yield* Effect.addFinalizer(() => off)

  for (;;) {
    const items = yield* question.list()
    const item = items[0]
    if (item) return item
    yield* Queue.take(asked).pipe(Effect.timeout("2 seconds"))
  }
})

describe("tool.question", () => {
  it.instance("renders task-free project choices and consumes clicked and typed answers once", () =>
    Effect.gen(function* () {
      const question = yield* Question.Service
      const toolInfo = yield* QuestionTool
      const tool = yield* toolInfo.init()
      for (const answer of ["browse-public-algorithms", "My own strategy idea"]) {
        const fiber = yield* tool.execute({ catalogQuestionIds: ["authoring-path"] }, ctx).pipe(Effect.forkScoped)
        const item = yield* pending(question)
        expect(item.orientation?.[0]).toMatchObject({ sectionId: "examples", label: "Examples" })
        expect(item.questions[0]).toMatchObject({ questionId: "authoring-path", custom: true, multiple: false,
          options: [{ optionId: "browse-public-algorithms" }, { optionId: "recommend-starting-point" }] })
        yield* question.reply({ requestID: item.id, answers: [[answer]] })
        expect((yield* Fiber.join(fiber)).metadata.answers).toEqual([[answer]])
        expect(yield* question.list()).toEqual([])
      }
      for (const answer of ["octobot-dca-trading-mode", "DCATradingMode", "My own DCA rules", undefined]) {
        const fiber = yield* tool.execute({ catalogQuestionIds: ["public-algorithm-octobot"] }, ctx).pipe(Effect.forkScoped)
        const item = yield* pending(question)
        const answers = answer === undefined ? [] : [answer]
        yield* question.reply({ requestID: item.id, answers: [answers] })
        const result = yield* Fiber.join(fiber)
        expect(result.metadata.answers).toEqual([answers])
        if (answer === "octobot-dca-trading-mode") {
          expect(result.output).toContain("https://example.com/pinned/dca.py")
          expect(result.output).toContain('"optionId":"octobot-dca-trading-mode"')
          expect(result.output).toContain('"label":"DCATradingMode"')
          expect(result.output).toContain('"questionId":"public-algorithm-octobot"')
          const history: SessionV1.WithParts[] = [{
            info: {
              id: ctx.messageID, sessionID: ctx.sessionID, role: "assistant", parentID: MessageID.make("msg_parent"),
              time: { created: 0 }, modelID: model.id, providerID: model.providerID, mode: "", agent: ctx.agent,
              path: { cwd: "/", root: "/" }, cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            },
            parts: [{
              id: PartID.make("prt_question"), messageID: ctx.messageID, sessionID: ctx.sessionID,
              type: "tool", tool: "question", callID: ctx.callID,
              state: { status: "completed", input: { catalogQuestionIds: ["public-algorithm-octobot"] },
                title: result.title, output: result.output, metadata: result.metadata, time: { start: 0, end: 1 } },
            }],
          }]
          const messages = yield* MessageV2.toModelMessagesEffect(history, model)
          const delivered = JSON.stringify(messages.find(message => message.role === "tool"))
          expect(delivered).toContain("https://example.com/pinned/dca.py")
          expect(delivered).not.toContain("https://example.com/pinned/grid.py")
          expect(yield* MessageV2.toModelMessagesEffect(JSON.parse(JSON.stringify(history)), model)).toEqual(messages)
        } else {
          expect(result.output).not.toContain("https://example.com/pinned/dca.py")
        }
        expect(result.output).not.toContain("https://example.com/pinned/grid.py")
        expect(yield* question.list()).toEqual([])
      }
    }),
    { init: directory => Effect.gen(function* () {
      const projection = {
        catalogVersion: "1.0.0", locale: "en_US", targetRuntime: "python-backtrader-v1",
        algorithmBrowsingEmptyState: null,
        sections: [{ sectionId: "examples", label: "Examples", items: [{ itemId: "public", label: "Public", description: "Browse." }] }],
        questions: [{ questionId: "authoring-path", header: "Start", question: "How to start?",
          selectionMode: "single", customAnswerPolicy: "allowed", options: [
            { optionId: "browse-public-algorithms", label: "Browse public algorithms", description: "Browse." },
            { optionId: "recommend-starting-point", label: "Recommend a starting point", description: "Recommend." },
          ] }, { questionId: "public-algorithm-octobot", header: "OctoBot", question: "Which source?",
          selectionMode: "single", customAnswerPolicy: "allowed", options: [
            { optionId: "octobot-dca-trading-mode", label: "DCATradingMode", description: "Requires order-lifecycle adaptation; source: https://example.com/pinned/dca.py" },
            { optionId: "octobot-grid-trading-mode", label: "GridTradingMode", description: "Grid source: https://example.com/pinned/grid.py" },
          ] }],
        effects: { createsStrategyRules: false, allowsExecutableAction: false },
      }
      const canonical = (value: unknown): string => {
        if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
        if (value !== null && typeof value === "object") return `{${Object.entries(value)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`
        return JSON.stringify(value)
      }
      const server = yield* Effect.acquireRelease(Effect.sync(() => Bun.serve({ port: 0, hostname: "127.0.0.1",
        async fetch(request) {
          expect(request.headers.get("Authorization")).toBe("Bearer task-free-lease")
          expect(await request.json()).toEqual({ nativeSessionId: ctx.sessionID })
          return Response.json({ questionCatalog: { ...projection,
            projectionHash: createHash("sha256").update(canonical(projection)).digest("hex") } })
        },
      })), server => Effect.sync(() => server.stop(true)))
      yield* Effect.promise(() => writeFile(path.join(directory, "opencode.json"), JSON.stringify({
        mcp: { stratforge: { type: "remote", url: `http://127.0.0.1:${server.port}/mcp/authoring`,
          headers: { Authorization: "Bearer task-free-lease" } } },
      })))
    }) },
  )
  it.instance(
    "renders exact StratCraft catalog-backed questions",
    () =>
      Effect.gen(function* () {
        const question = yield* Question.Service
        const toolInfo = yield* QuestionTool
        const tool = yield* toolInfo.init()

        const fiber = yield* tool.execute({ catalogQuestionIds: ["starting-direction"] }, ctx).pipe(Effect.forkScoped)
        const item = yield* pending(question)
        expect(item.orientation).toEqual([
          {
            sectionId: "strategy-styles",
            label: "Strategy styles",
            items: [{ itemId: "trend-following", label: "Trend following", description: "Explore trends." }],
          },
        ])
        expect(item.questions).toEqual([
          {
            questionId: "starting-direction",
            question: "What should this strategy be about?",
            header: "Strategy intent",
            options: [
              {
                optionId: "trend-following",
                label: "Trend following",
                description: "Begin with a public trend-following pattern.",
              },
              {
                optionId: "open-source-starting-point",
                label: "Open-source starting point",
                description: "Inspect a supported public algorithm; source: https://example.com/pinned/selected.py",
              },
            ],
            multiple: false,
            custom: true,
          },
        ])
        yield* question.reply({ requestID: item.id, answers: [["open-source-starting-point"]] })
        const result = yield* Fiber.join(fiber)
        expect(result.output).toContain(
          '"starting-direction (What should this strategy be about?)"="open-source-starting-point"',
        )
        expect(result.metadata.questions).toEqual(item.questions)
        expect(result.output).toContain("https://example.com/pinned/selected.py")
        expect(result.output).not.toContain("Begin with a public trend-following pattern.")

        const customFiber = yield* tool.execute({ catalogQuestionIds: ["starting-direction"] }, ctx).pipe(
          Effect.forkScoped,
        )
        const customItem = yield* pending(question)
        yield* question.reply({ requestID: customItem.id, answers: [["A custom direction"]] })
        const customResult = yield* Fiber.join(customFiber)
        expect(customResult.output).not.toContain("https://example.com/pinned/selected.py")
        expect(customResult.output).toContain(
          '"starting-direction (What should this strategy be about?)"="A custom direction"',
        )
      }),
    {
      init: (directory) =>
        Effect.promise(async () => {
          const projection = {
            catalogVersion: "1.0.0",
            locale: "en_US",
            targetRuntime: "python-backtrader-v1",
            algorithmBrowsingEmptyState: null,
            sections: [
              {
                sectionId: "strategy-styles",
                label: "Strategy styles",
                items: [{ itemId: "trend-following", label: "Trend following", description: "Explore trends." }],
              },
            ],
            questions: [
              {
                questionId: "starting-direction",
                header: "Strategy intent",
                question: "What should this strategy be about?",
                selectionMode: "single",
                customAnswerPolicy: "allowed",
                options: [
                  {
                    optionId: "trend-following",
                    label: "Trend following",
                    description: "Begin with a public trend-following pattern.",
                  },
                  {
                    optionId: "open-source-starting-point",
                    label: "Open-source starting point",
                    description: "Inspect a supported public algorithm; source: https://example.com/pinned/selected.py",
                  },
                ],
              },
            ],
            effects: { createsStrategyRules: false, allowsExecutableAction: false },
          }
          const canonical = (value: unknown): string => {
            if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
            if (value !== null && typeof value === "object") {
              return `{${Object.entries(value as Record<string, unknown>)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
                .join(",")}}`
            }
            return JSON.stringify(value)
          }
          const content = {
            ...projection,
            projectionHash: createHash("sha256").update(canonical(projection), "utf8").digest("hex"),
          }
          const taskDirectory = path.join(directory, ".stratcraft", "tasks", "bound-task")
          const instructionDirectory = path.join(taskDirectory, "instructions")
          await mkdir(instructionDirectory, { recursive: true })
          await writeFile(path.join(directory, "opencode.json"), JSON.stringify({
            instructions: [path.join(taskDirectory, "AGENTS.md")],
            mcp: { stratforge: { type: "remote", url: "http://127.0.0.1:7789/mcp/authoring", headers: {
              "X-StratCraft-Authoring-Task-Id": "bound-task",
            } } },
          }))
          await writeFile(
            path.join(instructionDirectory, "strategy-authoring-orientation.json"),
            `${JSON.stringify(content)}\n`,
            "utf8",
          )
        }),
    },
  )

  it.instance("should successfully execute with valid question parameters", () =>
    Effect.gen(function* () {
      const question = yield* Question.Service
      const toolInfo = yield* QuestionTool
      const tool = yield* toolInfo.init()
      const questions = [
        {
          question: "What is your favorite color?",
          header: "Color",
          options: [
            { label: "Red", description: "The color of passion" },
            { label: "Blue", description: "The color of sky" },
          ],
          multiple: false,
        },
      ]

      const fiber = yield* tool.execute({ questions }, ctx).pipe(Effect.forkScoped)
      const item = yield* pending(question)
      yield* question.reply({ requestID: item.id, answers: [["Red"]] })

      const result = yield* Fiber.join(fiber)
      expect(result.title).toBe("Asked 1 question")
      expect(result.output).toBe('User has answered your questions: "What is your favorite color?"="Red". You can now continue with the user\'s answers in mind.')
    }),
  )

  it.instance("should now pass with a header longer than 12 but less than 30 chars", () =>
    Effect.gen(function* () {
      const question = yield* Question.Service
      const toolInfo = yield* QuestionTool
      const tool = yield* toolInfo.init()
      const questions = [
        {
          question: "What is your favorite animal?",
          header: "This Header is Over 12",
          options: [{ label: "Dog", description: "Man's best friend" }],
        },
      ]

      const fiber = yield* tool.execute({ questions }, ctx).pipe(Effect.forkScoped)
      const item = yield* pending(question)
      yield* question.reply({ requestID: item.id, answers: [["Dog"]] })

      const result = yield* Fiber.join(fiber)
      expect(result.output).toContain(`"What is your favorite animal?"="Dog"`)
    }),
  )

  // intentionally removed the zod validation due to tool call errors, hoping prompting is gonna be good enough
  //   test("should throw an Error for header exceeding 30 characters", async () => {
  //     const tool = await QuestionTool.init()
  //     const questions = [
  //       {
  //         question: "What is your favorite animal?",
  //         header: "This Header is Definitely More Than Thirty Characters Long",
  //         options: [{ label: "Dog", description: "Man's best friend" }],
  //       },
  //     ]
  //     try {
  //       await tool.execute({ questions }, ctx)
  //       // If it reaches here, the test should fail
  //       expect(true).toBe(false)
  //     } catch (e: any) {
  //       expect(e).toBeInstanceOf(Error)
  //       expect(e.cause).toBeInstanceOf(z.ZodError)
  //     }
  //   })

  //   test("should throw an Error for label exceeding 30 characters", async () => {
  //     const tool = await QuestionTool.init()
  //     const questions = [
  //       {
  //         question: "A question with a very long label",
  //         header: "Long Label",
  //         options: [
  //           { label: "This is a very, very, very long label that will exceed the limit", description: "A description" },
  //         ],
  //       },
  //     ]
  //     try {
  //       await tool.execute({ questions }, ctx)
  //       // If it reaches here, the test should fail
  //       expect(true).toBe(false)
  //     } catch (e: any) {
  //       expect(e).toBeInstanceOf(Error)
  //       expect(e.cause).toBeInstanceOf(z.ZodError)
  //     }
  //   })
})
