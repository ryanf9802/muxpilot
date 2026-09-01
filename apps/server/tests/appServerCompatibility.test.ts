import { describe, expect, it, vi } from "vitest";
import { probeAppServerCompatibility, type AppServerProbeExecutor } from "../src/services/appServerCompatibility.js";

const requiredSchema = JSON.stringify([
  "initialize", "thread/start", "thread/resume", "thread/fork", "thread/read",
  "turn/start", "turn/steer", "turn/interrupt", "item/completed", "serverRequest/resolved"
]);

function executor(overrides: Partial<AppServerProbeExecutor> = {}): AppServerProbeExecutor {
  return {
    codexVersion: vi.fn(async () => "codex-cli 0.152.0"),
    appServerHelp: vi.fn(async () => "--listen <URL> unix://PATH"),
    proxyHelp: vi.fn(async () => "--sock <SOCKET_PATH>"),
    protocolSchema: vi.fn(async () => requiredSchema),
    ...overrides
  };
}

describe("app-server compatibility probe", () => {
  it("reports an available installed protocol", async () => {
    await expect(probeAppServerCompatibility(true, executor(), () => new Date("2026-09-01T12:00:00Z"))).resolves.toEqual({
      status: "available",
      available: true,
      codexVersion: "0.152.0",
      detail: "Codex app-server, Unix socket proxying, and the required protocol methods are available.",
      checkedAt: "2026-09-01T12:00:00.000Z",
      missingCapabilities: []
    });
  });

  it("does not invoke Codex when user-systemd is unavailable", async () => {
    const probe = executor();
    const result = await probeAppServerCompatibility(false, probe);
    expect(result.status).toBe("user_systemd_unavailable");
    expect(result.missingCapabilities).toEqual(["user-systemd"]);
    expect(probe.codexVersion).not.toHaveBeenCalled();
  });

  it("reports missing protocol and transport capabilities", async () => {
    const result = await probeAppServerCompatibility(true, executor({
      appServerHelp: vi.fn(async () => "app-server"),
      proxyHelp: vi.fn(async () => "proxy"),
      protocolSchema: vi.fn(async () => JSON.stringify(["initialize", "thread/start"]))
    }));
    expect(result.status).toBe("incompatible_codex_protocol");
    expect(result.missingCapabilities).toEqual(expect.arrayContaining(["thread/resume", "turn/start", "unix-listen", "unix-proxy"]));
  });

  it("fails closed when schema generation cannot complete", async () => {
    const result = await probeAppServerCompatibility(true, executor({
      protocolSchema: vi.fn(async () => { throw new Error("schema command failed\nsecret detail"); })
    }));
    expect(result).toMatchObject({
      status: "failed_health_probe",
      available: false,
      codexVersion: "0.152.0",
      detail: "Codex app-server health probe failed: schema command failed"
    });
  });
});
