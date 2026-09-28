import type { Logger } from "pino";
import type {
  AgentProviderKind,
  BtwDocumentOperation,
  BtwExchange,
  BtwExchangeStatus,
  ManagedSession
} from "@muxpilot/core";
import { providerDisplayName, sessionThreadId } from "@muxpilot/core";
import type { AppDatabase } from "../db/database.js";
import { btwErrorMessage, type BtwEngine, type BtwGeneration, type BtwGenerationListener } from "../providers/shared/btw.js";
import { eventId } from "../utils/ids.js";
import { nowIso } from "../utils/time.js";
import type { EventBus } from "./eventBus.js";
import type { BtwDocumentApplyResult, BtwDocumentChanges } from "./sessionDocuments.js";
import { isSessionDocumentCapacityError } from "./sessionDocuments.js";

const BTW_RESTART_ERROR = "muxpilot restarted before this BTW answer completed.";
const BTW_HANDOFF_RETRY_MS = 1_000;

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

interface BtwServiceOptions {
  db: AppDatabase;
  events: EventBus;
  /** BTW backends by provider; sessions of a provider without an engine cannot ask BTW questions. */
  engines: Partial<Record<AgentProviderKind, BtwEngine>>;
  documents?: BtwDocumentCoordinator;
  logger?: Pick<Logger, "warn" | "debug">;
  now?: () => string;
  handoffRetryMs?: number;
}

/** One generation attempt; a document conflict retry starts a new attempt for the same exchange. */
interface BtwAttempt {
  abort: AbortController;
  generation: BtwGeneration | null;
  settled: boolean;
}

interface ActiveBtwRun {
  exchange: BtwExchange;
  session: ManagedSession;
  sourceThreadId: string;
  attempt: BtwAttempt | null;
  documentsRoot: string | null;
  sourceCwd: string | null;
  cancelled: boolean;
  finished: boolean;
  retrying: boolean;
  handoffBusy: boolean;
  handoffTimer: ReturnType<typeof setTimeout> | null;
  handoffPromise: Promise<void> | null;
}

export class BtwError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = "BtwError";
  }
}

/**
 * Coordinates BTW side questions: exchange persistence, cancellation, and document handoff. Generation is
 * delegated to the session provider's BTW engine.
 */
export class BtwService {
  private readonly db: AppDatabase;
  private readonly events: EventBus;
  private readonly engines: Partial<Record<AgentProviderKind, BtwEngine>>;
  private readonly documents?: BtwDocumentCoordinator;
  private readonly logger?: Pick<Logger, "warn" | "debug">;
  private readonly now: () => string;
  private readonly handoffRetryMs: number;
  private readonly activeBySession = new Map<string, ActiveBtwRun>();
  private readonly startingSessions = new Set<string>();
  private authenticationGuard: ((provider: AgentProviderKind) => void) | null = null;

  constructor(options: BtwServiceOptions) {
    this.db = options.db;
    this.events = options.events;
    this.engines = options.engines;
    this.documents = options.documents;
    this.logger = options.logger;
    this.now = options.now ?? nowIso;
    this.handoffRetryMs = options.handoffRetryMs ?? BTW_HANDOFF_RETRY_MS;
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
    for (const engine of Object.values(this.engines)) engine.start();
  }

  /** Sessions whose BTW work must finish before the provider's account can change. */
  authenticationBlockers(provider: AgentProviderKind): string[] {
    const active = [...this.activeBySession.values()]
      .filter((run) => run.session.provider.kind === provider)
      .map((run) => run.exchange.sessionId);
    return [...new Set([...this.startingSessions, ...active])];
  }

  setAuthenticationGuard(guard: ((provider: AgentProviderKind) => void) | null): void {
    this.authenticationGuard = guard;
  }

  invalidateAuthentication(provider: AgentProviderKind): void {
    if (this.authenticationBlockers(provider).length === 0) this.engines[provider]?.invalidateAuthentication();
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
      await run.attempt?.generation?.interrupt();
      await this.finish(run, "failed", "muxpilot stopped before this BTW answer completed.", false);
    }));
    for (const engine of Object.values(this.engines)) engine.stop();
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
      if (!this.engines[session.provider.kind]) {
        throw new BtwError(`BTW questions are unavailable for ${providerDisplayName(session.provider.kind)} sessions`, 409);
      }
      this.authenticationGuard?.(session.provider.kind);
      const threadId = sessionThreadId(session);
      if (!threadId) throw new BtwError("This session does not have a conversation to snapshot", 409);
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
        documentWarning: null,
        createdAt: this.now(),
        firstTokenAt: null,
        completedAt: null,
        documentOperation: null
      };
      const run = this.newRun(exchange, session, threadId);
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
    run.attempt?.abort.abort();
    await run.attempt?.generation?.interrupt();
    await this.finish(run, "cancelled", null);
    return run.exchange;
  }

  private newRun(exchange: BtwExchange, session: ManagedSession, sourceThreadId: string): ActiveBtwRun {
    return {
      exchange,
      session,
      sourceThreadId,
      attempt: null,
      documentsRoot: null,
      sourceCwd: null,
      cancelled: false,
      finished: false,
      retrying: false,
      handoffBusy: false,
      handoffTimer: null,
      handoffPromise: null
    };
  }

  private async restoreDocumentHandoff(exchange: BtwExchange): Promise<ActiveBtwRun | null> {
    const session = await this.db.getSession(exchange.sessionId);
    const threadId = session ? sessionThreadId(session) : null;
    if (!session || !threadId) return null;
    return this.newRun(exchange, session, threadId);
  }

  private async runAttempt(run: ActiveBtwRun): Promise<void> {
    const attempt: BtwAttempt = { abort: new AbortController(), generation: null, settled: false };
    run.attempt = attempt;
    try {
      if (this.documents) {
        try {
          const staging = await this.documents.prepareBtwDocumentStaging(run.exchange.sessionId, run.exchange.id);
          run.documentsRoot = staging.documentsRoot;
          run.sourceCwd = staging.sourceCwd;
        } catch (error) {
          if (!isSessionDocumentCapacityError(error)) throw error;
          run.documentsRoot = null;
          run.sourceCwd = null;
          run.exchange = {
            ...run.exchange,
            documentOperation: null,
            documentWarning: `Document editing is unavailable: ${error.message}. Ask the main session to clean up its documents.`
          };
          await this.persistAndPublish(run);
        }
      }
      const engine = this.engines[run.session.provider.kind];
      if (!engine) throw new Error(`BTW questions are unavailable for ${providerDisplayName(run.session.provider.kind)} sessions`);
      const generation = await engine.generate({
        session: run.session,
        sourceThreadId: run.sourceThreadId,
        question: run.exchange.question,
        documentsRoot: run.documentsRoot,
        sourceCwd: run.sourceCwd,
        documentsUnavailable: Boolean(run.exchange.documentWarning),
        signal: attempt.abort.signal
      }, this.listener(run, attempt));
      attempt.generation = generation;
      if (run.attempt !== attempt || attempt.settled || run.finished) {
        if (run.cancelled) await generation.interrupt();
        if (run.attempt === attempt) run.attempt = null;
        await generation.dispose();
        return;
      }
      if (run.cancelled) await this.cancel(run.exchange.sessionId, run.exchange.id);
    } catch (error) {
      if (!run.finished && run.attempt === attempt) {
        await this.finish(run, run.cancelled ? "cancelled" : "failed", run.cancelled ? null : this.errorMessage(run, error));
      }
    }
  }

  private listener(run: ActiveBtwRun, attempt: BtwAttempt): BtwGenerationListener {
    const current = () => !run.finished && run.attempt === attempt && !attempt.settled;
    const settle = () => {
      attempt.settled = true;
    };
    return {
      delta: (delta) => {
        if (!current() || run.retrying) return;
        const firstTokenAt = run.exchange.firstTokenAt ?? this.now();
        run.exchange = { ...run.exchange, answer: run.exchange.answer + delta, firstTokenAt };
        this.publish("btw.delta", { exchangeId: run.exchange.id, delta, firstTokenAt });
      },
      completed: () => {
        if (!current()) return;
        settle();
        if (run.cancelled) void this.finish(run, "cancelled", null);
        else void this.completeGeneration(run);
      },
      interrupted: () => {
        if (!current()) return;
        settle();
        void this.finish(run, "cancelled", null);
      },
      failed: (message) => {
        if (!current()) return;
        settle();
        void this.finish(run, run.cancelled ? "cancelled" : "failed", run.cancelled ? null : message);
      },
      closed: (message) => {
        if (!current()) return;
        settle();
        run.attempt = null;
        void this.finish(run, "failed", message, false);
      }
    };
  }

  private async completeGeneration(run: ActiveBtwRun): Promise<void> {
    await this.cleanupGenerationThread(run);
    if (run.finished || run.cancelled) return;
    if (!this.documents || !run.documentsRoot) {
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
      await this.finish(run, "failed", this.errorMessage(run, error));
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
      await this.finish(run, "failed", this.errorMessage(run, error));
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

  private async finish(run: ActiveBtwRun, status: BtwExchangeStatus, error: string | null, cleanup = true): Promise<void> {
    if (run.finished) return;
    run.finished = true;
    const attempt = run.attempt;
    this.clearRunTimers(run);
    attempt?.abort.abort();
    run.exchange = { ...run.exchange, status, error, completedAt: this.now() };
    this.activeBySession.delete(run.exchange.sessionId);
    await this.db.putBtwExchange(run.exchange);
    this.publish("btw.finished", run.exchange);
    if (cleanup) await attempt?.generation?.dispose();
    await this.documents?.cleanupBtwDocumentStaging(run.exchange.sessionId, run.exchange.id).catch((cleanupError) => {
      this.logger?.debug({ err: cleanupError, exchangeId: run.exchange.id }, "BTW document staging cleanup failed");
    });
  }

  private async persistAndPublish(run: ActiveBtwRun): Promise<void> {
    await this.db.putBtwExchange(run.exchange);
    this.publish("btw.updated", run.exchange);
  }

  private clearRunTimers(run: ActiveBtwRun): void {
    run.attempt = null;
    if (run.handoffTimer) clearTimeout(run.handoffTimer);
    run.handoffTimer = null;
  }

  private async cleanupGenerationThread(run: ActiveBtwRun): Promise<void> {
    const generation = run.attempt?.generation;
    run.attempt = null;
    await generation?.dispose();
  }

  private errorMessage(run: ActiveBtwRun, error: unknown): string {
    return btwErrorMessage(error, `${providerDisplayName(run.session.provider.kind)} could not answer this BTW question.`);
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
