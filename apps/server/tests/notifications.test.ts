import { describe, expect, it, vi } from "vitest";
import webPush from "web-push";
import type { ManagedSession, NotificationRuleType, NotificationSettings, SessionEvent } from "@muxpilot/core";
import { matchingNotificationRules, NotificationService } from "../src/services/notifications.js";
import { EventBus } from "../src/services/eventBus.js";

describe("matchingNotificationRules", () => {
  it("fires done task only for yellow to waiting transitions", () => {
    const settings = testNotificationSettings([], { a: ["done_task"] });

    expect(matchingNotificationRules(settings, "a", "working", "waiting")).toEqual(["done_task"]);
    expect(matchingNotificationRules(settings, "a", "generating", "idle")).toEqual(["done_task"]);
    expect(matchingNotificationRules(settings, "a", "planning", "waiting")).toEqual([]);
    expect(matchingNotificationRules(settings, "a", "working", "waiting", { inputMode: "plan" })).toEqual([]);
    expect(matchingNotificationRules(settings, "a", "waiting", "waiting")).toEqual([]);
    expect(matchingNotificationRules(settings, "a", "approval", "waiting")).toEqual([]);
  });

  it("fires approval gate for red target statuses", () => {
    const settings = testNotificationSettings(["approval_gate"]);

    expect(matchingNotificationRules(settings, "a", "working", "approval")).toEqual(["approval_gate"]);
    expect(matchingNotificationRules(settings, "a", "working", "question")).toEqual(["approval_gate"]);
    expect(matchingNotificationRules(settings, "a", "working", "waiting")).toEqual([]);
  });

  it("fires status change on any actual transition", () => {
    const settings = testNotificationSettings(["status_change"]);

    expect(matchingNotificationRules(settings, "a", "working", "planning")).toEqual(["status_change"]);
    expect(matchingNotificationRules(settings, "a", "working", "waiting", { inputMode: "plan" })).toEqual([]);
    expect(matchingNotificationRules(settings, "a", "working", "working")).toEqual([]);
  });

  it("combines overlapping global and session rules once", () => {
    const settings = {
      globalRules: ["status_change" as const, "done_task" as const],
      sessionRules: { a: ["done_task" as const, "approval_gate" as const] },
      delivery: { pushEnabled: false, soundEnabled: true }
    };

    expect(matchingNotificationRules(settings, "a", "working", "waiting")).toEqual(["done_task", "status_change"]);
  });

  it("does not fire notifications for sessions becoming missing", () => {
    const settings = {
      globalRules: ["approval_gate" as const, "status_change" as const],
      sessionRules: { a: ["approval_gate" as const, "status_change" as const] },
      delivery: { pushEnabled: false, soundEnabled: true }
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
        listNotificationSettings: async () => ({ "device-test": testNotificationSettings(["done_task"]) }),
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
        deviceId: "device-test",
        rules: ["done_task"],
        previousStatus: "working",
        status: "waiting"
      }
    });
  });

  it("matches rules per device and sends push only when enabled", async () => {
    const events = new EventBus();
    const appendedEvents: SessionEvent[] = [];
    const sendNotification = vi.spyOn(webPush, "sendNotification").mockResolvedValue({} as never);
    const service = new NotificationService(
      {
        getPushVapidKeys: async () => ({ publicKey: "public", privateKey: "private" }),
        listSessions: async () => [testSession({ status: "working" })],
        listNotificationSettings: async () => ({
          "device-muted": testNotificationSettings(["done_task"], {}, { pushEnabled: false, soundEnabled: true }),
          "device-push": testNotificationSettings(["done_task"], {}, { pushEnabled: true, soundEnabled: true })
        }),
        getSession: async () => testSession({ status: "waiting" }),
        appendEvent: async (event: SessionEvent) => {
          appendedEvents.push(event);
        },
        listPushSubscriptions: async (deviceId: string) => [
          {
            deviceId,
            endpoint: `https://example.test/${deviceId}`,
            expirationTime: null,
            keys: { p256dh: "p256dh", auth: "auth" }
          }
        ],
        deletePushSubscription: async () => undefined
      } as never,
      events,
      { warn: () => undefined, error: () => undefined } as never
    );
    const transitionHandler = service as unknown as { handleStatusTransition: (sessionId: string, nextStatus: "working" | "waiting") => Promise<void> };

    try {
      await transitionHandler.handleStatusTransition("a", "working");
      await transitionHandler.handleStatusTransition("a", "waiting");

      await vi.waitFor(() => expect(appendedEvents).toHaveLength(2));
      expect(appendedEvents.map((event) => (event.payload as { deviceId: string }).deviceId).sort()).toEqual(["device-muted", "device-push"]);
      expect(sendNotification).toHaveBeenCalledTimes(1);
      expect(sendNotification.mock.calls[0]?.[0].endpoint).toBe("https://example.test/device-push");
    } finally {
      sendNotification.mockRestore();
    }
  });

  it("does not fire done task for plan-mode sessions that briefly look waiting", async () => {
    const events = new EventBus();
    const appendedEvents: SessionEvent[] = [];
    const service = new NotificationService(
      {
        getPushVapidKeys: async () => ({ publicKey: "public", privateKey: "private" }),
        listSessions: async () => [testSession({ status: "working", inputMode: "plan" })],
        listNotificationSettings: async () => ({ "device-test": testNotificationSettings(["done_task"]) }),
        getSession: async () => testSession({ status: "waiting", inputMode: "plan" }),
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

    expect(appendedEvents).toEqual([]);
  });

  it("uses reconciled startup statuses as the notification baseline", async () => {
    const events = new EventBus();
    const appendedEvents: SessionEvent[] = [];
    let currentStatus: ManagedSession["status"] = "waiting";
    const vapidKeys = webPush.generateVAPIDKeys();
    const service = new NotificationService(
      {
        getPushVapidKeys: async () => vapidKeys,
        listSessions: async () => [testSession({ status: currentStatus })],
        listNotificationSettings: async () => ({ "device-test": testNotificationSettings(["done_task"]) }),
        getSession: async () => testSession({ status: currentStatus }),
        appendEvent: async (event: SessionEvent) => {
          appendedEvents.push(event);
        },
        listPushSubscriptions: async () => []
      } as never,
      events,
      { warn: () => undefined, error: () => undefined } as never
    );

    await service.start();
    events.publish({
      id: "event-startup-waiting",
      type: "session.updated",
      sessionId: "a",
      payload: testSession({ status: "waiting" }),
      timestamp: "2026-07-08T00:00:00.000Z"
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(appendedEvents).toEqual([]);

    currentStatus = "working";
    events.publish({
      id: "event-working",
      type: "session.updated",
      sessionId: "a",
      payload: testSession({ status: "working" }),
      timestamp: "2026-07-08T00:00:01.000Z"
    });
    currentStatus = "waiting";
    events.publish({
      id: "event-waiting",
      type: "session.updated",
      sessionId: "a",
      payload: testSession({ status: "waiting" }),
      timestamp: "2026-07-08T00:00:02.000Z"
    });

    await vi.waitFor(() => expect(appendedEvents).toHaveLength(1));
    expect(appendedEvents[0]).toMatchObject({
      type: "notification.triggered",
      sessionId: "a",
      payload: {
        deviceId: "device-test",
        rules: ["done_task"],
        previousStatus: "working",
        status: "waiting"
      }
    });
    service.stop();
  });

  it("does not alert for an already-actionable status present at startup", async () => {
    const events = new EventBus();
    const appendedEvents: SessionEvent[] = [];
    const vapidKeys = webPush.generateVAPIDKeys();
    const service = new NotificationService(
      {
        getPushVapidKeys: async () => vapidKeys,
        listSessions: async () => [testSession({ status: "question" })],
        listNotificationSettings: async () => ({ "device-test": testNotificationSettings(["approval_gate"]) }),
        getSession: async () => testSession({ status: "question" }),
        appendEvent: async (event: SessionEvent) => {
          appendedEvents.push(event);
        },
        listPushSubscriptions: async () => []
      } as never,
      events,
      { warn: () => undefined, error: () => undefined } as never
    );

    await service.start();
    events.publish({
      id: "event-startup-question",
      type: "session.updated",
      sessionId: "a",
      payload: testSession({ status: "question" }),
      timestamp: "2026-07-08T00:00:00.000Z"
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(appendedEvents).toEqual([]);
    service.stop();
  });
});

function testNotificationSettings(
  globalRules: NotificationRuleType[] = [],
  sessionRules: Record<string, NotificationRuleType[]> = {},
  delivery = { pushEnabled: false, soundEnabled: true }
): NotificationSettings {
  return { globalRules, sessionRules, delivery };
}

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
    pinned: false,
    archived: false,
    ...input
  };
}
