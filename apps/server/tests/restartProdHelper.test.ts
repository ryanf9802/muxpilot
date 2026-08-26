import { describe, expect, it } from "vitest";
import {
  hostScopedHeavyEnvironment,
  isMuxpilotSessionCgroup,
  isRestartExecutionCgroup,
  restartScopeUnitName
} from "../../../.agents/skills/muxpilot-restart-prod/scripts/restart-environment.mjs";

describe("muxpilot production restart helper", () => {
  it("keeps heavyweight scheduler waiting attached to the host-scoped verifier", () => {
    expect(hostScopedHeavyEnvironment({
      MUXPILOT_HEAVY_QUEUE_ENABLED: "1",
      EXISTING: "value"
    })).toEqual({
      MUXPILOT_HEAVY_QUEUE_ENABLED: "0",
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
