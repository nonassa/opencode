import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Question } from "../question"
import DESCRIPTION from "./question.txt"
import { InstanceState } from "@/effect/instance-state"
import { loadStrategyAuthoringInteraction, loadStrategyProjectAuthoringInteraction, resolveStrategyAuthoringDirectory } from "./strategy-authoring-catalog"
import { Config } from "@/config/config"
import { Plugin } from "@/plugin"
import type { CatalogQuestionBeforeOutput, QuestionRequestAssociation } from "@opencode-ai/plugin"

export const Parameters = Schema.Struct({
  questions: Schema.optional(
    Schema.mutable(Schema.Array(Question.Prompt))
      .check(Schema.isMinLength(1))
      .annotate({ description: "Questions to ask" }),
  ),
  catalogQuestionIds: Schema.optional(
    Schema.mutable(Schema.Array(Schema.String)).check(Schema.isMinLength(1)).annotate({
      description: "Exact Strategy Authoring question IDs from the managed workspace catalog",
    }),
  ),
}).check(
  Schema.makeFilter((params) => {
    const hasQuestions = params.questions !== undefined
    const hasCatalogQuestionIds = params.catalogQuestionIds !== undefined
    return hasQuestions === hasCatalogQuestionIds
      ? "Exactly one of questions or catalogQuestionIds must be provided"
      : undefined
  }),
)

const RequestAssociation = Schema.Union([
  Schema.Struct({ purpose: Schema.Literal("request"), sourceId: Schema.String.check(Schema.isMinLength(1)) }),
  Schema.Struct({ purpose: Schema.Literal("scope-selection"), sourceId: Schema.Null }),
])

type Metadata = {
  questionRequestAssociation?: QuestionRequestAssociation
  answers?: ReadonlyArray<Question.Answer>
  questions: ReadonlyArray<Question.Info>
}

export const QuestionTool = Tool.define<typeof Parameters, Metadata, Question.Service | Config.Service | Plugin.Service>(
  "question",
  Effect.gen(function* () {
    const question = yield* Question.Service
    const config = yield* Config.Service
    const plugin = yield* Plugin.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      formatValidationError: () =>
        "Provide at least one complete question, or use top-level catalogQuestionIds for an admitted catalog question. " +
        'For the Strategy Authoring starting choices, use only {"catalogQuestionIds":["authoring-path"]}. ' +
        "Empty arrays and nested catalogQuestions are invalid.",
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const settings = params.catalogQuestionIds !== undefined ? yield* config.get() : undefined
          const server = settings?.mcp?.stratforge
          const remote = server && "type" in server && server.type === "remote" ? server : undefined
          const taskId = remote?.headers?.["X-StratCraft-Authoring-Task-Id"]
          const interaction =
            params.catalogQuestionIds !== undefined
              ? remote && taskId === undefined
                ? yield* Effect.promise(() => loadStrategyProjectAuthoringInteraction(
                    remote.url, remote.headers, ctx.sessionID, params.catalogQuestionIds!,
                  ))
                : loadStrategyAuthoringInteraction(
                  resolveStrategyAuthoringDirectory(
                    (yield* InstanceState.context).directory,
                    taskId,
                    settings?.instructions ?? [],
                  ),
                  params.catalogQuestionIds,
                )
              : { orientation: undefined, questions: params.questions! }
          // The existing allowance hook consumes owner-resolved questions, never model-built catalog menus.
          const hook: CatalogQuestionBeforeOutput = { args: { questions: interaction.questions }, questionContext: {} }
          if (params.catalogQuestionIds !== undefined) {
            for (const question of hook.args.questions) {
              question.options.forEach(option => Object.freeze(option))
              Object.freeze(question.options)
              Object.freeze(question)
            }
            Object.freeze(hook.args.questions)
            Object.freeze(hook.args)
            Object.freeze(hook)
          }
          yield* plugin.trigger("tool.execute.before", {
            tool: "question", sessionID: ctx.sessionID, messageID: ctx.messageID, callID: ctx.callID ?? "",
          }, hook)
          const questions = yield* Schema.decodeUnknownEffect(
            Schema.Array(Question.Info).check(Schema.isMinLength(1)),
          )(hook.args.questions)
          const association = hook.questionContext.requestAssociation === undefined
            ? undefined
            : Object.freeze({ ...(yield* Schema.decodeUnknownEffect(RequestAssociation)(hook.questionContext.requestAssociation)) })
          const metadata = { questions, ...(association ? { questionRequestAssociation: association } : {}) }
          yield* ctx.metadata({ input: params.catalogQuestionIds === undefined ? hook.args : params, metadata })
          const answers = yield* question.ask({
            sessionID: ctx.sessionID,
            orientation: interaction.orientation,
            questions,
            tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
          })

          const formatted = questions
            .map((q, i) => (
              `"${"questionId" in q && q.questionId ? `${q.questionId} (${q.question})` : q.question}"=` +
              `"${answers[i]?.length ? answers[i].join(", ") : "Unanswered"}"`
            ))
            .join(", ")

          const selected = questions.flatMap((q, i) => {
            if (params.catalogQuestionIds === undefined || !("questionId" in q)) return []
            return (answers[i] ?? []).flatMap((answer) => {
              const option = q.options.find((option) => option.optionId === answer)
              return option ? [{
                questionId: q.questionId,
                optionId: option.optionId,
                label: option.label,
                description: option.description,
              }] : []
            })
          })

          return {
            title: `Asked ${questions.length} question${questions.length > 1 ? "s" : ""}`,
            output: `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`
              + (selected.length ? `\nSelected catalog options: ${JSON.stringify(selected)}` : ""),
            metadata: { ...metadata, answers },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
