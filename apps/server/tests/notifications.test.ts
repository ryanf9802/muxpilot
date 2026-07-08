import { describe, expect, it, vi } from "vitest";
import type { ManagedSession, SessionEvent } from "@muxpilot/core";
import { matchingNotificationRules, NotificationService } from "../src/services/notifications.js";
import { EventBus } from "../src/services/eventBus.js";

describe("matchingNotificationRules", () => {
  it("fires done task only for yellow to waiting transitions", () => {
    const settings = { globalRules: [], sessionRules: { a: ["done_task" as const] } };

    expect(matchingNotificationRules(settings, "a", "working", "waiting")).toEqual(["done_task"]);
    expect(matchingNotificationRules(settings, "a", "waiting", "waiting")).toEqual([]);
    expect(matchingNotificationRules(settings, "a", "approval", "waiting")).toEqual([]);
  });

  it("fires approval gate for red target statuses", () => {
    const settings = { globalRules: ["approval_gate" as const], sessionRules: {} };

    expect(matchingNotificationRules(settings, "a", "working", "approval")).toEqual(["approval_gate"]);
    expect(matchingNotificationRules(settings, "a", "working", "question")).toEqual(["approval_gate"]);
    expect(matchingNotificationRules(settings, "a", "working", "waiting")).toEqual([]);
  });

  it("fires status change on any actual transition", () => {
    const settings = { globalRules: ["status_change" as const], sessionRules: {} };

    expect(matchingNotificationRules(settings, "a", "working", "planning")).toEqual(["status_change"]);
    expect(matchingNotificationRules(settings, "a", "working", "working")).toEqual([]);
  });

  it("combines overlapping global and session rules once", () => {
    const settings = {
      globalRules: ["status_change" as const, "done_task" as const],
      sessionRules: { a: ["done_task" as const, "approval_gate" as const] }
    };

    expect(matchingNotificationRules(settings, "a", "working", "waiting")).toEqual(["done_task", "status_change"]);
  });

  it("does not fire notifications for sessions becoming missing", () => {
    const settings = {
      globalRules: ["approval_gate" as const, "status_change" as const],
      sessionRules: { a: ["approval_gate" as const, "status_change" as const] }
    };

    expect(matchingNotificationRules(settings, "a", "waiting", "missing")).toEqual([]);
  });

  it("fires done task from discovered session updates", async () => {
    const events = new EventBus();
    const appendedEvents: SessionEvent[] = [];
    const service = new NotificationService(
      {
        getPushVapidKeys: async () => ({ publicKey: "public", privateKey: "private" }),
        listSessions: async () => [testSession({ status: "working" })],
        getNotificationSettings: async () => ({ globalRules: ["done_task"], sessionRules: {} }),
        getSession: async () => testSession({ status: "waiting" }),
        appendEvent: async (event: SessionEvent) => {
          appendedEvents.push(event);
        },
        listPushSubscriptions: async () => []
      } as never,
      events,
      { warn: () => undefined, error: () => undefined } as never
    );
    const transitionHandler = service as unknown as { handleStatusTransition: (sessionId: string, nextStatus: "working" | "waiting") => Promise<void> };
    await transitionHandler.handleStatusTransition("a", "working");
    await transitionHandler.handleStatusTransition("a", "waiting");

    await vi.waitFor(() => expect(appendedEvents).toHaveLength(1));
    expect(appendedEvents[0]).toMatchObject({
      type: "notification.triggered",
      sessionId: "a",
      payload: {
        rules: ["done_task"],
        previousStatus: "working",
        status: "waiting"
      }
    });
  });
});

function testSession(input: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: "a",
    tmux: {
      sessionId: "tmux",
      sessionName: "work",
      windowId: "@1",
      windowIndex: 1,
      windowName: "muxpilot",
      paneId: "%1",
      paneIndex: 0,
      paneActive: true,
      cwd: "/repo",
      currentCommand: "node",
      title: "codex",
      pid: 123,
      size: "120x40"
    },
    repo: { root: "/repo", name: "repo", branch: "main", dirty: false, worktree: null },
    codexSessionId: "codex",
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
    archived: false,
    ...input
  };
}
