import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  MANAGED_CONTROL_DESCRIPTOR_ENV,
  removeManagedControlDescriptor,
  writeManagedControlDescriptor,
} from "../../src/server/managed-control-descriptor"

const original = { ...process.env }
afterEach(() => {
  process.env = { ...original }
})

describe("managed control descriptor", () => {
  test("writes only a mode-0600 loopback descriptor without the control credential", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-control-"))
    const descriptor = path.join(directory, "control.json")
    process.env[MANAGED_CONTROL_DESCRIPTOR_ENV] = descriptor
    process.env.OPENCODE_CONFIG_CONTENT_ONLY = "1"
    process.env.STRATCRAFT_MANAGED_OPENCODE_CONTROL = "1"
    process.env.OPENCODE_SERVER_PASSWORD = "never-write-this-token"
    try {
      expect(await writeManagedControlDescriptor(new URL("http://127.0.0.1:4321"))).toBe(descriptor)
      const content = await readFile(descriptor, "utf8")
      expect(JSON.parse(content)).toMatchObject({ version: 1, origin: "http://127.0.0.1:4321" })
      expect(content).not.toContain("never-write-this-token")
      expect((await stat(descriptor)).mode & 0o777).toBe(0o600)
      await removeManagedControlDescriptor(descriptor)
      await expect(stat(descriptor)).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("rejects non-loopback and non-managed publication", async () => {
    process.env[MANAGED_CONTROL_DESCRIPTOR_ENV] = path.join(os.tmpdir(), "unused-control.json")
    await expect(writeManagedControlDescriptor(new URL("http://127.0.0.1:4321"))).rejects.toThrow("managed content-only")
    process.env.OPENCODE_CONFIG_CONTENT_ONLY = "1"
    process.env.STRATCRAFT_MANAGED_OPENCODE_CONTROL = "1"
    await expect(writeManagedControlDescriptor(new URL("https://example.com"))).rejects.toThrow("loopback HTTP")
  })
})
