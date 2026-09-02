import { describe, expect, it } from "vitest";
import {
  hostScopedHeavyEnvironment,
  isMuxpilotSessionCgroup,
  isShadowExecutionCgroup,
  shadowSocketPathSafety,
  shadowScopeUnitName,
  verifyProductionUnchanged
} from "../../../.agents/skills/muxpilot-start-shadow/scripts/shadow-environment.mjs";

describe("muxpilot shadow start helper", () => {
  it("keeps heavyweight installation and startup in the host verifier", () => {
    expect(hostScopedHeavyEnvironment({ MUXPILOT_HEAVY_QUEUE_ENABLED: "1", KEEP: "value" })).toEqual({
      MUXPILOT_HEAVY_QUEUE_ENABLED: "0",
      KEEP: "value"
    });
  });

  it("recognizes only the intended cgroup identities", () => {
    expect(isMuxpilotSessionCgroup("/user.slice/app.slice/muxpilot-session-685fce440c83e90394a1515c.scope")).toBe(true);
    expect(isShadowExecutionCgroup("/init.scope")).toBe(true);
    expect(isShadowExecutionCgroup("/user.slice/app.slice/muxpilot-shadow-start-123-ab12cd34.scope")).toBe(true);
    expect(isShadowExecutionCgroup("/user.slice/app.slice/muxpilot-session-685fce440c83e90394a1515c.scope")).toBe(false);
    expect(shadowScopeUnitName(123, "ab12cd34")).toBe("muxpilot-shadow-start-123-ab12cd34");
  });

  it("rejects checkout paths that cannot hold every shadow Unix socket", () => {
    const short = shadowSocketPathSafety("/home/user/mp-s");
    expect(short.safe).toBe(true);
    expect(short.unsafePaths).toEqual([]);

    const long = shadowSocketPathSafety(`/home/user/${"deep-checkout/".repeat(8)}muxpilot`);
    expect(long.safe).toBe(false);
    expect(long.unsafePaths.some(({ path }) => path.endsWith("git-workflow-broker.sock"))).toBe(true);
    expect(long.unsafePaths.every(({ bytes }) => bytes > long.maxBytes)).toBe(true);
  });

  it("requires production identities to survive while allowing additive sessions", () => {
    const before = snapshot();
    expect(() => verifyProductionUnchanged(before, {
      ...snapshot(),
      tmuxPanes: [...before.tmuxPanes, { identity: "new:@9:%9", pid: 99 }],
      appServerServices: [...before.appServerServices, { unit: "muxpilot-session-ffffffffffffffffffffffff.service", activeState: "active", mainPid: 99 }],
      sessions: [...before.sessions, { id: "new", codexSessionId: "thread-new", driverKind: "codex_tmux", tmuxPaneId: "%9", tmuxPid: 99 }]
    })).not.toThrow();
    expect(() => verifyProductionUnchanged(before, {
      ...snapshot(),
      processes: { ...before.processes, server: { pid: 99, cgroup: "/prod.scope" } }
    })).toThrow("production server identity changed");
    expect(() => verifyProductionUnchanged(before, { ...snapshot(), tmuxPanes: [] })).toThrow("production tmux pane changed");
    expect(() => verifyProductionUnchanged(before, { ...snapshot(), sessions: [] })).toThrow("production session identity changed");
  });
});

function snapshot() {
  return {
    processes: {
      supervisor: { pid: 1, cgroup: "/prod.scope" },
      server: { pid: 2, cgroup: "/prod.scope" },
      web: { pid: 3, cgroup: "/prod.scope" }
    },
    tmuxPanes: [{ identity: "prod:@1:%1", pid: 4 }],
    appServerServices: [{ unit: "muxpilot-session-0123456789abcdef01234567.service", activeState: "active", mainPid: 5 }],
    sessions: [{ id: "session-1", codexSessionId: "thread-1", driverKind: "codex_tmux", tmuxPaneId: "%1", tmuxPid: 4 }]
  };
}
