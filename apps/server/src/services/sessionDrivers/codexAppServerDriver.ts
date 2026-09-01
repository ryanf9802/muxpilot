import { isAbsolute } from "node:path";
import type {
  ManagedSession,
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
  now?(): Date;
}

export class CodexAppServerDriver implements AgentSessionDriver {
  readonly kind = "codex_app_server" as const;
  readonly capabilities = CODEX_APP_SERVER_CAPABILITIES;
  private readonly subscribers = new Map<string, Set<(event: DriverEvent) => void>>();
  private readonly activeTurns = new Map<string, string>();
  private readonly now: () => Date;

  constructor(
    private readonly supervisor: RuntimeSupervisor,
    private readonly connections: CodexAppServerConnectionManager,
    private readonly options: CodexAppServerDriverOptions
  ) {
    this.now = options.now ?? (() => new Date());
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
    await this.supervisor.stop(runtime);
  }

  async answerApproval(): Promise<void> {
    throw new Error("App-server approval resolution is unavailable until durable gate records are enabled");
  }

  async answerQuestion(): Promise<void> {
    throw new Error("App-server question resolution is unavailable until durable gate records are enabled");
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
      notification: ({ method, params }) => {
        if (method === "turn/started") {
          const turnId = nestedId(params, "turn");
          if (turnId) this.activeTurns.set(sessionId, turnId);
        } else if (method === "turn/completed") {
          const turnId = nestedId(params, "turn");
          if (!turnId || this.activeTurns.get(sessionId) === turnId) this.activeTurns.delete(sessionId);
        }
        this.emit(sessionId, method, params);
      },
      serverRequest: ({ method, params }) => this.emit(sessionId, method, params),
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
}

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
