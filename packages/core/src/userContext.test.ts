import { describe, expect, it } from "vitest";
import { isDisplayableUserPromptText, normalizeUserContextText } from "./userContext.js";

describe("user context normalization", () => {
  it("treats direct user text as displayable prompt text", () => {
    expect(isDisplayableUserPromptText("Build prompt history search")).toBe(true);
    expect(normalizeUserContextText("Build prompt history search")).toMatchObject({
      kind: "message",
      text: "Build prompt history search"
    });
  });

  it("excludes subagent notifications from displayable prompt text", () => {
    const text = subagentNotificationContext();

    expect(isDisplayableUserPromptText(text)).toBe(false);
    expect(normalizeUserContextText(text)).toMatchObject({
      kind: "action",
      text: expect.stringContaining("Subagent completed: 019f428a-0df4-7ef3-acd5-ec042babc237")
    });
  });
});

function subagentNotificationContext(): string {
  return [
    "<subagent_notification>",
    JSON.stringify({
      agent_path: "019f428a-0df4-7ef3-acd5-ec042babc237",
      status: {
        completed: "Regression pass found no blocking issues in the staged diff."
      }
    }),
    "</subagent_notification>"
  ].join("\n");
}
