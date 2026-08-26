import type { Logger } from "pino";
import type { BtwExchange, BtwExchangeStatus } from "@muxpilot/core";
import type { AppDatabase } from "../db/database.js";
import { eventId } from "../utils/ids.js";
import { nowIso } from "../utils/time.js";
import type { EventBus } from "./eventBus.js";
import {
  CodexAppServerClient,
  type CodexAppServerClientOptions,
  type CodexAppServerMessage
} from "./codexUsage.js";

const BTW_RESTART_ERROR = "muxpilot restarted before this BTW answer completed.";
const BTW_INTERACTIVE_ERROR = "BTW questions cannot request interactive input or approval.";
const BTW_TIMEOUT_MS = 120_000;
const BTW_DEVELOPER_INSTRUCTIONS = `You are answering one quick side question from a snapshot of another Codex conversation.
Answer directly and concisely. Do not continue, steer, or modify the source task.
This thread is strictly read-only: do not edit files, change repository state, send messages, create goals, delegate work, request user input, use network access, or perform external side effects.
You may inspect local files with read-only tools only when needed to answer accurately.
If the snapshot is incomplete or the answer cannot be established safely, say so briefly.`;

interface BtwAppServerClient {
  initialize(): Promise<void>;
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  respond(id: string | number, result: unknown): void;
  respondError(id: string | number, message: string, code?: number): void;
  subscribe(listener: (message: CodexAppServerMessage) => void): () => void;
  subscribeClose(listener: (error: Error) => void): () => void;
  stop(): void;
}

interface BtwServiceOptions {
  db: AppDatabase;
  events: EventBus;
  client: BtwAppServerClient;
  logger?: Pick<Logger, "warn" | "debug">;
  now?: () => string;
}

interface ActiveBtwRun {
  exchange: BtwExchange;
  sourceCodexSessionId: string;
  threadId: string | null;
  turnId: string | null;
  cancelled: boolean;
  finished: boolean;
  timeout: ReturnType<typeof setTimeout> | null;
}

interface ThreadForkResponse {
  thread?: { id?: unknown };
}

interface TurnStartResponse {
  turn?: { id?: unknown };
}

export class BtwError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = "BtwError";
  }
}

export class BtwService {
  private readonly db: AppDatabase;
  private readonly events: EventBus;
  private readonly client: BtwAppServerClient;
  private readonly logger?: Pick<Logger, "warn" | "debug">;
  private readonly now: () => string;
  private readonly activeBySession = new Map<string, ActiveBtwRun>();
  private readonly activeByThread = new Map<string, ActiveBtwRun>();
  private readonly startingSessions = new Set<string>();
  private readonly unsubscribeMessage: () => void;
  private readonly unsubscribeClose: () => void;

  constructor(options: BtwServiceOptions) {
    this.db = options.db;
    this.events = options.events;
    this.client = options.client;
    this.logger = options.logger;
    this.now = options.now ?? nowIso;
    this.unsubscribeMessage = this.client.subscribe((message) => this.handleMessage(message));
    this.unsubscribeClose = this.client.subscribeClose((error) => this.handleClientClose(error));
  }

  static create(options: Omit<BtwServiceOptions, "client"> & CodexAppServerClientOptions): BtwService {
    return new BtwService({
      ...options,
      client: new CodexAppServerClient({
        codexHome: options.codexHome,
        timeoutMs: options.timeoutMs ?? 10_000,
        logger: options.logger
      })
    });
  }

  async start(): Promise<void> {
    await this.db.failRunningBtwExchanges(BTW_RESTART_ERROR, this.now());
    try {
      await this.client.initialize();
    } catch (error) {
      this.logger?.warn({ err: error }, "BTW Codex app-server warmup failed; the next question will retry");
    }
  }

  async stop(): Promise<void> {
    const runs = [...this.activeBySession.values()];
    await Promise.all(runs.map(async (run) => {
      if (run.threadId && run.turnId) {
        try {
          await this.client.request("turn/interrupt", { threadId: run.threadId, turnId: run.turnId });
        } catch {
          // The app-server may already be stopping.
        }
      }
      await this.finish(run, "failed", "muxpilot stopped before this BTW answer completed.", false);
    }));
    this.unsubscribeMessage();
    this.unsubscribeClose();
    this.client.stop();
  }

  async ask(sessionId: string, question: string): Promise<BtwExchange> {
    const text = question.trim();
    if (!text) throw new BtwError("BTW question is empty");
    if (this.startingSessions.has(sessionId) || this.activeBySession.has(sessionId)) {
      throw new BtwError("Wait for the active BTW question to finish or cancel it first", 409);
    }

    this.startingSessions.add(sessionId);
    try {
      const session = await this.db.getSession(sessionId);
      if (!session) throw new BtwError("Session not found", 404);
      if (!session.codexSessionId) throw new BtwError("This session does not have a Codex conversation to snapshot", 409);
      if (await this.db.activeBtwExchange(sessionId)) {
        throw new BtwError("Wait for the active BTW question to finish or cancel it first", 409);
      }

      const exchange: BtwExchange = {
        id: eventId(),
        sessionId,
        question: text,
        answer: "",
        status: "running",
        error: null,
        createdAt: this.now(),
        firstTokenAt: null,
        completedAt: null
      };
      const run: ActiveBtwRun = {
        exchange,
        sourceCodexSessionId: session.codexSessionId,
        threadId: null,
        turnId: null,
        cancelled: false,
        finished: false,
        timeout: null
      };
      await this.db.putBtwExchange(exchange);
      this.activeBySession.set(sessionId, run);
      run.timeout = setTimeout(() => void this.timeoutRun(run), BTW_TIMEOUT_MS);
      this.publish("btw.started", exchange);
      void this.run(run);
      return exchange;
    } finally {
      this.startingSessions.delete(sessionId);
    }
  }

  async list(sessionId: string): Promise<BtwExchange[]> {
    if (!await this.db.getSession(sessionId)) throw new BtwError("Session not found", 404);
    const exchanges = await this.db.listBtwExchanges(sessionId);
    const active = this.activeBySession.get(sessionId)?.exchange;
    return active ? exchanges.map((exchange) => exchange.id === active.id ? { ...active } : exchange) : exchanges;
  }

  async cancel(sessionId: string, exchangeId: string): Promise<BtwExchange> {
    const stored = await this.db.getBtwExchange(sessionId, exchangeId);
    if (!stored) throw new BtwError("BTW exchange not found", 404);
    const run = this.activeBySession.get(sessionId);
    if (!run || run.exchange.id !== exchangeId || run.finished || stored.status !== "running") {
      throw new BtwError("This BTW exchange is no longer running", 409);
    }
    run.cancelled = true;
    if (run.threadId && run.turnId) {
      try {
        await this.client.request("turn/interrupt", { threadId: run.threadId, turnId: run.turnId });
      } catch (error) {
        this.logger?.debug({ err: error, exchangeId }, "BTW turn interrupt failed");
      }
    }
    await this.finish(run, "cancelled", null);
    return run.exchange;
  }

  private async run(run: ActiveBtwRun): Promise<void> {
    try {
      const fork = await this.client.request<ThreadForkResponse>("thread/fork", {
        threadId: run.sourceCodexSessionId,
        ephemeral: true,
        excludeTurns: true,
        approvalPolicy: "never",
        sandbox: "read-only",
        developerInstructions: BTW_DEVELOPER_INSTRUCTIONS
      });
      const threadId = stringValue(fork.thread?.id);
      if (!threadId) throw new Error("Codex app-server did not return a BTW thread id");
      run.threadId = threadId;
      this.activeByThread.set(threadId, run);
      if (run.finished || run.cancelled) {
        await this.cleanupThread(threadId);
        return;
      }

      let turn: TurnStartResponse;
      try {
        turn = await this.startTurn(threadId, run.exchange.question, true);
      } catch (error) {
        if (!isUnsupportedEffortError(error)) throw error;
        turn = await this.startTurn(threadId, run.exchange.question, false);
      }
      const turnId = stringValue(turn.turn?.id);
      if (!turnId) throw new Error("Codex app-server did not return a BTW turn id");
      run.turnId = turnId;
      if (run.finished) {
        if (run.cancelled) {
          try {
            await this.client.request("turn/interrupt", { threadId, turnId });
          } catch {
            // Cancellation already completed from the operator's perspective.
          }
        }
        await this.cleanupThread(threadId);
        return;
      }
      if (run.cancelled && !run.finished) await this.cancel(run.exchange.sessionId, run.exchange.id);
    } catch (error) {
      if (!run.finished) {
        await this.finish(run, run.cancelled ? "cancelled" : "failed", run.cancelled ? null : errorMessage(error));
      }
    }
  }

  private startTurn(threadId: string, question: string, lowEffort: boolean): Promise<TurnStartResponse> {
    return this.client.request<TurnStartResponse>("turn/start", {
      threadId,
      input: [{ type: "text", text: question }],
      ...(lowEffort ? { effort: "low" } : {}),
      summary: "none",
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false }
    });
  }

  private handleMessage(message: CodexAppServerMessage): void {
    if (message.id !== undefined && message.method) {
      this.denyServerRequest(message.id, message.method);
      return;
    }
    if (!message.method) return;
    const params = recordValue(message.params);
    const threadId = stringValue(params?.threadId);
    if (!threadId) return;
    const run = this.activeByThread.get(threadId);
    if (!run || run.finished) return;

    if (message.method === "item/agentMessage/delta") {
      const delta = stringValue(params?.delta);
      if (!delta) return;
      const firstTokenAt = run.exchange.firstTokenAt ?? this.now();
      run.exchange = {
        ...run.exchange,
        answer: run.exchange.answer + delta,
        firstTokenAt
      };
      this.publish("btw.delta", {
        exchangeId: run.exchange.id,
        delta,
        firstTokenAt
      });
      return;
    }

    if (message.method === "turn/completed") {
      const turn = recordValue(params?.turn);
      const status = stringValue(turn?.status);
      if (run.cancelled || status === "interrupted") {
        void this.finish(run, "cancelled", null);
      } else if (status === "completed") {
        void this.finish(run, "completed", null);
      } else if (status === "failed") {
        const error = recordValue(turn?.error);
        void this.finish(run, "failed", stringValue(error?.message) ?? "Codex could not answer this BTW question.");
      }
    }
  }

  private denyServerRequest(id: string | number, method: string): void {
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      this.client.respond(id, { decision: "decline" });
      return;
    }
    if (method === "item/tool/requestUserInput") {
      this.client.respond(id, { answers: {} });
      return;
    }
    if (method === "mcpServer/elicitation/request") {
      this.client.respond(id, { action: "decline" });
      return;
    }
    if (method === "applyPatchApproval" || method === "execCommandApproval") {
      this.client.respond(id, { decision: { denied: { rejection: BTW_INTERACTIVE_ERROR } } });
      return;
    }
    this.client.respondError(id, BTW_INTERACTIVE_ERROR);
  }

  private handleClientClose(error: Error): void {
    for (const run of [...this.activeBySession.values()]) {
      void this.finish(run, "failed", `Codex app-server stopped: ${errorMessage(error)}`, false);
    }
  }

  private async timeoutRun(run: ActiveBtwRun): Promise<void> {
    if (run.finished) return;
    const threadId = run.threadId;
    const turnId = run.turnId;
    await this.finish(run, "failed", "BTW question timed out after 2 minutes.", false);
    if (threadId && turnId) {
      try {
        await this.client.request("turn/interrupt", { threadId, turnId });
      } catch {
        // The exchange is already terminal from the operator's perspective.
      }
    }
    if (threadId) await this.cleanupThread(threadId);
  }

  private async finish(run: ActiveBtwRun, status: BtwExchangeStatus, error: string | null, cleanup = true): Promise<void> {
    if (run.finished) return;
    run.finished = true;
    if (run.timeout) {
      clearTimeout(run.timeout);
      run.timeout = null;
    }
    run.exchange = {
      ...run.exchange,
      status,
      error,
      completedAt: this.now()
    };
    this.activeBySession.delete(run.exchange.sessionId);
    if (run.threadId) this.activeByThread.delete(run.threadId);
    await this.db.putBtwExchange(run.exchange);
    this.publish("btw.finished", run.exchange);
    if (cleanup && run.threadId) await this.cleanupThread(run.threadId);
  }

  private async cleanupThread(threadId: string): Promise<void> {
    try {
      await this.client.request("thread/unsubscribe", { threadId });
    } catch (error) {
      this.logger?.debug({ err: error, threadId }, "BTW thread unsubscribe failed");
    }
  }

  private publish(type: "btw.started" | "btw.delta" | "btw.finished", payload: unknown): void {
    const sessionId = type === "btw.delta"
      ? this.activeBySessionForExchange((payload as { exchangeId: string }).exchangeId)?.exchange.sessionId
      : (payload as BtwExchange).sessionId;
    if (!sessionId) return;
    this.events.publish({ id: eventId(), type, sessionId, payload, timestamp: this.now() });
  }

  private activeBySessionForExchange(exchangeId: string): ActiveBtwRun | null {
    for (const run of this.activeBySession.values()) {
      if (run.exchange.id === exchangeId) return run;
    }
    return null;
  }
}

function isUnsupportedEffortError(error: unknown): boolean {
  return error instanceof Error && /effort|reasoning/i.test(error.message);
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 1_000) || "Codex could not answer this BTW question.";
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
