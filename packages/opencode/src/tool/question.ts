import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Question } from "../question"
import DESCRIPTION from "./question.txt"
import { InstanceState } from "@/effect/instance-state"
import { loadStrategyAuthoringQuestions } from "./strategy-authoring-catalog"

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
  questions: ReadonlyArray<Question.Prompt>
}

export const QuestionTool = Tool.define<typeof Parameters, Metadata, Question.Service>(
  "question",
  Effect.gen(function* () {
    const question = yield* Question.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const questions =
            params.catalogQuestionIds !== undefined
              ? loadStrategyAuthoringQuestions((yield* InstanceState.context).directory, params.catalogQuestionIds)
              : params.questions!
          const answers = yield* question.ask({
            sessionID: ctx.sessionID,
            questions,
            tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
          })

          const formatted = questions
            .map((q, i) => `"${q.question}"="${answers[i]?.length ? answers[i].join(", ") : "Unanswered"}"`)
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
