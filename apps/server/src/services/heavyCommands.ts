import { serializeHeavyCommandQueueEvent } from "@muxpilot/core";
import type { HeavyCommand, HeavyCommandOutputResponse, HeavyCommandsResponse } from "@muxpilot/core";
import { createConnection } from "node:net";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

const ACTIVE_STATES = new Set(["waiting", "reserved", "running", "stalled", "terminating"]);
const RUN_ID = /^[a-z0-9]+-[a-f0-9]{12}$/;
const MAX_OWNER_BYTES = 256 * 1024;
const MAX_TAIL_BYTES = 128 * 1024;

export interface HeavyCommandSessionCoordinator {
  sessionIdForWorkspace(workspaceId: string): Promise<string | null>;
  resumeHeavyCommand(sessionId: string, message: string): Promise<boolean>;
}

export class HeavyCommandService {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private coordinator: HeavyCommandSessionCoordinator | null = null;

  constructor(
    private readonly leaseRoot: string,
    private readonly sessionRoot: string,
    private readonly concurrency = 2,
    private readonly resumeTimeoutMs = 120_000
  ) {}

  start(coordinator: HeavyCommandSessionCoordinator): void {
    this.coordinator = coordinator;
    if (this.timer) return;
    this.timer = setInterval(() => this.scheduleTick(), 250);
    this.scheduleTick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    while (this.ticking) await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }

  private scheduleTick(): void {
    void this.tick().catch((error) => console.error("Muxpilot heavyweight scheduler tick failed", error));
  }

  async hasDeferred(workspaceId: string): Promise<boolean> {
    return (await this.list(workspaceId)).commands.some((command) => command.state === "waiting" || command.state === "reserved");
  }

  async cancelWorkspace(workspaceId: string, reason: string): Promise<void> {
    await this.withSchedulerLock(async () => {
      for (const owner of await this.readQueueOwners()) {
        if (owner.workspaceId === workspaceId && (owner.state === "waiting" || owner.state === "reserved")) {
          await this.cancelOwner(owner, reason);
        }
      }
    });
  }

  async list(workspaceId: string): Promise<HeavyCommandsResponse> {
    const commands: HeavyCommand[] = [];
    for (const runId of await readdir(join(this.leaseRoot, "runs")).catch(() => [])) {
      if (!RUN_ID.test(runId)) continue;
      const command = await this.readOwner(runId, workspaceId);
      if (command && ACTIVE_STATES.has(command.state)) commands.push(command);
    }
    commands.sort((left, right) => left.queuedAt.localeCompare(right.queuedAt) || left.runId.localeCompare(right.runId));
    const globalWaiting = (await this.readQueueOwners()).filter((owner) => owner.state === "waiting")
      .sort((left, right) => left.queuedAt.localeCompare(right.queuedAt) || left.runId.localeCompare(right.runId));
    const positions = new Map(globalWaiting.map((owner, index) => [owner.runId, index + 1]));
    for (const command of commands) {
      command.queuePosition = command.state === "waiting" ? positions.get(command.runId) ?? null : null;
    }
    return { commands, sampledAt: new Date().toISOString() };
  }

  async output(workspaceId: string, runId: string): Promise<HeavyCommandOutputResponse | null> {
    const command = await this.readOwner(runId, workspaceId);
    if (!command?.logPath) return null;
    const expectedRoot = resolve(this.sessionRoot, workspaceId, "heavy-commands");
    const path = resolve(command.logPath);
    if (!inside(expectedRoot, path)) return null;
    const details = await lstat(path).catch(() => null);
    if (!details?.isFile() || details.isSymbolicLink()) return null;
    const canonicalRoot = await realpath(expectedRoot).catch(() => null);
    const canonicalPath = await realpath(path).catch(() => null);
    if (!canonicalRoot || !canonicalPath || !inside(canonicalRoot, canonicalPath)) return null;
    const length = Math.min(details.size, MAX_TAIL_BYTES);
    const file = await open(canonicalPath, "r");
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, Math.max(0, details.size - length));
      return { runId, output: buffer.subarray(0, bytesRead).toString("utf8"), truncated: details.size > length };
    } finally {
      await file.close();
    }
  }

  async terminate(workspaceId: string, runId: string): Promise<"accepted" | "missing" | "inactive"> {
    const command = await this.readOwner(runId, workspaceId);
    if (!command) return "missing";
    if (!ACTIVE_STATES.has(command.state)) return "inactive";
    if (command.state === "waiting" || command.state === "reserved") {
      await this.withSchedulerLock(async () => {
        const owner = await this.readQueueOwner(runId);
        if (owner) await this.cancelOwner(owner, "operator cancelled queued heavyweight command");
      });
      return "accepted";
    }
    const socketPath = join(this.leaseRoot, "runs", runId, "control.sock");
    const response = await sendControl(socketPath, { action: "terminate" }).catch(() => null);
    if (!response?.ok) return "inactive";
    return response.accepted ? "accepted" : "inactive";
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const reserved = await this.withSchedulerLock(async () => {
        const now = Date.now();
        let owners = await this.readQueueOwners();
        for (const owner of owners) {
          if (owner.state === "reserved" && owner.resumeDeadlineAt && Date.parse(owner.resumeDeadlineAt) <= now) {
            await this.cancelOwner(owner, "resume reservation expired before the agent claimed it");
          }
        }
        owners = await this.readQueueOwners();
        const occupied = new Set<number>();
        for (let slot = 0; slot < this.concurrency; slot += 1) {
          if (await this.slotOccupied(slot, owners)) occupied.add(slot);
        }
        const waiting = owners.filter((owner) => owner.state === "waiting")
          .sort((left, right) => left.queuedAt.localeCompare(right.queuedAt) || left.runId.localeCompare(right.runId));
        for (const owner of waiting) {
          const slot = Array.from({ length: this.concurrency }, (_, index) => index).find((candidate) => !occupied.has(candidate));
          if (slot === undefined) break;
          const slotPath = join(this.leaseRoot, `slot-${slot}`);
          await mkdir(slotPath);
          const heartbeatAt = new Date().toISOString();
          await writeFile(join(slotPath, "owner.json"), JSON.stringify({ version: 4, runId: owner.runId, state: "reserved", heartbeatAt }), { mode: 0o600 });
          owner.state = "reserved";
          owner.slot = slot;
          owner.heartbeatAt = heartbeatAt;
          await this.writeOwner(owner);
          occupied.add(slot);
        }
        const current = await this.readQueueOwners();
        for (const owner of current) {
          owner.heartbeatAt = new Date().toISOString();
          await this.writeOwner(owner);
          if (owner.state === "reserved" && owner.slot !== null) {
            await writeFile(join(this.leaseRoot, `slot-${owner.slot}`, "owner.json"), JSON.stringify({ version: 4, runId: owner.runId, state: "reserved", heartbeatAt: owner.heartbeatAt }), { mode: 0o600 });
          }
        }
        return current.filter((owner) => owner.state === "reserved" && !owner.resumeSentAt);
      });

      for (const owner of reserved) await this.dispatchResume(owner);
    } finally {
      this.ticking = false;
    }
  }

  private async dispatchResume(owner: QueueOwner): Promise<void> {
    if (!this.coordinator) return;
    const sessionId = await this.coordinator.sessionIdForWorkspace(owner.workspaceId);
    if (!sessionId) {
      await this.cancelWorkspace(owner.workspaceId, "owning session is no longer available");
      return;
    }
    await this.withSchedulerLock(async () => {
      const current = await this.readQueueOwner(owner.runId);
      if (!current || current.state !== "reserved" || current.resumeSentAt) return;
      if (current.slot === null) {
        await this.cancelOwner(current, "reserved heavyweight command has no slot");
        return;
      }
      const command = [process.execPath, current.runnerPath, "--heavy", "--resume", current.runId, ...current.runnerOptions, "--", ...current.command];
      const message = serializeHeavyCommandQueueEvent({
        version: 1,
        kind: "resume_requested",
        runId: current.runId,
        commandDisplay: current.commandDisplay,
        skill: "$muxpilot-heavy-command-queue",
        slot: current.slot,
        resumeCommand: command.map(shellQuote).join(" ")
      });
      if (!await this.coordinator!.resumeHeavyCommand(sessionId, message)) return;
      const sentAt = new Date();
      current.resumeSentAt = sentAt.toISOString();
      current.resumeDeadlineAt = new Date(sentAt.getTime() + this.resumeTimeoutMs).toISOString();
      current.heartbeatAt = sentAt.toISOString();
      await this.writeOwner(current);
    });
  }

  private async slotOccupied(slot: number, queuedOwners: QueueOwner[]): Promise<boolean> {
    const path = join(this.leaseRoot, `slot-${slot}`);
    let owner: Record<string, unknown>;
    try { owner = JSON.parse(await readFile(join(path, "owner.json"), "utf8")) as Record<string, unknown>; } catch {
      if (!await stat(path).catch(() => null)) return false;
      await rm(path, { recursive: true, force: true });
      return false;
    }
    if (owner.version === 4 && owner.state === "reserved") {
      const valid = queuedOwners.some((candidate) => candidate.runId === owner.runId && candidate.state === "reserved" && candidate.slot === slot);
      if (valid) return true;
      await rm(path, { recursive: true, force: true });
      return false;
    }
    if (owner.version === 2 && typeof owner.controlSocket === "string") {
      const response = await sendControl(owner.controlSocket, { action: "probe" }).catch(() => null);
      if (response?.ok) return true;
      await rm(path, { recursive: true, force: true });
      return false;
    }
    const heartbeat = typeof owner.heartbeatAt === "number" ? owner.heartbeatAt : Date.parse(String(owner.heartbeatAt));
    if (Number.isFinite(heartbeat) && Date.now() - heartbeat < 12 * 60 * 60 * 1000) return true;
    await rm(path, { recursive: true, force: true });
    return false;
  }

  private async cancelOwner(owner: QueueOwner, reason: string): Promise<void> {
    owner.state = "cancelled";
    owner.terminationReason = reason;
    owner.heartbeatAt = new Date().toISOString();
    await this.writeOwner(owner);
    if (owner.slot !== null) await rm(join(this.leaseRoot, `slot-${owner.slot}`), { recursive: true, force: true });
  }

  private async readQueueOwners(): Promise<QueueOwner[]> {
    const owners: QueueOwner[] = [];
    for (const runId of await readdir(join(this.leaseRoot, "runs")).catch(() => [])) {
      const owner = await this.readQueueOwner(runId);
      if (owner && (owner.state === "waiting" || owner.state === "reserved")) owners.push(owner);
    }
    return owners;
  }

  private async readQueueOwner(runId: string): Promise<QueueOwner | null> {
    try {
      const owner = JSON.parse(await readFile(join(this.leaseRoot, "runs", runId, "owner.json"), "utf8")) as QueueOwner;
      if (owner.version !== 4 || owner.runId !== runId || !owner.workspaceId || !owner.cwd || !owner.runnerPath) return null;
      if (!Array.isArray(owner.command) || !owner.command.every((part) => typeof part === "string")) return null;
      if (!Array.isArray(owner.runnerOptions) || !owner.runnerOptions.every((part) => typeof part === "string")) return null;
      return owner;
    } catch {
      return null;
    }
  }

  private async writeOwner(owner: QueueOwner): Promise<void> {
    const path = join(this.leaseRoot, "runs", owner.runId, "owner.json");
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(owner), { mode: 0o600 });
    await rename(temporary, path);
  }

  private async withSchedulerLock<T>(operation: () => Promise<T>): Promise<T> {
    const path = join(this.leaseRoot, "scheduler-lock");
    await mkdir(this.leaseRoot, { recursive: true });
    while (true) {
      try { await mkdir(path); break; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const details = await stat(path).catch(() => null);
        if (details && Date.now() - details.mtimeMs > 60_000) await rm(path, { recursive: true, force: true });
        else await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      }
    }
    try { return await operation(); } finally { await rm(path, { recursive: true, force: true }); }
  }

  private async readOwner(runId: string, workspaceId: string): Promise<HeavyCommand | null> {
    if (!RUN_ID.test(runId)) return null;
    const runPath = join(this.leaseRoot, "runs", runId);
    const runDetails = await lstat(runPath).catch(() => null);
    if (!runDetails?.isDirectory() || runDetails.isSymbolicLink()) return null;
    const path = join(runPath, "owner.json");
    const details = await lstat(path).catch(() => null);
    if (!details?.isFile() || details.isSymbolicLink() || details.size > MAX_OWNER_BYTES) return null;
    try {
      const owner = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      if (![2, 3, 4].includes(Number(owner.version)) || owner.runId !== runId || owner.workspaceId !== workspaceId) return null;
      if (typeof owner.state !== "string" || !Array.isArray(owner.command) || !owner.command.every((part) => typeof part === "string")) return null;
      if (typeof owner.cwd !== "string" || typeof owner.commandDisplay !== "string" || typeof owner.queuedAt !== "string" || typeof owner.heartbeatAt !== "string") return null;
      const heartbeatAt = Date.parse(owner.heartbeatAt);
      if (!Number.isFinite(heartbeatAt) || !Number.isFinite(Date.parse(owner.queuedAt))) return null;
      if (ACTIVE_STATES.has(String(owner.state)) && Date.now() - heartbeatAt > 60_000) return null;
      if (owner.startedAt !== null && typeof owner.startedAt !== "string") return null;
      if (owner.lastOutputAt !== null && typeof owner.lastOutputAt !== "string") return null;
      if (Number(owner.version) >= 3 && ((owner.lastActivityAt !== null && typeof owner.lastActivityAt !== "string") || !validActivity(owner.activity))) return null;
      if (owner.logPath !== null && typeof owner.logPath !== "string") return null;
      if (owner.childPid !== null && (!Number.isInteger(owner.childPid) || Number(owner.childPid) <= 0)) return null;
      if (owner.slot !== null && (!Number.isInteger(owner.slot) || Number(owner.slot) < 0)) return null;
      if (!validDeadlines(owner.deadlines) || (owner.packageDiagnostics !== null && !validPackageDiagnostics(owner.packageDiagnostics))) return null;
      if (owner.terminationReason !== null && typeof owner.terminationReason !== "string") return null;
      return owner as unknown as HeavyCommand;
    } catch {
      return null;
    }
  }
}

interface QueueOwner extends Omit<HeavyCommand, "state"> {
  version: 4;
  state: HeavyCommand["state"] | "acquiring" | "cancelled" | "completed";
  runnerPath: string;
  runnerOptions: string[];
}

function validActivity(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const activity = value as Record<string, unknown>;
  return ["processCount", "cpuTicks", "ioBytes", "runningContainers", "createdContainers"]
    .every((key) => Number.isFinite(activity[key]) && Number(activity[key]) >= 0);
}

function validDeadlines(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const deadlines = value as Record<string, unknown>;
  return ["inactivityWarnMs", "inactivityTimeoutMs", "runtimeTimeoutMs", "terminationGraceMs"]
    .every((key) => Number.isSafeInteger(deadlines[key]) && Number(deadlines[key]) > 0);
}

function validPackageDiagnostics(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const diagnostics = value as Record<string, unknown>;
  if (!["declared", "resolvedPath", "resolvedVersion", "storePath"].every((key) => diagnostics[key] === null || typeof diagnostics[key] === "string")) return false;
  if (!Array.isArray(diagnostics.warnings) || !diagnostics.warnings.every((warning) => typeof warning === "string")) return false;
  if (!diagnostics.cachePaths || typeof diagnostics.cachePaths !== "object" || Array.isArray(diagnostics.cachePaths)) return false;
  return Object.values(diagnostics.cachePaths as Record<string, unknown>).every((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const cache = entry as Record<string, unknown>;
    return typeof cache.path === "string" && typeof cache.writable === "boolean";
  });
}

function sendControl(path: string, payload: object): Promise<{ ok?: boolean; accepted?: boolean }> {
  return new Promise((resolveResponse, reject) => {
    const socket = createConnection(path);
    let input = "";
    socket.setEncoding("utf8");
    socket.setTimeout(2_000, () => socket.destroy(new Error("control socket timed out")));
    socket.once("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on("data", (chunk) => {
      input += chunk;
      if (!input.includes("\n")) return;
      socket.end();
      try { resolveResponse(JSON.parse(input.trim())); } catch (error) { reject(error); }
    });
    socket.once("error", reject);
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function inside(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}
