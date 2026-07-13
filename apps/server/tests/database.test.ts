import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChatMessage, ManagedSession, QueuedInput, TranscriptPageResponse } from "@muxpilot/core";
import { AppDatabase, type StoredGitWorkspace } from "../src/db/database.js";

describe("AppDatabase activity summaries", () => {
  it("hydrates persisted activity summary metadata onto sessions", async () => {
    const db = await tempDb();
    const session = testSession("session-1");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.upsertActivitySummary(
      session.id,
      "Implementing dashboard activity summaries with a debounced model refresh.",
      "2026-07-07T00:00:02.000Z",
      4
    );

    const hydrated = db.getSession(session.id);

    expect(hydrated?.activitySummary).toBe("Implementing dashboard activity summaries with a debounced model refresh.");
    expect(hydrated?.activitySummaryGeneratedAt).toBe("2026-07-07T00:00:02.000Z");
    expect(hydrated?.activitySummarySourceSequence).toBe(4);
    db.close();
  });

  it("keeps recent prompt fallback when no activity summary exists", async () => {
    const db = await tempDb();
    const session = testSession("session-2");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(session.id, 1, "user", "First prompt"));
    db.appendMessage(testMessage(session.id, 2, "user", "Second prompt"));

    const hydrated = db.getSession(session.id);

    expect(hydrated?.activitySummary).toBeNull();
    expect(hydrated?.recentUserPrompts).toEqual(["Second prompt", "First prompt"]);
    db.close();
  });

  it("excludes initial instruction context from recent prompt metadata", async () => {
    const db = await tempDb();
    const session = testSession("session-context-preview");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(session.id, 1, "user", "First prompt", "2026-07-07T00:00:01.000Z"));
    db.appendMessage(testMessage(session.id, 2, "user", initialInstructionContext(), "2026-07-07T00:00:02.000Z"));
    db.appendMessage(testMessage(session.id, 3, "user", "Second prompt", "2026-07-07T00:00:03.000Z"));

    const hydrated = db.getSession(session.id);

    expect(hydrated?.preview).toBe("Second prompt");
    expect(hydrated?.recentUserPrompts).toEqual(["Second prompt", "First prompt"]);
    expect(hydrated?.lastActivityAt).toBe("2026-07-07T00:00:03.000Z");
    db.close();
  });

  it("searches displayable prompt history across active, archived, and missing sessions", async () => {
    const db = await tempDb();
    const active = testSession("session-history-active");
    const archived = { ...testSession("session-history-archived"), archived: true };
    const missing = { ...testSession("session-history-missing"), status: "missing" as const };
    db.upsertSession(active, "2026-07-07T00:00:00.000Z");
    db.upsertSession(archived, "2026-07-07T00:00:00.000Z");
    db.upsertSession(missing, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(active.id, 1, "user", "Build prompt history search", "2026-07-07T00:00:01.000Z"));
    db.appendMessage(testMessage(archived.id, 1, "user", "Archived prompt history result", "2026-07-07T00:00:03.000Z"));
    db.appendMessage(testMessage(missing.id, 1, "user", "Missing session prompt history result", "2026-07-07T00:00:02.000Z"));

    const history = await db.listPromptHistory("history", 10);

    expect(history.map((result) => result.text)).toEqual(expect.arrayContaining([
      "Archived prompt history result",
      "Missing session prompt history result",
      "Build prompt history search"
    ]));
    expect(history.map((result) => result.sessionId)).toEqual(expect.arrayContaining([archived.id, missing.id, active.id]));
    db.close();
  });

  it("excludes hidden and action user context from prompt history", async () => {
    const db = await tempDb();
    const session = testSession("session-history-context");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(session.id, 1, "user", initialInstructionContext(), "2026-07-07T00:00:01.000Z"));
    db.appendMessage(testMessage(session.id, 2, "user", subagentNotificationContext(), "2026-07-07T00:00:02.000Z"));
    db.appendMessage(testMessage(session.id, 3, "user", "Actual searchable prompt", "2026-07-07T00:00:03.000Z"));

    const history = await db.listPromptHistory("", 10);

    expect(history.map((result) => result.text)).toEqual(["Actual searchable prompt"]);
    db.close();
  });

  it("ranks indexed prompt history by exact and token matches", async () => {
    const db = await tempDb();
    const session = testSession("session-history-ranking");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(session.id, 1, "user", "xylophone graph", "2026-07-07T00:00:04.000Z"));
    db.appendMessage(testMessage(session.id, 2, "user", "graph", "2026-07-07T00:00:01.000Z"));
    db.appendMessage(testMessage(session.id, 3, "user", "build a graph view", "2026-07-07T00:00:02.000Z"));
    db.appendMessage(testMessage(session.id, 4, "user", "gather rough app hints", "2026-07-07T00:00:03.000Z"));

    const history = await db.listPromptHistory("graph", 10);

    expect(history.map((result) => result.text)).toEqual(["graph", "xylophone graph", "build a graph view"]);
    db.close();
  });

  it("searches restorable session history through the prompt index", async () => {
    const db = await tempDb();
    const active = { ...testSession("session-history-active"), codexSessionId: "codex-active" };
    const missing = { ...testSession("session-history-missing"), codexSessionId: "codex-missing", status: "missing" as const };
    const noCodex = testSession("session-history-no-codex");
    db.upsertSession(active, "2026-07-07T00:00:00.000Z");
    db.upsertSession(missing, "2026-07-07T00:00:00.000Z");
    db.upsertSession(noCodex, "2026-07-07T00:00:00.000Z");
    db.upsertGitWorkspace(testGitWorkspace(missing.id), "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(active.id, 1, "user", "Build indexed session history", "2026-07-07T00:00:01.000Z"));
    db.appendMessage(testMessage(missing.id, 1, "user", "Restore indexed session history", "2026-07-07T00:00:02.000Z"));
    db.appendMessage(testMessage(noCodex.id, 1, "user", "No Codex session history", "2026-07-07T00:00:03.000Z"));

    const history = await db.listSessionHistory("indexed history", 10);

    expect(history.map((result) => result.codexSessionId).sort()).toEqual(["codex-active", "codex-missing"]);
    expect(history.flatMap((result) => result.matchedPrompts.map((prompt) => prompt.text))).toEqual(
      expect.arrayContaining(["Build indexed session history", "Restore indexed session history"])
    );
    expect(history.find((result) => result.sessionId === missing.id)?.gitWorkspace).toEqual({
      id: "workspace-rekey",
      worktreePath: "/tmp/workspace-rekey",
      sessionBranch: "muxpilot/workspace-rekey",
      targetBranch: "main"
    });
    db.close();
  });

  it("keeps the same Codex session distinct across managed worktrees", async () => {
    const db = await tempDb();
    const first = { ...testSession("history-workspace-first"), codexSessionId: "shared-codex", lastActivityAt: "2026-07-07T00:00:01.000Z" };
    const second = { ...testSession("history-workspace-second"), codexSessionId: "shared-codex", lastActivityAt: "2026-07-07T00:00:02.000Z" };
    db.upsertSession(first, first.lastActivityAt);
    db.upsertSession(second, second.lastActivityAt);
    db.upsertGitWorkspace(testGitWorkspace(first.id, "workspace-first"), first.lastActivityAt);
    db.upsertGitWorkspace(testGitWorkspace(second.id, "workspace-second"), second.lastActivityAt);

    const history = await db.listSessionHistory("", 10);

    expect(history.map((result) => result.gitWorkspace?.id)).toEqual(["workspace-second", "workspace-first"]);
    db.close();
  });

  it("shares approval prefixes by repository common Git directory", async () => {
    const db = await tempDb();
    const prefix = ["pnpm", "test"];

    await db.addRepositoryApprovalRule("/repo/.git", prefix, "2026-07-10T00:00:00.000Z");

    expect(await db.hasRepositoryApprovalRule("/repo/.git", prefix)).toBe(true);
    expect(await db.hasRepositoryApprovalRule("/other/.git", prefix)).toBe(false);
    expect(await db.hasRepositoryApprovalRule("/repo/.git", ["pnpm", "install"])).toBe(false);
    db.close();
  });

  it("continues collapsing unmanaged history by Codex session", async () => {
    const db = await tempDb();
    const older = { ...testSession("history-unmanaged-old"), codexSessionId: "shared-unmanaged", lastActivityAt: "2026-07-07T00:00:01.000Z" };
    const newer = { ...testSession("history-unmanaged-new"), codexSessionId: "shared-unmanaged", lastActivityAt: "2026-07-07T00:00:02.000Z" };
    db.upsertSession(older, older.lastActivityAt);
    db.upsertSession(newer, newer.lastActivityAt);

    const history = await db.listSessionHistory("", 10);

    expect(history).toHaveLength(1);
    expect(history[0]?.sessionId).toBe(newer.id);
    db.close();
  });

  it("rekeys a managed session without duplicating transcript history", async () => {
    const db = await tempDb();
    const oldSession = { ...testSession("session-rekey-old"), codexSessionId: "codex-rekey", codexJsonlPath: "/tmp/rekey.jsonl" };
    const newSession = {
      ...oldSession,
      id: "session-rekey-new",
      tmux: { ...oldSession.tmux, paneId: "%9", windowId: "@9", windowName: "restored" },
      status: "unknown" as const,
      archived: false
    };
    db.upsertSession({ ...oldSession, status: "missing", archived: true }, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(oldSession.id, 1, "user", "Rekey searchable prompt", "2026-07-07T00:00:01.000Z"));
    db.appendMessage(testMessage(oldSession.id, 2, "assistant", "Rekey answer", "2026-07-07T00:00:02.000Z"));
    db.upsertActivitySummary(oldSession.id, "Existing summary", "2026-07-07T00:00:03.000Z", 2);
    db.setNotificationRule("device-rekey", "session", oldSession.id, "done_task", true, "2026-07-07T00:00:04.000Z");
    db.setParserOffset("old-offset", 1234, "parser-test", "2026-07-07T00:00:05.000Z");
    db.upsertGitWorkspace(testGitWorkspace(oldSession.id), "2026-07-07T00:00:05.000Z");

    const rebound = db.rekeySession(oldSession.id, newSession, { from: "old-offset", to: "new-offset" }, "2026-07-07T00:00:06.000Z");

    expect(rebound?.id).toBe(newSession.id);
    expect(db.getSession(oldSession.id)).toBeNull();
    expect(db.listMessages(newSession.id, 0).map((message) => message.text)).toEqual(["Rekey searchable prompt", "Rekey answer"]);
    expect(db.listMessages(oldSession.id, 0)).toEqual([]);
    expect(db.listPromptHistory("rekey", 10).map((result) => result.sessionId)).toEqual([newSession.id]);
    expect(db.getActivitySummary(newSession.id)?.summary).toBe("Existing summary");
    expect(db.getNotificationSettings("device-rekey").sessionRules[newSession.id]).toEqual(["done_task"]);
    expect(db.getParserOffset("old-offset")).toBe(0);
    expect(db.getParserOffset("new-offset")).toBe(1234);
    expect(db.getGitWorkspaceBySession(newSession.id)?.id).toBe("workspace-rekey");
    expect(db.getGitWorkspaceBySession(oldSession.id)).toBeNull();
    expect(db.appendMessage(testMessage(oldSession.id, 3, "assistant", "Stale parser write"))).toBe(false);
    expect(db.listMessages(newSession.id, 0).map((message) => message.text)).toEqual(["Rekey searchable prompt", "Rekey answer"]);
    db.close();
  });

  it("returns newest prompt history for an empty query", async () => {
    const db = await tempDb();
    const session = testSession("session-history-newest");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(session.id, 1, "user", "Old prompt", "2026-07-07T00:00:01.000Z"));
    db.appendMessage(testMessage(session.id, 2, "user", "New prompt", "2026-07-07T00:00:02.000Z"));

    const history = await db.listPromptHistory("", 1);

    expect(history.map((result) => result.text)).toEqual(["New prompt"]);
    db.close();
  });

  it("hydrates transcript size from message count", async () => {
    const db = await tempDb();
    const session = testSession("session-size");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(session.id, 1, "user", "Prompt"));
    db.appendMessage(testMessage(session.id, 2, "assistant", "Progress"));
    db.appendMessage(testMessage(session.id, 3, "tool", "Tool output"));

    const hydrated = db.getSession(session.id);

    expect(hydrated?.transcriptSize).toBe(3);
    db.close();
  });

  it("persists session input mode in session data", async () => {
    const db = await tempDb();
    const session = testSession("session-input-mode");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");

    const updated = db.setSessionInputMode(session.id, "plan", "2026-07-07T00:00:01.000Z");

    expect(updated?.inputMode).toBe("plan");
    expect(db.getSession(session.id)?.inputMode).toBe("plan");
    db.close();
  });

  it("hydrates missing legacy session model selections", async () => {
    const db = await tempDb();
    const legacySession = { ...testSession("session-legacy-models") };
    delete (legacySession as Partial<ManagedSession>).models;
    db.upsertSession(legacySession as ManagedSession, "2026-07-07T00:00:00.000Z");

    expect(db.getSession(legacySession.id)?.models).toEqual({
      default: { model: null, reasoningEffort: null },
      plan: { model: null, reasoningEffort: null }
    });
    db.close();
  });

  it("hydrates missing legacy session pin state as unpinned", async () => {
    const db = await tempDb();
    const legacySession = { ...testSession("session-legacy-pinned") };
    delete (legacySession as Partial<ManagedSession>).pinned;
    db.upsertSession(legacySession as ManagedSession, "2026-07-07T00:00:00.000Z");

    expect(db.getSession(legacySession.id)?.pinned).toBe(false);
    db.close();
  });

  it("persists session pin state across session upserts", async () => {
    const db = await tempDb();
    const session = testSession("session-pinned");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");

    expect(db.setSessionPinned(session.id, true, "2026-07-07T00:00:01.000Z")?.pinned).toBe(true);
    db.upsertSession({ ...session, lastActivityAt: "2026-07-07T00:00:02.000Z" }, "2026-07-07T00:00:02.000Z");

    expect(db.getSession(session.id)?.pinned).toBe(true);
    db.close();
  });

  it("persists session model settings per collaboration mode", async () => {
    const db = await tempDb();
    const session = testSession("session-models");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");

    const normal = db.setSessionModelSettings(session.id, "default", "gpt-5.4", "medium", "2026-07-07T00:00:01.000Z");
    const plan = db.setSessionModelSettings(session.id, "plan", "gpt-5.5", "high", "2026-07-07T00:00:02.000Z");

    expect(normal?.models).toEqual({
      default: { model: "gpt-5.4", reasoningEffort: "medium" },
      plan: { model: null, reasoningEffort: null }
    });
    expect(plan?.models).toEqual({
      default: { model: "gpt-5.4", reasoningEffort: "medium" },
      plan: { model: "gpt-5.5", reasoningEffort: "high" }
    });
    expect(db.getSession(session.id)?.models).toEqual({
      default: { model: "gpt-5.4", reasoningEffort: "medium" },
      plan: { model: "gpt-5.5", reasoningEffort: "high" }
    });
    db.close();
  });

  it("pages recent and older transcript messages without loading the full chat", async () => {
    const db = await tempDb();
    const session = testSession("session-pages");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    for (let sequence = 1; sequence <= 7; sequence += 1) {
      db.appendMessage(testMessage(session.id, sequence, sequence % 2 === 0 ? "assistant" : "user", `message ${sequence}`));
    }

    const recent = db.listRecentMessages(session.id, 3);
    const older = db.listMessagesBefore(session.id, recent.items[0]?.firstSequence ?? 0, 3);

    expect(itemSpans(recent)).toEqual([[5, 5, "message"], [6, 6, "message"], [7, 7, "message"]]);
    expect(recent.hasMoreBefore).toBe(true);
    expect(recent.hasMoreAfter).toBe(false);
    expect(itemSpans(older)).toEqual([[2, 2, "message"], [3, 3, "message"], [4, 4, "message"]]);
    expect(older.hasMoreBefore).toBe(true);
    db.close();
  });

  it("loads an active transcript tail from the previous assistant output through the latest prompt", async () => {
    const db = await tempDb();
    const session = testSession("session-active-tail");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(session.id, 1, "user", "Older prompt"));
    db.appendMessage(testMessage(session.id, 2, "assistant", "Older answer"));
    db.appendMessage(testMessage(session.id, 3, "tool", "Older tool output", undefined, "tool_output"));
    db.appendMessage(testMessage(session.id, 4, "assistant", "Prior assistant output"));
    db.appendMessage(testMessage(session.id, 5, "tool", "Tool before current prompt", undefined, "tool_output"));
    db.appendMessage(testMessage(session.id, 6, "user", "Current prompt"));
    for (let sequence = 7; sequence <= 16; sequence += 1) {
      db.appendMessage(testMessage(session.id, sequence, "tool", `Collapsed row ${sequence}`, undefined, "tool_output"));
    }

    const tail = db.listActiveTailMessages(session.id, 4);

    expect(itemSpans(tail)).toEqual([
      [1, 1, "message"],
      [2, 2, "message"],
      [3, 3, "range:stack"],
      [4, 4, "message"],
      [5, 5, "range:stack"],
      [6, 6, "message"],
      [7, 16, "range:activity"]
    ]);
    expect(tail.hasMoreBefore).toBe(false);
    expect(tail.hasMoreAfter).toBe(false);

    const older = db.listMessagesBefore(session.id, tail.items[0]?.firstSequence ?? 0, 3);
    expect(itemSpans(older)).toEqual([]);
    expect(older.hasMoreBefore).toBe(false);
    db.close();
  });

  it("backfills older visible turns when current noise collapses under the page size", async () => {
    const db = await tempDb();
    const session = testSession("session-active-tail-visible-page");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(session.id, 1, "user", "First prompt"));
    db.appendMessage(testMessage(session.id, 2, "assistant", "First answer"));
    db.appendMessage(testMessage(session.id, 3, "tool", "First hidden output", undefined, "tool_output"));
    db.appendMessage(testMessage(session.id, 4, "user", "Second prompt"));
    db.appendMessage(testMessage(session.id, 5, "assistant", "Second answer"));
    db.appendMessage(testMessage(session.id, 6, "tool", "Second hidden output", undefined, "tool_output"));
    db.appendMessage(testMessage(session.id, 7, "assistant", "Prior assistant output"));
    db.appendMessage(testMessage(session.id, 8, "tool", "Tool before current prompt", undefined, "tool_output"));
    db.appendMessage(testMessage(session.id, 9, "user", "Current prompt"));
    for (let sequence = 10; sequence <= 30; sequence += 1) {
      db.appendMessage(testMessage(session.id, sequence, "tool", `Collapsed row ${sequence}`, undefined, "tool_output"));
    }

    const tail = db.listActiveTailMessages(session.id, 8);

    expect(itemSpans(tail)).toEqual([
      [1, 1, "message"],
      [2, 2, "message"],
      [3, 3, "range:stack"],
      [4, 4, "message"],
      [5, 5, "message"],
      [6, 6, "range:stack"],
      [7, 7, "message"],
      [8, 8, "range:stack"],
      [9, 9, "message"],
      [10, 30, "range:activity"]
    ]);
    expect(tail.hasMoreBefore).toBe(false);
    expect(tail.hasMoreAfter).toBe(false);
    db.close();
  });

  it("does not show older pagination for a short active visible tail", async () => {
    const db = await tempDb();
    const session = testSession("session-active-tail-short-visible");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(session.id, 1, "user", "First prompt"));
    db.appendMessage(testMessage(session.id, 2, "assistant", "First answer"));
    db.appendMessage(testMessage(session.id, 3, "user", "Previous prompt"));
    db.appendMessage(testMessage(session.id, 4, "assistant", "Previous answer"));
    db.appendMessage(testMessage(session.id, 5, "user", "Current prompt"));
    db.appendMessage(testMessage(session.id, 6, "assistant", "Current answer"));

    const tail = db.listActiveTailMessages(session.id, 80);

    expect(itemSpans(tail)).toEqual([
      [1, 1, "message"],
      [2, 2, "message"],
      [3, 3, "message"],
      [4, 4, "message"],
      [5, 5, "message"],
      [6, 6, "message"]
    ]);
    expect(tail.hasMoreBefore).toBe(false);
    expect(tail.hasMoreAfter).toBe(false);
    db.close();
  });

  it("shows older pagination for a long transcript even when the active tail is short", async () => {
    const db = await tempDb();
    const session = testSession("session-active-tail-long-visible-history");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    for (let sequence = 1; sequence <= 90; sequence += 1) {
      db.appendMessage(testMessage(session.id, sequence, sequence % 2 === 0 ? "assistant" : "user", `Earlier message ${sequence}`));
    }
    db.appendMessage(testMessage(session.id, 91, "assistant", "Previous answer"));
    db.appendMessage(testMessage(session.id, 92, "user", "Current prompt"));
    db.appendMessage(testMessage(session.id, 93, "assistant", "Current answer"));

    const tail = db.listActiveTailMessages(session.id, 80);

    expect(itemSpans(tail)[0]).toEqual([14, 14, "message"]);
    expect(itemSpans(tail).slice(-3)).toEqual([[91, 91, "message"], [92, 92, "message"], [93, 93, "message"]]);
    expect(tail.hasMoreBefore).toBe(true);
    expect(tail.hasMoreAfter).toBe(false);

    const older = db.listMessagesBefore(session.id, tail.items[0]?.firstSequence ?? 0, 80);
    expect(older.items).toHaveLength(13);
    expect(older.items[0]?.firstSequence).toBe(1);
    expect(older.items.at(-1)?.lastSequence).toBe(13);
    expect(older.hasMoreBefore).toBe(false);
    db.close();
  });

  it("shows older pagination when the active tail fills the visible item page", async () => {
    const db = await tempDb();
    const session = testSession("session-active-tail-full-visible-page");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(session.id, 1, "user", "First prompt"));
    db.appendMessage(testMessage(session.id, 2, "assistant", "First answer"));
    db.appendMessage(testMessage(session.id, 3, "user", "Previous prompt"));
    db.appendMessage(testMessage(session.id, 4, "assistant", "Previous answer"));
    db.appendMessage(testMessage(session.id, 5, "user", "Current prompt"));
    db.appendMessage(testMessage(session.id, 6, "assistant", "Current answer"));

    const tail = db.listActiveTailMessages(session.id, 3);

    expect(itemSpans(tail)).toEqual([[4, 4, "message"], [5, 5, "message"], [6, 6, "message"]]);
    expect(tail.hasMoreBefore).toBe(true);
    expect(tail.hasMoreAfter).toBe(false);
    db.close();
  });

  it("bounds the active transcript tail by visible items", async () => {
    const db = await tempDb();
    const session = testSession("session-active-tail-visible-limit");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(session.id, 1, "user", "First prompt"));
    db.appendMessage(testMessage(session.id, 2, "assistant", "First answer"));
    db.appendMessage(testMessage(session.id, 3, "tool", "First hidden output", undefined, "tool_output"));
    db.appendMessage(testMessage(session.id, 4, "user", "Second prompt"));
    db.appendMessage(testMessage(session.id, 5, "assistant", "Second answer"));
    db.appendMessage(testMessage(session.id, 6, "tool", "Second hidden output", undefined, "tool_output"));
    db.appendMessage(testMessage(session.id, 7, "assistant", "Prior assistant output"));
    db.appendMessage(testMessage(session.id, 8, "tool", "Tool before current prompt", undefined, "tool_output"));
    db.appendMessage(testMessage(session.id, 9, "user", "Current prompt"));
    for (let sequence = 10; sequence <= 120; sequence += 1) {
      db.appendMessage(testMessage(session.id, sequence, "tool", `Collapsed row ${sequence}`, undefined, "tool_output"));
    }

    const tail = db.listActiveTailMessages(session.id, 3);
    const older = db.listMessagesBefore(session.id, tail.items[0]?.firstSequence ?? 0, 4);
    const activeRange = tail.items.at(-1);
    const expandedRange =
      activeRange?.type === "range" ? db.listMessageRange(session.id, activeRange.firstSequence, activeRange.lastSequence) : null;

    expect(itemSpans(tail)).toEqual([
      [5, 5, "message"],
      [6, 6, "range:stack"],
      [7, 7, "message"],
      [8, 8, "range:stack"],
      [9, 9, "message"],
      [10, 120, "range:activity"]
    ]);
    expect(tail.hasMoreBefore).toBe(true);
    expect(tail.hasMoreAfter).toBe(false);
    expect(itemSpans(older)).toEqual([
      [1, 1, "message"],
      [2, 2, "message"],
      [3, 3, "range:stack"],
      [4, 4, "message"]
    ]);
    expect(expandedRange?.items[0]).toMatchObject({ type: "message", message: { text: "Collapsed row 10" } });
    db.close();
  });

  it("collapses repeated assistant output in the active turn to the latest assistant message", async () => {
    const db = await tempDb();
    const session = testSession("session-active-tail-assistant-churn");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(session.id, 1, "user", "Older prompt"));
    db.appendMessage(testMessage(session.id, 2, "assistant", "Older answer"));
    db.appendMessage(testMessage(session.id, 3, "user", "Current prompt"));
    db.appendMessage(testMessage(session.id, 4, "tool", "Tool batch 1", undefined, "tool_output"));
    db.appendMessage(testMessage(session.id, 5, "assistant", "Assistant update 1"));
    db.appendMessage(testMessage(session.id, 6, "tool", "Tool batch 2", undefined, "tool_output"));
    db.appendMessage(testMessage(session.id, 7, "assistant", "Assistant update 2"));
    db.appendMessage(testMessage(session.id, 8, "tool", "Tool batch 3", undefined, "tool_output"));
    db.appendMessage(testMessage(session.id, 9, "assistant", "Newest assistant output"));
    db.appendMessage(testMessage(session.id, 10, "tool", "Trailing tool output", undefined, "tool_output"));

    const tail = db.listActiveTailMessages(session.id, 10);
    const assistantMessages = tail.items.filter((item) => item.type === "message" && item.message.role === "assistant");
    const activeRange = tail.items.find((item) => item.type === "range" && item.firstSequence === 4 && item.lastSequence === 8);
    const expandedRange =
      activeRange?.type === "range" ? db.listMessageRange(session.id, activeRange.firstSequence, activeRange.lastSequence) : null;

    expect(itemSpans(tail)).toEqual([
      [1, 1, "message"],
      [2, 2, "message"],
      [3, 3, "message"],
      [4, 8, "range:activity"],
      [9, 9, "message"],
      [10, 10, "range:stack"]
    ]);
    expect(assistantMessages.map((item) => (item.type === "message" ? item.message.text : ""))).toEqual([
      "Older answer",
      "Newest assistant output"
    ]);
    expect(expandedRange?.items.map((item) => (item.type === "message" ? item.message.text : item.label))).toEqual([
      "Tool batch 1",
      "Assistant update 1",
      "Tool batch 2",
      "Assistant update 2",
      "Tool batch 3"
    ]);
    db.close();
  });

  it("keeps subagent notifications inside the collapsed active turn range", async () => {
    const db = await tempDb();
    const session = testSession("session-active-tail-subagents");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(session.id, 1, "user", "Older prompt"));
    db.appendMessage(testMessage(session.id, 2, "assistant", "Previous answer"));
    db.appendMessage(testMessage(session.id, 3, "user", "Current prompt"));
    db.appendMessage(testMessage(session.id, 4, "tool", "Tool batch 1", undefined, "tool_output"));
    db.appendMessage(testMessage(session.id, 5, "user", subagentNotificationContext()));
    db.appendMessage(testMessage(session.id, 6, "tool", "Tool batch 2", undefined, "tool_output"));
    db.appendMessage(testMessage(session.id, 7, "user", subagentNotificationContext()));
    db.appendMessage(testMessage(session.id, 8, "assistant", "Current answer"));

    const tail = db.listActiveTailMessages(session.id, 10);

    expect(itemSpans(tail)).toEqual([
      [1, 1, "message"],
      [2, 2, "message"],
      [3, 3, "message"],
      [4, 7, "range:activity"],
      [8, 8, "message"]
    ]);
    expect(tail.items.find((item) => item.type === "range" && item.label.includes("subagent"))).toBeUndefined();
    db.close();
  });

  it("skips hidden user context rows when choosing the active tail prompt anchor", async () => {
    const db = await tempDb();
    const session = testSession("session-active-tail-hidden-context");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(session.id, 1, "user", "Older prompt"));
    db.appendMessage(testMessage(session.id, 2, "assistant", "Prior assistant output"));
    db.appendMessage(testMessage(session.id, 3, "user", "Current prompt"));
    db.appendMessage(testMessage(session.id, 4, "assistant", "Current assistant output"));
    db.appendMessage(testMessage(session.id, 5, "user", "<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>"));

    const tail = db.listActiveTailMessages(session.id, 3);

    expect(itemSpans(tail)).toEqual([[2, 2, "message"], [3, 3, "message"], [4, 4, "message"]]);
    expect(tail.hasMoreBefore).toBe(true);
    db.close();
  });

  it("skips instruction plus environment context rows when choosing the active tail prompt anchor", async () => {
    const db = await tempDb();
    const session = testSession("session-active-tail-instruction-context");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(session.id, 1, "user", "Older prompt"));
    db.appendMessage(testMessage(session.id, 2, "assistant", "Prior assistant output"));
    db.appendMessage(testMessage(session.id, 3, "user", "Current prompt"));
    db.appendMessage(testMessage(session.id, 4, "assistant", "Current assistant output"));
    db.appendMessage(testMessage(session.id, 5, "user", initialInstructionContext()));

    const tail = db.listActiveTailMessages(session.id, 4);

    expect(itemSpans(tail)).toEqual([[2, 2, "message"], [3, 3, "message"], [4, 4, "message"], [5, 5, "user_action"]]);
    expect(tail.hasMoreBefore).toBe(true);
    db.close();
  });

  it("starts active tail at the latest visible prompt when there is no prior assistant output", async () => {
    const db = await tempDb();
    const session = testSession("session-active-tail-no-output");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(session.id, 1, "tool", "Initial system-ish output", undefined, "tool_output"));
    db.appendMessage(testMessage(session.id, 2, "user", "First prompt"));
    db.appendMessage(testMessage(session.id, 3, "tool", "Tool output", undefined, "tool_output"));

    const tail = db.listActiveTailMessages(session.id, 2);

    expect(itemSpans(tail)).toEqual([[2, 2, "message"], [3, 3, "range:activity"]]);
    expect(tail.hasMoreBefore).toBe(false);
    expect(tail.hasMoreAfter).toBe(false);
    db.close();
  });

  it("anchors active tail at the progress update when the prior assistant output is a duplicate response", async () => {
    const db = await tempDb();
    const session = testSession("session-active-tail-duplicate-progress");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(session.id, 1, "user", "Older prompt"));
    db.appendMessage(testMessage(session.id, 2, "assistant", "Checking files", undefined, "assistant_update"));
    db.appendMessage(testMessage(session.id, 3, "assistant", "Checking files", undefined, "assistant"));
    db.appendMessage(testMessage(session.id, 4, "user", "Current prompt"));
    db.appendMessage(testMessage(session.id, 5, "tool", "Tool output", undefined, "tool_output"));

    const tail = db.listActiveTailMessages(session.id, 3);

    expect(itemSpans(tail)).toEqual([
      [1, 1, "message"],
      [2, 2, "range:stack"],
      [3, 3, "message"],
      [4, 4, "message"],
      [5, 5, "range:activity"]
    ]);
    expect(tail.hasMoreBefore).toBe(false);
    db.close();
  });

  it("falls back to a fixed recent page when active tail has no visible prompt", async () => {
    const db = await tempDb();
    const session = testSession("session-active-tail-no-prompt");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(session.id, 1, "tool", "Tool 1", undefined, "tool_output"));
    db.appendMessage(testMessage(session.id, 2, "tool", "Tool 2", undefined, "tool_output"));
    db.appendMessage(testMessage(session.id, 3, "tool", "Tool 3", undefined, "tool_output"));

    const tail = db.listActiveTailMessages(session.id, 2);

    expect(itemSpans(tail)).toEqual([[1, 3, "range:stack"]]);
    expect(tail.hasMoreBefore).toBe(false);
    expect(tail.hasMoreAfter).toBe(false);
    db.close();
  });

  it("keeps question requests outside collapsed transcript ranges", async () => {
    const db = await tempDb();
    const session = testSession("session-question-request-range");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(session.id, 1, "user", "Prompt"));
    db.appendMessage(testMessage(session.id, 2, "tool", "Tool before question", undefined, "tool_output"));
    db.appendMessage(testMessage(session.id, 3, "system", "Question requested", undefined, "question_request"));
    db.appendMessage(testMessage(session.id, 4, "tool", "Tool after question", undefined, "tool_output"));

    const tail = db.listRecentMessages(session.id, 10);

    expect(itemSpans(tail)).toEqual([
      [1, 1, "message"],
      [2, 2, "range:activity"],
      [3, 3, "message"],
      [4, 4, "range:activity"]
    ]);
    db.close();
  });

  it("pages earliest and newer transcript messages without loading the full chat", async () => {
    const db = await tempDb();
    const session = testSession("session-pages-forward");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    for (let sequence = 1; sequence <= 7; sequence += 1) {
      db.appendMessage(testMessage(session.id, sequence, "user", `message ${sequence}`));
    }

    const earliest = db.listEarliestMessages(session.id, 3);
    const newer = db.listMessagesAfterPage(session.id, earliest.items.at(-1)?.lastSequence ?? 0, 3);

    expect(itemSpans(earliest)).toEqual([[1, 1, "message"], [2, 2, "message"], [3, 3, "message"]]);
    expect(earliest.hasMoreBefore).toBe(false);
    expect(earliest.hasMoreAfter).toBe(true);
    expect(itemSpans(newer)).toEqual([[4, 4, "message"], [5, 5, "message"], [6, 6, "message"]]);
    expect(newer.hasMoreAfter).toBe(true);
    db.close();
  });

  it("searches the full persisted transcript and returns match metadata", async () => {
    const db = await tempDb();
    const session = testSession("session-transcript-search");
    await db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    await db.appendMessage(testMessage(session.id, 1, "user", "First prompt"));
    await db.appendMessage(testMessage(session.id, 2, "assistant", "Intermediate answer"));
    await db.appendMessage(testMessage(session.id, 3, "tool", "Tool output with distant needle", undefined, "tool_output"));
    await db.appendMessage(testMessage(session.id, 4, "assistant", "<oai-mem-citation>needle hidden metadata</oai-mem-citation>"));
    await db.appendMessage(testMessage(session.id, 5, "user", initialInstructionContext()));

    const search = await db.searchMessages(session.id, "needle", 10);

    expect(search.total).toBe(1);
    expect(search.matches).toEqual([
      expect.objectContaining({
        sequence: 3,
        messageId: `${session.id}-3`,
        itemId: `${session.id}-3`,
        preview: expect.stringContaining("distant needle")
      })
    ]);
    db.close();
  });

  it("loads a bounded expanded transcript page around a search match", async () => {
    const db = await tempDb();
    const session = testSession("session-transcript-around");
    await db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    for (let sequence = 1; sequence <= 9; sequence += 1) {
      const role = sequence === 1 || sequence === 9 ? "user" : "tool";
      const type = role === "tool" ? "tool_output" : "user";
      await db.appendMessage(testMessage(session.id, sequence, role, `message ${sequence}`, undefined, type));
    }

    const page = await db.listMessagesAround(session.id, 5, 3);

    expect(itemSpans(page)).toEqual([[4, 4, "message"], [5, 5, "message"], [6, 6, "message"]]);
    expect(page.hasMoreBefore).toBe(true);
    expect(page.hasMoreAfter).toBe(true);
    db.close();
  });

  it("collapses assistant activity when a newer transcript page starts mid-turn", async () => {
    const db = await tempDb();
    const session = testSession("session-newer-page-mid-turn");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(session.id, 1, "user", "Prompt"));
    db.appendMessage(testMessage(session.id, 2, "assistant", "First answer"));
    db.appendMessage(testMessage(session.id, 3, "tool", "Tool output", undefined, "tool_output"));
    db.appendMessage(testMessage(session.id, 4, "assistant", "Second answer"));
    db.appendMessage(testMessage(session.id, 5, "user", "Next prompt"));

    const newer = db.listMessagesAfterPage(session.id, 1, 10);

    expect(itemSpans(newer)).toEqual([[2, 3, "range:activity"], [4, 4, "message"], [5, 5, "message"]]);
    db.close();
  });

  it("applies transcript page limits to collapsed visible items instead of raw messages", async () => {
    const db = await tempDb();
    const session = testSession("session-visible-item-pages");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(session.id, 1, "user", "First prompt"));
    db.appendMessage(testMessage(session.id, 2, "assistant", "First answer"));
    for (let sequence = 3; sequence <= 20; sequence += 1) {
      db.appendMessage(testMessage(session.id, sequence, "tool", `First hidden row ${sequence}`, undefined, "tool_output"));
    }
    db.appendMessage(testMessage(session.id, 21, "user", "Second prompt"));
    db.appendMessage(testMessage(session.id, 22, "assistant", "Second answer"));
    for (let sequence = 23; sequence <= 40; sequence += 1) {
      db.appendMessage(testMessage(session.id, sequence, "tool", `Second hidden row ${sequence}`, undefined, "tool_output"));
    }

    const recent = db.listRecentMessages(session.id, 4);
    const older = db.listMessagesBefore(session.id, recent.items[0]?.firstSequence ?? 0, 4);

    expect(itemSpans(recent)).toEqual([
      [3, 20, "range:stack"],
      [21, 21, "message"],
      [22, 22, "message"],
      [23, 40, "range:stack"]
    ]);
    expect(recent.hasMoreBefore).toBe(true);
    expect(itemSpans(older)).toEqual([[1, 1, "message"], [2, 2, "message"]]);
    expect(older.hasMoreBefore).toBe(false);
    expect(older.hasMoreAfter).toBe(true);
    db.close();
  });

  it("reports no older transcript page when the oldest row is loaded", async () => {
    const db = await tempDb();
    const session = testSession("session-page-end");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    for (let sequence = 1; sequence <= 3; sequence += 1) {
      db.appendMessage(testMessage(session.id, sequence, "user", `message ${sequence}`));
    }

    const recent = db.listRecentMessages(session.id, 5);

    expect(itemSpans(recent)).toEqual([[1, 1, "message"], [2, 2, "message"], [3, 3, "message"]]);
    expect(recent.hasMoreBefore).toBe(false);
    expect(recent.hasMoreAfter).toBe(false);
    db.close();
  });

  it("sorts sessions by latest session activity", async () => {
    const db = await tempDb();
    const olderUserInput = testSession("older-user-input");
    const newerSessionActivity = testSession("newer-session-activity");
    db.upsertSession(olderUserInput, "2026-07-07T00:00:00.000Z");
    db.upsertSession(newerSessionActivity, "2026-07-07T00:00:00.000Z");

    db.appendMessage(testMessage(olderUserInput.id, 1, "user", "Older user prompt", "2026-07-07T00:00:01.000Z"));
    db.appendMessage(testMessage(olderUserInput.id, 2, "assistant", "Later assistant answer", "2026-07-07T00:00:04.000Z"));
    db.appendMessage(testMessage(newerSessionActivity.id, 1, "user", "Newer user prompt", "2026-07-07T00:00:02.000Z"));
    db.appendMessage(testMessage(newerSessionActivity.id, 2, "tool", "Tool output", "2026-07-07T00:00:05.000Z", "tool_output"));

    const sessions = db.listSessions();

    expect(sessions.map((session) => session.id)).toEqual([newerSessionActivity.id, olderUserInput.id]);
    expect(sessions[0]?.lastActivityAt).toBe("2026-07-07T00:00:05.000Z");
    expect(sessions[1]?.lastActivityAt).toBe("2026-07-07T00:00:04.000Z");
    db.close();
  });

  it("keeps summaries and previews limited to displayable prompts", async () => {
    const db = await tempDb();
    const contextOnly = testSession("context-only");
    const realPrompt = testSession("real-prompt");
    db.upsertSession(contextOnly, "2026-07-07T00:00:00.000Z");
    db.upsertSession(realPrompt, "2026-07-07T00:00:00.000Z");

    db.appendMessage(testMessage(contextOnly.id, 1, "user", initialInstructionContext(), "2026-07-07T00:00:04.000Z"));
    db.appendMessage(testMessage(realPrompt.id, 1, "user", "Actual prompt", "2026-07-07T00:00:01.000Z"));
    db.appendMessage(testMessage(realPrompt.id, 2, "user", initialInstructionContext(), "2026-07-07T00:00:05.000Z"));

    const sessions = db.listSessions();
    const summaryPrompts = db.listRecentUserPromptsForSummary(realPrompt.id);

    const realPromptSession = sessions.find((session) => session.id === realPrompt.id);
    const contextOnlySession = sessions.find((session) => session.id === contextOnly.id);
    expect(realPromptSession?.lastActivityAt).toBe("2026-07-07T00:00:05.000Z");
    expect(realPromptSession?.recentUserPrompts).toEqual(["Actual prompt"]);
    expect(contextOnlySession?.lastActivityAt).toBe("2026-07-07T00:00:04.000Z");
    expect(contextOnlySession?.recentUserPrompts).toEqual([]);
    expect(summaryPrompts.map((message) => message.text)).toEqual(["Actual prompt"]);
    db.close();
  });
});

describe("AppDatabase OpenAI usage summaries", () => {
  it("aggregates usage into zero-filled daily buckets", async () => {
    const db = await tempDb();
    db.recordOpenAIUsage({
      id: "usage-1",
      source: "activity_summary",
      sourceId: "session-1",
      model: "gpt-4.1-mini",
      responseId: "resp_1",
      createdAt: "2026-07-06T12:00:00.000Z",
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 10,
      totalTokens: 110,
      estimatedCostUsd: 0.001,
      pricingStatus: "priced"
    });
    db.recordOpenAIUsage({
      id: "usage-2",
      source: "activity_summary",
      sourceId: "session-2",
      model: "gpt-4.1-mini",
      responseId: "resp_2",
      createdAt: "2026-07-07T16:00:00.000Z",
      inputTokens: 300,
      cachedInputTokens: 0,
      outputTokens: 40,
      totalTokens: 340,
      estimatedCostUsd: 0.002,
      pricingStatus: "priced"
    });

    const summary = db.summarizeOpenAIUsage(3, new Date("2026-07-07T20:00:00.000Z"));

    expect(summary.points.map((point) => point.date)).toEqual(["2026-07-05", "2026-07-06", "2026-07-07"]);
    expect(summary.points.map((point) => point.requestCount)).toEqual([0, 1, 1]);
    expect(summary.totals.requestCount).toBe(2);
    expect(summary.totals.totalTokens).toBe(450);
    expect(summary.totals.estimatedCostUsd).toBeCloseTo(0.003);
    db.close();
  });

  it("keeps unpriced usage out of cost totals and reports the model", async () => {
    const db = await tempDb();
    db.recordOpenAIUsage({
      id: "usage-unpriced",
      source: "activity_summary",
      sourceId: "session-1",
      model: "custom-model",
      responseId: null,
      createdAt: "2026-07-07T12:00:00.000Z",
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 10,
      totalTokens: 110,
      estimatedCostUsd: null,
      pricingStatus: "unpriced"
    });

    const summary = db.summarizeOpenAIUsage(1, new Date("2026-07-07T20:00:00.000Z"));

    expect(summary.totals.requestCount).toBe(1);
    expect(summary.totals.estimatedCostUsd).toBeNull();
    expect(summary.unpricedModels).toEqual(["custom-model"]);
    db.close();
  });
});

describe("AppDatabase activity summary settings", () => {
  it("defaults activity summaries to enabled", async () => {
    const db = await tempDb();

    expect(await db.getActivitySummariesEnabled()).toBe(true);
    db.close();
  });

  it("persists activity summary enablement", async () => {
    const db = await tempDb();

    await db.setActivitySummariesEnabled(false);
    expect(await db.getActivitySummariesEnabled()).toBe(false);
    await db.setActivitySummariesEnabled(true);
    expect(await db.getActivitySummariesEnabled()).toBe(true);
    db.close();
  });
});

describe("AppDatabase remote access settings", () => {
  it("defaults unrestricted remote access to disabled", async () => {
    const db = await tempDb();

    expect(await db.getUnrestrictedRemoteAccessEnabled()).toBe(false);
    db.close();
  });

  it("persists unrestricted remote access enablement", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muxpilot-db-"));
    const path = join(dir, "test.db");
    const db = new AppDatabase(path);

    await db.setUnrestrictedRemoteAccessEnabled(true);
    expect(await db.getUnrestrictedRemoteAccessEnabled()).toBe(true);
    db.close();

    const restarted = new AppDatabase(path);
    expect(await restarted.getUnrestrictedRemoteAccessEnabled()).toBe(true);
    await restarted.setUnrestrictedRemoteAccessEnabled(false);
    expect(await restarted.getUnrestrictedRemoteAccessEnabled()).toBe(false);
    restarted.close();
  });
});

describe("AppDatabase queued inputs", () => {
  it("clears sent queued inputs after a normalized transcript echo", async () => {
    const db = await tempDb();
    const session = testSession("session-queue-normalized");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendQueuedInput(
      testQueuedInput(session.id, {
        id: "queued-1",
        text: "Fix repo validation gaps:\n\n:add prettier to UI dev dependencies",
        status: "sent",
        createdAt: "2026-07-07T00:00:01.000Z",
        updatedAt: "2026-07-07T00:00:03.000Z",
        sentAt: "2026-07-07T00:00:03.000Z"
      })
    );
    db.appendMessage(
      testMessage(
        session.id,
        1,
        "user",
        "Fix repo validation gaps\n\nadd prettier to UI dev dependencies",
        "2026-07-07T00:00:02.000Z"
      )
    );

    expect(await db.deleteEchoedSentQueuedInputs(session.id)).toBe(1);
    expect(await db.listQueuedInputs(session.id)).toEqual([]);
    db.close();
  });

  it("keeps sent queued inputs when later user messages are unrelated", async () => {
    const db = await tempDb();
    const session = testSession("session-queue-unrelated");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    const input = testQueuedInput(session.id, {
      id: "queued-1",
      text: "Implement the custom integration route tests",
      status: "sent",
      createdAt: "2026-07-07T00:00:01.000Z",
      updatedAt: "2026-07-07T00:00:02.000Z",
      sentAt: "2026-07-07T00:00:02.000Z"
    });
    db.appendQueuedInput(input);
    db.appendMessage(testMessage(session.id, 1, "user", "Open the notification settings", "2026-07-07T00:00:03.000Z"));

    expect(await db.deleteEchoedSentQueuedInputs(session.id)).toBe(0);
    expect(await db.listQueuedInputs(session.id)).toEqual([input]);
    db.close();
  });
});

describe("AppDatabase notifications", () => {
  it("persists global and per-session notification rules", async () => {
    const db = await tempDb();
    const deviceId = "device-test";

    expect(await db.getNotificationSettings(deviceId)).toEqual({ globalRules: [], sessionRules: {}, delivery: { pushEnabled: false, soundEnabled: true } });
    await db.setNotificationRule(deviceId, "global", null, "status_change", true, "2026-07-08T00:00:00.000Z");
    await db.setNotificationRule(deviceId, "session", "session-1", "done_task", true, "2026-07-08T00:00:01.000Z");
    await db.setNotificationRule(deviceId, "session", "session-1", "approval_gate", true, "2026-07-08T00:00:02.000Z");

    expect(await db.getNotificationSettings(deviceId)).toEqual({
      globalRules: ["status_change"],
      sessionRules: { "session-1": ["approval_gate", "done_task"] },
      delivery: { pushEnabled: false, soundEnabled: true }
    });

    await db.setNotificationRule(deviceId, "session", "session-1", "done_task", false, "2026-07-08T00:00:03.000Z");
    expect(await db.getNotificationSettings(deviceId)).toEqual({
      globalRules: ["status_change"],
      sessionRules: { "session-1": ["approval_gate"] },
      delivery: { pushEnabled: false, soundEnabled: true }
    });
    db.close();
  });

  it("keeps notification settings separate per device", async () => {
    const db = await tempDb();

    await db.setNotificationRule("device-one", "global", null, "status_change", true, "2026-07-08T00:00:00.000Z");
    await db.setNotificationRule("device-two", "session", "session-1", "done_task", true, "2026-07-08T00:00:01.000Z");
    await db.setNotificationDeliverySetting("device-two", "sound", false, "2026-07-08T00:00:02.000Z");
    await db.setNotificationDeliverySetting("device-two", "push", true, "2026-07-08T00:00:03.000Z");

    expect(await db.getNotificationSettings("device-one")).toEqual({
      globalRules: ["status_change"],
      sessionRules: {},
      delivery: { pushEnabled: false, soundEnabled: true }
    });
    expect(await db.getNotificationSettings("device-two")).toEqual({
      globalRules: [],
      sessionRules: { "session-1": ["done_task"] },
      delivery: { pushEnabled: true, soundEnabled: false }
    });
    expect(await db.listNotificationSettings()).toEqual({
      "device-one": {
        globalRules: ["status_change"],
        sessionRules: {},
        delivery: { pushEnabled: false, soundEnabled: true }
      },
      "device-two": {
        globalRules: [],
        sessionRules: { "session-1": ["done_task"] },
        delivery: { pushEnabled: true, soundEnabled: false }
      }
    });
    db.close();
  });

  it("persists push subscriptions and VAPID keys", async () => {
    const db = await tempDb();
    const deviceId = "device-test";
    const subscription = {
      endpoint: "https://example.test/push/1",
      expirationTime: null,
      keys: { p256dh: "p256dh", auth: "auth" }
    };

    await db.upsertPushSubscription(deviceId, subscription, "2026-07-08T00:00:00.000Z");
    await db.setPushVapidKeys({ publicKey: "public", privateKey: "private" }, "2026-07-08T00:00:01.000Z");

    expect(await db.listPushSubscriptions(deviceId)).toEqual([{ ...subscription, deviceId }]);
    expect(await db.getPushVapidKeys()).toEqual({ publicKey: "public", privateKey: "private" });
    await db.deletePushSubscription(deviceId, subscription.endpoint);
    expect(await db.listPushSubscriptions(deviceId)).toEqual([]);
    db.close();
  });
});

describe("AppDatabase touched repositories", () => {
  it("persists dismissals until the directory is touched again", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muxpilot-db-"));
    const path = join(dir, "test.db");
    const db = new AppDatabase(path);
    const repository = {
      path: "/repo/old",
      label: "old",
      repoRoot: "/repo/old",
      branch: "main",
      lastActivityAt: "2026-07-08T00:00:00.000Z"
    };

    await db.upsertTouchedRepository(repository, "2026-07-08T00:00:00.000Z");
    await db.dismissSessionDirectory(repository.path, "2026-07-08T01:00:00.000Z");
    expect(await db.listDismissedSessionDirectories()).toEqual([repository.path]);
    db.close();

    const restarted = new AppDatabase(path);
    expect(await restarted.listDismissedSessionDirectories()).toEqual([repository.path]);
    await restarted.upsertTouchedRepository(
      { ...repository, lastActivityAt: "2026-07-08T00:30:00.000Z" },
      "2026-07-08T03:00:00.000Z"
    );
    expect(await restarted.listDismissedSessionDirectories()).toEqual([repository.path]);
    await restarted.upsertTouchedRepository(
      { ...repository, lastActivityAt: "2026-07-08T02:00:00.000Z" },
      "2026-07-08T03:00:00.000Z"
    );
    expect(await restarted.listDismissedSessionDirectories()).toEqual([]);
    restarted.close();
  });

  it("persists touched repositories in recency order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muxpilot-db-"));
    const path = join(dir, "test.db");
    const db = new AppDatabase(path);

    await db.upsertTouchedRepository(
      {
        path: "/repo/older",
        label: "older",
        repoRoot: "/repo/older",
        branch: "main",
        lastActivityAt: "2026-07-08T00:00:00.000Z"
      },
      "2026-07-08T00:00:00.000Z"
    );
    await db.upsertTouchedRepository(
      {
        path: "/repo/newer",
        label: "newer",
        repoRoot: "/repo/newer",
        branch: "dev",
        lastActivityAt: "2026-07-08T01:00:00.000Z"
      },
      "2026-07-08T01:00:00.000Z"
    );
    db.close();

    const restarted = new AppDatabase(path);
    expect(await restarted.listTouchedRepositories()).toEqual([
      {
        path: "/repo/newer",
        label: "newer",
        repoRoot: "/repo/newer",
        branch: "dev",
        source: "recent",
        lastActivityAt: "2026-07-08T01:00:00.000Z"
      },
      {
        path: "/repo/older",
        label: "older",
        repoRoot: "/repo/older",
        branch: "main",
        source: "recent",
        lastActivityAt: "2026-07-08T00:00:00.000Z"
      }
    ]);
    restarted.close();
  });

  it("keeps the latest repository activity when an older touch is upserted", async () => {
    const db = await tempDb();

    await db.upsertTouchedRepository(
      {
        path: "/repo",
        label: "repo",
        repoRoot: "/repo",
        branch: "main",
        lastActivityAt: "2026-07-08T02:00:00.000Z"
      },
      "2026-07-08T02:00:00.000Z"
    );
    await db.upsertTouchedRepository(
      {
        path: "/repo",
        label: "repo-renamed",
        repoRoot: "/repo",
        branch: "stage",
        lastActivityAt: "2026-07-08T01:00:00.000Z"
      },
      "2026-07-08T03:00:00.000Z"
    );

    expect(await db.listTouchedRepositories()).toEqual([
      {
        path: "/repo",
        label: "repo-renamed",
        repoRoot: "/repo",
        branch: "stage",
        source: "recent",
        lastActivityAt: "2026-07-08T02:00:00.000Z"
      }
    ]);
    db.close();
  });

  it("backfills touched repositories from existing managed sessions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muxpilot-db-"));
    const path = join(dir, "test.db");
    const db = new AppDatabase(path);
    await db.upsertSession(
      {
        ...testSession("session-1"),
        repo: { root: "/repo/backfilled", name: "backfilled", branch: "main", dirty: false, worktree: null },
        tmux: { ...testSession("session-1").tmux, cwd: "/repo/backfilled" },
        lastActivityAt: "2026-07-08T04:00:00.000Z"
      },
      "2026-07-08T04:00:01.000Z"
    );
    await db.dismissSessionDirectory("/repo/backfilled", "2026-07-08T05:00:00.000Z");
    db.close();

    const restarted = new AppDatabase(path);
    expect(await restarted.listDismissedSessionDirectories()).toEqual(["/repo/backfilled"]);
    expect(await restarted.listTouchedRepositories()).toEqual([
      {
        path: "/repo/backfilled",
        label: "backfilled",
        repoRoot: "/repo/backfilled",
        branch: "main",
        source: "recent",
        lastActivityAt: "2026-07-08T04:00:00.000Z"
      }
    ]);
    restarted.close();
  });
});

async function tempDb(): Promise<AppDatabase> {
  const dir = await mkdtemp(join(tmpdir(), "muxpilot-db-"));
  return new AppDatabase(join(dir, "test.db"));
}

function itemSpans(page: TranscriptPageResponse): Array<[number, number, string]> {
  return page.items.map((item) => [
    item.firstSequence,
    item.lastSequence,
    item.type === "range" ? `range:${item.rangeKind}` : item.type
  ]);
}

function testSession(id: string): ManagedSession {
  return {
    id,
    tmux: {
      sessionId: "tmux-session",
      sessionName: "work",
      windowId: "@1",
      windowIndex: 1,
      windowName: "codex",
      paneId: "%1",
      paneIndex: 0,
      paneActive: true,
      cwd: "/repo",
      currentCommand: "node",
      title: "codex",
      pid: 123,
      size: "120x40"
    },
    repo: {
      root: "/repo",
      name: "repo",
      branch: "main",
      dirty: false,
      worktree: null
    },
    codexSessionId: "codex-session",
    codexJsonlPath: "/tmp/codex.jsonl",
    discoveryConfidence: "high",
    status: "waiting",
    lastActivityAt: null,
    preview: "",
    recentUserPrompts: [],
    activitySummary: null,
    activitySummaryGeneratedAt: null,
    activitySummarySourceSequence: null,
    inputMode: "default",
    models: { default: { model: null, reasoningEffort: null }, plan: { model: null, reasoningEffort: null } },
    transcriptSize: 0,
    unreadCount: 0,
    pinned: false,
    archived: false
  };
}

function testMessage(
  sessionId: string,
  sequence: number,
  role: ChatMessage["role"],
  text: string,
  timestamp = `2026-07-07T00:00:0${sequence}.000Z`,
  type: ChatMessage["type"] = role === "user" ? "user" : "assistant"
): ChatMessage {
  return {
    id: `${sessionId}-${sequence}`,
    sessionId,
    sequence,
    type,
    role,
    timestamp,
    text,
    payload: {}
  };
}

function testQueuedInput(sessionId: string, input: Partial<QueuedInput> & Pick<QueuedInput, "id" | "text" | "status">): QueuedInput {
  return {
    sessionId,
    mode: "default",
    error: null,
    codexSessionId: "codex-session",
    codexJsonlPath: "/tmp/codex.jsonl",
    createdAt: "2026-07-07T00:00:01.000Z",
    updatedAt: "2026-07-07T00:00:01.000Z",
    sentAt: null,
    ...input
  };
}

function testGitWorkspace(sessionId: string, workspaceId = "workspace-rekey"): StoredGitWorkspace {
  const timestamp = "2026-07-07T00:00:05.000Z";
  return {
    id: workspaceId,
    sessionId,
    commonGitDir: "/repo/.git",
    helperToken: "test-helper-token",
    createdAt: timestamp,
    updatedAt: timestamp,
    summary: {
      workflowVersion: 1,
      id: workspaceId,
      state: "worktree",
      entryPath: "/repo",
      repoRoot: "/repo",
      targetBranch: "main",
      targetSha: "a".repeat(40),
      sessionBranch: `muxpilot/${workspaceId}`,
      worktreePath: `/tmp/${workspaceId}`,
      lastError: null,
      updatedAt: timestamp,
      dependencyLinks: []
    }
  };
}

function initialInstructionContext(): string {
  return [
    "# AGENTS.md instructions for /home/dev/workspace/teamweave",
    "",
    "<INSTRUCTIONS>",
    "# Repository Guidelines",
    "",
    "## Directory-Local Rules",
    "Before changing files in a directory, read that directory's AGENTS.md.",
    "</INSTRUCTIONS>",
    "",
    "<environment_context>",
    "  <cwd>/home/dev/workspace/teamweave</cwd>",
    "  <shell>bash</shell>",
    "</environment_context>"
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
