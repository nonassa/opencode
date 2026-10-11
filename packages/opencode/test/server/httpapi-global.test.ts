import { NodeHttpServer } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { ServerAuth } from "../../src/server/auth"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { GlobalPaths } from "../../src/server/routes/instance/httpapi/groups/global"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { testEffect } from "../lib/effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { AppProcess } from "@opencode-ai/core/process"
import { HttpClientResponse } from "effect/unstable/http"

const defaultInstallation = Layer.mock(Installation.Service)({
  method: () => Effect.succeed("npm"),
  latest: () => Effect.succeed("9.9.9"),
  upgrade: () => Effect.void,
})
const apiLayer = (installation = defaultInstallation) =>
  HttpRouter.serve(
    HttpApiBuilder.layer(RootHttpApi).pipe(
      Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlers]),
      Layer.provide([authorizationLayer, schemaErrorLayer]),
      // Raw HttpApi routes expose an opaque handler context at the request boundary.
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
    ),
    { disableListenLog: true, disableLogger: true },
  ).pipe(
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provide(Layer.mock(Auth.Service)({})),
    Layer.provide(Layer.mock(Config.Service)({})),
    Layer.provide(Layer.mock(MoveSession.Service)({})),
    Layer.provide(installation),
    Layer.provide(ServerAuth.Config.configLayer({ password: Option.none(), username: "opencode" })),
  )
const it = testEffect(apiLayer())

describe("global HttpApi", () => {
  it.live("upgrades to the requested version", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(GlobalPaths.upgrade).pipe(
        HttpClientRequest.bodyJsonUnsafe({ target: "9.9.9" }),
        HttpClient.execute,
      )

      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ success: true, version: "9.9.9" })
    }),
  )

  it.live("rejects invalid upgrade payloads", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(GlobalPaths.upgrade).pipe(
        HttpClientRequest.bodyJsonUnsafe({ target: 1 }),
        HttpClient.execute,
      )

      expect(response.status).toBe(400)
    }),
  )

  it.live("rejects invalid upgrade target versions", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(GlobalPaths.upgrade).pipe(
        HttpClientRequest.bodyJsonUnsafe({ target: "latest" }),
        HttpClient.execute,
      )

      expect(response.status).toBe(400)
    }),
  )

  it.live("rejects unsupported upgrade content types", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(GlobalPaths.upgrade).pipe(
        HttpClientRequest.setBody(HttpBody.text('{"target":"1.0.0"}', "text/plain")),
        HttpClient.execute,
      )

      expect(response.status).toBe(415)
    }),
  )
})

const nativeEffects: string[] = []
const nativeInstallation = LayerNode.compile(Installation.node, [
  [
    httpClient,
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        nativeEffects.push(request.url)
        return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}")))
      }),
    ),
  ],
  [
    AppProcess.node,
    Layer.mock(AppProcess.Service)({
      run: (command) => {
        const executable = command._tag === "StandardCommand" ? command.command : "piped"
        nativeEffects.push(command._tag === "StandardCommand" ? [command.command, ...command.args].join(" ") : "piped")
        return Effect.succeed({
          command: executable,
          exitCode: 0,
          stdout: Buffer.from("opencode-ai"),
          stderr: Buffer.alloc(0),
          stdoutTruncated: false,
          stderrTruncated: false,
        })
      },
    }),
  ],
])

testEffect(apiLayer(nativeInstallation)).live(
  "managed upgrade endpoint cannot bypass the real Installation owner",
  () =>
    Effect.gen(function* () {
      const prior = Flag.OPENCODE_DISABLE_AUTOUPDATE
      const contentOnly = process.env.OPENCODE_CONFIG_CONTENT_ONLY
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          Flag.OPENCODE_DISABLE_AUTOUPDATE = true
          process.env.OPENCODE_CONFIG_CONTENT_ONLY = "1"
          nativeEffects.length = 0
        }),
        () =>
          Effect.sync(() => {
            Flag.OPENCODE_DISABLE_AUTOUPDATE = prior
            if (contentOnly === undefined) delete process.env.OPENCODE_CONFIG_CONTENT_ONLY
            else process.env.OPENCODE_CONFIG_CONTENT_ONLY = contentOnly
          }),
      )
      const response = yield* HttpClientRequest.post(GlobalPaths.upgrade).pipe(
        HttpClientRequest.bodyJsonUnsafe({ target: "1.19.0" }),
        HttpClient.execute,
      )
      expect(response.status).toBe(500)
      expect(yield* response.json).toEqual({
        success: false,
        error: "OpenCode updates are managed by StratCraft Guide.",
      })
      // Method detection may inspect package installation, but no upgrade command or request may run.
      expect(nativeEffects.every((command) => command === "npm list -g --depth=0")).toBe(true)
    }),
)
