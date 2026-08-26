import webPush from "web-push";
import {
  agentSessionRoot,
  operatorSessionStatusPresentation,
  type CollaborationMode,
  type ManagedSession,
  type NotificationRuleType,
  type NotificationSettings,
  type NotificationTriggeredPayload,
  type PushSubscriptionInput,
  type SessionEvent,
  type SessionStatus
} from "@muxpilot/core";
import type { Logger } from "pino";
import type { AppDatabase, PushVapidKeys } from "../db/database.js";
import type { EventBus } from "./eventBus.js";
import { eventId } from "../utils/ids.js";
import { nowIso } from "../utils/time.js";

type NotificationSeverity = NotificationTriggeredPayload["severity"];
const DEFAULT_DUPLICATE_WINDOW_MS = 60_000;

interface NotificationServiceOptions {
  duplicateWindowMs?: number;
  nowMs?: () => number;
}

export class NotificationService {
  private readonly knownTreeStatuses = new Map<string, SessionStatus>();
  private readonly knownRootIds = new Map<string, string>();
  private readonly knownParentIds = new Map<string, string | null>();
  private readonly syncingSessions = new Set<string>();
  private readonly lastTriggeredAt = new Map<string, number>();
  private eventQueue = Promise.resolve();
  private unsubscribe: (() => void) | null = null;
  private vapidKeys: PushVapidKeys | null = null;

  constructor(
    private readonly db: AppDatabase,
    private readonly events: EventBus,
    private readonly logger: Pick<Logger, "warn" | "error">,
    private readonly options: NotificationServiceOptions = {}
  ) {}

  async start(): Promise<void> {
    this.vapidKeys = await this.ensureVapidKeys();
    webPush.setVapidDetails("mailto:muxpilot@localhost", this.vapidKeys.publicKey, this.vapidKeys.privateKey);
    await this.reseedNotificationBaselines();
    this.unsubscribe = this.events.subscribe((event) => {
      this.eventQueue = this.eventQueue.then(() => this.handleEvent(event)).catch((error) => {
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
        if (session.initializing === true) {
          await this.reseedForStatus(session.id, session.status);
          return;
        }
        if (session.transcriptSyncing === true) {
          this.syncingSessions.add(session.id);
          await this.reseedForStatus(session.id, session.status);
          return;
        }
        if (this.syncingSessions.delete(session.id)) {
          await this.reseedForStatus(session.id, session.status);
          return;
        }
        const sessions = await this.notificationSessions(session.id, session.status);
        const current = sessions.find((candidate) => candidate.id === session.id);
        if (!current || this.hierarchyChanged(current)) {
          await this.reseedNotificationBaselines(sessions);
          return;
        }
        await this.handleStatusTransition(session.id, session.status, sessions);
      }
      return;
    }

    if (event.type !== "status.changed") return;
    const nextStatus = statusFromPayload(event.payload);
    if (!nextStatus) return;

    if (this.syncingSessions.has(event.sessionId)) {
      await this.reseedForStatus(event.sessionId, nextStatus);
      return;
    }

    await this.handleStatusTransition(event.sessionId, nextStatus);
  }

  private async handleStatusTransition(sessionId: string, nextStatus: SessionStatus, providedSessions?: ManagedSession[]): Promise<void> {
    const sessions = providedSessions ?? await this.notificationSessions(sessionId, nextStatus);
    const source = sessions.find((session) => session.id === sessionId);
    if (!source) return;
    const root = agentSessionRoot(source, sessions);
    const presentation = operatorSessionStatusPresentation(root, sessions);
    if (presentation.status === "completed") return;
    const previousStatus = this.knownTreeStatuses.get(root.id);
    this.recordHierarchy(sessions);
    this.knownTreeStatuses.set(root.id, presentation.status);
    const nextTreeStatus = presentation.status;
    if (!previousStatus || previousStatus === nextTreeStatus) return;
    if (source.id !== root.id && source.status !== "approval") return;

    const settingsByDevice = await this.db.listNotificationSettings();
    await Promise.all(
      Object.entries(settingsByDevice).map(async ([deviceId, settings]) => {
        const matchedRules = matchingNotificationRules(settings, root.id, previousStatus, nextTreeStatus, { inputMode: source.inputMode });
        const rules = matchedRules.filter((rule) => this.shouldTrigger(deviceId, root.id, rule, nextTreeStatus));
        if (rules.length === 0) return;

        const payload = notificationPayload(deviceId, root, source, previousStatus, nextTreeStatus, rules);
        const triggeredEvent: SessionEvent = {
          id: eventId(),
          type: "notification.triggered",
          sessionId: root.id,
          payload,
          timestamp: nowIso()
        };
        this.events.publish(triggeredEvent);
        if (settings.delivery.pushEnabled) await this.sendPushNotifications(deviceId, payload);
      })
    );
  }

  private async notificationSessions(sessionId: string, status: SessionStatus): Promise<ManagedSession[]> {
    const sessions = await this.db.listSessions(true);
    const stored = await this.db.getSession(sessionId) ?? sessions.find((session) => session.id === sessionId);
    if (!stored) return sessions;
    const source = { ...stored, status };
    const index = sessions.findIndex((session) => session.id === sessionId);
    if (index < 0) return [...sessions, source];
    const next = [...sessions];
    next[index] = source;
    return next;
  }

  private hierarchyChanged(session: ManagedSession): boolean {
    if (!this.knownRootIds.has(session.id) || !this.knownParentIds.has(session.id)) return true;
    return this.knownRootIds.get(session.id) !== (session.agentOwnership?.rootSessionId ?? session.id)
      || this.knownParentIds.get(session.id) !== (session.agentOwnership?.parentSessionId ?? null);
  }

  private async reseedNotificationBaselines(providedSessions?: ManagedSession[]): Promise<void> {
    const sessions = providedSessions ?? await this.db.listSessions(true);
    this.knownTreeStatuses.clear();
    this.recordHierarchy(sessions);
    const roots = new Map<string, ManagedSession>();
    for (const session of sessions) {
      const root = agentSessionRoot(session, sessions);
      roots.set(root.id, root);
    }
    for (const root of roots.values()) {
      const presentation = operatorSessionStatusPresentation(root, sessions);
      if (presentation.status !== "completed") this.knownTreeStatuses.set(root.id, presentation.status);
    }
  }

  private async reseedForStatus(sessionId: string, status: SessionStatus): Promise<void> {
    await this.reseedNotificationBaselines(await this.notificationSessions(sessionId, status));
  }

  private recordHierarchy(sessions: ManagedSession[]): void {
    this.knownRootIds.clear();
    this.knownParentIds.clear();
    for (const session of sessions) {
      this.knownRootIds.set(session.id, agentSessionRoot(session, sessions).id);
      this.knownParentIds.set(session.id, session.agentOwnership?.parentSessionId ?? null);
    }
  }

  private shouldTrigger(
    deviceId: string,
    sessionId: string,
    rule: NotificationRuleType,
    status: SessionStatus
  ): boolean {
    const now = (this.options.nowMs ?? Date.now)();
    const key = [deviceId, sessionId, rule, status].join("\u0000");
    const previous = this.lastTriggeredAt.get(key);
    const duplicateWindowMs = this.options.duplicateWindowMs ?? DEFAULT_DUPLICATE_WINDOW_MS;
    if (previous !== undefined && now - previous < duplicateWindowMs) return false;
    this.lastTriggeredAt.set(key, now);
    return true;
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
  if (status === "missing" || status === "startup_failed") return [];
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
  root: ManagedSession,
  source: ManagedSession,
  previousStatus: SessionStatus,
  status: SessionStatus,
  rules: NotificationRuleType[]
): NotificationTriggeredPayload {
  const sessionName = notificationSessionName(root);
  const sourceSessionName = source.id === root.id ? undefined : notificationSessionName(source);
  const title = rules.length === 1 ? notificationRuleLabel(rules[0]!) : "Multiple muxpilot alerts";
  const body = `${sourceSessionName ? `${sessionName} · ${sourceSessionName}` : sessionName}: ${notificationStatusLabel(status)}`;
  return {
    deviceId,
    sessionId: root.id,
    sessionName,
    sourceSessionId: source.id === root.id ? undefined : source.id,
    sourceSessionName,
    rules,
    previousStatus,
    status,
    severity: notificationSeverity(rules, status),
    title,
    body,
    url: `/sessions/${source.id}`
  };
}

function notificationSessionName(session: ManagedSession): string {
  return session.tmux.windowName || session.repo.name || "Session";
}

function notificationSeverity(rules: NotificationRuleType[], status: SessionStatus): NotificationSeverity {
  if (rules.includes("approval_gate")) return "red";
  if (rules.includes("done_task")) return "green";
  return statusSeverity(status);
}

function statusSeverity(status: SessionStatus): NotificationSeverity {
  if (status === "approval" || status === "question" || status === "plan_ready" || status === "blocked" || status === "input_failed" || status === "startup_failed" || status === "missing") return "red";
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
    value === "queued" ||
    value === "waiting" ||
    value === "approval" ||
    value === "question" ||
    value === "plan_ready" ||
    value === "blocked" ||
    value === "startup_failed" ||
    value === "input_failed" ||
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
