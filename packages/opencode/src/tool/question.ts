import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Question } from "../question"
import DESCRIPTION from "./question.txt"
import { InstanceState } from "@/effect/instance-state"
import { loadStrategyAuthoringInteraction, loadStrategyProjectAuthoringInteraction, resolveStrategyAuthoringDirectory } from "./strategy-authoring-catalog"
import { Config } from "@/config/config"

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

type Metadata = {
  answers: ReadonlyArray<Question.Answer>
  questions: ReadonlyArray<Question.Info>
}

export const QuestionTool = Tool.define<typeof Parameters, Metadata, Question.Service | Config.Service>(
  "question",
  Effect.gen(function* () {
    const question = yield* Question.Service
    const config = yield* Config.Service

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
          const questions = interaction.questions
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
            metadata: {
              answers,
              questions,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
