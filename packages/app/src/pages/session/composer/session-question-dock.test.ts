import { describe, expect, test } from "bun:test"
import { questionOptionAnswer } from "./session-question-dock"

describe("session question dock option answers", () => {
  test("uses a catalog option identity without changing the displayed label", () => {
    expect(
      questionOptionAnswer({
        optionId: "browse-public-algorithms",
        label: "Browse public algorithms",
      }),
    ).toBe("browse-public-algorithms")
  })

  test("keeps labels authoritative for generic questions", () => {
    expect(questionOptionAnswer({ label: "Continue" })).toBe("Continue")
  })
})
