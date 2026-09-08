import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  hostScopedRestartEnvironment,
  isMuxpilotSessionCgroup,
  isRestartExecutionCgroup,
  restartScopeUnitName
} from "../../../.agents/skills/muxpilot-restart-prod/scripts/restart-environment.mjs";

describe("muxpilot production restart helper", () => {
  it("runs production lifecycle directly instead of through a heavyweight worker", () => {
    const source = readFileSync(new URL("../../../.agents/skills/muxpilot-restart-prod/scripts/restart-prod.mjs", import.meta.url), "utf8");
    expect(source).toContain('spawnSync("pnpm", ["app", "restart", "prod"]');
    expect(source).toContain('import { join, resolve } from "node:path"');
    expect(source).not.toContain("muxpilot-git-run.mjs");
    expect(source).not.toContain('"--heavy"');
  });

  it("removes inherited heavyweight ownership from the host-scoped lifecycle", () => {
    expect(hostScopedRestartEnvironment({
      MUXPILOT_HEAVY_BROKER_SOCKET: "/tmp/broker.sock",
      MUXPILOT_HEAVY_BROKER_TOKEN: "secret",
      MUXPILOT_HEAVY_COMPLETION_ENABLED: "1",
      MUXPILOT_HEAVY_QUEUE_ENABLED: "1",
      MUXPILOT_HEAVY_RUN_ID: "run-1",
      EXISTING: "value"
    })).toEqual({
      EXISTING: "value"
    });
  });

  it("recognizes muxpilot session cgroups", () => {
    expect(isMuxpilotSessionCgroup("/user.slice/app.slice/muxpilot-session-685fce440c83e90394a1515c.scope")).toBe(true);
    expect(isMuxpilotSessionCgroup("/user.slice/app.slice/muxpilot-prod-restart-123-ab12cd34.scope")).toBe(false);
  });

  it("allows init or dedicated restart execution cgroups", () => {
    expect(isRestartExecutionCgroup("/init.scope")).toBe(true);
    expect(isRestartExecutionCgroup("/user.slice/app.slice/muxpilot-prod-restart-123-ab12cd34.scope")).toBe(true);
    expect(isRestartExecutionCgroup("/user.slice/app.slice/muxpilot-session-685fce440c83e90394a1515c.scope")).toBe(false);
    expect(isRestartExecutionCgroup("/user.slice/app.slice/not-muxpilot-prod-restart-123-ab12cd34.scope")).toBe(false);
  });

  it("creates a systemd-safe restart scope unit name", () => {
    expect(restartScopeUnitName(123, "ab12cd34")).toBe("muxpilot-prod-restart-123-ab12cd34");
  });
});
