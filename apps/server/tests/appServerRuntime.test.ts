import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppServerCompatibility } from "@muxpilot/core";
import { CodexAppServerConnectionManager } from "../src/services/sessionDrivers/codexAppServerConnectionManager.js";
import {
  appServerCapabilityId,
  createSessionDriverRegistry
} from "../src/services/sessionDrivers/appServerRuntime.js";
import { SystemdAppServerSupervisor } from "../src/services/sessionDrivers/systemdAppServerSupervisor.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("app-server runtime composition", () => {
  it("registers no driver when compatibility is unavailable", () => {
    const { runtimeDir: _runtimeDir, ...unavailableOptions } = options({
      status: "user_systemd_unavailable",
      available: false,
      codexVersion: null,
      detail: "unavailable",
      checkedAt: "2026-09-01T12:00:00.000Z",
      missingCapabilities: ["user-systemd"]
    });
    const registry = createSessionDriverRegistry(unavailableOptions);
    expect(registry.has("codex_app_server")).toBe(false);
  });

  it("requires the user runtime directory when app-server is available", () => {
    const { runtimeDir: _runtimeDir, ...availableOptions } = options(availableCompatibility());

    expect(() => createSessionDriverRegistry(availableOptions)).toThrow("requires XDG_RUNTIME_DIR");
  });

  it("registers the compatible driver without starting a service or creating runtime files", () => {
    const dataDir = join(tmpdir(), `muxpilot-app-runtime-${randomUUID()}`);
    const registry = createSessionDriverRegistry({
      ...options(availableCompatibility()),
      dataDir,
      runtimeDir: join(tmpdir(), "muxpilot-runtime")
    });
    expect(registry.has("codex_app_server")).toBe(true);
    expect(registry.require("codex_app_server").capabilities).toMatchObject({
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
      codexVersion: "0.152.0"
    };
    vi.spyOn(SystemdAppServerSupervisor.prototype, "start")
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
    const registry = createSessionDriverRegistry({
      ...options(availableCompatibility()),
      runtimeDir: join(tmpdir(), "muxpilot-runtime"),
      sessionEnvironment: { resolveForLaunch, markApplied }
    });
    const driver = registry.require("codex_app_server");
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
  });

  it("derives a stable private runtime identity from the muxpilot session id", () => {
    expect(appServerCapabilityId("session-1")).toMatch(/^[a-f0-9]{24}$/);
    expect(appServerCapabilityId("session-1")).toBe(appServerCapabilityId("session-1"));
    expect(appServerCapabilityId("session-1")).not.toBe(appServerCapabilityId("session-2"));
    expect(appServerCapabilityId("session-1", "shadow")).not.toBe(appServerCapabilityId("session-1"));
    expect(() => appServerCapabilityId(" ")).toThrow("must not be empty");
    expect(() => appServerCapabilityId("session-1", " ")).toThrow("namespace must not be empty");
  });
});

function options(compatibility: AppServerCompatibility) {
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

function availableCompatibility(): AppServerCompatibility {
  return {
    status: "available",
    available: true,
    codexVersion: "0.152.0",
    detail: "available",
    checkedAt: "2026-09-01T12:00:00.000Z",
    missingCapabilities: []
  };
}
