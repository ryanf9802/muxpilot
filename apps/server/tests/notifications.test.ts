import { describe, expect, it, vi } from "vitest";
import webPush from "web-push";
import type { ManagedSession, NotificationRuleType, NotificationSettings, SessionEvent } from "@muxpilot/core";
import { matchingNotificationRules, NotificationService } from "../src/services/notifications.js";
import { EventBus } from "../src/services/eventBus.js";

describe("matchingNotificationRules", () => {
  it("fires done task only for yellow to waiting transitions", () => {
    const settings = testNotificationSettings([], { a: ["done_task"] });

    expect(matchingNotificationRules(settings, "a", "working", "waiting")).toEqual(["done_task"]);
    expect(matchingNotificationRules(settings, "a", "running", "waiting")).toEqual(["done_task"]);
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
    expect(matchingNotificationRules(settings, "a", "planning", "input_failed")).toEqual(["approval_gate"]);
    expect(matchingNotificationRules(settings, "a", "working", "waiting")).toEqual([]);
  });

  it("fires status change on any actual transition", () => {
    const settings = testNotificationSettings(["status_change"]);

    expect(matchingNotificationRules(settings, "a", "working", "planning")).toEqual(["status_change"]);
    expect(matchingNotificationRules(settings, "a", "working", "waiting", { inputMode: "plan" })).toEqual([]);
    expect(matchingNotificationRules(settings, "a", "working", "working")).toEqual([]);
  });

  it("seeds initializing session status without notifying", async () => {
    const events = new EventBus();
    const appendedEvents: SessionEvent[] = [];
    const vapidKeys = webPush.generateVAPIDKeys();
    events.subscribe((event) => {
      if (event.type === "notification.triggered") appendedEvents.push(event);
    });
    const service = new NotificationService(
      {
        getPushVapidKeys: async () => vapidKeys,
        listSessions: async () => [],
        listNotificationSettings: async () => ({ "device-test": testNotificationSettings(["status_change"]) }),
        getSession: async () => testSession({ status: "waiting" }),
        listPushSubscriptions: async () => []
      } as never,
      events,
      { warn: () => undefined, error: () => undefined } as never
    );
    await service.start();

    events.publish({
      id: "event-initializing",
      type: "session.updated",
      sessionId: "a",
      payload: testSession({ status: "unknown", initializing: true }),
      timestamp: "2026-07-08T00:00:00.000Z"
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(appendedEvents).toEqual([]);

    service.stop();
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
    expect(matchingNotificationRules(settings, "a", "waiting", "startup_failed")).toEqual([]);
  });

  it("fires done task from discovered session updates", async () => {
    const events = new EventBus();
    const appendedEvents: SessionEvent[] = [];
    events.subscribe((event) => {
      if (event.type === "notification.triggered") appendedEvents.push(event);
    });
    const service = new NotificationService(
      {
        getPushVapidKeys: async () => ({ publicKey: "public", privateKey: "private" }),
        listSessions: async () => [testSession({ status: "working" })],
        listNotificationSettings: async () => ({ "device-test": testNotificationSettings(["done_task"]) }),
        getSession: async () => testSession({ status: "waiting" }),
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
    events.subscribe((event) => {
      if (event.type === "notification.triggered") appendedEvents.push(event);
    });
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
    events.subscribe((event) => {
      if (event.type === "notification.triggered") appendedEvents.push(event);
    });
    const service = new NotificationService(
      {
        getPushVapidKeys: async () => ({ publicKey: "public", privateKey: "private" }),
        listSessions: async () => [testSession({ status: "working", inputMode: "plan" })],
        listNotificationSettings: async () => ({ "device-test": testNotificationSettings(["done_task"]) }),
        getSession: async () => testSession({ status: "waiting", inputMode: "plan" }),
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
    events.subscribe((event) => {
      if (event.type === "notification.triggered") appendedEvents.push(event);
    });
    let currentStatus: ManagedSession["status"] = "waiting";
    const vapidKeys = webPush.generateVAPIDKeys();
    const service = new NotificationService(
      {
        getPushVapidKeys: async () => vapidKeys,
        listSessions: async () => [testSession({ status: currentStatus })],
        listNotificationSettings: async () => ({ "device-test": testNotificationSettings(["done_task"]) }),
        getSession: async () => testSession({ status: currentStatus }),
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
    events.subscribe((event) => {
      if (event.type === "notification.triggered") appendedEvents.push(event);
    });
    const vapidKeys = webPush.generateVAPIDKeys();
    const service = new NotificationService(
      {
        getPushVapidKeys: async () => vapidKeys,
        listSessions: async () => [testSession({ status: "question" })],
        listNotificationSettings: async () => ({ "device-test": testNotificationSettings(["approval_gate"]) }),
        getSession: async () => testSession({ status: "question" }),
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

  it("uses transcript replay statuses as a silent notification baseline", async () => {
    const events = new EventBus();
    const appendedEvents: SessionEvent[] = [];
    events.subscribe((event) => {
      if (event.type === "notification.triggered") appendedEvents.push(event);
    });
    const service = new NotificationService(
      {
        getPushVapidKeys: async () => webPush.generateVAPIDKeys(),
        listSessions: async () => [testSession({ status: "working" })],
        listNotificationSettings: async () => ({ "device-test": testNotificationSettings(["status_change"]) }),
        getSession: async () => testSession({ status: "waiting" }),
        listPushSubscriptions: async () => []
      } as never,
      events,
      { warn: () => undefined, error: () => undefined } as never
    );

    await service.start();
    events.publish({
      id: "sync-start",
      type: "session.updated",
      sessionId: "a",
      payload: testSession({ status: "working", transcriptSyncing: true }),
      timestamp: "2026-07-08T00:00:00.000Z"
    });
    events.publish({
      id: "replayed-approval",
      type: "status.changed",
      sessionId: "a",
      payload: { status: "approval" },
      timestamp: "2026-07-08T00:00:01.000Z"
    });
    events.publish({
      id: "sync-complete",
      type: "session.updated",
      sessionId: "a",
      payload: testSession({ status: "waiting", transcriptSyncing: false }),
      timestamp: "2026-07-08T00:00:02.000Z"
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(appendedEvents).toEqual([]);

    events.publish({
      id: "real-working",
      type: "status.changed",
      sessionId: "a",
      payload: { status: "working" },
      timestamp: "2026-07-08T00:00:03.000Z"
    });
    await vi.waitFor(() => expect(appendedEvents).toHaveLength(1));
    service.stop();
  });

  it("deduplicates rapid identical notifications per device, rule, and status", async () => {
    const events = new EventBus();
    const triggeredEvents: SessionEvent[] = [];
    let now = 1_000;
    events.subscribe((event) => {
      if (event.type === "notification.triggered") triggeredEvents.push(event);
    });
    const service = new NotificationService(
      {
        getPushVapidKeys: async () => ({ publicKey: "public", privateKey: "private" }),
        listSessions: async () => [testSession({ status: "working" })],
        listNotificationSettings: async () => ({ "device-test": testNotificationSettings(["done_task"]) }),
        getSession: async () => testSession({ status: "waiting" }),
        listPushSubscriptions: async () => []
      } as never,
      events,
      { warn: () => undefined, error: () => undefined } as never,
      { nowMs: () => now }
    );
    const transitionHandler = service as unknown as {
      handleStatusTransition: (sessionId: string, nextStatus: "working" | "waiting") => Promise<void>;
    };

    await transitionHandler.handleStatusTransition("a", "working");
    await transitionHandler.handleStatusTransition("a", "waiting");
    await transitionHandler.handleStatusTransition("a", "working");
    await transitionHandler.handleStatusTransition("a", "waiting");
    expect(triggeredEvents).toHaveLength(1);

    now += 60_000;
    await transitionHandler.handleStatusTransition("a", "working");
    await transitionHandler.handleStatusTransition("a", "waiting");
    expect(triggeredEvents).toHaveLength(2);
  });

  it("keeps parallel child completion silent for the operator", async () => {
    const events = new EventBus();
    const triggeredEvents: SessionEvent[] = [];
    events.subscribe((event) => {
      if (event.type === "notification.triggered") triggeredEvents.push(event);
    });
    const root = namedSession("root", "waiting");
    const first = namedSession("first", "working", agentOwnership(root.id));
    const second = namedSession("second", "working", agentOwnership(root.id));
    const sessions = [root, first, second];
    const service = new NotificationService(
      {
        getPushVapidKeys: async () => ({ publicKey: "public", privateKey: "private" }),
        listSessions: async () => sessions,
        getSession: async (sessionId: string) => sessions.find((session) => session.id === sessionId) ?? null,
        listNotificationSettings: async () => ({
          "device-test": testNotificationSettings([], {
            [root.id]: ["done_task"],
            [first.id]: ["status_change"],
            [second.id]: ["status_change"]
          })
        }),
        listPushSubscriptions: async () => []
      } as never,
      events,
      { warn: () => undefined, error: () => undefined } as never
    );
    const transitionHandler = service as unknown as {
      handleStatusTransition: (sessionId: string, nextStatus: ManagedSession["status"]) => Promise<void>;
    };

    await transitionHandler.handleStatusTransition(first.id, "working");
    first.status = "waiting";
    await transitionHandler.handleStatusTransition(first.id, "waiting");
    expect(triggeredEvents).toEqual([]);

    second.status = "waiting";
    await transitionHandler.handleStatusTransition(second.id, "waiting");
    expect(triggeredEvents).toEqual([]);
  });

  it.each(["working", "running", "waiting", "question", "plan_ready", "blocked", "input_failed", "startup_failed"] as const)(
    "keeps a child's %s transition silent",
    async (status) => {
      const events = new EventBus();
      const triggeredEvents: SessionEvent[] = [];
      events.subscribe((event) => {
        if (event.type === "notification.triggered") triggeredEvents.push(event);
      });
      const root = namedSession("root", "waiting");
      const child = namedSession("child", status === "working" ? "waiting" : "working", agentOwnership(root.id));
      const sessions = [root, child];
      const service = new NotificationService(
        {
          getPushVapidKeys: async () => ({ publicKey: "public", privateKey: "private" }),
          listSessions: async () => sessions,
          getSession: async (sessionId: string) => sessions.find((session) => session.id === sessionId) ?? null,
          listNotificationSettings: async () => ({
            "device-test": testNotificationSettings(["approval_gate", "done_task", "status_change"])
          }),
          listPushSubscriptions: async () => []
        } as never,
        events,
        { warn: () => undefined, error: () => undefined } as never
      );
      const transitionHandler = service as unknown as {
        handleStatusTransition: (sessionId: string, nextStatus: ManagedSession["status"]) => Promise<void>;
      };

      await transitionHandler.handleStatusTransition(child.id, child.status);
      child.status = status;
      await transitionHandler.handleStatusTransition(child.id, status);

      expect(triggeredEvents).toEqual([]);
    }
  );

  it("uses the root rules for child approval, opens the causal child, and silently resolves it", async () => {
    const events = new EventBus();
    const triggeredEvents: SessionEvent[] = [];
    events.subscribe((event) => {
      if (event.type === "notification.triggered") triggeredEvents.push(event);
    });
    const root = namedSession("root", "waiting");
    const child = namedSession("child", "working", agentOwnership(root.id));
    const sessions = [root, child];
    const service = new NotificationService(
      {
        getPushVapidKeys: async () => ({ publicKey: "public", privateKey: "private" }),
        listSessions: async () => sessions,
        getSession: async (sessionId: string) => sessions.find((session) => session.id === sessionId) ?? null,
        listNotificationSettings: async () => ({
          "device-test": testNotificationSettings([], {
            [root.id]: ["approval_gate"],
            [child.id]: ["done_task"]
          })
        }),
        listPushSubscriptions: async () => []
      } as never,
      events,
      { warn: () => undefined, error: () => undefined } as never
    );
    const transitionHandler = service as unknown as {
      handleStatusTransition: (sessionId: string, nextStatus: ManagedSession["status"]) => Promise<void>;
    };

    await transitionHandler.handleStatusTransition(child.id, "working");
    child.status = "approval";
    await transitionHandler.handleStatusTransition(child.id, "approval");

    expect(triggeredEvents).toHaveLength(1);
    expect(triggeredEvents[0]).toMatchObject({
      sessionId: root.id,
      payload: {
        sourceSessionId: child.id,
        rules: ["approval_gate"],
        status: "approval",
        body: "root · child: approval",
        url: `/sessions/${child.id}`
      }
    });

    child.status = "working";
    await transitionHandler.handleStatusTransition(child.id, "working");
    expect(triggeredEvents).toHaveLength(1);
  });

  it("silently rebases notification state when a session is adopted, reparented, or released", async () => {
    const events = new EventBus();
    const triggeredEvents: SessionEvent[] = [];
    events.subscribe((event) => {
      if (event.type === "notification.triggered") triggeredEvents.push(event);
    });
    const root = namedSession("root", "waiting");
    const otherRoot = namedSession("other-root", "waiting");
    const child = namedSession("child", "working");
    const sessions = [root, otherRoot, child];
    const vapidKeys = webPush.generateVAPIDKeys();
    const service = new NotificationService(
      {
        getPushVapidKeys: async () => vapidKeys,
        listSessions: async () => sessions,
        getSession: async (sessionId: string) => sessions.find((session) => session.id === sessionId) ?? null,
        listNotificationSettings: async () => ({ "device-test": testNotificationSettings(["status_change"]) }),
        listPushSubscriptions: async () => []
      } as never,
      events,
      { warn: () => undefined, error: () => undefined } as never
    );
    await service.start();
    const eventHandler = service as unknown as { handleEvent: (event: SessionEvent) => Promise<void> };

    child.agentOwnership = agentOwnership(root.id);
    await eventHandler.handleEvent({
      id: "adopted",
      type: "session.updated",
      sessionId: child.id,
      payload: child,
      timestamp: "2026-08-26T00:00:00.000Z"
    });

    child.agentOwnership = agentOwnership(otherRoot.id);
    await eventHandler.handleEvent({
      id: "reparented",
      type: "session.updated",
      sessionId: child.id,
      payload: child,
      timestamp: "2026-08-26T00:00:01.000Z"
    });

    child.agentOwnership = null;
    await eventHandler.handleEvent({
      id: "released",
      type: "session.updated",
      sessionId: child.id,
      payload: child,
      timestamp: "2026-08-26T00:00:02.000Z"
    });

    expect(triggeredEvents).toEqual([]);
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
    name: "muxpilot",
    cwd: "/repo",
    provider: { kind: "codex", threadId: "codex", rolloutPath: "/tmp/codex.jsonl" },
    repo: { root: "/repo", name: "repo", branch: "main", dirty: false, worktree: null },
    codexSessionId: "codex",
    codexJsonlPath: "/tmp/codex.jsonl",
    discoveryConfidence: "high",
    status: "waiting",
    lastActivityAt: null,
    preview: "",
    recentUserPrompts: [],
    approvalMode: "ask",
    inputMode: "default",
    models: { default: { model: null, reasoningEffort: null }, plan: { model: null, reasoningEffort: null } },
    transcriptSize: 0,
    unreadCount: 0,
    pinned: false,
    archived: false,
    ...input
  };
}

function namedSession(id: string, status: ManagedSession["status"], agentOwnership: ManagedSession["agentOwnership"] = null): ManagedSession {
  return testSession({ id, name: id, status, agentOwnership });
}

function agentOwnership(rootSessionId: string): NonNullable<ManagedSession["agentOwnership"]> {
  return {
    parentSessionId: rootSessionId,
    rootSessionId,
    origin: "created",
    createdAt: "2026-08-26T00:00:00.000Z",
    workTokenBaseline: 0,
    workTokenBudget: 1_000_000,
    completedAt: null
  };
}
