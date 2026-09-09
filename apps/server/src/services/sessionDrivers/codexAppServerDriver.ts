import { isAbsolute } from "node:path";
import type {
  ApprovalDecision,
  ManagedSession,
  QuestionAnswerRequest,
  SessionCapabilities
} from "@muxpilot/core";
import { CodexAppServerConnectionManager, type AppServerSessionHandlers } from "./codexAppServerConnectionManager.js";
import { CodexAppServerProtocol, type TurnSteerResponse } from "./codexAppServerProtocol.js";
import { JsonRpcResponseError } from "./jsonRpcConnection.js";
import type {
  AgentSessionDriver,
  AgentSessionLaunchResult,
  AgentSessionLaunchSpec,
  DriverEvent,
  DriverInputReceipt,
  DriverPlanActionRequest,
  DriverPlanActionResult,
  DriverSubscription,
  RuntimeStartSpec,
  RuntimeSupervisor,
  SystemdSessionRuntimeRef
} from "./types.js";

export const CODEX_APP_SERVER_CAPABILITIES: SessionCapabilities = {
  start: true,
  sendMessage: true,
  steer: true,
  resume: true,
  fork: true,
  verifiedInput: true,
  interrupt: true,
  kill: true,
  approvals: true,
  questions: true,
  planActions: true,
  fastMode: true,
  rawTerminalCapture: false,
  terminalAttach: true,
  hibernate: true
};

export interface CodexAppServerDriverOptions {
  runtimeSpec(spec: AgentSessionLaunchSpec): RuntimeStartSpec | Promise<RuntimeStartSpec>;
  requestStore?: AppServerRequestStore;
  processStore?: AppServerProcessStore;
  eventSink?: AppServerDriverEventSink;
  now?(): Date;
  interactiveRequestReplayDelayMs?: number;
}

export interface AppServerProcessStore {
  upsertAppServerCommandProcess(process: AppServerProcessOwnership & { sessionId: string; observedAt: string }): Promise<void>;
  removeAppServerCommandProcess(sessionId: string, threadId: string, itemId: string, processId: string): Promise<boolean>;
  removeAppServerTurnCommandProcesses(sessionId: string, threadId: string, turnId: string): Promise<number>;
  clearAppServerCommandProcesses(sessionId: string): Promise<number>;
  listAppServerCommandProcesses(sessionId: string, threadId: string): Promise<Array<AppServerProcessOwnership & {
    sessionId: string;
    observedAt: string;
  }>>;
}

interface AppServerProcessOwnership {
  threadId: string;
  turnId: string;
  itemId: string;
  processId: string;
}

export interface AppServerDriverEventSink {
  handle(sessionId: string, event: DriverEvent): Promise<void>;
  restore(sessionId: string, threadId: string, status: unknown, restoredAt: string): Promise<void>;
}

export interface AppServerRequestStore {
  upsertAppServerRequest(request: {
    sessionId: string;
    requestId: string | number;
    method: string;
    params: unknown;
    threadId: string;
    turnId: string;
    receivedAt: string;
    lastSeenAt: string;
  }): Promise<{ state: "pending" | "responded" | "resolved"; response: unknown | null }>;
  listUnresolvedAppServerRequests(sessionId: string): Promise<Array<{
    requestId: string | number;
    state: "pending" | "responded" | "resolved";
    response: unknown | null;
  }>>;
  claimAppServerRequestResponse(
    sessionId: string,
    requestId: string | number,
    response: unknown,
    respondedAt: string
  ): Promise<unknown | null>;
  resolveAppServerRequest(sessionId: string, requestId: string | number, resolvedAt: string): Promise<boolean>;
  resolveAppServerTurnRequests(sessionId: string, threadId: string, turnId: string, resolvedAt: string): Promise<number>;
}

export class AppServerSteerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppServerSteerUnavailableError";
  }
}

export class CodexAppServerDriver implements AgentSessionDriver {
  readonly kind = "codex_app_server" as const;
  readonly capabilities = CODEX_APP_SERVER_CAPABILITIES;
  private readonly subscribers = new Map<string, Set<(event: DriverEvent) => void>>();
  private readonly activeTurns = new Map<string, string>();
  private readonly sessionThreads = new Map<string, string>();
  private readonly turnProcesses = new Map<string, Map<string, Set<string>>>();
  private readonly pendingRequests = new Map<string, {
    sessionId: string;
    id: string | number;
    method: string;
    params: unknown;
    threadId: string;
    turnId: string;
    responded: boolean;
  }>();
  private readonly interactiveRequestReplayTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly now: () => Date;
  private readonly interactiveRequestReplayDelayMs: number;
  private readonly requestStore: AppServerRequestStore | null;
  private readonly processStore: AppServerProcessStore | null;
  private readonly eventSink: AppServerDriverEventSink | null;

  constructor(
    private readonly supervisor: RuntimeSupervisor,
    private readonly connections: CodexAppServerConnectionManager,
    private readonly options: CodexAppServerDriverOptions
  ) {
    this.now = options.now ?? (() => new Date());
    this.interactiveRequestReplayDelayMs = options.interactiveRequestReplayDelayMs ?? 100;
    this.requestStore = options.requestStore ?? null;
    this.processStore = options.processStore ?? null;
    this.eventSink = options.eventSink ?? null;
  }

  async start(spec: AgentSessionLaunchSpec): Promise<AgentSessionLaunchResult> {
    return this.launch(spec, "start");
  }

  async resume(spec: AgentSessionLaunchSpec): Promise<AgentSessionLaunchResult> {
    requireSourceThread(spec);
    return this.launch(spec, "resume");
  }

  async fork(spec: AgentSessionLaunchSpec): Promise<AgentSessionLaunchResult> {
    requireSourceThread(spec);
    return this.launch(spec, "fork");
  }

  async subscribe(session: ManagedSession, onEvent: (event: DriverEvent) => void): Promise<DriverSubscription> {
    requireAppServerSession(session);
    const listeners = this.subscribers.get(session.id) ?? new Set();
    listeners.add(onEvent);
    this.subscribers.set(session.id, listeners);
    return {
      close: async () => {
        listeners.delete(onEvent);
        if (listeners.size === 0) this.subscribers.delete(session.id);
      }
    };
  }

  async sendMessage(session: ManagedSession, text: string, clientMessageId: string): Promise<DriverInputReceipt> {
    const { threadId, protocol } = this.protocolFor(session);
    const response = await protocol.startTurn(threadId, text, clientMessageId, turnOptions(session));
    this.activeTurns.set(session.id, response.turn.id);
    return receipt(threadId, response.turn.id, clientMessageId, this.now());
  }

  async reconcileInput(session: ManagedSession, clientMessageId: string): Promise<DriverInputReceipt | null> {
    const { threadId, protocol } = this.protocolFor(session);
    const current = await protocol.readThread(threadId, true);
    const turnId = findClientMessageTurnId(current.thread, clientMessageId);
    return turnId ? receipt(threadId, turnId, clientMessageId, this.now()) : null;
  }

  async steer(
    session: ManagedSession,
    text: string,
    clientMessageId: string
  ): Promise<DriverInputReceipt> {
    const { threadId, protocol } = this.protocolFor(session);
    const expectedTurnId = this.activeTurns.get(session.id);
    if (!expectedTurnId) throw new AppServerSteerUnavailableError("Codex has no active turn to steer");
    let response: TurnSteerResponse;
    try {
      response = await protocol.steerTurn(threadId, expectedTurnId, text, clientMessageId);
    } catch (error) {
      if (isDefinitiveSteerRejection(error)) {
        throw new AppServerSteerUnavailableError(error instanceof Error ? error.message : String(error));
      }
      throw error;
    }
    this.activeTurns.set(session.id, response.turnId);
    return receipt(threadId, response.turnId, clientMessageId, this.now());
  }

  async interrupt(session: ManagedSession, expectedTurnId: string | null): Promise<void> {
    const { threadId, protocol } = this.protocolFor(session);
    const turnId = expectedTurnId ?? this.activeTurns.get(session.id);
    if (!turnId) throw new Error("Cannot interrupt app-server session without an active turn id");
    await protocol.interruptTurn(threadId, turnId);
    const processIds = this.turnProcesses.get(session.id)?.get(turnId) ?? [];
    for (const processId of processIds) {
      await protocol.terminateBackgroundTerminal(threadId, processId);
    }
    await this.processStore?.removeAppServerTurnCommandProcesses(session.id, threadId, turnId).catch(() => undefined);
    this.turnProcesses.get(session.id)?.delete(turnId);
    this.activeTurns.delete(session.id);
  }

  async kill(session: ManagedSession): Promise<void> {
    const runtime = requireAppServerSession(session);
    const connection = this.connections.get(session.id);
    if (connection) {
      const protocol = new CodexAppServerProtocol(connection.rpc);
      const threadId = requireThreadId(session);
      const activeTurn = this.activeTurns.get(session.id);
      if (activeTurn) await protocol.interruptTurn(threadId, activeTurn).catch(() => undefined);
      const terminals = await protocol.listBackgroundTerminals(threadId).catch(() => null);
      for (const processId of backgroundProcessIds(terminals)) {
        await protocol.terminateBackgroundTerminal(threadId, processId).catch(() => undefined);
      }
    }
    await this.connections.close(session.id).catch(() => undefined);
    this.activeTurns.delete(session.id);
    this.sessionThreads.delete(session.id);
    this.turnProcesses.delete(session.id);
    this.clearPendingRequests(session.id);
    this.cancelInteractiveRequestReplay(session.id);
    await this.supervisor.stop(runtime);
    await this.processStore?.clearAppServerCommandProcesses(session.id).catch(() => undefined);
  }

  async answerApproval(session: ManagedSession, requestId: string | number, decision: ApprovalDecision): Promise<void> {
    const pending = this.requirePendingRequest(session, requestId);
    if (!APPROVAL_METHODS.has(pending.method)) throw new Error(`Server request is not an approval: ${pending.method}`);
    const response = approvalResponse(pending.method, pending.params, decision);
    await this.respondPending(session, requestId, pending, response);
  }

  async answerQuestion(session: ManagedSession, requestId: string | number, answer: QuestionAnswerRequest): Promise<void> {
    const pending = this.requirePendingRequest(session, requestId);
    if (pending.method !== "item/tool/requestUserInput") {
      throw new Error(`Server request is not a structured question: ${pending.method}`);
    }
    await this.respondPending(session, requestId, pending, { answers: answer.answers });
  }

  async hibernationBlockers(session: ManagedSession): Promise<string[]> {
    const { threadId, protocol } = this.protocolFor(session);
    const blockers: string[] = [];
    await this.reconcileActiveTurnForHibernation(session.id, threadId, protocol);
    if (this.activeTurns.has(session.id)) blockers.push("active_turn");
    if ([...this.pendingRequests.values()].some((request) => request.sessionId === session.id)) {
      blockers.push("interactive_request");
    }
    const terminals = await protocol.listBackgroundTerminals(threadId);
    if (backgroundProcessIds(terminals).length > 0) blockers.push("background_terminal");
    return blockers;
  }

  private async reconcileActiveTurnForHibernation(
    sessionId: string,
    threadId: string,
    protocol: CodexAppServerProtocol
  ): Promise<void> {
    const activeTurnId = this.activeTurns.get(sessionId);
    if (!activeTurnId) return;
    let thread: Record<string, unknown>;
    try {
      thread = (await protocol.readThread(threadId, true)).thread;
    } catch {
      return;
    }
    if (thread.id !== threadId || recordValue(thread, "status")?.type !== "idle") return;
    const turns = Array.isArray(thread.turns) ? thread.turns : [];
    const activeTurn = turns.find((value) => (
      value !== null
      && typeof value === "object"
      && !Array.isArray(value)
      && (value as Record<string, unknown>).id === activeTurnId
    ));
    if (!activeTurn || !isTerminalTurnStatus((activeTurn as Record<string, unknown>).status)) return;
    if (this.activeTurns.get(sessionId) !== activeTurnId) return;
    this.activeTurns.delete(sessionId);
    this.turnProcesses.get(sessionId)?.delete(activeTurnId);
    if (this.turnProcesses.get(sessionId)?.size === 0) this.turnProcesses.delete(sessionId);
  }

  async hibernate(session: ManagedSession): Promise<SystemdSessionRuntimeRef> {
    const runtime = requireAppServerSession(session);
    const threadId = requireThreadId(session);
    const blockers = await this.hibernationBlockers(session);
    if (blockers.length > 0) throw new Error(`App-server session cannot hibernate: ${blockers.join(", ")}`);
    await this.connections.close(session.id);
    let stopped: SystemdSessionRuntimeRef;
    try {
      stopped = await this.supervisor.stop(runtime);
    } catch (error) {
      await this.connections.reconnect({
        sessionId: session.id,
        runtime,
        threadId,
        handlers: this.handlers(session.id)
      }).catch(() => undefined);
      throw error;
    }
    this.activeTurns.delete(session.id);
    this.turnProcesses.delete(session.id);
    this.clearPendingRequests(session.id);
    this.cancelInteractiveRequestReplay(session.id);
    await this.processStore?.clearAppServerCommandProcesses(session.id).catch(() => undefined);
    return { ...stopped, state: "hibernated" };
  }

  async runtimeEvidence(session: ManagedSession) {
    return this.supervisor.inspect(requireAppServerSession(session));
  }

  async choosePlanAction(
    session: ManagedSession,
    action: "implement" | "clear_context_implement" | "stay_in_plan",
    request: DriverPlanActionRequest
  ): Promise<DriverPlanActionResult> {
    if (action === "stay_in_plan") {
      return { provider: requireProvider(session), receipt: null };
    }
    if (!request.clientMessageId) throw new Error("App-server plan implementation requires a client message id");
    const implementationSession = { ...session, inputMode: "default" as const };
    if (action === "implement") {
      const { threadId, protocol } = this.protocolFor(session);
      const response = await protocol.startTurn(
        threadId,
        PLAN_IMPLEMENTATION_MESSAGE,
        request.clientMessageId,
        await implementationTurnOptions(protocol, implementationSession)
      );
      this.activeTurns.set(session.id, response.turn.id);
      return {
        provider: requireProvider(session),
        receipt: receipt(threadId, response.turn.id, request.clientMessageId, this.now())
      };
    }
    if (!request.plan?.trim()) throw new Error("Clear-context implementation requires an approved plan");
    const runtime = requireAppServerSession(session);
    const launchOptions = request.launchOptions;
    if (!launchOptions) throw new Error("Clear-context implementation requires fresh-thread launch options");
    const previousThreadId = requireThreadId(session);
    const settings = {
      cwd: session.cwd ?? session.tmux.cwd,
      model: launchOptions.model,
      developerInstructions: launchOptions.developerInstructions,
      runtimeWorkspaceRoots: launchOptions.writableRoots
    };
    this.sessionThreads.delete(session.id);
    const connection = await this.connections.start({
      sessionId: session.id,
      runtime,
      settings,
      handlers: this.handlers(session.id)
    }).catch((error) => {
      this.sessionThreads.set(session.id, previousThreadId);
      throw error;
    });
    const text = `${PLAN_IMPLEMENTATION_CLEAR_CONTEXT_PREFIX}\n\n${request.plan.trim()}`;
    const protocol = new CodexAppServerProtocol(connection.rpc);
    let response: Awaited<ReturnType<CodexAppServerProtocol["startTurn"]>>;
    try {
      response = await protocol.startTurn(
        connection.threadId,
        text,
        request.clientMessageId,
        await implementationTurnOptions(protocol, implementationSession)
      );
    } catch (error) {
      this.sessionThreads.set(session.id, previousThreadId);
      const unresolved = await this.requestStore?.listUnresolvedAppServerRequests(session.id) ?? [];
      await this.connections.reconnect({
        sessionId: session.id,
        runtime,
        threadId: previousThreadId,
        settings,
        expectedPendingRequestIds: unresolved.map((pending) => pending.requestId),
        handlers: this.handlers(session.id)
      }).catch(() => undefined);
      throw error;
    }
    this.sessionThreads.set(session.id, connection.threadId);
    this.activeTurns.set(session.id, response.turn.id);
    return {
      provider: { kind: "codex", threadId: connection.threadId, rolloutPath: null },
      receipt: receipt(connection.threadId, response.turn.id, request.clientMessageId, this.now())
    };
  }

  async setPreferences(session: ManagedSession, preferences: Parameters<AgentSessionDriver["setPreferences"]>[1]): Promise<void> {
    const { threadId, protocol } = this.protocolFor(session);
    const settings: Record<string, unknown> = {};
    if (preferences.model) {
      settings.model = preferences.model.model;
      settings.effort = preferences.model.reasoningEffort;
    }
    if (preferences.fastMode !== undefined) settings.serviceTier = preferences.fastMode ? "fast" : null;
    if (preferences.mode) {
      const selected = preferences.model ?? session.models[preferences.mode];
      settings.collaborationMode = selected.model
        ? {
            mode: preferences.mode,
            settings: {
              model: selected.model,
              reasoning_effort: selected.reasoningEffort,
              developer_instructions: null
            }
          }
        : await protocol.resolveDefaultCollaborationMode(preferences.mode);
    }
    await protocol.updateThreadSettings(threadId, settings);
  }

  async rename(session: ManagedSession, name: string): Promise<void> {
    const { threadId, protocol } = this.protocolFor(session);
    await protocol.renameThread(threadId, name);
  }

  private async launch(spec: AgentSessionLaunchSpec, operation: "start" | "resume" | "fork"): Promise<AgentSessionLaunchResult> {
    const activeTurnBeforeLaunch = this.activeTurns.get(spec.sessionId);
    const runtimeSpec = await this.options.runtimeSpec(spec);
    if (runtimeSpec.sessionId !== spec.sessionId) throw new Error("Runtime spec session id does not match launch spec");
    const runtime = await this.supervisor.start(runtimeSpec);
    try {
      if (operation === "resume") this.sessionThreads.set(spec.sessionId, requireSourceThread(spec));
      else this.sessionThreads.delete(spec.sessionId);
      const handlers = this.handlers(spec.sessionId);
      const settings = {
        cwd: spec.cwd,
        model: spec.options.model,
        developerInstructions: spec.options.developerInstructions,
        runtimeWorkspaceRoots: spec.options.writableRoots
      };
      const unresolved = operation === "resume" && this.requestStore
        ? await this.requestStore.listUnresolvedAppServerRequests(spec.sessionId)
        : [];
      const connection = operation === "start"
        ? await this.connections.start({ sessionId: spec.sessionId, runtime, settings, handlers })
        : operation === "fork"
          ? await this.connections.fork({
              sessionId: spec.sessionId,
              runtime,
              sourceThreadId: requireSourceThread(spec),
              settings,
              handlers
            })
          : await this.connections.reconnect({
              sessionId: spec.sessionId,
              runtime,
              threadId: requireSourceThread(spec),
              settings,
              expectedPendingRequestIds: unresolved.map((request) => request.requestId),
              handlers
            });
      this.sessionThreads.set(spec.sessionId, connection.threadId);
      if (operation === "resume") {
        const restoredTurnId = this.restoreActiveTurnAfterReconnect(
          spec.sessionId,
          connection.threadId,
          connection.reconciliation.current.thread,
          activeTurnBeforeLaunch
        );
        if (restoredTurnId) {
          const terminals = await new CodexAppServerProtocol(connection.rpc)
            .listBackgroundTerminals(connection.threadId)
            .catch(() => null);
          await this.restoreTurnProcessesAfterReconnect(
            spec.sessionId,
            connection.threadId,
            restoredTurnId,
            terminals,
            connection.reconciliation.journalProcessOwnership
          );
        }
        for (const request of unresolved) {
          if (request.state !== "responded") continue;
          if (request.response === null) throw new Error(`Responded app-server request has no durable response: ${request.requestId}`);
          await connection.rpc.respond(request.requestId, request.response);
        }
        await this.eventSink?.restore(
          spec.sessionId,
          connection.threadId,
          recordValue(connection.reconciliation.current.thread, "status"),
          this.now().toISOString()
        );
      }
      return {
        sessionId: spec.sessionId,
        provider: { kind: "codex", threadId: connection.threadId, rolloutPath: null },
        runtime,
        capabilities: { ...this.capabilities },
        ready: Promise.resolve()
      };
    } catch (error) {
      await this.connections.close(spec.sessionId).catch(() => undefined);
      await this.supervisor.stop(runtime).catch(() => undefined);
      throw error;
    }
  }

  private handlers(sessionId: string): AppServerSessionHandlers {
    return {
      notification: async ({ method, params }) => {
        const receivedAt = this.now().toISOString();
        const threadId = directString(params, "threadId");
        if (method === "serverRequest/resolved") {
          const requestId = directId(params, "requestId");
          if (requestId !== null) {
            await this.requestStore?.resolveAppServerRequest(sessionId, requestId, receivedAt);
            this.pendingRequests.delete(pendingKey(sessionId, requestId));
          }
        }
        if (threadId && !this.isSessionThread(sessionId, threadId)) {
          if (method === "turn/completed") {
            const turnId = nestedId(params, "turn");
            if (turnId) {
              await this.requestStore?.resolveAppServerTurnRequests(sessionId, threadId, turnId, receivedAt);
              this.clearPendingTurnRequests(sessionId, threadId, turnId);
            }
          }
          return;
        }
        if (method === "turn/started") {
          const turnId = nestedId(params, "turn");
          if (turnId) this.activeTurns.set(sessionId, turnId);
        } else if (method === "item/started") {
          await this.persistTurnProcess(sessionId, params, receivedAt);
          this.trackTurnProcess(sessionId, params);
        } else if (method === "item/completed") {
          await this.removePersistedTurnProcess(sessionId, params);
          this.releaseTurnProcess(sessionId, params);
        } else if (method === "turn/completed") {
          const turnId = nestedId(params, "turn");
          const activeTurnId = this.activeTurns.get(sessionId);
          if (!turnId || !activeTurnId || activeTurnId === turnId) {
            if (this.requestStore) {
              if (!threadId || !turnId) {
                throw new Error("App-server turn completion is missing thread/turn identity");
              }
              await this.requestStore.resolveAppServerTurnRequests(sessionId, threadId, turnId, receivedAt);
            }
            this.activeTurns.delete(sessionId);
            if (threadId && turnId) this.clearPendingTurnRequests(sessionId, threadId, turnId);
          }
        }
        const event = { method, params, receivedAt };
        await this.eventSink?.handle(sessionId, event);
        this.emit(sessionId, event);
        if (method === "thread/status/changed") {
          if (threadId && threadStatusNeedsInteractiveRequest(params)) {
            this.scheduleInteractiveRequestReplay(sessionId, threadId);
          } else {
            this.cancelInteractiveRequestReplay(sessionId);
          }
        }
      },
      serverRequest: async ({ id, method, params }) => {
        const threadId = directString(params, "threadId");
        const turnId = directString(params, "turnId");
        if (!threadId || !turnId) throw new Error(`App-server request is missing thread/turn identity: ${method}`);
        const receivedAt = this.now().toISOString();
        if (this.isSessionThread(sessionId, threadId)) this.cancelInteractiveRequestReplay(sessionId);
        const persisted = await this.requestStore?.upsertAppServerRequest({
          sessionId,
          requestId: id,
          method,
          params,
          threadId,
          turnId,
          receivedAt,
          lastSeenAt: receivedAt
        });
        const key = pendingKey(sessionId, id);
        const existing = this.pendingRequests.get(key);
        const responded = persisted ? persisted.state === "responded" : (existing?.responded ?? false);
        this.pendingRequests.set(key, { sessionId, id, method, params, threadId, turnId, responded });
        if (responded) return;
        const event = { method, params: { requestId: id, params }, receivedAt };
        await this.eventSink?.handle(sessionId, event);
        this.emit(sessionId, event);
      },
      error: (error) => this.emit(sessionId, {
        method: "connection/error",
        params: { message: error.message },
        receivedAt: this.now().toISOString()
      })
    };
  }

  private emit(sessionId: string, event: DriverEvent): void {
    for (const listener of this.subscribers.get(sessionId) ?? []) {
      try {
        listener(event);
      } catch {
        // A UI subscriber cannot fail the protocol transport.
      }
    }
  }

  private protocolFor(session: ManagedSession): { threadId: string; protocol: CodexAppServerProtocol } {
    requireAppServerSession(session);
    const threadId = requireThreadId(session);
    const connection = this.connections.get(session.id);
    if (!connection || connection.threadId !== threadId) throw new Error("App-server session is not reconciled and ready for input");
    return { threadId, protocol: new CodexAppServerProtocol(connection.rpc) };
  }

  private requirePendingRequest(session: ManagedSession, requestId: string | number) {
    this.protocolFor(session);
    const pending = this.pendingRequests.get(pendingKey(session.id, requestId));
    if (!pending) throw new Error(`Unknown app-server request id: ${requestId}`);
    if (pending.responded) throw new Error(`App-server request was already answered: ${requestId}`);
    return pending;
  }

  private async respondPending(
    session: ManagedSession,
    requestId: string | number,
    pending: { id: string | number; responded: boolean },
    response: unknown
  ): Promise<void> {
    const connection = this.connections.get(session.id);
    if (!connection) throw new Error("App-server session is not reconciled and ready for input");
    if (this.requestStore) {
      const claimed = await this.requestStore.claimAppServerRequestResponse(
        session.id,
        pending.id,
        response,
        this.now().toISOString()
      );
      if (!claimed) throw new Error(`App-server request was already answered: ${requestId}`);
      pending.responded = true;
    }
    await connection.rpc.respond(pending.id, response);
    if (!this.requestStore) pending.responded = true;
  }

  private clearPendingRequests(sessionId: string): void {
    for (const [key, pending] of this.pendingRequests) {
      if (pending.sessionId === sessionId) this.pendingRequests.delete(key);
    }
  }

  private scheduleInteractiveRequestReplay(sessionId: string, threadId: string): void {
    this.cancelInteractiveRequestReplay(sessionId);
    const timer = setTimeout(() => {
      this.interactiveRequestReplayTimers.delete(sessionId);
      void this.replayMissingInteractiveRequest(sessionId, threadId);
    }, this.interactiveRequestReplayDelayMs);
    timer.unref?.();
    this.interactiveRequestReplayTimers.set(sessionId, timer);
  }

  private cancelInteractiveRequestReplay(sessionId: string): void {
    const timer = this.interactiveRequestReplayTimers.get(sessionId);
    if (!timer) return;
    clearTimeout(timer);
    this.interactiveRequestReplayTimers.delete(sessionId);
  }

  private async replayMissingInteractiveRequest(sessionId: string, threadId: string): Promise<void> {
    if ([...this.pendingRequests.values()].some((request) => (
      request.sessionId === sessionId && request.threadId === threadId && !request.responded
    ))) return;
    const connection = this.connections.get(sessionId);
    if (!connection || connection.threadId !== threadId) return;
    const protocol = new CodexAppServerProtocol(connection.rpc);
    try {
      const current = await protocol.readThread(threadId, false);
      if (!threadStatusNeedsInteractiveRequest(current.thread)) return;
      if ([...this.pendingRequests.values()].some((request) => (
        request.sessionId === sessionId && request.threadId === threadId && !request.responded
      ))) return;
      await protocol.resumeThread(threadId);
    } catch (error) {
      this.emit(sessionId, {
        method: "connection/error",
        params: { message: `Could not replay pending app-server request: ${error instanceof Error ? error.message : String(error)}` },
        receivedAt: this.now().toISOString()
      });
    }
  }

  private clearPendingTurnRequests(sessionId: string, threadId: string, turnId: string): void {
    for (const [key, pending] of this.pendingRequests) {
      if (pending.sessionId === sessionId && pending.threadId === threadId && pending.turnId === turnId) {
        this.pendingRequests.delete(key);
      }
    }
  }

  private isSessionThread(sessionId: string, threadId: string): boolean {
    const expected = this.connections.get(sessionId)?.threadId ?? this.sessionThreads.get(sessionId);
    return expected === threadId;
  }

  private restoreActiveTurnAfterReconnect(
    sessionId: string,
    threadId: string,
    thread: Record<string, unknown>,
    activeTurnBeforeLaunch: string | undefined
  ): string | null {
    if (this.activeTurns.get(sessionId) !== activeTurnBeforeLaunch) return null;
    const restoredTurnId = activeTurnIdFromThread(threadId, thread);
    if (restoredTurnId) {
      this.activeTurns.set(sessionId, restoredTurnId);
      return restoredTurnId;
    }
    this.activeTurns.delete(sessionId);
    this.turnProcesses.delete(sessionId);
    return null;
  }

  private async restoreTurnProcessesAfterReconnect(
    sessionId: string,
    threadId: string,
    turnId: string,
    terminals: unknown,
    journalOwnership: readonly AppServerProcessOwnership[]
  ): Promise<void> {
    if (this.activeTurns.get(sessionId) !== turnId) return;
    const storedOwnership = this.processStore
      ? await this.processStore.listAppServerCommandProcesses(sessionId, threadId)
      : [];
    if (this.activeTurns.get(sessionId) !== turnId) return;
    const restoredProcessIds = backgroundProcessIdsForTurn(terminals, turnId, [...journalOwnership, ...storedOwnership]);
    if (restoredProcessIds.length === 0) return;
    const turns = this.turnProcesses.get(sessionId) ?? new Map<string, Set<string>>();
    const processes = turns.get(turnId) ?? new Set<string>();
    for (const processId of restoredProcessIds) processes.add(processId);
    turns.set(turnId, processes);
    this.turnProcesses.set(sessionId, turns);
  }

  private async persistTurnProcess(sessionId: string, params: unknown, observedAt: string): Promise<void> {
    const ownership = commandProcessOwnership(params);
    if (!ownership) return;
    await this.processStore?.upsertAppServerCommandProcess({ sessionId, ...ownership, observedAt });
  }

  private async removePersistedTurnProcess(sessionId: string, params: unknown): Promise<void> {
    const ownership = commandProcessOwnership(params);
    if (!ownership) return;
    await this.processStore?.removeAppServerCommandProcess(
      sessionId,
      ownership.threadId,
      ownership.itemId,
      ownership.processId
    );
  }

  private trackTurnProcess(sessionId: string, params: unknown): void {
    const item = recordValue(params, "item");
    const turnId = directString(params, "turnId");
    const processId = directString(item, "processId");
    if (item?.type !== "commandExecution" || !turnId || !processId) return;
    const turns = this.turnProcesses.get(sessionId) ?? new Map<string, Set<string>>();
    const processes = turns.get(turnId) ?? new Set<string>();
    processes.add(processId);
    turns.set(turnId, processes);
    this.turnProcesses.set(sessionId, turns);
  }

  private releaseTurnProcess(sessionId: string, params: unknown): void {
    const item = recordValue(params, "item");
    const turnId = directString(params, "turnId");
    const processId = directString(item, "processId");
    if (!turnId || !processId) return;
    const turns = this.turnProcesses.get(sessionId);
    const processes = turns?.get(turnId);
    processes?.delete(processId);
    if (processes?.size === 0) turns?.delete(turnId);
    if (turns?.size === 0) this.turnProcesses.delete(sessionId);
  }
}

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval"
]);

function threadStatusNeedsInteractiveRequest(value: unknown): boolean {
  const envelope = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  const status = recordValue(envelope, "status") ?? envelope;
  if (status?.type !== "active") return false;
  const flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
  return flags.includes("waitingOnApproval") || flags.includes("waitingOnUserInput");
}

export const PLAN_IMPLEMENTATION_MESSAGE = "Implement the plan.";
export const PLAN_IMPLEMENTATION_CLEAR_CONTEXT_PREFIX = [
  "A previous agent produced the plan below to accomplish the user's task.",
  "Implement the plan in a fresh context. Treat the plan as the source of user intent,",
  "re-read files as needed, and carry the work through implementation and verification."
].join(" ");

function requireAppServerSession(session: ManagedSession): SystemdSessionRuntimeRef {
  if (session.driverKind !== "codex_app_server" || session.runtime?.kind !== "systemd_service") {
    throw new Error("Session is not owned by the app-server driver");
  }
  return session.runtime;
}

function requireThreadId(session: ManagedSession): string {
  const threadId = session.provider?.threadId ?? session.codexSessionId;
  if (!threadId) throw new Error("App-server session has no Codex thread id");
  return threadId;
}

function requireProvider(session: ManagedSession): ManagedSession["provider"] & { kind: "codex"; threadId: string } {
  const threadId = requireThreadId(session);
  return { kind: "codex", threadId, rolloutPath: session.provider?.rolloutPath ?? session.codexJsonlPath };
}

function requireSourceThread(spec: AgentSessionLaunchSpec): string {
  if (!spec.sourceThreadId?.trim()) throw new Error("App-server resume/fork requires a source thread id");
  return spec.sourceThreadId;
}

function turnOptions(session: ManagedSession): Record<string, unknown> {
  const selected = session.models[session.inputMode];
  const cwd = session.cwd ?? session.tmux.cwd;
  if (!cwd || !isAbsolute(cwd)) throw new Error("App-server session cwd must be absolute");
  return {
    cwd,
    model: selected.model,
    effort: selected.reasoningEffort,
    serviceTier: session.fastMode ? "fast" : null,
    collaborationMode: selected.model ? {
      mode: session.inputMode,
      settings: { model: selected.model, reasoning_effort: selected.reasoningEffort }
    } : null
  };
}

async function implementationTurnOptions(
  protocol: CodexAppServerProtocol,
  session: ManagedSession
): Promise<Record<string, unknown>> {
  const options = turnOptions(session);
  if (options.collaborationMode === null) {
    options.collaborationMode = await protocol.resolveDefaultCollaborationMode("default");
  }
  return options;
}

function receipt(threadId: string, turnId: string, clientMessageId: string, now: Date): DriverInputReceipt {
  return { clientMessageId, threadId, turnId, acceptedAt: now.toISOString() };
}

function findClientMessageTurnId(thread: Record<string, unknown>, clientMessageId: string): string | null {
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  for (const value of turns) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const turn = value as Record<string, unknown>;
    if (typeof turn.id !== "string" || !turn.id) continue;
    const items = Array.isArray(turn.items) ? turn.items : [];
    if (items.some((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      const record = item as Record<string, unknown>;
      return record.clientId === clientMessageId || record.clientUserMessageId === clientMessageId;
    })) return turn.id;
  }
  return null;
}

function nestedId(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const nested = (value as Record<string, unknown>)[key];
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) return null;
  const id = (nested as Record<string, unknown>).id;
  return typeof id === "string" && id ? id : null;
}

function directId(value: unknown, key: string): string | number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = (value as Record<string, unknown>)[key];
  return typeof id === "string" || (typeof id === "number" && Number.isSafeInteger(id)) ? id : null;
}

function directString(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = (value as Record<string, unknown>)[key];
  return typeof result === "string" && result ? result : null;
}

function pendingKey(sessionId: string, requestId: string | number): string {
  return JSON.stringify([sessionId, typeof requestId, requestId]);
}

function approvalResponse(method: string, params: unknown, decision: ApprovalDecision): unknown {
  if (method === "item/permissions/requestApproval") {
    if (decision === "deny") return { permissions: {}, scope: "turn" };
    const permissions = recordValue(params, "permissions");
    if (!permissions) throw new Error("Permission-profile approval is missing the requested permission profile");
    if (decision === "approve_once") return { permissions, scope: "turn" };
    if (decision === "approve_for_session") return { permissions, scope: "session" };
    throw new Error(`Approval decision is not representable for ${method}: ${decision}`);
  }
  if (decision === "approve_once") return { decision: "accept" };
  if (decision === "approve_for_session") return { decision: "acceptForSession" };
  if (decision === "deny") return { decision: "decline" };
  if (decision === "approve_for_prefix" && method === "item/commandExecution/requestApproval") {
    const amendment = recordArray(params, "proposedExecpolicyAmendment");
    if (amendment) return { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: amendment } } };
  }
  throw new Error(`Approval decision is not representable for ${method}: ${decision}`);
}

function recordValue(value: unknown, key: string): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = (value as Record<string, unknown>)[key];
  return candidate && typeof candidate === "object" && !Array.isArray(candidate)
    ? candidate as Record<string, unknown>
    : null;
}

function recordArray(value: unknown, key: string): string[] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = (value as Record<string, unknown>)[key];
  return Array.isArray(candidate) && candidate.every((item) => typeof item === "string") ? candidate : null;
}

function backgroundProcessIds(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const processes = (value as Record<string, unknown>).data;
  if (!Array.isArray(processes)) return [];
  return processes.flatMap((process) => {
    if (!process || typeof process !== "object" || Array.isArray(process)) return [];
    const id = (process as Record<string, unknown>).processId;
    return typeof id === "string" && id ? [id] : [];
  });
}

function backgroundProcessIdsForTurn(
  terminals: unknown,
  turnId: string,
  ownership: readonly AppServerProcessOwnership[]
): string[] {
  const exactOwnership = new Map(ownership.map((value) => [`${value.itemId}\0${value.processId}`, value]));
  const active = new Set([...exactOwnership.values()]
    .filter((value) => value.turnId === turnId)
    .map((value) => `${value.itemId}\0${value.processId}`));
  if (!terminals || typeof terminals !== "object" || Array.isArray(terminals)) return [];
  const processes = (terminals as Record<string, unknown>).data;
  if (!Array.isArray(processes)) return [];
  return [...new Set(processes.flatMap((process) => {
    if (!process || typeof process !== "object" || Array.isArray(process)) return [];
    const record = process as Record<string, unknown>;
    const itemId = directString(record, "itemId");
    const processId = directString(record, "processId");
    return itemId && processId && active.has(`${itemId}\0${processId}`) ? [processId] : [];
  }))];
}

function commandProcessOwnership(params: unknown): AppServerProcessOwnership | null {
  const item = recordValue(params, "item");
  const threadId = directString(params, "threadId");
  const turnId = directString(params, "turnId");
  const itemId = directString(item, "id") ?? directString(params, "itemId");
  const processId = directString(item, "processId") ?? directString(params, "processId");
  if (!threadId || !turnId || !itemId || !processId) return null;
  if (item?.type !== "commandExecution") return null;
  return { threadId, turnId, itemId, processId };
}

function activeTurnIdFromThread(threadId: string, thread: Record<string, unknown>): string | null {
  if (thread.id !== threadId || recordValue(thread, "status")?.type !== "active") return null;
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (!turn || typeof turn !== "object" || Array.isArray(turn)) continue;
    const record = turn as Record<string, unknown>;
    if (record.status !== "inProgress") continue;
    const turnId = directString(record, "id");
    if (turnId) return turnId;
  }
  return null;
}

function isTerminalTurnStatus(value: unknown): boolean {
  return value === "completed" || value === "interrupted" || value === "failed";
}

function isDefinitiveSteerRejection(error: unknown): boolean {
  if (!(error instanceof JsonRpcResponseError)) return false;
  if (containsObjectKey(error.data, "activeTurnNotSteerable")) return true;
  return /(?:no|without an?) active turn|active turn .*not steerable|expected turn .*?(?:match|active)|expectedTurnId/i.test(error.message);
}

function containsObjectKey(value: unknown, key: string): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((entry) => containsObjectKey(entry, key));
  const record = value as Record<string, unknown>;
  return Object.hasOwn(record, key) || Object.values(record).some((entry) => containsObjectKey(entry, key));
}
