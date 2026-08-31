import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Fiber, Queue } from "effect"
import { QuestionTool } from "../../src/tool/question"
import { Question } from "../../src/question"
import { SessionID, MessageID } from "../../src/session/schema"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { testEffect } from "../lib/effect"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

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

const it = testEffect(
  LayerNode.compile(LayerNode.group([Question.node, EventV2Bridge.node, Truncate.node, Agent.node])),
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
  it.instance(
    "renders exact StratCraft catalog-backed questions",
    () =>
      Effect.gen(function* () {
        const question = yield* Question.Service
        const toolInfo = yield* QuestionTool
        const tool = yield* toolInfo.init()

        const fiber = yield* tool.execute({ catalogQuestionIds: ["starting-direction"] }, ctx).pipe(Effect.forkScoped)
        const item = yield* pending(question)
        expect(item.questions).toEqual([
          {
            question: "What should this strategy be about?",
            header: "Strategy intent",
            options: [
              { label: "Trend following", description: "Begin with a public trend-following pattern." },
              { label: "Open-source starting point", description: "Inspect a supported public algorithm." },
            ],
            multiple: false,
            custom: true,
          },
        ])
        yield* question.reply({ requestID: item.id, answers: [["A custom direction"]] })
        const result = yield* Fiber.join(fiber)
        expect(result.output).toContain('"What should this strategy be about?"="A custom direction"')
        expect(result.metadata.questions).toEqual(item.questions)
      }),
    {
      init: (directory) =>
        Effect.promise(async () => {
          const projection = {
            catalogVersion: "1.0.0",
            locale: "en_US",
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
                    description: "Inspect a supported public algorithm.",
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
          const instructionDirectory = path.join(directory, "instructions")
          await mkdir(instructionDirectory, { recursive: true })
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
