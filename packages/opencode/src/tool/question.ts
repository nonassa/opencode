import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Question } from "../question"
import DESCRIPTION from "./question.txt"
import { InstanceState } from "@/effect/instance-state"
import { loadStrategyAuthoringInteraction, resolveStrategyAuthoringDirectory } from "./strategy-authoring-catalog"
import { Config } from "@/config/config"

export const Parameters = Schema.Struct({
  questions: Schema.optional(
    Schema.mutable(Schema.Array(Question.Prompt)).annotate({ description: "Questions to ask" }),
  ),
  catalogQuestionIds: Schema.optional(
    Schema.mutable(Schema.Array(Schema.String)).annotate({
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
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const settings = params.catalogQuestionIds !== undefined ? yield* config.get() : undefined
          const server = settings?.mcp?.stratforge
          const interaction =
            params.catalogQuestionIds !== undefined
              ? loadStrategyAuthoringInteraction(
                  resolveStrategyAuthoringDirectory(
                    (yield* InstanceState.context).directory,
                    server && "type" in server && server.type === "remote"
                      ? server.headers?.["X-StratCraft-Authoring-Task-Id"]
                      : undefined,
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

          return {
            title: `Asked ${questions.length} question${questions.length > 1 ? "s" : ""}`,
            output: `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`,
            metadata: {
              answers,
              questions,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
