/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { TuiPluginApi, TuiPluginMeta } from "@opencode-ai/plugin/tui"
import { testRender, type JSX } from "@opentui/solid"
import SidebarContext from "../../src/feature-plugins/sidebar/context"

test.each([
  { name: "used session", messages: [{ role: "assistant", providerID: "test", modelID: "model", tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 30, write: 0 } } }], tokens: "155 tokens" },
  { name: "empty session", messages: [], tokens: "0 tokens" },
])("sidebar shows token count without percentage or spend for $name", async ({ messages, tokens }) => {
  let view!: (context: unknown, props: { session_id: string }) => JSX.Element
  const api = {
    theme: { current: { text: "white", textMuted: "gray" } },
    state: {
      session: {
        messages: () => messages,
        get: () => ({ cost: 1.25 }),
      },
      provider: { find: () => ({ models: { model: { limit: { context: 1000 } } } }) },
    },
    slots: { register: (plugin: { slots: { sidebar_content: typeof view } }) => { view = plugin.slots.sidebar_content } },
  } as unknown as TuiPluginApi
  await SidebarContext.tui(api, undefined, {} as TuiPluginMeta)

  const app = await testRender(() => view({}, { session_id: "ses_test" }), { width: 40, height: 8 })
  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("Context")
    expect(frame).toContain(tokens)
    expect(frame).not.toContain("used")
    expect(frame).not.toContain("spent")
    expect(frame).not.toContain("%")
    expect(frame).not.toContain("$1.25")
  } finally {
    app.renderer.destroy()
  }
})
