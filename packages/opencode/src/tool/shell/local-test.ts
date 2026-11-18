import { Effect, Schema } from "effect"
import { existsSync, realpathSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ChildProcess } from "effect/unstable/process"
import WIN32_LAUNCHER from "./local-test-windows.txt"

export const supported = ["linux", "darwin", "win32"].includes(process.platform)
export const windowsParameters = Schema.Struct({
  command: Schema.String.annotate({
    description: "One managed Python command, for example python -B -m pytest -q tests.",
  }),
  description: Schema.String.annotate({ description: "Short description of the Python check." }),
  timeout: Schema.optional(Schema.Number).annotate({ description: "Optional timeout in milliseconds." }),
  workdir: Schema.optional(Schema.String).annotate({ description: "Working directory inside the project workspace." }),
})

export const LOCAL_TEST_TOOL_ID = "local_test"
function linuxCommand(command: string, cwd: string, workspace: string, env: NodeJS.ProcessEnv) {
  const system = ["/usr", "/lib", "/lib64", "/bin"]
  const mounts = system.filter(existsSync).flatMap((entry) => ["--ro-bind", entry, entry])
  const runtime = (
    env.STRATCRAFT_AUTHORING_PYTHON_BIN ? [env.STRATCRAFT_AUTHORING_PYTHON_BIN, env.VIRTUAL_ENV] : []
  ).filter((entry): entry is string => !!entry && path.isAbsolute(entry) && entry !== "/")
  for (const entry of runtime) {
    const real = realpathSync(entry)
    mounts.push("--ro-bind", real, entry)
  }
  return ChildProcess.make(
    "/usr/bin/bwrap",
    [
      "--unshare-all",
      "--die-with-parent",
      "--cap-drop",
      "ALL",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
      ...mounts,
      "--ro-bind",
      workspace,
      workspace,
      "--chdir",
      cwd,
      "--clearenv",
      "--setenv",
      "HOME",
      "/tmp",
      "--setenv",
      "TMPDIR",
      "/tmp",
      "--setenv",
      "PATH",
      [env.STRATCRAFT_AUTHORING_PYTHON_BIN, "/usr/bin", "/bin"].filter(Boolean).join(":"),
      "--setenv",
      "PYTHONDONTWRITEBYTECODE",
      "1",
      "--",
      "/bin/sh",
      "-c",
      command,
    ],
    { env: {}, stdin: "ignore", detached: true },
  )
}

const scratchDirectory = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "opencode-local-test-"))),
  (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true, maxRetries: 5 })),
)

export const command = Effect.fn("LocalTest.command")(function* (
  command: string,
  cwd: string,
  workspace: string,
  env: NodeJS.ProcessEnv,
) {
  if (process.platform === "linux") return linuxCommand(command, cwd, workspace, env)
  const scratch = realpathSync(yield* scratchDirectory)
  if (process.platform === "win32") {
    if (!env.STRATCRAFT_AUTHORING_PYTHON_BIN || !env.VIRTUAL_ENV) {
      throw new Error(
        "The managed Python Strategy runtime is unavailable. Retry runtime verification before running Python tests.",
      )
    }
    const runtime = realpathSync(env.VIRTUAL_ENV)
    return ChildProcess.make(
      path.join(runtime, "python.exe"),
      [
        "-I",
        "-S",
        "-B",
        "-c",
        WIN32_LAUNCHER,
        scratch,
        runtime,
        realpathSync(workspace),
        path.relative(realpathSync(workspace), realpathSync(cwd)),
        command,
      ],
      { cwd: runtime, env: { SystemRoot: process.env.SystemRoot }, stdin: "ignore" },
    )
  }

  const aliases = env.STRATCRAFT_AUTHORING_PYTHON_BIN
  const readable = [
    "/System/Library",
    "/usr/lib",
    "/usr/bin",
    "/bin",
    "/private/etc/localtime",
    realpathSync(workspace),
    scratch,
    aliases && realpathSync(aliases),
    aliases && env.VIRTUAL_ENV && realpathSync(env.VIRTUAL_ENV),
  ].filter((entry): entry is string => !!entry && path.isAbsolute(entry) && entry !== "/")
  const subpath = (entry: string) => `(subpath ${JSON.stringify(entry)})`
  const policy = `(version 1)
    (deny default)
    (allow process-fork process-exec sysctl-read)
    (allow file-read* ${readable.map(subpath).join(" ")} (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))
    (allow file-write* ${subpath(scratch)} (literal "/dev/null"))`
  return ChildProcess.make("/usr/bin/sandbox-exec", ["-p", policy, "/bin/sh", "-c", command], {
    cwd,
    env: {
      HOME: scratch,
      TMPDIR: scratch,
      PATH: [aliases, "/usr/bin", "/bin"].filter(Boolean).join(":"),
      PYTHONDONTWRITEBYTECODE: "1",
    },
    stdin: "ignore",
    detached: true,
  })
})

export * as LocalTest from "./local-test"
