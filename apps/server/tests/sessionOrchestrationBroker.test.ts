import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { ManagedSession } from "@muxpilot/core";
import type { AppDatabase } from "../src/db/database.js";
import type { SessionManager } from "../src/services/sessionManager.js";
import { SessionOrchestrationBroker } from "../src/services/sessionOrchestrationBroker.js";
import type { RawSessionEvidence } from "../src/services/rawSessionEvidence.js";

describe("SessionOrchestrationBroker raw evidence", () => {
  it("ignores advisory context pressure but wakes after the 85-percent guard blocks work", async () => {
    const child: ManagedSession = {
      ...managedSession(),
      id: "context-child",
      status: "working",
      contextUsage: {
        activeTokens: 75,
        contextWindowTokens: 100,
        contextPercent: 75,
        lifetimeInputTokens: 100,
        lifetimeCachedInputTokens: 0,
        lifetimeOutputTokens: 0,
        lifetimeReasoningTokens: 0,
        lifetimeTotalTokens: 100,
        lifetimeWorkTokens: 100,
        sampledAt: "2026-08-25T00:00:00.000Z"
      }
    };
    const wait = {
      actorSessionId: "parent-1",
      sessionIds: [child.id],
      mode: "all" as const,
      expiresAt: Date.now() + 60_000,
      readyAt: null
    };
    const db = {
      listAgentWaits: vi.fn(async () => [wait]),
      listSessions: vi.fn(async () => [child]),
      listQueuedInputs: vi.fn(async () => []),
      upsertAgentWait: vi.fn(async () => undefined),
      deleteAgentWait: vi.fn(async () => undefined)
    } as unknown as AppDatabase;
    const manager = {
      hasActiveHeavyCommand: vi.fn(async () => false),
      resumeAgentWait: vi.fn(async () => true)
    } as unknown as SessionManager;
    const broker = new SessionOrchestrationBroker(db, manager, "/tmp/unused.sock", "/tmp/unused-capabilities", { info: vi.fn(), warn: vi.fn() }, {} as RawSessionEvidence);

    await (broker as unknown as { tick(): Promise<void> }).tick();

    expect(manager.resumeAgentWait).not.toHaveBeenCalled();

    child.status = "blocked";
    child.contextUsage!.contextPercent = 85;
    await (broker as unknown as { tick(): Promise<void> }).tick();

    expect(manager.resumeAgentWait).toHaveBeenCalledWith("parent-1", expect.stringContaining('"effectiveStatus":"blocked"'));
  });

  it("keeps waiting for a working descendant and wakes with its attention status", async () => {
    const target = { ...managedSession(), id: "target", status: "waiting" as const };
    const child: ManagedSession = {
      ...managedSession(),
      id: "target-child",
      status: "working",
      agentOwnership: {
        parentSessionId: target.id,
        rootSessionId: target.id,
        origin: "created",
        createdAt: "2026-08-25T00:00:00.000Z",
        workTokenBaseline: 0,
        workTokenBudget: 1_000_000,
        completedAt: null
      }
    };
    const sessions = [target, child];
    const wait = {
      actorSessionId: "actor",
      sessionIds: [target.id],
      mode: "all" as const,
      expiresAt: Date.now() + 60_000,
      readyAt: null
    };
    const db = {
      listAgentWaits: vi.fn(async () => [wait]),
      listSessions: vi.fn(async () => sessions),
      listQueuedInputs: vi.fn(async () => []),
      upsertAgentWait: vi.fn(async () => undefined),
      deleteAgentWait: vi.fn(async () => undefined)
    } as unknown as AppDatabase;
    const manager = {
      hasActiveHeavyCommand: vi.fn(async () => false),
      resumeAgentWait: vi.fn(async () => true)
    } as unknown as SessionManager;
    const broker = new SessionOrchestrationBroker(db, manager, "/tmp/unused.sock", "/tmp/unused-capabilities", { info: vi.fn(), warn: vi.fn() }, {} as RawSessionEvidence);
    const tick = () => (broker as unknown as { tick(): Promise<void> }).tick();

    await tick();
    expect(manager.resumeAgentWait).not.toHaveBeenCalled();

    child.status = "approval";
    await tick();
    expect(manager.resumeAgentWait).toHaveBeenCalledOnce();
    expect(manager.resumeAgentWait).toHaveBeenCalledWith("actor", expect.stringContaining('"effectiveStatus":"approval"'));
    expect(manager.resumeAgentWait).toHaveBeenCalledWith("actor", expect.stringContaining('"effectiveStatusSessionId":"target-child"'));
  });

  it("does not resume a parent while a child still has active queued work", async () => {
    const child: ManagedSession = {
      ...managedSession(),
      id: "child-1",
      status: "waiting",
      contextUsage: {
        activeTokens: 75,
        contextWindowTokens: 100,
        contextPercent: 75,
        lifetimeTotalTokens: 100,
        lifetimeCachedInputTokens: 0,
        lifetimeWorkTokens: 100,
        sampledAt: "2026-08-25T00:00:00.000Z"
      }
    };
    let activeHeavyCommand = true;
    const wait = {
      actorSessionId: "parent-1",
      sessionIds: [child.id],
      mode: "all" as const,
      expiresAt: Date.now() + 60_000,
      readyAt: null
    };
    const db = {
      listAgentWaits: vi.fn(async () => [wait]),
      listSessions: vi.fn(async () => [child]),
      listQueuedInputs: vi.fn(async () => []),
      upsertAgentWait: vi.fn(async () => undefined),
      deleteAgentWait: vi.fn(async () => undefined)
    } as unknown as AppDatabase;
    const manager = {
      hasActiveHeavyCommand: vi.fn(async () => activeHeavyCommand),
      resumeAgentWait: vi.fn(async () => true)
    } as unknown as SessionManager;
    const broker = new SessionOrchestrationBroker(
      db,
      manager,
      "/tmp/muxpilot-unused.sock",
      "/tmp/muxpilot-unused-capabilities",
      { info: vi.fn(), warn: vi.fn() },
      {} as RawSessionEvidence
    );
    const tick = () => (broker as unknown as { tick(): Promise<void> }).tick();

    await tick();
    expect(manager.resumeAgentWait).not.toHaveBeenCalled();

    activeHeavyCommand = false;
    await tick();
    expect(manager.resumeAgentWait).toHaveBeenCalledOnce();
    expect(db.deleteAgentWait).toHaveBeenCalledWith(wait.actorSessionId);
  });

  it("pre-approves its capability-scoped MCP tools for managed Codex launches", async () => {
    const capabilityRoot = await mkdtemp(join(tmpdir(), "muxpilot-capabilities-"));
    try {
      const broker = new SessionOrchestrationBroker(
        {} as AppDatabase,
        {} as SessionManager,
        join(capabilityRoot, "broker.sock"),
        capabilityRoot,
        { info: vi.fn(), warn: vi.fn() },
        {} as RawSessionEvidence
      );

      await expect(broker.prepareLaunch()).resolves.toMatchObject({
        server: {
          name: "muxpilot_sessions",
          defaultToolsApprovalMode: "approve"
        }
      });
    } finally {
      await rm(capabilityRoot, { recursive: true, force: true });
    }
  });

  it("dispatches authenticated raw evidence calls without interpreting their content", async () => {
    const session = managedSession();
    const db = {
      getSession: vi.fn(async () => session),
      listRecentMessages: vi.fn(async () => ({
        items: [{
          type: "message",
          message: {
            id: "message-1",
            sessionId: session.id,
            sequence: 1,
            type: "status",
            role: "system",
            timestamp: "2026-08-25T00:00:00.000Z",
            text: "task_complete",
            payload: { rawLifecycle: { type: "task_complete" } }
          }
        }],
        hasMoreBefore: false
      })),
      listQueuedInputs: vi.fn(async () => [{ id: "queued-1", text: "pending" }])
    } as unknown as AppDatabase;
    const manager = {
      getSession: vi.fn(async () => session),
      listSessions: vi.fn(async () => [session])
    } as unknown as SessionManager;
    const rawEvidence: RawSessionEvidence = {
      listTmuxPanes: vi.fn(async () => ({ fields: ["pane_id"], output: "%7\n" })),
      captureTmuxPane: vi.fn(async () => ({ paneId: "%7", output: "raw pane\n" })),
      readTmuxProcessTree: vi.fn(async () => ({ paneId: "%7", rootPid: 700, processes: [], truncated: false })),
      readSessionRuntime: vi.fn(async () => ({ sessionId: session.id, driverKind: session.driverKind })),
      readSessionProcessTree: vi.fn(async () => ({ sessionId: session.id, rootPid: 700, processes: [], truncated: false })),
      readSessionProtocolJournal: vi.fn(async () => ({ sessionId: session.id, fileSize: 3, startOffset: 0, endOffset: 3, text: "rpc" })),
      listCodexSessionFiles: vi.fn(async () => ({ root: "/codex/sessions", files: [], nextOffset: null })),
      readCodexSessionFile: vi.fn(async () => ({
        relativePath: "rollout.jsonl",
        fileSize: 3,
        startOffset: 0,
        endOffset: 3,
        text: "raw"
      }))
    };
    const broker = new SessionOrchestrationBroker(
      db,
      manager,
      "/tmp/muxpilot-unused.sock",
      "/tmp/muxpilot-unused-capabilities",
      { info: vi.fn(), warn: vi.fn() },
      rawEvidence
    );
    const token = "token";
    const capabilityId = "0123456789abcdef01234567";
    const internals = broker as unknown as {
      capabilities: Map<string, object>;
      handle(raw: string): Promise<unknown>;
    };
    internals.capabilities.set(token, {
      version: 1,
      id: capabilityId,
      token,
      socketPath: "/tmp/muxpilot-unused.sock",
      actorSessionId: session.id
    });
    const call = (action: string, args: Record<string, unknown> = {}) => internals.handle(JSON.stringify({ version: 1, token, action, args }));

    await expect(call("capture_tmux_pane", { paneId: "%7", lines: 50, includeAnsi: true }))
      .resolves.toEqual({ paneId: "%7", output: "raw pane\n" });
    expect(rawEvidence.captureTmuxPane).toHaveBeenCalledWith("%7", 50, true, false);
    await expect(call("read_session_runtime", { sessionId: session.id }))
      .resolves.toMatchObject({ sessionId: session.id });
    expect(rawEvidence.readSessionRuntime).toHaveBeenCalledWith(session);
    await expect(call("read_codex_session_file", { relativePath: "rollout.jsonl" }))
      .resolves.toMatchObject({ text: "raw", startOffset: 0, endOffset: 3 });
    expect(rawEvidence.readCodexSessionFile).toHaveBeenCalledWith("rollout.jsonl", null, 64 * 1024);

    await expect(call("read_session", { sessionId: session.id, limit: 5 })).resolves.toMatchObject({
      muxpilotRecord: { id: session.id, codexSessionId: session.codexSessionId },
      queuedInputs: [{ id: "queued-1", text: "pending" }],
      messages: [{ text: "task_complete", payload: { rawLifecycle: { type: "task_complete" } } }]
    });
  });

  it("advertises every raw read-only primitive through MCP", async () => {
    const script = fileURLToPath(new URL("../../../scripts/muxpilot-session-mcp.mjs", import.meta.url));
    const child = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"] });
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      let output = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        output += chunk;
        const line = output.split("\n").find(Boolean);
        if (!line) return;
        try { resolve(JSON.parse(line) as Record<string, unknown>); } catch (error) { reject(error); }
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code && !output) reject(new Error(`MCP process exited ${code}`));
      });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
    const result = await response;
    child.kill("SIGTERM");
    const tools = (result.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);

    expect(tools).toEqual(expect.arrayContaining([
      "list_tmux_panes",
      "capture_tmux_pane",
      "read_tmux_process_tree",
      "list_codex_session_files",
      "read_codex_session_file"
    ]));
  });
});

function managedSession(): ManagedSession {
  return {
    id: "session-1",
    tmux: {
      sessionId: "$1",
      sessionName: "muxpilot",
      windowId: "@1",
      windowIndex: 0,
      windowName: "work",
      paneId: "%7",
      paneIndex: 0,
      paneActive: true,
      cwd: "/repo",
      currentCommand: "node",
      title: "Codex",
      pid: 700,
      size: "120x40"
    },
    repo: { root: "/repo", name: "repo", branch: "main", dirty: false, worktree: null },
    codexSessionId: "codex-1",
    codexJsonlPath: "/codex/sessions/rollout.jsonl",
    discoveryConfidence: "high",
    status: "waiting",
    lastActivityAt: "2026-08-25T00:00:00.000Z",
    preview: "done",
    recentUserPrompts: [],
    activitySummary: null,
    activitySummaryGeneratedAt: null,
    activitySummarySourceSequence: null,
    inputMode: "default",
    models: {
      default: { model: null, reasoningEffort: null },
      plan: { model: null, reasoningEffort: null }
    },
    transcriptSize: 1,
    unreadCount: 0,
    pinned: false,
    archived: false
  };
}
