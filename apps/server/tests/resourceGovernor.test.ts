import { describe, expect, it, vi } from "vitest";
import type { ManagedSession, SessionStatus } from "@muxpilot/core";
import { cpus } from "node:os";
import {
  allocateSessionResources,
  ResourceGovernor,
  type SystemdController
} from "../src/services/resourceGovernor.js";

const config = {
  enabled: true,
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

describe("ResourceGovernor", () => {
  it("sets the tmux scope and restores it on shutdown", async () => {
    const properties: string[][] = [];
    const controller: SystemdController = {
      scopeForPid: vi.fn(async () => "tmux-spawn-test.scope"),
      memoryCurrent: vi.fn(async () => 0),
      setProperties: vi.fn(async (_scope, next) => { properties.push(next); })
    };
    const logger = { info: vi.fn(), warn: vi.fn() };
    const governor = new ResourceGovernor(config, async () => [session("one", "working")], logger, controller);

    await governor.reconcile();
    expect(governor.snapshot()).toMatchObject({
      enabled: true,
      busySessions: 1,
      idleSessions: 0,
      tasksMax: 768
    });
    await governor.stop();

    expect(properties[0]).toEqual(expect.arrayContaining([
      `CPUQuota=${Math.max(1, Math.round(75 * cpus().length * 100) / 100)}%`,
      "TasksMax=768"
    ]));
    expect(properties[0]?.some((property) => property.startsWith("MemoryMax="))).toBe(true);
    expect(properties[1]).toEqual([
      "CPUQuota=infinity",
      "MemoryHigh=infinity",
      "MemoryMax=infinity",
      "TasksMax=infinity"
    ]);
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
