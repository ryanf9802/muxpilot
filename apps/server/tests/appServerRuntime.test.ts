import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AppServerCompatibility } from "@muxpilot/core";
import {
  appServerCapabilityId,
  createSessionDriverRegistry
} from "../src/services/sessionDrivers/appServerRuntime.js";

describe("app-server runtime composition", () => {
  it("registers no driver when compatibility is unavailable", () => {
    const registry = createSessionDriverRegistry(options({
      status: "user_systemd_unavailable",
      available: false,
      codexVersion: null,
      detail: "unavailable",
      checkedAt: "2026-09-01T12:00:00.000Z",
      missingCapabilities: ["user-systemd"]
    }));
    expect(registry.has("codex_app_server")).toBe(false);
  });

  it("registers the compatible driver without starting a service or creating runtime files", () => {
    const dataDir = join(tmpdir(), `muxpilot-app-runtime-${randomUUID()}`);
    const registry = createSessionDriverRegistry({
      ...options(availableCompatibility()),
      dataDir
    });
    expect(registry.has("codex_app_server")).toBe(true);
    expect(registry.require("codex_app_server").capabilities).toMatchObject({
      start: true,
      verifiedInput: true,
      terminalAttach: true
    });
    expect(existsSync(dataDir)).toBe(false);
  });

  it("derives a stable private runtime identity from the muxpilot session id", () => {
    expect(appServerCapabilityId("session-1")).toMatch(/^[a-f0-9]{24}$/);
    expect(appServerCapabilityId("session-1")).toBe(appServerCapabilityId("session-1"));
    expect(appServerCapabilityId("session-1")).not.toBe(appServerCapabilityId("session-2"));
    expect(() => appServerCapabilityId(" ")).toThrow("must not be empty");
  });
});

function options(compatibility: AppServerCompatibility) {
  return {
    compatibility,
    dataDir: "/tmp/muxpilot-app-server-runtime-test",
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
