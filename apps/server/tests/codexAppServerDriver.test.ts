import { describe, expect, it, vi } from "vitest";
import type { ManagedSession } from "@muxpilot/core";
import { CodexAppServerDriver } from "../src/services/sessionDrivers/codexAppServerDriver.js";
import type { AppServerSessionConnection, AppServerSessionHandlers } from "../src/services/sessionDrivers/codexAppServerConnectionManager.js";
import type { JsonRpcConnection } from "../src/services/sessionDrivers/jsonRpcConnection.js";
import type { RuntimeStartSpec, RuntimeSupervisor, SystemdSessionRuntimeRef } from "../src/services/sessionDrivers/types.js";

const runtime: SystemdSessionRuntimeRef = {
  kind: "systemd_service",
  unit: "muxpilot-session-0123456789abcdef01234567.service",
  socketPath: "/run/muxpilot/app.sock",
  state: "connected",
  codexVersion: "0.152.0"
};

describe("CodexAppServerDriver", () => {
  it("starts, resumes, and forks through durable runtime establishment", async () => {
    const harness = createHarness();
    const start = await harness.driver.start(launchSpec());
    const resume = await harness.driver.resume(launchSpec("source-thread"));
    const fork = await harness.driver.fork(launchSpec("source-thread"));

    expect(harness.supervisor.start).toHaveBeenCalledTimes(3);
    expect(harness.connections.start).toHaveBeenCalledOnce();
    expect(harness.connections.reconnect).toHaveBeenCalledOnce();
    expect(harness.connections.fork).toHaveBeenCalledOnce();
    expect([start, resume, fork].map((result) => result.provider.threadId)).toEqual(["thread-1", "thread-1", "thread-1"]);
    expect(start.capabilities).toMatchObject({ sendMessage: true, approvals: false, rawTerminalCapture: false });
  });

  it("sends verified structured turns only on the reconciled thread", async () => {
    const harness = createHarness();
    const session = managedSession();
    const receipt = await harness.driver.sendMessage(session, "hello", "client-1");

    expect(harness.rpc.request).toHaveBeenCalledWith("turn/start", expect.objectContaining({
      threadId: "thread-1",
      input: [{ type: "text", text: "hello" }],
      clientUserMessageId: "client-1",
      cwd: "/repo"
    }));
    expect(receipt).toEqual({
      clientMessageId: "client-1",
      threadId: "thread-1",
      turnId: "turn-1",
      acceptedAt: "2026-09-01T12:00:00.000Z"
    });
    harness.rpc.request.mockResolvedValueOnce({ turnId: "turn-1" });
    await expect(harness.driver.steer(session, "follow up", "turn-1", "client-2")).resolves.toMatchObject({
      clientMessageId: "client-2",
      turnId: "turn-1"
    });
    expect(harness.rpc.request).toHaveBeenCalledWith("turn/steer", {
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      input: [{ type: "text", text: "follow up" }],
      clientUserMessageId: "client-2"
    });

    harness.connection.threadId = "different-thread";
    await expect(harness.driver.sendMessage(session, "unsafe", "client-3")).rejects.toThrow("not reconciled");
  });

  it("fans out protocol events without allowing a subscriber to fail transport", async () => {
    const harness = createHarness();
    const observed: string[] = [];
    await harness.driver.start(launchSpec());
    await harness.driver.subscribe(managedSession(), () => { throw new Error("UI failed"); });
    const subscription = await harness.driver.subscribe(managedSession(), (event) => observed.push(event.method));
    expect(() => harness.handlers.notification?.({ method: "turn/started", params: { turn: { id: "turn-9" } } })).not.toThrow();
    harness.handlers.serverRequest?.({ id: "approval-1", method: "item/fileChange/requestApproval", params: {} });
    expect(observed).toEqual(["turn/started", "item/fileChange/requestApproval"]);
    await subscription.close();
  });

  it("interrupts active work, terminates background processes, and stops the service on kill", async () => {
    const harness = createHarness();
    const session = managedSession();
    await harness.driver.sendMessage(session, "work", "client-1");
    harness.rpc.request.mockImplementation(async (method: string) => {
      if (method === "thread/backgroundTerminals/list") return { data: [{ processId: "process-1" }] };
      return {};
    });

    await harness.driver.kill(session);

    expect(harness.rpc.request).toHaveBeenCalledWith("turn/interrupt", { threadId: "thread-1", turnId: "turn-1" });
    expect(harness.rpc.request).toHaveBeenCalledWith("thread/backgroundTerminals/terminate", {
      threadId: "thread-1",
      processId: "process-1"
    });
    expect(harness.connections.close).toHaveBeenCalledWith("session-1");
    expect(harness.supervisor.stop).toHaveBeenCalledWith(runtime);
  });
});

function createHarness(): {
  driver: CodexAppServerDriver;
  supervisor: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
  connections: Record<string, ReturnType<typeof vi.fn>>;
  connection: { threadId: string; rpc: JsonRpcConnection };
  rpc: { request: ReturnType<typeof vi.fn> };
  handlers: AppServerSessionHandlers;
} {
  const rpc = {
    request: vi.fn(async (method: string) => method === "turn/start" ? { turn: { id: "turn-1" } } : {})
  };
  const connection = {
    sessionId: "session-1",
    threadId: "thread-1",
    connectionId: "connection-1",
    rpc: rpc as unknown as JsonRpcConnection,
    reconciliation: {},
    close: vi.fn(async () => undefined)
  } as unknown as AppServerSessionConnection & { threadId: string };
  let handlers: AppServerSessionHandlers = {};
  const establish = async (spec: { handlers?: AppServerSessionHandlers }) => {
    handlers = spec.handlers ?? {};
    return connection;
  };
  const connections = {
    start: vi.fn(establish),
    reconnect: vi.fn(establish),
    fork: vi.fn(establish),
    get: vi.fn(() => connection),
    close: vi.fn(async () => undefined)
  };
  const supervisor = {
    start: vi.fn(async () => runtime),
    stop: vi.fn(async () => ({ ...runtime, state: "stopped" as const }))
  };
  const driver = new CodexAppServerDriver(
    supervisor as unknown as RuntimeSupervisor,
    connections as unknown as ConstructorParameters<typeof CodexAppServerDriver>[1],
    {
      runtimeSpec: (spec) => ({
        sessionId: spec.sessionId,
        capabilityId: "0123456789abcdef01234567",
        cwd: spec.cwd,
        codexHome: "/codex",
        codexVersion: "0.152.0",
        environment: {}
      } satisfies RuntimeStartSpec),
      now: () => new Date("2026-09-01T12:00:00.000Z")
    }
  );
  return { driver, supervisor, connections, connection, rpc, get handlers() { return handlers; } };
}

function launchSpec(sourceThreadId?: string) {
  return {
    sessionId: "session-1",
    name: "Session",
    cwd: "/repo",
    sourceThreadId,
    options: { model: "gpt-5.6", reasoningEffort: "high", writableRoots: ["/repo"] }
  };
}

function managedSession(): ManagedSession {
  return {
    id: "session-1",
    name: "Session",
    cwd: "/repo",
    provider: { kind: "codex", threadId: "thread-1", rolloutPath: null },
    driverKind: "codex_app_server",
    runtime,
    capabilities: {} as ManagedSession["capabilities"],
    tmux: {} as ManagedSession["tmux"],
    repo: { root: "/repo", name: "repo", branch: "main", dirty: false, worktree: null },
    codexSessionId: "thread-1",
    codexJsonlPath: null,
    discoveryConfidence: "high",
    status: "idle",
    lastActivityAt: null,
    preview: "",
    recentUserPrompts: [],
    activitySummary: null,
    activitySummaryGeneratedAt: null,
    activitySummarySourceSequence: null,
    inputMode: "default",
    models: {
      default: { model: "gpt-5.6", reasoningEffort: "high" },
      plan: { model: "gpt-5.6", reasoningEffort: "high" }
    },
    fastMode: true,
    transcriptSize: 0,
    unreadCount: 0,
    pinned: false,
    archived: false
  };
}
