import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  hostScopedShadowEnvironment,
  isMuxpilotSessionCgroup,
  isShadowExecutionCgroup,
  shadowSocketPathSafety,
  shadowScopeUnitName,
  verifyReusableDependencyInstall,
  verifyProductionUnchanged
} from "../../../.agents/skills/muxpilot-start-shadow/scripts/shadow-environment.mjs";

describe("muxpilot shadow start helper", () => {
  it("runs persistent shadow lifecycle without the heavyweight runner", () => {
    const source = readFileSync(new URL("../../../.agents/skills/muxpilot-start-shadow/scripts/start-shadow.mjs", import.meta.url), "utf8");
    expect(source).toContain('spawnSync("pnpm", pnpmArgs');
    expect(source).toContain('MUXPILOT_SHADOW_STOPPED_OUTSIDE_SESSION_SCOPE');
    expect(source).toContain('waitForPortAvailable(port)');
    expect(source).not.toContain("muxpilot-git-run.mjs");
    expect(source).not.toContain('"--heavy"');
  });

  it("removes heavyweight execution ownership from direct host-scoped commands", () => {
    expect(hostScopedShadowEnvironment({
      MUXPILOT_HEAVY_QUEUE_ENABLED: "1",
      MUXPILOT_HEAVY_COMPLETION_ENABLED: "1",
      MUXPILOT_HEAVY_RUN_ID: "stale-run",
      MUXPILOT_HEAVY_BROKER_SOCKET: "/tmp/heavy.sock",
      MUXPILOT_HEAVY_BROKER_TOKEN: "secret",
      MUXPILOT_HEAVY_VALIDATION_CONCURRENCY: "2",
      KEEP: "value"
    })).toEqual({
      MUXPILOT_HEAVY_VALIDATION_CONCURRENCY: "2",
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
    expect(long.unsafePaths.some(({ path }) => path.endsWith("git-workflow-broker/broker.sock"))).toBe(true);
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

  it("reuses an exact ancestor installation only when dependency inputs are unchanged", () => {
    const root = mkdtempSync(join(tmpdir(), "muxpilot-shadow-deps-"));
    try {
      git(root, "init");
      git(root, "config", "user.email", "shadow-test@example.com");
      git(root, "config", "user.name", "Shadow Test");
      writeFileSync(join(root, "package.json"), '{"name":"fixture"}\n');
      writeFileSync(join(root, "source.txt"), "one\n");
      git(root, "add", ".");
      git(root, "commit", "-m", "initial");
      const installed = git(root, "rev-parse", "HEAD");

      writeFileSync(join(root, "source.txt"), "two\n");
      git(root, "commit", "-am", "source only");
      const sourceOnly = git(root, "rev-parse", "HEAD");
      expect(verifyReusableDependencyInstall(root, installed, sourceOnly)).toEqual({
        installedCommit: installed,
        requestedCommit: sourceOnly
      });

      writeFileSync(join(root, "package.json"), '{"name":"fixture","dependencies":{"x":"1"}}\n');
      git(root, "commit", "-am", "dependency change");
      const dependencyChange = git(root, "rev-parse", "HEAD");
      expect(() => verifyReusableDependencyInstall(root, installed, dependencyChange)).toThrow("dependency inputs changed");
      expect(() => verifyReusableDependencyInstall(root, "not-a-sha", dependencyChange)).toThrow("exact lowercase 40-character Git SHA");
      expect(() => verifyReusableDependencyInstall(root, dependencyChange, installed)).toThrow("is not an ancestor");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function git(root: string, ...args: string[]) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

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
