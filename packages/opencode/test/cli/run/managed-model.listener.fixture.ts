import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { subscribeManagedModel, type ManagedModelProjection } from "@/cli/cmd/run/managed-model.transport"
import { Server } from "@/server/server"
import { disposeAllInstances } from "../../fixture/fixture"

const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-managed-model-listener-"))
process.env.OPENCODE_CONFIG_CONTENT_ONLY = "1"
process.env.OPENCODE_CONFIG_CONTENT = "{}"
process.env.STRATCRAFT_MANAGED_OPENCODE_CONTROL = "1"
process.env.OPENCODE_SERVER_PASSWORD = ""
const received: ManagedModelProjection[] = []
const listener = await Server.listen({ port: 0, hostname: "127.0.0.1" })
let subscription: Awaited<ReturnType<typeof subscribeManagedModel>> | undefined

try {
  subscription = await subscribeManagedModel({
    fetch,
    origin: listener.url,
    directory,
    sessionID: () => "",
    onProjection: (projection) => received.push(projection),
  })
  const response = await fetch(new URL("/managed/model", listener.url), {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencode-directory": directory },
    body: JSON.stringify({
      providerID: "openrouter",
      modelID: "google/gemini-3.7-flash",
      protocol: "openai-compatible",
      baseURL: "https://openrouter.ai/api/v1",
    }),
  })
  if (!response.ok) throw new Error(`Managed model transition failed (${response.status}).`)
  await Promise.race([
    (async () => {
      while (!received.some((projection) => projection.revision === 1)) await Bun.sleep(1)
    })(),
    Bun.sleep(2_000).then(() => {
      throw new Error(`Managed subscriber remained at revisions ${received.map((item) => item.revision).join(",")}.`)
    }),
  ])
  process.stdout.write(`${JSON.stringify(received)}\n`)
} finally {
  await subscription?.close()
  await listener.stop(true)
  await disposeAllInstances()
  await rm(directory, { recursive: true, force: true })
}

process.exit(0)
