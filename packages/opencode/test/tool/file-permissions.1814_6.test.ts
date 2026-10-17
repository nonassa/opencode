import { expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { existsSync } from "fs"
import { Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Permission } from "../../src/permission"
import { WriteTool } from "../../src/tool/write"
import { EditTool } from "../../src/tool/edit"
import { ApplyPatchTool } from "../../src/tool/apply_patch"
import { LSP } from "../../src/lsp/lsp"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Format } from "../../src/format"
import { Truncate } from "../../src/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { InstanceState } from "../../src/effect/instance-state"
import { SessionID, MessageID } from "../../src/session/schema"
import type { Tool } from "../../src/tool/tool"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const fixture = process.env.STRATCRAFT_FILE_PERMISSION_TEST_FIXTURE
// Ordinary native runs use a scoped fixture; the integration driver supplies
// the actual shared host projection to run these same file effects end to end.
const supplied = fixture
  ? await Bun.file(fixture).text()
  : JSON.stringify({
      edit: {
        "*": "deny",
        "/stratcraft-permission-project/strategy/**": "allow",
        "/stratcraft-permission-project/tests/**": "allow",
        "/stratcraft-permission-project/strategy.manifest.json": "allow",
      },
      read: "allow",
      external_directory: "deny",
    })
const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Permission.node,
      LSP.node,
      FSUtil.node,
      EventV2Bridge.node,
      Format.node,
      CrossSpawnSpawner.node,
      Truncate.node,
      Agent.node,
    ]),
  ),
)

const context = Effect.fn("FilePermissionTest.context")(function* (directory: string, readOnly = false) {
  const owner = yield* Permission.Service
  const permission: Parameters<typeof Permission.fromConfig>[0] = JSON.parse(
    supplied.replaceAll("/stratcraft-permission-project", directory.replaceAll("\\", "/")),
  )
  const ruleset = Permission.fromConfig(readOnly ? { ...permission, edit: "deny" } : permission)
  const ctx: Tool.Context = {
    sessionID: SessionID.make("ses_file-permissions"),
    messageID: MessageID.make("msg_file-permissions"),
    callID: "file-permissions",
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: (request) =>
      owner.ask({ ...request, sessionID: SessionID.make("ses_file-permissions"), ruleset }).pipe(Effect.orDie),
  }
  return ctx
})

for (const git of [false, true]) {
  for (const relative of [false, true]) {
    it.instance(
      `native write, edit and patch respect the generated scope (git=${git}, relative=${relative})`,
      () =>
        Effect.gen(function* () {
          const { directory } = yield* TestInstance
          const ctx = yield* context(directory)
          const file = relative ? "strategy/strategy.py" : path.join(directory, "strategy/strategy.py")
          const writer = yield* (yield* WriteTool).init()
          yield* writer.execute({ filePath: file, content: "value = 1\n" }, ctx)
          const editor = yield* (yield* EditTool).init()
          yield* editor.execute({ filePath: file, oldString: "value = 1", newString: "value = 2" }, ctx)
          const patcher = yield* (yield* ApplyPatchTool).init()
          yield* patcher.execute(
            { patchText: `*** Begin Patch\n*** Update File: ${file}\n@@\n-value = 2\n+value = 3\n*** End Patch` },
            ctx,
          )
          expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "strategy/strategy.py"), "utf8"))).toBe(
            "value = 3\n",
          )
          yield* writer.execute({ filePath: "tests/test_strategy.py", content: "assert True\n" }, ctx)
          expect((yield* (yield* Permission.Service).list()).length).toBe(0)
        }),
      { git },
    )
  }
}

it.instance("native file edits retain read-only, protected-file and outside-project refusals", () =>
  Effect.gen(function* () {
    const { directory } = yield* TestInstance
    const writer = yield* (yield* WriteTool).init()
    for (const [file, readOnly] of [
      ["strategy/strategy.py", true],
      [".stratcraft/instructions.md", false],
      ["../other-project.py", false],
      [path.join(path.dirname(directory), "secret.key"), false],
      ["strategy/../../outside.py", false],
    ] as const) {
      const target = path.resolve(directory, file)
      const exit = yield* writer
        .execute({ filePath: file, content: "unauthorized\n" }, yield* context(directory, readOnly))
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(existsSync(target)).toBe(false)
    }
  }),
)

it.instance("symlinks cannot bypass the project or protected-file scope, including new nested files", () =>
  Effect.gen(function* () {
    const { directory } = yield* TestInstance
    const outside = path.join(path.dirname(directory), path.basename(directory) + "-outside")
    yield* Effect.acquireRelease(
      Effect.promise(() => fs.mkdir(outside)),
      () => Effect.promise(() => fs.rm(outside, { recursive: true, force: true })),
    )
    yield* Effect.promise(async () => {
      await fs.mkdir(path.join(directory, "strategy"))
      await fs.mkdir(path.join(directory, ".stratcraft"))
      await fs.symlink(outside, path.join(directory, "strategy/external"), "junction")
      await fs.symlink(path.join(directory, ".stratcraft"), path.join(directory, "strategy/protected"), "junction")
      await fs.symlink(path.join(outside, "missing.py"), path.join(directory, "strategy/dangling.py"))
      await fs.writeFile(path.join(outside, "existing.py"), "original\n")
    })
    const writer = yield* (yield* WriteTool).init()
    for (const file of [
      "strategy/external/existing.py",
      "strategy/external/new/nested.py",
      "strategy/protected/owner.json",
      "strategy/dangling.py",
    ]) {
      const exit = yield* writer
        .execute({ filePath: file, content: "unauthorized\n" }, yield* context(directory))
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
    }
    expect(yield* Effect.promise(() => fs.readFile(path.join(outside, "existing.py"), "utf8"))).toBe("original\n")
    expect(existsSync(path.join(outside, "new/nested.py"))).toBe(false)
    expect(existsSync(path.join(outside, "missing.py"))).toBe(false)
    expect(existsSync(path.join(directory, ".stratcraft/owner.json"))).toBe(false)
  }),
)

it.instance("patch moves check both the source and destination against the same scope", () =>
  Effect.gen(function* () {
    const { directory } = yield* TestInstance
    yield* Effect.promise(async () => {
      await fs.mkdir(path.join(directory, "strategy"))
      await fs.writeFile(path.join(directory, "strategy/strategy.py"), "value = 1\n")
    })
    const patcher = yield* (yield* ApplyPatchTool).init()
    const exit = yield* patcher
      .execute(
        {
          patchText:
            "*** Begin Patch\n*** Update File: strategy/strategy.py\n*** Move to: .stratcraft/owner.py\n@@\n-value = 1\n+value = 2\n*** End Patch",
        },
        yield* context(directory),
      )
      .pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "strategy/strategy.py"), "utf8"))).toBe(
      "value = 1\n",
    )
    expect(existsSync(path.join(directory, ".stratcraft/owner.py"))).toBe(false)
  }),
)

it.instance(
  "file permission matching retains relative rules, absolute read rules and final deny precedence",
  () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const { worktree } = yield* InstanceState.context
      const owner = yield* Permission.Service
      const file = path.join(directory, "strategy/strategy.py")
      const relative = path.relative(worktree, file).replaceAll("\\", "/")
      const request = {
        sessionID: SessionID.make("ses_file-permissions"),
        metadata: {},
        always: [],
        patterns: [relative],
      }
      yield* owner.ask({
        ...request,
        permission: "edit",
        ruleset: Permission.fromConfig({ edit: { "*": "deny", [relative]: "allow" } }),
      })
      yield* owner.ask({
        ...request,
        permission: "read",
        ruleset: Permission.fromConfig({ read: { "*": "deny", [file]: "allow" } }),
      })
      const exit = yield* owner
        .ask({
          ...request,
          permission: "edit",
          ruleset: Permission.fromConfig({
            edit: {
              "*": "deny",
              [path.join(directory, "strategy/**")]: "allow",
              [relative]: "deny",
            },
          }),
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect((yield* owner.list()).length).toBe(0)
    }),
  { git: true },
)
