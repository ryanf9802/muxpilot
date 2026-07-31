import { createServer } from "node:net";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HeavyCommandService } from "../src/services/heavyCommands.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("HeavyCommandService", () => {
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
    expect((await service.list("workspace-b")).commands).toHaveLength(0);
    expect((await service.output("workspace-a", runId))?.output).toBe("visible output");
    expect(await service.output("workspace-b", runId)).toBeNull();
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
});

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
