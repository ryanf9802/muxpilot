import { randomUUID } from "node:crypto";
import { CodexAppServerProtocol, type InitializeResponse, type ThreadIdentityResponse } from "./codexAppServerProtocol.js";
import {
  JsonRpcConnection,
  type JsonRpcConnectionHandlers,
  type JsonRpcNotification,
  type JsonRpcServerRequest
} from "./jsonRpcConnection.js";
import type { ProtocolJournal } from "./protocolJournal.js";
import type { RuntimeSupervisor, SystemdSessionRuntimeRef } from "./types.js";

export interface AppServerSessionHandlers {
  notification?(notification: JsonRpcNotification): void | Promise<void>;
  serverRequest?(request: JsonRpcServerRequest): void | Promise<void>;
  error?(error: Error): void;
}

export interface AppServerReconnectSpec {
  sessionId: string;
  runtime: SystemdSessionRuntimeRef;
  threadId: string;
  expectedPendingRequestIds?: readonly (string | number)[];
  handlers?: AppServerSessionHandlers;
}

export interface AppServerReconciliation {
  initialize: InitializeResponse;
  resumed: ThreadIdentityResponse;
  current: ThreadIdentityResponse;
  replayedRequestIds: readonly (string | number)[];
}

export interface AppServerSessionConnection {
  readonly sessionId: string;
  readonly threadId: string;
  readonly connectionId: string;
  readonly rpc: JsonRpcConnection;
  readonly reconciliation: AppServerReconciliation;
  close(): Promise<void>;
}

interface ConnectionManagerDependencies {
  createConnection(
    connectionId: string,
    proxy: Awaited<ReturnType<RuntimeSupervisor["reconnect"]>>,
    journal: Pick<ProtocolJournal, "append">,
    handlers: JsonRpcConnectionHandlers
  ): Promise<JsonRpcConnection>;
  connectionId(): string;
}

export class CodexAppServerConnectionManager {
  private readonly active = new Map<string, AppServerSessionConnection>();
  private readonly operationTails = new Map<string, Promise<void>>();
  private readonly dependencies: ConnectionManagerDependencies;

  constructor(
    private readonly supervisor: RuntimeSupervisor,
    private readonly journalForSession: (sessionId: string) => Pick<ProtocolJournal, "append">,
    private readonly clientVersion: string,
    dependencies: Partial<ConnectionManagerDependencies> = {}
  ) {
    this.dependencies = {
      createConnection: (connectionId, proxy, protocolJournal, handlers) => JsonRpcConnection.connect(
        connectionId,
        proxy,
        protocolJournal,
        handlers
      ),
      connectionId: () => randomUUID(),
      ...dependencies
    };
  }

  reconnect(spec: AppServerReconnectSpec): Promise<AppServerSessionConnection> {
    return this.serialize(spec.sessionId, () => this.reconnectExclusive(spec));
  }

  close(sessionId: string): Promise<void> {
    return this.serialize(sessionId, async () => {
      const existing = this.active.get(sessionId);
      if (!existing) return;
      this.active.delete(sessionId);
      await existing.rpc.close();
    });
  }

  get(sessionId: string): AppServerSessionConnection | null {
    return this.active.get(sessionId) ?? null;
  }

  private async reconnectExclusive(spec: AppServerReconnectSpec): Promise<AppServerSessionConnection> {
    requireIdentity(spec.sessionId, "sessionId");
    requireIdentity(spec.threadId, "threadId");
    const previous = this.active.get(spec.sessionId);
    if (previous) {
      this.active.delete(spec.sessionId);
      await previous.rpc.close();
    }

    const connectionId = this.dependencies.connectionId();
    const replayedRequestIds = new Set<string | number>();
    let connection: JsonRpcConnection | null = null;
    let proxy: Awaited<ReturnType<RuntimeSupervisor["reconnect"]>> | null = null;
    const handlers: JsonRpcConnectionHandlers = {
      notification: (notification) => spec.handlers?.notification?.(notification),
      serverRequest: async (request) => {
        replayedRequestIds.add(request.id);
        await spec.handlers?.serverRequest?.(request);
      },
      error: (error) => {
        if (this.active.get(spec.sessionId)?.connectionId === connectionId) this.active.delete(spec.sessionId);
        spec.handlers?.error?.(error);
      }
    };

    try {
      proxy = await this.supervisor.reconnect(spec.runtime);
      connection = await this.dependencies.createConnection(
        connectionId,
        proxy,
        this.journalForSession(spec.sessionId),
        handlers
      );
      const protocol = new CodexAppServerProtocol(connection);
      const initialize = await protocol.initialize(this.clientVersion);
      const resumed = await protocol.resumeThread(spec.threadId);
      requireMatchingThread(spec.threadId, resumed, "resume");
      const current = await protocol.readThread(spec.threadId, true);
      requireMatchingThread(spec.threadId, current, "read");
      const missing = (spec.expectedPendingRequestIds ?? []).filter((id) => !replayedRequestIds.has(id));
      if (missing.length > 0) {
        throw new Error(`Codex did not replay pending server requests during reconnect: ${missing.join(", ")}`);
      }
      const managed: AppServerSessionConnection = {
        sessionId: spec.sessionId,
        threadId: spec.threadId,
        connectionId,
        rpc: connection,
        reconciliation: {
          initialize,
          resumed,
          current,
          replayedRequestIds: [...replayedRequestIds]
        },
        close: () => this.closeIfCurrent(spec.sessionId, connectionId)
      };
      this.active.set(spec.sessionId, managed);
      return managed;
    } catch (error) {
      if (connection) await connection.close().catch(() => undefined);
      else await proxy?.close().catch(() => undefined);
      throw error;
    }
  }

  private closeIfCurrent(sessionId: string, connectionId: string): Promise<void> {
    return this.serialize(sessionId, async () => {
      const existing = this.active.get(sessionId);
      if (!existing || existing.connectionId !== connectionId) return;
      this.active.delete(sessionId);
      await existing.rpc.close();
    });
  }

  private serialize<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTails.get(sessionId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.operationTails.set(sessionId, tail);
    void tail.finally(() => {
      if (this.operationTails.get(sessionId) === tail) this.operationTails.delete(sessionId);
    });
    return result;
  }
}

function requireMatchingThread(expectedThreadId: string, response: ThreadIdentityResponse, operation: string): void {
  if (response.thread.id !== expectedThreadId) {
    throw new Error(`Codex ${operation} returned unexpected thread ${response.thread.id}`);
  }
}

function requireIdentity(value: string, name: string): void {
  if (!value.trim()) throw new Error(`${name} must not be empty`);
}
