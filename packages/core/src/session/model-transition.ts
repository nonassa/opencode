export * as SessionModelTransition from "./model-transition"

import type { Model } from "@opencode-ai/llm"
import { Context, Effect, Layer } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { ModelV2 } from "../model"
import { SessionSchema } from "./schema"

export type Target = Readonly<{
  model: Model
  ref: ModelV2.Ref
}>

export interface Interface {
  readonly queue: (input: { readonly sessionID: SessionSchema.ID; readonly target: Target }) => Effect.Effect<void>
  readonly queueDefault: (target: Target) => Effect.Effect<void>
  readonly apply: (sessionID: SessionSchema.ID) => Effect.Effect<Target | undefined>
  readonly current: (sessionID: SessionSchema.ID) => Effect.Effect<Model | undefined>
  readonly clear: (sessionID: SessionSchema.ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionModelTransition") {}

export const layer = Layer.sync(Service, () => {
  const current = new Map<SessionSchema.ID, Target>()
  const pending = new Map<SessionSchema.ID, Target>()
  const appliedDefaultRevision = new Map<SessionSchema.ID, number>()
  let defaultTarget: Target | undefined
  let defaultRevision = 0
  return Service.of({
    queue: (input) => Effect.sync(() => pending.set(input.sessionID, input.target)).pipe(Effect.asVoid),
    queueDefault: (target) =>
      Effect.sync(() => {
        defaultTarget = target
        defaultRevision += 1
      }),
    apply: (sessionID) =>
      Effect.sync(() => {
        const exact = pending.get(sessionID)
        const target = exact ?? (appliedDefaultRevision.get(sessionID) === defaultRevision ? undefined : defaultTarget)
        if (!target) return
        current.set(sessionID, target)
        pending.delete(sessionID)
        if (!exact) appliedDefaultRevision.set(sessionID, defaultRevision)
        return target
      }),
    current: (sessionID) => Effect.sync(() => current.get(sessionID)?.model),
    clear: (sessionID) =>
      Effect.sync(() => {
        current.delete(sessionID)
        pending.delete(sessionID)
        appliedDefaultRevision.delete(sessionID)
      }),
  })
})

export const node = makeLocationNode({ service: Service, layer, deps: [] })
