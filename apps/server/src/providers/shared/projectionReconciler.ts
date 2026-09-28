import type { ChatMessage, ManagedSession } from "@muxpilot/core";
import type {
  AppServerProjectionInput,
  AppServerProjectionRepairResult,
  AppServerProjectionResult,
  AppServerReconciliationState
} from "../../db/database.js";
import { eventId } from "../../utils/ids.js";
import type { EventBus } from "../../services/eventBus.js";
import type { AppServerEventProjection } from "../codex/events.js";
import type { DriverEvent, DriverEventSink, DriverInterruptIntent } from "../types.js";
import { providerTurnFailure, providerTurnInterruption } from "../../utils/turnFailure.js";

export interface AppServerProjectionStore {
  applyAppServerProjection(projection: AppServerProjectionInput): Promise<AppServerProjectionResult>;
  getAppServerReconciliationState(sessionId: string): Promise<AppServerReconciliationState | null>;
  getAppServerTurnInterruptionKind(sessionId: string, threadId: string, turnId: string): Promise<DriverInterruptIntent | null>;
  getSession(sessionId: string): Promise<ManagedSession | null>;
  upsertSession(session: ManagedSession, updatedAt: string): Promise<void>;
  latestPlanReadyMessage(sessionId: string): Promise<ChatMessage | null>;
  repairAppServerProjectionThread(sessionId: string, threadId: string): Promise<AppServerProjectionRepairResult>;
}

/** Provider-specific interpretation of runtime events for the shared projection pipeline. */
export interface ProjectionAdapter {
  project(event: { method: string; params: unknown }, receivedAt: string): AppServerEventProjection | null;
  /** A sanitized operator-facing message when the event proves the provider account needs re-authentication. */
  authenticationFailure(method: string, params: unknown): string | null;
  /** Splits one runtime event that carries several transcript items into one event per item. */
  expand?(event: DriverEvent): DriverEvent[];
  /** Server requests that may legitimately carry a child thread id (approvals, questions). */
  isInteractiveServerRequest(event: DriverEvent): boolean;
  /** Event that reports the provider account changed outside muxpilot. */
  accountUpdatedMethod?: string;
}

/**
 * Serializes runtime events per session and projects them into persisted messages, reconciliation state and
 * session status. Turn and status events share one Codex-compatible shape across providers.
 */
export class ProjectionReconciler implements DriverEventSink {
  private readonly operationTails = new Map<string, Promise<void>>();
  private readonly latestProjectedTurnIds = new Map<string, string>();

  constructor(
    private readonly store: AppServerProjectionStore,
    private readonly events: Pick<EventBus, "publish">,
    private readonly adapter: ProjectionAdapter,
    private readonly onAuthenticationFailure?: (sessionId: string, error: string) => void,
    private readonly onAccountUpdated?: () => void
  ) {}

  handle(sessionId: string, event: DriverEvent): Promise<void> {
    const eventTurnId = driverEventTurnId(event.params);
    const eventThreadId = driverEventThreadId(event.params);
    if (eventThreadId && eventTurnId) this.latestProjectedTurnIds.set(threadTurnKey(sessionId, eventThreadId), eventTurnId);
    return this.serialize(sessionId, async () => { await this.handleExclusive(sessionId, event); });
  }

  async recordIntentionalInterruption(
    sessionId: string,
    threadId: string,
    turnId: string,
    intent: DriverInterruptIntent,
    observedAt: string
  ): Promise<void> {
    await this.handle(sessionId, {
      method: "muxpilot/turn/intentionallyInterrupted",
      params: { threadId, turnId, kind: intent },
      receivedAt: observedAt
    });
  }

  private async handleExclusive(
    sessionId: string,
    event: DriverEvent,
    recoveryGuard?: { threadKey: string; turnId: string },
    restoring = false
  ): Promise<boolean> {
    if (this.adapter.accountUpdatedMethod && event.method === this.adapter.accountUpdatedMethod) {
      this.onAccountUpdated?.();
      return true;
    }
    const authenticationError = this.adapter.authenticationFailure(event.method, event.params);
    if (authenticationError && !restoring) {
      const existing = await this.requireSession(sessionId);
      const updated: ManagedSession = {
        ...existing,
        status: "waiting",
        authenticationError,
        authenticationResumeRequired: true
      };
      await this.store.upsertSession(updated, event.receivedAt);
      this.publish("session.updated", sessionId, updated, event.receivedAt);
      this.onAuthenticationFailure?.(sessionId, authenticationError);
    }
    for (const item of this.adapter.expand?.(event) ?? [event]) {
      if (!await this.projectExclusive(sessionId, item, recoveryGuard, restoring)) return false;
    }
    return true;
  }

  private async projectExclusive(
    sessionId: string,
    event: DriverEvent,
    recoveryGuard: { threadKey: string; turnId: string } | undefined,
    restoring: boolean
  ): Promise<boolean> {
    const projection = this.adapter.project({ method: event.method, params: event.params }, event.receivedAt);
    if (!projection || projection.transient) return true;
    const existingSession = await this.requireSession(sessionId);
    const rootThreadId = existingSession.provider.threadId;
    if (rootThreadId && projection.identity.threadId !== rootThreadId && !this.adapter.isInteractiveServerRequest(event)) return true;
    const current = await this.store.getAppServerReconciliationState(sessionId);
    const normalizedProjection = preserveBudgetBlock(
      preserveActiveTurnUntilCompletion(
        preserveInputFailure(
          normalizePlanModeStatus(projection, existingSession.inputMode),
          existingSession.status
        ),
        current,
        existingSession.status,
        restoring
      ),
      existingSession
    );
    const pendingPlan = normalizedProjection.status === "idle"
      ? await this.store.latestPlanReadyMessage(sessionId)
      : null;
    const projectedTurnId = recoveryGuard ? this.latestProjectedTurnIds.get(recoveryGuard.threadKey) : null;
    if (projectedTurnId && projectedTurnId !== recoveryGuard?.turnId) return false;
    const applied = await this.store.applyAppServerProjection(input(
      sessionId,
      preservePlanReady(normalizedProjection, current, pendingPlan),
      turnFailure(event.params),
      event.receivedAt
    ));
    const session = applied.messageChanged || applied.statusChanged
      ? await this.requireSession(sessionId)
      : null;
    if (applied.messageChanged && applied.message) this.publish("message.appended", sessionId, applied.message, event.receivedAt);
    if (applied.failedSubmission) this.publish("message.appended", sessionId, applied.failedSubmission, event.receivedAt);
    if (applied.statusChanged && applied.state.status) {
      this.publish("status.changed", sessionId, { status: applied.state.status }, event.receivedAt);
    }
    if (session) this.publish("session.updated", sessionId, session, event.receivedAt);
    return true;
  }

  restore(
    sessionId: string,
    threadId: string,
    status: unknown,
    latestTurn: Record<string, unknown> | null,
    restoredAt: string
  ): Promise<void> {
    return this.serialize(sessionId, () => this.restoreExclusive(sessionId, threadId, status, latestTurn, restoredAt));
  }

  private async restoreExclusive(
    sessionId: string,
    threadId: string,
    status: unknown,
    latestTurn: Record<string, unknown> | null,
    restoredAt: string
  ): Promise<void> {
    await this.store.repairAppServerProjectionThread(sessionId, threadId);
    const current = await this.store.getAppServerReconciliationState(sessionId);
    const latestTurnId = stringValue(latestTurn?.id);
    const recoveryGuard = latestTurnId ? { threadKey: threadTurnKey(sessionId, threadId), turnId: latestTurnId } : undefined;
    if (reconciliationAdvanced(
      current,
      latestTurnId,
      this.latestProjectedTurnIds.get(threadTurnKey(sessionId, threadId)),
      restoredAt
    )) return;
    const intentionalInterruption = providerTurnInterruption(latestTurn) && latestTurnId
      ? await this.store.getAppServerTurnInterruptionKind(sessionId, threadId, latestTurnId)
      : null;
    if (intentionalInterruption === "budget_guard") return;
    if (intentionalInterruption === "operator") {
      await this.handleExclusive(sessionId, {
        method: "turn/completed",
        params: { threadId, turn: latestTurn },
        receivedAt: restoredAt
      }, recoveryGuard);
      return;
    }
    if (providerTurnFailure({ turn: latestTurn })) {
      await this.handleExclusive(sessionId, {
        method: "turn/completed",
        params: { threadId, turn: latestTurn },
        receivedAt: restoredAt
      }, recoveryGuard, true);
      return;
    }
    if (providerTurnInterruption(latestTurn)) {
      const applied = await this.handleExclusive(sessionId, {
        method: "turn/completed",
        params: { threadId, turn: latestTurn, muxpilotUnexpectedInterruption: true },
        receivedAt: restoredAt
      }, recoveryGuard);
      if (!applied) return;
    }
    await this.handleExclusive(sessionId, {
      method: "thread/status/changed",
      params: { threadId, status },
      receivedAt: restoredAt
    }, recoveryGuard, true);
  }

  private serialize(sessionId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.operationTails.get(sessionId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.operationTails.set(sessionId, tail);
    void tail.finally(() => {
      if (this.operationTails.get(sessionId) === tail) this.operationTails.delete(sessionId);
    });
    return result;
  }

  private async requireSession(sessionId: string): Promise<ManagedSession> {
    const session = await this.store.getSession(sessionId);
    if (!session) throw new Error(`App-server reconciliation session disappeared: ${sessionId}`);
    return session;
  }

  private publish(type: "message.appended" | "status.changed" | "session.updated", sessionId: string, payload: unknown, timestamp: string): void {
    this.events.publish({ id: eventId(), type, sessionId, payload, timestamp });
  }
}

function input(
  sessionId: string,
  projection: AppServerEventProjection,
  turnFailure: ReturnType<typeof providerTurnFailure>,
  observedAt: string
): AppServerProjectionInput {
  return {
    sessionId,
    ...projection.identity,
    method: projection.method,
    status: projection.status,
    message: projection.message,
    evidence: projection.payload,
    turnFailure,
    observedAt
  };
}

function turnFailure(params: unknown): ReturnType<typeof providerTurnFailure> {
  const root = params && typeof params === "object" && !Array.isArray(params) ? params as Record<string, unknown> : null;
  return providerTurnFailure(params)
    ?? (root?.muxpilotUnexpectedInterruption === true ? providerTurnInterruption(root.turn) : null);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function driverEventTurnId(params: unknown): string | null {
  const root = params && typeof params === "object" && !Array.isArray(params) ? params as Record<string, unknown> : null;
  const turn = root?.turn && typeof root.turn === "object" && !Array.isArray(root.turn) ? root.turn as Record<string, unknown> : null;
  return stringValue(root?.turnId) ?? stringValue(turn?.id);
}

function driverEventThreadId(params: unknown): string | null {
  const root = params && typeof params === "object" && !Array.isArray(params) ? params as Record<string, unknown> : null;
  const nested = root?.params && typeof root.params === "object" && !Array.isArray(root.params)
    ? root.params as Record<string, unknown>
    : null;
  return stringValue(root?.threadId) ?? stringValue(nested?.threadId);
}

function threadTurnKey(sessionId: string, threadId: string): string {
  return `${sessionId}\0${threadId}`;
}

function reconciliationAdvanced(
  current: AppServerReconciliationState | null,
  latestTurnId: string | null,
  latestProjectedTurnId: string | undefined,
  restoredAt: string
): boolean {
  if (current?.observedAt && current.observedAt > restoredAt) return true;
  if (!latestTurnId) return false;
  if (latestProjectedTurnId && latestProjectedTurnId !== latestTurnId) return true;
  return Boolean(current?.turnId && current.turnId !== latestTurnId);
}

function preserveInputFailure(
  projection: AppServerEventProjection,
  status: ManagedSession["status"]
): AppServerEventProjection {
  if (status !== "input_failed" || !projection.status || !["idle", "waiting"].includes(projection.status)) return projection;
  return { ...projection, status: "input_failed" };
}

function preserveBudgetBlock(
  projection: AppServerEventProjection,
  session: ManagedSession
): AppServerEventProjection {
  return session.agentOwnership?.budgetExhaustedAt
    ? { ...projection, status: "blocked" }
    : projection;
}

function preserveActiveTurnUntilCompletion(
  projection: AppServerEventProjection,
  current: AppServerReconciliationState | null,
  sessionStatus: ManagedSession["status"],
  restoring: boolean
): AppServerEventProjection {
  if (
    projection.method === "thread/status/changed"
    && projection.status === "idle"
    && !restoring
    && current?.turnId
    && current.method !== "turn/completed"
    && isActiveTurnStatus(sessionStatus)
  ) {
    return { ...projection, status: null };
  }
  return projection;
}

function isActiveTurnStatus(status: ManagedSession["status"]): boolean {
  return status === "working" || status === "running" || status === "generating" || status === "executing" || status === "planning";
}

function preservePlanReady(
  projection: AppServerEventProjection,
  current: AppServerReconciliationState | null,
  pendingPlan: ChatMessage | null
): AppServerEventProjection {
  if (projection.status === "idle" && pendingPlan) return { ...projection, status: "plan_ready" };
  if (
    current?.status === "plan_ready"
    && current.turnId === projection.identity.turnId
    && projection.method === "item/completed"
    && projection.message?.role === "assistant"
  ) {
    return { ...projection, status: null };
  }
  return projection;
}

function normalizePlanModeStatus(
  projection: AppServerEventProjection,
  inputMode: ManagedSession["inputMode"]
): AppServerEventProjection {
  if (
    inputMode !== "plan"
    || !projection.status
    || !["working", "generating", "executing"].includes(projection.status)
  ) return projection;
  return { ...projection, status: "planning" };
}
