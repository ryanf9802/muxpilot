import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderCompatibility } from "@muxpilot/core";
import { CodexAppServerConnectionManager } from "../src/providers/codex/connectionManager.js";
import { codexRuntimeCommand, createCodexProvider } from "../src/providers/codex/provider.js";
import { sessionRuntimeCapabilityId } from "../src/runtime/capabilityId.js";
import { SystemdSessionSupervisor } from "../src/runtime/systemdSessionSupervisor.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Codex provider composition", () => {
  it("has no driver when compatibility is unavailable", () => {
    const { runtimeDir: _runtimeDir, ...unavailableOptions } = options({
      provider: "codex",
      status: "user_systemd_unavailable",
      available: false,
      version: null,
      detail: "unavailable",
      checkedAt: "2026-09-01T12:00:00.000Z",
      missingCapabilities: ["user-systemd"]
    });
    const provider = createCodexProvider(unavailableOptions);
    expect(provider.driver).toBeNull();
    expect(provider.compatibility()).toMatchObject({ provider: "codex", available: false });
  });

  it("requires the user runtime directory when app-server is available", () => {
    const { runtimeDir: _runtimeDir, ...availableOptions } = options(availableCompatibility());

    expect(() => createCodexProvider(availableOptions)).toThrow("requires XDG_RUNTIME_DIR");
  });

  it("registers the compatible driver without starting a service or creating runtime files", () => {
    const dataDir = join(tmpdir(), `muxpilot-app-runtime-${randomUUID()}`);
    const provider = createCodexProvider({
      ...options(availableCompatibility()),
      dataDir,
      runtimeDir: join(tmpdir(), "muxpilot-runtime")
    });
    expect(provider.kind).toBe("codex");
    expect(provider.driver?.kind).toBe("codex");
    expect(provider.driver?.capabilities).toMatchObject({
      start: true,
      verifiedInput: true,
      terminalAttach: true
    });
    expect(existsSync(dataDir)).toBe(false);
  });

  it("keeps an environment revision pending for reuse and applies it after a fresh launch", async () => {
    const runtime = {
      kind: "systemd_service" as const,
      unit: "muxpilot-session-0123456789abcdef01234567.service",
      socketPath: "/run/muxpilot/app.sock",
      state: "connected" as const,
      agentVersion: "0.152.0"
    };
    const start = vi.spyOn(SystemdSessionSupervisor.prototype, "start")
      .mockResolvedValueOnce({ ...runtime, launchDisposition: "reused" })
      .mockResolvedValueOnce({ ...runtime, launchDisposition: "started" });
    vi.spyOn(CodexAppServerConnectionManager.prototype, "start").mockResolvedValue({
      sessionId: "session-1",
      threadId: "thread-1",
      connectionId: "connection-1",
      rpc: {} as never,
      reconciliation: {
        initialize: {} as never,
        established: { thread: { id: "thread-1" } },
        current: { thread: { id: "thread-1" } },
        replayedRequestIds: [],
        journalProcessOwnership: []
      },
      close: vi.fn(async () => undefined)
    });
    const resolveForLaunch = vi.fn()
      .mockResolvedValueOnce({ environment: { TOKEN: "pending" }, revision: 7 })
      .mockResolvedValueOnce({ environment: { TOKEN: "pending" }, revision: 8 });
    const markApplied = vi.fn(async () => undefined);
    const provider = createCodexProvider({
      ...options(availableCompatibility()),
      runtimeDir: join(tmpdir(), "muxpilot-runtime"),
      sessionEnvironment: { resolveForLaunch, markApplied }
    });
    const driver = provider.driver!;
    const spec = {
      sessionId: "session-1",
      name: "Session 1",
      cwd: "/repo",
      options: {}
    };

    await expect(driver.start(spec)).resolves.toMatchObject({ launchDisposition: "reused" });
    expect(markApplied).not.toHaveBeenCalled();

    await expect(driver.start(spec)).resolves.toMatchObject({ launchDisposition: "started" });
    expect(markApplied).toHaveBeenCalledOnce();
    expect(markApplied).toHaveBeenCalledWith("session-1", 8);
    const startSpec = start.mock.calls[0]![0];
    expect(startSpec.environment).toMatchObject({ TOKEN: "pending", CODEX_HOME: "/tmp/codex-home" });
    expect(startSpec.agentVersion).toBe("0.152.0");
    expect(startSpec.command({ socketPath: "/run/app.sock", directory: "/data/x" })).toEqual(codexRuntimeCommand("/run/app.sock", []));
  });

  it("launches the same Codex app-server argv as before provider extraction", () => {
    expect(codexRuntimeCommand("/run/user/1000/muxpilot/app-server-sessions/abc/app-server.sock", [
      { name: "muxpilot_sessions", command: "/usr/bin/node", args: ["/mcp.mjs", "cap"], defaultToolsApprovalMode: "approve" }
    ])).toEqual([
      "codex",
      "-c", "check_for_update_on_startup=false",
      "-c", "sandbox_workspace_write.network_access=true",
      "-c", "mcp_servers.muxpilot_sessions.command=\"/usr/bin/node\"",
      "-c", "mcp_servers.muxpilot_sessions.args=[\"/mcp.mjs\",\"cap\"]",
      "-c", "mcp_servers.muxpilot_sessions.default_tools_approval_mode=\"approve\"",
      "app-server",
      "--listen",
      "unix:///run/user/1000/muxpilot/app-server-sessions/abc/app-server.sock"
    ]);
  });

  it("derives a stable private runtime identity from the muxpilot session id", () => {
    expect(sessionRuntimeCapabilityId("session-1")).toMatch(/^[a-f0-9]{24}$/);
    expect(sessionRuntimeCapabilityId("session-1")).toBe(sessionRuntimeCapabilityId("session-1"));
    expect(sessionRuntimeCapabilityId("session-1")).not.toBe(sessionRuntimeCapabilityId("session-2"));
    expect(sessionRuntimeCapabilityId("session-1", "shadow")).not.toBe(sessionRuntimeCapabilityId("session-1"));
    expect(() => sessionRuntimeCapabilityId(" ")).toThrow("must not be empty");
    expect(() => sessionRuntimeCapabilityId("session-1", " ")).toThrow("namespace must not be empty");
  });
});

function options(compatibility: ProviderCompatibility) {
  return {
    compatibility,
    dataDir: "/tmp/muxpilot-app-server-runtime-test",
    runtimeDir: "/run/user/1000",
    codexHome: "/tmp/codex-home",
    environment: {},
    db: {} as never,
    events: {} as never
  };
}

function availableCompatibility(): ProviderCompatibility {
  return {
    provider: "codex",
    status: "available",
    available: true,
    version: "0.152.0",
    detail: "available",
    checkedAt: "2026-09-01T12:00:00.000Z",
    missingCapabilities: []
  };
}
