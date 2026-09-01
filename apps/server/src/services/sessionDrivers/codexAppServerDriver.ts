import { isAbsolute } from "node:path";
import type {
  ApprovalDecision,
  ManagedSession,
  QuestionAnswerRequest,
  SessionCapabilities
} from "@muxpilot/core";
import { CodexAppServerConnectionManager, type AppServerSessionHandlers } from "./codexAppServerConnectionManager.js";
import { CodexAppServerProtocol } from "./codexAppServerProtocol.js";
import type {
  AgentSessionDriver,
  AgentSessionLaunchResult,
  AgentSessionLaunchSpec,
  DriverEvent,
  DriverInputReceipt,
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
  approvals: false,
  questions: false,
  planActions: false,
  fastMode: true,
  rawTerminalCapture: false,
  terminalAttach: true,
  hibernate: true
};

export interface CodexAppServerDriverOptions {
  runtimeSpec(spec: AgentSessionLaunchSpec): RuntimeStartSpec | Promise<RuntimeStartSpec>;
  requestStore?: AppServerRequestStore;
  now?(): Date;
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
  }): Promise<unknown>;
  listUnresolvedAppServerRequests(sessionId: string): Promise<Array<{
    requestId: string | number;
    state: "pending" | "responded" | "resolved";
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

export class CodexAppServerDriver implements AgentSessionDriver {
  readonly kind = "codex_app_server" as const;
  readonly capabilities = CODEX_APP_SERVER_CAPABILITIES;
  private readonly subscribers = new Map<string, Set<(event: DriverEvent) => void>>();
  private readonly activeTurns = new Map<string, string>();
  private readonly pendingRequests = new Map<string, {
    sessionId: string;
    id: string | number;
    method: string;
    params: unknown;
    responded: boolean;
  }>();
  private readonly now: () => Date;
  private readonly requestStore: AppServerRequestStore | null;

  constructor(
    private readonly supervisor: RuntimeSupervisor,
    private readonly connections: CodexAppServerConnectionManager,
    private readonly options: CodexAppServerDriverOptions
  ) {
    this.now = options.now ?? (() => new Date());
    this.requestStore = options.requestStore ?? null;
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

  async steer(
    session: ManagedSession,
    text: string,
    expectedTurnId: string,
    clientMessageId: string
  ): Promise<DriverInputReceipt> {
    const { threadId, protocol } = this.protocolFor(session);
    const response = await protocol.steerTurn(threadId, expectedTurnId, text, clientMessageId);
    this.activeTurns.set(session.id, response.turnId);
    return receipt(threadId, response.turnId, clientMessageId, this.now());
  }

  async interrupt(session: ManagedSession, expectedTurnId: string | null): Promise<void> {
    const { threadId, protocol } = this.protocolFor(session);
    const turnId = expectedTurnId ?? this.activeTurns.get(session.id);
    if (!turnId) throw new Error("Cannot interrupt app-server session without an active turn id");
    await protocol.interruptTurn(threadId, turnId);
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
    this.clearPendingRequests(session.id);
    await this.supervisor.stop(runtime);
  }

  async answerApproval(session: ManagedSession, requestId: string, decision: ApprovalDecision): Promise<void> {
    const pending = this.requirePendingRequest(session, requestId);
    if (!APPROVAL_METHODS.has(pending.method)) throw new Error(`Server request is not an approval: ${pending.method}`);
    const response = approvalResponse(pending.method, pending.params, decision);
    await this.respondPending(session, requestId, pending, response);
  }

  async answerQuestion(session: ManagedSession, requestId: string, answer: QuestionAnswerRequest): Promise<void> {
    const pending = this.requirePendingRequest(session, requestId);
    if (pending.method !== "item/tool/requestUserInput") {
      throw new Error(`Server request is not a structured question: ${pending.method}`);
    }
    await this.respondPending(session, requestId, pending, { answers: answer.answers });
  }

  async choosePlanAction(): Promise<void> {
    throw new Error("App-server plan actions are unavailable until durable plan records are enabled");
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
      if (!selected.model) throw new Error("Cannot select collaboration mode without a model");
      settings.collaborationMode = {
        mode: preferences.mode,
        settings: { model: selected.model, reasoning_effort: selected.reasoningEffort }
      };
    }
    await protocol.updateThreadSettings(threadId, settings);
  }

  async rename(session: ManagedSession, name: string): Promise<void> {
    const { threadId, protocol } = this.protocolFor(session);
    await protocol.renameThread(threadId, name);
  }

  private async launch(spec: AgentSessionLaunchSpec, operation: "start" | "resume" | "fork"): Promise<AgentSessionLaunchResult> {
    const runtimeSpec = await this.options.runtimeSpec(spec);
    if (runtimeSpec.sessionId !== spec.sessionId) throw new Error("Runtime spec session id does not match launch spec");
    const runtime = await this.supervisor.start(runtimeSpec);
    try {
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
              expectedPendingRequestIds: unresolved.map((request) => request.requestId),
              handlers
            });
      return {
        sessionId: spec.sessionId,
        provider: { kind: "codex", threadId: connection.threadId, rolloutPath: null },
        runtime,
        capabilities: { ...this.capabilities },
        ready: Promise.resolve()
      };
    } catch (error) {
      await this.supervisor.stop(runtime).catch(() => undefined);
      throw error;
    }
  }

  private handlers(sessionId: string): AppServerSessionHandlers {
    return {
      notification: async ({ method, params }) => {
        if (method === "turn/started") {
          const turnId = nestedId(params, "turn");
          if (turnId) this.activeTurns.set(sessionId, turnId);
        } else if (method === "turn/completed") {
          const turnId = nestedId(params, "turn");
          const activeTurnId = this.activeTurns.get(sessionId);
          if (!turnId || !activeTurnId || activeTurnId === turnId) {
            const threadId = directString(params, "threadId");
            if (this.requestStore) {
              if (!threadId || !turnId) {
                throw new Error("App-server turn completion is missing thread/turn identity");
              }
              await this.requestStore.resolveAppServerTurnRequests(sessionId, threadId, turnId, this.now().toISOString());
            }
            this.activeTurns.delete(sessionId);
            this.clearPendingRequests(sessionId);
          }
        } else if (method === "serverRequest/resolved") {
          const requestId = directId(params, "requestId");
          if (requestId !== null) {
            await this.requestStore?.resolveAppServerRequest(sessionId, requestId, this.now().toISOString());
            this.pendingRequests.delete(pendingKey(sessionId, requestId));
          }
        }
        this.emit(sessionId, method, params);
      },
      serverRequest: async ({ id, method, params }) => {
        const threadId = directString(params, "threadId");
        const turnId = directString(params, "turnId");
        if (!threadId || !turnId) throw new Error(`App-server request is missing thread/turn identity: ${method}`);
        const receivedAt = this.now().toISOString();
        await this.requestStore?.upsertAppServerRequest({
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
        this.pendingRequests.set(key, { sessionId, id, method, params, responded: existing?.responded ?? false });
        this.emit(sessionId, method, { requestId: id, params });
      },
      error: (error) => this.emit(sessionId, "connection/error", { message: error.message })
    };
  }

  private emit(sessionId: string, method: string, params: unknown): void {
    const event = { method, params, receivedAt: this.now().toISOString() };
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

  private requirePendingRequest(session: ManagedSession, requestId: string) {
    this.protocolFor(session);
    const pending = this.pendingRequests.get(pendingKey(session.id, requestId));
    if (!pending) throw new Error(`Unknown app-server request id: ${requestId}`);
    if (pending.responded) throw new Error(`App-server request was already answered: ${requestId}`);
    return pending;
  }

  private async respondPending(
    session: ManagedSession,
    requestId: string,
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
}

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval"
]);

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

function receipt(threadId: string, turnId: string, clientMessageId: string, now: Date): DriverInputReceipt {
  return { clientMessageId, threadId, turnId, acceptedAt: now.toISOString() };
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
    throw new Error("Permission-profile approvals require an explicit granted profile");
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
