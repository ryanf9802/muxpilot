import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { serializeGitWorkflowEvent, serializeHeavyCommandQueueEvent, serializeSessionWaitEvent } from "@muxpilot/core";
import { parseCodexJsonl } from "../src/codex/parser.js";

describe("parseCodexJsonl", () => {
  it("reports active context and cache-adjusted lifetime work tokens", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muxpilot-parser-"));
    const path = join(dir, "session.jsonl");
    await writeFile(path, `${JSON.stringify({
      timestamp: "2026-08-25T00:00:00Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          model_context_window: 200_000,
          last_token_usage: { input_tokens: 149_000, total_tokens: 150_000 },
          total_token_usage: {
            input_tokens: 1_000_000,
            cached_input_tokens: 800_000,
            output_tokens: 50_000,
            reasoning_output_tokens: 25_000,
            total_tokens: 1_050_000
          }
        }
      }
    })}\n`);

    const result = await parseCodexJsonl(path, 0);

    expect(result.contextUsage).toMatchObject({
      activeTokens: 150_000,
      contextWindowTokens: 200_000,
      contextPercent: 75,
      lifetimeTotalTokens: 1_050_000,
      lifetimeWorkTokens: 275_000
    });
    expect(result.messages).toEqual([]);
  });

  it("renders an orchestration wake marker as a system status", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muxpilot-parser-"));
    const path = join(dir, "session.jsonl");
    const marker = '<muxpilot_session_wait>{"version":1,"kind":"resume_requested","sessions":[]}</muxpilot_session_wait>';
    await writeFile(path, `${JSON.stringify({
      timestamp: "2026-08-25T00:00:00Z",
      type: "event_msg",
      payload: { type: "user_message", message: marker }
    })}\n`);

    const result = await parseCodexJsonl(path, 0);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({ type: "status", role: "system", text: "Agent session wait resumed" });
  });

  it("normalizes and deduplicates orchestration wake response-item echoes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muxpilot-parser-"));
    const path = join(dir, "session.jsonl");
    const marker = serializeSessionWaitEvent({ version: 1, kind: "resume_requested", sessions: [{ id: "child-1" }] });
    await writeFile(path, [
      JSON.stringify({
        timestamp: "2026-08-25T00:00:00Z",
        type: "event_msg",
        payload: { type: "user_message", message: marker }
      }),
      JSON.stringify({
        timestamp: "2026-08-25T00:00:00.100Z",
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: marker }] }
      }),
      ""
    ].join("\n"));

    const result = await parseCodexJsonl(path, 0);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      type: "status",
      role: "system",
      text: "Agent session wait resumed",
      payload: { agentSessionWait: { version: 1, kind: "resume_requested", sessions: [{ id: "child-1" }] } }
    });
  });

  it("leaves malformed orchestration wake text visible as user input", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muxpilot-parser-"));
    const path = join(dir, "session.jsonl");
    const marker = '<muxpilot_session_wait>{"version":2,"kind":"resume_requested","sessions":[]}</muxpilot_session_wait>';
    await writeFile(path, `${JSON.stringify({
      timestamp: "2026-08-25T00:00:00Z",
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: marker }] }
    })}\n`);

    const result = await parseCodexJsonl(path, 0);

    expect(result.messages[0]).toMatchObject({ role: "user", text: marker });
  });

  it("advances across a JSONL record larger than the normal read batch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muxpilot-parser-"));
    const path = join(dir, "session.jsonl");
    const oversizedOutput = "x".repeat(1024 * 1024 + 256);
    await writeFile(
      path,
      [
        JSON.stringify({
          timestamp: "2026-07-07T00:00:00Z",
          type: "response_item",
          payload: { type: "function_call_output", output: oversizedOutput }
        }),
        JSON.stringify({
          timestamp: "2026-07-07T00:00:01Z",
          type: "response_item",
          payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "final answer" }] }
        }),
        ""
      ].join("\n")
    );

    const first = await parseCodexJsonl(path, 0);
    const second = await parseCodexJsonl(path, first.nextOffset);

    expect(first.nextOffset).toBeGreaterThan(1024 * 1024);
    expect(first.complete).toBe(false);
    expect(second.messages.map((message) => message.text)).toEqual(["final answer"]);
    expect(second.complete).toBe(true);
  });

  it("skips a record over the safety limit without pinning the parser offset", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muxpilot-parser-"));
    const path = join(dir, "session.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({ type: "response_item", payload: { type: "function_call_output", output: "x".repeat(512) } }),
        JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "after oversized record" } }),
        ""
      ].join("\n")
    );

    const first = await parseCodexJsonl(path, 0, { batchBytes: 64, maxRecordBytes: 128 });
    const second = await parseCodexJsonl(path, first.nextOffset, { batchBytes: 64, maxRecordBytes: 128 });

    expect(first.notices).toEqual([expect.stringContaining("Skipped an oversized Codex transcript record")]);
    expect(first.nextOffset).toBeGreaterThan(0);
    expect(second.messages.map((message) => message.text)).toEqual(["after oversized record"]);
    expect(second.complete).toBe(true);
  });

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

  it("preserves exact rollout turn and item identity for app-server reconciliation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muxpilot-parser-identity-"));
    const path = join(dir, "session.jsonl");
    await writeFile(path, `${JSON.stringify({
      timestamp: "2026-09-01T12:00:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        id: "msg-agent-1",
        role: "assistant",
        content: [{ type: "output_text", text: "authoritative rollout evidence" }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn-1" }
      }
    })}\n`);

    const result = await parseCodexJsonl(path, 0);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      payload: {
        codexItemIdentity: {
          turnId: "turn-1",
          itemId: "msg-agent-1",
          clientMessageId: null
        }
      }
    });
  });

  it("hides internal context compaction bookkeeping", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muxpilot-parser-"));
    const path = join(dir, "session.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({ timestamp: "2026-07-07T00:00:00Z", type: "event_msg", payload: { type: "context_compacted" } }),
        JSON.stringify({ timestamp: "2026-07-07T00:00:01Z", type: "event_msg", payload: { type: "agent_message", message: "still working" } }),
        ""
      ].join("\n")
    );

    const result = await parseCodexJsonl(path, 0);

    expect(result.messages.map((message) => message.text)).toEqual(["still working"]);
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

  it("reclassifies and deduplicates queue automation echoes in both directions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muxpilot-parser-"));
    const path = join(dir, "session.jsonl");
    const resume = serializeHeavyCommandQueueEvent({
      version: 1,
      kind: "resume_requested",
      runId: "mabc-012345abcdef",
      commandDisplay: "pnpm test",
      skill: "$muxpilot-heavy-command-queue",
      slot: 0,
      resumeCommand: "'node' 'run.mjs' '--resume' 'mabc-012345abcdef' '--' 'pnpm' 'test'"
    });
    const released = serializeHeavyCommandQueueEvent({
      version: 1,
      kind: "queue_released",
      runId: "mdef-fedcba654321",
      commandDisplay: "pnpm lint",
      skill: "$muxpilot-heavy-command-queue"
    });
    await writeFile(path, [
      JSON.stringify({ timestamp: "2026-07-07T00:00:00.000Z", type: "event_msg", payload: { type: "user_message", message: resume } }),
      JSON.stringify({ timestamp: "2026-07-07T00:00:00.100Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: resume }] } }),
      JSON.stringify({ timestamp: "2026-07-07T00:00:01.000Z", type: "event_msg", payload: { type: "agent_message", message: released } }),
      JSON.stringify({ timestamp: "2026-07-07T00:00:01.100Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: released }] } }),
      ""
    ].join("\n"));

    const result = await parseCodexJsonl(path, 0);

    expect(result.messages).toHaveLength(2);
    expect(result.messages).toEqual([
      expect.objectContaining({ role: "system", type: "status", text: "Heavyweight slot ready · session resumed automatically" }),
      expect.objectContaining({ role: "system", type: "status", text: "Heavyweight command queued · session released while waiting" })
    ]);
    expect(result.messages[0]?.payload).toHaveProperty("muxpilotHeavyCommandQueue");
  });

  it("extracts Git workflow events from function and custom tool outputs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muxpilot-parser-"));
    const path = join(dir, "session.jsonl");
    const created = serializeGitWorkflowEvent({
      version: 1,
      eventId: "mwf-012345abcdef",
      kind: "worktree_created",
      operation: "begin",
      workspaceId: "workspace-a",
      targetBranch: "main",
      sessionBranch: "muxpilot/workspace-a/task",
      worktreePath: "/tmp/task",
      skill: "$muxpilot-git-workflow"
    });
    const integrated = serializeGitWorkflowEvent({
      version: 1,
      eventId: "mwf-fedcba654321",
      kind: "integration_completed",
      operation: "finish",
      workspaceId: "workspace-a",
      targetBranch: "main",
      targetSha: "0123456789abcdef",
      cleanup: "removed",
      skill: "$muxpilot-git-workflow"
    });
    await writeFile(path, [
      JSON.stringify({
        timestamp: "2026-07-07T00:00:00.000Z",
        type: "response_item",
        payload: { type: "function_call_output", output: `command output\n${created}` }
      }),
      JSON.stringify({
        timestamp: "2026-07-07T00:00:01.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          output: [
            { type: "input_text", text: `wrapper\n${created}` },
            { type: "input_text", text: `${integrated}\nEXIT 0` }
          ]
        }
      }),
      ""
    ].join("\n"));

    const result = await parseCodexJsonl(path, 0);

    expect(result.messages.filter((item) => item.payload.muxpilotGitWorkflow)).toEqual([
      expect.objectContaining({ role: "system", type: "status", text: "Implementation worktree created" }),
      expect.objectContaining({ role: "system", type: "status", text: "Changes integrated locally" })
    ]);
    const workflowMessages = result.messages.filter((item) => item.payload.muxpilotGitWorkflow);
    expect(workflowMessages[0]?.id).toHaveLength(64);
    expect(workflowMessages[0]?.id).not.toBe(workflowMessages[1]?.id);
    expect(result.messages).toContainEqual(expect.objectContaining({ role: "tool", type: "tool_output" }));
  });

  it("keeps escalated function calls as tool transcript context", async () => {
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
    expect(result.messages[0]).toMatchObject({ type: "tool_call", role: "tool" });
  });

  it("keeps escalated wrapped custom tool calls as tool transcript context", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muxpilot-parser-"));
    const path = join(dir, "session.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({
          timestamp: "2026-07-09T00:00:00Z",
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            name: "exec",
            call_id: "call-wrapped-approval",
            input: [
              "const r = await tools.exec_command({",
              "  cmd: 'node fetch-codex-manual.mjs',",
              "  workdir: '/repo',",
              "  sandbox_permissions: 'require_escalated',",
              "  justification: 'Fetch the official manual',",
              "  prefix_rule: ['node', 'fetch-codex-manual.mjs']",
              "});"
            ].join("\n")
          }
        }),
        ""
      ].join("\n")
    );

    const result = await parseCodexJsonl(path, 0);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({ type: "tool_call", role: "tool" });
  });

  it("keeps non-escalated wrapped custom exec calls as tool transcript context", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muxpilot-parser-"));
    const path = join(dir, "session.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({
          timestamp: "2026-07-09T00:00:00Z",
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            name: "exec",
            call_id: "call-wrapped-normal",
            input: "const r = await tools.exec_command({ cmd: 'pnpm test' });"
          }
        }),
        ""
      ].join("\n")
    );

    const result = await parseCodexJsonl(path, 0);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({ type: "tool_call", role: "tool" });
  });

  it("keeps escalated wrapped calls with quoted keys and a dynamic command as tool context", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muxpilot-parser-"));
    const path = join(dir, "session.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({
          timestamp: "2026-07-09T00:00:00Z",
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            name: "exec",
            call_id: "call-dynamic-approval",
            input: [
              "const cmd = `UV_PROJECT_ENVIRONMENT=/tmp/control-api make lint`;",
              "const r = await tools.exec_command({",
              "  \"cmd\": cmd,",
              "  \"workdir\": \"/repo\",",
              "  \"sandbox_permissions\": \"require_escalated\",",
              "  \"justification\": \"Run the lint suite\",",
              "  \"prefix_rule\": [\"make\", \"lint\"]",
              "});"
            ].join("\n")
          }
        }),
        ""
      ].join("\n")
    );

    const result = await parseCodexJsonl(path, 0);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({ type: "tool_call", role: "tool" });
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
            id: "fc-question",
            name: "request_user_input",
            call_id: "call-question",
            internal_chat_message_metadata_passthrough: { turn_id: "turn-question" },
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
    expect(result.messages[0]?.payload.codexItemIdentity).toEqual({
      turnId: "turn-question",
      itemId: "call-question",
      clientMessageId: null
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
                  "<recommended_plugins>",
                  "Here is a list of plugins that are available but not installed.",
                  "- Google Drive (google-drive@openai-curated-remote)",
                  "</recommended_plugins>"
                ].join("\n")
              },
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
