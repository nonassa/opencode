import { expect, mock, test } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { tmpdir } from "../fixture/fixture"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "../fixture/tui-sdk"

for (const newer of [false, true]) {
  test(`command refusal preserves ${newer ? "newer draft and stashes refused input" : "original draft"}`, async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const setup = await createTestRenderer({ width: 100, height: 30, useThread: false, kittyKeyboard: true })
    const core = await import("@opentui/core")
    mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
    const provider = {
      id: "fixture",
      name: "Fixture",
      models: { model: { id: "model", name: "Fixture model", capabilities: {}, cost: {}, limit: {} } },
    }
    const agent = { name: "build", mode: "primary", options: {}, permission: [] }
    const session = {
      id: "ses_refusal",
      projectID: "proj_test",
      directory,
      title: "Refusal",
      version: "1",
      time: { created: 1, updated: 1 },
    }
    let refuse!: (response: Response) => void
    let called!: () => void
    const requested = new Promise<void>((resolve) => {
      called = resolve
    })
    const response = new Promise<Response>((resolve) => {
      refuse = resolve
    })
    const events = createEventSource()
    const calls = createFetch((url) => {
      if (url.pathname === "/api/provider")
        return json({ location: { directory, project: { id: "proj_test", directory } }, data: [provider] })
      if (url.pathname === "/api/agent")
        return json({ location: { directory, project: { id: "proj_test", directory } }, data: [agent] })
      if (url.pathname === "/config/providers") return json({ providers: [provider], default: { fixture: "model" } })
      if (url.pathname === "/provider")
        return json({ all: [provider], default: { fixture: "model" }, connected: ["fixture"] })
      if (url.pathname === "/agent") return json([agent])
      if (url.pathname === "/command")
        return json([{ name: "continue", description: "Continue", template: "Continue" }])
      if (url.pathname === "/session/ses_refusal/command") {
        called()
        return response
      }
      if (url.pathname === "/session/ses_refusal") return json(session)
      if (url.pathname.startsWith("/session/ses_refusal/")) return json([])
    }, events)
    const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (new URL(request.url).pathname === "/session" && request.method === "POST")
        return Promise.resolve(json(session))
      return calls.fetch(input, init)
    }) as typeof fetch
    let api: TuiPluginApi | undefined
    let slots: import("../../src/plugin/slots").HostSlots | undefined
    let started!: () => void
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    const { run } = await import("../../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: fetcher,
        events: events.source,
        args: {},
        pluginHost: {
          async start(input) {
            api = input.api
            slots = input.runtime.setupSlots(input.api)
            started()
          },
          async dispose() {
            slots?.dispose()
          },
        },
      }).pipe(Effect.provide(Global.layerWith({ state: tmp.path, data: tmp.path, home: tmp.path }))),
    )
    try {
      await ready
      for (let i = 0; i < 100 && !(setup.renderer.currentFocusedRenderable instanceof TextareaRenderable); i++)
        await Bun.sleep(10)
      for (let i = 0; i < 200; i++) {
        await setup.renderOnce()
        if (setup.captureCharFrame().includes("Fixture model")) break
        await Bun.sleep(10)
      }
      setup.mockInput.pressEscape()
      const prompt = setup.renderer.currentFocusedRenderable
      if (!(prompt instanceof TextareaRenderable)) throw new Error("prompt not focused")
      prompt.insertText("/continue ")
      await setup.renderOnce()
      setup.mockInput.pressEscape()
      setup.mockInput.pressEnter()
      await Promise.race([
        requested,
        Bun.sleep(5000).then(() => {
          throw new Error("command not submitted: " + setup.captureCharFrame())
        }),
      ])
      for (let i = 0; i < 100 && prompt.plainText; i++) await Bun.sleep(10)
      if (newer) prompt.insertText("Newer draft")
      refuse(json({ name: "UnknownError", data: { message: "Continuation refused" } }, { status: 400 }))
      for (let i = 0; i < 100; i++) {
        await setup.renderOnce()
        if (setup.captureCharFrame().includes("Failed to send prompt")) break
        await Bun.sleep(10)
      }
      expect(setup.captureCharFrame()).toContain("Failed to send prompt")
      if (!newer) expect(prompt.plainText).toBe("/continue ")
      if (newer) {
        expect(prompt.plainText).toBe("Newer draft")
        api?.keymap.dispatchCommand("prompt.clear")
        api?.keymap.dispatchCommand("prompt.stash.pop")
        expect(prompt.plainText).toBe("/continue ")
      }
    } finally {
      refuse(json({}))
      api?.keymap.dispatchCommand("prompt.clear")
      api?.keymap.dispatchCommand("app.exit")
      await task
      if (!setup.renderer.isDestroyed) setup.renderer.destroy()
      mock.restore()
    }
  }, 30_000)
}
