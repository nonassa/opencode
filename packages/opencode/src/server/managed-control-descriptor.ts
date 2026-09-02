import path from "node:path"
import { unlink, writeFile } from "node:fs/promises"

export const MANAGED_CONTROL_DESCRIPTOR_ENV = "STRATCRAFT_MANAGED_OPENCODE_CONTROL_DESCRIPTOR"

export async function writeManagedControlDescriptor(url: URL): Promise<string | undefined> {
  const descriptorPath = process.env[MANAGED_CONTROL_DESCRIPTOR_ENV]
  if (!descriptorPath) return
  if (process.env.OPENCODE_CONFIG_CONTENT_ONLY !== "1" || process.env.STRATCRAFT_MANAGED_OPENCODE_CONTROL !== "1")
    throw new Error("Managed OpenCode control descriptor requires the managed content-only runtime")
  if (!path.isAbsolute(descriptorPath)) throw new Error("Managed OpenCode control descriptor path must be absolute")
  if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost"))
    throw new Error("Managed OpenCode control endpoint must be loopback HTTP")
  await writeFile(
    descriptorPath,
    JSON.stringify({ version: 1, origin: url.origin, pid: process.pid }),
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  )
  return descriptorPath
}

export async function removeManagedControlDescriptor(descriptorPath: string | undefined): Promise<void> {
  if (!descriptorPath) return
  await unlink(descriptorPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
  })
}
