import type { Logger } from "pino";
import type {
  BtwDocumentOperation,
  BtwExchange,
  BtwExchangeStatus
} from "@muxpilot/core";
import type { AppDatabase } from "../db/database.js";
import { eventId } from "../utils/ids.js";
import { nowIso } from "../utils/time.js";
import type { EventBus } from "./eventBus.js";
import type { BtwDocumentApplyResult, BtwDocumentChanges } from "./sessionDocuments.js";
import {
  CodexAppServerClient,
  type CodexAppServerClientOptions,
  type CodexAppServerMessage
} from "./codexUsage.js";

const BTW_RESTART_ERROR = "muxpilot restarted before this BTW answer completed.";
const BTW_INTERACTIVE_ERROR = "BTW questions cannot request interactive input or approval.";
const BTW_TIMEOUT_MS = 120_000;
const BTW_HANDOFF_RETRY_MS = 1_000;
const BTW_READ_ONLY_INSTRUCTIONS = `You are answering one quick side question from a snapshot of another Codex conversation.
Answer directly and concisely. Do not continue, steer, or modify the source task.
This thread is strictly read-only: do not edit files, change repository state, send messages, create goals, delegate work, request user input, use network access, or perform external side effects.
You may inspect local files with read-only tools only when needed to answer accurately.
If the snapshot is incomplete or the answer cannot be established safely, say so briefly.`;

interface BtwDocumentCoordinator {
  prepareBtwDocumentStaging(sessionId: string, exchangeId: string): Promise<{ documentsRoot: string; sourceCwd: string }>;
  inspectBtwDocumentStaging(sessionId: string, exchangeId: string): Promise<BtwDocumentChanges>;
  cleanupBtwDocumentStaging(sessionId: string, exchangeId: string): Promise<void>;
  applyBtwDocumentStaging(
    sessionId: string,
    exchangeId: string
  ): Promise<{ status: "not_ready" } | (BtwDocumentApplyResult & { noticeDelivered?: boolean })>;
  deliverBtwDocumentNotice(sessionId: string, exchangeId: string, changes: BtwDocumentChanges): Promise<boolean>;
}

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
  documents?: BtwDocumentCoordinator;
  logger?: Pick<Logger, "warn" | "debug">;
  now?: () => string;
  handoffRetryMs?: number;
}

interface ActiveBtwRun {
  exchange: BtwExchange;
  sourceCodexSessionId: string;
  threadId: string | null;
  turnId: string | null;
  documentsRoot: string | null;
  sourceCwd: string | null;
  cancelled: boolean;
  finished: boolean;
  retrying: boolean;
  handoffBusy: boolean;
  timeout: ReturnType<typeof setTimeout> | null;
  handoffTimer: ReturnType<typeof setTimeout> | null;
  handoffPromise: Promise<void> | null;
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
  private readonly documents?: BtwDocumentCoordinator;
  private readonly logger?: Pick<Logger, "warn" | "debug">;
  private readonly now: () => string;
  private readonly handoffRetryMs: number;
  private readonly activeBySession = new Map<string, ActiveBtwRun>();
  private readonly activeByThread = new Map<string, ActiveBtwRun>();
  private readonly startingSessions = new Set<string>();
  private readonly unsubscribeMessage: () => void;
  private readonly unsubscribeClose: () => void;
  private authenticationGuard: (() => void) | null = null;

  constructor(options: BtwServiceOptions) {
    this.db = options.db;
    this.events = options.events;
    this.client = options.client;
    this.documents = options.documents;
    this.logger = options.logger;
    this.now = options.now ?? nowIso;
    this.handoffRetryMs = options.handoffRetryMs ?? BTW_HANDOFF_RETRY_MS;
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
    for (const exchange of await this.db.listRunningBtwExchanges()) {
      if (this.documents && isPendingDocumentHandoff(exchange.documentOperation)) {
        const run = await this.restoreDocumentHandoff(exchange);
        if (run) {
          this.activeBySession.set(exchange.sessionId, run);
          this.scheduleDocumentHandoff(run);
          continue;
        }
      }
      await this.db.failBtwExchange(exchange.sessionId, exchange.id, BTW_RESTART_ERROR, this.now());
      await this.documents?.cleanupBtwDocumentStaging(exchange.sessionId, exchange.id).catch(() => undefined);
    }
    void this.client.initialize().catch((error) => {
      this.logger?.warn({ err: error }, "BTW Codex app-server warmup failed; the next question will retry");
    });
  }

  authenticationBlockers(): string[] {
    return [...new Set([...this.startingSessions, ...this.activeBySession.keys()])];
  }

  setAuthenticationGuard(guard: (() => void) | null): void {
    this.authenticationGuard = guard;
  }

  invalidateAuthentication(): void {
    if (this.startingSessions.size === 0 && this.activeBySession.size === 0) this.client.stop();
  }

  async stop(): Promise<void> {
    const runs = [...this.activeBySession.values()];
    await Promise.all(runs.map(async (run) => {
      if (isPendingDocumentHandoff(run.exchange.documentOperation)) {
        this.clearRunTimers(run);
        await run.handoffPromise;
        if (run.finished) return;
        this.clearRunTimers(run);
        run.finished = true;
        this.activeBySession.delete(run.exchange.sessionId);
        return;
      }
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
    this.authenticationGuard?.();
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
        completedAt: null,
        documentOperation: null
      };
      const run = this.newRun(exchange, session.codexSessionId);
      await this.db.putBtwExchange(exchange);
      this.activeBySession.set(sessionId, run);
      this.publish("btw.started", exchange);
      void this.runAttempt(run);
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
    if (run.handoffBusy) throw new BtwError("Document changes are being handed off; wait for this BTW request to finish", 409);
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

  private newRun(exchange: BtwExchange, sourceCodexSessionId: string): ActiveBtwRun {
    return {
      exchange,
      sourceCodexSessionId,
      threadId: null,
      turnId: null,
      documentsRoot: null,
      sourceCwd: null,
      cancelled: false,
      finished: false,
      retrying: false,
      handoffBusy: false,
      timeout: null,
      handoffTimer: null,
      handoffPromise: null
    };
  }

  private async restoreDocumentHandoff(exchange: BtwExchange): Promise<ActiveBtwRun | null> {
    const session = await this.db.getSession(exchange.sessionId);
    if (!session?.codexSessionId) return null;
    return this.newRun(exchange, session.codexSessionId);
  }

  private async runAttempt(run: ActiveBtwRun): Promise<void> {
    try {
      if (this.documents) {
        const staging = await this.documents.prepareBtwDocumentStaging(run.exchange.sessionId, run.exchange.id);
        run.documentsRoot = staging.documentsRoot;
        run.sourceCwd = staging.sourceCwd;
      }
      run.timeout = setTimeout(() => void this.timeoutRun(run), BTW_TIMEOUT_MS);
      const fork = await this.client.request<ThreadForkResponse>("thread/fork", this.forkParams(run));
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
        turn = await this.startTurn(run, true);
      } catch (error) {
        if (!isUnsupportedEffortError(error)) throw error;
        turn = await this.startTurn(run, false);
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

  private forkParams(run: ActiveBtwRun): Record<string, unknown> {
    if (!run.documentsRoot) {
      return {
        threadId: run.sourceCodexSessionId,
        ephemeral: true,
        excludeTurns: true,
        approvalPolicy: "never",
        sandbox: "read-only",
        developerInstructions: BTW_READ_ONLY_INSTRUCTIONS
      };
    }
    return {
      threadId: run.sourceCodexSessionId,
      ephemeral: true,
      excludeTurns: true,
      approvalPolicy: "never",
      sandbox: "workspace-write",
      cwd: run.documentsRoot,
      runtimeWorkspaceRoots: [run.documentsRoot],
      developerInstructions: documentInstructions(run.documentsRoot, run.sourceCwd)
    };
  }

  private startTurn(run: ActiveBtwRun, lowEffort: boolean): Promise<TurnStartResponse> {
    const workspaceWrite = Boolean(run.documentsRoot);
    return this.client.request<TurnStartResponse>("turn/start", {
      threadId: run.threadId,
      input: [{ type: "text", text: run.exchange.question }],
      ...(lowEffort ? { effort: "low" } : {}),
      summary: "none",
      approvalPolicy: "never",
      sandboxPolicy: workspaceWrite
        ? {
            type: "workspaceWrite",
            writableRoots: [run.documentsRoot],
            networkAccess: false,
            excludeTmpdirEnvVar: true,
            excludeSlashTmp: true
          }
        : { type: "readOnly", networkAccess: false }
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
      if (run.retrying) return;
      const delta = stringValue(params?.delta);
      if (!delta) return;
      const firstTokenAt = run.exchange.firstTokenAt ?? this.now();
      run.exchange = { ...run.exchange, answer: run.exchange.answer + delta, firstTokenAt };
      this.publish("btw.delta", { exchangeId: run.exchange.id, delta, firstTokenAt });
      return;
    }

    if (message.method === "turn/completed") {
      const turn = recordValue(params?.turn);
      const status = stringValue(turn?.status);
      if (run.cancelled || status === "interrupted") {
        void this.finish(run, "cancelled", null);
      } else if (status === "completed") {
        void this.completeGeneration(run);
      } else if (status === "failed") {
        const error = recordValue(turn?.error);
        void this.finish(run, "failed", stringValue(error?.message) ?? "Codex could not answer this BTW question.");
      }
    }
  }

  private async completeGeneration(run: ActiveBtwRun): Promise<void> {
    await this.cleanupGenerationThread(run);
    if (run.finished || run.cancelled) return;
    if (!this.documents) {
      await this.finish(run, "completed", null);
      return;
    }
    try {
      const changes = await this.documents.inspectBtwDocumentStaging(run.exchange.sessionId, run.exchange.id);
      if (run.finished || run.cancelled) return;
      if (changes.created.length === 0 && changes.updated.length === 0) {
        if (run.retrying) {
          run.exchange = {
            ...run.exchange,
            documentOperation: operation("applied", changes, run.exchange.documentOperation?.retryCount ?? 1)
          };
        }
        await this.finish(run, "completed", null);
        return;
      }
      const retryCount = run.exchange.documentOperation?.retryCount ?? 0;
      run.exchange = { ...run.exchange, documentOperation: operation("waiting", changes, retryCount) };
      run.retrying = false;
      await this.persistAndPublish(run);
      this.scheduleDocumentHandoff(run);
    } catch (error) {
      await this.finish(run, "failed", errorMessage(error));
    }
  }

  private scheduleDocumentHandoff(run: ActiveBtwRun): void {
    if (run.finished || run.handoffTimer) return;
    run.handoffTimer = setTimeout(() => {
      run.handoffTimer = null;
      const handoff = this.processDocumentHandoff(run);
      run.handoffPromise = handoff;
      void handoff.finally(() => {
        if (run.handoffPromise === handoff) run.handoffPromise = null;
      });
    }, this.handoffRetryMs);
  }

  private async processDocumentHandoff(run: ActiveBtwRun): Promise<void> {
    if (run.finished || run.handoffBusy || !this.documents || !run.exchange.documentOperation) return;
    run.handoffBusy = true;
    try {
      if (run.exchange.documentOperation.phase === "notifying") {
        const delivered = await this.documents.deliverBtwDocumentNotice(
          run.exchange.sessionId,
          run.exchange.id,
          changesFromOperation(run.exchange.documentOperation)
        );
        if (!delivered) {
          this.scheduleDocumentHandoff(run);
          return;
        }
        run.exchange = {
          ...run.exchange,
          documentOperation: { ...run.exchange.documentOperation, phase: "applied" }
        };
        await this.finish(run, "completed", null);
        return;
      }

      const result = await this.documents.applyBtwDocumentStaging(run.exchange.sessionId, run.exchange.id);
      if (result.status === "not_ready") {
        this.scheduleDocumentHandoff(run);
        return;
      }
      if (result.status === "conflict") {
        await this.handleDocumentConflict(run, result.names);
        return;
      }
      if (!result.noticeDelivered) {
        run.exchange = {
          ...run.exchange,
          documentOperation: operation("notifying", result.changes, run.exchange.documentOperation.retryCount)
        };
        await this.persistAndPublish(run);
        this.scheduleDocumentHandoff(run);
        return;
      }
      run.exchange = {
        ...run.exchange,
        documentOperation: operation("applied", result.changes, run.exchange.documentOperation.retryCount)
      };
      await this.finish(run, "completed", null);
    } catch (error) {
      await this.finish(run, "failed", errorMessage(error));
    } finally {
      run.handoffBusy = false;
    }
  }

  private async handleDocumentConflict(run: ActiveBtwRun, names: string[]): Promise<void> {
    const retryCount = run.exchange.documentOperation?.retryCount ?? 0;
    if (retryCount >= 1) {
      run.exchange = {
        ...run.exchange,
        documentOperation: {
          phase: "conflict",
          created: run.exchange.documentOperation?.created ?? [],
          updated: run.exchange.documentOperation?.updated ?? names,
          retryCount
        }
      };
      await this.finish(run, "failed", `Documents changed again while BTW was updating: ${names.join(", ")}`);
      return;
    }
    run.exchange = {
      ...run.exchange,
      documentOperation: operation("retrying", changesFromOperation(run.exchange.documentOperation!), 1)
    };
    run.retrying = true;
    await this.persistAndPublish(run);
    await this.cleanupGenerationThread(run);
    void this.runAttempt(run);
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
      if (isPendingDocumentHandoff(run.exchange.documentOperation)) continue;
      void this.finish(run, "failed", `Codex app-server stopped: ${errorMessage(error)}`, false);
    }
  }

  private async timeoutRun(run: ActiveBtwRun): Promise<void> {
    if (run.finished || isPendingDocumentHandoff(run.exchange.documentOperation)) return;
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
    this.clearRunTimers(run);
    run.exchange = { ...run.exchange, status, error, completedAt: this.now() };
    this.activeBySession.delete(run.exchange.sessionId);
    if (run.threadId) this.activeByThread.delete(run.threadId);
    await this.db.putBtwExchange(run.exchange);
    this.publish("btw.finished", run.exchange);
    if (cleanup && run.threadId) await this.cleanupThread(run.threadId);
    await this.documents?.cleanupBtwDocumentStaging(run.exchange.sessionId, run.exchange.id).catch((cleanupError) => {
      this.logger?.debug({ err: cleanupError, exchangeId: run.exchange.id }, "BTW document staging cleanup failed");
    });
  }

  private async persistAndPublish(run: ActiveBtwRun): Promise<void> {
    await this.db.putBtwExchange(run.exchange);
    this.publish("btw.updated", run.exchange);
  }

  private clearGeneration(run: ActiveBtwRun): void {
    if (run.timeout) clearTimeout(run.timeout);
    run.timeout = null;
    if (run.threadId) this.activeByThread.delete(run.threadId);
    run.turnId = null;
  }

  private clearRunTimers(run: ActiveBtwRun): void {
    this.clearGeneration(run);
    if (run.handoffTimer) clearTimeout(run.handoffTimer);
    run.handoffTimer = null;
  }

  private async cleanupGenerationThread(run: ActiveBtwRun): Promise<void> {
    this.clearGeneration(run);
    const threadId = run.threadId;
    run.threadId = null;
    if (threadId) await this.cleanupThread(threadId);
  }

  private async cleanupThread(threadId: string): Promise<void> {
    try {
      await this.client.request("thread/unsubscribe", { threadId });
    } catch (error) {
      this.logger?.debug({ err: error, threadId }, "BTW thread unsubscribe failed");
    }
  }

  private publish(type: "btw.started" | "btw.delta" | "btw.updated" | "btw.finished", payload: unknown): void {
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

function operation(
  phase: BtwDocumentOperation["phase"],
  changes: BtwDocumentChanges,
  retryCount: number
): BtwDocumentOperation {
  return { phase, created: changes.created, updated: changes.updated, retryCount };
}

function changesFromOperation(documentOperation: BtwDocumentOperation): BtwDocumentChanges {
  return { created: documentOperation.created, updated: documentOperation.updated };
}

function isPendingDocumentHandoff(documentOperation: BtwDocumentOperation | null | undefined): boolean {
  return documentOperation?.phase === "waiting" || documentOperation?.phase === "notifying";
}

function documentInstructions(documentsRoot: string, sourceCwd: string | null): string {
  return `You are answering one quick side request from a snapshot of another Codex conversation.
Answer directly and concisely. Do not continue, steer, interrupt, or message the source task.
You may create or update Markdown session documents only when the operator explicitly asks you to do so. The only writable directory is ${JSON.stringify(documentsRoot)}.
Keep INDEX.md current when creating documents. Do not delete or rename documents. Do not edit repository files, change repository state, create goals, delegate work, request user input, use network access, or perform any other side effect.
The source workspace path is ${sourceCwd ? JSON.stringify(sourceCwd) : "unavailable"}; inspect it read-only only when needed for accurate document content.
If the snapshot is incomplete or the request cannot be completed safely, say so briefly.`;
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
