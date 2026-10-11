import { expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit, Fiber, Queue, Schema } from "effect"
import { Parameters, QuestionTool } from "../../src/tool/question"
import { ToolJsonSchema } from "../../src/tool/json-schema"
import { Question } from "../../src/question"
import { SessionID, MessageID } from "../../src/session/schema"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Truncate } from "../../src/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config/config"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(LayerNode.group([Question.node, EventV2Bridge.node, Truncate.node, Agent.node, Config.node])),
)
const ctx = {
  sessionID: SessionID.make("ses_empty_question"),
  messageID: MessageID.make("msg_empty_question"),
  callID: "empty-question",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}
const prompt = {
  question: "Choose a direction?",
  header: "Direction",
  options: [{ label: "One", description: "First" }],
}
const invalid = [
  { questions: [] },
  { catalogQuestionIds: [] },
  { catalogQuestions: [{ catalogQuestionIds: ["authoring-path"] }], questions: [] },
  {},
  { questions: [prompt], catalogQuestionIds: ["authoring-path"] },
  { questions: [{ ...prompt, question: "  " }] },
]

test("1772 question wire schema requires nonempty input while retaining an object root", () => {
  const schema = ToolJsonSchema.fromSchema(Parameters)
  expect(schema.type).toBe("object")
  expect(schema.properties?.questions).toMatchObject({ type: "array", minItems: 1 })
  expect(schema.properties?.catalogQuestionIds).toMatchObject({ type: "array", minItems: 1 })
  for (const input of invalid) expect(() => Schema.decodeUnknownSync(Parameters)(input)).toThrow()
  expect(Schema.decodeUnknownSync(Parameters)({ questions: [prompt] })).toEqual({ questions: [prompt] })
  expect(Schema.decodeUnknownSync(Parameters)({ catalogQuestionIds: ["authoring-path"] })).toEqual({
    catalogQuestionIds: ["authoring-path"],
  })
})

for (const [index, input] of invalid.entries()) {
  it.instance(`1772 malformed call ${index} fails without publishing a pending question`, () =>
    Effect.gen(function* () {
      const question = yield* Question.Service
      const toolInfo = yield* QuestionTool
      const tool = yield* toolInfo.init()
      const events = yield* EventV2Bridge.Service
      const asked: unknown[] = []
      const off = yield* events.listen((event) => {
        if (event.type === Question.Event.Asked.type) asked.push(event)
        return Effect.void
      })
      yield* Effect.addFinalizer(() => off)
      const result = yield* tool.execute(input, ctx).pipe(Effect.timeout("200 millis"), Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      if (!Exit.isFailure(result)) return
      const error = Cause.squash(result.cause)
      expect(error).toMatchObject({ _tag: "ToolInvalidArgumentsError", tool: "question" })
      expect(String(error)).toContain("catalogQuestionIds")
      expect(yield* question.list()).toEqual([])
      expect(asked).toEqual([])
    }),
  )
}

it.instance("1772 native owner refuses zero questions without entering a wait", () =>
  Effect.gen(function* () {
    const question = yield* Question.Service
    const result = yield* question
      .ask({ sessionID: ctx.sessionID, questions: [] })
      .pipe(Effect.timeout("200 millis"), Effect.exit)
    expect(Exit.isFailure(result)).toBe(true)
    if (!Exit.isFailure(result)) return
    expect(Cause.squash(result.cause)).toMatchObject({ _tag: "QuestionRejectedError", reason: "invalid-request" })
    expect(yield* question.list()).toEqual([])
  }),
)

for (const recovery of ["list", "reply", "reject"] as const) {
  it.instance(`1772 ${recovery} rejects a retained empty request without an answer receipt`, () =>
    Effect.gen(function* () {
      const question = yield* Question.Service
      const events = yield* EventV2Bridge.Service
      const ready = yield* Queue.unbounded<void>()
      const replied: unknown[] = []
      const rejected: unknown[] = []
      const off = yield* events.listen((event) => {
        if (event.type === Question.Event.Asked.type) Queue.offerUnsafe(ready, undefined)
        if (event.type === Question.Event.Replied.type) replied.push(event.data)
        if (event.type === Question.Event.Rejected.type) rejected.push(event.data)
        return Effect.void
      })
      yield* Effect.addFinalizer(() => off)
      const questions = [prompt]
      const fiber = yield* question
        .ask({ sessionID: ctx.sessionID, questions, tool: { messageID: ctx.messageID, callID: ctx.callID } })
        .pipe(Effect.forkScoped)
      yield* Queue.take(ready).pipe(Effect.timeout("2 seconds"))
      const [request] = yield* question.list()
      // A request retained from the old implementation has no questions.
      // Mutate the pending projection to exercise the real owner, without a test-only production API.
      ;(request!.questions as Question.Info[]).splice(0)
      if (recovery === "reply") yield* question.reply({ requestID: request!.id, answers: [] })
      if (recovery === "reject") yield* question.reject(request!.id)
      expect(yield* question.list()).toEqual([])
      const result = yield* Fiber.await(fiber).pipe(Effect.timeout("200 millis"))
      expect(Exit.isFailure(result)).toBe(true)
      if (!Exit.isFailure(result)) return
      expect(Cause.squash(result.cause)).toMatchObject({ _tag: "QuestionRejectedError", reason: "invalid-request" })
      expect(replied).toEqual([])
      expect(rejected).toEqual([{ sessionID: ctx.sessionID, requestID: request!.id }])
    }),
  )
}
