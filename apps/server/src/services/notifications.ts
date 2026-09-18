import webPush from "web-push";
import {
  agentSessionRoot,
  operatorSessionStatusPresentation,
  type CollaborationMode,
  type CodexUsageSummaryResponse,
  type ManagedSession,
  type NotificationRuleType,
  type NotificationSettings,
  type NotificationTriggeredPayload,
  type UsageLimitNotificationTriggeredPayload,
  type UsageLimitThreshold,
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
type NotificationDeliveryPayload = NotificationTriggeredPayload | UsageLimitNotificationTriggeredPayload;
const DEFAULT_DUPLICATE_WINDOW_MS = 60_000;
const DEFAULT_USAGE_POLL_INTERVAL_MS = 10_000;

interface NotificationServiceOptions {
  duplicateWindowMs?: number;
  nowMs?: () => number;
  pendingAutomaticWork?: (sessionId: string) => Promise<readonly string[]>;
  usageSummary?: () => Promise<CodexUsageSummaryResponse>;
  usagePollIntervalMs?: number;
}

interface NotificationSourceEvent {
  id: string;
  type: SessionEvent["type"];
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
  private usageTimer: ReturnType<typeof setTimeout> | null = null;
  private usageStopped = true;
  private readonly knownUsageLimits = new Map<"fiveHour" | "weekly", { identity: string; remainingPercent: number }>();

  constructor(
    private readonly db: AppDatabase,
    private readonly events: EventBus,
    private readonly logger: Pick<Logger, "info" | "warn" | "error">,
    private readonly options: NotificationServiceOptions = {}
  ) {}

  async start(): Promise<void> {
    this.usageStopped = false;
    this.vapidKeys = await this.ensureVapidKeys();
    webPush.setVapidDetails("mailto:muxpilot@localhost", this.vapidKeys.publicKey, this.vapidKeys.privateKey);
    await this.reseedNotificationBaselines();
    this.unsubscribe = this.events.subscribe((event) => {
      this.eventQueue = this.eventQueue.then(() => this.handleEvent(event)).catch((error) => {
        this.logger.error({ err: error }, "notification event handling failed");
      });
    });
    this.scheduleUsagePoll(0);
  }

  stop(): void {
    this.usageStopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.usageTimer) clearTimeout(this.usageTimer);
    this.usageTimer = null;
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
        await this.handleStatusTransition(session.id, session.status, sessions, event);
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

    await this.handleStatusTransition(event.sessionId, nextStatus, undefined, event);
  }

  private async handleStatusTransition(
    sessionId: string,
    nextStatus: SessionStatus,
    providedSessions?: ManagedSession[],
    sourceEvent?: NotificationSourceEvent
  ): Promise<void> {
    const sessions = providedSessions ?? await this.notificationSessions(sessionId, nextStatus);
    const source = sessions.find((session) => session.id === sessionId);
    if (!source) return;
    const root = agentSessionRoot(source, sessions);
    const presentation = operatorSessionStatusPresentation(root, sessions);
    if (presentation.status === "completed") return;
    const previousStatus = this.knownTreeStatuses.get(root.id);
    this.recordHierarchy(sessions);
    const nextTreeStatus = presentation.status;
    if (!previousStatus || previousStatus === nextTreeStatus) {
      this.knownTreeStatuses.set(root.id, nextTreeStatus);
      return;
    }
    if (source.id !== root.id && source.status !== "approval") {
      this.knownTreeStatuses.set(root.id, nextTreeStatus);
      return;
    }

    const settingsByDevice = await this.db.listNotificationSettings();
    const candidates = Object.entries(settingsByDevice).flatMap(([deviceId, settings]) => {
      const rules = matchingNotificationRules(settings, root.id, previousStatus, nextTreeStatus, { inputMode: source.inputMode });
      return rules.length > 0 ? [{ deviceId, settings, rules }] : [];
    });
    if (candidates.length > 0 && isInputReadyStatus(nextTreeStatus) && this.options.pendingAutomaticWork) {
      let suppressionReasons: readonly string[];
      try {
        suppressionReasons = await this.options.pendingAutomaticWork(root.id);
      } catch (error) {
        suppressionReasons = ["pending_work_lookup_failed"];
        this.logger.warn({ err: error, sessionId: root.id, sourceEvent }, "notification pending-work lookup failed");
      }
      if (suppressionReasons.length > 0) {
        const decisionId = sourceEvent?.id ?? eventId();
        for (const candidate of candidates) {
          this.logger.info?.({
            notification: {
              decision: "suppressed",
              decisionId,
              sessionId: root.id,
              sourceSessionId: source.id,
              deviceId: candidate.deviceId,
              previousStatus,
              status: nextTreeStatus,
              rules: candidate.rules,
              reasons: suppressionReasons,
              sourceEvent
            }
          }, "notification suppressed for pending automatic work");
        }
        return;
      }
    }

    this.knownTreeStatuses.set(root.id, nextTreeStatus);
    await Promise.all(
      candidates.map(async ({ deviceId, settings, rules: matchedRules }) => {
        const rules: NotificationRuleType[] = [];
        for (const rule of matchedRules) {
          if (this.shouldTrigger(deviceId, root.id, rule, nextTreeStatus)) {
            rules.push(rule);
          } else {
            this.logger.info?.({
              notification: {
                decision: "suppressed",
                decisionId: sourceEvent?.id ?? eventId(),
                sessionId: root.id,
                sourceSessionId: source.id,
                deviceId,
                previousStatus,
                status: nextTreeStatus,
                rules: [rule],
                reasons: ["duplicate_window"],
                sourceEvent
              }
            }, "duplicate notification suppressed");
          }
        }
        if (rules.length === 0) return;

        const payload = notificationPayload(deviceId, root, source, previousStatus, nextTreeStatus, rules);
        const triggeredEvent: SessionEvent = {
          id: eventId(),
          type: "notification.triggered",
          sessionId: root.id,
          payload,
          timestamp: nowIso()
        };
        this.logger.info?.({
          notification: {
            decision: "triggered",
            notificationId: triggeredEvent.id,
            sessionId: root.id,
            sourceSessionId: source.id,
            deviceId,
            previousStatus,
            status: nextTreeStatus,
            rules,
            sourceEvent,
            pushEnabled: settings.delivery.pushEnabled
          }
        }, "notification triggered");
        this.events.publish(triggeredEvent);
        this.logger.info?.({ notificationId: triggeredEvent.id, sessionId: root.id, deviceId }, "notification event published");
        if (settings.delivery.pushEnabled) await this.sendPushNotifications(deviceId, payload, triggeredEvent.id);
      })
    );
  }

  private scheduleUsagePoll(delay: number): void {
    if (!this.options.usageSummary || this.usageStopped || this.usageTimer) return;
    this.usageTimer = setTimeout(() => {
      this.usageTimer = null;
      void this.pollUsageLimits();
    }, delay);
  }

  private async pollUsageLimits(): Promise<void> {
    try {
      const settings = await this.db.listNotificationSettings();
      if (Object.keys(settings).length === 0) return;
      const summary = await this.options.usageSummary!();
      await this.handleUsageSummary(summary, settings);
    } catch (error) {
      this.logger.warn({ err: error }, "usage limit notification polling failed");
    } finally {
      this.scheduleUsagePoll(this.options.usagePollIntervalMs ?? DEFAULT_USAGE_POLL_INTERVAL_MS);
    }
  }

  private async handleUsageSummary(summary: CodexUsageSummaryResponse, settingsByDevice: Record<string, NotificationSettings>): Promise<void> {
    if (!summary.available || !summary.account) return;
    for (const limitKey of ["fiveHour", "weekly"] as const) {
      const limit = summary.limits[limitKey];
      if (!limit || limit.remainingPercent === null) continue;
      const identity = `${summary.account.kind}:${summary.account.email ?? ""}:${limit.limitName ?? ""}:${limit.windowDurationMins ?? ""}:${limit.resetsAt ?? ""}`;
      const previous = this.knownUsageLimits.get(limitKey);
      const remainingPercent = Math.max(0, Math.min(100, limit.remainingPercent));
      if (!previous || previous.identity !== identity || remainingPercent > previous.remainingPercent) {
        this.knownUsageLimits.set(limitKey, { identity, remainingPercent });
        continue;
      }
      await Promise.all(Object.entries(settingsByDevice).map(async ([deviceId, settings]) => {
        const threshold = mostUrgentCrossedThreshold(previous.remainingPercent, remainingPercent, settings.usageLimitThresholds);
        if (threshold === null) return;
        const payload = usageLimitNotificationPayload(deviceId, limitKey, limit.label, remainingPercent, threshold);
        const triggeredEvent: SessionEvent = {
          id: eventId(),
          type: "usage.notification.triggered",
          sessionId: "codex-usage",
          payload,
          timestamp: nowIso()
        };
        this.events.publish(triggeredEvent);
        this.logger.info?.({ notificationId: triggeredEvent.id, deviceId, limit: limitKey, threshold, remainingPercent, pushEnabled: settings.delivery.pushEnabled }, "usage limit notification triggered");
        if (settings.delivery.pushEnabled) await this.sendPushNotifications(deviceId, payload, triggeredEvent.id);
      }));
      this.knownUsageLimits.set(limitKey, { identity, remainingPercent });
    }
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

  private async sendPushNotifications(deviceId: string, payload: NotificationDeliveryPayload, notificationId: string): Promise<void> {
    const subscriptions = await this.db.listPushSubscriptions(deviceId);
    const notificationContext = notificationDeliveryContext(payload);
    const outcomes = await Promise.all(
      subscriptions.map(async (subscription) => {
        try {
          await webPush.sendNotification(toWebPushSubscription(subscription), JSON.stringify(payload));
          return "sent" as const;
        } catch (error) {
          if (isExpiredPushSubscriptionError(error)) {
            await this.db.deletePushSubscription(subscription.deviceId, subscription.endpoint);
            return "expired" as const;
          } else {
            this.logger.warn({ err: error, notificationId, deviceId, ...notificationContext }, "push notification send failed");
            return "failed" as const;
          }
        }
      })
    );
    this.logger.info?.({
      notificationId,
      deviceId,
      ...notificationContext,
      subscriptionCount: subscriptions.length,
      sentCount: outcomes.filter((outcome) => outcome === "sent").length,
      expiredCount: outcomes.filter((outcome) => outcome === "expired").length,
      failedCount: outcomes.filter((outcome) => outcome === "failed").length
    }, "push notification delivery completed");
  }
}

function notificationDeliveryContext(payload: NotificationDeliveryPayload): { sessionId: string } | { usageLimit: string } {
  return "sessionId" in payload ? { sessionId: payload.sessionId } : { usageLimit: payload.limit };
}

export function mostUrgentCrossedThreshold(
  previousRemaining: number,
  remaining: number,
  enabledThresholds: readonly UsageLimitThreshold[]
): UsageLimitThreshold | null {
  const crossed = enabledThresholds.filter((threshold) => previousRemaining > threshold && remaining <= threshold);
  return crossed.length ? Math.min(...crossed) as UsageLimitThreshold : null;
}

function usageLimitNotificationPayload(
  deviceId: string,
  limit: "fiveHour" | "weekly",
  label: string,
  remainingPercent: number,
  threshold: UsageLimitThreshold
): UsageLimitNotificationTriggeredPayload {
  const roundedRemaining = Math.round(remainingPercent);
  const limitLabel = label || (limit === "fiveHour" ? "5h limit" : "Weekly limit");
  return {
    deviceId,
    limit,
    limitLabel,
    remainingPercent,
    threshold,
    severity: threshold === 0 ? "red" : "yellow",
    title: threshold === 0 ? "Codex usage limit exhausted" : "Codex usage limit warning",
    body: `${limitLabel} has ${roundedRemaining}% remaining.`,
    url: "/"
  };
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
  return status === "working" || status === "running" || status === "generating" || status === "executing";
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
  return session.name || session.repo.name || "Session";
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
    value === "running" ||
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
