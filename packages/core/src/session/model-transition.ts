export * as SessionModelTransition from "./model-transition"

import type { Model } from "@opencode-ai/llm"
import { Context, Effect, Layer, Queue, Stream } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { ModelV2 } from "../model"
import { SessionSchema } from "./schema"

export type Target = Readonly<{
  model: Model
  ref: ModelV2.Ref
}>

export type Applied = Target & Readonly<{ revision: number }>

export type Projection = Readonly<{
  revision: number
  current?: ModelV2.Ref
  next?: ModelV2.Ref
}>

export interface Interface {
  readonly queue: (input: { readonly sessionID: SessionSchema.ID; readonly target: Target }) => Effect.Effect<number>
  readonly queueDefault: (target: Target) => Effect.Effect<number>
  readonly apply: (sessionID: SessionSchema.ID) => Effect.Effect<Applied | undefined>
  readonly current: (sessionID: SessionSchema.ID) => Effect.Effect<Model | undefined>
  readonly clear: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly snapshot: (sessionID?: SessionSchema.ID) => Effect.Effect<Projection>
  readonly changes: (sessionID?: SessionSchema.ID) => Stream.Stream<Projection>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionModelTransition") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const current = new Map<SessionSchema.ID, Applied>()
    const pending = new Map<SessionSchema.ID, Applied>()
    const appliedDefaultRevision = new Map<SessionSchema.ID, number>()
    const changed = new Set<() => void>()
    let defaultTarget: Applied | undefined
    let revision = 0
    const snapshot = (sessionID?: SessionSchema.ID): Projection => {
      const applied = sessionID ? current.get(sessionID) : undefined
      const exact = sessionID ? pending.get(sessionID) : undefined
      const next =
        exact ??
        (sessionID && appliedDefaultRevision.get(sessionID) === defaultTarget?.revision ? undefined : defaultTarget)
      return {
        revision,
        ...(applied ? { current: applied.ref } : {}),
        ...(next ? { next: next.ref } : {}),
      }
    }
    const publish = () => Effect.sync(() => changed.forEach((listener) => listener()))
    return Service.of({
      queue: (input) =>
        Effect.gen(function* () {
          revision += 1
          pending.set(input.sessionID, { revision, ...input.target })
          yield* publish()
          return revision
        }),
      queueDefault: (target) =>
        Effect.gen(function* () {
          revision += 1
          defaultTarget = { revision, ...target }
          yield* publish()
          return revision
        }),
      apply: (sessionID) =>
        Effect.gen(function* () {
          const exact = pending.get(sessionID)
          const target =
            exact ?? (appliedDefaultRevision.get(sessionID) === defaultTarget?.revision ? undefined : defaultTarget)
          if (!target) return undefined
          current.set(sessionID, target)
          pending.delete(sessionID)
          if (!exact) appliedDefaultRevision.set(sessionID, target.revision)
          yield* publish()
          return target
        }),
      current: (sessionID) => Effect.sync(() => current.get(sessionID)?.model),
      clear: (sessionID) =>
        Effect.gen(function* () {
          current.delete(sessionID)
          pending.delete(sessionID)
          appliedDefaultRevision.delete(sessionID)
          yield* publish()
        }),
      snapshot: (sessionID) => Effect.sync(() => snapshot(sessionID)),
      changes: (sessionID) =>
        Stream.callback<Projection>((queue) => {
          const listener = () => Queue.offerUnsafe(queue, snapshot(sessionID))
          return Effect.acquireRelease(
            Effect.sync(() => {
              changed.add(listener)
              listener()
            }),
            () => Effect.sync(() => changed.delete(listener)),
          )
        }),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [] })
