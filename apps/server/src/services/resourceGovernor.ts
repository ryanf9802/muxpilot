import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { basename } from "node:path";
import { promisify } from "node:util";
import type { ManagedSession, SessionResourceUsage, SessionStatus } from "@muxpilot/core";

const execFileAsync = promisify(execFile);
const BUSY_STATUSES = new Set<SessionStatus>([
  "generating",
  "executing",
  "working",
  "planning",
  "unknown"
]);
const IDLE_MEMORY_HIGH = 512 * 1024 * 1024;
const IDLE_MEMORY_MAX = 1024 * 1024 * 1024;
const IDLE_CPU_PERCENT = 25;
const IDLE_HYSTERESIS_MS = 5000;

export interface ResourceGovernorConfig {
  enabled: boolean;
  agentMemorySoftPercent: number;
  agentMemoryHardPercent: number;
  agentCpuPercent: number;
  sessionTasksMax: number;
  reconcileIntervalMs?: number;
}

export interface SessionResourceAllocation {
  busy: boolean;
  memoryHighBytes: number;
  memoryMaxBytes: number;
  cpuPercent: number;
  tasksMax: number;
}

export interface ResourceGovernorSnapshot {
  enabled: boolean;
  busySessions: number;
  idleSessions: number;
  busyMemoryHighBytes: number | null;
  busyMemoryMaxBytes: number | null;
  busyCpuPercent: number | null;
  tasksMax: number;
}

interface Logger {
  info(values: object, message: string): void;
  warn(values: object, message: string): void;
}

export interface SystemdController {
  scopeForPid(pid: number): Promise<string | null>;
  metrics(scope: string): Promise<ScopeResourceMetrics>;
  setProperties(scope: string, properties: string[]): Promise<void>;
}

export interface ScopeResourceMetrics {
  memoryCurrentBytes: number | null;
  cpuUsageNsec: number | null;
}

export class ResourceGovernor {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly managedScopes = new Set<string>();
  private readonly idleSince = new Map<string, number>();
  private readonly cpuSamples = new Map<string, { usageNsec: number; sampledAtMs: number }>();
  private resourceUsage = new Map<string, SessionResourceUsage>();
  private currentSnapshot: ResourceGovernorSnapshot;

  constructor(
    private readonly config: ResourceGovernorConfig,
    private readonly listSessions: () => Promise<ManagedSession[]>,
    private readonly logger: Logger,
    private readonly controller: SystemdController = new UserSystemdController()
  ) {
    this.currentSnapshot = {
      enabled: config.enabled,
      busySessions: 0,
      idleSessions: 0,
      busyMemoryHighBytes: null,
      busyMemoryMaxBytes: null,
      busyCpuPercent: null,
      tasksMax: config.sessionTasksMax
    };
  }

  snapshot(): ResourceGovernorSnapshot {
    return { ...this.currentSnapshot };
  }

  usageForSession(sessionId: string): SessionResourceUsage | null {
    return this.resourceUsage.get(sessionId) ?? null;
  }

  start(): void {
    if (!this.config.enabled || this.timer) return;
    void this.reconcile();
    this.timer = setInterval(() => void this.reconcile(), this.config.reconcileIntervalMs ?? 2000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 25));
    const scopes = [...this.managedScopes];
    this.managedScopes.clear();
    await Promise.all(scopes.map((scope) =>
      this.controller.setProperties(scope, [
        "CPUQuota=infinity",
        "MemoryHigh=infinity",
        "MemoryMax=infinity",
        "TasksMax=infinity"
      ]).catch(() => undefined)
    ));
  }

  async reconcile(): Promise<void> {
    if (!this.config.enabled || this.running) return;
    this.running = true;
    try {
      const sessions = (await this.listSessions()).filter((session) =>
        !session.archived && session.status !== "missing" && session.tmux.pid > 0
      );
      const allocations = allocateSessionResources(sessions, this.config, this.idleSince);
      const values = [...allocations.values()];
      const busyAllocation = values.find((allocation) => allocation.busy) ?? null;
      this.currentSnapshot = {
        enabled: true,
        busySessions: values.filter((allocation) => allocation.busy).length,
        idleSessions: values.filter((allocation) => !allocation.busy).length,
        busyMemoryHighBytes: busyAllocation?.memoryHighBytes ?? null,
        busyMemoryMaxBytes: busyAllocation?.memoryMaxBytes ?? null,
        busyCpuPercent: busyAllocation?.cpuPercent ?? null,
        tasksMax: this.config.sessionTasksMax
      };
      const emergency = await memoryAvailablePercent().then((value) => value !== null && value < 8);
      const nextResourceUsage = new Map<string, SessionResourceUsage>();
      const sampledScopes = new Set<string>();
      await Promise.all(sessions.map(async (session) => {
        const scope = await this.controller.scopeForPid(session.tmux.pid);
        if (!scope) return;
        this.managedScopes.add(scope);
        sampledScopes.add(scope);
        const allocation = allocations.get(session.id)!;
        const sampledAtMs = Date.now();
        const metrics = await this.controller.metrics(scope);
        const cpuPercent = this.cpuPercentForSample(scope, metrics.cpuUsageNsec, sampledAtMs);
        if (metrics.memoryCurrentBytes !== null) {
          nextResourceUsage.set(session.id, {
            memoryCurrentBytes: metrics.memoryCurrentBytes,
            memoryHighBytes: allocation.memoryHighBytes,
            memoryMaxBytes: allocation.memoryMaxBytes,
            cpuPercent,
            cpuLimitPercent: allocation.cpuPercent,
            sampledAt: new Date(sampledAtMs).toISOString()
          });
        }
        const properties = [
          `CPUQuota=${formatPercent(allocation.cpuPercent)}`,
          `MemoryHigh=${allocation.memoryHighBytes}`,
          `TasksMax=${allocation.tasksMax}`
        ];
        const current = metrics.memoryCurrentBytes;
        if (emergency || (current !== null && current <= allocation.memoryMaxBytes)) {
          properties.push(`MemoryMax=${allocation.memoryMaxBytes}`);
        }
        await this.controller.setProperties(scope, properties);
      }).map((operation) => operation.catch((error) => {
        this.logger.warn({ err: error }, "could not apply resource limits to a session scope");
      })));
      for (const scope of this.cpuSamples.keys()) {
        if (!sampledScopes.has(scope)) this.cpuSamples.delete(scope);
      }
      this.resourceUsage = nextResourceUsage;
    } catch (error) {
      this.resourceUsage = new Map();
      this.logger.warn({ err: error }, "resource governor reconciliation failed");
    } finally {
      this.running = false;
    }
  }

  private cpuPercentForSample(scope: string, usageNsec: number | null, sampledAtMs: number): number | null {
    if (usageNsec === null) return null;
    const previous = this.cpuSamples.get(scope);
    this.cpuSamples.set(scope, { usageNsec, sampledAtMs });
    if (!previous || usageNsec < previous.usageNsec || sampledAtMs <= previous.sampledAtMs) return null;
    return Math.max(0, (usageNsec - previous.usageNsec) / ((sampledAtMs - previous.sampledAtMs) * 1_000_000) * 100);
  }
}

export function allocateSessionResources(
  sessions: ManagedSession[],
  config: Pick<ResourceGovernorConfig, "agentMemorySoftPercent" | "agentMemoryHardPercent" | "agentCpuPercent" | "sessionTasksMax">,
  idleSince: Map<string, number> = new Map(),
  now = Date.now(),
  totalMemoryBytes = totalmem(),
  logicalCpuCount = cpus().length
): Map<string, SessionResourceAllocation> {
  const busy = sessions.filter((session) => {
    if (session.initializing || BUSY_STATUSES.has(session.status)) {
      idleSince.delete(session.id);
      return true;
    }
    const since = idleSince.get(session.id) ?? now;
    idleSince.set(session.id, since);
    return now - since < IDLE_HYSTERESIS_MS;
  });
  const divisor = Math.max(1, busy.length);
  const busyIds = new Set(busy.map((session) => session.id));
  const softPool = totalMemoryBytes * config.agentMemorySoftPercent / 100;
  const hardPool = totalMemoryBytes * config.agentMemoryHardPercent / 100;
  const result = new Map<string, SessionResourceAllocation>();
  for (const session of sessions) {
    const isBusy = busyIds.has(session.id);
    result.set(session.id, isBusy ? {
      busy: true,
      memoryHighBytes: Math.floor(softPool / divisor),
      memoryMaxBytes: Math.floor(hardPool / divisor),
      cpuPercent: logicalCpuCount * config.agentCpuPercent / divisor,
      tasksMax: config.sessionTasksMax
    } : {
      busy: false,
      memoryHighBytes: IDLE_MEMORY_HIGH,
      memoryMaxBytes: IDLE_MEMORY_MAX,
      cpuPercent: IDLE_CPU_PERCENT,
      tasksMax: config.sessionTasksMax
    });
  }
  return result;
}

export class UserSystemdController implements SystemdController {
  async scopeForPid(pid: number): Promise<string | null> {
    const cgroup = await readFile(`/proc/${pid}/cgroup`, "utf8").catch(() => "");
    const unified = cgroup.split(/\r?\n/).find((line) => line.startsWith("0::"))?.slice(3);
    const unit = unified ? basename(unified) : "";
    return unit.endsWith(".scope") ? unit : null;
  }

  async metrics(scope: string): Promise<ScopeResourceMetrics> {
    const { stdout } = await execFileAsync("systemctl", [
      "--user", "show", scope, "--property=MemoryCurrent", "--property=CPUUsageNSec"
    ], { timeout: 2000 });
    return parseSystemdMetrics(stdout);
  }

  async setProperties(scope: string, properties: string[]): Promise<void> {
    await execFileAsync("systemctl", ["--user", "set-property", "--runtime", scope, ...properties], { timeout: 2000 });
  }
}

export function parseSystemdMetrics(output: string): ScopeResourceMetrics {
  const properties = Object.fromEntries(
    output.trim().split(/\r?\n/).map((line) => {
      const separator = line.indexOf("=");
      return separator >= 0 ? [line.slice(0, separator), line.slice(separator + 1)] : [line, ""];
    })
  );
  return {
    memoryCurrentBytes: nonnegativeNumber(properties.MemoryCurrent),
    cpuUsageNsec: nonnegativeNumber(properties.CPUUsageNSec)
  };
}

function nonnegativeNumber(value: string | undefined): number | null {
  if (!value?.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function formatPercent(value: number): string {
  return `${Math.max(1, Math.round(value * 100) / 100)}%`;
}

async function memoryAvailablePercent(): Promise<number | null> {
  const text = await readFile("/proc/meminfo", "utf8").catch(() => "");
  const total = Number(text.match(/^MemTotal:\s+(\d+)/m)?.[1]);
  const available = Number(text.match(/^MemAvailable:\s+(\d+)/m)?.[1]);
  return total > 0 && available >= 0 ? available / total * 100 : null;
}
