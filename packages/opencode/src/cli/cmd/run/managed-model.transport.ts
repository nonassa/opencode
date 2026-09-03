export type ManagedModelRef = Readonly<{ providerID: string; modelID: string }>

export type ManagedModelProjection = Readonly<{
  revision: number
  current?: ManagedModelRef
  next?: ManagedModelRef
}>

export type ManagedModelSubscription = Readonly<{ close: () => Promise<void> }>

export async function subscribeManagedModel(input: {
  fetch: typeof globalThis.fetch
  directory: string
  sessionID: () => string
  onProjection: (projection: ManagedModelProjection) => void
  onError?: (error: unknown) => void
}): Promise<ManagedModelSubscription> {
  const controller = new AbortController()
  const headers = { "x-opencode-directory": input.directory }
  const run = async () => {
    while (!controller.signal.aborted) {
      try {
        const url = new URL("http://opencode.internal/managed/model/events")
        const sessionID = input.sessionID()
        if (sessionID) url.searchParams.set("sessionID", sessionID)
        const response = await input.fetch(url, { headers, signal: controller.signal })
        if (!response.ok || !response.body) throw new Error(`Managed model state stream failed (${response.status}).`)
        await readEvents(response.body, input.onProjection, controller.signal)
      } catch (error) {
        if (controller.signal.aborted) return
        input.onError?.(error)
      }
      if (!controller.signal.aborted) await Bun.sleep(250)
    }
  }
  const task = run()
  return {
    close: async () => {
      controller.abort()
      await task
    },
  }
}

async function readEvents(
  body: ReadableStream<Uint8Array>,
  onProjection: (projection: ManagedModelProjection) => void,
  signal: AbortSignal,
) {
  const reader = body.getReader()
  const cancel = () => void reader.cancel()
  signal.addEventListener("abort", cancel, { once: true })
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (!signal.aborted) {
      const item = await reader.read()
      if (item.done) return
      buffer += decoder.decode(item.value, { stream: true })
      const events = buffer.split("\n\n")
      buffer = events.pop() ?? ""
      for (const event of events) {
        const data = event
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice("data: ".length)
        if (data) onProjection(parseProjection(JSON.parse(data)))
      }
    }
  } finally {
    signal.removeEventListener("abort", cancel)
    reader.releaseLock()
  }
}

function parseProjection(input: unknown): ManagedModelProjection {
  if (!isRecord(input)) throw new Error("Managed model projection must be an object.")
  if (typeof input.revision !== "number" || !Number.isInteger(input.revision) || input.revision < 0)
    throw new Error("Managed model projection revision is invalid.")
  const ref = (candidate: unknown): ManagedModelRef | undefined => {
    if (candidate === undefined) return undefined
    if (!isRecord(candidate)) throw new Error("Managed model projection ref is invalid.")
    if (typeof candidate.providerID !== "string" || typeof candidate.modelID !== "string")
      throw new Error("Managed model projection ref is invalid.")
    return { providerID: candidate.providerID, modelID: candidate.modelID }
  }
  const current = ref(input.current)
  const next = ref(input.next)
  return {
    revision: input.revision,
    ...(current ? { current } : {}),
    ...(next ? { next } : {}),
  }
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return !!input && typeof input === "object" && !Array.isArray(input)
}
