import webPush from "web-push";
import type {
  CollaborationMode,
  ManagedSession,
  NotificationRuleType,
  NotificationSettings,
  NotificationTriggeredPayload,
  PushSubscriptionInput,
  SessionEvent,
  SessionStatus
} from "@muxpilot/core";
import type { Logger } from "pino";
import type { AppDatabase, PushVapidKeys } from "../db/database.js";
import type { EventBus } from "./eventBus.js";
import { eventId } from "../utils/ids.js";
import { nowIso } from "../utils/time.js";

type NotificationSeverity = NotificationTriggeredPayload["severity"];

export class NotificationService {
  private readonly knownStatuses = new Map<string, SessionStatus>();
  private readonly syncingSessions = new Set<string>();
  private unsubscribe: (() => void) | null = null;
  private vapidKeys: PushVapidKeys | null = null;

  constructor(
    private readonly db: AppDatabase,
    private readonly events: EventBus,
    private readonly logger: Pick<Logger, "warn" | "error">
  ) {}

  async start(): Promise<void> {
    this.vapidKeys = await this.ensureVapidKeys();
    webPush.setVapidDetails("mailto:muxpilot@localhost", this.vapidKeys.publicKey, this.vapidKeys.privateKey);
    const sessions = await this.db.listSessions(true);
    for (const session of sessions) {
      this.knownStatuses.set(session.id, session.status);
    }
    this.unsubscribe = this.events.subscribe((event) => {
      void this.handleEvent(event).catch((error) => {
        this.logger.error({ err: error }, "notification event handling failed");
      });
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  async publicPushKey(): Promise<string> {
    if (!this.vapidKeys) this.vapidKeys = await this.ensureVapidKeys();
    return this.vapidKeys.publicKey;
  }

  private async ensureVapidKeys(): Promise<PushVapidKeys> {
    const existing = await this.db.getPushVapidKeys();
    if (existing) return existing;
    return this.db.setPushVapidKeys(webPush.generateVAPIDKeys(), nowIso());
  }

  private async handleEvent(event: SessionEvent): Promise<void> {
    if (event.type === "session.updated") {
      const session = event.payload as Partial<ManagedSession>;
      if (typeof session.id === "string" && isSessionStatus(session.status)) {
        if (session.transcriptSyncing === true) {
          this.knownStatuses.set(session.id, session.status);
          this.syncingSessions.add(session.id);
          return;
        }
        if (this.syncingSessions.delete(session.id)) {
          this.knownStatuses.set(session.id, session.status);
          return;
        }
        await this.handleStatusTransition(session.id, session.status);
      }
      return;
    }

    if (event.type !== "status.changed") return;
    const nextStatus = statusFromPayload(event.payload);
    if (!nextStatus) return;

    if (this.syncingSessions.has(event.sessionId)) {
      this.knownStatuses.set(event.sessionId, nextStatus);
      return;
    }

    await this.handleStatusTransition(event.sessionId, nextStatus);
  }

  private async handleStatusTransition(sessionId: string, nextStatus: SessionStatus): Promise<void> {
    const previousStatus = this.knownStatuses.get(sessionId);
    this.knownStatuses.set(sessionId, nextStatus);
    if (!previousStatus || previousStatus === nextStatus) return;

    const session = await this.db.getSession(sessionId);
    const settingsByDevice = await this.db.listNotificationSettings();
    await Promise.all(
      Object.entries(settingsByDevice).map(async ([deviceId, settings]) => {
        const matchedRules = matchingNotificationRules(settings, sessionId, previousStatus, nextStatus, { inputMode: session?.inputMode ?? null });
        if (matchedRules.length === 0) return;

        const payload = notificationPayload(deviceId, session, sessionId, previousStatus, nextStatus, matchedRules);
        const triggeredEvent: SessionEvent = {
          id: eventId(),
          type: "notification.triggered",
          sessionId,
          payload,
          timestamp: nowIso()
        };
        await this.db.appendEvent(triggeredEvent);
        this.events.publish(triggeredEvent);
        if (settings.delivery.pushEnabled) await this.sendPushNotifications(deviceId, payload);
      })
    );
  }

  private async sendPushNotifications(deviceId: string, payload: NotificationTriggeredPayload): Promise<void> {
    const subscriptions = await this.db.listPushSubscriptions(deviceId);
    await Promise.all(
      subscriptions.map(async (subscription) => {
        try {
          await webPush.sendNotification(toWebPushSubscription(subscription), JSON.stringify(payload));
        } catch (error) {
          if (isExpiredPushSubscriptionError(error)) {
            await this.db.deletePushSubscription(subscription.deviceId, subscription.endpoint);
          } else {
            this.logger.warn({ err: error }, "push notification send failed");
          }
        }
      })
    );
  }
}

export function matchingNotificationRules(
  settings: NotificationSettings,
  sessionId: string,
  previousStatus: SessionStatus,
  status: SessionStatus,
  context: { inputMode?: CollaborationMode | null } = {}
): NotificationRuleType[] {
  if (status === "missing") return [];
  const enabled = new Set<NotificationRuleType>([...settings.globalRules, ...(settings.sessionRules[sessionId] ?? [])]);
  return NOTIFICATION_RULE_TYPES.filter((type) => enabled.has(type) && notificationRuleMatches(type, previousStatus, status, context));
}

function notificationRuleMatches(
  type: NotificationRuleType,
  previousStatus: SessionStatus,
  status: SessionStatus,
  context: { inputMode?: CollaborationMode | null }
): boolean {
  if (context.inputMode === "plan" && isInputReadyStatus(status)) return false;
  if (type === "status_change") return previousStatus !== status;
  if (type === "approval_gate") return statusSeverity(status) === "red";
  return isTaskRunningStatus(previousStatus) && (status === "waiting" || status === "idle");
}

function isTaskRunningStatus(status: SessionStatus): boolean {
  return status === "working" || status === "generating" || status === "executing";
}

function isInputReadyStatus(status: SessionStatus): boolean {
  return status === "waiting" || status === "idle";
}

function notificationPayload(
  deviceId: string,
  session: ManagedSession | null,
  sessionId: string,
  previousStatus: SessionStatus,
  status: SessionStatus,
  rules: NotificationRuleType[]
): NotificationTriggeredPayload {
  const sessionName = session?.tmux.windowName || session?.repo.name || "Session";
  const title = rules.length === 1 ? notificationRuleLabel(rules[0]!) : "Multiple muxpilot alerts";
  const body = `${sessionName}: ${notificationStatusLabel(status)}`;
  return {
    deviceId,
    sessionId,
    sessionName,
    rules,
    previousStatus,
    status,
    severity: notificationSeverity(rules, status),
    title,
    body,
    url: `/sessions/${sessionId}`
  };
}

function notificationSeverity(rules: NotificationRuleType[], status: SessionStatus): NotificationSeverity {
  if (rules.includes("approval_gate")) return "red";
  if (rules.includes("done_task")) return "green";
  return statusSeverity(status);
}

function statusSeverity(status: SessionStatus): NotificationSeverity {
  if (status === "approval" || status === "question" || status === "plan_ready" || status === "blocked" || status === "missing") return "red";
  if (status === "waiting" || status === "idle") return "green";
  return "yellow";
}

function notificationRuleLabel(type: NotificationRuleType): string {
  if (type === "done_task") return "Task done";
  if (type === "approval_gate") return "Approval gate";
  return "Status changed";
}

function notificationStatusLabel(status: SessionStatus): string {
  if (status === "plan_ready") return "plan ready";
  return status.replace(/_/g, " ");
}

function statusFromPayload(payload: unknown): SessionStatus | null {
  if (!payload || typeof payload !== "object" || !("status" in payload)) return null;
  const status = (payload as { status?: unknown }).status;
  return isSessionStatus(status) ? status : null;
}

function isSessionStatus(value: unknown): value is SessionStatus {
  return (
    value === "idle" ||
    value === "generating" ||
    value === "executing" ||
    value === "working" ||
    value === "planning" ||
    value === "waiting" ||
    value === "approval" ||
    value === "question" ||
    value === "plan_ready" ||
    value === "blocked" ||
    value === "missing" ||
    value === "unknown"
  );
}

function toWebPushSubscription(subscription: PushSubscriptionInput): webPush.PushSubscription {
  return {
    endpoint: subscription.endpoint,
    expirationTime: subscription.expirationTime ?? null,
    keys: subscription.keys
  };
}

function isExpiredPushSubscriptionError(error: unknown): boolean {
  const statusCode = typeof error === "object" && error && "statusCode" in error ? (error as { statusCode?: unknown }).statusCode : null;
  return statusCode === 404 || statusCode === 410;
}

const NOTIFICATION_RULE_TYPES: readonly NotificationRuleType[] = ["done_task", "approval_gate", "status_change"];
