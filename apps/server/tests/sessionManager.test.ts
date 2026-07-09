import { appendFile, mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TmuxPane } from "@muxpilot/core";
import type { CodexProcessInfo } from "../src/codex/codexProcessResolver.js";
import { CodexSessionStore } from "../src/codex/codexSessionStore.js";
import { AppDatabase } from "../src/db/database.js";
import { EventBus } from "../src/services/eventBus.js";
import { SessionManager } from "../src/services/sessionManager.js";
import { TmuxAdapter } from "../src/tmux/tmuxAdapter.js";

describe("SessionManager transcript isolation", () => {
  it("clears stale messages when a tmux pane binds to a new Codex session file", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const pane = testPane({ cwd: repo, paneId: "%1" });

    await writeCodexSession(harness.codexHome, "first.jsonl", {
      sessionId: "codex-first",
      cwd: repo,
      user: "first prompt",
      assistant: "first answer",
      mtime: new Date("2026-07-07T00:00:00.000Z")
    });
    harness.tmux.listPanes = async () => [pane];

    await harness.manager.discover();
    await harness.manager.ingest();
    const session = harness.manager.listSessions(true)[0];
    expect(session).toBeDefined();
    expect(harness.manager.listMessages(session.id, 0).map((message) => message.text)).toEqual(["first prompt", "first answer"]);

    await writeCodexSession(harness.codexHome, "second.jsonl", {
      sessionId: "codex-second",
      cwd: repo,
      user: "second prompt",
      assistant: "second answer",
      mtime: new Date("2026-07-07T00:01:00.000Z")
    });
    harness.processLookup.set(pane.pid, {
      pid: 999,
      sessionId: null,
      startedAtMs: new Date("2026-07-07T00:01:00.000Z").getTime()
    });

    await harness.manager.discover();
    await harness.manager.ingest();

    expect(harness.manager.getSession(session.id)?.codexSessionId).toBe("codex-second");
    expect(harness.manager.listMessages(session.id, 0).map((message) => message.text)).toEqual(["second prompt", "second answer"]);
    harness.db.close();
  });

  it("stamps transcript pages with the current Codex source", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const pane = testPane({ cwd: repo, paneId: "%1" });

    await writeCodexSession(harness.codexHome, "source.jsonl", {
      sessionId: "codex-source",
      cwd: repo,
      user: "source prompt",
      assistant: "source answer",
      mtime: new Date("2026-07-07T00:00:00.000Z")
    });
    harness.tmux.listPanes = async () => [pane];

    await harness.manager.discover();
    await harness.manager.ingest();

    const session = (await harness.manager.listSessions(true))[0];
    expect(session).toBeDefined();

    const page = await harness.manager.listActiveTailMessages(session!.id, 80);
    expect(page).toMatchObject({
      sessionId: session!.id,
      codexSessionId: "codex-source",
      codexJsonlPath: session!.codexJsonlPath
    });

    const range = await harness.manager.listMessageRange(session!.id, 1, 2);
    expect(range).toMatchObject({
      sessionId: session!.id,
      codexSessionId: "codex-source",
      codexJsonlPath: session!.codexJsonlPath
    });
    harness.db.close();
  });

  it("keeps identical messages in different Codex sessions separate", async () => {
    const harness = await createHarness();
    const repoA = join(harness.dir, "repo-a");
    const repoB = join(harness.dir, "repo-b");
    await mkdir(repoA);
    await mkdir(repoB);
    const timestamp = new Date("2026-07-07T00:00:00.000Z");

    await writeCodexSession(harness.codexHome, "a.jsonl", {
      sessionId: "codex-a",
      cwd: repoA,
      user: "shared prompt",
      assistant: "shared answer",
      mtime: timestamp
    });
    await writeCodexSession(harness.codexHome, "b.jsonl", {
      sessionId: "codex-b",
      cwd: repoB,
      user: "shared prompt",
      assistant: "shared answer",
      mtime: timestamp
    });

    harness.tmux.listPanes = async () => [testPane({ cwd: repoA, paneId: "%1" }), testPane({ cwd: repoB, paneId: "%2" })];

    await harness.manager.discover();
    await harness.manager.ingest();

    const sessions = harness.manager.listSessions(true);
    expect(sessions).toHaveLength(2);
    for (const session of sessions) {
      expect(harness.manager.listMessages(session.id, 0).map((message) => message.text)).toEqual(["shared prompt", "shared answer"]);
    }
    harness.db.close();
  });

  it("schedules activity summaries only for parsed user messages", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    await writeCodexSession(harness.codexHome, "session.jsonl", {
      sessionId: "codex-session",
      cwd: repo,
      user: "summary source prompt",
      assistant: "assistant output should not schedule summaries",
      mtime: new Date("2026-07-07T00:00:00.000Z")
    });
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];

    await harness.manager.discover();
    await harness.manager.ingest();

    const session = harness.manager.listSessions(true)[0];
    expect(session).toBeDefined();
    expect(harness.activitySummarizer.scheduledSessionIds).toEqual([session.id]);
    harness.db.close();
  });

  it("does not schedule activity summaries when summary generation is disabled", async () => {
    const harness = await createHarness();
    harness.activitySummarizer.setEnabled(false);
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    await writeCodexSession(harness.codexHome, "session.jsonl", {
      sessionId: "codex-session",
      cwd: repo,
      user: "summary generation disabled",
      assistant: "assistant output",
      mtime: new Date("2026-07-07T00:00:00.000Z")
    });
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];

    await harness.manager.discover();
    await harness.manager.ingest();

    expect(harness.activitySummarizer.scheduledSessionIds).toEqual([]);
    harness.db.close();
  });

  it("does not append later response item echoes of user messages", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const path = join(harness.codexHome, "sessions", "user-echo.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({
          timestamp: "2026-07-07T00:00:00.000Z",
          type: "session_meta",
          payload: { session_id: "codex-session", cwd: repo, cli_version: "test" }
        }),
        JSON.stringify({
          timestamp: "2026-07-07T00:00:01.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "Continue" }
        }),
        ""
      ].join("\n")
    );
    await utimes(path, new Date("2026-07-07T00:00:00.000Z"), new Date("2026-07-07T00:00:00.000Z"));
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];

    await harness.manager.discover();
    await harness.manager.ingest();
    const session = harness.manager.listSessions(true)[0];
    expect(session).toBeDefined();

    await appendFile(
      path,
      [
        JSON.stringify({
          timestamp: "2026-07-07T00:00:01.500Z",
          type: "response_item",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Continue" }] }
        }),
        ""
      ].join("\n")
    );
    await harness.manager.ingest();

    expect(harness.manager.listMessages(session.id, 0).map((message) => message.text)).toEqual(["Continue"]);
    expect(harness.activitySummarizer.scheduledSessionIds).toEqual([session.id]);
    harness.db.close();
  });

  it("does not schedule activity summaries for assistant-only appended messages", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const path = join(harness.codexHome, "sessions", "assistant-only.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({
          timestamp: "2026-07-07T00:00:00.000Z",
          type: "session_meta",
          payload: { session_id: "codex-session", cwd: repo, cli_version: "test" }
        }),
        JSON.stringify({
          timestamp: "2026-07-07T00:00:01.000Z",
          type: "event_msg",
          payload: { type: "agent_message", message: "assistant only" }
        }),
        ""
      ].join("\n")
    );
    await utimes(path, new Date("2026-07-07T00:00:00.000Z"), new Date("2026-07-07T00:00:00.000Z"));
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];

    await harness.manager.discover();
    await harness.manager.ingest();

    expect(harness.activitySummarizer.scheduledSessionIds).toEqual([]);
    harness.db.close();
  });

  it("merges late skill-only user events into the existing user message", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const path = join(harness.codexHome, "sessions", "late-skill.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({
          timestamp: "2026-07-07T00:00:00.000Z",
          type: "session_meta",
          payload: { session_id: "codex-session", cwd: repo, cli_version: "test" }
        }),
        JSON.stringify({
          timestamp: "2026-07-07T00:00:01.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "Test skill $teamweave-browser" }
        }),
        ""
      ].join("\n")
    );
    await utimes(path, new Date("2026-07-07T00:00:00.000Z"), new Date("2026-07-07T00:00:00.000Z"));
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];

    await harness.manager.discover();
    await harness.manager.ingest();
    const session = harness.manager.listSessions(true)[0];
    expect(session).toBeDefined();
    expect(harness.manager.listMessages(session.id, 0).map((message) => message.text)).toEqual(["Test skill $teamweave-browser"]);

    await appendFile(
      path,
      [
        JSON.stringify({
          timestamp: "2026-07-07T00:00:02.000Z",
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
    await harness.manager.ingest();

    expect(harness.manager.listMessages(session.id, 0).map((message) => message.text)).toEqual([
      "Test skill $teamweave-browser\n\nSkills: teamweave-browser"
    ]);
    harness.db.close();
  });

  it("keeps a reparsed approval pending until it is resolved", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const path = join(harness.codexHome, "sessions", "approval.jsonl");
    const sentKeys: string[][] = [];
    await writeFile(
      path,
      [
        JSON.stringify({
          timestamp: "2026-07-07T00:00:00.000Z",
          type: "session_meta",
          payload: { session_id: "codex-session", cwd: repo, cli_version: "test" }
        }),
        JSON.stringify({
          timestamp: "2026-07-07T00:00:01.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            call_id: "call-approval",
            arguments: JSON.stringify({
              cmd: "tmux list-panes -a -F '#{session_id} #{window_id} #{pane_id}'",
              sandbox_permissions: "require_escalated",
              justification: "Verify session mappings",
              prefix_rule: ["tmux", "list-panes"]
            })
          }
        }),
        ""
      ].join("\n")
    );
    await utimes(path, new Date("2026-07-07T00:00:00.000Z"), new Date("2026-07-07T00:00:00.000Z"));
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.capturePane = async () => "› ";
    harness.tmux.sendKeys = async (_paneId, keys) => {
      sentKeys.push(keys);
    };

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0];
    expect(session).toBeDefined();

    await harness.manager.ingest();
    expect((await harness.manager.getPendingApproval(session.id))?.prefixRule).toEqual(["tmux", "list-panes"]);

    await harness.db.resetParserOffset(`${session.id}:${path}`);
    await harness.manager.ingest();
    await harness.manager.discover();

    const approval = await harness.manager.getPendingApproval(session.id);
    expect(approval?.command).toContain("tmux list-panes");
    expect(approval?.prefixRule).toEqual(["tmux", "list-panes"]);

    harness.tmux.capturePane = async () => "Command approval required\nallow and don't ask again";
    await harness.manager.resolveApproval(session.id, { decision: "approve_for_prefix" });
    expect(sentKeys).toEqual([[]]);
    expect(await harness.manager.getPendingApproval(session.id)).toBeNull();
    harness.db.close();
  });

  it("surfaces and resolves app permission prompts that have no JSONL approval event", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const path = join(harness.codexHome, "sessions", "app-approval.jsonl");
    const sentKeys: string[][] = [];
    await writeFile(
      path,
      [
        JSON.stringify({
          timestamp: "2026-07-07T00:00:00.000Z",
          type: "session_meta",
          payload: { session_id: "codex-session", cwd: repo, cli_version: "test" }
        }),
        JSON.stringify({
          timestamp: "2026-07-07T00:00:01.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "_create_pull_request",
            namespace: "mcp__codex_apps__github",
            call_id: "call-app-approval",
            arguments: JSON.stringify({ title: "Scope assignment CADs to workspace", base: "stage" })
          }
        }),
        ""
      ].join("\n")
    );
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    let capture = appApprovalCapture(1);
    harness.tmux.capturePane = async () => capture;
    harness.tmux.sendKeys = async (_paneId, keys) => {
      sentKeys.push(keys);
    };

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0];
    expect(session?.status).toBe("waiting");
    await harness.manager.ingest();
    await harness.manager.discover();
    expect((await harness.manager.getSession(session.id))?.status).toBe("approval");
    capture = "Ready\n› ";

    expect(await harness.manager.getPendingApproval(session.id)).toMatchObject({
      id: "call-app-approval",
      kind: "permissions",
      title: "Allow GitHub to create a pull request?",
      toolName: "codex_apps.github.create_pull_request",
      options: [
        { decision: "approve_once", label: "Allow" },
        { decision: "approve_for_session", label: "Allow for this session" },
        { decision: "approve_always", label: "Always allow" },
        { decision: "deny", label: "Cancel" }
      ]
    });

    capture = appApprovalCapture(1);
    await harness.manager.resolveApproval(session.id, { decision: "approve_for_session" });
    expect(sentKeys).toEqual([["Down", "Enter"]]);
    expect((await harness.manager.getSession(session.id))?.status).toBe("waiting");
    harness.db.close();
  });

  it("surfaces and resolves command approval prompts that have no JSONL approval event", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const path = join(harness.codexHome, "sessions", "command-approval.jsonl");
    const sentKeys: string[][] = [];
    await writeFile(
      path,
      [
        JSON.stringify({
          timestamp: "2026-07-09T00:00:00.000Z",
          type: "session_meta",
          payload: { session_id: "codex-session", cwd: repo, cli_version: "test" }
        }),
        JSON.stringify({
          timestamp: "2026-07-09T00:00:01.000Z",
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            name: "exec",
            call_id: "call-command-approval",
            input: "const r = await tools.exec_command({ sandbox_permissions: 'require_escalated' });"
          }
        }),
        ""
      ].join("\n")
    );
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.capturePane = async () => commandApprovalCapture(1);
    harness.tmux.sendKeys = async (_paneId, keys) => {
      sentKeys.push(keys);
    };

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0];
    expect(session?.status).toBe("waiting");
    await harness.manager.ingest();
    await harness.manager.discover();
    expect((await harness.manager.getSession(session.id))?.status).toBe("approval");

    expect(await harness.manager.getPendingApproval(session.id)).toMatchObject({
      kind: "command",
      title: "Would you like to run the following command?",
      command: "pnpm app restart prod",
      reason: "Do you want to allow restarting the muxpilot production server so the simplified hold feedback is live?",
      prefixRule: ["pnpm", "app", "restart", "prod"],
      options: [
        { decision: "approve_once", label: "Approve once" },
        { decision: "approve_for_prefix", label: "Always allow prefix" },
        { decision: "deny", label: "Deny" }
      ]
    });

    await harness.manager.resolveApproval(session.id, { decision: "approve_for_prefix" });
    expect(sentKeys).toEqual([["Down", "Enter"]]);
    expect((await harness.manager.getSession(session.id))?.status).toBe("waiting");
    expect(await harness.manager.getPendingApproval(session.id)).toBeNull();
    harness.db.close();
  });

  it("does not send approval keys when an app permission prompt changes before resolution", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const sentKeys: string[][] = [];
    let resolving = false;
    let resolutionCaptureCount = 0;
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.capturePane = async () => {
      if (!resolving) return appApprovalCapture(1);
      resolutionCaptureCount += 1;
      return resolutionCaptureCount === 1 ? appApprovalCapture(1) : "Ready\n› ";
    };
    harness.tmux.sendKeys = async (_paneId, keys) => {
      sentKeys.push(keys);
    };

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0];
    await harness.db.setSessionStatus(session.id, "approval", "2026-07-09T00:00:00.000Z");
    resolving = true;

    await expect(harness.manager.resolveApproval(session.id, { decision: "approve_always" })).rejects.toThrow(
      "not showing an approval gate"
    );
    expect(sentKeys).toEqual([]);
    harness.db.close();
  });

  it("keeps parsed questions pending and answers option prompts with menu keys", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const path = join(harness.codexHome, "sessions", "question.jsonl");
    const sentKeys: string[][] = [];
    await writeFile(
      path,
      [
        JSON.stringify({
          timestamp: "2026-07-07T00:00:00.000Z",
          type: "session_meta",
          payload: { session_id: "codex-session", cwd: repo, cli_version: "test" }
        }),
        JSON.stringify({
          timestamp: "2026-07-07T00:00:01.000Z",
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
    await utimes(path, new Date("2026-07-07T00:00:00.000Z"), new Date("2026-07-07T00:00:00.000Z"));
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.capturePane = async () => "› ";
    harness.tmux.sendKeys = async (_paneId, keys) => {
      sentKeys.push(keys);
    };

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0];
    expect(session).toBeDefined();

    await harness.manager.ingest();

    expect(harness.manager.getSession(session.id)?.status).toBe("question");
    const pendingQuestion = await harness.manager.getPendingQuestion(session.id);
    expect(pendingQuestion?.questions[0]?.id).toBe("loading_treatment");
    expect(pendingQuestion?.createdAt).toBe("2026-07-07T00:00:01.000Z");
    expect(pendingQuestion?.expiresAt).toBe("2026-07-07T00:01:01.000Z");
    expect(pendingQuestion?.countdownStartedAt).not.toBe("2026-07-07T00:00:01.000Z");
    expect(pendingQuestion?.countdownExpiresAt).not.toBe("2026-07-07T00:01:01.000Z");
    expect(Date.parse(pendingQuestion?.countdownExpiresAt ?? "") - Date.parse(pendingQuestion?.countdownStartedAt ?? "")).toBe(
      60000
    );

    await harness.manager.discover();

    expect(harness.manager.getSession(session.id)?.status).toBe("question");
    expect((await harness.manager.getPendingQuestion(session.id))?.questions[0]?.id).toBe("loading_treatment");

    await harness.manager.answerQuestion(session.id, {
      answers: {
        loading_treatment: { answers: ["Input only (Recommended)"] }
      }
    });

    expect(sentKeys).toEqual([["Enter"]]);
    expect(harness.manager.getSession(session.id)?.status).toBe("waiting");
    expect(await harness.manager.getPendingQuestion(session.id)).toBeNull();
    harness.db.close();
  });

  it("answers option prompts before interrupting and sending other text", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const path = join(harness.codexHome, "sessions", "question-options.jsonl");
    const operations: string[] = [];
    await writeFile(
      path,
      [
        JSON.stringify({
          timestamp: "2026-07-07T00:00:00.000Z",
          type: "session_meta",
          payload: { session_id: "codex-session", cwd: repo, cli_version: "test" }
        }),
        JSON.stringify({
          timestamp: "2026-07-07T00:00:01.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "request_user_input",
            call_id: "call-question",
            arguments: JSON.stringify({
              questions: [
                {
                  id: "scope",
                  header: "Scope",
                  question: "How far should this go?",
                  options: [
                    { label: "Small", description: "" },
                    { label: "Complete", description: "" }
                  ]
                },
                {
                  id: "note",
                  header: "Note",
                  question: "Any note?",
                  options: [{ label: "None", description: "" }]
                },
                {
                  id: "details",
                  header: "Details",
                  question: "What should Codex know?",
                  options: []
                }
              ]
            })
          }
        }),
        ""
      ].join("\n")
    );
    await utimes(path, new Date("2026-07-07T00:00:00.000Z"), new Date("2026-07-07T00:00:00.000Z"));
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.sendKeys = async (_paneId, keys) => {
      operations.push(`keys:${keys.join(",")}`);
    };
    harness.tmux.pasteText = async (_paneId, text) => {
      operations.push(`paste:${text}`);
    };
    harness.tmux.interrupt = async () => {
      operations.push("interrupt");
    };
    harness.tmux.sendInput = async (_paneId, text) => {
      operations.push(`input:${text}`);
    };

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0];
    expect(session).toBeDefined();
    await harness.manager.ingest();

    await harness.manager.answerQuestion(session.id, {
      answers: {
        scope: { answers: ["Complete", "Include tests"] },
        note: { answers: ["None of the above", "Ship it"] },
        details: { answers: ["Typed only"] }
      }
    });

    expect(operations).toEqual([
      "keys:Down,Enter",
      "keys:Down,Enter",
      "paste:Typed only ",
      "keys:Enter",
      "interrupt",
      "input:Include tests\n\nShip it "
    ]);
    harness.db.close();
  });

  it("does not resurface a parsed question after later user input", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const path = join(harness.codexHome, "sessions", "stale-question.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({
          timestamp: "2026-07-07T00:00:00.000Z",
          type: "session_meta",
          payload: { session_id: "codex-session", cwd: repo, cli_version: "test" }
        }),
        JSON.stringify({
          timestamp: "2026-07-07T00:00:01.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "request_user_input",
            call_id: "call-question",
            arguments: JSON.stringify({
              questions: [
                {
                  id: "fix_depth",
                  header: "Fix Depth",
                  question: "How far should the performance fix go in this pass?",
                  options: []
                }
              ]
            })
          }
        }),
        ""
      ].join("\n")
    );
    await utimes(path, new Date("2026-07-07T00:00:00.000Z"), new Date("2026-07-07T00:00:00.000Z"));
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.capturePane = async () => "› ";

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0];
    expect(session).toBeDefined();
    await harness.manager.ingest();

    expect((await harness.manager.getPendingQuestion(session.id))?.questions[0]?.id).toBe("fix_depth");

    await appendFile(
      path,
      [
        JSON.stringify({
          timestamp: "2026-07-07T00:00:02.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "{\"answers\":{\"fix_depth\":{\"answers\":[\"Small fix\"]}}}" }
        }),
        ""
      ].join("\n")
    );
    await utimes(path, new Date("2026-07-07T00:00:02.000Z"), new Date("2026-07-07T00:00:02.000Z"));

    await harness.manager.ingest();
    await harness.manager.discover();

    expect(harness.manager.getSession(session.id)?.status).toBe("waiting");
    expect(await harness.manager.getPendingQuestion(session.id)).toBeNull();
    harness.db.close();
  });

  it("does not resurface a parsed question after a matching function call output answer", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const path = join(harness.codexHome, "sessions", "answered-question-output.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({
          timestamp: "2026-07-07T00:00:00.000Z",
          type: "session_meta",
          payload: { session_id: "codex-session", cwd: repo, cli_version: "test" }
        }),
        JSON.stringify({
          timestamp: "2026-07-07T00:00:01.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "request_user_input",
            call_id: "call-question",
            arguments: JSON.stringify({
              autoResolutionMs: 60000,
              questions: [
                {
                  id: "queue_mode",
                  header: "Queue Mode",
                  question: "Which queued-message behavior should the plan target?",
                  options: []
                }
              ]
            })
          }
        }),
        ""
      ].join("\n")
    );
    await utimes(path, new Date("2026-07-07T00:00:00.000Z"), new Date("2026-07-07T00:00:00.000Z"));
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.capturePane = async () => "› ";

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0];
    expect(session).toBeDefined();
    await harness.manager.ingest();

    expect(harness.manager.getSession(session.id)?.status).toBe("question");
    expect((await harness.manager.getPendingQuestion(session.id))?.questions[0]?.id).toBe("queue_mode");

    await appendFile(
      path,
      [
        JSON.stringify({
          timestamp: "2026-07-07T00:00:02.000Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call-question",
            output: JSON.stringify({
              answers: {
                queue_mode: {
                  answers: [
                    "Auto-send (Recommended)",
                    "user_note: Auto-send, but queued messages should stay editable before they are sent"
                  ]
                }
              }
            })
          }
        }),
        ""
      ].join("\n")
    );
    await utimes(path, new Date("2026-07-07T00:00:02.000Z"), new Date("2026-07-07T00:00:02.000Z"));

    await harness.manager.ingest();

    expect(await harness.manager.getPendingQuestion(session.id)).toBeNull();

    await harness.manager.discover();

    expect(harness.manager.getSession(session.id)?.status).toBe("waiting");
    expect(await harness.manager.getPendingQuestion(session.id)).toBeNull();
    harness.db.close();
  });

  it("keeps a parsed question pending after an unrelated function call output", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const path = join(harness.codexHome, "sessions", "unrelated-question-output.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({
          timestamp: "2026-07-07T00:00:00.000Z",
          type: "session_meta",
          payload: { session_id: "codex-session", cwd: repo, cli_version: "test" }
        }),
        JSON.stringify({
          timestamp: "2026-07-07T00:00:01.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "request_user_input",
            call_id: "call-question",
            arguments: JSON.stringify({
              questions: [
                {
                  id: "queue_mode",
                  header: "Queue Mode",
                  question: "Which queued-message behavior should the plan target?",
                  options: []
                }
              ]
            })
          }
        }),
        JSON.stringify({
          timestamp: "2026-07-07T00:00:02.000Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call-other",
            output: JSON.stringify({
              answers: {
                queue_mode: { answers: ["Auto-send (Recommended)"] }
              }
            })
          }
        }),
        ""
      ].join("\n")
    );
    await utimes(path, new Date("2026-07-07T00:00:00.000Z"), new Date("2026-07-07T00:00:00.000Z"));
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.capturePane = async () => "› ";

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0];
    expect(session).toBeDefined();
    await harness.manager.ingest();
    await harness.manager.discover();

    expect(harness.manager.getSession(session.id)?.status).toBe("question");
    expect((await harness.manager.getPendingQuestion(session.id))?.questions[0]?.id).toBe("queue_mode");
    harness.db.close();
  });

  it("shows a newer proposed plan instead of an older parsed question", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const path = join(harness.codexHome, "sessions", "question-then-plan.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({
          timestamp: "2026-07-07T00:00:00.000Z",
          type: "session_meta",
          payload: { session_id: "codex-session", cwd: repo, cli_version: "test" }
        }),
        JSON.stringify({
          timestamp: "2026-07-07T00:00:01.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "request_user_input",
            call_id: "call-question",
            arguments: JSON.stringify({
              questions: [
                {
                  id: "fix_depth",
                  header: "Fix Depth",
                  question: "How far should the performance fix go in this pass?",
                  options: []
                }
              ]
            })
          }
        }),
        JSON.stringify({
          timestamp: "2026-07-07T00:00:02.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "<proposed_plan>\nDo it.\n</proposed_plan>" }]
          }
        }),
        ""
      ].join("\n")
    );
    await utimes(path, new Date("2026-07-07T00:00:00.000Z"), new Date("2026-07-07T00:00:00.000Z"));
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.capturePane = async () => "› ";

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0];
    expect(session).toBeDefined();
    await harness.manager.ingest();

    expect(harness.manager.getSession(session.id)?.status).toBe("plan_ready");
    expect(await harness.manager.getPendingQuestion(session.id)).toBeNull();

    await harness.manager.discover();

    expect(harness.manager.getSession(session.id)?.status).toBe("plan_ready");
    expect(await harness.manager.getPendingQuestion(session.id)).toBeNull();
    harness.db.close();
  });

  it("keeps plan-mode sessions planning while the proposed plan is still being emitted", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const path = join(harness.codexHome, "sessions", "planning-plan-output.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({
          timestamp: "2026-07-07T00:00:00.000Z",
          type: "session_meta",
          payload: { session_id: "codex-session", cwd: repo, cli_version: "test" }
        }),
        JSON.stringify({
          timestamp: "2026-07-07T00:00:01.000Z",
          type: "event_msg",
          payload: { type: "task_started", collaboration_mode_kind: "plan" }
        }),
        JSON.stringify({
          timestamp: "2026-07-07T00:00:02.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "make a plan" }
        }),
        ""
      ].join("\n")
    );
    await utimes(path, new Date("2026-07-07T00:00:00.000Z"), new Date("2026-07-07T00:00:00.000Z"));
    let capture = "working (1s)\nEsc to interrupt";
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.capturePane = async () => capture;

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0];
    expect(session).toBeDefined();
    await harness.manager.ingest();
    await harness.manager.discover();

    expect(harness.manager.getSession(session.id)?.status).toBe("planning");

    capture = "› ";
    await harness.manager.discover();

    expect(harness.manager.getSession(session.id)?.status).toBe("planning");

    await appendFile(
      path,
      [
        JSON.stringify({
          timestamp: "2026-07-07T00:00:03.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "<proposed_plan>\nDo it.\n</proposed_plan>" }]
          }
        }),
        ""
      ].join("\n")
    );
    await harness.manager.ingest();

    expect(harness.manager.getSession(session.id)?.status).toBe("plan_ready");
    harness.db.close();
  });

  it("keeps planning from session input mode when transcript mode metadata is missing", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const path = join(harness.codexHome, "sessions", "planning-without-mode-metadata.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({
          timestamp: "2026-07-07T00:00:00.000Z",
          type: "session_meta",
          payload: { session_id: "codex-session", cwd: repo, cli_version: "test" }
        }),
        JSON.stringify({
          timestamp: "2026-07-07T00:00:01.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "make a plan" }
        }),
        JSON.stringify({
          timestamp: "2026-07-07T00:00:02.000Z",
          type: "event_msg",
          payload: { type: "agent_message", message: "I will inspect the code and produce a plan." }
        }),
        ""
      ].join("\n")
    );
    await utimes(path, new Date("2026-07-07T00:00:00.000Z"), new Date("2026-07-07T00:00:00.000Z"));
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1", title: "plan-mode" })];
    harness.tmux.capturePane = async () => "Plan mode prompt:\n› ";

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0];
    expect(session).toBeDefined();
    expect(session.inputMode).toBe("plan");
    await harness.manager.ingest();
    await harness.manager.discover();

    expect(harness.manager.getSession(session.id)?.status).toBe("planning");
    harness.db.close();
  });

  it("marks complete proposed plans as plan ready until a plan action is chosen", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const path = join(harness.codexHome, "sessions", "plan-ready.jsonl");
    const sentKeys: string[][] = [];
    await writeFile(
      path,
      [
        JSON.stringify({
          timestamp: "2026-07-07T00:00:00.000Z",
          type: "session_meta",
          payload: { session_id: "codex-session", cwd: repo, cli_version: "test" }
        }),
        JSON.stringify({
          timestamp: "2026-07-07T00:00:01.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "make a plan" }
        }),
        JSON.stringify({
          timestamp: "2026-07-07T00:00:02.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "<proposed_plan>\nDo it.\n</proposed_plan>" }]
          }
        }),
        JSON.stringify({
          timestamp: "2026-07-07T00:00:03.000Z",
          type: "event_msg",
          payload: { type: "turn_complete" }
        }),
        ""
      ].join("\n")
    );
    await utimes(path, new Date("2026-07-07T00:00:00.000Z"), new Date("2026-07-07T00:00:00.000Z"));
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.capturePane = async () => "› ";
    harness.tmux.sendKeys = async (_paneId, keys) => {
      sentKeys.push(keys);
    };

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0];
    expect(session).toBeDefined();

    await harness.manager.ingest();
    expect(harness.manager.getSession(session.id)?.status).toBe("plan_ready");

    harness.db.setSessionStatus(session.id, "waiting", "2026-07-07T00:00:03.000Z");
    await harness.manager.discover();
    expect(harness.manager.getSession(session.id)?.status).toBe("plan_ready");

    await harness.manager.discover();
    expect(harness.manager.getSession(session.id)?.status).toBe("plan_ready");

    await harness.manager.act(session.id, { type: "choosePlanAction", action: "clear_context_implement" });
    expect(sentKeys).toEqual([["Down", "Enter"]]);
    expect(harness.manager.getSession(session.id)?.status).toBe("waiting");

    await harness.manager.discover();
    expect(harness.manager.getSession(session.id)?.status).toBe("waiting");
    harness.db.close();
  });

  it("maps plan actions to their Codex menu positions", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const path = join(harness.codexHome, "sessions", "plan-actions.jsonl");
    const sentKeys: string[][] = [];
    await writeFile(
      path,
      [
        JSON.stringify({
          timestamp: "2026-07-07T00:00:00.000Z",
          type: "session_meta",
          payload: { session_id: "codex-session", cwd: repo, cli_version: "test" }
        }),
        JSON.stringify({
          timestamp: "2026-07-07T00:00:01.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "<proposed_plan>\nDo it.\n</proposed_plan>" }]
          }
        }),
        ""
      ].join("\n")
    );
    await utimes(path, new Date("2026-07-07T00:00:00.000Z"), new Date("2026-07-07T00:00:00.000Z"));
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.sendKeys = async (_paneId, keys) => {
      sentKeys.push(keys);
    };

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0];
    expect(session).toBeDefined();
    await harness.manager.ingest();

    await harness.manager.act(session.id, { type: "choosePlanAction", action: "implement" });
    await harness.manager.act(session.id, { type: "choosePlanAction", action: "clear_context_implement" });
    await harness.manager.act(session.id, { type: "choosePlanAction", action: "stay_in_plan" });

    expect(sentKeys).toEqual([["Enter"], ["Down", "Enter"], ["Down", "Down", "Enter"]]);
    expect(harness.manager.getSession(session.id)?.inputMode).toBe("plan");
    harness.db.close();
  });

  it("sets input mode from the selected proposed-plan action", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const path = join(harness.codexHome, "sessions", "plan-action-mode.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({
          timestamp: "2026-07-07T00:00:00.000Z",
          type: "session_meta",
          payload: { session_id: "codex-session", cwd: repo, cli_version: "test" }
        }),
        JSON.stringify({
          timestamp: "2026-07-07T00:00:01.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "<proposed_plan>\nDo it.\n</proposed_plan>" }]
          }
        }),
        ""
      ].join("\n")
    );
    await utimes(path, new Date("2026-07-07T00:00:00.000Z"), new Date("2026-07-07T00:00:00.000Z"));
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.sendKeys = async () => undefined;

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0];
    expect(session).toBeDefined();
    await harness.manager.ingest();

    await harness.manager.act(session.id, { type: "choosePlanAction", action: "implement" });
    expect(harness.manager.getSession(session.id)?.inputMode).toBe("default");

    await harness.manager.act(session.id, { type: "choosePlanAction", action: "stay_in_plan" });
    expect(harness.manager.getSession(session.id)?.inputMode).toBe("plan");
    harness.db.close();
  });

  it("does not mark incomplete proposed plan tags as plan ready", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const path = join(harness.codexHome, "sessions", "incomplete-plan.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({
          timestamp: "2026-07-07T00:00:00.000Z",
          type: "session_meta",
          payload: { session_id: "codex-session", cwd: repo, cli_version: "test" }
        }),
        JSON.stringify({
          timestamp: "2026-07-07T00:00:01.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Before\n<proposed_plan>\nNo close" }]
          }
        }),
        ""
      ].join("\n")
    );
    await utimes(path, new Date("2026-07-07T00:00:00.000Z"), new Date("2026-07-07T00:00:00.000Z"));
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0];
    expect(session).toBeDefined();

    await harness.manager.ingest();
    expect(harness.manager.getSession(session.id)?.status).not.toBe("plan_ready");
    harness.db.close();
  });

  it("persists input mode and cycles Codex mode before sending", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    await writeCodexSession(harness.codexHome, "session.jsonl", {
      sessionId: "codex-session",
      cwd: repo,
      user: "first prompt",
      assistant: "first answer",
      mtime: new Date("2026-07-07T00:00:00.000Z")
    });
    const pane = testPane({ cwd: repo, paneId: "%1" });
    const sentInputs: string[] = [];
    const sentKeys: string[][] = [];
    harness.tmux.listPanes = async () => [pane];
    harness.tmux.sendKeys = async (_paneId, keys) => {
      sentKeys.push(keys);
      if (keys.includes("BTab")) pane.title = "plan-mode";
    };
    harness.tmux.sendInput = async (_paneId, text) => {
      sentInputs.push(text);
    };

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0];
    expect(session).toBeDefined();

    const actionSession = await harness.manager.act(session.id, { type: "setInputMode", mode: "plan" });
    await harness.manager.sendInput(session.id, "next prompt", "plan");

    expect(actionSession?.inputMode).toBe("plan");
    expect(harness.manager.getSession(session.id)?.inputMode).toBe("plan");
    expect(sentKeys).toEqual([["BTab"]]);
    expect(sentInputs).toEqual(["next prompt "]);
    harness.db.close();
  });

  it("hydrates model selections from the latest Codex turn context", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const mtime = new Date("2026-07-07T00:00:00.000Z");
    await writeCodexSession(harness.codexHome, "session.jsonl", {
      sessionId: "codex-session",
      cwd: repo,
      user: "first prompt",
      assistant: "first answer",
      mtime
    });
    await appendFile(
      join(harness.codexHome, "sessions", "session.jsonl"),
      [
        JSON.stringify({
          timestamp: "2026-07-07T00:00:03.000Z",
          type: "turn_context",
          payload: { model: "gpt-5.4", effort: "medium" }
        }),
        JSON.stringify({
          timestamp: "2026-07-07T00:00:04.000Z",
          type: "turn_context",
          payload: {
            model: "gpt-5.4",
            effort: "medium",
            collaboration_mode: { mode: "default", settings: { model: "gpt-5.5", reasoning_effort: "high" } }
          }
        }),
        ""
      ].join("\n")
    );
    await utimes(join(harness.codexHome, "sessions", "session.jsonl"), mtime, mtime);
    const pane = testPane({ cwd: repo, paneId: "%1" });
    harness.tmux.listPanes = async () => [pane];

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0];
    expect(session).toBeDefined();
    expect(session.models).toEqual({
      default: { model: "gpt-5.5", reasoningEffort: "high" },
      plan: { model: null, reasoningEffort: null }
    });
    harness.db.close();
  });

  it("adds a protective trailing space when sending a skill-like final word", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    await writeCodexSession(harness.codexHome, "session.jsonl", {
      sessionId: "codex-session",
      cwd: repo,
      user: "first prompt",
      assistant: "first answer",
      mtime: new Date("2026-07-07T00:00:00.000Z")
    });
    const sentInputs: string[] = [];
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.capturePane = async () => "› ";
    harness.tmux.sendInput = async (_paneId, text) => {
      sentInputs.push(text);
    };

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0];
    expect(session).toBeDefined();

    await harness.manager.sendInput(session.id, "run $test-example");

    expect(sentInputs).toEqual(["run $test-example "]);
    harness.db.close();
  });

  it("returns the updated session and sends cycle keys for normal mode", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    await writeCodexSession(harness.codexHome, "session.jsonl", {
      sessionId: "codex-session",
      cwd: repo,
      user: "first prompt",
      assistant: "first answer",
      mtime: new Date("2026-07-07T00:00:00.000Z")
    });
    const sentKeys: string[][] = [];
    const pane = testPane({ cwd: repo, paneId: "%1", title: "plan-mode" });
    harness.tmux.listPanes = async () => [pane];
    harness.tmux.capturePane = async () => "Plan mode prompt:\n› Plan {feature}";
    harness.tmux.sendKeys = async (_paneId, keys) => {
      sentKeys.push(keys);
      if (keys.includes("BTab")) {
        pane.title = "codex";
        harness.tmux.capturePane = async () => "› ";
      }
    };

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0];
    expect(session).toBeDefined();
    expect(session.inputMode).toBe("plan");

    const actionSession = await harness.manager.act(session.id, { type: "setInputMode", mode: "default" });

    expect(sentKeys).toEqual([["BTab"]]);
    expect(actionSession?.inputMode).toBe("default");
    expect(harness.manager.getSession(session.id)?.inputMode).toBe("default");
    harness.db.close();
  });

  it("persists requested input mode when Codex does not expose a mode signal", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    await writeCodexSession(harness.codexHome, "session.jsonl", {
      sessionId: "codex-session",
      cwd: repo,
      user: "first prompt",
      assistant: "first answer",
      mtime: new Date("2026-07-07T00:00:00.000Z")
    });
    const sentKeys: string[][] = [];
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.capturePane = async () => "› ";
    harness.tmux.sendKeys = async (_paneId, keys) => {
      sentKeys.push(keys);
    };

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0];
    expect(session).toBeDefined();

    await harness.manager.act(session.id, { type: "setInputMode", mode: "plan" });

    expect(sentKeys).toEqual([["BTab"]]);
    expect(harness.manager.getSession(session.id)?.inputMode).toBe("plan");

    await harness.manager.discover();

    expect(harness.manager.getSession(session.id)?.inputMode).toBe("plan");
    harness.db.close();
  });

  it("persists requested input mode when stale pane text still looks like normal mode", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    await writeCodexSession(harness.codexHome, "session.jsonl", {
      sessionId: "codex-session",
      cwd: repo,
      user: "first prompt",
      assistant: "first answer",
      mtime: new Date("2026-07-07T00:00:00.000Z")
    });
    const sentKeys: string[][] = [];
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.capturePane = async () => "Implement this plan?\n3. No, stay in Plan mode\n› Implement {feature}";
    harness.tmux.sendKeys = async (_paneId, keys) => {
      sentKeys.push(keys);
    };

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0];
    expect(session).toBeDefined();
    expect(session.inputMode).toBe("default");

    await harness.manager.act(session.id, { type: "setInputMode", mode: "plan" });

    expect(sentKeys).toEqual([["BTab"]]);
    expect(harness.manager.getSession(session.id)?.inputMode).toBe("plan");
    harness.db.close();
  });

  it("queues busy inputs, sends the edited text when ready, and clears after transcript echo", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const sentInputs: string[] = [];
    let capture = "Working (esc to interrupt)";
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.capturePane = async () => capture;
    harness.tmux.sendInput = async (_paneId, text) => {
      sentInputs.push(text);
    };

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0];
    expect(session).toBeDefined();
    expect(harness.manager.getSession(session.id)?.status).toBe("working");

    await harness.manager.sendInput(session.id, "queued prompt");

    expect(sentInputs).toEqual([]);
    expect((await harness.manager.listQueuedInputs(session.id)).map((input) => input.text)).toEqual(["queued prompt"]);

    const queued = (await harness.manager.listQueuedInputs(session.id))[0];
    expect(queued).toBeDefined();
    await harness.manager.updateQueuedInput(session.id, queued!.id, "edited queued prompt", "default");

    capture = "› ";
    await harness.manager.discover();

    const sentQueue = await harness.manager.listQueuedInputs(session.id);
    expect(sentInputs).toEqual(["edited queued prompt "]);
    expect(sentQueue).toMatchObject([{ text: "edited queued prompt", status: "sent" }]);

    await harness.db.appendMessage({
      id: "queued-echo",
      sessionId: session.id,
      sequence: await harness.db.nextSequence(session.id),
      type: "user",
      role: "user",
      timestamp: new Date(Date.now() + 1000).toISOString(),
      text: "edited queued prompt",
      payload: {}
    });
    await harness.manager.discover();

    expect(await harness.manager.listQueuedInputs(session.id)).toEqual([]);
    harness.db.close();
  });

  it("does not send queued input just because input mode changed", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const sentInputs: string[] = [];
    const sentKeys: string[][] = [];
    let capture = "Working (esc to interrupt)";
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.capturePane = async () => capture;
    harness.tmux.sendInput = async (_paneId, text) => {
      sentInputs.push(text);
    };
    harness.tmux.sendKeys = async (_paneId, keys) => {
      sentKeys.push(keys);
    };

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0];
    expect(session).toBeDefined();

    await harness.db.appendQueuedInput({
      id: "queued-input",
      sessionId: session.id,
      text: "queued prompt",
      mode: "default",
      status: "queued",
      error: null,
      codexSessionId: session.codexSessionId,
      codexJsonlPath: session.codexJsonlPath,
      createdAt: "2026-07-07T00:00:01.000Z",
      updatedAt: "2026-07-07T00:00:01.000Z",
      sentAt: null
    });
    expect(sentInputs).toEqual([]);
    expect((await harness.manager.listQueuedInputs(session.id)).map((input) => input.text)).toEqual(["queued prompt"]);

    capture = "› ";
    await harness.manager.act(session.id, { type: "setInputMode", mode: "plan" });

    expect(sentKeys).toEqual([["BTab"]]);
    expect(sentInputs).toEqual([]);
    expect(await harness.manager.listQueuedInputs(session.id)).toMatchObject([{ text: "queued prompt", status: "queued" }]);
    harness.db.close();
  });

  it("allows clearing sent queued inputs but keeps sending inputs protected", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.capturePane = async () => "Working (esc to interrupt)";

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0];
    expect(session).toBeDefined();

    await harness.db.appendQueuedInput({
      id: "sent-input",
      sessionId: session.id,
      text: "already sent prompt",
      mode: "default",
      status: "sent",
      error: null,
      codexSessionId: session.codexSessionId,
      codexJsonlPath: session.codexJsonlPath,
      createdAt: "2026-07-07T00:00:01.000Z",
      updatedAt: "2026-07-07T00:00:02.000Z",
      sentAt: "2026-07-07T00:00:02.000Z"
    });
    await harness.db.appendQueuedInput({
      id: "sending-input",
      sessionId: session.id,
      text: "sending prompt",
      mode: "default",
      status: "sending",
      error: null,
      codexSessionId: session.codexSessionId,
      codexJsonlPath: session.codexJsonlPath,
      createdAt: "2026-07-07T00:00:03.000Z",
      updatedAt: "2026-07-07T00:00:04.000Z",
      sentAt: null
    });

    await harness.manager.deleteQueuedInput(session.id, "sent-input");
    await expect(harness.manager.deleteQueuedInput(session.id, "sending-input")).rejects.toThrow("Queued input is already sending");

    expect(await harness.manager.listQueuedInputs(session.id)).toMatchObject([{ id: "sending-input", status: "sending" }]);
    harness.db.close();
  });

  it("discovers input mode from the live Codex pane", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    await writeCodexSession(harness.codexHome, "session.jsonl", {
      sessionId: "codex-session",
      cwd: repo,
      user: "first prompt",
      assistant: "first answer",
      mtime: new Date("2026-07-07T00:00:00.000Z")
    });
    const pane = testPane({ cwd: repo, paneId: "%1" });
    harness.tmux.listPanes = async () => [pane];
    harness.tmux.capturePane = async () => "Plan mode prompt:\n› Plan {feature}";

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0];
    expect(session).toBeDefined();
    expect(session.inputMode).toBe("plan");

    harness.tmux.capturePane = async () => "Implement this plan?\n3. No, stay in Plan mode\n› Implement {feature}";
    await harness.manager.discover();

    expect(harness.manager.getSession(session.id)?.inputMode).toBe("plan");
    harness.db.close();
  });

  it("corrects stored input mode from parsed Codex default-mode user messages", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const path = join(harness.codexHome, "sessions", "default-mode-user.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({
          timestamp: "2026-07-07T00:00:00.000Z",
          type: "session_meta",
          payload: { session_id: "codex-session", cwd: repo, cli_version: "test" }
        }),
        JSON.stringify({
          timestamp: "2026-07-07T00:00:01.000Z",
          type: "event_msg",
          payload: { type: "task_started", collaboration_mode_kind: "default" }
        }),
        JSON.stringify({
          timestamp: "2026-07-07T00:00:02.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "normal prompt" }
        }),
        ""
      ].join("\n")
    );
    await utimes(path, new Date("2026-07-07T00:00:00.000Z"), new Date("2026-07-07T00:00:00.000Z"));
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.capturePane = async () => "› ";

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0];
    expect(session).toBeDefined();
    await harness.db.setSessionInputMode(session.id, "plan", "2026-07-07T00:00:01.500Z");

    await harness.manager.ingest();

    expect(harness.manager.getSession(session.id)?.inputMode).toBe("default");
    harness.db.close();
  });

  it("corrects stored input mode from parsed Codex plan-mode user messages", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const path = join(harness.codexHome, "sessions", "plan-mode-user.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({
          timestamp: "2026-07-07T00:00:00.000Z",
          type: "session_meta",
          payload: { session_id: "codex-session", cwd: repo, cli_version: "test" }
        }),
        JSON.stringify({
          timestamp: "2026-07-07T00:00:01.000Z",
          type: "event_msg",
          payload: { type: "task_started", collaboration_mode_kind: "plan" }
        }),
        JSON.stringify({
          timestamp: "2026-07-07T00:00:02.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "plan prompt" }
        }),
        ""
      ].join("\n")
    );
    await utimes(path, new Date("2026-07-07T00:00:00.000Z"), new Date("2026-07-07T00:00:00.000Z"));
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.capturePane = async () => "› ";

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0];
    expect(session).toBeDefined();

    await harness.manager.ingest();

    expect(harness.manager.getSession(session.id)?.inputMode).toBe("plan");
    harness.db.close();
  });

  it("persists the verified input mode after send-time switching", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    await writeCodexSession(harness.codexHome, "session.jsonl", {
      sessionId: "codex-session",
      cwd: repo,
      user: "first prompt",
      assistant: "first answer",
      mtime: new Date("2026-07-07T00:00:00.000Z")
    });
    const pane = testPane({ cwd: repo, paneId: "%1" });
    const sentInputs: string[] = [];
    const sentKeys: string[][] = [];
    harness.tmux.listPanes = async () => [pane];
    harness.tmux.sendKeys = async (_paneId, keys) => {
      sentKeys.push(keys);
      if (keys.includes("BTab")) pane.title = "plan-mode";
    };
    harness.tmux.sendInput = async (_paneId, text) => {
      sentInputs.push(text);
    };

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0];
    expect(session).toBeDefined();

    await harness.manager.sendInput(session.id, "next prompt", "plan");

    expect(sentKeys).toEqual([["BTab"]]);
    expect(sentInputs).toEqual(["next prompt "]);
    expect(harness.manager.getSession(session.id)?.inputMode).toBe("plan");
    harness.db.close();
  });

  it("sends input after one mode switch when Codex mode verification is ambiguous", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    await writeCodexSession(harness.codexHome, "session.jsonl", {
      sessionId: "codex-session",
      cwd: repo,
      user: "first prompt",
      assistant: "first answer",
      mtime: new Date("2026-07-07T00:00:00.000Z")
    });
    const sentInputs: string[] = [];
    const sentKeys: string[][] = [];
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.capturePane = async () => "› ";
    harness.tmux.sendKeys = async (_paneId, keys) => {
      sentKeys.push(keys);
    };
    harness.tmux.sendInput = async (_paneId, text) => {
      sentInputs.push(text);
    };

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0];
    expect(session).toBeDefined();

    await harness.manager.sendInput(session.id, "next prompt", "plan");

    expect(sentKeys).toEqual([["BTab"]]);
    expect(sentInputs).toEqual(["next prompt "]);
    expect(harness.manager.getSession(session.id)?.inputMode).toBe("plan");
    harness.db.close();
  });

  it("shows planning while Codex works after the latest plan mode prompt", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const path = join(harness.codexHome, "sessions", "planning.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({
          timestamp: "2026-07-07T00:00:00.000Z",
          type: "session_meta",
          payload: { session_id: "codex-session", cwd: repo, cli_version: "test" }
        }),
        JSON.stringify({
          timestamp: "2026-07-07T00:00:01.000Z",
          type: "event_msg",
          payload: { type: "task_started", collaboration_mode_kind: "plan" }
        }),
        JSON.stringify({
          timestamp: "2026-07-07T00:00:02.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "make a plan" }
        }),
        ""
      ].join("\n")
    );
    await utimes(path, new Date("2026-07-07T00:00:00.000Z"), new Date("2026-07-07T00:00:00.000Z"));
    const pane = testPane({ cwd: repo, paneId: "%1" });
    harness.tmux.listPanes = async () => [pane];
    harness.tmux.capturePane = async () => "› ";

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0];
    expect(session).toBeDefined();
    await harness.manager.ingest();

    pane.title = "working";
    harness.tmux.capturePane = async () => "Working (1s)\nEsc to interrupt";
    await harness.manager.discover();

    expect(harness.manager.getSession(session.id)?.status).toBe("planning");
    harness.db.close();
  });

  it("keeps planning while an incomplete proposed plan is the latest assistant output", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const path = join(harness.codexHome, "sessions", "pending-plan.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({
          timestamp: "2026-07-07T00:00:00.000Z",
          type: "session_meta",
          payload: { session_id: "codex-session", cwd: repo, cli_version: "test" }
        }),
        JSON.stringify({
          timestamp: "2026-07-07T00:00:01.000Z",
          type: "event_msg",
          payload: { type: "task_started", collaboration_mode_kind: "plan" }
        }),
        JSON.stringify({
          timestamp: "2026-07-07T00:00:02.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "make a plan" }
        }),
        JSON.stringify({
          timestamp: "2026-07-07T00:00:03.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Before\n<proposed_plan>\nStill writing" }]
          }
        }),
        JSON.stringify({
          timestamp: "2026-07-07T00:00:04.000Z",
          type: "event_msg",
          payload: { type: "turn_complete" }
        }),
        ""
      ].join("\n")
    );
    await utimes(path, new Date("2026-07-07T00:00:00.000Z"), new Date("2026-07-07T00:00:00.000Z"));
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.capturePane = async () => "› ";

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0];
    expect(session).toBeDefined();
    await harness.manager.ingest();
    await harness.manager.discover();

    expect(harness.manager.getSession(session.id)?.status).toBe("planning");
    harness.db.close();
  });

  it("does not infer blocked from transcript text when the pane is ready", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1", windowName: "scroll-jump" })];
    harness.tmux.capturePane = async () => [
      "- Full test and typecheck are still blocked by unrelated failures.",
      "",
      "› "
    ].join("\n");

    await harness.manager.discover();

    const session = harness.manager.listSessions(true)[0];
    expect(session?.status).toBe("waiting");
    harness.db.close();
  });

  it("prefers working cues over incidental blocked text in the pane and window name", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    harness.tmux.listPanes = async () => [
      testPane({ cwd: repo, paneId: "%1", windowName: "codex-inv-blocked-status", title: "⠧ muxpilot" })
    ];
    harness.tmux.capturePane = async () => [
      "The DB row is also persisted as blocked.",
      "",
      "Working (20s • esc to interrupt)"
    ].join("\n");

    await harness.manager.discover();

    const session = harness.manager.listSessions(true)[0];
    expect(session?.status).toBe("working");
    harness.db.close();
  });

  it("prefers active working cues over approval wording in transcript text", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1", title: "⠇ muxpilot" })];
    harness.tmux.capturePane = async () => [
      "- Parses ‘Would you like to run…’ gates and don't ask again choices.",
      "",
      "Working (20s • esc to interrupt)"
    ].join("\n");

    await harness.manager.discover();

    const session = harness.manager.listSessions(true)[0];
    expect(session?.status).toBe("working");
    harness.db.close();
  });

  it("prefers the active composer over approval wording in transcript text", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.capturePane = async () => [
      "The earlier example said: Would you like to run this command and don't ask again?",
      "",
      "› "
    ].join("\n");

    await harness.manager.discover();

    const session = harness.manager.listSessions(true)[0];
    expect(session?.status).toBe("waiting");
    harness.db.close();
  });

  it("does not publish approval for an uncorroborated quoted approval form", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const publishedStatuses: string[] = [];
    const unsubscribe = harness.events.subscribe((event) => {
      if (event.type !== "session.updated" && event.type !== "status.changed") return;
      const status = (event.payload as { status?: unknown }).status;
      if (typeof status === "string") publishedStatuses.push(status);
    });
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.capturePane = async () => commandApprovalCapture(1);

    await harness.manager.discover();

    const session = harness.manager.listSessions(true)[0];
    expect(session?.status).toBe("waiting");
    expect(publishedStatuses).not.toContain("approval");
    unsubscribe();
    harness.db.close();
  });

  it("still infers blocked from an explicit blocked status label", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.capturePane = async () => "Blocked\n";

    await harness.manager.discover();

    const session = harness.manager.listSessions(true)[0];
    expect(session?.status).toBe("blocked");
    harness.db.close();
  });

  it("keeps two Codex panes in the same cwd bound to their own transcripts", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "shared-repo");
    await mkdir(repo);

    await writeCodexSession(harness.codexHome, "pane-a.jsonl", {
      sessionId: "codex-a",
      cwd: repo,
      user: "pane a prompt",
      assistant: "pane a answer",
      mtime: new Date("2026-07-07T00:00:00.000Z")
    });
    await writeCodexSession(harness.codexHome, "pane-b.jsonl", {
      sessionId: "codex-b",
      cwd: repo,
      user: "pane b prompt",
      assistant: "pane b answer",
      mtime: new Date("2026-07-07T00:01:00.000Z")
    });

    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" }), testPane({ cwd: repo, paneId: "%2" })];
    harness.tmux.capturePane = async (paneId) => (paneId === "%1" ? "pane a prompt\n› " : "pane b prompt\n› ");

    await harness.manager.discover();
    await harness.manager.ingest();

    const sessions = harness.manager.listSessions(true);
    const paneA = sessions.find((session) => session.tmux.paneId === "%1");
    const paneB = sessions.find((session) => session.tmux.paneId === "%2");
    expect(paneA?.codexSessionId).toBe("codex-a");
    expect(paneB?.codexSessionId).toBe("codex-b");
    expect(paneA ? harness.manager.listMessages(paneA.id, 0).map((message) => message.text) : []).toEqual([
      "pane a prompt",
      "pane a answer"
    ]);
    expect(paneB ? harness.manager.listMessages(paneB.id, 0).map((message) => message.text) : []).toEqual([
      "pane b prompt",
      "pane b answer"
    ]);
    harness.db.close();
  });

  it("keeps duplicate node windows separate for input and rename actions", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "shared-repo");
    await mkdir(repo);
    const sentInputs: Array<{ paneId: string; text: string }> = [];
    let panes = [
      testPane({ cwd: repo, paneId: "%111", windowName: "node", title: "node" }),
      testPane({ cwd: repo, paneId: "%112", windowName: "node", title: "node" })
    ];

    await writeCodexSession(harness.codexHome, "pane-a.jsonl", {
      sessionId: "codex-a",
      cwd: repo,
      user: "pane a prompt",
      assistant: "pane a answer",
      mtime: new Date("2026-07-07T00:00:00.000Z")
    });
    await writeCodexSession(harness.codexHome, "pane-b.jsonl", {
      sessionId: "codex-b",
      cwd: repo,
      user: "pane b prompt",
      assistant: "pane b answer",
      mtime: new Date("2026-07-07T00:01:00.000Z")
    });

    harness.tmux.listPanes = async () => panes;
    harness.tmux.capturePane = async (paneId) => (paneId === "%111" ? "context 90%\npane a prompt\n› " : "context 90%\npane b prompt\n› ");
    harness.tmux.sendInput = async (paneId, text) => {
      sentInputs.push({ paneId, text });
    };
    harness.tmux.renameWindow = async (paneId, name) => {
      panes = panes.map((pane) => (pane.paneId === paneId ? { ...pane, windowName: name } : pane));
    };

    await harness.manager.discover();
    await harness.manager.ingest();

    const sessions = harness.manager.listSessions(true);
    const paneA = sessions.find((session) => session.tmux.paneId === "%111");
    const paneB = sessions.find((session) => session.tmux.paneId === "%112");
    expect(paneA?.codexSessionId).toBe("codex-a");
    expect(paneB?.codexSessionId).toBe("codex-b");
    expect(paneA?.id).not.toBe(paneB?.id);

    await harness.manager.sendInput(paneB!.id, "hello b");
    await harness.manager.act(paneA!.id, { type: "rename", name: "renamed-a" });

    expect(sentInputs).toEqual([{ paneId: "%112", text: "hello b " }]);
    expect(harness.manager.getSession(paneA!.id)?.tmux.windowName).toBe("renamed-a");
    expect(harness.manager.getSession(paneB!.id)?.tmux.windowName).toBe("node");
    harness.db.close();
  });

  it("binds a resumed Codex pane by argv session id before cwd recency", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "shared-repo");
    await mkdir(repo);
    const pane = testPane({ cwd: repo, paneId: "%1", pid: 101 });

    await writeCodexSession(harness.codexHome, "older-resumed.jsonl", {
      sessionId: "codex-resumed",
      cwd: repo,
      user: "resumed prompt",
      assistant: "resumed answer",
      mtime: new Date("2026-07-07T00:00:00.000Z")
    });
    await writeCodexSession(harness.codexHome, "newer-other.jsonl", {
      sessionId: "codex-other",
      cwd: repo,
      user: "other prompt",
      assistant: "other answer",
      mtime: new Date("2026-07-07T00:10:00.000Z")
    });
    harness.tmux.listPanes = async () => [pane];
    harness.tmux.capturePane = async () => "› ";
    harness.processLookup.set(pane.pid, {
      pid: 201,
      sessionId: "codex-resumed",
      startedAtMs: new Date("2026-07-07T00:20:00.000Z").getTime()
    });

    await harness.manager.discover();
    await harness.manager.ingest();

    const session = harness.manager.listSessions(true)[0];
    expect(session?.codexSessionId).toBe("codex-resumed");
    expect(session ? harness.manager.listMessages(session.id, 0).map((message) => message.text) : []).toEqual([
      "resumed prompt",
      "resumed answer"
    ]);
    harness.db.close();
  });

  it("binds fresh same-cwd Codex panes by process start time when captures are generic", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "shared-repo");
    await mkdir(repo);
    const paneA = testPane({ cwd: repo, paneId: "%1", pid: 101 });
    const paneB = testPane({ cwd: repo, paneId: "%2", pid: 102 });

    await writeCodexSession(harness.codexHome, "pane-a.jsonl", {
      sessionId: "codex-a",
      cwd: repo,
      user: "pane a prompt",
      assistant: "pane a answer",
      startedAt: new Date("2026-07-07T00:00:00.000Z"),
      mtime: new Date("2026-07-07T00:05:00.000Z")
    });
    await writeCodexSession(harness.codexHome, "pane-b.jsonl", {
      sessionId: "codex-b",
      cwd: repo,
      user: "pane b prompt",
      assistant: "pane b answer",
      startedAt: new Date("2026-07-07T00:01:00.000Z"),
      mtime: new Date("2026-07-07T00:06:00.000Z")
    });
    harness.tmux.listPanes = async () => [paneA, paneB];
    harness.tmux.capturePane = async () => "› ";
    harness.processLookup.set(paneA.pid, {
      pid: 201,
      sessionId: null,
      startedAtMs: new Date("2026-07-07T00:00:02.000Z").getTime()
    });
    harness.processLookup.set(paneB.pid, {
      pid: 202,
      sessionId: null,
      startedAtMs: new Date("2026-07-07T00:01:02.000Z").getTime()
    });

    await harness.manager.discover();
    await harness.manager.ingest();

    const sessions = harness.manager.listSessions(true);
    expect(sessions.find((session) => session.tmux.paneId === "%1")?.codexSessionId).toBe("codex-a");
    expect(sessions.find((session) => session.tmux.paneId === "%2")?.codexSessionId).toBe("codex-b");
    harness.db.close();
  });

  it("repairs a stale plan binding when visible transcript matches a later Codex file", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "shared-repo");
    await mkdir(repo);
    const pane = testPane({ cwd: repo, paneId: "%1", pid: 101 });

    await writeCodexResponseSession(harness.codexHome, "old-plan.jsonl", {
      sessionId: "codex-old-plan",
      cwd: repo,
      user: "make a plan",
      assistant: "<proposed_plan>\nDo it.\n</proposed_plan>",
      startedAt: new Date("2026-07-07T00:00:00.000Z"),
      mtime: new Date("2026-07-07T00:05:00.000Z")
    });
    harness.tmux.listPanes = async () => [pane];
    harness.tmux.capturePane = async () => "› ";
    harness.processLookup.set(pane.pid, {
      pid: 201,
      sessionId: null,
      startedAtMs: new Date("2026-07-07T00:00:02.000Z").getTime()
    });

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0];
    expect(session).toBeDefined();
    await harness.manager.ingest();
    expect(harness.manager.getSession(session.id)?.status).toBe("plan_ready");

    await writeCodexResponseSession(harness.codexHome, "later-implementation.jsonl", {
      sessionId: "codex-later-implementation",
      cwd: repo,
      user: "Implement the plan.",
      assistant: "Implemented the session scroll and mobile keyboard layout fixes.",
      startedAt: new Date("2026-07-07T00:10:00.000Z"),
      mtime: new Date("2026-07-07T00:15:00.000Z")
    });
    harness.tmux.capturePane = async () => "Implemented the session scroll and mobile keyboard layout fixes.\n› ";

    await harness.manager.discover();
    await harness.manager.ingest();

    const rebound = harness.manager.getSession(session.id);
    expect(rebound?.codexSessionId).toBe("codex-later-implementation");
    expect(rebound?.status).toBe("waiting");
    expect(harness.manager.listMessages(session.id, 0).map((message) => message.text)).toEqual([
      "Implement the plan.",
      "Implemented the session scroll and mobile keyboard layout fixes."
    ]);
    harness.db.close();
  });

  it("does not steal another pane's transcript when mtimes change in a shared cwd", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "shared-repo");
    await mkdir(repo);

    await writeCodexSession(harness.codexHome, "pane-a.jsonl", {
      sessionId: "codex-a",
      cwd: repo,
      user: "pane a prompt",
      assistant: "pane a answer",
      mtime: new Date("2026-07-07T00:00:00.000Z")
    });
    await writeCodexSession(harness.codexHome, "pane-b.jsonl", {
      sessionId: "codex-b",
      cwd: repo,
      user: "pane b prompt",
      assistant: "pane b answer",
      mtime: new Date("2026-07-07T00:01:00.000Z")
    });

    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" }), testPane({ cwd: repo, paneId: "%2" })];
    harness.tmux.capturePane = async (paneId) => (paneId === "%1" ? "pane a prompt\n› " : "pane b prompt\n› ");

    await harness.manager.discover();
    await harness.manager.ingest();
    await utimes(
      join(harness.codexHome, "sessions", "pane-b.jsonl"),
      new Date("2026-07-07T00:02:00.000Z"),
      new Date("2026-07-07T00:02:00.000Z")
    );

    await harness.manager.discover();
    await harness.manager.ingest();

    const sessions = harness.manager.listSessions(true);
    expect(sessions.find((session) => session.tmux.paneId === "%1")?.codexSessionId).toBe("codex-a");
    expect(sessions.find((session) => session.tmux.paneId === "%2")?.codexSessionId).toBe("codex-b");
    harness.db.close();
  });

  it("keeps an existing same-cwd binding when discovery has no stronger match", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "shared-repo");
    await mkdir(repo);
    const pane = testPane({ cwd: repo, paneId: "%1" });

    await writeCodexSession(harness.codexHome, "bound.jsonl", {
      sessionId: "codex-bound",
      cwd: repo,
      user: "bound prompt",
      assistant: "bound answer",
      mtime: new Date("2026-07-07T00:00:00.000Z")
    });
    harness.tmux.listPanes = async () => [pane];
    harness.tmux.capturePane = async () => "› ";

    await harness.manager.discover();
    await harness.manager.ingest();
    const session = harness.manager.listSessions(true)[0];
    expect(session?.codexSessionId).toBe("codex-bound");

    await writeCodexSession(harness.codexHome, "newer-ambiguous.jsonl", {
      sessionId: "codex-newer-ambiguous",
      cwd: repo,
      user: "newer ambiguous prompt",
      assistant: "newer ambiguous answer",
      mtime: new Date("2026-07-07T00:05:00.000Z")
    });

    await harness.manager.discover();
    await harness.manager.ingest();

    const rebound = harness.manager.getSession(session!.id);
    expect(rebound?.codexSessionId).toBe("codex-bound");
    expect(harness.manager.listMessages(session!.id, 0).map((message) => message.text)).toEqual(["bound prompt", "bound answer"]);
    harness.db.close();
  });

  it("keeps an existing same-cwd binding when visible overlap ties a newer candidate", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "shared-repo");
    await mkdir(repo);
    const pane = testPane({ cwd: repo, paneId: "%1" });

    await writeCodexSession(harness.codexHome, "bound.jsonl", {
      sessionId: "codex-bound",
      cwd: repo,
      user: "shared visible prompt",
      assistant: "bound answer",
      mtime: new Date("2026-07-07T00:00:00.000Z")
    });
    harness.tmux.listPanes = async () => [pane];
    harness.tmux.capturePane = async () => "shared visible prompt\n› ";

    await harness.manager.discover();
    await harness.manager.ingest();
    const session = harness.manager.listSessions(true)[0];
    expect(session?.codexSessionId).toBe("codex-bound");

    await writeCodexSession(harness.codexHome, "newer-same-visible.jsonl", {
      sessionId: "codex-newer-same-visible",
      cwd: repo,
      user: "shared visible prompt",
      assistant: "newer answer",
      mtime: new Date("2026-07-07T00:05:00.000Z")
    });

    await harness.manager.discover();
    await harness.manager.ingest();

    const rebound = harness.manager.getSession(session!.id);
    expect(rebound?.codexSessionId).toBe("codex-bound");
    expect(harness.manager.listMessages(session!.id, 0).map((message) => message.text)).toEqual([
      "shared visible prompt",
      "bound answer"
    ]);
    harness.db.close();
  });

  it("repairs a stale shared-cwd binding when the visible transcript matches another pane", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "shared-repo");
    await mkdir(repo);

    await writeCodexSession(harness.codexHome, "pane-a.jsonl", {
      sessionId: "codex-a",
      cwd: repo,
      user: "pane a prompt",
      assistant: "pane a answer",
      mtime: new Date("2026-07-07T00:00:00.000Z")
    });
    await writeCodexSession(harness.codexHome, "pane-b.jsonl", {
      sessionId: "codex-b",
      cwd: repo,
      user: "pane b prompt",
      assistant: "pane b answer",
      mtime: new Date("2026-07-07T00:01:00.000Z")
    });

    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" }), testPane({ cwd: repo, paneId: "%2" })];
    harness.tmux.capturePane = async () => "› ";

    await harness.manager.discover();
    expect(harness.manager.listSessions(true).find((session) => session.tmux.paneId === "%1")?.codexSessionId).toBeNull();
    expect(harness.manager.listSessions(true).find((session) => session.tmux.paneId === "%2")?.codexSessionId).toBeNull();

    harness.tmux.capturePane = async (paneId) => (paneId === "%1" ? "pane a prompt\n› " : "pane b prompt\n› ");
    await harness.manager.discover();

    const sessions = harness.manager.listSessions(true);
    expect(sessions.find((session) => session.tmux.paneId === "%1")?.codexSessionId).toBe("codex-a");
    expect(sessions.find((session) => session.tmux.paneId === "%2")?.codexSessionId).toBe("codex-b");
    harness.db.close();
  });

  it("leaves ambiguous same-cwd candidates unbound instead of guessing by recency", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "shared-repo");
    await mkdir(repo);

    await writeCodexSession(harness.codexHome, "older.jsonl", {
      sessionId: "codex-older",
      cwd: repo,
      user: "older prompt",
      assistant: "older answer",
      mtime: new Date("2026-07-07T00:00:00.000Z")
    });
    await writeCodexSession(harness.codexHome, "newer.jsonl", {
      sessionId: "codex-newer",
      cwd: repo,
      user: "newer prompt",
      assistant: "newer answer",
      mtime: new Date("2026-07-07T00:01:00.000Z")
    });

    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.capturePane = async () => "› ";

    await harness.manager.discover();
    await harness.manager.ingest();

    const session = harness.manager.listSessions(true)[0];
    expect(session?.codexSessionId).toBeNull();
    expect(session?.codexJsonlPath).toBeNull();
    expect(session ? harness.manager.listMessages(session.id, 0) : []).toEqual([]);
    harness.db.close();
  });

  it("includes a visible fresh Codex pane before it has an unambiguous session file", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "shared-repo");
    await mkdir(repo);

    await writeCodexSession(harness.codexHome, "older.jsonl", {
      sessionId: "codex-older",
      cwd: repo,
      user: "older prompt",
      assistant: "older answer",
      mtime: new Date("2026-07-07T00:00:00.000Z")
    });
    await writeCodexSession(harness.codexHome, "newer.jsonl", {
      sessionId: "codex-newer",
      cwd: repo,
      user: "newer prompt",
      assistant: "newer answer",
      mtime: new Date("2026-07-07T00:01:00.000Z")
    });

    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1", windowName: "new-work", title: "repo" })];
    harness.tmux.capturePane = async () => [
      "╭───────────────────────────────────────╮",
      "│ >_ OpenAI Codex (v0.142.5)            │",
      "│                                       │",
      "│ model:     loading   /model to change │",
      "│ directory: ~/workspace/teamweave      │",
      "╰───────────────────────────────────────╯",
      "",
      "› Use /skills to list available skills"
    ].join("\n");

    await harness.manager.discover();

    const session = harness.manager.listSessions(true)[0];
    expect(session?.status).toBe("waiting");
    expect(session?.tmux.windowName).toBe("new-work");
    expect(session?.codexSessionId).toBeNull();
    harness.db.close();
  });

  it("rejects input when the tmux pane is no longer live", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    let sent = false;

    await writeCodexSession(harness.codexHome, "session.jsonl", {
      sessionId: "codex-session",
      cwd: repo,
      user: "prompt",
      assistant: "answer",
      mtime: new Date("2026-07-07T00:00:00.000Z")
    });
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.sendInput = async () => {
      sent = true;
    };

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0];
    expect(session).toBeDefined();

    harness.tmux.listPanes = async () => [];
    await expect(harness.manager.sendInput(session.id, "hello")).rejects.toThrow("Session pane is no longer available");
    expect(sent).toBe(false);
    harness.db.close();
  });

  it("rejects input when a pane id no longer belongs to the stored session", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    let sent = false;

    await writeCodexSession(harness.codexHome, "session.jsonl", {
      sessionId: "codex-session",
      cwd: repo,
      user: "prompt",
      assistant: "answer",
      mtime: new Date("2026-07-07T00:00:00.000Z")
    });
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.sendInput = async () => {
      sent = true;
    };

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0];
    expect(session).toBeDefined();

    harness.tmux.listPanes = async () => [
      { ...testPane({ cwd: repo, paneId: "%1" }), sessionId: "other-tmux-session" }
    ];
    await expect(harness.manager.sendInput(session.id, "hello")).rejects.toThrow("Session pane no longer matches");
    expect(sent).toBe(false);
    harness.db.close();
  });

  it("refreshes the stored tmux window name before rename returns", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const panes = [testPane({ cwd: repo, paneId: "%1" })];
    let codexListRecentCalls = 0;
    harness.tmux.listPanes = async () => panes;
    harness.tmux.renameWindow = async (_paneId, name) => {
      panes[0] = { ...panes[0], windowName: name };
    };
    const listRecent = harness.codexStore.listRecent.bind(harness.codexStore);
    harness.codexStore.listRecent = async () => {
      codexListRecentCalls += 1;
      return listRecent();
    };

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0];
    expect(session?.tmux.windowName).toBe("codex");
    expect(codexListRecentCalls).toBe(1);

    await harness.manager.act(session.id, { type: "rename", name: "renamed-session" });

    expect(harness.manager.getSession(session.id)?.tmux.windowName).toBe("renamed-session");
    expect(codexListRecentCalls).toBe(1);
    harness.db.close();
  });

  it("catches up transcript backfill from the most recently updated Codex file first", async () => {
    const harness = await createHarness();
    const olderRepo = join(harness.dir, "older-repo");
    const newerRepo = join(harness.dir, "newer-repo");
    await mkdir(olderRepo);
    await mkdir(newerRepo);
    await writeCodexSession(harness.codexHome, "older.jsonl", {
      sessionId: "codex-older",
      cwd: olderRepo,
      user: "older prompt",
      assistant: "older answer",
      mtime: new Date("2026-07-07T00:00:00.000Z")
    });
    await writeCodexSession(harness.codexHome, "newer.jsonl", {
      sessionId: "codex-newer",
      cwd: newerRepo,
      user: "newer prompt",
      assistant: "newer answer",
      mtime: new Date("2026-07-07T00:01:00.000Z")
    });
    harness.tmux.listPanes = async () => [testPane({ cwd: olderRepo, paneId: "%1" }), testPane({ cwd: newerRepo, paneId: "%2" })];
    await harness.manager.discover();

    const appendedMessages: string[] = [];
    const unsubscribe = harness.events.subscribe((event) => {
      if (event.type === "message.appended") appendedMessages.push((event.payload as { text?: string }).text ?? "");
    });
    await harness.manager.catchUpIngest();
    unsubscribe();

    expect(appendedMessages.slice(0, 2)).toEqual(["newer prompt", "newer answer"]);
    expect(appendedMessages.slice(2, 4)).toEqual(["older prompt", "older answer"]);
    harness.db.close();
  });

  it("normalizes renamed session names before applying tmux window names", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const panes = [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.listPanes = async () => panes;
    harness.tmux.renameWindow = async (_paneId, name) => {
      panes[0] = { ...panes[0], windowName: name };
    };

    await harness.manager.discover();
    const session = (await harness.manager.listSessions(true))[0];
    expect(session).toBeDefined();

    await harness.manager.act(session.id, { type: "rename", name: "My Session!" });

    expect((await harness.manager.getSession(session.id))?.tmux.windowName).toBe("my-session");
    harness.db.close();
  });

  it("rejects renamed session names that cannot normalize to a valid slug", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];

    await harness.manager.discover();
    const session = (await harness.manager.listSessions(true))[0];
    expect(session).toBeDefined();

    await expect(harness.manager.act(session.id, { type: "rename", name: "!" })).rejects.toThrow(
      "Session name must be 2-32 lowercase letters, numbers, or hyphens"
    );
    harness.db.close();
  });

  it("pins and unpins sessions through session actions", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];

    await harness.manager.discover();
    const session = (await harness.manager.listSessions(true))[0];
    expect(session).toBeDefined();
    const updatedPins: boolean[] = [];
    const unsubscribe = harness.events.subscribe((event) => {
      if (event.type === "session.updated") updatedPins.push((event.payload as { pinned?: boolean } | null)?.pinned ?? false);
    });

    await harness.manager.act(session.id, { type: "pin" });
    await harness.manager.act(session.id, { type: "unpin" });
    unsubscribe();

    expect(updatedPins).toEqual([true, false]);
    expect((await harness.manager.getSession(session.id))?.pinned).toBe(false);
    harness.db.close();
  });

  it("creates a new Codex tmux window in the shared muxpilot session from an explicit directory", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const otherRepo = join(harness.dir, "other-repo");
    await mkdir(otherRepo);
    let panes = [testPane({ cwd: otherRepo, paneId: "%1", windowId: "@1" })];
    const createCalls: Array<{ cwd: string; name: string }> = [];
    harness.tmux.listPanes = async () => panes;
    harness.tmux.createCodexWindowInMuxpilotSession = async (cwd, name) => {
      createCalls.push({ cwd, name });
      const pane = testPane({ cwd, paneId: "%2", windowId: "@2", windowName: name, title: name, pid: 456, sessionName: "muxpilot" });
      panes = [...panes, pane];
      return pane;
    };

    const created = await harness.manager.createSessionInDirectory(repo, "new-work");

    expect(createCalls).toEqual([{ cwd: repo, name: "new-work" }]);
    expect(created.tmux.sessionName).toBe("muxpilot");
    expect(created.tmux.paneId).toBe("%2");
    expect(created.tmux.windowName).toBe("new-work");
    expect(harness.manager.listSessions(true).map((session) => session.tmux.paneId).sort()).toEqual(["%1", "%2"]);
    harness.db.close();
  });

  it("normalizes created session names before creating tmux windows", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    let panes = [testPane({ cwd: repo, paneId: "%1", windowId: "@1" })];
    const createCalls: Array<{ cwd: string; name: string }> = [];
    harness.tmux.listPanes = async () => panes;
    harness.tmux.createCodexWindowInMuxpilotSession = async (cwd, name) => {
      createCalls.push({ cwd, name });
      const pane = testPane({ cwd, paneId: "%2", windowId: "@2", windowName: name, title: name, pid: 456, sessionName: "muxpilot" });
      panes = [...panes, pane];
      return pane;
    };

    const created = await harness.manager.createSessionInDirectory(repo, "My Session!");

    expect(createCalls).toEqual([{ cwd: repo, name: "my-session" }]);
    expect(created.tmux.windowName).toBe("my-session");
    harness.db.close();
  });

  it("rejects created session names that cannot normalize to a valid slug", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);

    await expect(harness.manager.createSessionInDirectory(repo, "!")).rejects.toThrow(
      "Session name must be 2-32 lowercase letters, numbers, or hyphens"
    );
    harness.db.close();
  });

  it("rejects new session creation when the directory does not exist", async () => {
    const harness = await createHarness();
    let createCalled = false;
    harness.tmux.createCodexWindowInMuxpilotSession = async () => {
      createCalled = true;
      throw new Error("should not create");
    };

    await expect(harness.manager.createSessionInDirectory(join(harness.dir, "missing"), "new-work")).rejects.toThrow(
      "Directory does not exist or is not accessible"
    );
    expect(createCalled).toBe(false);
    harness.db.close();
  });

  it("creates in the shared muxpilot session when no live panes exist", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    let panes: TmuxPane[] = [];
    const createCalls: Array<{ cwd: string; name: string }> = [];
    harness.tmux.listPanes = async () => panes;
    harness.tmux.createCodexWindowInMuxpilotSession = async (cwd, name) => {
      createCalls.push({ cwd, name });
      const pane = testPane({ cwd, paneId: "%1", windowId: "@1", windowName: name, title: name, pid: 456, sessionName: "muxpilot" });
      panes = [pane];
      return pane;
    };

    const created = await harness.manager.createSessionInDirectory(repo, "new-work");

    expect(createCalls).toEqual([{ cwd: repo, name: "new-work" }]);
    expect(created.tmux.sessionName).toBe("muxpilot");
    expect(created.tmux.paneId).toBe("%1");
    expect(created.tmux.windowName).toBe("new-work");
    harness.db.close();
  });

  it("restores a missing managed session with codex resume", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    await writeCodexSession(harness.codexHome, "session.jsonl", {
      sessionId: "codex-restorable",
      cwd: repo,
      user: "restore this session",
      assistant: "ready",
      mtime: new Date("2026-07-07T00:00:00.000Z")
    });
    const originalPane = testPane({ cwd: repo, paneId: "%1", windowId: "@1", windowName: "old-work" });
    let panes: TmuxPane[] = [originalPane];
    const resumeCalls: Array<{ cwd: string; name: string; codexSessionId: string }> = [];
    harness.tmux.listPanes = async () => panes;

    await harness.manager.discover();
    await harness.manager.ingest();
    const original = (await harness.manager.listSessions(true))[0];
    expect(original?.codexSessionId).toBe("codex-restorable");
    expect(harness.manager.listMessages(original!.id, 0).map((message) => message.text)).toEqual(["restore this session", "ready"]);

    panes = [];
    await harness.manager.discover();
    expect((await harness.manager.getSession(original!.id))?.status).toBe("missing");

    const appendedMessages: string[] = [];
    const unsubscribe = harness.events.subscribe((event) => {
      if (event.type === "message.appended") appendedMessages.push((event.payload as { text?: string }).text ?? "");
    });
    harness.tmux.createCodexResumeWindowInMuxpilotSession = async (cwd, name, codexSessionId) => {
      resumeCalls.push({ cwd, name, codexSessionId });
      const pane = testPane({ cwd, paneId: "%2", windowId: "@2", windowName: "shell", title: "node", pid: 456, sessionName: "muxpilot" });
      panes = [pane];
      return pane;
    };

    const restored = await harness.manager.restoreSession(original!.id);

    expect(resumeCalls).toEqual([{ cwd: repo, name: "old-work", codexSessionId: "codex-restorable" }]);
    expect(restored.restored).toBe(true);
    expect(restored.session.tmux.paneId).toBe("%2");
    expect(restored.session.codexSessionId).toBe("codex-restorable");
    expect(restored.session.status).toBe("unknown");
    expect(await harness.manager.getSession(original!.id)).toBeNull();
    expect(harness.manager.listMessages(restored.session.id, 0).map((message) => message.text)).toEqual(["restore this session", "ready"]);
    expect(appendedMessages).toEqual([]);

    harness.tmux.capturePane = async () => "Starting Codex";
    await harness.manager.discover();
    expect((await harness.manager.getSession(restored.session.id))?.status).toBe("unknown");

    await appendFile(
      join(harness.codexHome, "sessions", "session.jsonl"),
      [
        JSON.stringify({
          timestamp: "2026-07-07T00:00:03.000Z",
          type: "event_msg",
          payload: { type: "agent_message", message: "new after restore" }
        }),
        ""
      ].join("\n")
    );
    await harness.manager.ingest();

    expect(harness.manager.listMessages(restored.session.id, 0).map((message) => message.text)).toEqual([
      "restore this session",
      "ready",
      "new after restore"
    ]);
    unsubscribe();
    harness.db.close();
  });

  it("lists active and touched existing directories for new session suggestions", async () => {
    const harness = await createHarness();
    const activeRepo = join(harness.dir, "active");
    const recentRepo = join(harness.dir, "recent");
    const missingRepo = join(harness.dir, "missing");
    await mkdir(activeRepo);
    await mkdir(recentRepo);
    harness.tmux.listPanes = async () => [testPane({ cwd: activeRepo, paneId: "%1" })];

    await harness.manager.discover();
    const active = harness.manager.listSessions(true).find((session) => session.tmux.cwd === activeRepo);
    expect(active).toBeDefined();
    await harness.db.upsertTouchedRepository(
      {
        path: recentRepo,
        label: "recent",
        repoRoot: recentRepo,
        branch: null,
        lastActivityAt: "2026-07-08T00:00:00.000Z"
      },
      "2026-07-08T00:00:00.000Z"
    );
    await harness.db.upsertTouchedRepository(
      {
        path: missingRepo,
        label: "missing",
        repoRoot: missingRepo,
        branch: null,
        lastActivityAt: "2026-07-08T00:00:01.000Z"
      },
      "2026-07-08T00:00:00.000Z"
    );

    const suggestions = await harness.manager.listSessionDirectories();

    expect(suggestions.map((suggestion) => [suggestion.path, suggestion.source])).toContainEqual([activeRepo, "active"]);
    expect(suggestions.map((suggestion) => [suggestion.path, suggestion.source])).toContainEqual([recentRepo, "recent"]);
    expect(suggestions.map((suggestion) => suggestion.path)).not.toContain(missingRepo);
    harness.db.close();
  });

  it("marks the session missing before kill returns", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    let panes = [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.listPanes = async () => panes;
    harness.tmux.killPane = async (paneId) => {
      panes = panes.filter((pane) => pane.paneId !== paneId);
    };

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0];
    expect(session?.status).not.toBe("missing");

    await harness.manager.act(session.id, { type: "kill" });

    expect(harness.manager.getSession(session.id)?.status).toBe("missing");
    expect(harness.manager.listSessions().filter((candidate) => candidate.status !== "missing")).toEqual([]);
    harness.db.close();
  });
});

async function createHarness(): Promise<{
  dir: string;
  codexHome: string;
  db: AppDatabase;
  tmux: TmuxAdapter;
  codexStore: CodexSessionStore;
  events: EventBus;
  manager: SessionManager;
  activitySummarizer: FakeActivitySummarizer;
  processLookup: FakeCodexProcessLookup;
}> {
  const dir = await mkdtemp(join(tmpdir(), "muxpilot-session-manager-"));
  const codexHome = join(dir, "codex-home");
  await mkdir(join(codexHome, "sessions"), { recursive: true });
  const db = new AppDatabase(join(dir, "test.db"));
  const tmux = new TmuxAdapter();
  const activitySummarizer = new FakeActivitySummarizer();
  const processLookup = new FakeCodexProcessLookup();
  tmux.listPanes = async () => [];
  tmux.capturePane = async () => "› ";
  const codexStore = new CodexSessionStore(codexHome);
  const events = new EventBus();
  const manager = new SessionManager(
    db,
    tmux,
    codexStore,
    events,
    60_000,
    60_000,
    { approveOnce: [], approveForPrefix: [], deny: [] },
    ["BTab"],
    activitySummarizer,
    processLookup
  );
  return { dir, codexHome, db, tmux, codexStore, events, manager, activitySummarizer, processLookup };
}

class FakeActivitySummarizer {
  readonly scheduledSessionIds: string[] = [];
  private enabled = true;

  schedule(sessionId: string): void {
    if (!this.enabled) return;
    this.scheduledSessionIds.push(sessionId);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.stop();
  }

  stop(): void {
    this.scheduledSessionIds.length = 0;
  }
}

class FakeCodexProcessLookup {
  private readonly processes = new Map<number, CodexProcessInfo | null>();

  set(panePid: number, processInfo: CodexProcessInfo | null): void {
    this.processes.set(panePid, processInfo);
  }

  async resolveForPane(panePid: number): Promise<CodexProcessInfo | null> {
    return this.processes.get(panePid) ?? null;
  }
}

async function writeCodexSession(
  codexHome: string,
  name: string,
  input: { sessionId: string; cwd: string; user: string; assistant: string; startedAt?: Date; mtime: Date }
): Promise<void> {
  const path = join(codexHome, "sessions", name);
  const startedAt = input.startedAt ?? input.mtime;
  await writeFile(
    path,
    [
      JSON.stringify({
        timestamp: startedAt.toISOString(),
        type: "session_meta",
        payload: { session_id: input.sessionId, timestamp: startedAt.toISOString(), cwd: input.cwd, cli_version: "test" }
      }),
      JSON.stringify({
        timestamp: "2026-07-07T00:00:01.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: input.user }
      }),
      JSON.stringify({
        timestamp: "2026-07-07T00:00:02.000Z",
        type: "event_msg",
        payload: { type: "agent_message", message: input.assistant }
      }),
      ""
    ].join("\n")
  );
  await utimes(path, input.mtime, input.mtime);
}

async function writeCodexResponseSession(
  codexHome: string,
  name: string,
  input: { sessionId: string; cwd: string; user: string; assistant: string; startedAt: Date; mtime: Date }
): Promise<void> {
  const path = join(codexHome, "sessions", name);
  await writeFile(
    path,
    [
      JSON.stringify({
        timestamp: input.startedAt.toISOString(),
        type: "session_meta",
        payload: { session_id: input.sessionId, timestamp: input.startedAt.toISOString(), cwd: input.cwd, cli_version: "test" }
      }),
      JSON.stringify({
        timestamp: "2026-07-07T00:00:01.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: input.user }
      }),
      JSON.stringify({
        timestamp: "2026-07-07T00:00:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: input.assistant }]
        }
      }),
      ""
    ].join("\n")
  );
  await utimes(path, input.mtime, input.mtime);
}

function appApprovalCapture(selected: number): string {
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
    "◦ Running pnpm app restart prod",
    "",
    "  Would you like to run the following command?",
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

function testPane(input: {
  cwd: string;
  paneId: string;
  windowId?: string;
  pid?: number;
  windowName?: string;
  title?: string;
  sessionName?: string;
}): TmuxPane {
  return {
    sessionId: "tmux-session",
    sessionName: input.sessionName ?? "work",
    windowId: input.windowId ?? `@${input.paneId.slice(1)}`,
    windowIndex: Number(input.paneId.slice(1)),
    windowName: input.windowName ?? "codex",
    paneId: input.paneId,
    paneIndex: 0,
    paneActive: true,
    cwd: input.cwd,
    currentCommand: "node",
    title: input.title ?? "codex",
    pid: input.pid ?? 123,
    size: "120x40"
  };
}
