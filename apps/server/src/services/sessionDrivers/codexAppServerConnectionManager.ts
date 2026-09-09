import { randomUUID } from "node:crypto";
import {
  CodexAppServerProtocol,
  type InitializeResponse,
  type ThreadIdentityResponse,
  type ThreadLaunchSettings
} from "./codexAppServerProtocol.js";
import {
  JsonRpcConnection,
  JsonRpcResponseError,
  type JsonRpcConnectionHandlers,
  type JsonRpcNotification,
  type JsonRpcServerRequest
} from "./jsonRpcConnection.js";
import type { AppServerCommandProcessOwnership, ProtocolJournal } from "./protocolJournal.js";
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
  settings?: Partial<ThreadLaunchSettings>;
  expectedPendingRequestIds?: readonly (string | number)[];
  handlers?: AppServerSessionHandlers;
}

export interface AppServerOpenSpec {
  sessionId: string;
  runtime: SystemdSessionRuntimeRef;
  settings: ThreadLaunchSettings;
  handlers?: AppServerSessionHandlers;
}

export interface AppServerForkSpec extends AppServerOpenSpec {
  sourceThreadId: string;
}

export interface AppServerReconciliation {
  initialize: InitializeResponse;
  established: ThreadIdentityResponse;
  current: ThreadIdentityResponse;
  replayedRequestIds: readonly (string | number)[];
  journalProcessOwnership: readonly AppServerCommandProcessOwnership[];
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

interface ThreadEstablishment {
  response: ThreadIdentityResponse;
  readCurrentTurns: boolean;
}

export class CodexAppServerConnectionManager {
  private readonly active = new Map<string, AppServerSessionConnection>();
  private readonly operationTails = new Map<string, Promise<void>>();
  private readonly dependencies: ConnectionManagerDependencies;

  constructor(
    private readonly supervisor: RuntimeSupervisor,
    private readonly journalForSession: (sessionId: string) => Pick<ProtocolJournal, "append" | "listActiveCommandProcesses">,
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
    return this.serialize(spec.sessionId, () => this.connectExclusive(
      spec.sessionId,
      spec.runtime,
      spec.handlers,
      spec.expectedPendingRequestIds ?? [],
      spec.settings,
      true,
      async (protocol) => {
        const backgroundTerminals = await protocol.listBackgroundTerminals(spec.threadId).catch(() => null);
        if (hasBackgroundTerminals(backgroundTerminals)) {
          const attached = await protocol.readThread(spec.threadId, true);
          requireMatchingThread(spec.threadId, attached, "attach");
          return { response: attached, readCurrentTurns: true };
        }
        try {
          const resumed = await protocol.resumeThread(spec.threadId, spec.settings);
          requireMatchingThread(spec.threadId, resumed, "resume");
          return { response: resumed, readCurrentTurns: true };
        } catch (error) {
          if (!isMissingRolloutError(error, spec.threadId)) throw error;
          const attached = await protocol.readThread(spec.threadId, false);
          requireIdleMatchingThread(spec.threadId, attached);
          return { response: attached, readCurrentTurns: false };
        }
      }
    ));
  }

  start(spec: AppServerOpenSpec): Promise<AppServerSessionConnection> {
    return this.serialize(spec.sessionId, () => this.connectExclusive(
      spec.sessionId,
      spec.runtime,
      spec.handlers,
      [],
      spec.settings,
      false,
      (protocol) => protocol.startThread(spec.settings).then((response) => ({ response, readCurrentTurns: false }))
    ));
  }

  fork(spec: AppServerForkSpec): Promise<AppServerSessionConnection> {
    return this.serialize(spec.sessionId, async () => {
      requireIdentity(spec.sourceThreadId, "sourceThreadId");
      return this.connectExclusive(
        spec.sessionId,
        spec.runtime,
        spec.handlers,
        [],
        spec.settings,
        false,
        (protocol) => protocol.forkThread(spec.sourceThreadId, spec.settings).then((response) => ({
          response,
          readCurrentTurns: true
        }))
      );
    });
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

  private async connectExclusive(
    sessionId: string,
    runtime: SystemdSessionRuntimeRef,
    sessionHandlers: AppServerSessionHandlers | undefined,
    expectedPendingRequestIds: readonly (string | number)[],
    settings: Partial<ThreadLaunchSettings> | undefined,
    recoverProcessOwnership: boolean,
    establish: (protocol: CodexAppServerProtocol) => Promise<ThreadEstablishment>
  ): Promise<AppServerSessionConnection> {
    requireIdentity(sessionId, "sessionId");
    const previous = this.active.get(sessionId);
    if (previous) {
      this.active.delete(sessionId);
      await previous.rpc.close();
    }

    const connectionId = this.dependencies.connectionId();
    const replayedRequestIds = new Set<string | number>();
    let connection: JsonRpcConnection | null = null;
    let proxy: Awaited<ReturnType<RuntimeSupervisor["reconnect"]>> | null = null;
    const handlers: JsonRpcConnectionHandlers = {
      notification: (notification) => sessionHandlers?.notification?.(notification),
      serverRequest: async (request) => {
        replayedRequestIds.add(request.id);
        await sessionHandlers?.serverRequest?.(request);
      },
      error: (error) => {
        if (this.active.get(sessionId)?.connectionId === connectionId) this.active.delete(sessionId);
        sessionHandlers?.error?.(error);
      }
    };

    try {
      proxy = await this.supervisor.reconnect(runtime);
      const journal = this.journalForSession(sessionId);
      connection = await this.dependencies.createConnection(
        connectionId,
        proxy,
        journal,
        handlers
      );
      const protocol = new CodexAppServerProtocol(connection);
      const initialize = await protocol.initialize(this.clientVersion);
      const establishment = await establish(protocol);
      const established = establishment.response;
      const threadId = established.thread.id;
      if (settings) {
        await protocol.updateThreadSettings(threadId, {
          sandboxPolicy: workspaceWriteSandboxPolicy(settings)
        });
      }
      // Codex does not materialize a brand-new thread's turn collection until
      // its first user message. Keep the connection/input path available so
      // callers can deliver that message. Persisted resumed and forked threads
      // retain the full turn-list reconciliation barrier.
      const current = await protocol.readThread(threadId, establishment.readCurrentTurns);
      requireMatchingThread(threadId, current, "read");
      const journalProcessOwnership = recoverProcessOwnership
        ? await journal.listActiveCommandProcesses(threadId)
        : [];
      const missing = expectedPendingRequestIds.filter((id) => !replayedRequestIds.has(id));
      if (missing.length > 0) {
        throw new Error(`Codex did not replay pending server requests during reconnect: ${missing.join(", ")}`);
      }
      const managed: AppServerSessionConnection = {
        sessionId,
        threadId,
        connectionId,
        rpc: connection,
        reconciliation: {
          initialize,
          established,
          current,
          replayedRequestIds: [...replayedRequestIds],
          journalProcessOwnership
        },
        close: () => this.closeIfCurrent(sessionId, connectionId)
      };
      this.active.set(sessionId, managed);
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

function requireIdleMatchingThread(expectedThreadId: string, response: ThreadIdentityResponse): void {
  requireMatchingThread(expectedThreadId, response, "empty-thread attach");
  const status = response.thread.status;
  if (!status || typeof status !== "object" || !("type" in status) || status.type !== "idle") {
    throw new Error(`Codex empty-thread attach returned non-idle thread ${expectedThreadId}`);
  }
}

function isMissingRolloutError(error: unknown, threadId: string): boolean {
  return error instanceof JsonRpcResponseError
    && error.code === -32600
    && error.message === `no rollout found for thread id ${threadId}`;
}

function requireIdentity(value: string, name: string): void {
  if (!value.trim()) throw new Error(`${name} must not be empty`);
}

function workspaceWriteSandboxPolicy(settings: Partial<ThreadLaunchSettings>): Record<string, unknown> {
  return {
    type: "workspaceWrite",
    writableRoots: [...new Set((settings.runtimeWorkspaceRoots ?? []).filter((root) => root !== settings.cwd))],
    networkAccess: true
  };
}

function hasBackgroundTerminals(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && "data" in value && Array.isArray(value.data) && value.data.length > 0);
}
