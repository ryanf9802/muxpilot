import type { ManagedSession } from "@muxpilot/core";
import type {
  AppServerProjectionInput,
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
}

export class CodexAppServerReconciler implements AppServerDriverEventSink {
  constructor(
    private readonly store: AppServerProjectionStore,
    private readonly events: Pick<EventBus, "publish">
  ) {}

  async handle(sessionId: string, event: DriverEvent): Promise<void> {
    const projection = projectAppServerEvent({ method: event.method, params: event.params }, event.receivedAt);
    if (!projection || projection.transient) return;
    const current = await this.store.getAppServerReconciliationState(sessionId);
    const applied = await this.store.applyAppServerProjection(input(sessionId, preservePlanReady(projection, current), event.receivedAt));
    const session = applied.messageChanged || applied.statusChanged
      ? await this.requireSession(sessionId)
      : null;
    if (applied.messageChanged && applied.message) this.publish("message.appended", sessionId, applied.message, event.receivedAt);
    if (applied.statusChanged && applied.state.status) {
      this.publish("status.changed", sessionId, { status: applied.state.status }, event.receivedAt);
    }
    if (session) this.publish("session.updated", sessionId, session, event.receivedAt);
  }

  async restore(sessionId: string, threadId: string, restoredAt: string): Promise<void> {
    const state = await this.store.getAppServerReconciliationState(sessionId);
    if (!state) return;
    if (state.threadId !== threadId) {
      throw new Error(`App-server reconciliation thread mismatch: expected ${threadId}, found ${state.threadId}`);
    }
    const session = await this.requireSession(sessionId);
    if (state.status) this.publish("status.changed", sessionId, { status: state.status }, restoredAt);
    this.publish("session.updated", sessionId, session, restoredAt);
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
  current: AppServerReconciliationState | null
): AppServerEventProjection {
  if (current?.status !== "plan_ready" || projection.status !== "idle") return projection;
  return { ...projection, status: null };
}
