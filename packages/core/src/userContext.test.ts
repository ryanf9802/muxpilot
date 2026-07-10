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

  it("hides recommended plugin context without hiding adjacent user text", () => {
    const context = recommendedPluginsContext();

    expect(normalizeUserContextText(context)).toEqual({ kind: "hidden", text: "", skillNames: [] });
    expect(normalizeUserContextText(`${context}\n\nExplain the deployment failure`)).toMatchObject({
      kind: "message",
      text: "Explain the deployment failure"
    });
  });

  it("compacts AGENTS instructions when recommended plugins precede them", () => {
    const text = [
      recommendedPluginsContext(),
      "",
      "# AGENTS.md instructions for /home/dev/workspace/teamweave",
      "",
      "<INSTRUCTIONS>",
      "# Repository Guidelines",
      "</INSTRUCTIONS>",
      "",
      "<environment_context>",
      "  <cwd>/home/dev/workspace/teamweave</cwd>",
      "</environment_context>"
    ].join("\n");

    expect(normalizeUserContextText(text)).toEqual({
      kind: "action",
      text: "Loaded AGENTS.md instructions for /home/dev/workspace/teamweave",
      skillNames: []
    });
  });
});

function recommendedPluginsContext(): string {
  return [
    "<recommended_plugins>",
    "Here is a list of plugins that are available but not installed.",
    "- Google Drive (google-drive@openai-curated-remote)",
    "</recommended_plugins>"
  ].join("\n");
}

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
