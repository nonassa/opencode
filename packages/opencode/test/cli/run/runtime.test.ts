import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { OpencodeClient } from "@opencode-ai/sdk/v2"
import { runInteractiveMode } from "@/cli/cmd/run/runtime"
import type { FooterApi, RunProvider } from "@/cli/cmd/run/types"
import type { ManagedModelProjection } from "@/cli/cmd/run/managed-model.transport"

type SessionMessage = NonNullable<Awaited<ReturnType<OpencodeClient["session"]["messages"]>>["data"]>[number]

const provider: RunProvider = {
  id: "openai",
  name: "OpenAI",
  source: "api",
  env: [],
  options: {},
  models: {
    "gpt-5": {
      id: "gpt-5",
      providerID: "openai",
      api: {
        id: "openai",
        url: "https://openai.test",
        npm: "@ai-sdk/openai",
      },
      name: "Little Frank",
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: true,
        toolcall: true,
        input: {
          text: true,
          audio: false,
          image: false,
          video: false,
          pdf: false,
        },
        output: {
          text: true,
          audio: false,
          image: false,
          video: false,
          pdf: false,
        },
        interleaved: false,
      },
      cost: {
        input: 0,
        output: 0,
        cache: {
          read: 0,
          write: 0,
        },
      },
      limit: {
        context: 128000,
        output: 8192,
      },
      status: "active",
      options: {},
      headers: {},
      release_date: "2026-01-01",
    },
  },
}

const transportProviders: RunProvider[][] = []

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function ok<T>(data: T) {
  return Promise.resolve({
    data,
    error: undefined,
    request: new Request("https://opencode.test"),
    response: new Response(),
  })
}

function footer(): FooterApi {
  let closed = false
  const closes = new Set<() => void>()

  const notify = () => {
    for (const fn of closes) fn()
  }

  return {
    get isClosed() {
      return closed
    },
    onPrompt: () => () => {},
    onQueuedRemove: () => () => {},
    onClose(fn) {
      if (closed) {
        fn()
        return () => {}
      }

      closes.add(fn)
      return () => {
        closes.delete(fn)
      }
    },
    event() {},
    append() {},
    idle() {
      return Promise.resolve()
    },
    close() {
      if (closed) {
        return
      }

      closed = true
      notify()
    },
    destroy() {
      if (closed) {
        return
      }

      closed = true
      notify()
    },
  }
}

afterEach(() => {
  mock.restore()
  transportProviders.length = 0
})

describe("run interactive runtime", () => {
  test("renders the latest managed model projection before the first session", async () => {
    const events: unknown[] = []
    const previousContentOnly = process.env.OPENCODE_CONFIG_CONTENT_ONLY
    const previousControl = process.env.STRATCRAFT_MANAGED_OPENCODE_CONTROL
    process.env.OPENCODE_CONFIG_CONTENT_ONLY = "1"
    process.env.STRATCRAFT_MANAGED_OPENCODE_CONTROL = "1"
    const sdk = new OpencodeClient()
    spyOn(sdk.config, "providers").mockImplementation(() => ok({ providers: [provider], default: {} }))
    spyOn(sdk.app, "agents").mockImplementation(() => ok([]))
    spyOn(sdk.experimental.resource, "list").mockImplementation(() => ok({}))
    spyOn(sdk.command, "list").mockImplementation(() => ok([]))

    await runInteractiveMode(
      {
        sdk,
        directory: "/tmp",
        sessionID: "",
        resume: false,
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-5" },
        variant: undefined,
        files: [],
        thinking: true,
        backgroundSubagents: false,
      },
      {
        createRuntimeLifecycle: async () => {
          const output = footer()
          output.event = (event) => events.push(event)
          return {
            footer: output,
            onResize: () => () => {},
            refreshTheme: () => {},
            resetForReplay: () => Promise.resolve(),
            close: () => Promise.resolve(),
          }
        },
        managedModelTransport: Promise.resolve({
          subscribeManagedModel: async (input: {
            fetch: typeof globalThis.fetch
            directory: string
            sessionID: () => string
            onProjection: (projection: ManagedModelProjection) => void
            onError?: (error: unknown) => void
          }) => {
            input.onProjection({
              revision: 1,
              next: { providerID: "openrouter", modelID: "google/gemini-3.7-flash" },
            })
            input.onProjection({
              revision: 2,
              current: { providerID: "openrouter", modelID: "deepseek/deepseek-v4-flash" },
              next: { providerID: "openai", modelID: "gpt-5" },
            })
            input.onProjection({
              revision: 1,
              next: { providerID: "openrouter", modelID: "stale/model" },
            })
            return { close: () => Promise.resolve() }
          },
        }),
        streamTransport: Promise.resolve({
          createSessionTransport: async (input: { footer: FooterApi }) => {
            setTimeout(() => input.footer.close(), 0)
            return {
              runPromptTurn: async () => {},
              selectSubagent: () => {},
              replayOnResize: async () => false,
              close: async () => {},
            }
          },
          formatUnknownError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
        }),
      },
    ).finally(() => {
      if (previousContentOnly === undefined) delete process.env.OPENCODE_CONFIG_CONTENT_ONLY
      else process.env.OPENCODE_CONFIG_CONTENT_ONLY = previousContentOnly
      if (previousControl === undefined) delete process.env.STRATCRAFT_MANAGED_OPENCODE_CONTROL
      else process.env.STRATCRAFT_MANAGED_OPENCODE_CONTROL = previousControl
    })

    expect(events).toContainEqual({ type: "model", model: "Little Frank · OpenAI" })
    expect(events).toContainEqual({
      type: "stream.patch",
      patch: { status: "next model openrouter/google/gemini-3.7-flash" },
    })
    expect(events).toContainEqual({
      type: "stream.patch",
      patch: { status: "current model openrouter/deepseek/deepseek-v4-flash; next model openai/gpt-5" },
    })
    expect(JSON.stringify(events)).not.toContain("stale/model")
  })

  test("does not expose managed model synchronization in standalone mode", async () => {
    const previousContentOnly = process.env.OPENCODE_CONFIG_CONTENT_ONLY
    const previousControl = process.env.STRATCRAFT_MANAGED_OPENCODE_CONTROL
    delete process.env.OPENCODE_CONFIG_CONTENT_ONLY
    delete process.env.STRATCRAFT_MANAGED_OPENCODE_CONTROL
    let subscriptions = 0
    const sdk = new OpencodeClient()
    spyOn(sdk.config, "providers").mockImplementation(() => ok({ providers: [provider], default: {} }))
    spyOn(sdk.app, "agents").mockImplementation(() => ok([]))
    spyOn(sdk.experimental.resource, "list").mockImplementation(() => ok({}))
    spyOn(sdk.command, "list").mockImplementation(() => ok([]))

    await runInteractiveMode(
      {
        sdk,
        directory: "/tmp",
        sessionID: "ses-standalone",
        resume: false,
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-5" },
        variant: undefined,
        files: [],
        thinking: true,
        backgroundSubagents: false,
      },
      {
        createRuntimeLifecycle: async () => ({
          footer: footer(),
          onResize: () => () => {},
          refreshTheme: () => {},
          resetForReplay: () => Promise.resolve(),
          close: () => Promise.resolve(),
        }),
        managedModelTransport: Promise.resolve({
          subscribeManagedModel: async () => {
            subscriptions += 1
            return { close: () => Promise.resolve() }
          },
        }),
        streamTransport: Promise.resolve({
          createSessionTransport: async (input: { footer: FooterApi }) => {
            setTimeout(() => input.footer.close(), 0)
            return {
              runPromptTurn: async () => {},
              selectSubagent: () => {},
              replayOnResize: async () => false,
              close: async () => {},
            }
          },
          formatUnknownError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
        }),
      },
    ).finally(() => {
      if (previousContentOnly === undefined) delete process.env.OPENCODE_CONFIG_CONTENT_ONLY
      else process.env.OPENCODE_CONFIG_CONTENT_ONLY = previousContentOnly
      if (previousControl === undefined) delete process.env.STRATCRAFT_MANAGED_OPENCODE_CONTROL
      else process.env.STRATCRAFT_MANAGED_OPENCODE_CONTROL = previousControl
    })

    expect(subscriptions).toBe(0)
  })

  test("waits for provider metadata before eager replay transport bootstrap", async () => {
    const providersStarted = defer<void>()
    const providers = defer<void>()

    const sdk = new OpencodeClient()
    spyOn(sdk.config, "providers").mockImplementation(async () => {
      providersStarted.resolve()
      await providers.promise
      return ok({ providers: [provider], default: {} })
    })
    spyOn(sdk.session, "messages").mockImplementation(() =>
      ok([
        {
          info: {
            id: "msg-user-1",
            sessionID: "ses-1",
            role: "user",
            time: {
              created: 1,
            },
            agent: "build",
            model: {
              providerID: "openai",
              modelID: "gpt-5",
              variant: undefined,
            },
          },
          parts: [
            {
              id: "part-user-1",
              sessionID: "ses-1",
              messageID: "msg-user-1",
              type: "text",
              text: "hello",
            },
          ],
        } satisfies SessionMessage,
      ]),
    )
    spyOn(sdk.session, "get").mockRejectedValue(new Error("not needed"))
    spyOn(sdk.app, "agents").mockImplementation(() => ok([]))
    spyOn(sdk.experimental.resource, "list").mockImplementation(() => ok({}))
    spyOn(sdk.command, "list").mockImplementation(() => ok([]))

    const task = runInteractiveMode(
      {
        sdk,
        directory: "/tmp",
        sessionID: "ses-1",
        sessionTitle: "Session",
        resume: true,
        replay: true,
        replayLimit: 100,
        agent: "build",
        model: {
          providerID: "openai",
          modelID: "gpt-5",
        },
        variant: undefined,
        files: [],
        thinking: true,
        backgroundSubagents: false,
      },
      {
        createRuntimeLifecycle: async () => ({
          footer: footer(),
          onResize: () => () => {},
          refreshTheme: () => {},
          resetForReplay: () => Promise.resolve(),
          close: () => Promise.resolve(),
        }),
        streamTransport: Promise.resolve({
          createSessionTransport: async (input: { providers?: () => RunProvider[]; footer: FooterApi }) => {
            transportProviders.push(input.providers?.() ?? [])
            setTimeout(() => {
              input.footer.close()
            }, 0)
            return {
              runPromptTurn: async () => {},
              selectSubagent: () => {},
              replayOnResize: async () => false,
              close: async () => {},
            }
          },
          formatUnknownError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
        }),
      },
    )

    await providersStarted.promise

    expect(transportProviders).toEqual([])

    providers.resolve()

    await task

    expect(transportProviders).toEqual([[provider]])
  })
})
