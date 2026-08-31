import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { loadStrategyAuthoringQuestions } from "../../src/tool/strategy-authoring-catalog"
import { tmpdir } from "../fixture/fixture"

const base = {
  catalogVersion: "1.0.0",
  locale: "en_US",
  sections: [],
  questions: [
    {
      questionId: "starting-direction",
      header: "Strategy intent",
      question: "What should this strategy be about?",
      selectionMode: "single",
      customAnswerPolicy: "allowed",
      options: [{ optionId: "trend", label: "Trend", description: "Use a public trend pattern." }],
    },
    {
      questionId: "choice-ownership",
      header: "Choice ownership",
      question: "Who should choose?",
      selectionMode: "single",
      customAnswerPolicy: "allowed",
      options: [{ optionId: "user", label: "I will", description: "The user will choose." }],
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
  test("loads exact questions in catalog order", async () => {
    await using tmp = await tmpdir()
    await writeProjection(tmp.path, base)
    expect(loadStrategyAuthoringQuestions(tmp.path, ["starting-direction", "choice-ownership"])).toEqual([
      {
        question: "What should this strategy be about?",
        header: "Strategy intent",
        options: [{ label: "Trend", description: "Use a public trend pattern." }],
        multiple: false,
        custom: true,
      },
      {
        question: "Who should choose?",
        header: "Choice ownership",
        options: [{ label: "I will", description: "The user will choose." }],
        multiple: false,
        custom: true,
      },
    ])
  })

  test("rejects missing, malformed, and hash-mismatched projections", async () => {
    await using tmp = await tmpdir()
    expect(() => loadStrategyAuthoringQuestions(tmp.path, ["starting-direction"])).toThrow("Cannot load verified")
    await Bun.write(path.join(tmp.path, "instructions", "strategy-authoring-orientation.json"), "not-json")
    expect(() => loadStrategyAuthoringQuestions(tmp.path, ["starting-direction"])).toThrow("Cannot load verified")
    await writeProjection(tmp.path, { ...base, locale: "fr_FR" }, base)
    expect(() => loadStrategyAuthoringQuestions(tmp.path, ["starting-direction"])).toThrow("projection hash mismatch")
  })

  test("rejects invalid catalog structure and semantics", async () => {
    await using tmp = await tmpdir()
    await mkdir(path.join(tmp.path, "instructions"), { recursive: true })
    await Bun.write(path.join(tmp.path, "instructions", "strategy-authoring-orientation.json"), "null")
    expect(() => loadStrategyAuthoringQuestions(tmp.path, ["starting-direction"])).toThrow("must be an object")
    const invalid = [
      { ...base, sections: null },
      { ...base, questions: [null] },
      { ...base, questions: [{ ...base.questions[0], questionId: "" }] },
      { ...base, questions: [base.questions[0], base.questions[0]] },
      { ...base, questions: [{ ...base.questions[0], selectionMode: "multiple" }] },
      { ...base, questions: [{ ...base.questions[0], options: [] }] },
      { ...base, questions: [{ ...base.questions[0], options: [null] }] },
      { ...base, questions: [{ ...base.questions[0], options: [{ ...base.questions[0].options[0], optionId: "" }] }] },
      {
        ...base,
        questions: [{ ...base.questions[0], options: [base.questions[0].options[0], base.questions[0].options[0]] }],
      },
      { ...base, effects: { createsStrategyRules: true, allowsExecutableAction: false } },
    ]
    for (const projection of invalid) {
      await writeProjection(tmp.path, projection)
      expect(() => loadStrategyAuthoringQuestions(tmp.path, ["starting-direction"])).toThrow()
    }
  })

  test("rejects invalid requested identities and order", async () => {
    await using tmp = await tmpdir()
    await writeProjection(tmp.path, base)
    expect(() => loadStrategyAuthoringQuestions(tmp.path, [])).toThrow("non-empty and unique")
    expect(() => loadStrategyAuthoringQuestions(tmp.path, ["starting-direction", "starting-direction"])).toThrow(
      "non-empty and unique",
    )
    expect(() => loadStrategyAuthoringQuestions(tmp.path, ["unknown"])).toThrow("Unknown Strategy Authoring")
    expect(() => loadStrategyAuthoringQuestions(tmp.path, ["choice-ownership", "starting-direction"])).toThrow(
      "retain catalog order",
    )
  })
})
