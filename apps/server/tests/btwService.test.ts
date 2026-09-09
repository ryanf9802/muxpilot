import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ManagedSession, SessionEvent } from "@muxpilot/core";
import { AppDatabase } from "../src/db/database.js";
import { BtwService, type BtwError } from "../src/services/btwService.js";
import type { CodexAppServerMessage } from "../src/services/codexUsage.js";
import { EventBus } from "../src/services/eventBus.js";

describe("BtwService", () => {
  it("isolates document writes and waits for a safe applied handoff", async () => {
    const db = await tempDb();
    await db.upsertSession(testSession("source"), "2026-08-26T12:00:00.000Z");
    const client = new FakeAppServerClient();
    const coordinator = new FakeDocumentCoordinator();
    const events = new EventBus();
    const published: SessionEvent[] = [];
    events.subscribe((event) => published.push(event));
    const service = new BtwService({ db, events, client, documents: coordinator, handoffRetryMs: 0, now: timestampClock() });
    await service.start();

    const exchange = await service.ask("source", "Create plan.md with an implementation checklist");
    await eventually(() => client.requests.some((request) => request.method === "turn/start"));
    const forkParams = client.requests.find((request) => request.method === "thread/fork")?.params;
    expect(forkParams).toMatchObject({
      ephemeral: true,
      sandbox: "workspace-write",
      cwd: "/staging/documents",
      runtimeWorkspaceRoots: ["/staging/documents"]
    });
    expect(forkParams).not.toHaveProperty("deferGoalContinuation");
    expect(client.requests.find((request) => request.method === "turn/start")?.params).toMatchObject({
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: ["/staging/documents"],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true
      }
    });

    client.emit({
      method: "turn/completed",
      params: { threadId: "btw-thread", turn: { id: "btw-turn", status: "completed", error: null } }
    });
    await eventually(async () => (await db.getBtwExchange("source", exchange.id))?.status === "completed");

    expect(coordinator.applyCalls).toBe(1);
    expect(await db.getBtwExchange("source", exchange.id)).toMatchObject({
      status: "completed",
      documentOperation: { phase: "applied", created: ["plan.md"], updated: [], retryCount: 0 }
    });
    expect(published.map((event) => event.type)).toEqual(["btw.started", "btw.updated", "btw.finished"]);
    await service.stop();
    await db.close();
  });

  it("completes an ordinary BTW answer without a document handoff when staging is unchanged", async () => {
    const db = await tempDb();
    await db.upsertSession(testSession("source"), "2026-08-26T12:00:00.000Z");
    const client = new FakeAppServerClient();
    const coordinator = new FakeDocumentCoordinator();
    coordinator.changes = { created: [], updated: [] };
    const service = new BtwService({ db, events: new EventBus(), client, documents: coordinator, now: timestampClock() });
    await service.start();

    const exchange = await service.ask("source", "What owns input delivery?");
    await eventually(() => client.requests.some((request) => request.method === "turn/start"));
    client.emit({ method: "item/agentMessage/delta", params: { threadId: "btw-thread", delta: "SessionManager" } });
    client.emit({ method: "turn/completed", params: { threadId: "btw-thread", turn: { id: "btw-turn", status: "completed" } } });
    await eventually(async () => (await db.getBtwExchange("source", exchange.id))?.status === "completed");

    expect(await db.getBtwExchange("source", exchange.id)).toMatchObject({
      answer: "SessionManager",
      status: "completed",
      documentOperation: null
    });
    expect(coordinator.applyCalls).toBe(0);
    await service.stop();
    await db.close();
  });

  it("regenerates once from fresh documents when the handoff conflicts", async () => {
    const db = await tempDb();
    await db.upsertSession(testSession("source"), "2026-08-26T12:00:00.000Z");
    const client = new FakeAppServerClient();
    const coordinator = new FakeDocumentCoordinator();
    coordinator.conflictsRemaining = 1;
    const service = new BtwService({
      db,
      events: new EventBus(),
      client,
      documents: coordinator,
      handoffRetryMs: 0,
      now: timestampClock()
    });
    await service.start();

    const exchange = await service.ask("source", "Update plan.md");
    await eventually(() => client.requests.filter((request) => request.method === "turn/start").length === 1);
    client.emit({ method: "turn/completed", params: { threadId: "btw-thread", turn: { id: "btw-turn", status: "completed" } } });
    await eventually(() => client.requests.filter((request) => request.method === "turn/start").length === 2);
    expect(await db.getBtwExchange("source", exchange.id)).toMatchObject({
      status: "running",
      documentOperation: { phase: "retrying", retryCount: 1 }
    });

    client.emit({ method: "turn/completed", params: { threadId: "btw-thread", turn: { id: "btw-turn", status: "completed" } } });
    await eventually(async () => (await db.getBtwExchange("source", exchange.id))?.status === "completed");
    expect(coordinator.applyCalls).toBe(2);
    expect(coordinator.prepareCalls).toBe(2);
    expect(await db.getBtwExchange("source", exchange.id)).toMatchObject({
      documentOperation: { phase: "applied", retryCount: 1 }
    });
    await service.stop();
    await db.close();
  });

  it("resumes a persisted waiting document handoff after restart without recreating staging", async () => {
    const db = await tempDb();
    await db.upsertSession(testSession("source"), "2026-08-26T12:00:00.000Z");
    await db.putBtwExchange({
      id: "waiting-exchange",
      sessionId: "source",
      question: "Create plan.md",
      answer: "Created the requested plan.",
      status: "running",
      error: null,
      createdAt: "2026-08-26T11:00:00.000Z",
      firstTokenAt: "2026-08-26T11:00:01.000Z",
      completedAt: null,
      documentOperation: { phase: "waiting", created: ["plan.md"], updated: [], retryCount: 0 }
    });
    const coordinator = new FakeDocumentCoordinator();
    const service = new BtwService({
      db,
      events: new EventBus(),
      client: new FakeAppServerClient(),
      documents: coordinator,
      handoffRetryMs: 0,
      now: timestampClock()
    });

    await service.start();
    await eventually(async () => (await db.getBtwExchange("source", "waiting-exchange"))?.status === "completed");
    expect(coordinator.prepareCalls).toBe(0);
    expect(coordinator.applyCalls).toBe(1);
    await service.stop();
    await db.close();
  });

  it("fails safely instead of overwriting after a second document conflict", async () => {
    const db = await tempDb();
    await db.upsertSession(testSession("source"), "2026-08-26T12:00:00.000Z");
    const client = new FakeAppServerClient();
    const coordinator = new FakeDocumentCoordinator();
    coordinator.conflictsRemaining = 2;
    const service = new BtwService({
      db,
      events: new EventBus(),
      client,
      documents: coordinator,
      handoffRetryMs: 0,
      now: timestampClock()
    });
    await service.start();

    const exchange = await service.ask("source", "Update plan.md");
    await eventually(() => client.requests.filter((request) => request.method === "turn/start").length === 1);
    client.emit({ method: "turn/completed", params: { threadId: "btw-thread", turn: { id: "btw-turn", status: "completed" } } });
    await eventually(() => client.requests.filter((request) => request.method === "turn/start").length === 2);
    client.emit({ method: "turn/completed", params: { threadId: "btw-thread", turn: { id: "btw-turn", status: "completed" } } });
    await eventually(async () => (await db.getBtwExchange("source", exchange.id))?.status === "failed");

    expect(coordinator.applyCalls).toBe(2);
    expect(await db.getBtwExchange("source", exchange.id)).toMatchObject({
      status: "failed",
      documentOperation: { phase: "conflict", retryCount: 1 }
    });
    await service.stop();
    await db.close();
  });

  it("answers through an ephemeral read-only fork and streams outside the source transcript", async () => {
    const db = await tempDb();
    await db.upsertSession(testSession("source"), "2026-08-26T12:00:00.000Z");
    const client = new FakeAppServerClient();
    const events = new EventBus();
    const published: SessionEvent[] = [];
    events.subscribe((event) => published.push(event));
    const service = new BtwService({ db, events, client, now: timestampClock() });
    await service.start();

    const exchange = await service.ask("source", "What file owns input delivery?");
    await eventually(() => client.requests.some((request) => request.method === "turn/start"));

    const fork = client.requests.find((request) => request.method === "thread/fork");
    expect(fork?.params).toMatchObject({
      threadId: "codex-source",
      ephemeral: true,
      excludeTurns: true,
      approvalPolicy: "never",
      sandbox: "read-only"
    });
    expect(client.requests.find((request) => request.method === "turn/start")?.params).toMatchObject({
      threadId: "btw-thread",
      effort: "low",
      sandboxPolicy: { type: "readOnly", networkAccess: false }
    });

    client.emit({
      method: "item/agentMessage/delta",
      params: { threadId: "btw-thread", turnId: "btw-turn", itemId: "message", delta: "SessionManager" }
    });
    client.emit({
      method: "turn/completed",
      params: { threadId: "btw-thread", turn: { id: "btw-turn", status: "completed", error: null } }
    });
    await eventually(async () => (await db.getBtwExchange("source", exchange.id))?.status === "completed");

    expect(await db.getBtwExchange("source", exchange.id)).toMatchObject({
      answer: "SessionManager",
      status: "completed",
      error: null
    });
    expect(await db.listMessages("source", 0)).toEqual([]);
    expect(published.map((event) => event.type)).toEqual(["btw.started", "btw.delta", "btw.finished"]);
    expect(client.requests.some((request) => request.method === "thread/unsubscribe")).toBe(true);
    await service.stop();
    await db.close();
  });

  it("cancels the ephemeral turn and rejects a second active question", async () => {
    const db = await tempDb();
    await db.upsertSession(testSession("source"), "2026-08-26T12:00:00.000Z");
    const client = new FakeAppServerClient();
    const service = new BtwService({ db, events: new EventBus(), client, now: timestampClock() });
    await service.start();
    const exchange = await service.ask("source", "First question");
    await expect(service.ask("source", "Second question")).rejects.toMatchObject({ statusCode: 409 } satisfies Partial<BtwError>);
    await eventually(() => client.requests.some((request) => request.method === "turn/start"));

    expect(await service.cancel("source", exchange.id)).toMatchObject({ status: "cancelled" });
    expect(client.requests).toContainEqual(expect.objectContaining({
      method: "turn/interrupt",
      params: { threadId: "btw-thread", turnId: "btw-turn" }
    }));
    expect(await db.getBtwExchange("source", exchange.id)).toMatchObject({ status: "cancelled" });
    await service.stop();
    await db.close();
  });

  it("denies interactive requests and repairs running records on restart", async () => {
    const db = await tempDb();
    await db.upsertSession(testSession("source"), "2026-08-26T12:00:00.000Z");
    await db.putBtwExchange({
      id: "stale",
      sessionId: "source",
      question: "Old question",
      answer: "",
      status: "running",
      error: null,
      createdAt: "2026-08-26T11:00:00.000Z",
      firstTokenAt: null,
      completedAt: null
    });
    const client = new FakeAppServerClient();
    const service = new BtwService({ db, events: new EventBus(), client, now: timestampClock() });
    await service.start();
    expect(await db.getBtwExchange("source", "stale")).toMatchObject({ status: "failed" });

    const exchange = await service.ask("source", "Do not prompt me");
    await eventually(() => client.requests.some((request) => request.method === "turn/start"));
    client.emit({ id: 77, method: "item/commandExecution/requestApproval", params: { threadId: "btw-thread" } });
    expect(client.responses).toContainEqual({ id: 77, result: { decision: "decline" } });
    client.emit({ id: 78, method: "execCommandApproval", params: { threadId: "btw-thread" } });
    expect(client.responses).toContainEqual({
      id: 78,
      result: { decision: { denied: { rejection: "BTW questions cannot request interactive input or approval." } } }
    });
    await service.cancel("source", exchange.id);
    await db.rekeySession("source", testSession("reconciled"), null, "2026-08-26T12:01:00.000Z");
    expect(await db.getBtwExchange("source", exchange.id)).toBeNull();
    expect(await db.getBtwExchange("reconciled", exchange.id)).toMatchObject({ status: "cancelled" });
    await service.stop();
    await db.close();
  });

  it("does not block startup on the optional Codex app-server warmup", async () => {
    const db = await tempDb();
    const client = new FakeAppServerClient();
    const warmupError = new Error("warmup timed out");
    let rejectWarmup!: (error: Error) => void;
    client.initializeResult = new Promise<void>((_resolve, reject) => {
      rejectWarmup = reject;
    });
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const service = new BtwService({ db, events: new EventBus(), client, logger });
    let started = false;

    const start = service.start().then(() => {
      started = true;
    });
    await eventually(() => client.initializeCalls === 1);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(started).toBe(true);
    rejectWarmup(warmupError);
    await start;
    await eventually(() => logger.warn.mock.calls.length === 1);
    expect(logger.warn).toHaveBeenCalledWith(
      { err: warmupError },
      "BTW Codex app-server warmup failed; the next question will retry"
    );

    await service.stop();
    await db.close();
  });
});

class FakeAppServerClient {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly responses: Array<{ id: string | number; result?: unknown; error?: unknown }> = [];
  initializeCalls = 0;
  initializeResult: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(message: CodexAppServerMessage) => void>();
  private readonly closeListeners = new Set<(error: Error) => void>();

  initialize(): Promise<void> {
    this.initializeCalls += 1;
    return this.initializeResult;
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    if (method === "thread/fork") return { thread: { id: "btw-thread", ephemeral: true } } as T;
    if (method === "turn/start") return { turn: { id: "btw-turn", status: "inProgress" } } as T;
    return {} as T;
  }

  respond(id: string | number, result: unknown): void {
    this.responses.push({ id, result });
  }

  respondError(id: string | number, message: string, code = -32000): void {
    this.responses.push({ id, error: { code, message } });
  }

  subscribe(listener: (message: CodexAppServerMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeClose(listener: (error: Error) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  emit(message: CodexAppServerMessage): void {
    for (const listener of this.listeners) listener(message);
  }

  stop(): void {}
}

class FakeDocumentCoordinator {
  applyCalls = 0;
  prepareCalls = 0;
  conflictsRemaining = 0;
  changes = { created: ["plan.md"], updated: [] as string[] };

  async prepareBtwDocumentStaging(): Promise<{ documentsRoot: string; sourceCwd: string }> {
    this.prepareCalls += 1;
    return { documentsRoot: "/staging/documents", sourceCwd: "/repo" };
  }

  async inspectBtwDocumentStaging(): Promise<{ created: string[]; updated: string[] }> {
    return this.changes;
  }

  async cleanupBtwDocumentStaging(): Promise<void> {}

  async applyBtwDocumentStaging(): Promise<
    | { status: "conflict"; names: string[] }
    | { status: "applied"; changes: { created: string[]; updated: string[] }; noticeDelivered: boolean }
  > {
    this.applyCalls += 1;
    if (this.conflictsRemaining > 0) {
      this.conflictsRemaining -= 1;
      return { status: "conflict", names: ["plan.md"] };
    }
    return { status: "applied", changes: this.changes, noticeDelivered: true };
  }

  async deliverBtwDocumentNotice(): Promise<boolean> {
    return true;
  }
}

async function tempDb(): Promise<AppDatabase> {
  const dir = await mkdtemp(join(tmpdir(), "muxpilot-btw-"));
  return new AppDatabase(join(dir, "test.db"));
}

function timestampClock(): () => string {
  let seconds = 0;
  return () => `2026-08-26T12:00:${String(seconds++).padStart(2, "0")}.000Z`;
}

async function eventually(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not reached");
}

function testSession(id: string): ManagedSession {
  return {
    id,
    name: id,
    cwd: "/repo",
    provider: { kind: "codex", threadId: "codex-source", rolloutPath: "/tmp/codex.jsonl" },
    repo: { root: "/repo", name: "repo", branch: "main", dirty: false, worktree: null },
    codexSessionId: "codex-source",
    codexJsonlPath: "/tmp/codex.jsonl",
    discoveryConfidence: "high",
    status: "working",
    lastActivityAt: null,
    preview: "",
    recentUserPrompts: [],
    activitySummary: null,
    activitySummaryGeneratedAt: null,
    activitySummarySourceSequence: null,
    inputMode: "default",
    models: { default: { model: null, reasoningEffort: null }, plan: { model: null, reasoningEffort: null } },
    transcriptSize: 0,
    unreadCount: 0,
    pinned: false,
    archived: false
  };
}
