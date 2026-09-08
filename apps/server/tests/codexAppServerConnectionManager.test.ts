import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { CodexAppServerConnectionManager } from "../src/services/sessionDrivers/codexAppServerConnectionManager.js";
import type { ProtocolJournal, ProtocolJournalEntry } from "../src/services/sessionDrivers/protocolJournal.js";
import type { RuntimeProxyConnection, RuntimeSupervisor, SystemdSessionRuntimeRef } from "../src/services/sessionDrivers/types.js";

const runtime: SystemdSessionRuntimeRef = {
  kind: "systemd_service",
  unit: "muxpilot-session-0123456789abcdef01234567.service",
  socketPath: "/runtime/app-server.sock",
  state: "connected",
  codexVersion: "0.152.0"
};

describe("CodexAppServerConnectionManager", () => {
  it("initializes, resumes, reads, and only then exposes a connection", async () => {
    const proxy = new FakeProtocolProxy();
    const manager = createManager([proxy]);
    expect(manager.get("session-1")).toBeNull();

    const connected = await manager.reconnect({
      sessionId: "session-1",
      runtime,
      threadId: "thread-1",
      settings: {
        cwd: "/repo",
        model: "gpt-5.6",
        developerInstructions: "Use repository rules.",
        runtimeWorkspaceRoots: ["/repo/.git", "/tmp/worktrees"]
      }
    });

    expect(proxy.methods).toEqual([
      "initialize",
      "thread/backgroundTerminals/list",
      "thread/resume",
      "thread/settings/update",
      "thread/read",
      "thread/turns/list"
    ]);
    expect(proxy.requests[2]).toMatchObject({
      method: "thread/resume",
      params: {
        threadId: "thread-1",
        excludeTurns: true,
        cwd: "/repo",
        model: "gpt-5.6",
        developerInstructions: "Use repository rules.",
        runtimeWorkspaceRoots: ["/repo/.git", "/tmp/worktrees"]
      }
    });
    expect(proxy.requests[3]).toMatchObject({
      method: "thread/settings/update",
      params: {
        threadId: "thread-1",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: ["/repo/.git", "/tmp/worktrees"],
          networkAccess: true
        }
      }
    });
    expect(connected.reconciliation.current.thread.id).toBe("thread-1");
    expect(manager.get("session-1")).toBe(connected);
  });

  it("attaches without resuming when the durable service still owns a background terminal", async () => {
    const proxy = new FakeProtocolProxy([], "thread-1", true);
    const manager = createManager([proxy]);

    const connected = await manager.reconnect({
      sessionId: "session-1",
      runtime,
      threadId: "thread-1",
      settings: { cwd: "/repo", runtimeWorkspaceRoots: ["/repo", "/repo/.git"] }
    });

    expect(proxy.methods).toEqual([
      "initialize",
      "thread/backgroundTerminals/list",
      "thread/read",
      "thread/turns/list",
      "thread/settings/update",
      "thread/read",
      "thread/turns/list"
    ]);
    expect(proxy.methods).not.toContain("thread/resume");
    expect(connected.threadId).toBe("thread-1");
  });

  it("returns journal-derived command ownership only during reconnect reconciliation", async () => {
    const ownership = [{
      threadId: "thread-1",
      turnId: "turn-active",
      itemId: "item-active",
      processId: "process-active"
    }];
    const manager = createManager([new FakeProtocolProxy(), new FakeProtocolProxy()], ownership);

    const reconnected = await manager.reconnect({ sessionId: "session-1", runtime, threadId: "thread-1" });
    const started = await manager.start({ sessionId: "session-2", runtime, settings: { cwd: "/repo" } });

    expect(reconnected.reconciliation.journalProcessOwnership).toEqual(ownership);
    expect(started.reconciliation.journalProcessOwnership).toEqual([]);
  });

  it("establishes new and forked threads through the same read barrier", async () => {
    const started = new FakeProtocolProxy([], "new-thread");
    const forked = new FakeProtocolProxy([], "forked-thread");
    const manager = createManager([started, forked]);

    const newConnection = await manager.start({
      sessionId: "new-session",
      runtime,
      settings: { cwd: "/repo", model: "gpt-5.6" }
    });
    const forkConnection = await manager.fork({
      sessionId: "fork-session",
      runtime,
      sourceThreadId: "source-thread",
      settings: { cwd: "/fork" }
    });

    expect(started.methods).toEqual(["initialize", "thread/start", "thread/settings/update", "thread/read", "thread/turns/list"]);
    expect(forked.methods).toEqual(["initialize", "thread/fork", "thread/settings/update", "thread/read", "thread/turns/list"]);
    expect(newConnection.threadId).toBe("new-thread");
    expect(forkConnection.threadId).toBe("forked-thread");
  });

  it("requires every persisted pending request to replay before accepting input", async () => {
    const request = {
      id: "approval-7",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1" }
    };
    const delivered: string[] = [];
    const first = new FakeProtocolProxy([request]);
    const second = new FakeProtocolProxy([request]);
    const manager = createManager([first, second]);

    await manager.reconnect({
      sessionId: "session-1",
      runtime,
      threadId: "thread-1",
      handlers: { serverRequest: ({ id }) => { delivered.push(String(id)); } }
    });
    const reconnected = await manager.reconnect({
      sessionId: "session-1",
      runtime,
      threadId: "thread-1",
      expectedPendingRequestIds: ["approval-7"],
      handlers: { serverRequest: ({ id }) => { delivered.push(String(id)); } }
    });

    expect(delivered).toEqual(["approval-7", "approval-7"]);
    expect(reconnected.reconciliation.replayedRequestIds).toEqual(["approval-7"]);
    expect(first.close).toHaveBeenCalledOnce();
  });

  it("fails closed when Codex stops replaying a known pending request", async () => {
    const proxy = new FakeProtocolProxy();
    const manager = createManager([proxy]);

    await expect(manager.reconnect({
      sessionId: "session-1",
      runtime,
      threadId: "thread-1",
      expectedPendingRequestIds: ["question-2"]
    })).rejects.toThrow("did not replay pending server requests");
    expect(proxy.close).toHaveBeenCalledOnce();
    expect(manager.get("session-1")).toBeNull();
  });

  it("rejects mismatched thread identity and serializes concurrent reconnects", async () => {
    const mismatched = new FakeProtocolProxy([], "other-thread");
    const first = new FakeProtocolProxy();
    const second = new FakeProtocolProxy();
    const manager = createManager([mismatched, first, second]);
    await expect(manager.reconnect({ sessionId: "bad", runtime, threadId: "thread-1" })).rejects.toThrow("unexpected thread");
    expect(mismatched.close).toHaveBeenCalledOnce();

    const one = manager.reconnect({ sessionId: "session-1", runtime, threadId: "thread-1" });
    const two = manager.reconnect({ sessionId: "session-1", runtime, threadId: "thread-1" });
    const [connectedOne, connectedTwo] = await Promise.all([one, two]);
    expect(first.close).toHaveBeenCalledOnce();
    expect(manager.get("session-1")).toBe(connectedTwo);
    expect(connectedOne.connectionId).not.toBe(connectedTwo.connectionId);
    await connectedOne.close();
    expect(manager.get("session-1")).toBe(connectedTwo);
    expect(second.close).not.toHaveBeenCalled();
  });
});

function createManager(
  proxies: FakeProtocolProxy[],
  journalProcessOwnership: Awaited<ReturnType<ProtocolJournal["listActiveCommandProcesses"]>> = []
): CodexAppServerConnectionManager {
  let connection = 0;
  const supervisor = {
    reconnect: vi.fn(async () => {
      const proxy = proxies.shift();
      if (!proxy) throw new Error("No proxy available");
      return proxy.connection;
    })
  } as unknown as RuntimeSupervisor;
  const entries: ProtocolJournalEntry[] = [];
  return new CodexAppServerConnectionManager(supervisor, () => ({
    append: async (entry) => { entries.push(entry); },
    listActiveCommandProcesses: async () => journalProcessOwnership
  }), "0.1.0", { connectionId: () => `connection-${++connection}` });
}

class FakeProtocolProxy {
  readonly input = new PassThrough();
  readonly output = new PassThrough();
  readonly close = vi.fn(async () => {
    this.input.destroy();
    this.output.destroy();
  });
  readonly connection: RuntimeProxyConnection = { input: this.input, output: this.output, close: this.close };
  readonly methods: string[] = [];
  readonly requests: Array<{ id: number; method: string; params?: unknown }> = [];
  private buffer = "";

  constructor(
    private readonly replayRequests: Array<{ id: string; method: string; params: unknown }> = [],
    private readonly responseThreadId = "thread-1",
    private readonly backgroundTerminal = false
  ) {
    this.input.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      let newline = this.buffer.indexOf("\n");
      while (newline >= 0) {
        const frame = JSON.parse(this.buffer.slice(0, newline)) as { id: number; method: string; params?: unknown };
        this.buffer = this.buffer.slice(newline + 1);
        this.methods.push(frame.method);
        this.requests.push(frame);
        if (frame.method === "initialize") {
          this.emit({ id: frame.id, result: {
            userAgent: "muxpilot/0.152.0",
            codexHome: "/tmp/codex-home",
            platformFamily: "unix",
            platformOs: "linux"
          } });
        } else if (frame.method === "thread/resume") {
          for (const request of this.replayRequests) this.emit(request);
          this.emit({ id: frame.id, result: { thread: { id: this.responseThreadId } } });
        } else if (frame.method === "thread/start" || frame.method === "thread/fork") {
          this.emit({ id: frame.id, result: { thread: { id: this.responseThreadId } } });
        } else if (frame.method === "thread/backgroundTerminals/list") {
          this.emit({ id: frame.id, result: { data: this.backgroundTerminal ? [{ processId: "process-1" }] : [] } });
        } else if (frame.method === "thread/settings/update") {
          this.emit({ id: frame.id, result: {} });
        } else if (frame.method === "thread/read") {
          this.emit({ id: frame.id, result: { thread: { id: this.responseThreadId, turns: [] } } });
        } else if (frame.method === "thread/turns/list") {
          this.emit({ id: frame.id, result: { data: [], nextCursor: null } });
        }
        newline = this.buffer.indexOf("\n");
      }
    });
  }

  private emit(frame: unknown): void {
    this.output.write(`${JSON.stringify(frame)}\n`);
  }
}
