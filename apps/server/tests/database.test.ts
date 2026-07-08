import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChatMessage, ManagedSession, TranscriptPageResponse } from "@muxpilot/core";
import { AppDatabase } from "../src/db/database.js";

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

  it("excludes hidden user context from prompt history", async () => {
    const db = await tempDb();
    const session = testSession("session-history-context");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(session.id, 1, "user", initialInstructionContext(), "2026-07-07T00:00:01.000Z"));
    db.appendMessage(testMessage(session.id, 2, "user", "Actual searchable prompt", "2026-07-07T00:00:02.000Z"));

    const history = await db.listPromptHistory("", 10);

    expect(history.map((result) => result.text)).toEqual(["Actual searchable prompt"]);
    db.close();
  });

  it("ranks prompt history by exact, substring, fuzzy match, then recency", async () => {
    const db = await tempDb();
    const session = testSession("session-history-ranking");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(session.id, 1, "user", "xylophone graph", "2026-07-07T00:00:04.000Z"));
    db.appendMessage(testMessage(session.id, 2, "user", "graph", "2026-07-07T00:00:01.000Z"));
    db.appendMessage(testMessage(session.id, 3, "user", "build a graph view", "2026-07-07T00:00:02.000Z"));
    db.appendMessage(testMessage(session.id, 4, "user", "gather rough app hints", "2026-07-07T00:00:03.000Z"));

    const history = await db.listPromptHistory("graph", 10);

    expect(history.map((result) => result.text)).toEqual([
      "graph",
      "xylophone graph",
      "build a graph view",
      "gather rough app hints"
    ]);
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

    expect(itemSpans(tail)).toEqual([[4, 4, "message"], [5, 5, "range:stack"], [6, 6, "message"], [7, 16, "range:activity"]]);
    expect(tail.hasMoreBefore).toBe(false);
    expect(tail.hasMoreAfter).toBe(false);

    const older = db.listMessagesBefore(session.id, tail.items[0]?.firstSequence ?? 0, 3);
    expect(itemSpans(older)).toEqual([[1, 1, "message"], [2, 2, "message"], [3, 3, "range:stack"]]);
    expect(older.hasMoreBefore).toBe(false);
    db.close();
  });

  it("does not backfill the active transcript tail with older turns when current noise collapses", async () => {
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

    expect(itemSpans(tail)).toEqual([[4, 4, "message"], [5, 5, "message"], [6, 6, "message"]]);
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

    expect(itemSpans(tail)).toEqual([[91, 91, "message"], [92, 92, "message"], [93, 93, "message"]]);
    expect(tail.hasMoreBefore).toBe(true);
    expect(tail.hasMoreAfter).toBe(false);

    const older = db.listMessagesBefore(session.id, tail.items[0]?.firstSequence ?? 0, 80);
    expect(older.items).toHaveLength(80);
    expect(older.items[0]?.firstSequence).toBe(11);
    expect(older.items.at(-1)?.lastSequence).toBe(90);
    expect(older.hasMoreBefore).toBe(true);
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
      [4, 4, "message"],
      [5, 5, "message"],
      [6, 6, "range:stack"]
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

    expect(itemSpans(tail)).toEqual([[2, 2, "range:stack"], [3, 3, "message"], [4, 4, "message"], [5, 5, "range:activity"]]);
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

describe("AppDatabase notifications", () => {
  it("persists global and per-session notification rules", async () => {
    const db = await tempDb();

    expect(await db.getNotificationSettings()).toEqual({ globalRules: [], sessionRules: {} });
    await db.setNotificationRule("global", null, "status_change", true, "2026-07-08T00:00:00.000Z");
    await db.setNotificationRule("session", "session-1", "done_task", true, "2026-07-08T00:00:01.000Z");
    await db.setNotificationRule("session", "session-1", "approval_gate", true, "2026-07-08T00:00:02.000Z");

    expect(await db.getNotificationSettings()).toEqual({
      globalRules: ["status_change"],
      sessionRules: { "session-1": ["approval_gate", "done_task"] }
    });

    await db.setNotificationRule("session", "session-1", "done_task", false, "2026-07-08T00:00:03.000Z");
    expect(await db.getNotificationSettings()).toEqual({
      globalRules: ["status_change"],
      sessionRules: { "session-1": ["approval_gate"] }
    });
    db.close();
  });

  it("persists push subscriptions and VAPID keys", async () => {
    const db = await tempDb();
    const subscription = {
      endpoint: "https://example.test/push/1",
      expirationTime: null,
      keys: { p256dh: "p256dh", auth: "auth" }
    };

    await db.upsertPushSubscription(subscription, "2026-07-08T00:00:00.000Z");
    await db.setPushVapidKeys({ publicKey: "public", privateKey: "private" }, "2026-07-08T00:00:01.000Z");

    expect(await db.listPushSubscriptions()).toEqual([subscription]);
    expect(await db.getPushVapidKeys()).toEqual({ publicKey: "public", privateKey: "private" });
    await db.deletePushSubscription(subscription.endpoint);
    expect(await db.listPushSubscriptions()).toEqual([]);
    db.close();
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
