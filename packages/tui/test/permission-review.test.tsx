import { expect, mock, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { tmpdir } from "./fixture/fixture"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "./fixture/tui-sdk"

test("exact algorithm review shows its full input and only offers one-action approval", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const setup = await createTestRenderer({ width: 120, height: 40, useThread: false, kittyKeyboard: true })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const calls = createFetch()
  const replies: unknown[] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (request.method !== "POST") return calls.fetch(input, init)
    replies.push({ path: new URL(request.url).pathname, body: JSON.parse(await request.text()) })
    return json(true)
  }) as typeof globalThis.fetch
  const events = createEventSource()
  let api: TuiPluginApi | undefined
  let started!: () => void
  const ready = new Promise<void>((resolve) => { started = resolve })
  const { run } = await import("../src/app")
  const task = Effect.runPromise(run({
    url: "http://test", directory, config: createTuiResolvedConfig({ plugin_enabled: {} }),
    fetch, events: events.source, args: {},
    pluginHost: { async start(input) { api = input.api; started() }, async dispose() {} },
  }).pipe(Effect.provide(Global.layerWith({ state: tmp.path, data: tmp.path, home: tmp.path }))))
  try {
    await ready
    await Bun.sleep(600)
    const { LocationProvider } = await import("../src/context/location")
    const { PermissionPrompt } = await import("../src/routes/session/permission")
    const request = {
      id: "per_algorithm_review", sessionID: "ses_algorithm_review",
      permission: "stratforge_apply_strategy_authoring_requirement_review",
      patterns: ["call-1"], always: [],
      metadata: { requiresExactReview: true, input: {
        strategy_project_id: "current-project", objective: "Keep the grid and add an RSI buy filter.",
        review: { preservedRequirement: "Grid levels remain unchanged", sourceText: "Add to current algorithm",
          requirements: Array.from({ length: 50 }, (_, i) => `Preserve rule ${i}`),
          finalConsequence: "Keep the existing algorithm intact" },
      } },
    }
    api!.route.register([{ name: "exact-review", render: () => (
      <LocationProvider location={{ directory }}><PermissionPrompt request={request} directory={directory} /></LocationProvider>
    ) }])
    api!.ui.dialog.clear()
    api!.route.navigate("exact-review")
    await Bun.sleep(50)
    await setup.renderOnce()
    await setup.renderOnce()
    const frame = setup.captureCharFrame().replace(/\s+/g, " ")
    expect(frame).toContain("Keep the grid and add an RSI buy filter.")
    expect(frame).toContain("Grid levels remain unchanged")
    expect(frame).toContain("current-project")
    expect(frame).not.toContain("Allow always")
    expect(frame).not.toContain("Keep the existing algorithm intact")
    for (let i = 0; i < 80; i++) setup.mockInput.pressArrow("down")
    await Bun.sleep(50)
    await setup.renderOnce()
    expect(setup.captureCharFrame().replace(/\s+/g, " ")).toContain("Keep the existing algorithm intact")
    expect(replies).toEqual([])
    setup.mockInput.pressEnter()
    await Bun.sleep(50)
    expect(replies).toEqual([{ path: "/permission/per_algorithm_review/reply", body: { reply: "once" } }])
  } finally {
    setup.renderer.destroy()
    await task
    mock.restore()
  }
}, 10000)
