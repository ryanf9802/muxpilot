import type { ChatMessage, ManagedSession } from "@muxpilot/core";
import type {
  AppServerProjectionInput,
  AppServerProjectionRepairResult,
  AppServerProjectionResult,
  AppServerReconciliationState
} from "../../db/database.js";
import { eventId } from "../../utils/ids.js";
import type { EventBus } from "../eventBus.js";
import { projectAppServerEvent, type AppServerEventProjection } from "./codexAppServerEvents.js";
import type { AppServerDriverEventSink } from "./codexAppServerDriver.js";
import type { DriverEvent, DriverInterruptIntent } from "./types.js";
import { codexTurnFailure, codexTurnInterruption } from "../../utils/codexTurnFailure.js";

export interface AppServerProjectionStore {
  applyAppServerProjection(projection: AppServerProjectionInput): Promise<AppServerProjectionResult>;
  getAppServerReconciliationState(sessionId: string): Promise<AppServerReconciliationState | null>;
  getAppServerTurnInterruptionKind(sessionId: string, threadId: string, turnId: string): Promise<DriverInterruptIntent | null>;
  getSession(sessionId: string): Promise<ManagedSession | null>;
  upsertSession(session: ManagedSession, updatedAt: string): Promise<void>;
  latestPlanReadyMessage(sessionId: string): Promise<ChatMessage | null>;
  repairAppServerProjectionThread(sessionId: string, threadId: string): Promise<AppServerProjectionRepairResult>;
}

export class CodexAppServerReconciler implements AppServerDriverEventSink {
  private readonly operationTails = new Map<string, Promise<void>>();
  private readonly latestProjectedTurnIds = new Map<string, string>();

  constructor(
    private readonly store: AppServerProjectionStore,
    private readonly events: Pick<EventBus, "publish">,
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
    recoveryGuard?: { threadKey: string; turnId: string }
  ): Promise<boolean> {
    if (event.method === "account/updated") {
      this.onAccountUpdated?.();
      return true;
    }
    const authenticationError = authenticationFailure(event.method, event.params);
    if (authenticationError) {
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
    const projection = projectAppServerEvent({ method: event.method, params: event.params }, event.receivedAt);
    if (!projection || projection.transient) return true;
    const existingSession = await this.requireSession(sessionId);
    const rootThreadId = existingSession.provider?.kind === "codex" ? existingSession.provider.threadId : null;
    if (rootThreadId && projection.identity.threadId !== rootThreadId && !isInteractiveServerRequest(event)) return true;
    const current = await this.store.getAppServerReconciliationState(sessionId);
    const normalizedProjection = preserveBudgetBlock(
      preserveInputFailure(
        normalizePlanModeStatus(projection, existingSession.inputMode),
        existingSession.status
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
      authenticationError ? null : turnFailure(event.params),
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
    const intentionalInterruption = codexTurnInterruption(latestTurn) && latestTurnId
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
    if (codexTurnInterruption(latestTurn)) {
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
    }, recoveryGuard);
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

function authenticationFailure(method: string, value: unknown): string | null {
  const root = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const turn = root?.turn && typeof root.turn === "object" && !Array.isArray(root.turn) ? root.turn as Record<string, unknown> : null;
  if (method !== "connection/error" && !(method === "turn/completed" && turn?.status === "failed")) return null;
  const text = collectErrorText(value).join(" ");
  if (!/unauthori[sz]ed|access token|refresh token|logged out|signed in to another account|authentication required/i.test(text)) return null;
  const sanitized = text
    .replace(/((?:access|refresh|id)[_-]?token|api[_-]?key|authorization)\s*[:=]\s*["']?[^"',\s}]+/gi, "$1=[credential redacted]")
    .replace(/(?:sk-|sess-|Bearer\s+)[A-Za-z0-9._-]+/gi, "[credential redacted]")
    .slice(0, 800) || "Codex account authentication required.";
  return `${sanitized} Manage Codex authentication with the Codex CLI, then return to muxpilot.`;
}

function collectErrorText(value: unknown, depth = 0): string[] {
  if (depth > 5) return [];
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item) => collectErrorText(item, depth + 1));
  return Object.values(value as Record<string, unknown>).flatMap((item) => collectErrorText(item, depth + 1));
}

function isInteractiveServerRequest(event: DriverEvent): boolean {
  const params = event.params;
  return Boolean(
    [
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
      "item/tool/requestUserInput"
    ].includes(event.method)
    && params
    && typeof params === "object"
    && !Array.isArray(params)
    && "requestId" in params
    && "params" in params
  );
}

function input(
  sessionId: string,
  projection: AppServerEventProjection,
  turnFailure: ReturnType<typeof codexTurnFailure>,
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

function turnFailure(params: unknown): ReturnType<typeof codexTurnFailure> {
  const root = params && typeof params === "object" && !Array.isArray(params) ? params as Record<string, unknown> : null;
  return codexTurnFailure(params)
    ?? (root?.muxpilotUnexpectedInterruption === true ? codexTurnInterruption(root.turn) : null);
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
