import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  ApprovalDecision,
  ApprovalMode,
  ManagedSession,
  MessageContentPart,
  QuestionAnswerRequest,
  SessionCapabilities
} from "@muxpilot/core";
import { JsonRpcConnection, JsonRpcResponseError, type JsonRpcNotification } from "../../runtime/jsonRpcConnection.js";
import {
  AppServerLaunchAttemptError,
  AppServerSteerUnavailableError,
  PLAN_IMPLEMENTATION_CLEAR_CONTEXT_PREFIX,
  PLAN_IMPLEMENTATION_MESSAGE,
  type AppServerRequestStore
} from "../codex/driver.js";
import type {
  AgentSessionDriver,
  AgentSessionLaunchOptions,
  AgentSessionLaunchResult,
  AgentSessionLaunchSpec,
  DriverEvent,
  DriverEventSink,
  DriverInputReceipt,
  DriverInterruptIntent,
  DriverInterruptOutcome,
  DriverPlanActionRequest,
  DriverPlanActionResult,
  DriverSubscription,
  RuntimeStartSpec,
  RuntimeSupervisor,
  SystemdSessionRuntimeRef
} from "../types.js";
import type { ProtocolJournal } from "../../runtime/protocolJournal.js";
import type { ClaudeTranscriptArchive } from "./transcriptArchive.js";
import { CLAUDE_APPROVAL_METHOD, CLAUDE_QUESTION_METHOD } from "./events.js";
import {
  CLAUDE_HOST_PROTOCOL_VERSION,
  HOST_ERROR,
  submissionMessageUuid,
  type HostApprovalResponse,
  type HostInputPart,
  type HostLaunchConfig,
  type HostSessionState,
  type InitializeResult,
  type SessionOpenParams,
  type TurnReceipt
} from "./host/protocol.js";

export const CLAUDE_SESSION_CAPABILITIES: SessionCapabilities = {
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
  // A second Claude process resuming a live session would write the same transcript concurrently.
  terminalAttach: false,
  hibernate: true
};

/** Host calls answer promptly; interactive waits are modeled as notifications, never as pending requests. */
const HOST_REQUEST_TIMEOUT_MS = 60_000;

export interface ClaudeDriverOptions {
  runtimeSpec(spec: AgentSessionLaunchSpec): RuntimeStartSpec | Promise<RuntimeStartSpec>;
  runtimeStarted?(sessionId: string, launchDisposition: "started" | "reused"): void | Promise<void>;
  hostLaunch(spec: { cwd: string; options: AgentSessionLaunchOptions }): HostLaunchConfig;
  journalFor(sessionId: string): Pick<ProtocolJournal, "append">;
  requestStore?: AppServerRequestStore;
  eventSink?: DriverEventSink;
  /** Live rate-limit reports from `rate_limit_event`, used to keep usage current between probes. */
  onRateLimit?(info: Record<string, unknown>): void;
  /** Durable transcript copies: mirrored after turns, restored before anything resumes a conversation. */
  archive?: Pick<ClaudeTranscriptArchive, "mirror" | "ensureRestored">;
  clientVersion?: string;
  now?(): Date;
}

interface HostConnection {
  rpc: JsonRpcConnection;
  threadId: string;
  transcriptPath: string | null;
  hostInstanceId: string;
}

interface PendingRequest {
  sessionId: string;
  requestId: string;
  method: string;
  params: Record<string, unknown>;
  threadId: string;
  turnId: string;
  responded: boolean;
}

export class ClaudeSessionDriver implements AgentSessionDriver {
  readonly kind = "claude" as const;
  readonly capabilities = CLAUDE_SESSION_CAPABILITIES;
  private readonly connections = new Map<string, HostConnection>();
  private readonly activeTurns = new Map<string, string>();
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly subscribers = new Map<string, Set<(event: DriverEvent) => void>>();
  private readonly launchTails = new Map<string, Promise<unknown>>();
  private readonly now: () => Date;

  constructor(
    private readonly supervisor: RuntimeSupervisor,
    private readonly options: ClaudeDriverOptions
  ) {
    this.now = options.now ?? (() => new Date());
  }

  start(spec: AgentSessionLaunchSpec): Promise<AgentSessionLaunchResult> {
    return this.serializeLaunch(spec.sessionId, () => this.launch(spec, "start"));
  }

  resume(spec: AgentSessionLaunchSpec): Promise<AgentSessionLaunchResult> {
    requireSourceThread(spec);
    return this.serializeLaunch(spec.sessionId, () => this.launch(spec, "resume"));
  }

  fork(spec: AgentSessionLaunchSpec): Promise<AgentSessionLaunchResult> {
    requireSourceThread(spec);
    return this.serializeLaunch(spec.sessionId, () => this.launch(spec, "fork"));
  }

  async subscribe(session: ManagedSession, onEvent: (event: DriverEvent) => void): Promise<DriverSubscription> {
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

  async sendMessage(session: ManagedSession, text: string, clientMessageId: string, content?: MessageContentPart[]): Promise<DriverInputReceipt> {
    const connection = this.connectionFor(session);
    const selected = session.models[session.inputMode];
    const result = await connection.rpc.request<TurnReceipt>("turn/start", {
      clientMessageId,
      messageUuid: submissionMessageUuid(session.id, clientMessageId, sha256Hex),
      content: hostInput(text, content),
      mode: session.inputMode,
      approvalMode: session.approvalMode,
      model: selected.model,
      effort: selected.reasoningEffort,
      fastMode: session.fastMode ?? null
    });
    this.activeTurns.set(session.id, result.turnId);
    return receipt(connection.threadId, result.turnId, clientMessageId, this.now());
  }

  async reconcileInput(session: ManagedSession, clientMessageId: string): Promise<DriverInputReceipt | null> {
    const connection = this.connectionFor(session);
    const known = await connection.rpc.request<TurnReceipt | null>("input/lookup", { clientMessageId });
    if (known) return receipt(connection.threadId, known.turnId, clientMessageId, this.now());
    // A restarted host forgets its input ledger; the transcript keeps the submission's deterministic uuid.
    const messageUuid = submissionMessageUuid(session.id, clientMessageId, sha256Hex);
    await this.options.archive?.ensureRestored(session.provider.threadId, session.provider.transcriptPath);
    const transcript = session.provider.transcriptPath ? await readFile(session.provider.transcriptPath, "utf8").catch(() => "") : "";
    return transcript.includes(`"uuid":"${messageUuid}"`)
      ? receipt(connection.threadId, messageUuid, clientMessageId, this.now())
      : null;
  }

  async steer(session: ManagedSession, text: string, clientMessageId: string, content?: MessageContentPart[]): Promise<DriverInputReceipt> {
    const connection = this.connectionFor(session);
    const expectedTurnId = this.activeTurns.get(session.id);
    if (!expectedTurnId) throw new AppServerSteerUnavailableError("Claude has no active turn to steer");
    try {
      const result = await connection.rpc.request<TurnReceipt>("turn/steer", {
        expectedTurnId,
        clientMessageId,
        messageUuid: submissionMessageUuid(session.id, clientMessageId, sha256Hex),
        content: hostInput(text, content)
      });
      return receipt(connection.threadId, result.turnId, clientMessageId, this.now());
    } catch (error) {
      if (error instanceof JsonRpcResponseError && error.code === HOST_ERROR.noActiveTurn) {
        this.activeTurns.delete(session.id);
        throw new AppServerSteerUnavailableError(error.message);
      }
      throw error;
    }
  }

  async interrupt(session: ManagedSession, expectedTurnId: string | null, intent?: DriverInterruptIntent): Promise<DriverInterruptOutcome> {
    const connection = this.connectionFor(session);
    const turnId = expectedTurnId ?? this.activeTurns.get(session.id) ?? null;
    const { outcome } = await connection.rpc.request<{ outcome: "interrupted" | "already_idle" }>("turn/interrupt", { turnId });
    if (outcome === "interrupted" && turnId && intent) {
      await this.options.eventSink?.recordIntentionalInterruption?.(session.id, connection.threadId, turnId, intent, this.now().toISOString());
    }
    return outcome;
  }

  async kill(session: ManagedSession): Promise<void> {
    const runtime = requireRuntime(session);
    const connection = this.connections.get(session.id);
    if (connection) await connection.rpc.request("shutdown", { force: true }).catch(() => undefined);
    await this.closeConnection(session.id);
    this.forgetSession(session.id);
    await this.supervisor.stop(runtime);
  }

  async answerApproval(session: ManagedSession, requestId: string | number, decision: ApprovalDecision): Promise<void> {
    const pending = this.requirePending(session, requestId, CLAUDE_APPROVAL_METHOD);
    await this.respondPending(session, pending, approvalResponse(decision));
  }

  async answerQuestion(session: ManagedSession, requestId: string | number, answer: QuestionAnswerRequest): Promise<void> {
    const pending = this.requirePending(session, requestId, CLAUDE_QUESTION_METHOD);
    await this.respondPending(session, pending, { answers: answer.answers });
  }

  async hibernationBlockers(session: ManagedSession): Promise<string[]> {
    const state = await this.readState(session);
    const blockers: string[] = [];
    if (state.activeTurn) blockers.push("active_turn");
    if (state.pendingRequests.length > 0) blockers.push("interactive_request");
    if (state.backgroundTasks.length > 0) blockers.push("background_terminal");
    // Scheduled wakeups and cron jobs fire only while the Claude runtime is alive.
    if (state.schedules?.wakeupDueAt || (state.schedules?.cronJobIds.length ?? 0) > 0) blockers.push("scheduled_wakeup");
    return blockers;
  }

  async hibernate(session: ManagedSession): Promise<SystemdSessionRuntimeRef> {
    const runtime = requireRuntime(session);
    const blockers = await this.hibernationBlockers(session);
    if (blockers.length > 0) throw new Error(`Claude session cannot hibernate: ${blockers.join(", ")}`);
    const connection = this.connectionFor(session);
    await connection.rpc.request("shutdown", { force: false });
    await this.closeConnection(session.id);
    const stopped = await this.supervisor.stop(runtime);
    this.forgetSession(session.id);
    await this.options.archive?.mirror(connection.threadId, connection.transcriptPath);
    return { ...stopped, state: "hibernated" };
  }

  async runtimeEvidence(session: ManagedSession) {
    return this.supervisor.inspect(requireRuntime(session));
  }

  async choosePlanAction(
    session: ManagedSession,
    action: "implement" | "clear_context_implement" | "stay_in_plan",
    request: DriverPlanActionRequest
  ): Promise<DriverPlanActionResult> {
    const connection = this.connectionFor(session);
    const provider = { kind: "claude" as const, threadId: connection.threadId, transcriptPath: session.provider.transcriptPath };
    if (action === "stay_in_plan") return { provider, receipt: null };
    if (!request.clientMessageId) throw new Error("Claude plan implementation requires a client message id");
    const implementation = { ...session, inputMode: "default" as const };
    if (action === "implement") {
      return { provider, receipt: await this.sendMessage(implementation, PLAN_IMPLEMENTATION_MESSAGE, request.clientMessageId) };
    }
    if (!request.plan?.trim()) throw new Error("Clear-context implementation requires an approved plan");
    if (!request.launchOptions) throw new Error("Clear-context implementation requires fresh-thread launch options");
    const previousThreadId = connection.threadId;
    const opened = await connection.rpc.request<HostSessionState>("session/open", {
      mode: "start",
      sessionId: randomUUID(),
      cwd: session.cwd,
      launch: this.options.hostLaunch({ cwd: session.cwd, options: request.launchOptions }),
      replace: true
    } satisfies SessionOpenParams);
    const previousTranscriptPath = connection.transcriptPath;
    await this.options.archive?.mirror(previousThreadId, previousTranscriptPath);
    connection.threadId = opened.sessionId;
    connection.transcriptPath = opened.transcriptPath;
    try {
      const sent = await this.sendMessage(
        { ...implementation, provider: { kind: "claude", threadId: opened.sessionId, transcriptPath: opened.transcriptPath } },
        `${PLAN_IMPLEMENTATION_CLEAR_CONTEXT_PREFIX}\n\n${request.plan.trim()}`,
        request.clientMessageId
      );
      return { provider: { kind: "claude", threadId: opened.sessionId, transcriptPath: opened.transcriptPath }, receipt: sent };
    } catch (error) {
      await connection.rpc.request("session/open", {
        mode: "resume",
        sessionId: previousThreadId,
        sourceSessionId: previousThreadId,
        cwd: session.cwd,
        launch: this.options.hostLaunch({ cwd: session.cwd, options: request.launchOptions }),
        replace: true
      } satisfies SessionOpenParams).catch(() => undefined);
      connection.threadId = previousThreadId;
      connection.transcriptPath = previousTranscriptPath;
      throw error;
    }
  }

  async setPreferences(session: ManagedSession, preferences: Parameters<AgentSessionDriver["setPreferences"]>[1]): Promise<void> {
    const connection = this.connectionFor(session);
    const selected = preferences.model ?? (preferences.mode ? session.models[preferences.mode] : null);
    await connection.rpc.request("settings/update", {
      ...(preferences.mode ? { permissionMode: preferences.mode } : {}),
      ...(selected?.model ? { model: selected.model } : {}),
      ...(selected?.reasoningEffort ? { effort: selected.reasoningEffort } : {}),
      ...(preferences.fastMode !== undefined ? { fastMode: preferences.fastMode } : {})
    });
  }

  async setApprovalMode(session: ManagedSession, approvalMode: ApprovalMode): Promise<void> {
    if (!this.connections.has(session.id)) return;
    await this.connectionFor(session).rpc.request("settings/update", { approvalMode });
  }

  async rename(_session: ManagedSession, _name: string): Promise<void> {
    // muxpilot's session name is authoritative; Claude's own session title is not shown anywhere.
  }

  private async launch(spec: AgentSessionLaunchSpec, operation: "start" | "resume" | "fork"): Promise<AgentSessionLaunchResult> {
    const runtimeSpec = await this.options.runtimeSpec(spec);
    if (runtimeSpec.sessionId !== spec.sessionId) throw new Error("Runtime spec session id does not match launch spec");
    const launched = await this.supervisor.start(runtimeSpec);
    const launchDisposition = launched.launchDisposition ?? "started";
    const { launchDisposition: _disposition, ...runtime } = launched;
    try {
      await this.options.runtimeStarted?.(spec.sessionId, launchDisposition);
      await this.closeConnection(spec.sessionId);
      // Resume and fork read the source transcript, which Claude Code may have swept since it was archived.
      if (operation !== "start") await this.options.archive?.ensureRestored(requireSourceThread(spec));
      const expectedThreadId = operation === "resume" ? requireSourceThread(spec) : randomUUID();
      const connection = await this.connect(spec.sessionId, runtime, expectedThreadId);
      const initialized = await connection.rpc.request<InitializeResult>("initialize", {
        protocolVersion: CLAUDE_HOST_PROTOCOL_VERSION,
        clientVersion: this.options.clientVersion ?? "muxpilot/0.1.0"
      });
      let state = initialized.state;
      const hostOwnsSession = state !== null && (operation === "resume" ? state.sessionId === expectedThreadId : false);
      if (!hostOwnsSession) {
        state = await connection.rpc.request<HostSessionState>("session/open", {
          mode: operation,
          sessionId: expectedThreadId,
          ...(operation === "start" ? {} : { sourceSessionId: requireSourceThread(spec) }),
          cwd: spec.cwd,
          launch: this.options.hostLaunch({ cwd: spec.cwd, options: spec.options }),
          replace: state !== null
        } satisfies SessionOpenParams);
      }
      if (!state) throw new Error("Claude host did not report session state");
      if (operation === "resume" && state.sessionId !== expectedThreadId) {
        throw new Error(`Claude host resumed the wrong session: expected ${expectedThreadId}, received ${state.sessionId}`);
      }
      connection.threadId = state.sessionId;
      connection.transcriptPath = state.transcriptPath;
      if (state.activeTurn) this.activeTurns.set(spec.sessionId, state.activeTurn.id);
      else this.activeTurns.delete(spec.sessionId);
      if (operation === "resume") await this.reconcileRequestsAfterReconnect(spec.sessionId, connection, state);
      if (operation === "resume") {
        await this.options.eventSink?.restore(
          spec.sessionId,
          state.sessionId,
          state.status,
          (state.activeTurn ?? state.latestTurn) as unknown as Record<string, unknown> | null,
          this.now().toISOString()
        );
      }
      return {
        sessionId: spec.sessionId,
        provider: { kind: "claude", threadId: state.sessionId, transcriptPath: state.transcriptPath },
        runtime: { ...runtime, agentVersion: initialized.claudeVersion ?? runtime.agentVersion },
        launchDisposition,
        capabilities: { ...this.capabilities },
        ready: Promise.resolve()
      };
    } catch (error) {
      await this.closeConnection(spec.sessionId).catch(() => undefined);
      if (launchDisposition === "started") await this.supervisor.stop(runtime).catch(() => undefined);
      throw new AppServerLaunchAttemptError(launchDisposition, error);
    }
  }

  private async connect(sessionId: string, runtime: SystemdSessionRuntimeRef, threadId: string): Promise<HostConnection> {
    const proxy = await this.supervisor.reconnect(runtime);
    const holder: { connection: HostConnection | null } = { connection: null };
    const rpc = await JsonRpcConnection.connect(
      `claude-${sessionId}-${randomUUID()}`,
      proxy,
      this.options.journalFor(sessionId),
      {
        notification: (notification) => this.handleNotification(sessionId, notification),
        error: (error) => {
          if (this.connections.get(sessionId) === holder.connection) this.connections.delete(sessionId);
          this.emit(sessionId, { method: "connection/error", params: { message: error.message }, receivedAt: this.now().toISOString() });
        }
      },
      { requestTimeoutMs: HOST_REQUEST_TIMEOUT_MS }
    );
    const connection: HostConnection = { rpc, threadId, transcriptPath: null, hostInstanceId: "" };
    holder.connection = connection;
    this.connections.set(sessionId, connection);
    return connection;
  }

  private async handleNotification(sessionId: string, notification: JsonRpcNotification): Promise<void> {
    const receivedAt = this.now().toISOString();
    const params = record(notification.params) ?? {};
    const threadId = string(params.threadId);
    let event: DriverEvent = { method: notification.method, params: notification.params, receivedAt };

    if (notification.method === "request/opened") {
      const handled = await this.handleRequestOpened(sessionId, params, receivedAt);
      if (!handled) return;
      event = handled;
    } else if (notification.method === "serverRequest/resolved") {
      const requestId = string(params.requestId);
      if (requestId) {
        await this.options.requestStore?.resolveAppServerRequest(sessionId, requestId, receivedAt);
        this.pendingRequests.delete(pendingKey(sessionId, requestId));
      }
    } else if (notification.method === "turn/started") {
      const turnId = string(record(params.turn)?.id);
      if (turnId) this.activeTurns.set(sessionId, turnId);
    } else if (notification.method === "turn/completed") {
      const turnId = string(record(params.turn)?.id);
      if (turnId && threadId) {
        await this.options.requestStore?.resolveAppServerTurnRequests(sessionId, threadId, turnId, receivedAt);
        for (const [key, pending] of this.pendingRequests) {
          if (pending.sessionId === sessionId && pending.turnId === turnId) this.pendingRequests.delete(key);
        }
      }
      if (!turnId || this.activeTurns.get(sessionId) === turnId) this.activeTurns.delete(sessionId);
      const connection = this.connections.get(sessionId);
      if (connection) void this.options.archive?.mirror(connection.threadId, connection.transcriptPath);
    } else if (notification.method === "sdk/message") {
      const message = record(params.message);
      if (message?.type === "rate_limit_event") {
        const info = record(message.rate_limit_info);
        if (info) this.options.onRateLimit?.(info);
      }
    }
    await this.options.eventSink?.handle(sessionId, event);
    this.emit(sessionId, event);
  }

  private async handleRequestOpened(sessionId: string, params: Record<string, unknown>, receivedAt: string): Promise<DriverEvent | null> {
    const requestId = string(params.requestId);
    const method = string(params.method);
    const requestParams = record(params.params);
    const threadId = string(requestParams?.threadId);
    const turnId = string(requestParams?.turnId);
    if (!requestId || !method || !requestParams || !threadId || !turnId) return null;
    const persisted = await this.options.requestStore?.upsertAppServerRequest({
      sessionId,
      requestId,
      method,
      params: requestParams,
      threadId,
      turnId,
      receivedAt,
      lastSeenAt: receivedAt
    });
    const key = pendingKey(sessionId, requestId);
    const responded = persisted ? persisted.state === "responded" : (this.pendingRequests.get(key)?.responded ?? false);
    this.pendingRequests.set(key, { sessionId, requestId, method, params: requestParams, threadId, turnId, responded });
    if (responded) {
      // The host re-announces requests it is still waiting on; deliver the operator's durable answer again.
      if (persisted?.response !== null && persisted?.response !== undefined) {
        await this.connections.get(sessionId)?.rpc.request("request/respond", { requestId, response: persisted.response }).catch(() => undefined);
      }
      return null;
    }
    return { method, params: { requestId, params: requestParams, openedAt: string(params.openedAt) ?? receivedAt }, receivedAt };
  }

  /** After reconnecting, redeliver answered requests and close requests a restarted host no longer holds. */
  private async reconcileRequestsAfterReconnect(sessionId: string, connection: HostConnection, state: HostSessionState): Promise<void> {
    const store = this.options.requestStore;
    if (!store) return;
    const live = new Set(state.pendingRequests.map((request) => request.requestId));
    for (const request of await store.listUnresolvedAppServerRequests(sessionId)) {
      const requestId = String(request.requestId);
      if (!live.has(requestId)) {
        await store.resolveAppServerRequest(sessionId, request.requestId, this.now().toISOString());
        this.pendingRequests.delete(pendingKey(sessionId, requestId));
        continue;
      }
      if (request.state === "responded" && request.response !== null) {
        await connection.rpc.request("request/respond", { requestId, response: request.response }).catch(() => undefined);
      }
    }
  }

  private requirePending(session: ManagedSession, requestId: string | number, method: string): PendingRequest {
    this.connectionFor(session);
    const pending = this.pendingRequests.get(pendingKey(session.id, String(requestId)));
    if (!pending) throw new Error(`Unknown Claude request id: ${requestId}`);
    if (pending.method !== method) throw new Error(`Claude request ${requestId} is not a ${method} request`);
    if (pending.responded) throw new Error(`Claude request was already answered: ${requestId}`);
    return pending;
  }

  private async respondPending(session: ManagedSession, pending: PendingRequest, response: unknown): Promise<void> {
    const connection = this.connectionFor(session);
    if (this.options.requestStore) {
      const claimed = await this.options.requestStore.claimAppServerRequestResponse(session.id, pending.requestId, response, this.now().toISOString());
      if (!claimed) throw new Error(`Claude request was already answered: ${pending.requestId}`);
    }
    pending.responded = true;
    const result = await connection.rpc.request<{ accepted: boolean }>("request/respond", { requestId: pending.requestId, response });
    if (!result.accepted) {
      await this.options.requestStore?.resolveAppServerRequest(session.id, pending.requestId, this.now().toISOString());
      this.pendingRequests.delete(pendingKey(session.id, pending.requestId));
      throw new Error("The Claude request is no longer waiting for an answer");
    }
  }

  private async readState(session: ManagedSession): Promise<HostSessionState> {
    const state = await this.connectionFor(session).rpc.request<HostSessionState | null>("state/read", {});
    if (!state) throw new Error("The Claude host has no open session");
    return state;
  }

  private connectionFor(session: ManagedSession): HostConnection {
    requireRuntime(session);
    const connection = this.connections.get(session.id);
    const threadId = session.provider.threadId;
    if (!connection || !threadId || connection.threadId !== threadId) {
      throw new Error("Claude session is not reconciled and ready for input");
    }
    return connection;
  }

  private async closeConnection(sessionId: string): Promise<void> {
    const connection = this.connections.get(sessionId);
    this.connections.delete(sessionId);
    await connection?.rpc.close().catch(() => undefined);
  }

  private forgetSession(sessionId: string): void {
    this.activeTurns.delete(sessionId);
    for (const [key, pending] of this.pendingRequests) {
      if (pending.sessionId === sessionId) this.pendingRequests.delete(key);
    }
  }

  private emit(sessionId: string, event: DriverEvent): void {
    for (const listener of this.subscribers.get(sessionId) ?? []) {
      try {
        listener(event);
      } catch {
        // A UI subscriber cannot fail the runtime transport.
      }
    }
  }

  private serializeLaunch<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.launchTails.get(sessionId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.catch(() => undefined);
    this.launchTails.set(sessionId, tail);
    void tail.finally(() => {
      if (this.launchTails.get(sessionId) === tail) this.launchTails.delete(sessionId);
    });
    return result;
  }
}

function approvalResponse(decision: ApprovalDecision): HostApprovalResponse {
  if (decision === "deny") return { behavior: "deny" };
  if (decision === "approve_for_prefix") return { behavior: "allow", scope: "prefix" };
  if (decision === "approve_for_session" || decision === "approve_always") return { behavior: "allow", scope: "session" };
  return { behavior: "allow", scope: "once" };
}

function hostInput(text: string, content?: MessageContentPart[]): HostInputPart[] {
  if (!content?.length) return [{ type: "text", value: text }];
  return content.map((part): HostInputPart => part.type === "text"
    ? { type: "text", value: part.text }
    : { type: "image", value: part.id, mimeType: part.mimeType });
}

function receipt(threadId: string, turnId: string, clientMessageId: string, now: Date): DriverInputReceipt {
  return { clientMessageId, threadId, turnId, acceptedAt: now.toISOString() };
}

function requireRuntime(session: ManagedSession): SystemdSessionRuntimeRef {
  if (session.runtime?.kind !== "systemd_service") throw new Error("Session is not owned by a Claude runtime");
  return session.runtime;
}

function requireSourceThread(spec: AgentSessionLaunchSpec): string {
  if (!spec.sourceThreadId?.trim()) throw new Error("Claude resume/fork requires a source session id");
  return spec.sourceThreadId;
}

function pendingKey(sessionId: string, requestId: string): string {
  return `${sessionId}\0${requestId}`;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
