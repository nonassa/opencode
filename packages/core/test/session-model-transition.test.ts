import { describe, expect } from "bun:test"
import { Model } from "@opencode-ai/llm"
import { OpenAIChat } from "@opencode-ai/llm/protocols/openai-chat"
import { Effect, Fiber, Option, Stream } from "effect"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionModelTransition } from "@opencode-ai/core/session/model-transition"
import { SessionV2 } from "@opencode-ai/core/session"
import { testEffect } from "./lib/effect"

const it = testEffect(SessionModelTransition.layer)
const sessionID = SessionV2.ID.make("ses_managed_transition")
const first = {
  model: Model.make({ id: "first", provider: "stratcraft-integrated", route: OpenAIChat.route }),
  ref: ModelV2.Ref.make({
    id: ModelV2.ID.make("first"),
    providerID: ProviderV2.ID.make("stratcraft-integrated"),
  }),
} satisfies SessionModelTransition.Target
const second = {
  model: Model.make({ id: "second", provider: "stratcraft-integrated", route: OpenAIChat.route }),
  ref: ModelV2.Ref.make({
    id: ModelV2.ID.make("second"),
    providerID: ProviderV2.ID.make("stratcraft-integrated"),
  }),
} satisfies SessionModelTransition.Target
const latest = {
  model: Model.make({ id: "latest", provider: "stratcraft-integrated", route: OpenAIChat.route }),
  ref: ModelV2.Ref.make({
    id: ModelV2.ID.make("latest"),
    providerID: ProviderV2.ID.make("stratcraft-integrated"),
  }),
} satisfies SessionModelTransition.Target

describe("SessionModelTransition", () => {
  it.effect("projects the latest managed default before a session exists without credentials", () =>
    Effect.gen(function* () {
      const transitions = yield* SessionModelTransition.Service

      expect(yield* transitions.snapshot()).toEqual({ revision: 0 })
      const firstRevision = yield* transitions.queueDefault(first)
      const latestRevision = yield* transitions.queueDefault(latest)

      expect(firstRevision).toBe(1)
      expect(latestRevision).toBe(2)
      expect(yield* transitions.snapshot()).toEqual({ revision: 2, next: latest.ref })
      expect(JSON.stringify(yield* transitions.snapshot())).not.toContain("route")
    }),
  )

  it.effect("distinguishes the current provider turn from the queued next target", () =>
    Effect.gen(function* () {
      const transitions = yield* SessionModelTransition.Service
      yield* transitions.queueDefault(first)
      const applied = yield* transitions.apply(sessionID)
      yield* transitions.queueDefault(latest)

      expect(applied?.revision).toBe(1)
      expect(yield* transitions.snapshot(sessionID)).toEqual({
        revision: 2,
        current: first.ref,
        next: latest.ref,
      })
    }),
  )

  it.effect("publishes each successful authoritative projection revision", () =>
    Effect.gen(function* () {
      const transitions = yield* SessionModelTransition.Service
      yield* transitions.queueDefault(second)
      const next = yield* Stream.runHead(transitions.changes()).pipe(Effect.forkChild)

      expect(Option.getOrThrow(yield* Fiber.join(next))).toEqual({ revision: 1, next: second.ref })
    }),
  )

  it.effect("retains the applied model for later provider turns", () =>
    Effect.gen(function* () {
      const transitions = yield* SessionModelTransition.Service
      yield* transitions.queue({ sessionID, target: first })

      expect((yield* transitions.apply(sessionID))?.ref).toEqual(first.ref)
      expect(String((yield* transitions.current(sessionID))?.id)).toBe("first")
      expect(yield* transitions.apply(sessionID)).toBeUndefined()
    }),
  )

  it.effect("coalesces pending changes to the latest complete target", () =>
    Effect.gen(function* () {
      const transitions = yield* SessionModelTransition.Service
      yield* transitions.queue({ sessionID, target: first })
      yield* transitions.queue({ sessionID, target: second })
      yield* transitions.queue({ sessionID, target: latest })

      expect((yield* transitions.apply(sessionID))?.ref).toEqual(latest.ref)
      expect(String((yield* transitions.current(sessionID))?.id)).toBe("latest")
    }),
  )

  it.effect("isolates current and pending models by exact session", () =>
    Effect.gen(function* () {
      const transitions = yield* SessionModelTransition.Service
      const other = SessionV2.ID.make("ses_other_transition")
      yield* transitions.queue({ sessionID, target: first })
      yield* transitions.queue({ sessionID: other, target: second })

      expect((yield* transitions.apply(sessionID))?.ref).toEqual(first.ref)
      expect((yield* transitions.apply(other))?.ref).toEqual(second.ref)
      expect(String((yield* transitions.current(sessionID))?.id)).toBe("first")
      expect(String((yield* transitions.current(other))?.id)).toBe("second")
    }),
  )

  it.effect("does not reapply a workspace default after another session queues an exact target", () =>
    Effect.gen(function* () {
      const transitions = yield* SessionModelTransition.Service
      const other = SessionV2.ID.make("ses_other_exact_transition")
      yield* transitions.queueDefault(first)
      yield* transitions.apply(sessionID)

      yield* transitions.queue({ sessionID: other, target: second })

      expect(yield* transitions.apply(sessionID)).toBeUndefined()
      expect((yield* transitions.apply(other))?.ref).toEqual(second.ref)
    }),
  )

  it.effect("clears credential-bearing state for a closed session", () =>
    Effect.gen(function* () {
      const transitions = yield* SessionModelTransition.Service
      yield* transitions.queue({ sessionID, target: first })
      yield* transitions.apply(sessionID)
      yield* transitions.queue({ sessionID, target: second })

      yield* transitions.clear(sessionID)

      expect(yield* transitions.current(sessionID)).toBeUndefined()
      expect(yield* transitions.apply(sessionID)).toBeUndefined()
    }),
  )

  it.effect("applies a managed process default once at each session run boundary", () =>
    Effect.gen(function* () {
      const transitions = yield* SessionModelTransition.Service
      const other = SessionV2.ID.make("ses_default_other")
      yield* transitions.queueDefault(first)

      expect((yield* transitions.apply(sessionID))?.ref).toEqual(first.ref)
      expect(yield* transitions.apply(sessionID)).toBeUndefined()
      expect((yield* transitions.apply(other))?.ref).toEqual(first.ref)

      yield* transitions.queueDefault(second)
      expect((yield* transitions.apply(sessionID))?.ref).toEqual(second.ref)
      expect((yield* transitions.apply(other))?.ref).toEqual(second.ref)
    }),
  )
})
