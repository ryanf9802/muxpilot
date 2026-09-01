import { createConnection, createServer } from "node:net";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeHeavyCommandQueueEvent } from "@muxpilot/core";
import { HeavyCommandService, heavyCommandSessionStatus } from "../src/services/heavyCommands.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("HeavyCommandService", () => {
  it("projects queue, process, and handoff states into distinct session statuses", () => {
    expect(heavyCommandSessionStatus([])).toBeNull();
    expect(heavyCommandSessionStatus([{ state: "waiting" }])).toBe("queued");
    expect(heavyCommandSessionStatus([{ state: "reserved" }])).toBe("working");
    expect(heavyCommandSessionStatus([{ state: "reporting" }])).toBe("working");
    expect(heavyCommandSessionStatus([{ state: "running" }])).toBe("running");
    expect(heavyCommandSessionStatus([{ state: "stalled" }])).toBe("running");
    expect(heavyCommandSessionStatus([{ state: "terminating" }])).toBe("running");
    expect(heavyCommandSessionStatus([{ state: "waiting" }, { state: "reporting" }, { state: "running" }])).toBe("running");
  });

  it("ignores wrapper-owned acquiring records until they become queue eligible", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-heavy-service-"));
    roots.push(root);
    const leases = join(root, "leases");
    const sessions = join(root, "sessions");
    const runId = "mabc123-aaaaaaaaaaaa";
    await writeQueueOwner(leases, runId, new Date().toISOString());
    const ownerPath = join(leases, "runs", runId, "owner.json");
    const initial = JSON.parse(await readFile(ownerPath, "utf8"));
    await writeFile(ownerPath, JSON.stringify({ ...initial, state: "acquiring" }));
    const messages: string[] = [];
    const service = new HeavyCommandService(leases, sessions, 1, 120_000);
    await service.start({
      sessionIdForWorkspace: async () => "session-a",
      resumeHeavyCommand: async (_sessionId, message) => { messages.push(message); return true; }
    });
    try {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 350));
      expect(messages).toHaveLength(0);
      expect((await service.list("workspace-a")).commands).toHaveLength(0);
      await expect(stat(join(leases, "slot-0"))).rejects.toThrow();

      await writeFile(ownerPath, JSON.stringify({ ...initial, state: "waiting", heartbeatAt: new Date().toISOString() }));
      await waitFor(async () => messages.length === 1);
      expect(JSON.parse(await readFile(ownerPath, "utf8"))).toMatchObject({ state: "reserved", slot: 0 });
    } finally {
      await service.stop();
    }
  });

  it("isolates active metadata and bounded output by workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-heavy-service-"));
    roots.push(root);
    const leases = join(root, "leases");
    const sessions = join(root, "sessions");
    const runId = "mabc123-012345abcdef";
    const runDir = join(leases, "runs", runId);
    const logDir = join(sessions, "workspace-a", "heavy-commands");
    const logPath = join(logDir, "run.log");
    await mkdir(runDir, { recursive: true });
    await mkdir(logDir, { recursive: true });
    await writeFile(logPath, "visible output");
    await writeFile(join(runDir, "owner.json"), JSON.stringify(owner(runId, "workspace-a", logPath)));
    const service = new HeavyCommandService(leases, sessions);

    expect((await service.list("workspace-a")).commands).toHaveLength(1);
    expect(await service.hasActive("workspace-a")).toBe(true);
    expect(await service.sessionStatusForWorkspace("workspace-a")).toBe("running");
    expect((await service.list("workspace-b")).commands).toHaveLength(0);
    expect(await service.hasActive("workspace-b")).toBe(false);
    expect(await service.sessionStatusForWorkspace("workspace-b")).toBeNull();
    expect((await service.output("workspace-a", runId))?.output).toBe("visible output");
    expect(await service.output("workspace-b", runId)).toBeNull();

    await writeFile(join(runDir, "owner.json"), JSON.stringify({
      ...owner(runId, "workspace-a", logPath), version: 3, state: "waiting", startedAt: null,
      lastOutputAt: null, lastActivityAt: null,
      activity: { processCount: 0, cpuTicks: 0, ioBytes: 0, runningContainers: 0, createdContainers: 0 }
    }));
    expect((await service.list("workspace-a")).commands[0]).toMatchObject({ state: "waiting", lastActivityAt: null });
    expect(await service.hasActive("workspace-a")).toBe(true);
    expect(await service.sessionStatusForWorkspace("workspace-a")).toBe("queued");
  });

  it("rejects malformed owners and sends termination over the private control socket", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-heavy-service-"));
    roots.push(root);
    const leases = join(root, "leases");
    const sessions = join(root, "sessions");
    const runId = "mabc123-fedcba543210";
    const runDir = join(leases, "runs", runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "owner.json"), "not json");
    const service = new HeavyCommandService(leases, sessions);
    expect((await service.list("workspace-a")).commands).toHaveLength(0);

    await writeFile(join(runDir, "owner.json"), JSON.stringify(owner(runId, "workspace-a", null)));
    const socketPath = join(runDir, "control.sock");
    const server = createServer((socket) => socket.once("data", () => socket.end(`${JSON.stringify({ ok: true, accepted: true })}\n`)));
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    await chmod(socketPath, 0o600);
    expect(await service.terminate("workspace-a", runId)).toBe("accepted");
    server.close();
  });

  it("reserves deferred commands in FIFO order and dispatches an exact resume", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-heavy-service-"));
    roots.push(root);
    const leases = join(root, "leases");
    const sessions = join(root, "sessions");
    const first = "mabc123-111111111111";
    const second = "mabc123-222222222222";
    await writeQueueOwner(leases, first, "2026-01-01T00:00:00.000Z");
    await writeQueueOwner(leases, second, "2026-01-01T00:00:01.000Z");
    await mkdir(join(leases, "slot-0"));
    await writeFile(join(leases, "slot-0", "owner.json"), JSON.stringify({ version: 2, runId: "orphan", controlSocket: join(leases, "missing.sock"), heartbeatAt: Date.now() }));
    const messages: string[] = [];
    const service = new HeavyCommandService(leases, sessions, 1, 120_000);
    await service.start({
      sessionIdForWorkspace: async () => "session-a",
      resumeHeavyCommand: async (_sessionId, message) => { messages.push(message); return true; }
    });
    try {
      await waitFor(async () => messages.length === 1);
      const firstOwner = JSON.parse(await readFile(join(leases, "runs", first, "owner.json"), "utf8"));
      const secondOwner = JSON.parse(await readFile(join(leases, "runs", second, "owner.json"), "utf8"));
      expect(firstOwner).toMatchObject({ state: "reserved", slot: 0 });
      expect(secondOwner).toMatchObject({ state: "waiting", slot: null });
      expect((await service.list("workspace-a")).commands.find((command) => command.runId === second)?.queuePosition).toBe(1);
      expect(normalizeHeavyCommandQueueEvent(messages[0] ?? "")).toMatchObject({
        legacy: false,
        event: {
          kind: "resume_requested",
          runId: first,
          commandDisplay: "make lint",
          slot: 0,
          resumeCommand: expect.stringContaining(`--resume' '${first}`)
        }
      });
      expect(await service.terminate("workspace-a", first)).toBe("accepted");
      await expect(stat(join(leases, "slot-0"))).rejects.toThrow();
    } finally {
      await service.stop();
    }
  });

  it("cancels a reservation when the delivered resume is not claimed in time", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-heavy-service-"));
    roots.push(root);
    const leases = join(root, "leases");
    const runId = "mabc123-333333333333";
    await writeQueueOwner(leases, runId, new Date().toISOString());
    const service = new HeavyCommandService(leases, join(root, "sessions"), 1, 40);
    await service.start({ sessionIdForWorkspace: async () => "session-a", resumeHeavyCommand: async () => true });
    try {
      await waitFor(async () => {
        const current = JSON.parse(await readFile(join(leases, "runs", runId, "owner.json"), "utf8"));
        return current.state === "cancelled";
      });
      const current = JSON.parse(await readFile(join(leases, "runs", runId, "owner.json"), "utf8"));
      expect(current.terminationReason).toContain("resume reservation expired");
      await expect(stat(join(leases, "slot-0"))).rejects.toThrow();
    } finally {
      await service.stop();
    }
  });

  it("delivers compact success and bounded failure completion events", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-heavy-service-"));
    roots.push(root);
    const leases = join(root, "leases");
    const sessions = join(root, "sessions");
    const messages: string[] = [];
    const passed = "mabc123-444444444444";
    const failed = "mabc123-555555555555";
    await writeReportingOwner(leases, sessions, passed, 0, "successful but noisy output");
    await writeReportingOwner(leases, sessions, failed, 1, `${"old failure context\n".repeat(4_000)}final assertion failed\n`);
    const service = new HeavyCommandService(leases, sessions, 2, 120_000);
    await service.start({
      sessionIdForWorkspace: async () => "session-a",
      resumeHeavyCommand: async (_sessionId, message) => { messages.push(message); return true; }
    });
    try {
      await waitFor(async () => messages.length === 2);
      const events = messages.map((message) => normalizeHeavyCommandQueueEvent(message)?.event);
      expect(events.find((event) => event?.runId === passed)).toMatchObject({
        kind: "run_completed",
        outcome: "passed",
        exitCode: 0,
        logPath: expect.stringContaining("passed.log")
      });
      expect(events.find((event) => event?.runId === passed)?.outputTail).toBeUndefined();
      expect(events.find((event) => event?.runId === failed)).toMatchObject({
        kind: "run_completed",
        outcome: "failed",
        exitCode: 1,
        outputTruncated: true,
        outputTail: expect.stringContaining("final assertion failed")
      });
      expect(Buffer.byteLength(events.find((event) => event?.runId === failed)?.outputTail ?? "")).toBeLessThanOrEqual(32 * 1024);
      expect(JSON.parse(await readFile(join(leases, "runs", passed, "owner.json"), "utf8"))).toMatchObject({ state: "completed", completionSentAt: expect.any(String) });
      expect(JSON.parse(await readFile(join(leases, "runs", failed, "owner.json"), "utf8"))).toMatchObject({ state: "completed", completionSentAt: expect.any(String) });
    } finally {
      await service.stop();
    }
  });

  it("counts only process-owning states as resource-busy", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-heavy-service-"));
    roots.push(root);
    const leases = join(root, "leases");
    const sessions = join(root, "sessions");
    const runId = "mabc123-666666666666";
    const runDir = join(leases, "runs", runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "owner.json"), JSON.stringify({
      ...owner(runId, "workspace-a", null),
      version: 4,
      runnerPath: "/skills/muxpilot-git-run.mjs",
      runnerOptions: [],
      resourceUnit: "muxpilot-heavy-mabc123-666666666666-a1b2c3.service",
      lastActivityAt: new Date().toISOString(),
      activity: { processCount: 1, cpuTicks: 1, ioBytes: 0, runningContainers: 0, createdContainers: 0 }
    }));
    const service = new HeavyCommandService(leases, sessions);
    expect(await service.hasRunning("workspace-a")).toBe(true);
    expect(await service.runningWorkspaceIds()).toEqual(new Set(["workspace-a"]));
    expect(await service.runningResourceUnits()).toEqual([{
      workspaceId: "workspace-a",
      unit: "muxpilot-heavy-mabc123-666666666666-a1b2c3.service"
    }]);
    const runningOwner = JSON.parse(await readFile(join(runDir, "owner.json"), "utf8"));
    await writeFile(join(runDir, "owner.json"), JSON.stringify({ ...runningOwner, heartbeatAt: "2026-01-01T00:00:00.000Z" }));
    expect(await service.runningWorkspaceIds()).toEqual(new Set());
    expect(await service.runningResourceUnits()).toEqual([]);
    await writeFile(join(runDir, "owner.json"), JSON.stringify({
      ...owner(runId, "workspace-a", null),
      state: "reporting",
      slot: null,
      exitCode: 0,
      signal: null,
      finishedAt: new Date().toISOString()
    }));
    expect(await service.hasActive("workspace-a")).toBe(true);
    expect(await service.hasRunning("workspace-a")).toBe(false);
    expect(await service.runningWorkspaceIds()).toEqual(new Set());
  });

  it("corroborates a stale active owner through its private control socket", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-heavy-service-"));
    roots.push(root);
    const leases = join(root, "leases");
    const runId = "mabc123-676767676767";
    const runDir = join(leases, "runs", runId);
    const controlSocket = join(runDir, "control.sock");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "owner.json"), JSON.stringify({
      ...owner(runId, "workspace-a", null),
      version: 4,
      runnerPath: "/skills/muxpilot-git-run.mjs",
      runnerOptions: [],
      resourceUnit: "muxpilot-heavy-mabc123-676767676767-a1b2c3.service",
      controlSocket,
      heartbeatAt: "2026-01-01T00:00:00.000Z",
      lastActivityAt: "2026-01-01T00:00:00.000Z",
      activity: { processCount: 1, cpuTicks: 1, ioBytes: 0, runningContainers: 0, createdContainers: 0 }
    }));
    let reportedRunId = runId;
    let reportedState = "running";
    const server = createServer((socket) => socket.once("data", () => socket.end(`${JSON.stringify({
      ok: true,
      runId: reportedRunId,
      state: reportedState
    })}\n`)));
    await new Promise<void>((resolve) => server.listen(controlSocket, resolve));
    await chmod(controlSocket, 0o600);
    const service = new HeavyCommandService(leases, join(root, "sessions"));
    try {
      expect(await service.sessionStatusForWorkspace("workspace-a")).toBe("running");
      expect(await service.runningWorkspaceIds()).toEqual(new Set(["workspace-a"]));
      expect(await service.runningResourceUnits()).toEqual([{
        workspaceId: "workspace-a",
        unit: "muxpilot-heavy-mabc123-676767676767-a1b2c3.service"
      }]);
      reportedState = "reporting";
      expect(await service.sessionStatusForWorkspace("workspace-a")).toBe("working");
      expect(await service.runningWorkspaceIds()).toEqual(new Set());
      reportedState = "running";
      reportedRunId = "mabc123-000000000000";
      expect(await service.sessionStatusForWorkspace("workspace-a")).toBeNull();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(await service.sessionStatusForWorkspace("workspace-a")).toBeNull();
    expect(await service.runningWorkspaceIds()).toEqual(new Set());
  });

  it("durably suppresses completion before cancelling a running worker", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-heavy-service-"));
    roots.push(root);
    const leases = join(root, "leases");
    const runId = "mabc123-777777777777";
    const runDir = join(leases, "runs", runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "owner.json"), JSON.stringify({
      ...owner(runId, "workspace-a", null),
      version: 4,
      runnerPath: "/skills/muxpilot-git-run.mjs",
      runnerOptions: [],
      lastActivityAt: new Date().toISOString(),
      activity: { processCount: 1, cpuTicks: 1, ioBytes: 0, runningContainers: 0, createdContainers: 0 }
    }));
    const requests: Array<{ action: string; reason: string }> = [];
    const server = createServer((socket) => socket.once("data", (chunk) => {
      requests.push(JSON.parse(chunk.toString().trim()));
      socket.end(`${JSON.stringify({ ok: true, accepted: true })}\n`);
    }));
    await new Promise<void>((resolve) => server.listen(join(runDir, "control.sock"), resolve));
    await chmod(join(runDir, "control.sock"), 0o600);
    try {
      const service = new HeavyCommandService(leases, join(root, "sessions"));
      await service.cancelWorkspace("workspace-a", "session interrupted");
      expect(await readFile(join(runDir, "completion-suppressed"), "utf8")).toBe("session interrupted");
      expect(requests).toEqual([{ action: "cancel", reason: "session interrupted" }]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("does not deliver a reporting completion after workspace cancellation", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-heavy-service-"));
    roots.push(root);
    const leases = join(root, "leases");
    const sessions = join(root, "sessions");
    const runId = "mabc123-888888888888";
    await writeReportingOwner(leases, sessions, runId, 0, "finished output");
    const service = new HeavyCommandService(leases, sessions);
    await service.cancelWorkspace("workspace-a", "session interrupted");
    const messages: string[] = [];
    await service.start({
      sessionIdForWorkspace: async () => "session-a",
      resumeHeavyCommand: async (_sessionId, message) => { messages.push(message); return true; }
    });
    try {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 350));
      expect(messages).toEqual([]);
      expect(JSON.parse(await readFile(join(leases, "runs", runId, "owner.json"), "utf8"))).toMatchObject({
        state: "cancelled",
        terminationReason: "session interrupted"
      });
    } finally {
      await service.stop();
    }
  });

  it("brokers validated transient worker launch and stop requests", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-heavy-service-"));
    roots.push(root);
    const leases = join(root, "leases");
    const runId = "mabc123-999999999999";
    const runDir = join(leases, "runs", runId);
    const bootstrapSocket = join(runDir, "bootstrap-123-a1b2c3.sock");
    await mkdir(runDir, { recursive: true });
    const bootstrapServer = createServer();
    await new Promise<void>((resolve) => bootstrapServer.listen(bootstrapSocket, resolve));
    const commands: Array<{ command: string; args: string[] }> = [];
    const service = new HeavyCommandService(leases, join(root, "sessions"), 2, 120_000, {
      enabled: true,
      environment: {},
      token: "broker-test-token",
      runnerPath: "/installed/muxpilot-git-run.mjs",
      logger: { warn: () => undefined },
      runCommand: async (command, args) => { commands.push({ command, args }); }
    });
    await service.start({ sessionIdForWorkspace: async () => null, resumeHeavyCommand: async () => false });
    const brokerSocket = service.brokerSocketPath()!;
    try {
      expect((await stat(brokerSocket)).mode & 0o777).toBe(0o600);
      expect((await stat(join(leases, "broker-token"))).mode & 0o777).toBe(0o600);
      expect(await readFile(join(leases, "broker-token"), "utf8")).toBe("broker-test-token");
      expect(await brokerRequest(brokerSocket, {
        action: "launch",
        token: "broker-test-token",
        runId,
        resourceUnit: `muxpilot-heavy-${runId}-a1b2c3.service`,
        bootstrapSocket
      })).toEqual({ ok: true });
      expect(commands[0]).toMatchObject({
        command: "systemd-run",
        args: expect.arrayContaining([
          `--unit=muxpilot-heavy-${runId}-a1b2c3.service`,
          "/installed/muxpilot-git-run.mjs",
          "--muxpilot-heavy-worker-bootstrap",
          bootstrapSocket
        ])
      });
      expect(await brokerRequest(brokerSocket, {
        action: "launch",
        token: "broker-test-token",
        runId,
        resourceUnit: `muxpilot-heavy-${runId}-a1b2c3.service`,
        bootstrapSocket: join(root, "outside.sock")
      })).toMatchObject({ ok: false, error: expect.stringContaining("outside") });
      expect(await brokerRequest(brokerSocket, {
        action: "stop",
        token: "broker-test-token",
        resourceUnit: `muxpilot-heavy-${runId}-a1b2c3.service`
      })).toEqual({ ok: true });
      expect(commands.at(-1)).toEqual({
        command: "systemctl",
        args: ["--user", "stop", `muxpilot-heavy-${runId}-a1b2c3.service`]
      });
      expect(await brokerRequest(brokerSocket, {
        action: "stop",
        token: "wrong-token",
        resourceUnit: `muxpilot-heavy-${runId}-a1b2c3.service`
      })).toMatchObject({ ok: false, error: "unauthorized heavyweight launch request" });
    } finally {
      await service.stop();
      await new Promise<void>((resolve) => bootstrapServer.close(() => resolve()));
    }
  });
});

async function writeReportingOwner(
  leases: string,
  sessions: string,
  runId: string,
  exitCode: number,
  output: string
): Promise<void> {
  const runDir = join(leases, "runs", runId);
  const logDir = join(sessions, "workspace-a", "heavy-commands");
  const logPath = join(logDir, `${exitCode === 0 ? "passed" : "failed"}.log`);
  await mkdir(runDir, { recursive: true });
  await mkdir(logDir, { recursive: true });
  await writeFile(logPath, output);
  const now = new Date().toISOString();
  await writeFile(join(runDir, "owner.json"), JSON.stringify({
    ...owner(runId, "workspace-a", logPath),
    version: 4,
    state: "reporting",
    runnerPath: "/skills/muxpilot-git-run.mjs",
    runnerOptions: [],
    slot: null,
    exitCode,
    signal: null,
    finishedAt: now,
    completionSentAt: null,
    lastActivityAt: now,
    activity: { processCount: 0, cpuTicks: 0, ioBytes: 0, runningContainers: 0, createdContainers: 0 }
  }));
}

async function writeQueueOwner(leases: string, runId: string, queuedAt: string): Promise<void> {
  const runDir = join(leases, "runs", runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "owner.json"), JSON.stringify({
    ...owner(runId, "workspace-a", null),
    version: 4,
    state: "waiting",
    runnerPath: "/skills/muxpilot-git-run.mjs",
    runnerOptions: [],
    slot: null,
    childPid: null,
    queuedAt,
    startedAt: null,
    lastOutputAt: null,
    lastActivityAt: null,
    activity: { processCount: 0, cpuTicks: 0, ioBytes: 0, runningContainers: 0, createdContainers: 0 },
    resumeSentAt: null,
    resumeDeadlineAt: null
  }));
}

async function waitFor(predicate: () => Promise<boolean> | boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error("condition was not met");
}

function brokerRequest(path: string, request: object): Promise<Record<string, unknown>> {
  return new Promise((resolveResponse, rejectResponse) => {
    const socket = createConnection(path);
    let input = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      input += chunk;
      if (!input.includes("\n")) return;
      socket.end();
      resolveResponse(JSON.parse(input.trim()));
    });
    socket.once("error", rejectResponse);
  });
}

function owner(runId: string, workspaceId: string, logPath: string | null) {
  const now = new Date().toISOString();
  return {
    version: 2,
    runId,
    workspaceId,
    state: "running",
    command: ["make", "lint"],
    commandDisplay: "make lint",
    cwd: "/workspace",
    childPid: 2,
    slot: 0,
    queuedAt: now,
    startedAt: now,
    lastOutputAt: now,
    heartbeatAt: now,
    logPath,
    deadlines: { inactivityWarnMs: 60_000, inactivityTimeoutMs: 600_000, runtimeTimeoutMs: 1_800_000, terminationGraceMs: 30_000 },
    packageDiagnostics: null,
    terminationReason: null
  };
}
