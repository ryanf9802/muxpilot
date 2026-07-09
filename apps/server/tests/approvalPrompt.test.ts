import { describe, expect, it } from "vitest";
import { interactiveApprovalKeys, parseInteractiveApprovalPrompt } from "../src/codex/approvalPrompt.js";

describe("interactive Codex approval prompts", () => {
  it("parses app permission choices from the live terminal form", () => {
    const prompt = parseInteractiveApprovalPrompt(githubApprovalCapture(1));

    expect(prompt).toEqual({
      kind: "permissions",
      title: "Allow GitHub to create a pull request?",
      command: null,
      reason: null,
      prefixRule: null,
      options: [
        {
          decision: "approve_once",
          label: "Allow",
          description: "Run the tool and continue.",
          menuNumber: 1,
          selected: true
        },
        {
          decision: "approve_for_session",
          label: "Allow for this session",
          description: "Run the tool and remember this choice for this session.",
          menuNumber: 2,
          selected: false
        },
        {
          decision: "approve_always",
          label: "Always allow",
          description: "Run the tool and remember this choice for future tool calls.",
          menuNumber: 3,
          selected: false
        },
        {
          decision: "deny",
          label: "Cancel",
          description: "Cancel this tool call",
          menuNumber: 4,
          selected: false
        }
      ]
    });
  });

  it("navigates relative to the currently selected permission choice", () => {
    const prompt = parseInteractiveApprovalPrompt(githubApprovalCapture(2));
    expect(prompt).not.toBeNull();

    expect(interactiveApprovalKeys(prompt!, "approve_once")).toEqual(["Up", "Enter"]);
    expect(interactiveApprovalKeys(prompt!, "approve_for_session")).toEqual(["Enter"]);
    expect(interactiveApprovalKeys(prompt!, "approve_always")).toEqual(["Down", "Enter"]);
    expect(interactiveApprovalKeys(prompt!, "approve_for_prefix")).toBeNull();
  });

  it("parses command approval choices from the live terminal form", () => {
    const prompt = parseInteractiveApprovalPrompt(commandApprovalCapture(1));

    expect(prompt).toEqual({
      kind: "command",
      title: "Would you like to run the following command?",
      command: "pnpm app restart prod",
      reason: "Do you want to allow restarting the muxpilot production server so the simplified hold feedback is live?",
      prefixRule: ["pnpm", "app", "restart", "prod"],
      options: [
        {
          decision: "approve_once",
          label: "Approve once",
          description: "Yes, proceed",
          menuNumber: 1,
          selected: true
        },
        {
          decision: "approve_for_prefix",
          label: "Always allow prefix",
          description: "Yes, and don't ask again for commands that start with `pnpm app restart prod`",
          menuNumber: 2,
          selected: false
        },
        {
          decision: "deny",
          label: "Deny",
          description: "No, and tell Codex what to do differently",
          menuNumber: 3,
          selected: false
        }
      ]
    });
  });

  it("navigates command approval choices relative to the current selection", () => {
    const prompt = parseInteractiveApprovalPrompt(commandApprovalCapture(2));
    expect(prompt).not.toBeNull();

    expect(interactiveApprovalKeys(prompt!, "approve_once")).toEqual(["Up", "Enter"]);
    expect(interactiveApprovalKeys(prompt!, "approve_for_prefix")).toEqual(["Enter"]);
    expect(interactiveApprovalKeys(prompt!, "deny")).toEqual(["Down", "Enter"]);
    expect(interactiveApprovalKeys(prompt!, "approve_for_session")).toBeNull();
  });

  it("parses wrapped command reasons and persistent prefix choices", () => {
    const prompt = parseInteractiveApprovalPrompt(wrappedCommandApprovalCapture());

    expect(prompt).toMatchObject({
      kind: "command",
      command: "node /home/ryanf/.codex/skills/.system/openai-docs/scripts/fetch-codex-manual.mjs",
      reason: "May I fetch the current official Codex manual to verify sandbox, skill, and resume guarantees for this architecture plan?",
      prefixRule: [
        "node",
        "/home/ryanf/.codex/skills/.system/openai-docs/scripts/fetch-codex-manual.mjs"
      ]
    });
    expect(prompt?.options.map((option) => option.decision)).toEqual([
      "approve_once",
      "approve_for_prefix",
      "deny"
    ]);
    expect(interactiveApprovalKeys(prompt!, "approve_for_prefix")).toEqual(["Down", "Enter"]);
  });

  it("uses the newest approval form when the capture includes an older gate", () => {
    const prompt = parseInteractiveApprovalPrompt(`${githubApprovalCapture(1)}\n${commandApprovalCapture(2)}`);

    expect(prompt?.kind).toBe("command");
    expect(interactiveApprovalKeys(prompt!, "approve_once")).toEqual(["Up", "Enter"]);
  });

  it("does not parse a quoted command gate followed by normal chat UI", () => {
    const capture = `${commandApprovalCapture(1)}\n\n• The prompt above is only an example.\n\n› `;

    expect(parseInteractiveApprovalPrompt(capture)).toBeNull();
  });

  it("does not treat a normal composer or unrelated picker as an approval", () => {
    expect(parseInteractiveApprovalPrompt("Ready\n› ")).toBeNull();
    expect(parseInteractiveApprovalPrompt("Choose an option?\n› 1. Continue\nenter to submit | esc to cancel")).toBeNull();
  });
});

function githubApprovalCapture(selected: number): string {
  const option = (number: number, text: string) => `${number === selected ? "  ›" : "   "} ${number}. ${text}`;
  return [
    "◦ Calling",
    "  └ codex_apps.github.create_pull_request({\"title\":\"Scope assignment CADs to workspace\"})",
    "",
    "  Field 1/1",
    "  Allow GitHub to create a pull request?",
    "",
    "  Title: Scope assignment CADs to workspace",
    "  base: stage",
    "",
    option(1, "Allow                   Run the tool and continue."),
    option(2, "Allow for this session  Run the tool and remember this choice for this session."),
    option(3, "Always allow            Run the tool and remember this choice for future tool calls."),
    option(4, "Cancel                  Cancel this tool call"),
    "  enter to submit | esc to cancel"
  ].join("\n");
}

function commandApprovalCapture(selected: number): string {
  const option = (number: number, text: string) => `${number === selected ? "›" : " "} ${number}. ${text}`;
  return [
    "The simplified version passes all 274 tests, typecheck, production build, and diff validation.",
    "",
    "◦ Running pnpm app restart prod",
    "",
    "  \u001b[1mWould you like to run the following command?\u001b[0m",
    "",
    "  Environment: local",
    "",
    "  Reason: Do you want to allow restarting the muxpilot production server so the simplified hold feedback is live?",
    "",
    "  $ pnpm app restart prod",
    "",
    option(1, "Yes, proceed (y)"),
    option(2, "Yes, and don't ask again for commands that start with `pnpm app restart prod` (p)"),
    option(3, "No, and tell Codex what to do differently (esc)")
  ].join("\n");
}

function wrappedCommandApprovalCapture(): string {
  return [
    "◦ Running node /home/ryanf/.codex/skills/.system/openai-docs/scripts/fetch-codex-manual.mjs",
    "",
    "  Would you like to run the following command?",
    "",
    "  Environment: local",
    "",
    "  Reason: May I fetch the current official Codex manual to verify sandbox, skill, and resume guarantees for this",
    "  architecture plan?",
    "",
    "  $ node /home/ryanf/.codex/skills/.system/openai-docs/scripts/fetch-codex-manual.mjs",
    "",
    "› 1. Yes, proceed (y)",
    "  2. Yes, and don't ask again for commands that start with `node /home/ryanf/.codex/skills/.system/openai-docs/scripts/",
    "     fetch-codex-manual.mjs` (p)",
    "  3. No, and tell Codex what to do differently (esc)"
  ].join("\n");
}
