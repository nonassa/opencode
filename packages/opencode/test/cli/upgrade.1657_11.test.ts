import { afterEach, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { Config } from "../../src/config/config"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Installation } from "../../src/installation"
import { GlobalBus } from "../../src/bus/global"
import { upgrade } from "../../src/cli/upgrade"
import { UpgradeCommand } from "../../src/cli/cmd/upgrade"

const originalContent = process.env.OPENCODE_CONFIG_CONTENT
const originalOnly = process.env.OPENCODE_CONFIG_CONTENT_ONLY
const originalDisabled = Flag.OPENCODE_DISABLE_AUTOUPDATE
const originalNotify = Flag.OPENCODE_ALWAYS_NOTIFY_UPDATE
const globalFile = path.join(Global.Path.config, "opencode.jsonc")
const originalGlobal = await Bun.file(globalFile)
  .text()
  .catch(() => undefined)
const spies: Array<{ mockRestore(): void }> = []

afterEach(async () => {
  for (const spy of spies.splice(0)) spy.mockRestore()
  Flag.OPENCODE_DISABLE_AUTOUPDATE = originalDisabled
  Flag.OPENCODE_ALWAYS_NOTIFY_UPDATE = originalNotify
  if (originalContent === undefined) delete process.env.OPENCODE_CONFIG_CONTENT
  else process.env.OPENCODE_CONFIG_CONTENT = originalContent
  if (originalOnly === undefined) delete process.env.OPENCODE_CONFIG_CONTENT_ONLY
  else process.env.OPENCODE_CONFIG_CONTENT_ONLY = originalOnly
  if (originalGlobal === undefined) await fs.rm(globalFile, { force: true })
  else await Bun.write(globalFile, originalGlobal)
  await AppRuntime.runPromise(Config.use.invalidate())
})

// Keep configuration parsing and update branching real; replace only external installation effects.
for (const disk of [{}, { autoupdate: true }]) {
  for (const latest of ["1.18.24", "1.19.0", "2.0.0"]) {
    test(`injected false prevents ${latest} update with disk ${JSON.stringify(disk)}`, async () => {
      await Bun.write(globalFile, JSON.stringify(disk))
      process.env.OPENCODE_CONFIG_CONTENT_ONLY = "1"
      process.env.OPENCODE_CONFIG_CONTENT = '{"autoupdate":false}'
      Flag.OPENCODE_DISABLE_AUTOUPDATE = false // Reproduce the reported process, before the launch flag correction.
      Flag.OPENCODE_ALWAYS_NOTIFY_UPDATE = false
      await AppRuntime.runPromise(Config.use.invalidate())
      const effects: string[] = []
      const classify = Installation.getReleaseType
      spies.push(
        spyOn(Installation, "getReleaseType").mockImplementation((_current, target) =>
          classify("1.18.23-managed.23", target),
        ),
      )
      spies.push(
        spyOn(Installation, "method").mockImplementation(async () => {
          effects.push("detect")
          return "npm"
        }),
      )
      spies.push(
        spyOn(Installation, "latest").mockImplementation(async () => {
          effects.push("network")
          return latest
        }),
      )
      spies.push(
        spyOn(Installation, "upgrade").mockImplementation(async () => {
          effects.push("mutate")
        }),
      )
      const onEvent = () => effects.push("event")
      GlobalBus.on("event", onEvent)
      try {
        await upgrade()
        expect(effects).toEqual([])
      } finally {
        GlobalBus.off("event", onEvent)
      }
    })
  }
}

for (const kind of ["patch", "minor", "major"] as const) {
  test(`standalone ${kind} update behavior remains available`, async () => {
    await Bun.write(globalFile, "{}")
    delete process.env.OPENCODE_CONFIG_CONTENT_ONLY
    delete process.env.OPENCODE_CONFIG_CONTENT
    Flag.OPENCODE_DISABLE_AUTOUPDATE = false
    Flag.OPENCODE_ALWAYS_NOTIFY_UPDATE = false
    await AppRuntime.runPromise(Config.use.invalidate())
    const effects: string[] = []
    spies.push(spyOn(Installation, "method").mockResolvedValue("npm"))
    spies.push(spyOn(Installation, "latest").mockResolvedValue("1.19.0"))
    // Source tests have version "local"; compiled-runtime verification uses the real version classifier.
    spies.push(spyOn(Installation, "getReleaseType").mockReturnValue(kind))
    spies.push(
      spyOn(Installation, "upgrade").mockImplementation(async () => {
        effects.push("mutate")
      }),
    )
    const onEvent = (evt: { payload: { type: string } }) => effects.push(evt.payload.type)
    GlobalBus.on("event", onEvent)
    try {
      await upgrade()
      expect(effects).toEqual(kind === "patch" ? ["mutate", "installation.updated"] : ["installation.update-available"])
    } finally {
      GlobalBus.off("event", onEvent)
    }
  })
}

test("managed CLI upgrade returns before installation discovery or mutation", async () => {
  process.env.OPENCODE_CONFIG_CONTENT_ONLY = "1"
  Flag.OPENCODE_DISABLE_AUTOUPDATE = true
  const priorExitCode = process.exitCode
  const effects: string[] = []
  spies.push(
    spyOn(Installation, "method").mockImplementation(async () => {
      effects.push("detect")
      return "npm"
    }),
  )
  spies.push(
    spyOn(Installation, "upgrade").mockImplementation(async () => {
      effects.push("mutate")
    }),
  )
  try {
    await UpgradeCommand.handler({ target: "1.19.0", method: "npm" })
    expect(process.exitCode).toBe(1)
    expect(effects).toEqual([])
  } finally {
    process.exitCode = priorExitCode ?? 0
  }
})
