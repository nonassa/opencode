/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { onCleanup } from "solid-js"
import type { QuestionRequest } from "@opencode-ai/sdk/v2"
import { QuestionPrompt } from "../../../src/routes/session/question"
import { SDKProvider } from "../../../src/context/sdk"
import { KVProvider } from "../../../src/context/kv"
import { ThemeProvider } from "../../../src/context/theme"
import { TuiConfigProvider } from "../../../src/config"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { eventSource, json } from "../../fixture/tui-sdk"
import { tmpdir } from "../../fixture/fixture"

async function mount(root: string, input: { questions: QuestionRequest["questions"]; fail?: boolean; full?: boolean }) {
  await Bun.write(`${root}/kv.json`, "{}")
  const calls: { path: string; directory: string | null; body: unknown }[] = []
  const fetcher = (async (value: RequestInfo | URL, init?: RequestInit) => {
    const request = value instanceof Request ? value : new Request(value, init)
    const url = new URL(request.url)
    calls.push({
      path: url.pathname,
      directory: url.searchParams.get("directory"),
      body: await request.json().catch(() => null),
    })
    return input.fail && calls.length === 1 ? json({ message: "Unavailable" }, { status: 503 }) : json(true)
  }) as typeof fetch
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts directory={root} paths={{ state: root, home: root, worktree: root }}>
        <SDKProvider url="http://test" directory={root} fetch={fetcher} events={eventSource()}>
          <OpencodeKeymapProvider keymap={keymap}>
            <TuiConfigProvider config={config}>
              <KVProvider>
                <ThemeProvider mode="dark" source={{ discover: async () => ({}) }}>
                  <QuestionPrompt
                    directory={root}
                    request={{
                      id: "que_legacy_empty",
                      sessionID: "ses_original",
                      questions: input.questions,
                      tool: { messageID: "msg_original", callID: "call_original" },
                      orientation: input.full
                        ? Array.from({ length: 3 }, (_, section) => ({
                            sectionId: `section-${section}`,
                            label: `Catalog section ${section}`,
                            items: Array.from({ length: section === 0 ? 6 : 5 }, (_, item) => ({
                              itemId: `item-${section}-${item}`,
                              label: `Algorithm ${section}-${item}`,
                              description: "Public algorithm description.",
                            })),
                          }))
                        : [
                            {
                              sectionId: "people",
                              label: "People and strategies",
                              items: [
                                {
                                  itemId: "one",
                                  label: "Public examples",
                                  description: "Explore existing algorithms.",
                                },
                              ],
                            },
                          ],
                    }}
                  />
                </ThemeProvider>
              </KVProvider>
            </TuiConfigProvider>
          </OpencodeKeymapProvider>
        </SDKProvider>
      </TestTuiContexts>
    )
  }
  const app = await testRender(() => <Harness />, { width: 110, height: input.full ? 24 : 45, kittyKeyboard: true })
  return { app, calls }
}

async function settle(app: Awaited<ReturnType<typeof testRender>>, predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    await app.renderOnce()
    if (predicate()) return
    await Bun.sleep(10)
  }
  throw new Error("Question did not settle: " + app.captureCharFrame())
}

test("1772 retained empty prompt rejects the exact request and never offers confirmation", async () => {
  await using root = await tmpdir()
  const { app, calls } = await mount(root.path, { questions: [] })
  try {
    await settle(app, () => calls.length > 0)
    expect(app.captureCharFrame()).not.toContain("Confirm")
    expect(app.captureCharFrame()).not.toContain("Review")
    expect(calls).toEqual([{ path: "/question/que_legacy_empty/reject", directory: root.path, body: null }])
    app.mockInput.pressEnter()
    await app.renderOnce()
    expect(calls).toHaveLength(1)
  } finally {
    app.renderer.destroy()
  }
})

test("1772 failed legacy rejection offers retry with the same identity", async () => {
  await using root = await tmpdir()
  const { app, calls } = await mount(root.path, { questions: [], fail: true })
  try {
    await settle(app, () => app.captureCharFrame().includes("retry"))
    app.mockInput.pressEscape()
    await settle(app, () => calls.length === 2)
    expect(calls[1]).toEqual(calls[0])
    expect(calls.every((call) => call.path.endsWith("/reject"))).toBe(true)
    expect(app.captureCharFrame()).not.toContain("Confirm")
  } finally {
    app.renderer.destroy()
  }
})

test("1772 catalog prompt displays existing orientation and submits stable option identity", async () => {
  await using root = await tmpdir()
  const { app, calls } = await mount(root.path, {
    questions: [
      {
        questionId: "authoring-path",
        question: "How would you like to continue?",
        header: "How to continue",
        custom: true,
        options: [
          { optionId: "browse-public-algorithms", label: "Browse public algorithms", description: "Choose a library." },
          {
            optionId: "recommend-starting-point",
            label: "Recommend a starting point",
            description: "Propose a public example.",
          },
        ],
      },
    ],
  })
  try {
    await settle(app, () => app.captureCharFrame().includes("Browse public algorithms"))
    const frame = app.captureCharFrame()
    expect(frame).toContain("People and strategies")
    expect(frame.indexOf("People and strategies")).toBeLessThan(frame.indexOf("How would you like to continue?"))
    expect(frame).toContain("Recommend a starting point")
    expect(frame).toContain("Type your own answer")
    expect(calls).toEqual([])
    app.mockInput.pressKey("1")
    await settle(app, () => calls.length === 1)
    expect(calls[0]).toEqual({
      path: "/question/que_legacy_empty/reply",
      directory: root.path,
      body: { answers: [["browse-public-algorithms"]] },
    })
  } finally {
    app.renderer.destroy()
  }
})

test("1772 full orientation preserves visible native choices in a short terminal", async () => {
  await using root = await tmpdir()
  const { app, calls } = await mount(root.path, {
    full: true,
    questions: [
      {
        question: "How would you like to continue?",
        header: "Start",
        custom: true,
        options: [
          { optionId: "browse-public-algorithms", label: "Browse public algorithms", description: "Browse next." },
        ],
      },
    ],
  })
  try {
    await settle(app, () => app.captureCharFrame().includes("How would you like to continue?"))
    expect(app.captureCharFrame()).toContain("Browse public algorithms")
    expect(app.captureCharFrame()).toContain("Type your own answer")
    app.mockInput.pressKey("1")
    await settle(app, () => calls.length === 1)
    expect(calls[0].body).toEqual({ answers: [["browse-public-algorithms"]] })
  } finally {
    app.renderer.destroy()
  }
})

test("1772 full orientation keeps native custom input usable", async () => {
  await using root = await tmpdir()
  const { app, calls } = await mount(root.path, {
    full: true,
    questions: [
      {
        question: "How would you like to continue?",
        header: "Start",
        custom: true,
        options: [
          { optionId: "browse-public-algorithms", label: "Browse public algorithms", description: "Browse next." },
        ],
      },
    ],
  })
  try {
    await settle(app, () => app.captureCharFrame().includes("Type your own answer"))
    app.mockInput.pressKey("2")
    await settle(app, () => Boolean(app.renderer.currentFocusedEditor))
    await app.mockInput.typeText("Start with moving averages")
    app.mockInput.pressEnter()
    await settle(app, () => calls.length === 1)
    expect(calls[0].body).toEqual({ answers: [["Start with moving averages"]] })
    expect(app.captureCharFrame()).toContain("How would you like to continue?")
  } finally {
    app.renderer.destroy()
  }
})
