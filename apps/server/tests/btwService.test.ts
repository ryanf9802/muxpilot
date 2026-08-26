import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ManagedSession, SessionEvent } from "@muxpilot/core";
import { AppDatabase } from "../src/db/database.js";
import { BtwService, type BtwError } from "../src/services/btwService.js";
import type { CodexAppServerMessage } from "../src/services/codexUsage.js";
import { EventBus } from "../src/services/eventBus.js";

describe("BtwService", () => {
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
});

class FakeAppServerClient {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly responses: Array<{ id: string | number; result?: unknown; error?: unknown }> = [];
  private readonly listeners = new Set<(message: CodexAppServerMessage) => void>();
  private readonly closeListeners = new Set<(error: Error) => void>();

  async initialize(): Promise<void> {}

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
    tmux: {
      sessionId: "tmux-session",
      sessionName: "work",
      windowId: "@1",
      windowIndex: 1,
      windowName: "codex",
      paneId: "%1",
      paneIndex: 0,
      paneActive: true,
      cwd: "/repo",
      currentCommand: "codex",
      title: "codex",
      pid: 123,
      size: "120x40"
    },
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
