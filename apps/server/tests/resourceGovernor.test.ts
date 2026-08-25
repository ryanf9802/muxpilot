import { describe, expect, it, vi } from "vitest";
import type { ManagedSession, SessionStatus } from "@muxpilot/core";
import { cpus } from "node:os";
import {
  allocateSessionResources,
  parseSystemdMetrics,
  ResourceGovernor,
  type SystemdController
} from "../src/services/resourceGovernor.js";

const config = {
  configured: true,
  enabled: true,
  unavailableReason: null,
  agentMemorySoftPercent: 50,
  agentMemoryHardPercent: 60,
  agentCpuPercent: 75,
  sessionTasksMax: 768
};

describe("allocateSessionResources", () => {
  it("fans the busy pool out and gives sustained idle sessions conservative limits", () => {
    const idleSince = new Map([["idle", 0]]);
    const sessions = [session("one", "working"), session("two", "planning"), session("idle", "waiting")];
    const result = allocateSessionResources(sessions, config, idleSince, 10_000, 16 * 1024 ** 3, 8);

    expect(result.get("one")).toMatchObject({
      busy: true,
      memoryHighBytes: 4 * 1024 ** 3,
      cpuPercent: 300
    });
    expect(result.get("two")?.memoryMaxBytes).toBe(Math.floor(16 * 1024 ** 3 * 0.6 / 2));
    expect(result.get("idle")).toMatchObject({
      busy: false,
      memoryHighBytes: 512 * 1024 ** 2,
      memoryMaxBytes: 1024 * 1024 ** 2,
      cpuPercent: 25
    });
  });

  it("keeps newly idle sessions in the busy pool for five seconds", () => {
    const idleSince = new Map<string, number>();
    const waiting = session("waiting", "waiting");
    expect(allocateSessionResources([waiting], config, idleSince, 1000, 1024 ** 3, 8).get("waiting")?.busy).toBe(true);
    expect(allocateSessionResources([waiting], config, idleSince, 5999, 1024 ** 3, 8).get("waiting")?.busy).toBe(true);
    expect(allocateSessionResources([waiting], config, idleSince, 6000, 1024 ** 3, 8).get("waiting")?.busy).toBe(false);
  });
});

describe("parseSystemdMetrics", () => {
  it("parses available cgroup counters and treats unavailable values as missing", () => {
    expect(parseSystemdMetrics("CPUUsageNSec=2500000000\nMemoryCurrent=1073741824\n")).toEqual({
      memoryCurrentBytes: 1073741824,
      cpuUsageNsec: 2500000000
    });
    expect(parseSystemdMetrics("CPUUsageNSec=[not set]\nMemoryCurrent=infinity\n")).toEqual({
      memoryCurrentBytes: null,
      cpuUsageNsec: null
    });
  });
});

describe("ResourceGovernor", () => {
  it("sets a session's dedicated scope and restores it on shutdown", async () => {
    const properties: string[][] = [];
    let metrics = { memoryCurrentBytes: 2 * 1024 ** 3, cpuUsageNsec: 1_000_000_000 };
    const controller: SystemdController = {
      metrics: vi.fn(async () => metrics),
      setProperties: vi.fn(async (_scope, next) => { properties.push(next); })
    };
    const logger = { info: vi.fn(), warn: vi.fn() };
    const managedSession = { ...session("one", "working"), resourceScope: "muxpilot-session-0123456789abcdef01234567.scope" };
    const governor = new ResourceGovernor(config, async () => [managedSession], logger, controller);
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);

    await governor.reconcile();
    expect(governor.snapshot()).toMatchObject({
      enabled: true,
      managedSessions: 1,
      unmanagedSessions: 0,
      busySessions: 1,
      idleSessions: 0,
      tasksMax: 768
    });
    expect(governor.usageForSession("one")).toMatchObject({
      memoryCurrentBytes: 2 * 1024 ** 3,
      cpuPercent: null
    });

    metrics = { memoryCurrentBytes: 3 * 1024 ** 3, cpuUsageNsec: 3_000_000_000 };
    now.mockReturnValue(3000);
    await governor.reconcile();
    expect(governor.usageForSession("one")).toMatchObject({
      memoryCurrentBytes: 3 * 1024 ** 3,
      cpuPercent: 100
    });
    await governor.stop();
    now.mockRestore();

    expect(controller.setProperties).toHaveBeenCalledWith("muxpilot-session-0123456789abcdef01234567.scope", expect.any(Array));
    expect(properties[0]).toEqual(expect.arrayContaining([
      `CPUQuota=${Math.max(1, Math.round(75 * cpus().length * 100) / 100)}%`,
      "TasksMax=768"
    ]));
    expect(properties[0]?.some((property) => property.startsWith("MemoryMax="))).toBe(true);
    expect(properties[2]).toEqual([
      "CPUQuota=infinity",
      "MemoryHigh=infinity",
      "MemoryMax=infinity",
      "TasksMax=infinity"
    ]);
  });

  it("never manages ambient or malformed scopes", async () => {
    const controller: SystemdController = {
      metrics: vi.fn(async () => ({ memoryCurrentBytes: 1, cpuUsageNsec: 1 })),
      setProperties: vi.fn(async () => undefined)
    };
    const sessions = [
      { ...session("init", "working"), resourceScope: "init.scope" },
      { ...session("legacy", "waiting"), resourceScope: null },
      { ...session("other", "planning"), resourceScope: "other.scope" }
    ];
    const governor = new ResourceGovernor(config, async () => sessions, { info: vi.fn(), warn: vi.fn() }, controller);

    await governor.reconcile();

    expect(controller.metrics).not.toHaveBeenCalled();
    expect(controller.setProperties).not.toHaveBeenCalled();
    expect(governor.snapshot()).toMatchObject({ managedSessions: 0, unmanagedSessions: 3 });
  });

  it("reports unavailable scopes without invoking systemd", async () => {
    const controller: SystemdController = {
      metrics: vi.fn(async () => ({ memoryCurrentBytes: 1, cpuUsageNsec: 1 })),
      setProperties: vi.fn(async () => undefined)
    };
    const governor = new ResourceGovernor({
      ...config,
      enabled: false,
      unavailableReason: "user_systemd_unavailable"
    }, async () => [session("legacy", "working")], { info: vi.fn(), warn: vi.fn() }, controller);

    await governor.reconcile();

    expect(governor.snapshot()).toMatchObject({
      configured: true,
      enabled: false,
      unavailableReason: "user_systemd_unavailable",
      managedSessions: 0,
      unmanagedSessions: 1
    });
    expect(controller.metrics).not.toHaveBeenCalled();
    expect(controller.setProperties).not.toHaveBeenCalled();
  });
});

function session(id: string, status: SessionStatus): ManagedSession {
  return {
    id,
    status,
    initializing: false,
    archived: false,
    tmux: { pid: Number(id.length + 100) }
  } as ManagedSession;
}
