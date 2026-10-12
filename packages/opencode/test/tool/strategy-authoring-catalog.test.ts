import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import {
  loadStrategyAuthoringInteraction,
  loadStrategyProjectAuthoringInteraction,
  loadStrategyAuthoringQuestions,
  resolveStrategyAuthoringDirectory,
} from "../../src/tool/strategy-authoring-catalog"
import { tmpdir } from "../fixture/fixture"

const base = {
  catalogVersion: "1.0.0",
  locale: "en_US",
  targetRuntime: "python-backtrader-v1",
  algorithmBrowsingEmptyState: null,
  sections: [
    {
      sectionId: "strategy-styles",
      label: "Strategy styles",
      items: [{ itemId: "trend-following", label: "Trend following", description: "Explore public trend systems." }],
    },
    {
      sectionId: "example-prompts",
      label: "Ways to begin",
      items: [
        {
          itemId: "start-turtle",
          label: "Start from Turtle Trading",
          description: "I want something like Turtle Trading.",
        },
      ],
    },
  ],
  questions: [
    {
      questionId: "authoring-path",
      header: "How to continue",
      question: "How would you like to continue?",
      selectionMode: "single",
      customAnswerPolicy: "allowed",
      options: [
        { optionId: "browse-public-algorithms", label: "Browse public algorithms", description: "Browse next." },
        { optionId: "recommend-starting-point", label: "Recommend a starting point", description: "Recommend one." },
      ],
    },
    {
      questionId: "public-algorithm-library",
      header: "Public algorithm library",
      question: "Which public algorithm library would you like to browse?",
      selectionMode: "single",
      customAnswerPolicy: "allowed",
      options: [{ optionId: "freqtrade", label: "freqtrade", description: "Browse public strategies." }],
    },
  ],
  effects: { createsStrategyRules: false, allowsExecutableAction: false },
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

async function writeProjection(directory: string, projection: unknown, hashSource = projection) {
  const file = path.join(directory, "instructions", "strategy-authoring-orientation.json")
  await mkdir(path.dirname(file), { recursive: true })
  await Bun.write(
    file,
    `${JSON.stringify({
      ...(projection as object),
      projectionHash: createHash("sha256").update(canonical(hashSource), "utf8").digest("hex"),
    })}\n`,
  )
}

describe("Strategy Authoring catalog question adapter", () => {
  test("does not turn a refused task-free orientation into choices or expose its response body", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() {
      return new Response("private-response-body", { status: 403 })
    } })
    try {
      await expect(loadStrategyProjectAuthoringInteraction(
        `http://127.0.0.1:${server.port}/mcp/authoring`, { Authorization: "Bearer revoked-lease" },
        "owning-root", ["authoring-path"],
      )).rejects.toThrow("Strategy Authoring project orientation is unavailable (HTTP 403)")
    } finally { server.stop(true) }
  })
  test("loads task-free choices from the authenticated owning project without borrowing a task", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
      expect(new URL(request.url).pathname).toBe("/mcp/authoring/orientation")
      expect(request.headers.get("Authorization")).toBe("Bearer owned-lease")
      expect(await request.json()).toEqual({ nativeSessionId: "owning-root" })
      return Response.json({ questionCatalog: { ...base,
        projectionHash: createHash("sha256").update(canonical(base), "utf8").digest("hex") } })
    } })
    try {
      const interaction = await loadStrategyProjectAuthoringInteraction(
        `http://127.0.0.1:${server.port}/mcp/authoring`, { Authorization: "Bearer owned-lease" },
        "owning-root", ["authoring-path"],
      )
      expect(interaction.orientation).toEqual(base.sections)
      expect(interaction.questions[0]).toMatchObject({ questionId: "authoring-path", custom: true,
        options: [{ optionId: "browse-public-algorithms" }, { optionId: "recommend-starting-point" }] })
    } finally { server.stop(true) }
  })
  test("resolves only the bound task projection, never a workspace or sibling catalog", async () => {
    await using tmp = await tmpdir()
    const selected = path.join(tmp.path, ".stratcraft", "tasks", "selected")
    const sibling = path.join(tmp.path, ".stratcraft", "tasks", "sibling")
    await writeProjection(selected, base)
    await writeProjection(sibling, { ...base, sections: [] })
    const instructions = [path.join(selected, "AGENTS.md")]
    expect(loadStrategyAuthoringInteraction(
      resolveStrategyAuthoringDirectory(tmp.path, "selected", instructions), ["authoring-path"],
    ).orientation).toEqual(base.sections)
    expect(() => resolveStrategyAuthoringDirectory(tmp.path, "sibling", instructions)).toThrow("instruction projection")
    expect(() => resolveStrategyAuthoringDirectory(tmp.path, undefined, instructions)).toThrow("task identity")
    expect(() => resolveStrategyAuthoringDirectory(tmp.path, "../selected", instructions)).toThrow("task identity")
  })
  test("loads exact orientation before catalog questions", async () => {
    await using tmp = await tmpdir()
    await writeProjection(tmp.path, base)
    expect(loadStrategyAuthoringInteraction(tmp.path, ["authoring-path"])).toEqual({
      orientation: base.sections,
      questions: [
        {
          questionId: "authoring-path",
          question: "How would you like to continue?",
          header: "How to continue",
          options: [
            { optionId: "browse-public-algorithms", label: "Browse public algorithms", description: "Browse next." },
            { optionId: "recommend-starting-point", label: "Recommend a starting point", description: "Recommend one." },
          ],
          multiple: false,
          custom: true,
        },
      ],
    })
  })

  test("accepts the complete projection for each supported target runtime", async () => {
    await using tmp = await tmpdir()
    await writeProjection(tmp.path, {
      ...base,
      targetRuntime: "cpp23-abi-v2",
      algorithmBrowsingEmptyState: "No convertible algorithms are currently available for this runtime.",
    })
    expect(loadStrategyAuthoringQuestions(tmp.path, ["authoring-path"])).toHaveLength(1)
  })

  test("loads exact questions in catalog order", async () => {
    await using tmp = await tmpdir()
    await writeProjection(tmp.path, base)
    expect(loadStrategyAuthoringQuestions(tmp.path, ["authoring-path", "public-algorithm-library"])).toEqual([
      {
        questionId: "authoring-path",
        question: "How would you like to continue?",
        header: "How to continue",
        options: [
          { optionId: "browse-public-algorithms", label: "Browse public algorithms", description: "Browse next." },
          { optionId: "recommend-starting-point", label: "Recommend a starting point", description: "Recommend one." },
        ],
        multiple: false,
        custom: true,
      },
      {
        questionId: "public-algorithm-library",
        question: "Which public algorithm library would you like to browse?",
        header: "Public algorithm library",
        options: [{ optionId: "freqtrade", label: "freqtrade", description: "Browse public strategies." }],
        multiple: false,
        custom: true,
      },
    ])
  })

  test("rejects missing, malformed, and hash-mismatched projections", async () => {
    await using tmp = await tmpdir()
    expect(() => loadStrategyAuthoringQuestions(tmp.path, ["authoring-path"])).toThrow("Cannot load verified")
    await Bun.write(path.join(tmp.path, "instructions", "strategy-authoring-orientation.json"), "not-json")
    expect(() => loadStrategyAuthoringQuestions(tmp.path, ["authoring-path"])).toThrow("Cannot load verified")
    await writeProjection(tmp.path, { ...base, locale: "fr_FR" }, base)
    expect(() => loadStrategyAuthoringQuestions(tmp.path, ["authoring-path"])).toThrow("projection hash mismatch")
    await writeProjection(tmp.path, { ...base, targetRuntime: "cpp23-abi-v2" }, base)
    expect(() => loadStrategyAuthoringQuestions(tmp.path, ["authoring-path"])).toThrow("projection hash mismatch")
    await writeProjection(tmp.path, { ...base, algorithmBrowsingEmptyState: "Tampered" }, base)
    expect(() => loadStrategyAuthoringQuestions(tmp.path, ["authoring-path"])).toThrow("projection hash mismatch")
  })

  test("rejects invalid catalog structure and semantics", async () => {
    await using tmp = await tmpdir()
    await mkdir(path.join(tmp.path, "instructions"), { recursive: true })
    await Bun.write(path.join(tmp.path, "instructions", "strategy-authoring-orientation.json"), "null")
    expect(() => loadStrategyAuthoringQuestions(tmp.path, ["authoring-path"])).toThrow("must be an object")
    const invalid = [
      { ...base, sections: null },
      { ...base, sections: [null] },
      { ...base, sections: [{ ...base.sections[0], sectionId: "" }] },
      { ...base, sections: [base.sections[0], base.sections[0]] },
      { ...base, sections: [{ ...base.sections[0], items: [] }] },
      { ...base, sections: [{ ...base.sections[0], items: [null] }] },
      { ...base, sections: [{ ...base.sections[0], items: [{ ...base.sections[0].items[0], itemId: "" }] }] },
      {
        ...base,
        sections: [{ ...base.sections[0], items: [base.sections[0].items[0], base.sections[0].items[0]] }],
      },
      { ...base, questions: [null] },
      { ...base, questions: [{ ...base.questions[0], questionId: "" }] },
      { ...base, questions: [base.questions[0], base.questions[0]] },
      { ...base, questions: [{ ...base.questions[0], selectionMode: "multiple" }] },
      { ...base, questions: [{ ...base.questions[0], options: [] }] },
      { ...base, questions: [{ ...base.questions[0], options: [null] }] },
      { ...base, targetRuntime: "unsupported" },
      { ...base, algorithmBrowsingEmptyState: "" },
      { ...base, questions: [{ ...base.questions[0], options: [{ ...base.questions[0].options[0], optionId: "" }] }] },
      {
        ...base,
        questions: [{ ...base.questions[0], options: [base.questions[0].options[0], base.questions[0].options[0]] }],
      },
      { ...base, effects: { createsStrategyRules: true, allowsExecutableAction: false } },
    ]
    for (const projection of invalid) {
      await writeProjection(tmp.path, projection)
      expect(() => loadStrategyAuthoringQuestions(tmp.path, ["authoring-path"])).toThrow()
    }
  })

  test("rejects invalid requested identities and order", async () => {
    await using tmp = await tmpdir()
    await writeProjection(tmp.path, base)
    expect(() => loadStrategyAuthoringQuestions(tmp.path, [])).toThrow("non-empty and unique")
    expect(() => loadStrategyAuthoringQuestions(tmp.path, ["authoring-path", "authoring-path"])).toThrow(
      "non-empty and unique",
    )
    expect(() => loadStrategyAuthoringQuestions(tmp.path, ["unknown"])).toThrow("Unknown Strategy Authoring")
    expect(() => loadStrategyAuthoringQuestions(tmp.path, ["public-algorithm-library", "authoring-path"])).toThrow(
      "retain catalog order",
    )
  })
})
