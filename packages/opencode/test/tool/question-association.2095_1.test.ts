import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Exit, Fiber, Layer, Queue } from "effect"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { QuestionTool } from "../../src/tool/question"
import { Question } from "../../src/question"
import { Plugin } from "../../src/plugin"
import { Config } from "../../src/config/config"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "../../src/tool/truncate"
import { ToolRegistry } from "../../src/tool/registry"
import { Permission } from "../../src/permission"
import { MCP } from "../../src/mcp"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { EffectBridge } from "../../src/effect/bridge"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Session } from "../../src/session/session"
import { SessionTools } from "../../src/session/tools"
import { MessageID, PartID } from "../../src/session/schema"
import type { Provider } from "../../src/provider/provider"
import type { CatalogQuestionBeforeOutput, Hooks, QuestionExecutionContext } from "@opencode-ai/plugin"
import { testEffect } from "../lib/effect"
import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

const filename = process.env.STRATCRAFT_QUESTION_ASSOCIATION_TEST_PLUGIN
  ?? new URL("../fixture/question-association-plugin.2095_1.mjs", import.meta.url).href

// Checked by native typechecking; never invoked at runtime.
function catalogContract(output: CatalogQuestionBeforeOutput) {
  // @ts-expect-error Catalog argument replacement is forbidden.
  output.args = { questions: [] }
  // @ts-expect-error Catalog question arrays are readonly.
  output.args.questions.push(output.args.questions[0])
  // @ts-expect-error Catalog option contents are readonly.
  output.args.questions[0].options[0].label = "forged"
  // @ts-expect-error The native-created context slot cannot be replaced.
  output.questionContext = {}
  output.questionContext.requestAssociation = { purpose: "request", sourceId: "original-request" }
}
const it = testEffect(LayerNode.compile(LayerNode.group([
  Question.node, Plugin.node, Config.node, Agent.node, Truncate.node, EventV2Bridge.node,
  Session.node, SessionProjector.node, Permission.node, RuntimeFlags.node,
]), [[RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })]]))
const model: Provider.Model = {
  id: ModelV2.ID.make("test-model"), providerID: ProviderV2.ID.make("test"),
  api: { id: "test-model", url: "https://example.com", npm: "@ai-sdk/openai" },
  name: "Test model", status: "active", release_date: "2026-01-01", options: {}, headers: {},
  capabilities: { temperature: true, reasoning: false, attachment: false, toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false }, interleaved: false },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } }, limit: { context: 0, input: 0, output: 0 },
}
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`
  return JSON.stringify(value)
}
const init = (directory: string) => Effect.promise(async () => {
  const projection = { catalogVersion: "1.8.0", locale: "en_US", targetRuntime: "python-backtrader-v1",
    algorithmBrowsingEmptyState: null, sections: [], questions: [{ questionId: "common-strategy",
      question: "Choose a strategy", header: "Strategy", selectionMode: "single", customAnswerPolicy: "allowed",
      options: [{ optionId: "moving-average", label: "Moving average", description: "Crossovers." }] }],
    effects: { createsStrategyRules: false, allowsExecutableAction: false } }
  const task = path.join(directory, ".stratcraft/tasks/retained-task")
  await mkdir(path.join(task, "instructions"), { recursive: true })
  await writeFile(path.join(task, "instructions/strategy-authoring-orientation.json"), JSON.stringify({ ...projection,
    projectionHash: createHash("sha256").update(canonical(projection)).digest("hex") }))
  await writeFile(path.join(directory, "opencode.json"), JSON.stringify({ instructions: [path.join(task, "AGENTS.md")],
    mcp: { stratforge: { type: "remote", url: "http://127.0.0.1:7789/mcp/authoring",
      headers: { "X-StratCraft-Authoring-Task-Id": "retained-task" } } } }))
})

describe.skipIf(!filename)("2095_1 native catalog and configured application plugin", () => {
  for (const mode of ["agent", "manual", "agent-ordinary", "manual-ordinary", "scope-selection", "capture-failure", "persistence-failure"] as const) {
    it.instance(mode, () => Effect.gen(function* () {
      const manual = mode.startsWith("manual")
      const catalog = !mode.endsWith("ordinary")
      const sessions = yield* Session.Service
      const plugin = yield* Plugin.Service
      const question = yield* Question.Service
      const events = yield* EventV2Bridge.Service
      const agent = yield* Agent.Service
      const bridge = yield* EffectBridge.make()
      const chat = yield* sessions.create({})
      const request = yield* sessions.updateMessage({ id: MessageID.ascending(), sessionID: chat.id, role: "user", agent: "build",
        model: { modelID: model.id, providerID: model.providerID }, time: { created: Date.now() } })
      yield* sessions.updatePart({ id: PartID.ascending(), sessionID: chat.id, messageID: request.id, type: "text",
        text: "Write a strategy", synthetic: !manual })
      const assistant: SessionV1.Assistant = { id: MessageID.ascending(), sessionID: chat.id, parentID: request.id,
        role: "assistant", agent: "build", mode: "build", modelID: model.id, providerID: model.providerID,
        time: { created: Date.now() }, path: { cwd: chat.directory, root: chat.directory }, cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }
      yield* sessions.updateMessage(assistant)
      const part = { id: PartID.ascending(), sessionID: chat.id, messageID: assistant.id, type: "tool" as const,
        tool: "question", callID: "call_29eb0fc76ec44b9498f8dc4b8f703d1e", state: { status: "running" as const,
          input: {}, metadata: { existing: "retained" }, time: { start: Date.now() } } }
      yield* sessions.updatePart(part)
      const captured: Record<string, unknown>[] = []
      let sourceId = "original-request"
      let captureUnavailable = mode === "capture-failure"
      let orientationReads = 0
      const server = yield* Effect.acquireRelease(Effect.sync(() => Bun.serve({ hostname: "127.0.0.1", port: 0,
        async fetch(req) {
          expect(req.headers.get("Authorization")).toBe("Bearer fixture-lease")
          const body = await req.json() as Record<string, unknown>
          if (new URL(req.url).pathname === "/orientation") {
            orientationReads++
            return Response.json({ continuation: { binding: { nativeSessionId: chat.id }, clarificationRequest:
              mode === "scope-selection" ? { purpose: "scope-selection", sourceId: null }
                : { purpose: "request", sourceId } } })
          }
          if (new URL(req.url).pathname === "/source") {
            if (captureUnavailable) return Response.json({ error: "capture unavailable" }, { status: 503 })
            if (!captured.some(item => item.sourceId === body.sourceId)) captured.push(body)
            return Response.json({ sourceId: body.sourceId })
          }
          return Response.json({})
        },
      })), server => Effect.sync(() => server.stop(true)))
      process.env.STRATCRAFT_ASSOCIATION_TEST_LEASE = "fixture-lease"
      yield* Effect.addFinalizer(() => Effect.sync(() => { delete process.env.STRATCRAFT_ASSOCIATION_TEST_LEASE }))
      const module = yield* Effect.promise(() => import(filename!))
      const client = { session: { message: ({ path: input }: { path: { id: string; messageID: string } }) => bridge.promise(
        sessions.messages({ sessionID: chat.id }).pipe(Effect.map(messages => ({ data: messages.find(item => item.info.id === input.messageID) }))),
      ) } }
      const hooks = yield* Effect.promise(() => module.StratCraftIdempotency({ client }, {
        orientationUrl: `http://127.0.0.1:${server.port}/orientation`, sourceCaptureUrl: `http://127.0.0.1:${server.port}/source`,
        leaseTokenEnvironmentVariable: "STRATCRAFT_ASSOCIATION_TEST_LEASE",
      }) as Promise<Hooks>)
      const installed = yield* plugin.list()
      let retainedContext: QuestionExecutionContext | undefined
      const oriented = yield* Queue.unbounded<void>()
      installed.push({ ...hooks, event: async input => {
        await hooks.event?.(input)
        if (String(input.event.type) === "question.asked") Queue.offerUnsafe(oriented, undefined)
      } })
      installed.push({ "tool.execute.before": async (_input, output) => {
        const questionOutput: CatalogQuestionBeforeOutput = output as CatalogQuestionBeforeOutput
        retainedContext = questionOutput.questionContext
        if (catalog) {
          expect(Object.isFrozen(output)).toBe(true)
          expect(Object.isFrozen(output.args)).toBe(true)
          expect(Object.isFrozen(questionOutput.questionContext)).toBe(false)
          expect(Reflect.set(output.args.questions[0], "questionId", "forged")).toBe(false)
          expect(Reflect.set(output.args.questions[0].options[0], "optionId", "forged")).toBe(false)
        }
      } })
      const toolInfo = yield* QuestionTool
      const definition = yield* toolInfo.init()
      const tools = yield* SessionTools.resolve({ agent: (yield* agent.get("build"))!, model, session: chat,
        processor: { message: assistant,
          updateToolCall: (_callID, update) => Effect.gen(function* () {
            const current = yield* sessions.getPart({ sessionID: chat.id, messageID: assistant.id, partID: part.id })
            if (!current || current.type !== "tool") throw new Error("Missing question part")
            const next = update(current)
            if (mode === "persistence-failure" && next.state.status === "running" && next.state.metadata?.questionRequestAssociation)
              throw new Error("Injected persistence failure")
            return yield* sessions.updatePart(next)
          }),
          completeToolCall: () => Effect.void,
        }, bypassAgentCheck: false, messages: [], promptOps: {} as never,
      }).pipe(Effect.provide(Layer.mergeAll(
        Layer.mock(ToolRegistry.Service, { tools: () => Effect.succeed([{ id: "question", ...definition }]) }),
        Layer.mock(MCP.Service, { clients: () => Effect.succeed({}), tools: () => Effect.succeed({}) }),
      )))
      const asked = yield* Queue.unbounded<void>()
      const off = yield* events.listen(event => {
        if (event.type === Question.Event.Asked.type) Queue.offerUnsafe(asked, undefined)
        return Effect.void
      })
      yield* Effect.addFinalizer(() => off)
      const args = catalog ? { catalogQuestionIds: ["common-strategy"] }
        : { questions: [{ question: "Choose a strategy", header: "Strategy",
          options: [{ label: "moving-average", description: "Crossovers." }] }] }
      const run = Effect.promise(() => Promise.resolve(tools.question!.execute!(mode === "agent" ? { ...args,
        stratcraftRequirementRequestSourceId: "model-forged", stratcraftRequirementQuestionPurpose: "request",
        questionContext: { requestAssociation: { purpose: "request", sourceId: "model-forged" } },
      } : args,
        { toolCallId: part.callID, messages: [], abortSignal: AbortSignal.any([]) })))
      if (mode === "persistence-failure") {
        expect(Exit.isFailure(yield* run.pipe(Effect.exit))).toBe(true)
        expect(yield* question.list()).toEqual([])
        expect(captured).toEqual([])
        return
      }
      const fiber = yield* run.pipe(Effect.forkScoped)
      yield* Effect.raceFirst(Queue.take(asked), Fiber.join(fiber).pipe(
        Effect.flatMap(() => Effect.die(new Error("Question ended before publication"))),
      )).pipe(Effect.timeout("2 seconds"))
      yield* Queue.take(oriented).pipe(Effect.timeout("2 seconds"))
      const pending = (yield* question.list())[0]!
      const saved = yield* sessions.getPart({ sessionID: chat.id, messageID: assistant.id, partID: part.id })
      expect(saved?.type).toBe("tool")
      if (saved?.type !== "tool" || saved.state.status !== "running" || !saved.state.metadata) throw new Error("Missing saved question")
      expect(saved.state.input).toEqual(args)
      expect(saved.state.metadata.existing).toBe("retained")
      expect(saved.state.metadata.questionRequestAssociation).toEqual(manual ? undefined
        : mode === "scope-selection" ? { purpose: "scope-selection", sourceId: null } : { purpose: "request", sourceId: "original-request" })
      // A plugin retaining its writable context cannot rewrite accepted call attribution.
      if (!retainedContext) throw new Error("Missing native question context")
      if (retainedContext.requestAssociation) {
        expect(Reflect.set(retainedContext.requestAssociation, "sourceId", "mutated-plugin-request")).toBe(true)
      }
      retainedContext.requestAssociation = { purpose: "request", sourceId: "late-plugin-request" }
      expect(saved.state.metadata.questionRequestAssociation).toEqual(manual ? undefined
        : mode === "scope-selection" ? { purpose: "scope-selection", sourceId: null } : { purpose: "request", sourceId: "original-request" })
      sourceId = "later-request"
      yield* question.reply({ requestID: pending.id, answers: [["moving-average"]] })
      const result = yield* Fiber.join(fiber)
      const output = result as { title: string; output: string; metadata: Record<string, unknown> }
      expect(output.metadata.questionRequestAssociation).toEqual(saved.state.metadata.questionRequestAssociation)
      expect(output.metadata.answers).toEqual([["moving-average"]])
      yield* sessions.updatePart({ ...saved, state: { status: "completed", input: saved.state.input, metadata: output.metadata,
        title: output.title, output: output.output, time: { start: saved.state.time.start, end: Date.now() } } })
      const restored = JSON.parse(JSON.stringify(yield* sessions.messages({ sessionID: chat.id })))
      expect(restored.find((item: SessionV1.WithParts) => item.info.id === assistant.id).parts[0].state.metadata.questionRequestAssociation)
        .toEqual(saved.state.metadata.questionRequestAssociation)
      if (mode === "capture-failure") {
        expect(captured).toEqual([])
        expect(output.output).toContain("source capture is pending")
        captureUnavailable = false
        const recovery = yield* Effect.promise(() => module.StratCraftIdempotency({ client }, {
          sourceCaptureUrl: `http://127.0.0.1:${server.port}/source`, leaseTokenEnvironmentVariable: "STRATCRAFT_ASSOCIATION_TEST_LEASE",
        }) as Promise<Hooks>)
        for (let retry = 0; retry < 2; retry++) yield* Effect.promise(() => recovery["tool.execute.after"]!({
          tool: "question", sessionID: chat.id, messageID: assistant.id, callID: part.callID, args,
        }, output))
        expect(captured).toHaveLength(1)
        expect(captured[0]!.requirementAnswers).toMatchObject([{ requestSourceId: "original-request" }])
      } else if (mode === "scope-selection") expect(captured).toEqual([])
      else {
        expect(captured).toHaveLength(1)
        expect(captured[0]!.requirementAnswers).toMatchObject([{ requestSourceId: manual ? expect.stringMatching(/^OCSRC-/) : "original-request" }])
        // A restored plugin captures the original saved call, without fresh orientation.
        const restoredHooks = yield* Effect.promise(() => module.StratCraftIdempotency({ client }, {
          sourceCaptureUrl: `http://127.0.0.1:${server.port}/source`, leaseTokenEnvironmentVariable: "STRATCRAFT_ASSOCIATION_TEST_LEASE",
        }) as Promise<Hooks>)
        yield* Effect.promise(() => restoredHooks["tool.execute.after"]!({ tool: "question", sessionID: chat.id,
          messageID: assistant.id, callID: part.callID, args }, output))
        expect(captured).toHaveLength(1)
      }
      // question.asked also refreshes orientation; answer capture must keep the issued association.
      expect(orientationReads).toBe(manual ? 1 : 2)
      expect(yield* question.list()).toEqual([])
      expect(Exit.isFailure(yield* question.reply({ requestID: pending.id, answers: [["moving-average"]] }).pipe(Effect.exit))).toBe(true)
    }), { init })
  }
})
