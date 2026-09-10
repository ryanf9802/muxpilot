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
import type { DriverEvent } from "./types.js";

export interface AppServerProjectionStore {
  applyAppServerProjection(projection: AppServerProjectionInput): Promise<AppServerProjectionResult>;
  getAppServerReconciliationState(sessionId: string): Promise<AppServerReconciliationState | null>;
  getSession(sessionId: string): Promise<ManagedSession | null>;
  latestPlanReadyMessage(sessionId: string): Promise<ChatMessage | null>;
  repairAppServerProjectionThread(sessionId: string, threadId: string): Promise<AppServerProjectionRepairResult>;
}

export class CodexAppServerReconciler implements AppServerDriverEventSink {
  constructor(
    private readonly store: AppServerProjectionStore,
    private readonly events: Pick<EventBus, "publish">
  ) {}

  async handle(sessionId: string, event: DriverEvent): Promise<void> {
    const projection = projectAppServerEvent({ method: event.method, params: event.params }, event.receivedAt);
    if (!projection || projection.transient) return;
    const existingSession = await this.requireSession(sessionId);
    const rootThreadId = existingSession.provider?.kind === "codex" ? existingSession.provider.threadId : null;
    if (rootThreadId && projection.identity.threadId !== rootThreadId && !isInteractiveServerRequest(event)) return;
    const current = await this.store.getAppServerReconciliationState(sessionId);
    const normalizedProjection = normalizePlanModeStatus(projection, existingSession.inputMode);
    const pendingPlan = normalizedProjection.status === "idle"
      ? await this.store.latestPlanReadyMessage(sessionId)
      : null;
    const applied = await this.store.applyAppServerProjection(input(
      sessionId,
      preservePlanReady(normalizedProjection, current, pendingPlan),
      event.receivedAt
    ));
    const session = applied.messageChanged || applied.statusChanged
      ? await this.requireSession(sessionId)
      : null;
    if (applied.messageChanged && applied.message) this.publish("message.appended", sessionId, applied.message, event.receivedAt);
    if (applied.statusChanged && applied.state.status) {
      this.publish("status.changed", sessionId, { status: applied.state.status }, event.receivedAt);
    }
    if (session) this.publish("session.updated", sessionId, session, event.receivedAt);
  }

  async restore(sessionId: string, threadId: string, status: unknown, restoredAt: string): Promise<void> {
    await this.store.repairAppServerProjectionThread(sessionId, threadId);
    await this.handle(sessionId, {
      method: "thread/status/changed",
      params: { threadId, status },
      receivedAt: restoredAt
    });
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

function input(sessionId: string, projection: AppServerEventProjection, observedAt: string): AppServerProjectionInput {
  return {
    sessionId,
    ...projection.identity,
    method: projection.method,
    status: projection.status,
    message: projection.message,
    evidence: projection.payload,
    observedAt
  };
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
