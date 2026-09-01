import { appendFile, mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ChatMessage, ManagedSession, TmuxPane } from "@muxpilot/core";
import type { CodexProcessInfo } from "../src/codex/codexProcessResolver.js";
import { CodexSessionStore, type CodexSessionFile } from "../src/codex/codexSessionStore.js";
import { AppDatabase } from "../src/db/database.js";
import { EventBus } from "../src/services/eventBus.js";
import { SessionDocumentService } from "../src/services/sessionDocuments.js";
import type { GitWorkspaceManager } from "../src/services/gitWorkspaceManager.js";
import {
  clearCodexTailAnalysisCache,
  codexModelSettingsFromPaneText,
  legacyTmuxPaneSessionId,
  latestCodexFastModeFromText,
  managedCodexLaunchOptions,
  normalizeRepositoryApprovalPrefix,
  sessionChanged,
  SessionManager,
  FastModeSwitchError,
  transcriptOverlapScore,
  tmuxPaneSessionId
} from "../src/services/sessionManager.js";
import { InputTransportError, TmuxAdapter, type CodexLaunchOptions } from "../src/tmux/tmuxAdapter.js";

describe("Codex pane model settings", () => {
  it("reads the persistent status line", () => {
    expect(codexModelSettingsFromPaneText("  gpt-5.6-sol xhigh · ~/workspace/muxpilot")).toEqual({
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh"
    });
  });

  it("ignores model and effort text without Codex screen framing", () => {
    expect(codexModelSettingsFromPaneText("Try gpt-5.6-sol medium for this task.")).toBeNull();
  });
});

describe("Codex transcript overlap discovery", () => {
  it("reuses parsed tails until the watched file metadata changes", async () => {
    clearCodexTailAnalysisCache();
    const dir = await mkdtemp(join(tmpdir(), "muxpilot-overlap-cache-"));
    const path = join(dir, "session.jsonl");
    await writeFile(path, `${JSON.stringify({ payload: { message: "first visible response" } })}\n`);
    const file: CodexSessionFile = {
      sessionId: "codex-cache",
      path,
      cwd: dir,
      startedAtMs: 1,
      updatedAtMs: 1,
      sizeBytes: 1,
      cliVersion: null
    };

    expect(await transcriptOverlapScore(file, "first visible response")).toBeGreaterThan(0);
    await writeFile(path, `${JSON.stringify({ payload: { message: "second visible response" } })}\n`);
    expect(await transcriptOverlapScore(file, "second visible response")).toBe(0);
    expect(await transcriptOverlapScore({ ...file, updatedAtMs: 2, sizeBytes: 2 }, "second visible response")).toBeGreaterThan(0);
    clearCodexTailAnalysisCache();
  });
});

describe("Codex Fast mode settings", () => {
  it("uses the latest applied thread service tier", () => {
    const settings = [
      JSON.stringify({ type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: { service_tier: "default" } } }),
      JSON.stringify({ type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: { service_tier: "priority" } } })
    ].join("\n");

    expect(latestCodexFastModeFromText(settings)).toBe(true);
    expect(latestCodexFastModeFromText('{"payload":{"type":"thread_settings_applied","thread_settings":{"service_tier":"default"}}}')).toBe(false);
    expect(latestCodexFastModeFromText('{"payload":{"type":"other","service_tier":"priority"}}')).toBeNull();
  });
});

describe("managed Codex launch instructions", () => {
  it("uses the worktree for coordination without restricting user-directed checkout work", () => {
    const options = managedCodexLaunchOptions({
      id: "workspace-1",
      sessionId: "session-1",
      sessionName: "change-task",
      commonGitDir: "/repo/.git",
      implementationRoot: "/tmp/worktrees/change-task",
      helperToken: "token",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      summary: {
        id: "workspace-1",
        entryPath: "/repo",
        targetBranch: "main",
        dependencyLinks: [{ kind: "node", relativePath: "node_modules", sourcePath: "/tmp", linked: false }]
      }
    } as Parameters<typeof managedCodexLaunchOptions>[0], "/home/dev/.codex", "/tmp/worktrees");

    expect(options.isolatedWorkspace).toBe(true);
    expect(options.environment).toMatchObject({
      CODEX_HOME: "/home/dev/.codex",
      MUXPILOT_GIT_HELPER_DIR: "/home/dev/.codex/skills/muxpilot-git-workflow/scripts"
    });
    expect(options.writableRoots).toContain("/tmp/worktrees");
    expect(options.writableRoots).toContain("/tmp");
    expect(options.developerInstructions).toContain("/home/dev/.codex/skills/muxpilot-git-workflow/scripts");
    expect(options.developerInstructions).toContain("short-lived worktree");
    expect(options.developerInstructions).toContain("first resolve the intended target");
    expect(options.developerInstructions).toContain("confirmation and retarget, then announce");
    expect(options.developerInstructions).toContain("muxpilot-git-begin");
    expect(options.developerInstructions).toContain("muxpilot-git-target");
    expect(options.developerInstructions).toContain("branch for implementation");
    expect(options.developerInstructions).toContain("source ref such as origin/dev is only the start point");
    expect(options.developerInstructions).toContain("before creating the branch or beginning implementation");
    expect(options.developerInstructions).toContain("name the fixed-target guard");
    expect(options.developerInstructions).toContain("confirmation for the fixed-target bypass");
    expect(options.developerInstructions).toContain("Initial target branch: main");
    expect(options.developerInstructions).toContain("obtain explicit confirmation for those guards");
    expect(options.developerInstructions).toContain("Never use an implementation worktree's state to claim that another checkout is clean or dirty");
    expect(options.developerInstructions).toContain("use normal approval or escalation instead of refusing it as out of scope");
    expect(options.developerInstructions).toContain("focused file/module checks");
    expect(options.developerInstructions).toContain("explicitly requests a PR-style review of a branch or ref");
    expect(options.developerInstructions).toContain("muxpilot-git-run.mjs --heavy");
    expect(options.developerInstructions).toContain("entire repository, workspace, application, package, or multi-project configuration");
    expect(options.developerInstructions).toContain("longer than one minute");
    expect(options.developerInstructions).toContain("When uncertain, treat the command as heavyweight");
    expect(options.developerInstructions).toContain("does not authorize repository-wide validation");
    expect(options.developerInstructions).toContain("$muxpilot-heavy-command-queue");
    expect(options.developerInstructions).toContain("QUEUED_NOT_RUN");
    expect(options.developerInstructions).toContain("RUNNING_DEFERRED");
    expect(options.developerInstructions).toContain("writable for test caches");
  });

  it("filters stale inaccessible dependencies from restored session launch options", () => {
    const dependency = { kind: "python" as const, relativePath: ".venv", sourcePath: "/missing/.venv", linked: true };
    const options = managedCodexLaunchOptions({
      id: "workspace-1",
      sessionId: "session-1",
      sessionName: "change-task",
      commonGitDir: "/repo/.git",
      implementationRoot: "/tmp/worktrees/change-task",
      helperToken: "token",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      summary: {
        id: "workspace-1",
        entryPath: "/repo",
        targetBranch: "main",
        dependencyLinks: [dependency]
      }
    } as Parameters<typeof managedCodexLaunchOptions>[0]);

    expect(options.writableRoots).not.toContain(dependency.sourcePath);
    expect(JSON.parse(options.environment.MUXPILOT_GIT_DEPENDENCIES)).toEqual([]);
  });
});

describe("managed Git workspace session updates", () => {
  it("detects a target-only workspace change for live UI refresh", () => {
    const previous = sessionForDiscoveryChange("main");
    const next = sessionForDiscoveryChange("release");

    expect(sessionChanged(previous, next)).toBe(true);
    expect(sessionChanged(next, { ...next })).toBe(false);
  });
});

describe("repository approval prefixes", () => {
  it("normalizes ephemeral task paths across worktrees", () => {
    const workspace = {
      id: "workspace-1",
      sessionId: "session-1",
      commonGitDir: "/repo/.git",
      implementationRoot: "/tmp/muxpilot/workspaces/workspace-1",
      helperToken: "token",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      summary: {
        id: "workspace-1",
        entryPath: "/repo",
        targetBranch: "main",
        worktreePath: "/tmp/muxpilot/workspaces/workspace-1/task-a"
      }
    } as Parameters<typeof normalizeRepositoryApprovalPrefix>[1];

    expect(normalizeRepositoryApprovalPrefix([
      "tool",
      "-C",
      "/tmp/muxpilot/workspaces/workspace-1/task-a",
      "cd /tmp/muxpilot/workspaces/workspace-1/task-a/apps/server && pnpm test"
    ], workspace)).toEqual([
      "tool",
      "-C",
      "$MUXPILOT_WORKTREE",
      "cd $MUXPILOT_WORKTREE/apps/server && pnpm test"
    ]);
  });
});

describe("session resource telemetry", () => {
  it("decorates API-facing sessions without persisting unavailable telemetry", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const pane = testPane({ cwd: repo, paneId: "%1" });
    await writeCodexSession(harness.codexHome, "resources.jsonl", {
      sessionId: "codex-resources",
      cwd: repo,
      user: "resource prompt",
      assistant: "resource answer",
      mtime: new Date("2026-07-31T00:00:00.000Z")
    });
    harness.tmux.listPanes = async () => [pane];
    await harness.manager.discover();
    const session = (await harness.manager.listSessions(true))[0]!;
    const resourceUsage = {
      memoryCurrentBytes: 1024 ** 3,
      memoryHighBytes: 2 * 1024 ** 3,
      memoryMaxBytes: 3 * 1024 ** 3,
      cpuPercent: 50,
      cpuLimitPercent: 300,
      sampledAt: "2026-07-31T00:00:00.000Z"
    };
    harness.manager.setResourceUsageLookup({
      usageForSession: (sessionId) => sessionId === session.id ? resourceUsage : null
    });

    expect((await harness.manager.getSession(session.id))?.resourceUsage).toEqual(resourceUsage);
    expect((await harness.manager.listSessions(true))[0]?.resourceUsage).toEqual(resourceUsage);
    expect((await harness.db.getSession(session.id))?.resourceUsage).toBeUndefined();
    harness.manager.setResourceUsageLookup({ usageForSession: () => null });
    expect((await harness.manager.getSession(session.id))?.resourceUsage).toBeNull();
    harness.db.close();
  });
});

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

  it("does not surface a reparsed escalated call without a live approval gate", async () => {
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
    expect(await harness.manager.getPendingApproval(session.id)).toBeNull();
    expect((await harness.manager.getSession(session.id))?.status).toBe("waiting");

    await harness.db.resetParserOffset(`${session.id}:${path}`);
    await harness.manager.ingest();
    await harness.manager.discover();

    expect(await harness.manager.getPendingApproval(session.id)).toBeNull();
    expect((await harness.manager.getSession(session.id))?.status).toBe("waiting");

    harness.tmux.capturePane = async () => "Command approval required\nallow and don't ask again";
    await harness.manager.discover();
    expect((await harness.manager.getSession(session.id))?.status).toBe("waiting");
    expect(await harness.manager.getPendingApproval(session.id)).toBeNull();
    expect(sentKeys).toEqual([]);
    harness.db.close();
  });

  it("does not restore a historical structured approval after the pane has continued", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const path = join(harness.codexHome, "sessions", "historical-approval.jsonl");
    await writeFile(path, [
      JSON.stringify({
        timestamp: "2026-07-07T00:00:00.000Z",
        type: "session_meta",
        payload: { session_id: "codex-session", cwd: repo, cli_version: "test" }
      }),
      JSON.stringify({
        timestamp: "2026-07-07T00:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "exec_approval_request",
          approval_id: "approval-historical",
          command: ["pnpm", "test"],
          prefix_rule: ["pnpm", "test"]
        }
      }),
      ""
    ].join("\n"));
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.capturePane = async () => "Ready\n› ";

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0]!;
    await harness.manager.ingest();

    expect((await harness.manager.getSession(session.id))?.status).toBe("waiting");
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
      capture = "› ";
    };

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0];
    expect(session?.status).toBe("waiting");
    await harness.manager.ingest();
    await harness.manager.discover();
    expect((await harness.manager.getSession(session.id))?.status).toBe("approval");

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

  it("surfaces and resolves app sign-in prompts from nested connector calls", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const path = join(harness.codexHome, "sessions", "app-sign-in.jsonl");
    const sentKeys: string[][] = [];
    await writeFile(
      path,
      [
        JSON.stringify({
          timestamp: "2026-07-31T00:00:00.000Z",
          type: "session_meta",
          payload: { session_id: "codex-session", cwd: repo, cli_version: "test" }
        }),
        JSON.stringify({
          timestamp: "2026-07-31T00:00:01.000Z",
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            name: "exec",
            call_id: "call-app-sign-in",
            input: [
              "const r = await tools.mcp__codex_apps__slack_slack_search_public_and_private({",
              '  query: "patch notes"',
              "});"
            ].join("\n")
          }
        }),
        ""
      ].join("\n")
    );
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    let capture = appSignInCapture(1);
    harness.tmux.capturePane = async () => capture;
    harness.tmux.sendKeys = async (_paneId, keys) => {
      sentKeys.push(keys);
      capture = "› ";
    };

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0];
    expect(session?.status).toBe("waiting");
    await harness.manager.ingest();
    await harness.manager.discover();
    expect((await harness.manager.getSession(session.id))?.status).toBe("approval");

    expect(await harness.manager.getPendingApproval(session.id)).toMatchObject({
      id: "call-app-sign-in",
      kind: "permissions",
      title: "Finish App Sign In",
      toolName: "codex_apps.slack.slack_search_public_and_private",
      options: [
        { decision: "approve_once", label: "I already signed in" },
        { decision: "deny", label: "Back" }
      ]
    });

    await harness.manager.resolveApproval(session.id, { decision: "approve_once" });
    expect(sentKeys).toEqual([["Enter"]]);
    expect((await harness.manager.getSession(session.id))?.status).toBe("waiting");
    harness.db.close();
  });

  it("surfaces a matching generic MCP approval from a batched nested tool call", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const path = join(harness.codexHome, "sessions", "generic-mcp-approval.jsonl");
    const sentKeys: string[][] = [];
    await writeFile(
      path,
      [
        JSON.stringify({
          timestamp: "2026-08-26T00:00:00.000Z",
          type: "session_meta",
          payload: { session_id: "codex-session", cwd: repo, cli_version: "test" }
        }),
        JSON.stringify({
          timestamp: "2026-08-26T00:00:01.000Z",
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            name: "exec",
            call_id: "call-generic-mcp-approval",
            input: [
              "const calls = [",
              '  tools.mcp__muxpilot_sessions__read_session({sessionId:"session-id",limit:10}),',
              '  tools.mcp__muxpilot_sessions__capture_tmux_pane({paneId:"%1",lines:100})',
              "];",
              "const results = await Promise.all(calls);"
            ].join("\n")
          }
        }),
        ""
      ].join("\n")
    );
    let capture = ["Working (20s • esc to interrupt)", mcpApprovalCapture(1)].join("\n");
    harness.tmux.listPanes = async () => [
      testPane({ cwd: repo, paneId: "%1", title: "[ . ] Action Required | codex-session" })
    ];
    harness.tmux.capturePane = async () => capture;
    harness.tmux.sendKeys = async (_paneId, keys) => {
      sentKeys.push(keys);
      capture = "› ";
    };

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0]!;
    expect(session.status).toBe("waiting");
    const publishedStatuses: string[] = [];
    const unsubscribe = harness.events.subscribe((event) => {
      if (event.type === "session.updated") publishedStatuses.push((event.payload as ManagedSession).status);
    });

    await harness.manager.ingest();
    await harness.manager.discover();

    expect((await harness.manager.getSession(session.id))?.status).toBe("approval");
    expect(publishedStatuses).toContain("approval");
    expect(await harness.manager.getPendingApproval(session.id)).toMatchObject({
      id: "call-generic-mcp-approval",
      kind: "permissions",
      title: 'Allow the muxpilot_sessions MCP server to run tool "capture_tmux_pane"?',
      toolName: "muxpilot_sessions.capture_tmux_pane"
    });

    await harness.manager.resolveApproval(session.id, { decision: "approve_for_session" });
    expect(sentKeys).toEqual([["Down", "Enter"]]);
    expect((await harness.manager.getSession(session.id))?.status).toBe("waiting");
    unsubscribe();
    harness.db.close();
  });

  it("surfaces a matching generic MCP approval from a native function call", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const path = join(harness.codexHome, "sessions", "native-mcp-approval.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({
          timestamp: "2026-08-26T00:00:00.000Z",
          type: "session_meta",
          payload: { session_id: "codex-session", cwd: repo, cli_version: "test" }
        }),
        JSON.stringify({
          timestamp: "2026-08-26T00:00:01.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "capture_tmux_pane",
            namespace: "mcp__muxpilot_sessions",
            call_id: "call-native-mcp-approval",
            arguments: JSON.stringify({ paneId: "%1", lines: 100 })
          }
        }),
        ""
      ].join("\n")
    );
    harness.tmux.listPanes = async () => [
      testPane({ cwd: repo, paneId: "%1", title: "[ . ] Action Required | codex-session" })
    ];
    harness.tmux.capturePane = async () => mcpApprovalCapture(1);

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0]!;
    await harness.manager.ingest();
    await harness.manager.discover();

    expect((await harness.manager.getSession(session.id))?.status).toBe("approval");
    expect(await harness.manager.getPendingApproval(session.id)).toMatchObject({
      id: "call-native-mcp-approval",
      toolName: "muxpilot_sessions.capture_tmux_pane"
    });
    harness.db.close();
  });

  it("rejects a generic MCP approval that does not match the latest nested tool call", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const path = join(harness.codexHome, "sessions", "mismatched-mcp-approval.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({
          timestamp: "2026-08-26T00:00:00.000Z",
          type: "session_meta",
          payload: { session_id: "codex-session", cwd: repo, cli_version: "test" }
        }),
        JSON.stringify({
          timestamp: "2026-08-26T00:00:01.000Z",
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            name: "exec",
            call_id: "call-unrelated-mcp-tool",
            input: [
              'const session = await tools.mcp__muxpilot_sessions__read_session({sessionId:"session-id",limit:10});',
              'const capture = await tools.mcp__other_sessions__capture_tmux_pane({paneId:"%1",lines:100});'
            ].join("\n")
          }
        }),
        ""
      ].join("\n")
    );
    harness.tmux.listPanes = async () => [
      testPane({ cwd: repo, paneId: "%1", title: "[ . ] Action Required | codex-session" })
    ];
    harness.tmux.capturePane = async () => mcpApprovalCapture(1);

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0]!;
    await harness.manager.ingest();
    await harness.manager.discover();

    expect((await harness.manager.getSession(session.id))?.status).toBe("waiting");
    harness.db.close();
  });

  it("surfaces and resolves wrapped custom command approvals despite working cues", async () => {
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
            input: [
              "const r = await tools.exec_command({",
              '  "cmd":"pnpm app restart prod",',
              '  "sandbox_permissions":"require_escalated",',
              '  "prefix_rule":["pnpm","app","restart","prod"]',
              "});"
            ].join("\n")
          }
        }),
        ""
      ].join("\n")
    );
    let capture = commandApprovalCapture(1);
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.capturePane = async () => capture;
    harness.tmux.sendKeys = async (_paneId, keys) => {
      sentKeys.push(keys);
      capture = "› ";
    };

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0];
    expect(session?.status).toBe("waiting");
    const publishedStatuses: string[] = [];
    const unsubscribe = harness.events.subscribe((event) => {
      if (event.type === "session.updated") publishedStatuses.push((event.payload as ManagedSession).status);
    });
    capture = [
      "Working (20s • esc to interrupt)",
      commandApprovalCapture(1).replace(
        "  $ pnpm app restart prod",
        ["  $ pnpm app restart prod", ...Array.from({ length: 35 }, (_, index) => `  command detail ${index + 1}`)].join("\n")
      )
    ].join("\n");
    await harness.manager.ingest();
    await harness.manager.discover();
    expect((await harness.manager.getSession(session.id))?.status).toBe("approval");
    expect(publishedStatuses).toContain("approval");

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
    expect(await harness.db.hasRepositoryApprovalRule("/repo/.git", ["pnpm", "app", "restart", "prod"])).toBe(false);
    expect((await harness.manager.getSession(session.id))?.status).toBe("waiting");
    expect(await harness.manager.getPendingApproval(session.id)).toBeNull();
    unsubscribe();
    harness.db.close();
  });

  it("surfaces destructive custom command approvals without explicit escalation metadata", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const path = join(harness.codexHome, "sessions", "destructive-command-approval.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({
          timestamp: "2026-08-09T00:00:00.000Z",
          type: "session_meta",
          payload: { session_id: "codex-session", cwd: repo, cli_version: "test" }
        }),
        JSON.stringify({
          timestamp: "2026-08-09T00:00:01.000Z",
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            name: "exec",
            call_id: "call-destructive-command-approval",
            input: 'const r = await tools.exec_command({cmd:"rm -rf /tmp/disposable-results",workdir:"/repo"}); text(r.output);'
          }
        }),
        ""
      ].join("\n")
    );
    const capture = commandApprovalCapture(1)
      .replaceAll("pnpm app restart prod", "rm -rf /tmp/disposable-results")
      .replace(
        "Do you want to allow restarting the muxpilot production server so the simplified hold feedback is live?",
        "Do you want to allow this destructive command?"
      );
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1", title: "[ . ] Action Required" })];
    harness.tmux.capturePane = async () => capture;

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0]!;
    expect(session.status).toBe("waiting");
    await harness.manager.ingest();
    await harness.manager.discover();

    expect((await harness.manager.getSession(session.id))?.status).toBe("approval");
    expect(await harness.manager.getPendingApproval(session.id)).toMatchObject({
      id: "call-destructive-command-approval",
      kind: "command",
      command: "rm -rf /tmp/disposable-results"
    });
    harness.db.close();
  });

  it("surfaces an elided destructive command approval during background discovery", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const path = join(harness.codexHome, "sessions", "elided-destructive-approval.jsonl");
    const command = [
      "rm -rf /tmp/rand-fixes-stage-2026-08-21",
      "&& python3 build_rand_reconciliation.py",
      "--v1-dir /home/dev/workspace/rand-migration",
      "--v2-dir /tmp/rand-v2-snapshot-2026-08-21",
      "--output-dir /tmp/rand-fixes-stage-2026-08-21"
    ].join(" ");
    await writeFile(path, [
      JSON.stringify({
        timestamp: "2026-08-21T17:29:00.000Z",
        type: "session_meta",
        payload: { session_id: "codex-session", cwd: repo, cli_version: "test" }
      }),
      JSON.stringify({
        timestamp: "2026-08-21T17:29:01.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "exec",
          call_id: "call-elided-destructive-approval",
          input: `const r = await tools.exec_command({ cmd: ${JSON.stringify(command)} }); text(r.output);`
        }
      }),
      ""
    ].join("\n"));
    const displayedCommand =
      "rm -rf /tmp/rand-fixes-stage-2026-08-21 && python3 … --output-dir /tmp/rand-fixes-stage-2026-08-21";
    const capture = commandApprovalCapture(1).replaceAll("pnpm app restart prod", displayedCommand);
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1", title: "⠸ codex-session" })];
    harness.tmux.capturePane = async () => capture;

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0]!;
    expect(session.status).toBe("working");
    const publishedStatuses: string[] = [];
    const unsubscribe = harness.events.subscribe((event) => {
      if (event.type === "session.updated") publishedStatuses.push((event.payload as ManagedSession).status);
    });

    await harness.manager.ingest();
    await harness.manager.discover();

    expect((await harness.manager.getSession(session.id))?.status).toBe("approval");
    expect(publishedStatuses).toContain("approval");
    unsubscribe();
    harness.db.close();
  });

  it("rejects a visible command approval that does not match the latest custom command", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const path = join(harness.codexHome, "sessions", "mismatched-command-approval.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({
          timestamp: "2026-08-09T00:00:00.000Z",
          type: "session_meta",
          payload: { session_id: "codex-session", cwd: repo, cli_version: "test" }
        }),
        JSON.stringify({
          timestamp: "2026-08-09T00:00:01.000Z",
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            name: "exec",
            call_id: "call-unrelated-command",
            input: 'const r = await tools.exec_command({cmd:"git status --short"}); text(r.output);'
          }
        }),
        ""
      ].join("\n")
    );
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.capturePane = async () => commandApprovalCapture(1).replaceAll("pnpm app restart prod", "rm -rf /tmp/results");

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0]!;
    await harness.manager.ingest();
    await harness.manager.discover();

    expect((await harness.manager.getSession(session.id))?.status).toBe("waiting");
    harness.db.close();
  });

  it("rejects an elided command approval with an unrelated visible suffix", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const path = join(harness.codexHome, "sessions", "mismatched-elided-command-approval.jsonl");
    await writeFile(path, [
      JSON.stringify({
        timestamp: "2026-08-21T17:29:00.000Z",
        type: "session_meta",
        payload: { session_id: "codex-session", cwd: repo, cli_version: "test" }
      }),
      JSON.stringify({
        timestamp: "2026-08-21T17:29:01.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "exec",
          call_id: "call-mismatched-elided-command",
          input: [
            "const r = await tools.exec_command({",
            '  cmd: "rm -rf /tmp/rand-fixes-stage-2026-08-21 && python3 unrelated.py --output-dir /tmp/unrelated"',
            "}); text(r.output);"
          ].join("\n")
        }
      }),
      ""
    ].join("\n"));
    const displayedCommand =
      "rm -rf /tmp/rand-fixes-stage-2026-08-21 && python3 … --output-dir /tmp/rand-fixes-stage-2026-08-21";
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.capturePane = async () => commandApprovalCapture(1).replaceAll("pnpm app restart prod", displayedCommand);

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0]!;
    await harness.manager.ingest();
    await harness.manager.discover();

    expect((await harness.manager.getSession(session.id))?.status).toBe("waiting");
    harness.db.close();
  });

  it("surfaces and resolves patch approvals that have no JSONL approval event", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const path = join(harness.codexHome, "sessions", "patch-approval.jsonl");
    const sentKeys: string[][] = [];
    await writeFile(
      path,
      [
        JSON.stringify({
          timestamp: "2026-07-14T00:00:00.000Z",
          type: "session_meta",
          payload: { session_id: "codex-session", cwd: repo, cli_version: "test" }
        }),
        JSON.stringify({
          timestamp: "2026-07-14T00:00:01.000Z",
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            name: "exec",
            call_id: "call-patch-approval",
            input: "const patch = '*** Begin Patch'; text(await tools.apply_patch(patch));"
          }
        }),
        ""
      ].join("\n")
    );
    let capture = [
      "Working (20s • esc to interrupt)",
      ...Array.from({ length: 35 }, (_, index) => `    ${index + 1} +patch detail`),
      patchApprovalCapture(1)
    ].join("\n");
    harness.tmux.listPanes = async () => [
      testPane({ cwd: repo, paneId: "%1", title: "[ ! ] Action Required | codex-session" })
    ];
    harness.tmux.capturePane = async () => capture;
    harness.tmux.sendKeys = async (_paneId, keys) => {
      sentKeys.push(keys);
      capture = "› ";
    };

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0]!;
    expect(session.status).toBe("waiting");
    await harness.manager.ingest();
    await harness.manager.discover();

    expect((await harness.manager.getSession(session.id))?.status).toBe("approval");
    expect(await harness.manager.getPendingApproval(session.id)).toMatchObject({
      id: "call-patch-approval",
      kind: "patch",
      title: "Would you like to make the following edits?",
      command: null,
      prefixRule: null,
      options: [
        { decision: "approve_once", label: "Approve once" },
        { decision: "approve_for_session", label: "Allow files for session" },
        { decision: "deny", label: "Deny" }
      ]
    });

    await harness.manager.resolveApproval(session.id, { decision: "approve_for_session" });
    expect(sentKeys).toEqual([["Down", "Enter"]]);
    expect((await harness.manager.getSession(session.id))?.status).toBe("waiting");
    expect(await harness.manager.getPendingApproval(session.id)).toBeNull();
    harness.db.close();
  });

  it("recovers a nested terminal approval when the persisted status is waiting", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const path = join(harness.codexHome, "sessions", "nested-command-approval.jsonl");
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
            call_id: "call-nested-command-approval",
            input: "for (const command of commands) await tools.exec_command({ sandbox_permissions: 'require_escalated' });"
          }
        }),
        ""
      ].join("\n")
    );
    const sentKeys: string[][] = [];
    let capture = commandApprovalCapture(1);
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.capturePane = async () => capture;
    harness.tmux.sendKeys = async (_paneId, keys) => {
      sentKeys.push(keys);
      capture = "› ";
    };

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0]!;
    await harness.manager.ingest();
    await harness.manager.discover();
    await harness.manager.resolveApproval(session.id, { decision: "approve_once" });
    expect((await harness.manager.getSession(session.id))?.status).toBe("waiting");

    capture = commandApprovalCapture(1)
      .replaceAll("pnpm app restart prod", "git status --short --branch; git log -1 --oneline --decorate")
      .replace(
        "Do you want to allow restarting the muxpilot production server so the simplified hold feedback is live?",
        "May I verify which existing managed checkout matches the target branch outside the broken sandbox mount?"
      );
    const approval = await harness.manager.getPendingApproval(session.id);

    expect(approval).toMatchObject({
      kind: "command",
      command: "git status --short --branch; git log -1 --oneline --decorate",
      reason: "May I verify which existing managed checkout matches the target branch outside the broken sandbox mount?"
    });
    expect((await harness.manager.getSession(session.id))?.status).toBe("approval");

    await harness.manager.resolveApproval(session.id, { decision: "approve_once" });
    expect(sentKeys).toEqual([["Enter"], ["Enter"]]);
    expect((await harness.manager.getSession(session.id))?.status).toBe("waiting");
    harness.db.close();
  });

  it("records prefix approvals for the session repository", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const path = join(harness.codexHome, "sessions", "repo-approval.jsonl");
    await writeFile(path, [
      JSON.stringify({ timestamp: "2026-07-10T00:00:00.000Z", type: "session_meta", payload: { session_id: "codex-session", cwd: repo, cli_version: "test" } }),
      JSON.stringify({ timestamp: "2026-07-10T00:00:01.000Z", type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "call-repo-approval", arguments: JSON.stringify({ cmd: "pnpm test", sandbox_permissions: "require_escalated", prefix_rule: ["pnpm", "test"] }) } }),
      ""
    ].join("\n"));
    const sentKeys: string[][] = [];
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.capturePane = async () => commandApprovalCapture(1)
      .replaceAll("pnpm app restart prod", "pnpm test");
    harness.tmux.sendKeys = async (_paneId, keys) => { sentKeys.push(keys); };
    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0]!;
    await harness.db.upsertGitWorkspace({
      id: "workspace-repo-approval",
      sessionId: session.id,
      commonGitDir: join(repo, ".git"),
      helperToken: "token",
      summary: { id: "workspace-repo-approval", entryPath: repo, targetBranch: "main" },
      createdAt: "2026-07-10T00:00:02.000Z",
      updatedAt: "2026-07-10T00:00:02.000Z"
    }, "2026-07-10T00:00:02.000Z");
    await harness.manager.ingest();
    await harness.manager.discover();
    expect((await harness.manager.getPendingApproval(session.id))?.options).toContainEqual(
      expect.objectContaining({ decision: "approve_for_prefix", label: "Allow for repository" })
    );
    await harness.manager.resolveApproval(session.id, { decision: "approve_for_prefix" });

    expect(await harness.db.hasRepositoryApprovalRule(join(repo, ".git"), ["pnpm", "test"])).toBe(true);
    await harness.manager.discover();
    expect(sentKeys).toEqual([["Enter"], ["Enter"]]);
    expect((await harness.manager.getSession(session.id))?.status).toBe("waiting");
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
    expect((await harness.manager.getSession(session.id))?.status).toBe("waiting");
    expect(await harness.manager.getPendingQuestion(session.id)).toBeNull();
    harness.db.close();
  });

  it("submits option notes within the native question overlay without interrupting", async () => {
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
      "keys:Down,Tab",
      "paste:Include tests ",
      "keys:Enter",
      "keys:Down,Tab",
      "paste:Ship it ",
      "keys:Enter",
      "paste:Typed only ",
      "keys:Enter"
    ]);
    harness.db.close();
  });

  it("returns a question conflict when the bound pane disappeared", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const path = join(harness.codexHome, "sessions", "missing-question-pane.jsonl");
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
              questions: [{
                id: "scope",
                header: "Scope",
                question: "How far should this go?",
                options: [{ label: "Complete", description: "" }]
              }]
            })
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
    harness.tmux.listPanes = async () => [];

    await expect(harness.manager.answerQuestion(session.id, {
      answers: { scope: { answers: ["Complete"] } }
    })).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("pane may have changed or become unavailable")
    });
    expect((await harness.manager.getSession(session.id))?.status).toBe("question");
    expect(await harness.manager.getPendingQuestion(session.id)).not.toBeNull();
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

  it("returns plan-mode sessions to waiting when Codex stops before proposing a plan", async () => {
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

    expect(harness.manager.getSession(session.id)?.status).toBe("waiting");

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

  it("does not treat plan input mode or ordinary assistant output as active planning", async () => {
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

    expect(harness.manager.getSession(session.id)?.status).toBe("waiting");
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
            content: [{
              type: "output_text",
              text: "Before\n<proposed_plan>\nDo it.\n</proposed_plan>\n<oai-mem-citation>private</oai-mem-citation>"
            }]
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
    let planNameAtSend: string | null = null;
    let planVisibleAtSend = false;
    harness.tmux.sendKeys = async (_paneId, keys) => {
      sentKeys.push(keys);
      if (planNameAtSend) {
        planVisibleAtSend = (await harness.manager.readDocument(session.id, planNameAtSend)).document.content === "Do it.\n";
      }
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

    const planMessage = await harness.db.latestPlanReadyMessage(session.id);
    expect(planMessage).not.toBeNull();
    planNameAtSend = `plan-${planMessage!.sequence}.md`;
    const documentEvents: unknown[] = [];
    const unsubscribeDocuments = harness.events.subscribe((event) => {
      if (event.sessionId === session.id && event.type === "documents.updated") documentEvents.push(event.payload);
    });
    const actionSession = await harness.manager.act(session.id, { type: "choosePlanAction", action: "clear_context_implement" });
    unsubscribeDocuments();
    expect(sentKeys).toEqual([["Down", "Enter"]]);
    expect(actionSession?.status).toBe("working");
    expect(harness.manager.getSession(session.id)?.status).toBe("working");
    const planName = `plan-${planMessage!.sequence}.md`;
    expect(planVisibleAtSend).toBe(true);
    expect((await harness.manager.listDocuments(session.id)).documents.map((document) => document.name)).toEqual(["INDEX.md", planName]);
    expect((await harness.manager.readDocument(session.id, planName)).document.content).toBe("Do it.\n");
    expect((await harness.manager.readDocument(session.id, "INDEX.md")).document.content).toContain(`](${planName})`);
    expect(documentEvents).toEqual([{ created: [planName, "INDEX.md"], updated: [] }]);

    await harness.manager.discover();
    expect(harness.manager.getSession(session.id)?.status).toBe("working");
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

    const publishedStatuses: string[] = [];
    const unsubscribe = harness.events.subscribe((event) => {
      if (event.sessionId !== session.id || event.type !== "status.changed") return;
      publishedStatuses.push(String((event.payload as { status?: unknown }).status));
    });
    const implement = await harness.manager.act(session.id, { type: "choosePlanAction", action: "implement" });
    expect(implement).toMatchObject({ status: "working", inputMode: "default" });
    expect(harness.manager.getSession(session.id)).toMatchObject({ status: "working", inputMode: "default" });
    const clearContext = await harness.manager.act(session.id, { type: "choosePlanAction", action: "clear_context_implement" });
    expect(clearContext).toMatchObject({ status: "working", inputMode: "default" });
    expect(harness.manager.getSession(session.id)).toMatchObject({ status: "working", inputMode: "default" });
    const stayInPlan = await harness.manager.act(session.id, { type: "choosePlanAction", action: "stay_in_plan" });
    unsubscribe();
    expect(stayInPlan).toMatchObject({ status: "planning", inputMode: "plan" });
    expect(harness.manager.getSession(session.id)).toMatchObject({ status: "planning", inputMode: "plan" });

    expect(sentKeys).toEqual([["Enter"], ["Down", "Enter"], ["Down", "Down", "Enter"]]);
    expect(publishedStatuses).toEqual(["working", "working", "planning"]);
    harness.db.close();
  });

  it("does not transition a plan-ready session when plan-action key submission fails", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const path = join(harness.codexHome, "sessions", "plan-action-send-failure.jsonl");
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
    harness.tmux.sendKeys = async () => {
      throw new Error("tmux key submission failed");
    };

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0]!;
    await harness.manager.ingest();
    const publishedStatuses: string[] = [];
    const unsubscribe = harness.events.subscribe((event) => {
      if (event.sessionId === session.id && event.type === "status.changed") {
        publishedStatuses.push(String((event.payload as { status?: unknown }).status));
      }
    });

    await expect(harness.manager.act(session.id, { type: "choosePlanAction", action: "implement" })).rejects.toThrow(
      "tmux key submission failed"
    );
    unsubscribe();

    expect(harness.manager.getSession(session.id)).toMatchObject({ status: "plan_ready", inputMode: "default" });
    expect(publishedStatuses).toEqual([]);
    const planMessage = await harness.db.latestPlanReadyMessage(session.id);
    expect((await harness.manager.readDocument(session.id, `plan-${planMessage!.sequence}.md`)).document.content).toBe("Do it.\n");
    harness.db.close();
  });

  it("does not persist a proposed plan when staying in Plan mode", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const path = join(harness.codexHome, "sessions", "stay-in-plan-without-document.jsonl");
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
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.sendKeys = async () => undefined;

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0]!;
    await harness.manager.ingest();
    await harness.manager.act(session.id, { type: "choosePlanAction", action: "stay_in_plan" });

    expect((await harness.manager.listDocuments(session.id)).documents).toEqual([]);
    harness.db.close();
  });

  it("does not begin implementation when approved-plan persistence fails", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const path = join(harness.codexHome, "sessions", "approved-plan-persistence-failure.jsonl");
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
    const sentKeys: string[][] = [];
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.sendKeys = async (_paneId, keys) => { sentKeys.push(keys); };

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0]!;
    await harness.manager.ingest();
    const planMessage = await harness.db.latestPlanReadyMessage(session.id);
    await harness.manager.listDocuments(session.id);
    const scopeId = harness.manager.getSession(session.id)!.documentScopeId!;
    await writeFile(join(harness.dir, "sessions", scopeId, "documents", `plan-${planMessage!.sequence}.md`), "# Existing\n");

    await expect(harness.manager.act(session.id, { type: "choosePlanAction", action: "implement" }))
      .rejects.toThrow("already exists with different content");
    expect(sentKeys).toEqual([]);
    expect(harness.manager.getSession(session.id)?.status).toBe("plan_ready");
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
    expect(harness.manager.getSession(session.id)).toMatchObject({ inputMode: "default", status: "working" });

    await harness.manager.act(session.id, { type: "choosePlanAction", action: "stay_in_plan" });
    expect(harness.manager.getSession(session.id)).toMatchObject({ inputMode: "plan", status: "planning" });
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

  it("switches Fast mode with Codex's toggle command after the tier is confirmed", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const mtime = new Date("2026-07-07T00:00:00.000Z");
    const sessionPath = join(harness.codexHome, "sessions", "session.jsonl");
    await writeCodexSession(harness.codexHome, "session.jsonl", {
      sessionId: "codex-session",
      cwd: repo,
      user: "first prompt",
      assistant: "first answer",
      mtime
    });
    await appendFile(
      sessionPath,
      `${JSON.stringify({
        timestamp: "2026-07-07T00:00:03.000Z",
        type: "event_msg",
        payload: { type: "thread_settings_applied", thread_settings: { service_tier: "default" } }
      })}\n`
    );
    await utimes(sessionPath, mtime, mtime);
    const pane = testPane({ cwd: repo, paneId: "%1", title: "⠙ repo" });
    harness.tmux.listPanes = async () => [pane];
    const sentInputs: string[] = [];
    harness.tmux.sendInput = async (_paneId, text) => {
      sentInputs.push(text);
      await appendFile(
        sessionPath,
        `${JSON.stringify({
          timestamp: "2026-07-07T00:00:04.000Z",
          type: "event_msg",
          payload: { type: "thread_settings_applied", thread_settings: { service_tier: "priority" } }
        })}\n`
      );
    };

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0];
    expect(session?.fastMode).toBe(false);
    expect(session?.status).toBe("working");

    const updated = await harness.manager.act(session.id, { type: "setFastMode", enabled: true });

    expect(sentInputs).toEqual(["/fast"]);
    expect(updated?.fastMode).toBe(true);
    harness.db.close();
  });

  it("submits an exact stranded Fast mode command without repasting", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const mtime = new Date("2026-07-07T00:00:00.000Z");
    const sessionPath = join(harness.codexHome, "sessions", "session.jsonl");
    await writeCodexSession(harness.codexHome, "session.jsonl", {
      sessionId: "codex-session",
      cwd: repo,
      user: "first prompt",
      assistant: "first answer",
      mtime
    });
    await appendFile(
      sessionPath,
      `${JSON.stringify({
        timestamp: "2026-07-07T00:00:03.000Z",
        type: "event_msg",
        payload: { type: "thread_settings_applied", thread_settings: { service_tier: "priority" } }
      })}\n`
    );
    await utimes(sessionPath, mtime, mtime);
    const pane = testPane({ cwd: repo, paneId: "%1", title: "codex" });
    harness.tmux.listPanes = async () => [pane];
    harness.tmux.capturePane = async () => "› /fast\n \n  /fast  1.5x speed, increased usage";
    const sentInputs: string[] = [];
    const submittedComposers: string[] = [];
    harness.tmux.sendInput = async (_paneId, text) => { sentInputs.push(text); };
    harness.tmux.submitComposedInput = async (_paneId, text) => {
      submittedComposers.push(text);
      await appendFile(
        sessionPath,
        `${JSON.stringify({
          timestamp: "2026-07-07T00:00:04.000Z",
          type: "event_msg",
          payload: { type: "thread_settings_applied", thread_settings: { service_tier: "default" } }
        })}\n`
      );
      return { pasteReplayCount: 0, submitKeyRetryCount: 0 };
    };

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0]!;
    const updated = await harness.manager.act(session.id, { type: "setFastMode", enabled: false });

    expect(sentInputs).toEqual([]);
    expect(submittedComposers).toEqual(["/fast "]);
    expect(updated?.fastMode).toBe(false);
    harness.db.close();
  });

  it("translates Fast mode transport failures into switch conflicts", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const mtime = new Date("2026-07-07T00:00:00.000Z");
    const sessionPath = join(harness.codexHome, "sessions", "session.jsonl");
    await writeCodexSession(harness.codexHome, "session.jsonl", {
      sessionId: "codex-session",
      cwd: repo,
      user: "first prompt",
      assistant: "first answer",
      mtime
    });
    await appendFile(
      sessionPath,
      `${JSON.stringify({
        timestamp: "2026-07-07T00:00:03.000Z",
        type: "event_msg",
        payload: { type: "thread_settings_applied", thread_settings: { service_tier: "default" } }
      })}\n`
    );
    await utimes(sessionPath, mtime, mtime);
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1", title: "⠙ repo" })];
    harness.tmux.sendInput = async () => {
      throw new InputTransportError(
        "Codex displayed input that did not match the submitted text",
        "composer_changed",
        { pasteReplayCount: 0, submitKeyRetryCount: 0 }
      );
    };

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0];

    await expect(harness.manager.act(session.id, { type: "setFastMode", enabled: true }))
      .rejects.toEqual(expect.objectContaining({
        constructor: FastModeSwitchError,
        message: "Codex displayed input that did not match the submitted text",
        statusCode: 409
      }));
    harness.db.close();
  });

  it("detects an explicit Standard tier beyond the previous JSONL tail window", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const sessionPath = join(harness.codexHome, "sessions", "session.jsonl");
    await writeCodexSession(harness.codexHome, "session.jsonl", {
      sessionId: "codex-session",
      cwd: repo,
      user: "first prompt",
      assistant: "first answer",
      mtime: new Date("2026-07-07T00:00:00.000Z")
    });
    await appendFile(
      sessionPath,
      `${JSON.stringify({
        type: "event_msg",
        payload: { type: "thread_settings_applied", thread_settings: { service_tier: "priority" } }
      })}\n`
    );
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];

    await harness.manager.discover();
    expect(harness.manager.listSessions(true)[0]?.fastMode).toBe(true);

    await appendFile(
      sessionPath,
      [
        JSON.stringify({
          type: "event_msg",
          payload: { type: "thread_settings_applied", thread_settings: { service_tier: "default" } }
        }),
        JSON.stringify({ type: "response_item", payload: { type: "function_call_output", output: "x".repeat(300 * 1024) } }),
        ""
      ].join("\n")
    );

    await harness.manager.discover();

    expect(harness.manager.listSessions(true)[0]?.fastMode).toBe(false);
    harness.db.close();
  });

  it("hydrates model selections from the Codex screen before the first turn", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.capturePane = async () => [
      "  gpt-5.6-sol medium · ~/workspace/muxpilot",
      "",
      "╭──────────────────────────────────────────────────╮",
      "│ >_ OpenAI Codex (v0.144.0)                       │",
      "│ model:     gpt-5.6-sol medium   /model to change │",
      "╰──────────────────────────────────────────────────╯",
      "",
      "› "
    ].join("\n");

    await harness.manager.discover();

    expect(harness.manager.listSessions(true)[0]?.models).toEqual({
      default: { model: "gpt-5.6-sol", reasoningEffort: "medium" },
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

    const result = await harness.manager.sendInput(session.id, "run $test-example");

    expect(sentInputs).toEqual(["run $test-example "]);
    expect(result).toMatchObject({ session: { status: "working", preview: "run $test-example" } });
    expect(harness.manager.getSession(session.id)?.status).toBe("working");
    harness.db.close();
  });

  it("persists a failed delivery transaction when tmux submission fails", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.capturePane = async () => "› ";
    harness.tmux.sendInput = async () => {
      throw new Error("tmux send failed");
    };

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0]!;

    await expect(harness.manager.sendInput(session.id, "do not persist")).rejects.toThrow("tmux send failed");

    expect(await harness.db.listMessages(session.id, 0)).toMatchObject([{
      text: "do not persist",
      payload: { muxpilotSubmission: { state: "failed", deliveryPhase: "failed", failureCode: "tmux_failed" } }
    }]);
    expect(harness.manager.getSession(session.id)).toMatchObject({ status: "input_failed", preview: "do not persist" });
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

  it("marks an old unacknowledged muxpilot submission failed while Codex remains ready", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.capturePane = async () => "› ";

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0]!;
    const submitted: ChatMessage = {
      id: "failed-submission",
      sessionId: session.id,
      sequence: await harness.db.nextSequence(session.id),
      type: "user",
      role: "user",
      timestamp: "2026-07-07T00:00:00.000Z",
      text: "Plan the change",
      payload: {
        collaborationMode: "plan",
        muxpilotSubmission: { codexSessionId: null, codexJsonlPath: null }
      }
    };
    await harness.db.appendMessage(submitted);
    await harness.db.setSessionStatus(session.id, "planning", submitted.timestamp);

    await harness.manager.discover();

    expect(harness.manager.getSession(session.id)?.status).toBe("input_failed");
    expect((await harness.db.latestUserMessage(session.id))?.payload).toMatchObject({
      muxpilotSubmission: { state: "failed", failureReason: expect.stringContaining("did not acknowledge") }
    });
    await harness.db.close();
  });

  it("acknowledges a restored legacy submission when its turn already completed", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.capturePane = async () => "› ";

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0]!;
    const submitted: ChatMessage = {
      id: "restored-completed-submission",
      sessionId: session.id,
      sequence: await harness.db.nextSequence(session.id),
      type: "user",
      role: "user",
      timestamp: "2026-07-07T00:00:00.000Z",
      text: "Already completed prompt",
      payload: {
        collaborationMode: "default",
        muxpilotSubmission: { codexSessionId: "codex-1", codexJsonlPath: "/tmp/codex-1.jsonl" }
      }
    };
    await harness.db.appendMessage(submitted);
    await harness.db.appendMessage({
      id: "restored-task-complete",
      sessionId: session.id,
      sequence: await harness.db.nextSequence(session.id),
      type: "status",
      role: "system",
      timestamp: "2026-07-07T00:01:00.000Z",
      text: "task_complete",
      payload: {}
    });

    await harness.manager.discover();

    expect(harness.manager.getSession(session.id)?.status).toBe("waiting");
    expect((await harness.db.latestUserMessage(session.id))?.payload).toMatchObject({
      muxpilotSubmission: {
        state: "acknowledged",
        deliveryPhase: "acknowledged",
        acknowledgedBy: "task_complete",
        failureReason: null
      }
    });
    await harness.db.close();
  });

  it("automatically replays one verified submission when Codex remains ready with an empty composer", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const sentInputs: string[] = [];
    const sentKeys: string[][] = [];
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.capturePane = async () => "› ";
    harness.tmux.sendInput = async (_paneId, text) => { sentInputs.push(text); };
    harness.tmux.sendKeys = async (_paneId, keys) => { sentKeys.push(keys); };

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0]!;
    const submitted: ChatMessage = {
      id: "automatic-replay",
      sessionId: session.id,
      sequence: await harness.db.nextSequence(session.id),
      type: "user",
      role: "user",
      timestamp: "2026-07-07T00:00:00.000Z",
      text: "Replay this prompt",
      payload: {
        collaborationMode: "plan",
        muxpilotSubmission: {
          state: "pending",
          deliveryPhase: "awaiting_ack",
          attemptCount: 1,
          replayCount: 0,
          enterRetryCount: 0,
          lastAttemptAt: "2026-07-07T00:00:00.000Z"
        }
      }
    };
    await harness.db.appendMessage(submitted);

    await harness.manager.discover();

    expect(sentInputs).toEqual(["Replay this prompt "]);
    expect(sentKeys).toEqual([["BTab"]]);
    expect(harness.manager.getSession(session.id)?.status).toBe("planning");
    expect((await harness.db.latestUserMessage(session.id))?.payload).toMatchObject({
      muxpilotSubmission: {
        state: "pending",
        deliveryPhase: "awaiting_ack",
        attemptCount: 2,
        replayCount: 1
      }
    });
    expect(await harness.db.listMessages(session.id, 0)).toHaveLength(1);
    await harness.db.close();
  });

  it("retries only Enter when the original prompt remains in the composer", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const submitPanes: string[] = [];
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.capturePane = async () => "› Submit this prompt";
    harness.tmux.submitInput = async (paneId) => { submitPanes.push(paneId); };

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0]!;
    const submitted: ChatMessage = {
      id: "enter-retry",
      sessionId: session.id,
      sequence: await harness.db.nextSequence(session.id),
      type: "user",
      role: "user",
      timestamp: "2026-07-07T00:00:00.000Z",
      text: "Submit this prompt",
      payload: {
        collaborationMode: "default",
        muxpilotSubmission: {
          state: "pending",
          deliveryPhase: "awaiting_ack",
          attemptCount: 1,
          replayCount: 0,
          enterRetryCount: 0,
          lastAttemptAt: "2026-07-07T00:00:00.000Z"
        }
      }
    };
    await harness.db.appendMessage(submitted);

    await harness.manager.discover();

    expect(submitPanes).toEqual(["%1"]);
    expect((await harness.db.latestUserMessage(session.id))?.payload).toMatchObject({
      muxpilotSubmission: { state: "pending", replayCount: 0, enterRetryCount: 1 }
    });
    await harness.db.close();
  });

  it("fails instead of replaying when the composer contains different input", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const sentInputs: string[] = [];
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.capturePane = async () => "› A different draft";
    harness.tmux.sendInput = async (_paneId, text) => { sentInputs.push(text); };

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0]!;
    await harness.db.appendMessage({
      id: "changed-composer",
      sessionId: session.id,
      sequence: await harness.db.nextSequence(session.id),
      type: "user",
      role: "user",
      timestamp: "2026-07-07T00:00:00.000Z",
      text: "Original prompt",
      payload: {
        muxpilotSubmission: {
          state: "pending",
          deliveryPhase: "awaiting_ack",
          replayCount: 0,
          enterRetryCount: 0,
          lastAttemptAt: "2026-07-07T00:00:00.000Z"
        }
      }
    });

    await harness.manager.discover();

    expect(sentInputs).toEqual([]);
    expect(harness.manager.getSession(session.id)?.status).toBe("input_failed");
    expect((await harness.db.latestUserMessage(session.id))?.payload).toMatchObject({
      muxpilotSubmission: { state: "failed", failureCode: "composer_changed" }
    });
    await harness.db.close();
  });

  it("does not perform a second automatic complete replay", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const sentInputs: string[] = [];
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.capturePane = async () => "› ";
    harness.tmux.sendInput = async (_paneId, text) => { sentInputs.push(text); };

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0]!;
    await harness.db.appendMessage({
      id: "replay-exhausted",
      sessionId: session.id,
      sequence: await harness.db.nextSequence(session.id),
      type: "user",
      role: "user",
      timestamp: "2026-07-07T00:00:00.000Z",
      text: "Do not duplicate",
      payload: {
        muxpilotSubmission: {
          state: "pending",
          deliveryPhase: "awaiting_ack",
          attemptCount: 2,
          replayCount: 1,
          enterRetryCount: 0,
          lastAttemptAt: "2026-07-07T00:00:00.000Z"
        }
      }
    });

    await harness.manager.discover();

    expect(sentInputs).toEqual([]);
    expect(harness.manager.getSession(session.id)?.status).toBe("input_failed");
    expect((await harness.db.latestUserMessage(session.id))?.payload).toMatchObject({
      muxpilotSubmission: { state: "failed", replayCount: 1, failureCode: "no_codex_acknowledgement" }
    });
    await harness.db.close();
  });

  it("retries the preserved failed submission without appending a duplicate", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const sentInputs: string[] = [];
    const sentKeys: string[][] = [];
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.capturePane = async () => "› ";
    harness.tmux.sendInput = async (_paneId, text) => sentInputs.push(text);
    harness.tmux.sendKeys = async (_paneId, keys) => { sentKeys.push(keys); };

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0]!;
    const submitted: ChatMessage = {
      id: "retry-submission",
      sessionId: session.id,
      sequence: await harness.db.nextSequence(session.id),
      type: "user",
      role: "user",
      timestamp: "2026-07-07T00:00:00.000Z",
      text: "Retry this exact prompt",
      payload: {
        collaborationMode: "plan",
        muxpilotSubmission: { state: "pending", attemptCount: 1, lastAttemptAt: "2026-07-07T00:00:00.000Z" }
      }
    };
    await harness.db.appendMessage(submitted);
    await harness.manager.discover();

    const retried = await harness.manager.act(session.id, { type: "retryInputDelivery" });

    expect(sentInputs).toEqual(["Retry this exact prompt "]);
    expect(sentKeys).toEqual([["BTab"]]);
    expect(retried?.status).toBe("planning");
    expect(await harness.db.listMessages(session.id, 0)).toHaveLength(1);
    expect((await harness.db.latestUserMessage(session.id))?.payload).toMatchObject({
      muxpilotSubmission: { state: "pending", attemptCount: 2, failureReason: null }
    });
    await harness.db.close();
  });

  it("restores the requested mode before submitting a matching preserved composer", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const submittedComposers: string[] = [];
    const sentInputs: string[] = [];
    const sentKeys: string[][] = [];
    let capture = "› Retry this exact prompt\n\n  gpt-5.6-sol high fast · Context 100% left · Plan mode";
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.capturePane = async () => capture;
    harness.tmux.sendKeys = async (_paneId, keys) => {
      sentKeys.push(keys);
      capture = "› Retry this exact prompt\n\n  gpt-5.6-sol medium fast · Context 100% left";
    };
    harness.tmux.sendInput = async (_paneId, text) => { sentInputs.push(text); };
    harness.tmux.submitComposedInput = async (_paneId, text) => {
      submittedComposers.push(text);
      return { pasteReplayCount: 0, submitKeyRetryCount: 0 };
    };

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0]!;
    const submitted: ChatMessage = {
      id: "retry-preserved-composer",
      sessionId: session.id,
      sequence: await harness.db.nextSequence(session.id),
      type: "user",
      role: "user",
      timestamp: "2026-07-07T00:00:00.000Z",
      text: "Retry this exact prompt",
      payload: {
        collaborationMode: "default",
        muxpilotSubmission: { state: "failed", attemptCount: 1, lastAttemptAt: "2026-07-07T00:00:00.000Z" }
      }
    };
    await harness.db.appendMessage(submitted);
    await harness.db.setSessionStatus(session.id, "input_failed", submitted.timestamp);

    const retried = await harness.manager.act(session.id, { type: "retryInputDelivery" });

    expect(submittedComposers).toEqual(["Retry this exact prompt "]);
    expect(sentInputs).toEqual([]);
    expect(sentKeys).toEqual([["BTab"]]);
    expect(retried?.status).toBe("working");
    expect(await harness.db.listMessages(session.id, 0)).toHaveLength(1);
    expect((await harness.db.latestUserMessage(session.id))?.payload).toMatchObject({
      muxpilotSubmission: {
        state: "pending",
        deliveryPhase: "awaiting_ack",
        attemptCount: 2,
        replayCount: 0
      }
    });
    await harness.db.close();
  });

  it("keeps a failed submission retryable when tmux delivery fails", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.capturePane = async () => "› ";
    harness.tmux.sendInput = async () => { throw new Error("tmux unavailable"); };

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0]!;
    const submitted: ChatMessage = {
      id: "retry-failure",
      sessionId: session.id,
      sequence: await harness.db.nextSequence(session.id),
      type: "user",
      role: "user",
      timestamp: "2026-07-07T00:00:00.000Z",
      text: "Retry after failure",
      payload: { muxpilotSubmission: { state: "failed", attemptCount: 1, lastAttemptAt: "2026-07-07T00:00:00.000Z" } }
    };
    await harness.db.appendMessage(submitted);
    await harness.db.setSessionStatus(session.id, "input_failed", submitted.timestamp);

    await expect(harness.manager.act(session.id, { type: "retryInputDelivery" })).rejects.toThrow("tmux unavailable");
    expect((await harness.db.latestUserMessage(session.id))?.payload).toMatchObject({
      muxpilotSubmission: { state: "failed", attemptCount: 2, failureReason: "Muxpilot could not deliver the input through tmux." }
    });
    await harness.db.close();
  });

  it("acknowledges a pending submission and retries it after a dismissed delivery failure", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    let capture = "Working (esc to interrupt)";
    const pane = testPane({ cwd: repo, paneId: "%1", title: "working" });
    harness.tmux.listPanes = async () => [pane];
    harness.tmux.capturePane = async () => capture;

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0]!;
    const submitted: ChatMessage = {
      id: "acknowledged-submission",
      sessionId: session.id,
      sequence: await harness.db.nextSequence(session.id),
      type: "user",
      role: "user",
      timestamp: "2026-07-07T00:00:00.000Z",
      text: "Start this prompt",
      payload: { muxpilotSubmission: { state: "pending", attemptCount: 1, lastAttemptAt: "2026-07-07T00:00:00.000Z" } }
    };
    await harness.db.appendMessage(submitted);

    await harness.manager.discover();
    expect((await harness.db.latestUserMessage(session.id))?.payload).toMatchObject({ muxpilotSubmission: { state: "acknowledged" } });
    expect(harness.manager.getSession(session.id)?.status).toBe("working");

    capture = "› ";
    pane.title = "codex";
    await harness.db.updateMessagePayload(submitted, {
      ...submitted.payload,
      muxpilotSubmission: {
        state: "failed",
        deliveryPhase: "failed",
        attemptCount: 1,
        lastAttemptAt: submitted.timestamp
      }
    });
    await harness.manager.discover();
    expect(harness.manager.getSession(session.id)?.status).toBe("input_failed");

    const dismissed = await harness.manager.act(session.id, { type: "dismissInputDeliveryFailure" });
    expect(dismissed?.status).toBe("waiting");
    expect((await harness.db.latestUserMessage(session.id))?.payload).toMatchObject({ muxpilotSubmission: { state: "dismissed" } });

    const sentInputs: string[] = [];
    harness.tmux.sendInput = async (_paneId, text) => { sentInputs.push(text); };
    const retried = await harness.manager.act(session.id, { type: "retryInputDelivery" });

    expect(sentInputs).toEqual(["Start this prompt "]);
    expect(retried?.status).toBe("working");
    expect(await harness.db.listMessages(session.id, 0)).toHaveLength(1);
    expect((await harness.db.latestUserMessage(session.id))?.payload).toMatchObject({
      muxpilotSubmission: { state: "pending", deliveryPhase: "awaiting_ack", attemptCount: 2 }
    });
    await harness.db.close();
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
    expect(harness.manager.getSession(session.id)).toMatchObject({ status: "working", preview: "edited queued prompt" });

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

  it("does not resend a failed queued delivery before its preserved submission is retried", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    let capture = "Working (esc to interrupt)";
    let shouldFail = true;
    const sentInputs: string[] = [];
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.capturePane = async () => capture;
    harness.tmux.sendInput = async (_paneId, text) => {
      if (shouldFail) throw new Error("tmux unavailable");
      sentInputs.push(text);
    };

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0]!;
    await harness.manager.sendInput(session.id, "queued recovery prompt");
    capture = "› ";

    await harness.manager.discover();
    expect(harness.manager.getSession(session.id)?.status).toBe("input_failed");
    expect(await harness.manager.listQueuedInputs(session.id)).toMatchObject([{ status: "failed" }]);
    expect(await harness.db.listMessages(session.id, 0)).toHaveLength(1);

    shouldFail = false;
    await harness.manager.discover();
    expect(sentInputs).toEqual([]);

    await harness.manager.act(session.id, { type: "retryInputDelivery" });
    expect(sentInputs).toEqual(["queued recovery prompt "]);
    expect(await harness.manager.listQueuedInputs(session.id)).toMatchObject([{ status: "sent" }]);
    expect(await harness.db.listMessages(session.id, 0)).toHaveLength(1);
    await harness.db.close();
  });

  it("keeps user input queued while an otherwise-ready session owns an active heavyweight command", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const sentInputs: string[] = [];
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.capturePane = async () => "› ";
    harness.tmux.sendInput = async (_paneId, text) => { sentInputs.push(text); };
    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0]!;
    await harness.db.upsertSession({
      ...session,
      gitWorkspace: { id: "workspace-a", entryPath: repo, targetBranch: "main" }
    }, new Date().toISOString());
    harness.manager.setHeavyCommandQueue({
      hasActive: async () => true,
      sessionStatusForWorkspace: async () => "queued",
      cancelWorkspace: async () => undefined
    });

    await harness.manager.discover();
    expect((await harness.manager.getSession(session.id))?.status).toBe("queued");

    await harness.manager.sendInput(session.id, "wait behind heavy task");
    expect(sentInputs).toEqual([]);
    expect(await harness.manager.listQueuedInputs(session.id)).toMatchObject([{ text: "wait behind heavy task", status: "queued" }]);
    harness.db.close();
  });

  it("shows running while keeping input queued for a process-owning heavyweight command", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const sentInputs: string[] = [];
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.capturePane = async () => "› ";
    harness.tmux.sendInput = async (_paneId, text) => { sentInputs.push(text); };
    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0]!;
    await harness.db.upsertSession({
      ...session,
      gitWorkspace: { id: "workspace-a", entryPath: repo, targetBranch: "main" }
    }, new Date().toISOString());
    harness.manager.setHeavyCommandQueue({
      hasActive: async () => true,
      sessionStatusForWorkspace: async () => "running",
      cancelWorkspace: async () => undefined
    });

    await harness.manager.discover();
    expect((await harness.manager.getSession(session.id))?.status).toBe("running");

    await harness.manager.sendInput(session.id, "wait for running heavy task");
    expect(sentInputs).toEqual([]);
    expect(await harness.manager.listQueuedInputs(session.id)).toMatchObject([
      { text: "wait for running heavy task", status: "queued" }
    ]);
    harness.db.close();
  });

  it("reports a managed session's target branch as its canonical repository branch", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0]!;
    await harness.db.upsertSession({
      ...session,
      repo: { ...session.repo, branch: "muxpilot/session-task" },
      gitWorkspace: { id: "workspace-a", entryPath: repo, targetBranch: "main" }
    }, new Date().toISOString());

    expect((await harness.manager.getSession(session.id))?.repo.branch).toBe("main");
    await harness.db.close();
  });

  it("marks an automatic heavyweight resume as active work", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const sentInputs: string[] = [];
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.capturePane = async () => "› ";
    harness.tmux.sendInput = async (_paneId, text) => { sentInputs.push(text); };
    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0]!;

    expect(await harness.manager.resumeHeavyCommand(session.id, "resume queued command")).toBe(true);
    expect(sentInputs).toEqual(["resume queued command "]);
    expect((await harness.manager.getSession(session.id))?.status).toBe("working");
    harness.db.close();
  });

  it("cancels a deferred heavyweight ticket before interrupting and releases queued input", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1" })];
    harness.tmux.capturePane = async () => "› ";
    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0]!;
    await harness.db.upsertSession({ ...session, gitWorkspace: { id: "workspace-a", entryPath: repo, targetBranch: "main" } }, new Date().toISOString());
    const operations: string[] = [];
    const sentInputs: string[] = [];
    let deferred = true;
    harness.manager.setHeavyCommandQueue({
      hasActive: async () => deferred,
      sessionStatusForWorkspace: async () => deferred ? "queued" : null,
      cancelWorkspace: async () => { operations.push("cancel"); deferred = false; }
    });
    harness.tmux.interrupt = async () => { operations.push("interrupt"); };
    harness.tmux.sendInput = async (_paneId, text) => { sentInputs.push(text); };

    await harness.manager.sendInput(session.id, "continue after interrupt");
    expect(sentInputs).toEqual([]);
    expect(await harness.manager.listQueuedInputs(session.id)).toMatchObject([
      { text: "continue after interrupt", status: "queued" }
    ]);

    await harness.manager.act(session.id, { type: "interrupt" });
    expect(operations).toEqual(["cancel", "interrupt"]);
    expect(harness.manager.getSession(session.id)?.status).toBe("waiting");

    await harness.manager.discover();
    expect(sentInputs).toEqual(["continue after interrupt "]);
    expect(await harness.manager.listQueuedInputs(session.id)).toMatchObject([
      { text: "continue after interrupt", status: "sent" }
    ]);
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
      actorSessionId: null,
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
      actorSessionId: null,
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
      actorSessionId: null,
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

    const published: string[] = [];
    const unsubscribe = harness.events.subscribe((event) => {
      if (event.sessionId === session.id) published.push(event.type);
    });
    const result = await harness.manager.sendInput(session.id, "next prompt", "plan");
    unsubscribe();

    expect(sentKeys).toEqual([["BTab"]]);
    expect(sentInputs).toEqual(["next prompt "]);
    expect(result).toMatchObject({
      session: {
        status: "planning",
        inputMode: "plan",
        preview: "next prompt",
        recentUserPrompts: ["next prompt"]
      },
      message: { role: "user", text: "next prompt", payload: { collaborationMode: "plan" } }
    });
    expect(harness.manager.getSession(session.id)).toMatchObject({ status: "planning", inputMode: "plan", preview: "next prompt" });
    expect(published).toEqual(expect.arrayContaining(["message.appended", "status.changed", "session.updated"]));
    harness.db.close();
  });

  it("keeps a muxpilot submission active across stale composer discovery until the turn completes", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const path = join(harness.codexHome, "sessions", "submission-lifecycle.jsonl");
    await writeCodexSession(harness.codexHome, "submission-lifecycle.jsonl", {
      sessionId: "codex-session",
      cwd: repo,
      user: "first prompt",
      assistant: "first answer",
      mtime: new Date("2026-07-07T00:00:00.000Z")
    });
    const pane = testPane({ cwd: repo, paneId: "%1" });
    harness.tmux.listPanes = async () => [pane];
    harness.tmux.capturePane = async () => "› ";
    harness.tmux.sendKeys = async () => undefined;
    harness.tmux.sendInput = async () => undefined;

    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0];
    expect(session).toBeDefined();
    await harness.manager.ingest();

    await harness.manager.sendInput(session.id, "next prompt", "plan");
    await harness.manager.discover();
    expect(harness.manager.getSession(session.id)).toMatchObject({ status: "planning", inputMode: "plan" });

    const taskStartedAt = new Date().toISOString();
    const userEchoAt = new Date(Date.now() + 1).toISOString();
    await appendFile(
      path,
      [
        JSON.stringify({
          timestamp: taskStartedAt,
          type: "event_msg",
          payload: { type: "task_started", collaboration_mode_kind: "default" }
        }),
        JSON.stringify({
          timestamp: userEchoAt,
          type: "event_msg",
          payload: { type: "user_message", message: "next prompt" }
        }),
        ""
      ].join("\n")
    );
    await harness.manager.ingest();
    await harness.manager.discover();
    expect(harness.manager.getSession(session.id)).toMatchObject({ status: "working", inputMode: "default" });

    await appendFile(
      path,
      `${JSON.stringify({ timestamp: new Date(Date.now() + 2).toISOString(), type: "event_msg", payload: { type: "task_complete" } })}\n`
    );
    await harness.manager.ingest();
    await harness.manager.discover();
    expect(harness.manager.getSession(session.id)?.status).toBe("waiting");
    await harness.db.close();
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

  it("returns to waiting when Codex stops with an incomplete proposed plan", async () => {
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
    let capture = "Working (1s)\nEsc to interrupt";
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

    expect(harness.manager.getSession(session.id)?.status).toBe("waiting");
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

  it.each(["828-working-days", "still-running", "waiting-room", "blocked-copy"])(
    "does not infer status from the user-controlled window name %s",
    async (windowName) => {
      const harness = await createHarness();
      const repo = join(harness.dir, "repo");
      await mkdir(repo);
      harness.tmux.listPanes = async () => [
        testPane({ cwd: repo, paneId: "%1", windowName, title: "workspace-id" })
      ];
      harness.tmux.capturePane = async () => [
        "• Booting MCP server: codex_apps (0s • esc to interrupt)",
        "",
        "⚠ MCP startup interrupted. The following servers were not initialized:",
        "  codex_apps, playwright",
        "",
        "› Implement {feature}",
        "",
        "  gpt-5.6-sol medium · Context 100% left",
        ...Array.from({ length: 45 }, () => "")
      ].join("\n");

      await harness.manager.discover();

      const session = harness.manager.listSessions(true)[0];
      expect(session?.status).toBe("waiting");
      harness.db.close();
    }
  );

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
      "› Implement {feature}",
      "",
      "Working (20s • esc to interrupt)",
      ...Array.from({ length: 45 }, () => "")
    ].join("\n");

    await harness.manager.discover();

    const session = harness.manager.listSessions(true)[0];
    expect(session?.status).toBe("working");
    harness.db.close();
  });

  it("prefers the Codex working title over its always-visible composer", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    harness.tmux.listPanes = async () => [
      testPane({ cwd: repo, paneId: "%1", windowName: "828-working-days", title: "⠙ workspace-id" })
    ];
    harness.tmux.capturePane = async () => [
      "• Working (4m 08s • esc to interrupt)",
      "› Implement {feature}",
      "  gpt-5.6-sol medium · Context 81% left",
      ...Array.from({ length: 45 }, () => "")
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

  it("keeps a parent pane bound to its root transcript while subagent transcripts grow", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "shared-repo");
    await mkdir(repo);
    const pane = testPane({ cwd: repo, paneId: "%1", pid: 101 });
    const rootPath = join(harness.codexHome, "sessions", "root.jsonl");
    const subagentPath = join(harness.codexHome, "sessions", "subagent.jsonl");

    await writeCodexSession(harness.codexHome, "root.jsonl", {
      sessionId: "codex-root",
      cwd: repo,
      user: "root prompt",
      assistant: "root answer",
      startedAt: new Date("2026-07-07T00:00:00.000Z"),
      mtime: new Date("2026-07-07T00:01:00.000Z")
    });
    await writeCodexSession(harness.codexHome, "subagent.jsonl", {
      sessionId: "codex-root",
      threadId: "codex-subagent",
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: "codex-root",
            depth: 1,
            agent_path: "/root/review"
          }
        }
      },
      cwd: repo,
      user: "subagent prompt visible in the pane",
      assistant: "subagent answer visible in the pane",
      startedAt: new Date("2026-07-07T00:02:00.000Z"),
      mtime: new Date("2026-07-07T00:03:00.000Z")
    });
    harness.tmux.listPanes = async () => [pane];
    harness.tmux.capturePane = async () => "subagent prompt visible in the pane\nsubagent answer visible in the pane\n› ";
    harness.processLookup.set(pane.pid, {
      pid: 201,
      sessionId: "codex-root",
      startedAtMs: new Date("2026-07-07T00:00:00.000Z").getTime()
    });

    const candidates = await harness.codexStore.listRecent();
    expect(candidates.map((candidate) => candidate.path)).toEqual([rootPath]);

    await harness.manager.discover();
    await harness.manager.catchUpIngest();
    const session = (await harness.manager.listSessions(true))[0];
    expect(session).toMatchObject({
      codexSessionId: "codex-root",
      codexJsonlPath: rootPath,
      transcriptSyncing: false
    });
    expect(harness.manager.listMessages(session!.id, 0).map((message) => message.text)).toEqual([
      "root prompt",
      "root answer"
    ]);

    await appendFile(
      subagentPath,
      `${JSON.stringify({
        timestamp: "2026-07-07T00:04:00.000Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "more subagent progress" }
      })}\n`
    );
    await harness.manager.discover();
    await harness.manager.ingest();

    expect(await harness.manager.getSession(session!.id)).toMatchObject({
      codexSessionId: "codex-root",
      codexJsonlPath: rootPath,
      transcriptSyncing: false
    });
    expect(harness.manager.listMessages(session!.id, 0).map((message) => message.text)).toEqual([
      "root prompt",
      "root answer"
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

  it("rebinds a stale long-running pane when one newer rollout starts growing", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "shared-repo");
    await mkdir(repo);
    const pane = testPane({ cwd: repo, paneId: "%1", pid: 101 });
    const oldStartedAt = new Date("2026-07-07T00:00:00.000Z");

    await writeCodexSession(harness.codexHome, "old.jsonl", {
      sessionId: "codex-old",
      cwd: repo,
      user: "old prompt",
      assistant: "old answer",
      startedAt: oldStartedAt,
      mtime: oldStartedAt
    });
    harness.tmux.listPanes = async () => [pane];
    harness.tmux.capturePane = async () => "› ";
    harness.processLookup.set(pane.pid, { pid: 201, sessionId: "codex-old", startedAtMs: oldStartedAt.getTime() });

    await harness.manager.discover();
    await harness.manager.ingest();
    const session = (await harness.manager.listSessions(true))[0];
    expect(session?.codexSessionId).toBe("codex-old");

    const newPath = join(harness.codexHome, "sessions", "new.jsonl");
    await writeCodexSession(harness.codexHome, "new.jsonl", {
      sessionId: "codex-new",
      cwd: repo,
      user: "new prompt",
      assistant: "new answer",
      startedAt: new Date("2026-07-07T02:00:00.000Z"),
      mtime: new Date("2026-07-07T02:00:00.000Z")
    });

    await harness.manager.discover();
    expect((await harness.manager.getSession(session!.id))?.codexSessionId).toBe("codex-old");

    const replayedStatusEvents: string[] = [];
    const unsubscribe = harness.events.subscribe((event) => {
      if (event.type === "status.changed") replayedStatusEvents.push(String((event.payload as { status?: unknown }).status));
    });
    await appendFile(
      newPath,
      `${JSON.stringify({ timestamp: "2026-07-07T02:00:03.000Z", type: "event_msg", payload: { type: "agent_message", message: "new progress" } })}\n`
    );
    await harness.manager.discover();

    const syncing = await harness.manager.getSession(session!.id);
    expect(syncing).toMatchObject({ codexSessionId: "codex-new", transcriptSyncing: true });
    expect(harness.manager.listMessages(session!.id, 0)).toEqual([]);

    await harness.manager.catchUpIngest();

    const rebound = await harness.manager.getSession(session!.id);
    expect(rebound).toMatchObject({ codexSessionId: "codex-new", transcriptSyncing: false });
    expect(harness.manager.listMessages(session!.id, 0).map((message) => message.text)).toEqual([
      "new prompt",
      "new answer",
      "new progress"
    ]);
    expect(replayedStatusEvents).toEqual([]);
    unsubscribe();
    harness.db.close();
  });

  it("rebinds a resumed pane when visible output belongs to a fresh context", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "shared-repo");
    await mkdir(repo);
    const pane = testPane({ cwd: repo, paneId: "%1", pid: 101 });
    const oldStartedAt = new Date("2026-07-07T00:00:00.000Z");

    await writeCodexSession(harness.codexHome, "old.jsonl", {
      sessionId: "codex-old",
      cwd: repo,
      user: "make a plan",
      assistant: "old proposed plan",
      startedAt: oldStartedAt,
      mtime: oldStartedAt
    });
    harness.tmux.listPanes = async () => [pane];
    harness.tmux.capturePane = async () => "old proposed plan\n› ";
    harness.processLookup.set(pane.pid, { pid: 201, sessionId: "codex-old", startedAtMs: oldStartedAt.getTime() });

    await harness.manager.discover();
    await harness.manager.ingest();
    const session = (await harness.manager.listSessions(true))[0];
    expect(session?.codexSessionId).toBe("codex-old");

    await writeCodexSession(harness.codexHome, "fresh.jsonl", {
      sessionId: "codex-fresh",
      cwd: repo,
      user: "implement in a fresh context",
      assistant: "fresh implementation progress",
      startedAt: new Date("2026-07-07T02:00:00.000Z"),
      mtime: new Date("2026-07-07T02:00:00.000Z")
    });
    harness.tmux.capturePane = async () => "fresh implementation progress\nWorking (1s • esc to interrupt)";

    await harness.manager.discover();
    await harness.manager.catchUpIngest();

    const rebound = await harness.manager.getSession(session!.id);
    expect(rebound).toMatchObject({
      codexSessionId: "codex-fresh",
      status: "working",
      inputMode: "default",
      transcriptSyncing: false
    });
    expect(harness.manager.listMessages(session!.id, 0).map((message) => message.text)).toEqual([
      "implement in a fresh context",
      "fresh implementation progress"
    ]);

    await harness.manager.discover();
    expect(await harness.manager.getSession(session!.id)).toMatchObject({
      codexSessionId: "codex-fresh",
      status: "working",
      transcriptSyncing: false
    });
    harness.db.close();
  });

  it("reconciles a fresh context on the first discovery after restart", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "shared-repo");
    await mkdir(repo);
    const pane = testPane({ cwd: repo, paneId: "%1", pid: 101 });
    const oldStartedAt = new Date("2026-07-07T00:00:00.000Z");

    await writeCodexSession(harness.codexHome, "old.jsonl", {
      sessionId: "codex-old",
      cwd: repo,
      user: "old prompt",
      assistant: "old answer",
      startedAt: oldStartedAt,
      mtime: oldStartedAt
    });
    harness.tmux.listPanes = async () => [pane];
    harness.tmux.capturePane = async () => "old answer\n› ";
    harness.processLookup.set(pane.pid, { pid: 201, sessionId: "codex-old", startedAtMs: oldStartedAt.getTime() });

    await harness.manager.discover();
    await harness.manager.ingest();
    const session = (await harness.manager.listSessions(true))[0];
    expect(session?.codexSessionId).toBe("codex-old");

    await writeCodexSession(harness.codexHome, "fresh.jsonl", {
      sessionId: "codex-fresh",
      cwd: repo,
      user: "fresh prompt",
      assistant: "fresh completed answer",
      startedAt: new Date("2026-07-07T02:00:00.000Z"),
      mtime: new Date("2026-07-07T02:00:00.000Z")
    });
    harness.manager.stop();
    const restartedStore = new CodexSessionStore(harness.codexHome);
    const restartedManager = new SessionManager(
      harness.db,
      harness.tmux,
      restartedStore,
      harness.events,
      60_000,
      60_000,
      { approveOnce: [], approveForPrefix: [], deny: [] },
      ["BTab"],
      new SessionDocumentService(join(harness.dir, "sessions")),
      null,
      harness.processLookup,
      null,
      harness.codexHome,
      null,
      {}
    );
    harness.tmux.capturePane = async () => "fresh completed answer\n› ";

    await restartedManager.discover();
    await restartedManager.catchUpIngest();

    expect(await restartedManager.getSession(session!.id)).toMatchObject({
      codexSessionId: "codex-fresh",
      transcriptSyncing: false
    });
    expect(restartedManager.listMessages(session!.id, 0).map((message) => message.text)).toEqual([
      "fresh prompt",
      "fresh completed answer"
    ]);

    await restartedManager.discover();
    expect(await restartedManager.getSession(session!.id)).toMatchObject({
      codexSessionId: "codex-fresh",
      transcriptSyncing: false
    });
    restartedManager.stop();
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

  it("excludes a non-Codex pane even when its cwd has an unclaimed Codex session file", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "shared-repo");
    await mkdir(repo);

    await writeCodexSession(harness.codexHome, "session.jsonl", {
      sessionId: "codex-session",
      cwd: repo,
      user: "prompt",
      assistant: "answer",
      mtime: new Date("2026-07-07T00:00:00.000Z")
    });

    harness.tmux.listPanes = async () => [
      testPane({
        cwd: repo,
        paneId: "%1",
        currentCommand: "nvim",
        windowName: "nvim",
        title: "RyansTower"
      })
    ];

    await harness.manager.discover();

    expect(harness.manager.listSessions(true)).toEqual([]);
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

  it("drains a multi-batch live transcript without revisiting caught-up missing sessions", async () => {
    const harness = await createHarness();
    const liveRepo = join(harness.dir, "live-repo");
    const missingRepo = join(harness.dir, "missing-repo");
    await mkdir(liveRepo);
    await mkdir(missingRepo);
    const livePath = join(harness.codexHome, "sessions", "live.jsonl");
    await writeCodexSession(harness.codexHome, "live.jsonl", {
      sessionId: "codex-live",
      cwd: liveRepo,
      user: "live prompt",
      assistant: "starting",
      mtime: new Date("2026-07-07T00:01:00.000Z")
    });
    await writeCodexSession(harness.codexHome, "missing.jsonl", {
      sessionId: "codex-missing",
      cwd: missingRepo,
      user: "old prompt",
      assistant: "old answer",
      mtime: new Date("2026-07-07T00:00:00.000Z")
    });
    harness.tmux.listPanes = async () => [
      testPane({ cwd: liveRepo, paneId: "%1" }),
      testPane({ cwd: missingRepo, paneId: "%2" })
    ];
    await harness.manager.discover();
    await harness.manager.catchUpIngest();
    const sessions = await harness.manager.listSessions(true);
    const liveSession = sessions.find((session) => session.tmux.cwd === liveRepo)!;
    const missingSession = sessions.find((session) => session.tmux.cwd === missingRepo)!;
    await harness.db.setSessionStatus(missingSession.id, "missing", "2026-07-07T00:02:00.000Z");
    const parserOffsetWrites: string[] = [];
    const setParserOffset = harness.db.setParserOffset.bind(harness.db);
    harness.db.setParserOffset = async (source, offset, parserVersion, updatedAt) => {
      parserOffsetWrites.push(source);
      await setParserOffset(source, offset, parserVersion, updatedAt);
    };

    await appendFile(
      livePath,
      [
        JSON.stringify({
          timestamp: "2026-07-07T00:03:00.000Z",
          type: "response_item",
          payload: { type: "function_call_output", output: "x".repeat(1024 * 1024 + 256) }
        }),
        JSON.stringify({
          timestamp: "2026-07-07T00:03:01.000Z",
          type: "response_item",
          payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "live final answer" }] }
        }),
        ""
      ].join("\n")
    );

    await harness.manager.ingest();

    expect((await harness.manager.listMessages(liveSession.id, 0)).map((message) => message.text)).toContain("live final answer");
    expect(parserOffsetWrites).toContain(`${liveSession.id}:${liveSession.codexJsonlPath}`);
    expect(parserOffsetWrites).not.toContain(`${missingSession.id}:${missingSession.codexJsonlPath}`);
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

    expect((await harness.manager.getSession(session.id))?.tmux.windowName).toBe("My-Session!");
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
      "Session name must be a 2-32 character Git-style name"
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

  it("forks a live busy session into a separate Codex pane and preserves its origin", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    await writeCodexSession(harness.codexHome, "fork-source.jsonl", {
      sessionId: "codex-fork-source",
      cwd: repo,
      user: "explore the first route",
      assistant: "working on it",
      mtime: new Date("2026-08-07T12:00:00.000Z")
    });
    const sourcePane = testPane({ cwd: repo, paneId: "%1", windowId: "@1", windowName: "route-one", pid: 101 });
    let panes = [sourcePane];
    harness.tmux.listPanes = async () => panes;
    await harness.manager.discover();
    await harness.manager.ingest();
    const source = harness.manager.listSessions(true)[0]!;
    await harness.db.upsertSession({
      ...source,
      pinned: true,
      inputMode: "plan",
      models: {
        default: { model: "gpt-5.6-sol", reasoningEffort: "high" },
        plan: { model: "gpt-5.6-sol", reasoningEffort: "medium" }
      },
      fastMode: true
    }, "2026-08-07T12:00:00.500Z");
    await harness.db.setSessionStatus(source.id, "working", "2026-08-07T12:00:01.000Z");

    const forkCalls: Array<{ cwd: string; name: string; codexSessionId: string }> = [];
    harness.tmux.createCodexForkWindowInMuxpilotSession = async (cwd, name, codexSessionId) => {
      forkCalls.push({ cwd, name, codexSessionId });
      const pane = testPane({ cwd, paneId: "%2", windowId: "@2", windowName: name, title: name, pid: 202 });
      panes = [...panes, pane];
      return { pane, ready: pendingReadiness() };
    };

    const fork = await harness.manager.forkSession(source.id, "route-two");

    expect(forkCalls).toEqual([{ cwd: repo, name: "route-two", codexSessionId: "codex-fork-source" }]);
    expect(fork.id).not.toBe(source.id);
    expect(fork.initializing).toBe(true);
    expect(fork.forkedFrom).toEqual({
      codexSessionId: "codex-fork-source",
      sessionId: source.id,
      sessionName: "route-one"
    });
    expect(fork).toMatchObject({
      pinned: false,
      inputMode: "plan",
      models: {
        default: { model: "gpt-5.6-sol", reasoningEffort: "high" },
        plan: { model: "gpt-5.6-sol", reasoningEffort: "medium" }
      },
      fastMode: true
    });
    expect(harness.manager.listMessages(fork.id, 0)).toEqual([]);
    expect(harness.manager.getSession(source.id)?.status).toBe("working");
    await harness.manager.discover();
    expect(harness.manager.getSession(fork.id)?.forkedFrom).toMatchObject({
      codexSessionId: "codex-fork-source",
      sessionId: source.id
    });
    expect(harness.manager.listMessages(source.id, 0).map((message) => message.text)).toEqual([
      "explore the first route",
      "working on it"
    ]);
    harness.db.close();
  });

  it("rejects forking a session before Codex assigns its conversation id", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const pane = testPane({ cwd: repo, paneId: "%1", windowId: "@1", windowName: "starting" });
    harness.tmux.createCodexWindowInMuxpilotSession = async () => ({ pane, ready: pendingReadiness() });
    const source = await harness.manager.createSessionInDirectory(repo, "starting");

    await expect(harness.manager.forkSession(source.id, "starting-fork")).rejects.toThrow(
      "Session does not have a Codex session id to fork"
    );
    harness.db.close();
  });

  it("forks a managed Git session into a distinct workspace on the same target branch", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    await writeCodexSession(harness.codexHome, "git-fork-source.jsonl", {
      sessionId: "codex-git-fork-source",
      cwd: repo,
      user: "change the implementation",
      assistant: "first route",
      mtime: new Date("2026-08-07T13:00:00.000Z")
    });
    harness.tmux.listPanes = async () => [testPane({ cwd: repo, paneId: "%1", windowId: "@1", windowName: "git-route" })];
    await harness.manager.discover();
    const source = harness.manager.listSessions(true)[0]!;
    await harness.db.upsertSession({
      ...source,
      gitWorkspace: {
        workflowVersion: 1,
        id: "workspace-source",
        state: "worktree",
        entryPath: repo,
        repoRoot: repo,
        targetBranch: "main",
        targetSha: "abc123",
        sessionBranch: "muxpilot/source/task",
        worktreePath: join(repo, "source-worktree"),
        lastError: null,
        updatedAt: "2026-08-07T13:00:00.000Z",
        dependencyLinks: []
      }
    }, "2026-08-07T13:00:00.000Z");

    const provisionCalls: Array<{ sessionName: string; entryPath: string; targetBranch: string }> = [];
    const workspace = {
      id: "workspace-fork",
      sessionId: null,
      sessionName: "git-route-fork",
      commonGitDir: join(repo, ".git"),
      controlPath: join(harness.dir, "control", "workspace-fork"),
      implementationRoot: join(harness.dir, "worktrees", "workspace-fork"),
      helperToken: "token",
      summary: {
        workflowVersion: 1 as const,
        id: "workspace-fork",
        state: "idle" as const,
        entryPath: repo,
        repoRoot: repo,
        targetBranch: "main",
        targetSha: "abc123",
        sessionBranch: null,
        worktreePath: null,
        lastError: null,
        updatedAt: "2026-08-07T13:00:01.000Z",
        dependencyLinks: []
      },
      createdAt: "2026-08-07T13:00:01.000Z",
      updatedAt: "2026-08-07T13:00:01.000Z"
    };
    const binds: Array<{ workspaceId: string; sessionId: string }> = [];
    const fakeGitWorkspaces = {
      provision: async (request: { sessionName: string; entryPath: string; targetBranch: string }) => {
        provisionCalls.push(request);
        return workspace;
      },
      ensureControlPath: async () => workspace.controlPath,
      bind: async (workspaceId: string, sessionId: string) => {
        binds.push({ workspaceId, sessionId });
        return { ...workspace, sessionId };
      }
    } as unknown as GitWorkspaceManager;
    (harness.manager as unknown as { gitWorkspaces: GitWorkspaceManager }).gitWorkspaces = fakeGitWorkspaces;
    harness.tmux.createCodexForkWindowInMuxpilotSession = async (cwd, name, codexSessionId, options) => {
      expect(cwd).toBe(workspace.controlPath);
      expect(name).toBe("git-route-fork");
      expect(codexSessionId).toBe("codex-git-fork-source");
      expect(options.environment).toMatchObject({ MUXPILOT_GIT_WORKSPACE_ID: "workspace-fork", MUXPILOT_GIT_TARGET_BRANCH: "main" });
      return {
        pane: testPane({ cwd, paneId: "%2", windowId: "@2", windowName: name, title: name }),
        ready: pendingReadiness()
      };
    };

    const fork = await harness.manager.forkSession(source.id, "git-route-fork");

    expect(provisionCalls).toEqual([{ sessionName: "git-route-fork", entryPath: repo, targetBranch: "main" }]);
    expect(binds).toEqual([{ workspaceId: "workspace-fork", sessionId: fork.id }]);
    expect(fork.gitWorkspace).toMatchObject({ id: "workspace-fork", targetBranch: "main", state: "idle" });
    expect(fork.gitWorkspace?.id).not.toBe("workspace-source");
    harness.db.close();
  });

  it("creates a new Codex tmux window in the shared muxpilot session from an explicit directory", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const otherRepo = join(harness.dir, "other-repo");
    await mkdir(otherRepo);
    let panes = [testPane({ cwd: otherRepo, paneId: "%1", windowId: "@1" })];
    const createCalls: Array<{ cwd: string; name: string; options: CodexLaunchOptions }> = [];
    const bindCapability = vi.fn(async () => undefined);
    harness.manager.setOrchestrationProvider({
      prepareLaunch: async () => ({
        capabilityId: "0123456789abcdef01234567",
        server: { name: "muxpilot_sessions", command: "/usr/bin/node", args: ["/tmp/mcp.mjs"] }
      }),
      bindCapability
    });
    harness.tmux.listPanes = async () => panes;
    harness.tmux.createCodexWindowInMuxpilotSession = async (cwd, name, options) => {
      createCalls.push({ cwd, name, options });
      const pane = testPane({ cwd, paneId: "%2", windowId: "@2", windowName: name, title: name, pid: 456, sessionName: "muxpilot" });
      panes = [...panes, pane];
      return { pane, ready: pendingReadiness() };
    };
    await harness.manager.discover();

    const created = await harness.manager.createSessionInDirectory(repo, "new-work");

    expect(createCalls).toEqual([{ cwd: repo, name: "new-work", options: expect.objectContaining({
      resourceScopeName: "muxpilot-session-0123456789abcdef01234567.scope"
    }) }]);
    expect(createCalls[0]?.options.developerInstructions).toContain("Use built-in Codex subagents for routine bounded delegation");
    expect(createCalls[0]?.options.developerInstructions).toContain("especially standard code-review passes");
    expect(createCalls[0]?.options.developerInstructions).toContain("Do not create a nested muxpilot session merely to perform a review in parallel");
    expect(createCalls[0]?.options.developerInstructions).toContain("if built-in subagents are unavailable, keep the review in the current session");
    expect(createCalls[0]?.options.developerInstructions).toContain("only when the operator explicitly requests a nested muxpilot session or the work is durable");
    expect(createCalls[0]?.options.developerInstructions).toContain("Use $muxpilot-documents");
    expect(createCalls[0]?.options.developerInstructions).toContain("never put INDEX.md or another muxpilot document in the session cwd");
    expect(createCalls[0]?.options.developerInstructions).toContain("cross-session document writes are forbidden");
    expect(createCalls[0]?.options.developerInstructions).toContain("agent-created muxpilot child sessions keep notes in their own $MUXPILOT_DOCUMENTS_DIR");
    expect(createCalls[0]?.options.developerInstructions).toContain("built-in Codex subagents share this session's scope and must not edit documents");
    expect(createCalls[0]?.options.developerInstructions).toContain("only the main parent agent verifies and updates canonical documents");
    expect(createCalls[0]?.options.developerInstructions).toContain("As an explicit scoped exception to Plan mode's general non-mutation rule");
    expect(createCalls[0]?.options.developerInstructions).toContain("Do not persist the current formal <proposed_plan> before operator approval");
    expect(createCalls[0]?.options.developerInstructions).toContain("A muxpilot BTW document notice inside <environment_context> is internal additive context");
    expect(createCalls[0]?.options.environment?.MUXPILOT_DOCUMENTS_DIR).toMatch(/sessions\/documents-[^/]+\/documents$/);
    expect(createCalls[0]?.options.writableRoots).toContain(createCalls[0]?.options.environment?.MUXPILOT_DOCUMENTS_DIR);
    expect(bindCapability).toHaveBeenCalledWith("0123456789abcdef01234567", created.id);
    expect(created).toMatchObject({
      orchestrationAvailable: true,
      resourceScope: "muxpilot-session-0123456789abcdef01234567.scope"
    });
    expect(created.documentScopeId).toMatch(/^documents-/);
    expect(created.tmux.sessionName).toBe("muxpilot");
    expect(created.tmux.paneId).toBe("%2");
    expect(created.tmux.windowName).toBe("new-work");
    expect(created.initializing).toBe(true);
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
      return { pane, ready: pendingReadiness() };
    };

    const created = await harness.manager.createSessionInDirectory(repo, "My Session!");

    expect(createCalls).toEqual([{ cwd: repo, name: "My-Session!" }]);
    expect(created.tmux.windowName).toBe("My-Session!");
    harness.db.close();
  });

  it("returns the allocated session before readiness and clears initialization afterward", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    let resolveReady: (() => void) | null = null;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const pane = testPane({
      cwd: repo,
      paneId: "%2",
      windowId: "@2",
      windowName: "new-work",
      title: "new-work",
      pid: 456,
      sessionName: "muxpilot",
      currentCommand: "codex"
    });
    harness.tmux.listPanes = async () => [pane];
    harness.tmux.createCodexWindowInMuxpilotSession = async () => ({ pane, ready });
    await harness.manager.discoverNow();
    expect((await harness.manager.getSession(tmuxPaneSessionId(pane)))?.initializing).toBe(false);

    const created = await harness.manager.createSessionInDirectory(repo, "new-work");

    expect(created.initializing).toBe(true);
    expect((await harness.manager.getSession(created.id))?.initializing).toBe(true);
    harness.tmux.listPanes = async () => [];
    await harness.manager.discoverNow();
    expect((await harness.manager.getSession(created.id))?.status).toBe("unknown");
    harness.tmux.listPanes = async () => [pane];
    resolveReady?.();
    await expect.poll(async () => (await harness.manager.getSession(created.id))?.initializing).toBe(false);
    harness.db.close();
  });

  it("queues input until Codex startup readiness completes", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    let resolveReady: (() => void) | null = null;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const pane = testPane({
      cwd: repo,
      paneId: "%2",
      windowId: "@2",
      windowName: "new-work",
      title: "new-work",
      pid: 456,
      sessionName: "muxpilot",
      currentCommand: "codex"
    });
    const sentInputs: string[] = [];
    harness.tmux.listPanes = async () => [pane];
    harness.tmux.capturePane = async () => "› ";
    harness.tmux.sendInput = async (_paneId, text) => {
      sentInputs.push(text);
    };
    harness.tmux.createCodexWindowInMuxpilotSession = async () => ({ pane, ready });

    const created = await harness.manager.createSessionInDirectory(repo, "new-work");
    const result = await harness.manager.sendInput(created.id, "startup prompt");
    await harness.manager.discoverNow();

    expect("queuedInput" in result).toBe(true);
    expect(sentInputs).toEqual([]);
    expect(await harness.manager.listQueuedInputs(created.id)).toMatchObject([{ text: "startup prompt", status: "queued" }]);

    resolveReady?.();
    await expect.poll(() => sentInputs).toEqual(["startup prompt "]);
    expect((await harness.manager.getSession(created.id))?.initializing).toBe(false);
    expect(await harness.manager.listQueuedInputs(created.id)).toMatchObject([{ status: "sent" }]);
    harness.db.close();
  });

  it("keeps an exact initializing pane discoverable before process metadata settles", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    let resolveReady: (() => void) | null = null;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const pane = testPane({
      cwd: repo,
      paneId: "%2",
      windowId: "@2",
      windowName: "new-work",
      title: "repo",
      pid: 456,
      sessionName: "muxpilot",
      currentCommand: "bash"
    });
    harness.tmux.listPanes = async () => [pane];
    harness.tmux.capturePane = async () => [
      ">_ OpenAI Codex (v0.147.0)",
      "› Summarize recent commits",
      "gpt-5.6-sol medium · Context 100% left"
    ].join("\n");
    harness.tmux.createCodexWindowInMuxpilotSession = async () => ({ pane, ready });

    const created = await harness.manager.createSessionInDirectory(repo, "new-work");
    await harness.manager.discoverNow();

    expect(await harness.manager.getSession(created.id)).toMatchObject({
      status: "waiting",
      initializing: true
    });

    resolveReady?.();
    await expect.poll(async () => (await harness.manager.getSession(created.id))?.initializing).toBe(false);
    await harness.manager.discoverNow();
    expect((await harness.manager.getSession(created.id))?.status).toBe("waiting");
    harness.db.close();
  });

  it("does not let a pre-creation discovery snapshot mark a ready session missing", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    let resolveReady: (() => void) | null = null;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    let releaseStaleSnapshot: (() => void) | null = null;
    const staleSnapshot = new Promise<void>((resolve) => {
      releaseStaleSnapshot = resolve;
    });
    let staleSnapshotStarted: (() => void) | null = null;
    const snapshotStarted = new Promise<void>((resolve) => {
      staleSnapshotStarted = resolve;
    });
    const pane = testPane({
      cwd: repo,
      paneId: "%2",
      windowId: "@2",
      windowName: "new-work",
      title: "repo",
      pid: 456,
      sessionName: "muxpilot",
      currentCommand: "bash"
    });
    harness.tmux.createCodexWindowInMuxpilotSession = async () => ({ pane, ready });

    const created = await harness.manager.createSessionInDirectory(repo, "new-work");
    harness.tmux.listPanes = async () => {
      staleSnapshotStarted?.();
      await staleSnapshot;
      return [];
    };
    const discover = harness.manager.discoverNow();
    await snapshotStarted;

    resolveReady?.();
    await expect.poll(async () => (await harness.manager.getSession(created.id))?.initializing).toBe(false);
    expect((await harness.manager.getSession(created.id))?.status).toBe("waiting");

    releaseStaleSnapshot?.();
    await discover;
    expect((await harness.manager.getSession(created.id))?.status).toBe("waiting");

    await harness.manager.discoverNow();
    expect((await harness.manager.getSession(created.id))?.status).toBe("missing");
    harness.db.close();
  });

  it("persists a startup failure instead of allowing the session to become missing", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    let rejectReady: ((error: Error) => void) | null = null;
    const ready = new Promise<void>((_resolve, reject) => {
      rejectReady = reject;
    });
    const pane = testPane({
      cwd: repo,
      paneId: "%2",
      windowId: "@2",
      windowName: "failed-work",
      title: "Codex startup failed",
      pid: 456,
      sessionName: "muxpilot",
      currentCommand: "sleep"
    });
    harness.tmux.listPanes = async () => [pane];
    harness.tmux.capturePane = async () => [
      "Codex couldn't start because its local data is locked.",
      "MUXPILOT_CODEX_STARTUP_FAILED code=1 attempts=3"
    ].join("\n");
    harness.tmux.createCodexWindowInMuxpilotSession = async () => ({ pane, ready });

    const created = await harness.manager.createSessionInDirectory(repo, "failed-work");
    rejectReady?.(new Error("Codex couldn't start because its local data is locked."));

    await expect.poll(async () => (await harness.manager.getSession(created.id))?.status).toBe("startup_failed");
    const failed = await harness.manager.getSession(created.id);
    expect(failed).toMatchObject({
      initializing: false,
      startupError: "Codex couldn't start because its local data is locked."
    });

    await harness.manager.discoverNow();
    expect(await harness.manager.getSession(created.id)).toMatchObject({
      status: "startup_failed",
      startupError: "Codex couldn't start because its local data is locked."
    });
    harness.db.close();
  });

  it("rejects created session names that cannot normalize to a valid slug", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);

    await expect(harness.manager.createSessionInDirectory(repo, "!")).rejects.toThrow(
      "Session name must be a 2-32 character Git-style name"
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
      return { pane, ready: pendingReadiness() };
    };

    const created = await harness.manager.createSessionInDirectory(repo, "new-work");

    expect(createCalls).toEqual([{ cwd: repo, name: "new-work" }]);
    expect(created.tmux.sessionName).toBe("muxpilot");
    expect(created.tmux.paneId).toBe("%1");
    expect(created.tmux.windowName).toBe("new-work");
    harness.db.close();
  });

  it("keeps recycled tmux counters distinct across server generations", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const firstPane = testPane({
      cwd: repo,
      paneId: "%1",
      windowId: "@1",
      pid: 101,
      serverPid: 1001,
      sessionCreatedAt: 1_700_000_001
    });
    let panes = [firstPane];
    harness.tmux.listPanes = async () => panes;

    await harness.manager.discover();
    const firstSessionId = tmuxPaneSessionId(firstPane);
    await harness.db.upsertGitWorkspace({
      id: "workspace-first-generation",
      sessionId: firstSessionId,
      commonGitDir: join(repo, ".git"),
      helperToken: "",
      summary: { id: "workspace-first-generation", entryPath: repo, targetBranch: "main" },
      createdAt: "2026-07-13T00:00:00.000Z",
      updatedAt: "2026-07-13T00:00:00.000Z"
    }, "2026-07-13T00:00:00.000Z");

    panes = [];
    await harness.manager.discover();
    const secondPane = testPane({
      cwd: repo,
      paneId: "%1",
      windowId: "@1",
      pid: 102,
      serverPid: 1002,
      sessionCreatedAt: 1_700_000_002
    });
    panes = [secondPane];
    await harness.manager.discover();
    const secondSessionId = tmuxPaneSessionId(secondPane);
    await harness.db.upsertGitWorkspace({
      id: "workspace-second-generation",
      sessionId: secondSessionId,
      commonGitDir: join(repo, ".git"),
      helperToken: "",
      summary: { id: "workspace-second-generation", entryPath: repo, targetBranch: "main" },
      createdAt: "2026-07-13T00:00:01.000Z",
      updatedAt: "2026-07-13T00:00:01.000Z"
    }, "2026-07-13T00:00:01.000Z");

    expect(secondSessionId).not.toBe(firstSessionId);
    expect(await harness.db.getGitWorkspaceBySession(firstSessionId)).toMatchObject({ id: "workspace-first-generation" });
    expect(await harness.db.getGitWorkspaceBySession(secondSessionId)).toMatchObject({ id: "workspace-second-generation" });
    harness.db.close();
  });

  it("rekeys a live legacy session when generation metadata first appears", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    await writeCodexSession(harness.codexHome, "legacy.jsonl", {
      sessionId: "codex-legacy",
      cwd: repo,
      user: "preserve legacy history",
      assistant: "legacy answer",
      mtime: new Date("2026-07-13T00:00:00.000Z")
    });
    const legacyPane = testPane({ cwd: repo, paneId: "%1", windowId: "@1", pid: 101 });
    let panes = [legacyPane];
    harness.tmux.listPanes = async () => panes;

    await harness.manager.discover();
    await harness.manager.ingest();
    const legacyId = legacyTmuxPaneSessionId(legacyPane);
    const transcriptPath = join(harness.codexHome, "sessions", "legacy.jsonl");
    const legacyParserOffset = await harness.db.getParserOffset(`${legacyId}:${transcriptPath}`);
    await harness.db.upsertGitWorkspace({
      id: "workspace-legacy",
      sessionId: legacyId,
      commonGitDir: join(repo, ".git"),
      helperToken: "",
      summary: { id: "workspace-legacy", entryPath: repo, targetBranch: "main" },
      createdAt: "2026-07-13T00:00:00.000Z",
      updatedAt: "2026-07-13T00:00:00.000Z"
    }, "2026-07-13T00:00:00.000Z");
    await harness.db.setNotificationRule("device-legacy", "session", legacyId, "done_task", true, "2026-07-13T00:00:00.000Z");

    const generationPane = { ...legacyPane, serverPid: 1001, sessionCreatedAt: 1_700_000_001 };
    panes = [generationPane];
    await harness.manager.discover();
    const generationId = tmuxPaneSessionId(generationPane);

    expect(generationId).not.toBe(legacyId);
    expect(await harness.manager.getSession(legacyId)).toBeNull();
    expect((await harness.manager.listMessages(generationId, 0)).map((message) => message.text)).toEqual([
      "preserve legacy history",
      "legacy answer"
    ]);
    expect(await harness.db.getGitWorkspaceBySession(generationId)).toMatchObject({ id: "workspace-legacy" });
    expect((await harness.db.getNotificationSettings("device-legacy")).sessionRules[generationId]).toEqual(["done_task"]);
    expect(await harness.db.getParserOffset(`${legacyId}:${transcriptPath}`)).toBe(0);
    expect(await harness.db.getParserOffset(`${generationId}:${transcriptPath}`)).toBe(legacyParserOffset);
    harness.db.close();
  });

  it("offers every previously open session after an unclean startup loses its panes", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    await writeCodexSession(harness.codexHome, "recovery.jsonl", {
      sessionId: "codex-recovery",
      cwd: repo,
      user: "recover this work",
      assistant: "working on it",
      mtime: new Date("2026-08-17T20:00:00.000Z")
    });
    let panes = [testPane({ cwd: repo, paneId: "%1", windowId: "@1", windowName: "recovery-work" })];
    harness.tmux.listPanes = async () => panes;

    await harness.manager.prepareStartupRecovery();
    await harness.manager.discoverNow();
    const original = (await harness.manager.listSessions(true))[0]!;
    expect(original.codexSessionId).toBe("codex-recovery");

    await harness.manager.prepareStartupRecovery();
    panes = [];
    await harness.manager.discoverNow();
    await harness.manager.finishStartupRecovery();

    expect(await harness.manager.getSessionRecoveryIncident()).toMatchObject({
      sessions: [{
        sessionId: original.id,
        codexSessionId: "codex-recovery",
        sessionName: "recovery-work",
        previousStatus: original.status,
        status: "missing"
      }]
    });
    harness.db.close();
  });

  it("does not offer recovery after a clean shutdown", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    await writeCodexSession(harness.codexHome, "clean.jsonl", {
      sessionId: "codex-clean",
      cwd: repo,
      user: "clean shutdown",
      assistant: "ready",
      mtime: new Date("2026-08-17T20:00:00.000Z")
    });
    let panes = [testPane({ cwd: repo, paneId: "%1", windowId: "@1", windowName: "clean-work" })];
    harness.tmux.listPanes = async () => panes;

    await harness.manager.prepareStartupRecovery();
    await harness.manager.discoverNow();
    await harness.manager.markCleanShutdown();
    await harness.manager.prepareStartupRecovery();
    panes = [];
    await harness.manager.discoverNow();
    await harness.manager.finishStartupRecovery();

    expect(await harness.manager.getSessionRecoveryIncident()).toBeNull();
    harness.db.close();
  });

  it("restores an interrupted recovery batch without navigating session by session", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    await writeCodexSession(harness.codexHome, "batch-recovery.jsonl", {
      sessionId: "codex-batch-recovery",
      cwd: repo,
      user: "restore this batch",
      assistant: "ready",
      mtime: new Date("2026-08-17T20:00:00.000Z")
    });
    let panes = [testPane({ cwd: repo, paneId: "%1", windowId: "@1", windowName: "batch-work" })];
    harness.tmux.listPanes = async () => panes;
    await harness.manager.prepareStartupRecovery();
    await harness.manager.discoverNow();
    const original = (await harness.manager.listSessions(true))[0]!;
    await harness.manager.prepareStartupRecovery();
    panes = [];
    await harness.manager.discoverNow();
    await harness.manager.finishStartupRecovery();
    const incident = (await harness.manager.getSessionRecoveryIncident())!;
    let resumeCalls = 0;
    harness.tmux.createCodexResumeWindowInMuxpilotSession = async (cwd, name, codexSessionId) => {
      resumeCalls += 1;
      const pane = testPane({ cwd, paneId: "%2", windowId: "@2", windowName: name, pid: 456, sessionName: "muxpilot" });
      harness.processLookup.set(pane.pid, { pid: 457, sessionId: codexSessionId, startedAtMs: null });
      panes = [pane];
      return { pane, ready: pendingReadiness() };
    };

    const response = await harness.manager.restoreSessionRecovery(incident.id, [original.id]);

    expect(resumeCalls).toBe(1);
    expect(response.results).toMatchObject([{ sourceSessionId: original.id, status: "restored", error: null }]);
    expect(response.incident).toBeNull();
    expect(await harness.manager.getSessionRecoveryIncident()).toBeNull();
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
      harness.processLookup.set(pane.pid, { pid: 457, sessionId: codexSessionId, startedAtMs: null });
      panes = [pane];
      return { pane, ready: pendingReadiness() };
    };

    const [restored, duplicate] = await Promise.all([
      harness.manager.restoreSession(original!.id),
      harness.manager.restoreSession(original!.id)
    ]);

    expect(resumeCalls).toEqual([{ cwd: repo, name: "old-work", codexSessionId: "codex-restorable" }]);
    expect(restored.restored).toBe(true);
    expect(duplicate).toMatchObject({ restored: false, session: { id: restored.session.id } });
    expect(restored.session.tmux.paneId).toBe("%2");
    expect(restored.session.codexSessionId).toBe("codex-restorable");
    expect(restored.session.status).toBe("unknown");
    expect(restored.session.initializing).toBe(true);
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

  it("does not crash or lose transcript progress when restore races an ingest tick", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    const sourcePath = join(harness.codexHome, "sessions", "restore-race.jsonl");
    await writeCodexSession(harness.codexHome, "restore-race.jsonl", {
      sessionId: "codex-restore-race",
      cwd: repo,
      user: "restore race prompt",
      assistant: "restore race answer",
      mtime: new Date("2026-07-07T00:00:00.000Z")
    });
    let panes: TmuxPane[] = [testPane({ cwd: repo, paneId: "%1", windowId: "@1", windowName: "restore-race" })];
    harness.tmux.listPanes = async () => panes;

    await harness.manager.discover();
    await harness.manager.ingest();
    const original = (await harness.manager.listSessions(true))[0];
    expect(original).toBeDefined();

    panes = [];
    await harness.manager.discover();
    await appendFile(
      sourcePath,
      [
        JSON.stringify({
          timestamp: "2026-07-07T00:00:03.000Z",
          type: "event_msg",
          payload: { type: "agent_message", message: "arrived during restore" }
        }),
        ""
      ].join("\n")
    );

    const appendMessage = harness.db.appendMessage.bind(harness.db);
    let releaseAppend: (() => void) | null = null;
    let markAppendStarted: (() => void) | null = null;
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    const appendRelease = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    harness.db.appendMessage = async (message) => {
      if (message.sessionId === original!.id && message.text === "arrived during restore") {
        markAppendStarted?.();
        await appendRelease;
      }
      return await appendMessage(message);
    };

    const ingest = harness.manager.ingest();
    await appendStarted;
    harness.tmux.createCodexResumeWindowInMuxpilotSession = async (cwd) => {
      const pane = testPane({ cwd, paneId: "%2", windowId: "@2", windowName: "restore-race", pid: 456, sessionName: "muxpilot" });
      panes = [pane];
      return { pane, ready: pendingReadiness() };
    };

    const restored = await harness.manager.restoreSession(original!.id);
    releaseAppend?.();
    await expect(ingest).resolves.toBeUndefined();
    await harness.manager.ingest();

    expect(harness.manager.listMessages(restored.session.id, 0).map((message) => message.text)).toEqual([
      "restore race prompt",
      "restore race answer",
      "arrived during restore"
    ]);
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

    await harness.manager.dismissSessionDirectory(activeRepo);
    expect((await harness.manager.listSessionDirectories()).map((suggestion) => suggestion.path)).not.toContain(activeRepo);

    await harness.manager.dismissSessionDirectory(recentRepo);
    expect((await harness.manager.listSessionDirectories()).map((suggestion) => suggestion.path)).not.toContain(recentRepo);

    await harness.db.upsertTouchedRepository(
      {
        path: recentRepo,
        label: "recent",
        repoRoot: recentRepo,
        branch: null,
        lastActivityAt: "9999-07-08T02:00:00.000Z"
      },
      "9999-07-08T02:00:00.000Z"
    );
    expect((await harness.manager.listSessionDirectories()).map((suggestion) => suggestion.path)).toContain(recentRepo);
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

describe("agent-managed session hierarchy", () => {
  it("caps a root tree at two live descendants and frees the slot on release", async () => {
    const harness = await createHarness();
    const root = agentHierarchySession("agent-root");
    const first = agentHierarchySession("agent-first");
    const second = agentHierarchySession("agent-second");
    const third = agentHierarchySession("agent-third");
    for (const session of [root, first, second, third]) {
      await harness.db.upsertSession(session, "2026-08-25T00:00:00.000Z");
    }

    await harness.manager.agentClaim(root.id, first.id);
    await harness.manager.agentClaim(root.id, second.id);
    await expect(harness.manager.agentClaim(root.id, third.id)).rejects.toThrow("limit reached");

    await harness.manager.agentRelease(root.id, first.id);
    const claimedThird = await harness.manager.agentClaim(root.id, third.id);

    expect(claimedThird.agentOwnership).toMatchObject({
      parentSessionId: root.id,
      rootSessionId: root.id,
      workTokenBudget: 1_000_000
    });
    expect((await harness.manager.getSession(first.id))?.agentOwnership).toBeNull();
    await harness.db.close();
  });

  it("finishes descendants idempotently and retains completed history beneath a live root", async () => {
    const harness = await createHarness();
    const root = agentHierarchySession("finish-root");
    const child = agentHierarchySession("finish-child");
    await harness.db.upsertSession(root, "2026-08-25T00:00:00.000Z");
    await harness.db.upsertSession(child, "2026-08-25T00:00:00.000Z");
    const claimed = await harness.manager.agentClaim(root.id, child.id);
    await harness.db.setSessionAgentOwnership(child.id, {
      ...claimed.agentOwnership!,
      contextPausedAt: "2026-08-25T00:01:00.000Z"
    }, "2026-08-25T00:01:00.000Z");

    await Promise.all([
      harness.manager.agentFinish(root.id, child.id),
      harness.manager.agentFinish(root.id, child.id)
    ]);

    const completed = await harness.manager.getSession(child.id);
    expect(completed).toMatchObject({
      status: "missing",
      agentOwnership: {
        parentSessionId: root.id,
        completedAt: expect.any(String),
        contextPausedAt: "2026-08-25T00:01:00.000Z"
      }
    });
    const visible = await harness.manager.listSessions(false, false);
    expect(visible.map((session) => session.id)).toEqual(expect.arrayContaining([root.id, child.id]));
    expect(visible.find((session) => session.id === root.id)?.agentSummary).toMatchObject({
      liveDescendantCount: 0,
      totalDescendantCount: 1,
      worstStatus: null,
      worstStatusSessionId: null
    });
    await harness.db.close();
  });

  it("interrupts an owned session when active context reaches 85 percent", async () => {
    const harness = await createHarness();
    const transcript = join(harness.codexHome, "sessions", "agent-context.jsonl");
    const parent = agentHierarchySession("context-parent");
    const child = {
      ...agentHierarchySession("context-child"),
      codexJsonlPath: transcript,
      agentOwnership: {
        parentSessionId: parent.id,
        rootSessionId: parent.id,
        origin: "created" as const,
        createdAt: "2026-08-25T00:00:00.000Z",
        workTokenBaseline: 0,
        workTokenBudget: 1_000_000,
        completedAt: null
      }
    };
    await writeFile(transcript, `${JSON.stringify({
      timestamp: "2026-08-25T00:00:01.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          model_context_window: 100_000,
          last_token_usage: { total_tokens: 85_000 },
          total_token_usage: { input_tokens: 90_000, cached_input_tokens: 10_000, output_tokens: 5_000, total_tokens: 95_000 }
        }
      }
    })}\n`);
    await harness.db.upsertSession(parent, "2026-08-25T00:00:00.000Z");
    await harness.db.upsertSession(child, "2026-08-25T00:00:00.000Z");
    const interrupted: string[] = [];
    harness.tmux.interrupt = async (paneId) => { interrupted.push(paneId); };

    await harness.manager.catchUpIngest();

    expect(interrupted).toEqual([child.tmux.paneId]);
    expect(await harness.manager.getSession(child.id)).toMatchObject({
      status: "blocked",
      contextUsage: { contextPercent: 85 },
      agentOwnership: { contextPausedAt: expect.any(String) }
    });
    await harness.db.close();
  });

  it("lets the operator acknowledge a high-context guard for the next turn", async () => {
    const harness = await createHarness();
    const parent = agentHierarchySession("guard-parent");
    const child = agentHierarchySession("guard-child");
    await harness.db.upsertSession(parent, "2026-08-31T00:00:00.000Z");
    await harness.db.upsertSession(child, "2026-08-31T00:00:00.000Z");
    const claimed = await harness.manager.agentClaim(parent.id, child.id);
    await harness.db.setSessionAgentOwnership(child.id, {
      ...claimed.agentOwnership!,
      contextPausedAt: "2026-08-31T00:01:00.000Z"
    }, "2026-08-31T00:01:00.000Z");
    await harness.db.setSessionStatus(child.id, "blocked", "2026-08-31T00:01:00.000Z");
    const events: string[] = [];
    harness.events.subscribe((event) => events.push(`${event.type}:${event.sessionId}`));

    const updated = await harness.manager.act(child.id, {
      type: "acknowledgeAgentHighContext",
      reason: "Operator accepts the next high-context turn"
    });

    expect(updated).toMatchObject({
      status: "waiting",
      agentOwnership: { contextPausedAt: null, highContextApprovedAt: expect.any(String) }
    });
    expect(events).toContain(`session.updated:${child.id}`);
    await expect(harness.manager.act(child.id, {
      type: "acknowledgeAgentHighContext",
      reason: "stale retry"
    })).rejects.toThrow("not paused");
    await harness.db.close();
  });

  it("extends an exhausted budget but preserves another active guard", async () => {
    const harness = await createHarness();
    const parent = agentHierarchySession("budget-parent");
    const child = agentHierarchySession("budget-child");
    await harness.db.upsertSession(parent, "2026-08-31T00:00:00.000Z");
    await harness.db.upsertSession(child, "2026-08-31T00:00:00.000Z");
    const claimed = await harness.manager.agentClaim(parent.id, child.id);
    await harness.db.setSessionAgentOwnership(child.id, {
      ...claimed.agentOwnership!,
      budgetExhaustedAt: "2026-08-31T00:01:00.000Z",
      contextPausedAt: "2026-08-31T00:01:00.000Z"
    }, "2026-08-31T00:01:00.000Z");
    await harness.db.setSessionStatus(child.id, "blocked", "2026-08-31T00:01:00.000Z");

    const budgetUpdated = await harness.manager.act(child.id, {
      type: "extendAgentBudget",
      additionalTokens: 500_000,
      reason: "Finish the delegated implementation"
    });

    expect(budgetUpdated).toMatchObject({
      status: "blocked",
      agentOwnership: {
        workTokenBudget: 1_500_000,
        budgetExhaustedAt: null,
        contextPausedAt: "2026-08-31T00:01:00.000Z"
      }
    });
    const unblocked = await harness.manager.act(child.id, {
      type: "acknowledgeAgentHighContext",
      reason: "Continue after extending the budget"
    });
    expect(unblocked).toMatchObject({ status: "waiting" });
    await expect(harness.manager.agentExtendBudget(parent.id, child.id, 2_000_001, "too much"))
      .rejects.toThrow("between 1 and 2,000,000");
    await harness.db.close();
  });

  it("refuses agent creation and claims when session scopes are unavailable", async () => {
    const harness = await createHarness({ sessionScopesAvailable: false });
    const root = agentHierarchySession("scope-root");
    const child = agentHierarchySession("scope-child");
    await harness.db.upsertSession(root, "2026-08-25T00:00:00.000Z");
    await harness.db.upsertSession(child, "2026-08-25T00:00:00.000Z");

    await expect(harness.manager.agentCreateChild(root.id, "new-child", "Do work"))
      .rejects.toThrow("loginctl enable-linger");
    await expect(harness.manager.agentClaim(root.id, child.id))
      .rejects.toThrow("loginctl enable-linger");
    expect(await harness.db.getSession(child.id)).toMatchObject({ agentOwnership: null });
    await harness.db.close();
  });

  it("applies staged BTW documents only when ready and privately notifies the main agent", async () => {
    const harness = await createHarness();
    const repo = join(harness.dir, "repo");
    await mkdir(repo);
    await writeCodexSession(harness.codexHome, "session.jsonl", {
      sessionId: "codex-documents",
      cwd: repo,
      user: "Implement the task",
      assistant: "Working on it",
      mtime: new Date("2026-08-26T12:00:00.000Z")
    });
    const pane = testPane({ cwd: repo, paneId: "%documents", title: "codex" });
    harness.tmux.listPanes = async () => [pane];
    harness.tmux.capturePane = async () => "› ";
    const sentInputs: string[] = [];
    harness.tmux.sendInput = async (_paneId, text) => { sentInputs.push(text); };
    const eventTypes: string[] = [];
    harness.events.subscribe((event) => eventTypes.push(event.type));
    await harness.manager.discover();
    const session = harness.manager.listSessions(true)[0]!;
    const staging = await harness.manager.prepareBtwDocumentStaging(session.id, "exchange-documents");
    await writeFile(join(staging.documentsRoot, "plan.md"), "# Plan\n\n- [ ] Ship\n");

    expect(await harness.manager.applyBtwDocumentStaging(session.id, "exchange-documents")).toMatchObject({
      status: "applied",
      noticeDelivered: true,
      changes: { created: ["plan.md"], updated: [] }
    });
    expect((await harness.manager.readDocument(session.id, "plan.md")).document.content).toContain("- [ ] Ship");
    expect(sentInputs).toHaveLength(1);
    expect(sentInputs[0]).toContain("<muxpilot_document_notice>");
    expect(sentInputs[0]).toContain('"created":["plan.md"]');
    expect(eventTypes).toContain("documents.updated");
    expect(eventTypes).not.toContain("message.appended");
    await harness.db.close();
  });

  it("refuses to claim a live session that was not relaunched into a dedicated scope", async () => {
    const harness = await createHarness();
    const root = agentHierarchySession("claim-root");
    const child = { ...agentHierarchySession("claim-child"), resourceScope: null };
    await harness.db.upsertSession(root, "2026-08-25T00:00:00.000Z");
    await harness.db.upsertSession(child, "2026-08-25T00:00:00.000Z");

    await expect(harness.manager.agentClaim(root.id, child.id))
      .rejects.toThrow("dedicated muxpilot resource scopes");
    await expect(harness.manager.operatorSetAgentParent(child.id, root.id))
      .rejects.toThrow("dedicated muxpilot resource scopes");
    await harness.db.close();
  });
});

async function createHarness(options: { sessionScopesAvailable?: boolean } = {}): Promise<{
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
    new SessionDocumentService(join(dir, "sessions")),
    activitySummarizer,
    processLookup,
    null,
    codexHome,
    null,
    { MUXPILOT_SESSION_SCOPES_AVAILABLE: options.sessionScopesAvailable === false ? "0" : "1" }
  );
  return { dir, codexHome, db, tmux, codexStore, events, manager, activitySummarizer, processLookup };
}

function agentHierarchySession(id: string): ManagedSession {
  return {
    id,
    tmux: {
      sessionId: "muxpilot",
      sessionName: "muxpilot",
      windowId: `@${id}`,
      windowIndex: 1,
      windowName: id,
      paneId: `%${id}`,
      paneIndex: 0,
      paneActive: false,
      cwd: "/repo",
      currentCommand: "codex",
      title: id,
      pid: 123,
      size: "120x40"
    },
    repo: { root: "/repo", name: "repo", branch: "main", dirty: false, worktree: null },
    codexSessionId: `codex-${id}`,
    codexJsonlPath: null,
    discoveryConfidence: "high",
    status: "waiting",
    initializing: false,
    startupError: null,
    lastActivityAt: null,
    preview: "",
    recentUserPrompts: [],
    activitySummary: null,
    activitySummaryGeneratedAt: null,
    activitySummarySourceSequence: null,
    inputMode: "default",
    models: { default: { model: null, reasoningEffort: null }, plan: { model: null, reasoningEffort: null } },
    fastMode: null,
    fastModeAvailable: null,
    transcriptSize: 0,
    unreadCount: 0,
    pinned: false,
    archived: false,
    gitWorkspace: null,
    resourceUsage: null,
    resourceScope: "muxpilot-session-0123456789abcdef01234567.scope"
  };
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

function sessionForDiscoveryChange(targetBranch: string): ManagedSession {
  return {
    tmux: {} as ManagedSession["tmux"],
    repo: {} as ManagedSession["repo"],
    status: "waiting",
    codexSessionId: "codex-session",
    codexJsonlPath: "/tmp/session.jsonl",
    discoveryConfidence: "high",
    lastActivityAt: null,
    transcriptSyncing: false,
    inputMode: "default",
    models: {} as ManagedSession["models"],
    pinned: false,
    archived: false,
    gitWorkspace: {
      workflowVersion: 1,
      id: "workspace",
      state: "idle",
      entryPath: "/repo",
      repoRoot: "/repo",
      targetBranch,
      targetSha: "1111111111111111111111111111111111111111",
      sessionBranch: null,
      worktreePath: null,
      lastError: null,
      updatedAt: "2026-07-14T12:00:00.000Z",
      dependencyLinks: []
    }
  } as ManagedSession;
}

async function writeCodexSession(
  codexHome: string,
  name: string,
  input: {
    sessionId: string;
    threadId?: string;
    source?: unknown;
    cwd: string;
    user: string;
    assistant: string;
    startedAt?: Date;
    mtime: Date;
  }
): Promise<void> {
  const path = join(codexHome, "sessions", name);
  const startedAt = input.startedAt ?? input.mtime;
  await writeFile(
    path,
    [
      JSON.stringify({
        timestamp: startedAt.toISOString(),
        type: "session_meta",
        payload: {
          id: input.threadId ?? input.sessionId,
          session_id: input.sessionId,
          timestamp: startedAt.toISOString(),
          cwd: input.cwd,
          cli_version: "test",
          source: input.source ?? "cli"
        }
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

function mcpApprovalCapture(selected: number): string {
  const option = (number: number, text: string) => `${number === selected ? "  ›" : "   "} ${number}. ${text}`;
  return [
    "◦ Calling muxpilot_sessions.capture_tmux_pane({paneId: \"%1\", lines: 100})",
    "",
    "  Field 1/1",
    '  Allow the muxpilot_sessions MCP server to run tool "capture_tmux_pane"?',
    "",
    "  paneId: %1",
    "  lines: 100",
    "",
    option(1, "Allow                   Run the tool and continue."),
    option(2, "Allow for this session  Run the tool and remember this choice for this session."),
    option(3, "Always allow            Run the tool and remember this choice for future tool calls."),
    option(4, "Cancel                  Cancel this tool call"),
    "  enter to submit | esc to cancel"
  ].join("\n");
}

function appSignInCapture(selected: number): string {
  const option = (number: number, text: string) => `${number === selected ? "  ›" : "   "} ${number}. ${text}`;
  return [
    "◦ Calling",
    '  └ codex_apps.slack.slack_search_public_and_private({"query":"patch notes"})',
    "",
    "• Opened https://chatgpt.com/apps/slack/example in your browser.",
    "",
    "  Finish App Sign In",
    "",
    "  Sign in to the app on ChatGPT in the browser window that just opened.",
    "  Then return here and select \"I already signed in\".",
    "",
    "  Sign-in URL:",
    "  https://chatgpt.com/apps/slack/example",
    "",
    option(1, "I already signed in"),
    option(2, "Back"),
    "  Use tab / ↑ ↓ to move, enter to select, esc to close"
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
    option(3, "No, and tell Codex what to do differently (esc)"),
    "",
    "  Press enter to confirm or esc to cancel"
  ].join("\n");
}

function patchApprovalCapture(selected: number): string {
  const option = (number: number, text: string) => `${number === selected ? "›" : " "} ${number}. ${text}`;
  return [
    "  Would you like to make the following edits?",
    "",
    option(1, "Yes, proceed (y)"),
    option(2, "Yes, and don't ask again for these files (a)"),
    option(3, "No, and tell Codex what to do differently (esc)"),
    "",
    "  Press enter to confirm or esc to cancel"
  ].join("\n");
}

function pendingReadiness(): Promise<void> {
  return new Promise(() => undefined);
}

function testPane(input: {
  cwd: string;
  paneId: string;
  windowId?: string;
  pid?: number;
  serverPid?: number;
  sessionCreatedAt?: number;
  windowName?: string;
  title?: string;
  sessionName?: string;
  currentCommand?: string;
}): TmuxPane {
  return {
    sessionId: "tmux-session",
    sessionName: input.sessionName ?? "work",
    serverPid: input.serverPid,
    sessionCreatedAt: input.sessionCreatedAt,
    windowId: input.windowId ?? `@${input.paneId.slice(1)}`,
    windowIndex: Number(input.paneId.slice(1)),
    windowName: input.windowName ?? "codex",
    paneId: input.paneId,
    paneIndex: 0,
    paneActive: true,
    cwd: input.cwd,
    currentCommand: input.currentCommand ?? "node",
    title: input.title ?? "codex",
    pid: input.pid ?? 123,
    size: "120x40"
  };
}
