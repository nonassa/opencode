import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"

const relativePath = path.join("instructions", "strategy-authoring-orientation.json")

type CatalogOption = {
  optionId: string
  label: string
  description: string
}

type CatalogQuestion = {
  questionId: string
  header: string
  question: string
  selectionMode: "single"
  customAnswerPolicy: "allowed"
  options: CatalogOption[]
}

type CatalogOrientationSection = {
  sectionId: string
  label: string
  items: Array<{
    itemId: string
    label: string
    description: string
  }>
}

type Projection = {
  catalogVersion: string
  locale: string
  sections: CatalogOrientationSection[]
  questions: CatalogQuestion[]
  effects: {
    createsStrategyRules: false
    allowsExecutableAction: false
  }
  projectionHash: string
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string`)
  return value
}

function parseProjection(value: unknown): Projection {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Strategy Authoring orientation must be an object")
  }
  const source = value as Record<string, unknown>
  if (!Array.isArray(source.sections) || !Array.isArray(source.questions)) {
    throw new Error("Strategy Authoring orientation sections and questions must be arrays")
  }
  const sectionIds = new Set<string>()
  const itemIds = new Set<string>()
  const sections = source.sections.map((candidate, sectionIndex) => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`sections[${sectionIndex}] must be an object`)
    }
    const section = candidate as Record<string, unknown>
    const sectionId = text(section.sectionId, `sections[${sectionIndex}].sectionId`)
    if (sectionIds.has(sectionId)) throw new Error(`Duplicate orientation section '${sectionId}'`)
    sectionIds.add(sectionId)
    if (!Array.isArray(section.items) || section.items.length === 0) {
      throw new Error(`Orientation section '${sectionId}' must contain items`)
    }
    return {
      sectionId,
      label: text(section.label, `sections[${sectionIndex}].label`),
      items: section.items.map((candidateItem, itemIndex) => {
        if (candidateItem === null || typeof candidateItem !== "object" || Array.isArray(candidateItem)) {
          throw new Error(`sections[${sectionIndex}].items[${itemIndex}] must be an object`)
        }
        const item = candidateItem as Record<string, unknown>
        const itemId = text(item.itemId, `sections[${sectionIndex}].items[${itemIndex}].itemId`)
        if (itemIds.has(itemId)) throw new Error(`Duplicate orientation item '${itemId}'`)
        itemIds.add(itemId)
        return {
          itemId,
          label: text(item.label, `sections[${sectionIndex}].items[${itemIndex}].label`),
          description: text(item.description, `sections[${sectionIndex}].items[${itemIndex}].description`),
        }
      }),
    }
  })
  const questionIds = new Set<string>()
  const questions = source.questions.map((candidate, questionIndex) => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`questions[${questionIndex}] must be an object`)
    }
    const question = candidate as Record<string, unknown>
    const questionId = text(question.questionId, `questions[${questionIndex}].questionId`)
    if (questionIds.has(questionId)) throw new Error(`Duplicate catalog question '${questionId}'`)
    questionIds.add(questionId)
    if (question.selectionMode !== "single" || question.customAnswerPolicy !== "allowed") {
      throw new Error(`Unsupported answer semantics for catalog question '${questionId}'`)
    }
    if (!Array.isArray(question.options) || question.options.length === 0) {
      throw new Error(`Catalog question '${questionId}' must contain options`)
    }
    const optionIds = new Set<string>()
    const options = question.options.map((candidateOption, optionIndex) => {
      if (candidateOption === null || typeof candidateOption !== "object" || Array.isArray(candidateOption)) {
        throw new Error(`questions[${questionIndex}].options[${optionIndex}] must be an object`)
      }
      const option = candidateOption as Record<string, unknown>
      const optionId = text(option.optionId, `questions[${questionIndex}].options[${optionIndex}].optionId`)
      if (optionIds.has(optionId)) throw new Error(`Duplicate option '${optionId}' in catalog question '${questionId}'`)
      optionIds.add(optionId)
      return {
        optionId,
        label: text(option.label, `questions[${questionIndex}].options[${optionIndex}].label`),
        description: text(option.description, `questions[${questionIndex}].options[${optionIndex}].description`),
      }
    })
    return {
      questionId,
      header: text(question.header, `questions[${questionIndex}].header`),
      question: text(question.question, `questions[${questionIndex}].question`),
      selectionMode: "single" as const,
      customAnswerPolicy: "allowed" as const,
      options,
    }
  })
  const projectionHash = text(source.projectionHash, "projectionHash")
  const effects = source.effects
  if (
    effects === null ||
    typeof effects !== "object" ||
    (effects as Record<string, unknown>).createsStrategyRules !== false ||
    (effects as Record<string, unknown>).allowsExecutableAction !== false
  ) {
    throw new Error("Strategy Authoring orientation effects are invalid")
  }
  const projection = {
    catalogVersion: text(source.catalogVersion, "catalogVersion"),
    locale: text(source.locale, "locale"),
    sections,
    questions,
    effects: {
      createsStrategyRules: false as const,
      allowsExecutableAction: false as const,
    },
  }
  const actualHash = createHash("sha256").update(canonicalJson(projection), "utf8").digest("hex")
  if (actualHash !== projectionHash) throw new Error("Strategy Authoring orientation projection hash mismatch")
  return { ...projection, projectionHash } as Projection
}

export function loadStrategyAuthoringInteraction(directory: string, questionIds: readonly string[]) {
  if (questionIds.length === 0 || new Set(questionIds).size !== questionIds.length) {
    throw new Error("Catalog question IDs must be non-empty and unique")
  }
  const filename = path.join(directory, relativePath)
  let projection: Projection
  try {
    projection = parseProjection(JSON.parse(readFileSync(filename, "utf8")))
  } catch (error) {
    throw new Error(`Cannot load verified Strategy Authoring orientation '${filename}': ${String(error)}`)
  }
  const byId = new Map(projection.questions.map((question) => [question.questionId, question]))
  const selected = questionIds.map((questionId) => {
    const question = byId.get(questionId)
    if (!question) throw new Error(`Unknown Strategy Authoring catalog question '${questionId}'`)
    return question
  })
  const selectedIndexes = selected.map((question) => projection.questions.indexOf(question))
  if (selectedIndexes.some((index, position) => position > 0 && index <= selectedIndexes[position - 1]!)) {
    throw new Error("Strategy Authoring catalog questions must retain catalog order")
  }
  return {
    orientation: projection.sections,
    questions: selected.map((question) => ({
      question: question.question,
      header: question.header,
      options: question.options.map((option) => ({ label: option.label, description: option.description })),
      multiple: false,
      custom: true,
    })),
  }
}

export function loadStrategyAuthoringQuestions(directory: string, questionIds: readonly string[]) {
  return loadStrategyAuthoringInteraction(directory, questionIds).questions
}
