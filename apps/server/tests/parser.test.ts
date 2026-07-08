import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCodexJsonl } from "../src/codex/parser.js";

describe("parseCodexJsonl", () => {
  it("maps Codex JSONL events into chat messages", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muxpilot-parser-"));
    const path = join(dir, "session.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({ timestamp: "2026-07-07T00:00:00Z", type: "event_msg", payload: { type: "user_message", message: "hello" } }),
        JSON.stringify({ timestamp: "2026-07-07T00:00:01Z", type: "event_msg", payload: { type: "agent_message", message: "hi" } }),
        JSON.stringify({
          timestamp: "2026-07-07T00:00:02Z",
          type: "response_item",
          payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "final answer" }] }
        }),
        JSON.stringify({ timestamp: "2026-07-07T00:00:03Z", type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: "{}" } }),
        JSON.stringify({ timestamp: "2026-07-07T00:00:04Z", type: "response_item", payload: { type: "function_call_output", output: "Process exited with code 0" } }),
        ""
      ].join("\n")
    );

    const result = await parseCodexJsonl(path, 0);

    expect(result.messages.map((message) => message.type)).toEqual(["user", "assistant_update", "assistant", "tool_call", "command_output"]);
    expect(result.messages[0]?.text).toBe("hello");
    expect(result.nextOffset).toBeGreaterThan(0);
  });

  it("suppresses Codex response item echoes of user messages", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muxpilot-parser-"));
    const path = join(dir, "session.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({
          timestamp: "2026-07-07T00:00:00.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "Continue" }
        }),
        JSON.stringify({
          timestamp: "2026-07-07T00:00:00.500Z",
          type: "response_item",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Continue" }] }
        }),
        JSON.stringify({
          timestamp: "2026-07-07T00:00:06.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "Continue" }
        }),
        ""
      ].join("\n")
    );

    const result = await parseCodexJsonl(path, 0);

    expect(result.messages.map((message) => message.text)).toEqual(["Continue", "Continue"]);
    expect(result.messages.map((message) => message.payload.type)).toEqual(["event_msg", "event_msg"]);
  });

  it("keeps local image parts on Codex user response items", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muxpilot-parser-"));
    const path = join(dir, "session.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({
          timestamp: "2026-07-07T00:00:00.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "Inspect this " },
              { type: "localImage", path: "/tmp/muxpilot-data/attachments/session-a/att_123.png", detail: "auto" }
            ]
          }
        }),
        ""
      ].join("\n")
    );

    const result = await parseCodexJsonl(path, 0);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.text).toBe("Inspect this");
    expect(result.messages[0]?.payload.composerParts).toEqual([
      { type: "text", text: "Inspect this " },
      { type: "image", attachmentId: "att_123" }
    ]);
  });

  it("maps escalated function calls into approval requests", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muxpilot-parser-"));
    const path = join(dir, "session.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({
          timestamp: "2026-07-07T00:00:00Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            call_id: "call_123",
            arguments: JSON.stringify({
              cmd: "npm install",
              cwd: "/repo",
              sandbox_permissions: "require_escalated",
              justification: "Install dependencies",
              prefix_rule: ["npm", "install"]
            })
          }
        }),
        ""
      ].join("\n")
    );

    const result = await parseCodexJsonl(path, 0);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.type).toBe("approval_request");
    expect(result.messages[0]?.payload.approval).toMatchObject({
      id: "call_123",
      kind: "command",
      command: "npm install",
      cwd: "/repo",
      reason: "Install dependencies",
      prefixRule: ["npm", "install"]
    });
  });

  it("maps request_user_input calls into question requests", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muxpilot-parser-"));
    const path = join(dir, "session.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({
          timestamp: "2026-07-07T00:00:00Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "request_user_input",
            call_id: "call-question",
            arguments: JSON.stringify({
              autoResolutionMs: 60000,
              questions: [
                {
                  id: "loading_treatment",
                  header: "Loading UI",
                  question: "When sending, which area should get the reduced opacity treatment?",
                  options: [
                    {
                      label: "Input only (Recommended)",
                      description: "Dims the textarea while the button shows a spinner."
                    }
                  ]
                }
              ]
            })
          }
        }),
        ""
      ].join("\n")
    );

    const result = await parseCodexJsonl(path, 0);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.type).toBe("question_request");
    expect(result.messages[0]?.payload.question).toMatchObject({
      id: "call-question",
      autoResolutionMs: 60000,
      createdAt: "2026-07-07T00:00:00Z",
      expiresAt: "2026-07-07T00:01:00.000Z",
      countdownStartedAt: null,
      countdownExpiresAt: null,
      questions: [
        {
          id: "loading_treatment",
          header: "Loading UI",
          question: "When sending, which area should get the reduced opacity treatment?",
          options: [
            {
              label: "Input only (Recommended)",
              description: "Dims the textarea while the button shows a spinner."
            }
          ]
        }
      ]
    });
  });

  it("tags messages with the active collaboration mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muxpilot-parser-"));
    const path = join(dir, "session.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({
          timestamp: "2026-07-07T00:00:00Z",
          type: "event_msg",
          payload: { type: "task_started", collaboration_mode_kind: "plan" }
        }),
        JSON.stringify({ timestamp: "2026-07-07T00:00:01Z", type: "event_msg", payload: { type: "user_message", message: "plan prompt" } }),
        JSON.stringify({
          timestamp: "2026-07-07T00:00:02Z",
          type: "response_item",
          payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "plan answer" }] }
        }),
        JSON.stringify({
          timestamp: "2026-07-07T00:00:03Z",
          type: "event_msg",
          payload: { type: "task_started", collaboration_mode_kind: "default" }
        }),
        JSON.stringify({ timestamp: "2026-07-07T00:00:04Z", type: "event_msg", payload: { type: "user_message", message: "normal prompt" } }),
        ""
      ].join("\n")
    );

    const result = await parseCodexJsonl(path, 0);

    expect(result.messages.map((message) => message.payload.collaborationMode)).toEqual([
      "plan",
      "plan",
      "plan",
      "default",
      "default"
    ]);
  });

  it("compacts inline skill context in user messages", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muxpilot-parser-"));
    const path = join(dir, "session.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({
          timestamp: "2026-07-07T00:00:00Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: [
              "open a $pr-to-stage",
              "",
              "<skill>",
              "<name>pr-to-stage</name>",
              "<path>/home/dev/.codex/skills/pr-to-stage/SKILL.md</path>",
              "---",
              "name: pr-to-stage",
              "---",
              "# Pr To Stage",
              "</skill>"
            ].join("\n")
          }
        }),
        ""
      ].join("\n")
    );

    const result = await parseCodexJsonl(path, 0);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.type).toBe("user");
    expect(result.messages[0]?.text).toBe("open a $pr-to-stage\n\nSkills: pr-to-stage");
  });

  it("merges skill-only user events into the previous user message", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muxpilot-parser-"));
    const path = join(dir, "session.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({ timestamp: "2026-07-07T00:00:00Z", type: "event_msg", payload: { type: "user_message", message: "open a $pr-to-stage" } }),
        JSON.stringify({
          timestamp: "2026-07-07T00:00:01Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: [
              "<skill>",
              "<name>pr-to-stage</name>",
              "<path>/home/dev/.codex/skills/pr-to-stage/SKILL.md</path>",
              "---",
              "name: pr-to-stage",
              "---",
              "# Pr To Stage",
              "</skill>"
            ].join("\n")
          }
        }),
        ""
      ].join("\n")
    );

    const result = await parseCodexJsonl(path, 0);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.text).toBe("open a $pr-to-stage\n\nSkills: pr-to-stage");
  });

  it("returns pending skill names when a skill-only event has no in-batch user message", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muxpilot-parser-"));
    const path = join(dir, "session.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({
          timestamp: "2026-07-07T00:00:00Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: [
              "<skill>",
              "<name>teamweave-browser</name>",
              "<path>/home/dev/.codex/skills/teamweave-browser/SKILL.md</path>",
              "# TeamWeave Browser Workflow",
              "</skill>"
            ].join("\n")
          }
        }),
        ""
      ].join("\n")
    );

    const result = await parseCodexJsonl(path, 0);

    expect(result.messages).toEqual([]);
    expect(result.pendingSkillNames).toEqual(["teamweave-browser"]);
  });

  it("drops environment context user events", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muxpilot-parser-"));
    const path = join(dir, "session.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({ timestamp: "2026-07-07T00:00:00Z", type: "event_msg", payload: { type: "user_message", message: "actual prompt" } }),
        JSON.stringify({
          timestamp: "2026-07-07T00:00:01Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: [
              "<environment_context>",
              "  <cwd>/home/dev/workspace/muxpilot</cwd>",
              "  <shell>bash</shell>",
              "</environment_context>"
            ].join("\n")
          }
        }),
        ""
      ].join("\n")
    );

    const result = await parseCodexJsonl(path, 0);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.text).toBe("actual prompt");
  });

  it("maps subagent notifications into collapsed system status events", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muxpilot-parser-"));
    const path = join(dir, "session.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({
          timestamp: "2026-07-07T00:00:00Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: [
              "<subagent_notification>",
              JSON.stringify({
                agent_path: "019f3ef2-2b43-77a1-a379-f9ddc8b270b3",
                status: { completed: "No blocking findings in the staged diff." }
              }),
              "</subagent_notification>"
            ].join("\n")
          }
        }),
        ""
      ].join("\n")
    );

    const result = await parseCodexJsonl(path, 0);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      type: "status",
      role: "system",
      text: "Subagent completed: 019f3ef2-2b43-77a1-a379-f9ddc8b270b3\n\nNo blocking findings in the staged diff.",
      payload: {
        subagentNotification: {
          agentPath: "019f3ef2-2b43-77a1-a379-f9ddc8b270b3",
          text: "Subagent completed: 019f3ef2-2b43-77a1-a379-f9ddc8b270b3\n\nNo blocking findings in the staged diff."
        }
      }
    });
  });

  it("maps AGENTS.md instruction context into a compact status event", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muxpilot-parser-"));
    const path = join(dir, "session.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({
          timestamp: "2026-07-07T00:00:00Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: [
              "# AGENTS.md instructions for /home/dev/workspace/teamweave",
              "",
              "<INSTRUCTIONS>",
              "# Repository Guidelines",
              "",
              "## Directory-Local Rules",
              "Before changing files in a directory, read that directory's AGENTS.md.",
              "</INSTRUCTIONS>"
            ].join("\n")
          }
        }),
        ""
      ].join("\n")
    );

    const result = await parseCodexJsonl(path, 0);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      type: "status",
      role: "system",
      text: "Loaded AGENTS.md instructions for /home/dev/workspace/teamweave"
    });
  });

  it("maps response-item instruction plus environment context into a compact status event", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muxpilot-parser-"));
    const path = join(dir, "session.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({
          timestamp: "2026-07-07T00:00:00Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: [
                  "# AGENTS.md instructions for /home/dev/workspace/teamweave",
                  "",
                  "<INSTRUCTIONS>",
                  "# Repository Guidelines",
                  "",
                  "## Directory-Local Rules",
                  "Before changing files in a directory, read that directory's AGENTS.md.",
                  "</INSTRUCTIONS>"
                ].join("\n")
              },
              {
                type: "input_text",
                text: [
                  "<environment_context>",
                  "  <cwd>/home/dev/workspace/teamweave</cwd>",
                  "  <shell>bash</shell>",
                  "</environment_context>"
                ].join("\n")
              }
            ]
          }
        }),
        ""
      ].join("\n")
    );

    const result = await parseCodexJsonl(path, 0);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      type: "status",
      role: "system",
      text: "Loaded AGENTS.md instructions for /home/dev/workspace/teamweave"
    });
  });

  it("maps turn-aborted user context into a system status event", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muxpilot-parser-"));
    const path = join(dir, "session.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({
          timestamp: "2026-07-07T00:00:00Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: [
              "<turn_aborted>",
              "The user interrupted the previous turn on purpose.",
              "</turn_aborted>"
            ].join("\n")
          }
        }),
        ""
      ].join("\n")
    );

    const result = await parseCodexJsonl(path, 0);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      type: "status",
      role: "system",
      text: "Turn aborted"
    });
  });

  it("maps structured exec approval events into approval requests", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muxpilot-parser-"));
    const path = join(dir, "session.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({
          timestamp: "2026-07-07T00:00:00Z",
          type: "event_msg",
          payload: {
            type: "exec_approval_request",
            approval_id: "approval-1",
            command: ["pnpm", "build"],
            cwd: "/repo",
            reason: "Build verification",
            proposed_execpolicy_amendment: { command: ["pnpm", "build"] }
          }
        }),
        ""
      ].join("\n")
    );

    const result = await parseCodexJsonl(path, 0);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.type).toBe("approval_request");
    expect(result.messages[0]?.payload.approval).toMatchObject({
      id: "approval-1",
      kind: "command",
      command: "pnpm build",
      cwd: "/repo",
      reason: "Build verification",
      prefixRule: ["pnpm", "build"]
    });
  });
});
