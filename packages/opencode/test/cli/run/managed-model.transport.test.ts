import { expect, test } from "bun:test"
import { subscribeManagedModel, type ManagedModelProjection } from "@/cli/cmd/run/managed-model.transport"

function sse(projection: ManagedModelProjection) {
  return new Response(`event: model\nid: ${projection.revision}\ndata: ${JSON.stringify(projection)}\n\n`, {
    headers: { "content-type": "text/event-stream" },
  })
}

test("reads the authoritative pre-session snapshot without exposing credentials", async () => {
  const received: ManagedModelProjection[] = []
  const request = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input instanceof Request ? input.url : input.toString()).toBe(
        "http://opencode.internal/managed/model/events",
      )
      expect(init?.headers).toEqual({ "x-opencode-directory": "/workspace" })
      return sse({ revision: 3, next: { providerID: "openrouter", modelID: "openai/gpt-5.6-luna" } })
    },
    { preconnect() {} },
  )
  const subscription = await subscribeManagedModel({
    fetch: request,
    directory: "/workspace",
    sessionID: () => "",
    onProjection: (projection) => received.push(projection),
  })

  while (received.length === 0) await Bun.sleep(1)
  await subscription.close()

  expect(received[0]).toEqual({
    revision: 3,
    next: { providerID: "openrouter", modelID: "openai/gpt-5.6-luna" },
  })
  expect(JSON.stringify(received)).not.toContain("secret")
})

test("binds a reconnected stream to the current session identity", async () => {
  const urls: string[] = []
  const request = Object.assign(
    async (input: RequestInfo | URL) => {
      urls.push(input instanceof Request ? input.url : input.toString())
      return sse({
        revision: 4,
        current: { providerID: "openrouter", modelID: "deepseek/deepseek-v4-flash" },
        next: { providerID: "openrouter", modelID: "openai/gpt-5.6-luna" },
      })
    },
    { preconnect() {} },
  )
  const subscription = await subscribeManagedModel({
    fetch: request,
    directory: "/workspace",
    sessionID: () => "ses_current",
    onProjection: () => {},
  })

  while (urls.length === 0) await Bun.sleep(1)
  await subscription.close()

  expect(urls[0]).toBe("http://opencode.internal/managed/model/events?sessionID=ses_current")
})
