import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit, Fiber, Queue } from "effect"
import { QuestionTool } from "../../src/tool/question"
import { Question } from "../../src/question"
import { Plugin } from "../../src/plugin"
import { Config } from "../../src/config/config"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "../../src/tool/truncate"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { SessionID, MessageID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import type { Hooks } from "@opencode-ai/plugin"

// QuantNexus supplies its actual immutable generated plugins, rather than a copied guard.
const filename = process.env.STRATCRAFT_QUESTION_ALLOWANCE_TEST_FIXTURE
const projections: { relativePath: string; content: string }[] = filename ? JSON.parse(await readFile(filename, "utf8")) : []
const it = testEffect(LayerNode.compile(LayerNode.group([
  Question.node, Plugin.node, Config.node, Agent.node, Truncate.node, EventV2Bridge.node,
])))
const ctx = {
  sessionID: SessionID.make("ses_allowance"), messageID: MessageID.make("msg_retained-request"),
  callID: "catalog-call", agent: "build", abort: AbortSignal.any([]), messages: [],
  metadata: () => Effect.void, ask: () => Effect.void,
}
const prompt = { question: "Which rules?", header: "Rules", options: [{ label: "Continue", description: "Continue." }] }
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value !== null && typeof value === "object") return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`
  return JSON.stringify(value)
}
const init = (directory: string) => Effect.promise(async () => {
  const projection = {
    catalogVersion: "1.8.0", locale: "en_US", targetRuntime: "python-backtrader-v1", algorithmBrowsingEmptyState: null,
    sections: [{ sectionId: "styles", label: "Styles", items: [{ itemId: "trend", label: "Trend", description: "Trend." }] }],
    questions: ["common-strategy", "remaining-rules"].map(questionId => ({
      questionId, question: "Choose a strategy", header: "Strategy", selectionMode: "single", customAnswerPolicy: "allowed",
      options: [{ optionId: "moving-average", label: "Moving average", description: "Crossovers." }],
    })), effects: { createsStrategyRules: false, allowsExecutableAction: false },
  }
  const taskDirectory = path.join(directory, ".stratcraft/tasks/retained-task")
  await mkdir(path.join(taskDirectory, "instructions"), { recursive: true })
  await writeFile(path.join(taskDirectory, "instructions/strategy-authoring-orientation.json"), JSON.stringify({
    ...projection, projectionHash: createHash("sha256").update(canonical(projection)).digest("hex"),
  }))
  await writeFile(path.join(directory, "opencode.json"), JSON.stringify({ instructions: [path.join(taskDirectory, "AGENTS.md")],
    mcp: { stratforge: { type: "remote", url: "http://127.0.0.1:7789/mcp/authoring",
      headers: { "X-StratCraft-Authoring-Task-Id": "retained-task" } } },
  }))
})

describe.skipIf(!filename)("native catalog allowance with generated StratCraft plugins", () => {
  for (const projection of projections) {
    it.instance(projection.relativePath, () => Effect.gen(function* () {
      const plugin = yield* Plugin.Service
      const question = yield* Question.Service
      const events = yield* EventV2Bridge.Service
      const asked = yield* Queue.unbounded<void>()
      const off = yield* events.listen(event => {
        if (event.type === Question.Event.Asked.type) Queue.offerUnsafe(asked, undefined)
        return Effect.void
      })
      yield* Effect.addFinalizer(() => off)
      const reservations = new Set<string>()
      const requests: { requestId: string; nativeSessionId: string; resource: string }[] = []
      let refusal: string | undefined
      const server = yield* Effect.acquireRelease(Effect.sync(() => Bun.serve({ hostname: "127.0.0.1", port: 0,
        async fetch(request) {
          expect(request.headers.get("Authorization")).toBe("Bearer fixture-lease")
          const body = await request.json() as typeof requests[number]
          requests.push(body)
          if (body.nativeSessionId !== ctx.sessionID) return Response.json({ status: "stopped", reason: "identity-mismatch" })
          if (refusal) return Response.json({ status: "stopped", reason: refusal })
          const replay = reservations.has(body.requestId)
          reservations.add(body.requestId)
          return Response.json({ status: replay ? "replayed" : "reserved" })
        },
      })), server => Effect.sync(() => server.stop(true)))
      process.env.STRATCRAFT_QUESTION_TEST_LEASE = "fixture-lease"
      yield* Effect.addFinalizer(() => Effect.sync(() => { delete process.env.STRATCRAFT_QUESTION_TEST_LEASE }))
      const module = yield* Effect.promise(() => import(`data:text/javascript;base64,${Buffer.from(projection.content).toString("base64")}`))
      const hooks = yield* Effect.promise(async () => await module.StratCraftDiagnosisAllowance({}, {
        allowanceUrl: `http://127.0.0.1:${server.port}/allowance`, leaseTokenEnvironmentVariable: "STRATCRAFT_QUESTION_TEST_LEASE",
        confirmMajorDecisions: true,
      }) as Hooks)
      const installed = yield* plugin.list()
      installed.push(hooks)
      installed.push({ "tool.execute.before": async (_input, output) => {
        if (!output.args.questions[0].questionId) return
        // A later hook cannot alter the catalog or its count after the allowance reservation.
        expect(Reflect.set(output.args, "questions", [prompt])).toBe(false)
        expect(Reflect.set(output.args.questions[0], "questionId", "fabricated")).toBe(false)
        expect(Reflect.set(output.args.questions[0].options[0], "label", "Invented")).toBe(false)
        expect(() => output.args.questions.push(prompt)).toThrow(TypeError)
      } })
      const toolInfo = yield* QuestionTool
      const tool = yield* toolInfo.init()

      for (const [index, args] of [
        { catalogQuestionIds: ["common-strategy"] },
        { catalogQuestionIds: ["common-strategy", "remaining-rules"] },
        { questions: [prompt] },
      ].entries()) {
        for (const answer of ["moving-average", "My custom rules"]) {
          const callID = `call-${index}`
          const fiber = yield* tool.execute(args, { ...ctx, callID }).pipe(Effect.forkScoped)
          yield* Queue.take(asked).pipe(Effect.timeout("2 seconds"))
          const items = yield* question.list()
          expect(items).toHaveLength(1)
          const item = items[0]!
          expect(item).toMatchObject({ sessionID: ctx.sessionID, tool: { messageID: ctx.messageID, callID } })
          expect(item.questions).toHaveLength(index === 1 ? 2 : 1)
          yield* question.reply({ requestID: item.id, answers: item.questions.map(() => [answer]) })
          expect((yield* Fiber.join(fiber)).metadata.answers).toEqual(item.questions.map(() => [answer]))
          expect(yield* question.list()).toEqual([])
          expect(Exit.isFailure(yield* question.reply({ requestID: item.id, answers: [[answer]] }).pipe(Effect.exit))).toBe(true)
        }
      }
      expect([...reservations]).toEqual(["call-0:0", "call-1:0", "call-1:1", "call-2:0"])
      expect(requests.every(request => request.resource === "major-decision")).toBe(true)
      const reserved = reservations.size
      const attempted = requests.length
      for (const args of [
        {}, { questions: [] }, { questions: [{}] }, { catalogQuestionIds: [] },
        { catalogQuestionIds: ["missing"] }, { catalogQuestionIds: ["common-strategy", "common-strategy"] },
        { catalogQuestionIds: ["remaining-rules", "common-strategy"] },
        { questions: [prompt], catalogQuestionIds: ["common-strategy"] },
      ]) {
        expect(Exit.isFailure(yield* tool.execute(args as never, ctx).pipe(Effect.exit))).toBe(true)
        expect(yield* question.list()).toEqual([])
      }
      expect(requests).toHaveLength(attempted)
      expect(Exit.isFailure(yield* tool.execute({ questions: [prompt] }, { ...ctx, callID: undefined }).pipe(Effect.exit))).toBe(true)
      expect(requests).toHaveLength(attempted)

      for (const reason of ["decision-limit", "allowance-exhausted", "operation-stopped", "admission-revoked"]) {
        refusal = reason
        const exit = yield* tool.execute({ catalogQuestionIds: ["common-strategy"] }, ctx).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain(reason)
        expect(yield* question.list()).toEqual([])
      }
      refusal = undefined
      const stale = yield* tool.execute({ questions: [prompt] }, { ...ctx, sessionID: SessionID.make("ses_stale") }).pipe(Effect.exit)
      expect(Exit.isFailure(stale)).toBe(true)
      expect(reservations.size).toBe(reserved)
      const enabled = hooks["tool.execute.before"]
      const disabled = yield* Effect.promise(async () => await module.StratCraftDiagnosisAllowance({}, {
        allowanceUrl: `http://127.0.0.1:${server.port}/allowance`, leaseTokenEnvironmentVariable: "STRATCRAFT_QUESTION_TEST_LEASE",
        confirmMajorDecisions: false,
      }) as Hooks)
      hooks["tool.execute.before"] = disabled["tool.execute.before"]
      const beforeDisabled = requests.length
      expect(Exit.isFailure(yield* tool.execute({ catalogQuestionIds: ["common-strategy"] }, ctx).pipe(Effect.exit))).toBe(true)
      expect(requests).toHaveLength(beforeDisabled)
      hooks["tool.execute.before"] = enabled
      const cancelled = yield* tool.execute({ catalogQuestionIds: ["common-strategy"] }, ctx).pipe(Effect.forkScoped)
      yield* Queue.take(asked).pipe(Effect.timeout("2 seconds"))
      yield* question.reject((yield* question.list())[0]!.id)
      expect(Exit.isFailure(yield* Fiber.await(cancelled))).toBe(true)
      expect(yield* question.list()).toEqual([])
      expect(reservations.size).toBe(reserved + 1)
      const retry = yield* tool.execute({ catalogQuestionIds: ["common-strategy"] }, ctx).pipe(Effect.forkScoped)
      yield* Queue.take(asked).pipe(Effect.timeout("2 seconds"))
      yield* question.reply({ requestID: (yield* question.list())[0]!.id, answers: [["My custom retry rules"]] })
      expect((yield* Fiber.join(retry)).metadata.answers).toEqual([["My custom retry rules"]])
      expect(reservations.size).toBe(reserved + 1)
    }), { init })
  }
})
