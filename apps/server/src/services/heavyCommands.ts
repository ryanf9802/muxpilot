import { serializeHeavyCommandQueueEvent } from "@muxpilot/core";
import type { HeavyCommand, HeavyCommandOutputResponse, HeavyCommandsResponse } from "@muxpilot/core";
import { execFile } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { createConnection, createServer, type Server } from "node:net";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ACTIVE_STATES = new Set(["waiting", "reserved", "running", "stalled", "terminating", "reporting"]);
const RUNNING_STATES = new Set(["running", "stalled", "terminating"]);
const TRANSITION_STATES = new Set(["reserved", "reporting"]);
const RUN_ID = /^[a-z0-9]+-[a-f0-9]{12}$/;
const RESOURCE_UNIT = /^muxpilot-heavy-[a-z0-9]+-[a-f0-9]{12}-[a-f0-9]{6}\.service$/;
const MAX_OWNER_BYTES = 256 * 1024;
const MAX_TAIL_BYTES = 128 * 1024;
const COMPLETION_TAIL_BYTES = 32 * 1024;
const ACTIVE_OWNER_STALE_MS = 60_000;
const SLOT_OWNER_STALE_MS = 12 * 60 * 60 * 1000;
const COMPLETION_SUPPRESSION_FILE = "completion-suppressed";

export interface HeavyCommandSessionCoordinator {
  sessionIdForWorkspace(workspaceId: string): Promise<string | null>;
  resumeHeavyCommand(sessionId: string, message: string): Promise<boolean>;
  syncHeavyCommandSessionStatus(workspaceId: string, status: HeavyCommandSessionStatus): Promise<void>;
}

export interface HeavyCommandLaunchBrokerOptions {
  enabled: boolean;
  environment: Record<string, string>;
  token: string;
  runnerPath: string;
  logger: { warn(values: object, message: string): void };
  runCommand?: (command: string, args: string[]) => Promise<void>;
}

type OwnerProcessState = "active" | "inactive" | "unknown";

export interface HeavyCommandRuntime {
  ownerProcessState(owner: { wrapperPid?: number | null; resourceUnit?: string | null }): Promise<OwnerProcessState>;
  stopResourceUnit(resourceUnit: string): Promise<void>;
}

export class HeavyCommandService {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private coordinator: HeavyCommandSessionCoordinator | null = null;
  private brokerServer: Server | null = null;
  private activeStatusWorkspaces = new Set<string>();
  private readonly runtime: HeavyCommandRuntime;

  constructor(
    private readonly leaseRoot: string,
    private readonly sessionRoot: string,
    private readonly concurrency = 2,
    private readonly resumeTimeoutMs = 120_000,
    private readonly launchBroker: HeavyCommandLaunchBrokerOptions | null = null,
    runtime?: HeavyCommandRuntime
  ) {
    this.runtime = runtime ?? new HostHeavyCommandRuntime(launchBroker);
  }

  brokerSocketPath(): string | null {
    return this.launchBroker?.enabled ? join(this.leaseRoot, "broker.sock") : null;
  }

  async start(coordinator: HeavyCommandSessionCoordinator): Promise<void> {
    this.coordinator = coordinator;
    if (this.timer) return;
    if (this.launchBroker?.enabled) await this.startLaunchBroker();
    this.timer = setInterval(() => this.scheduleTick(), 250);
    this.scheduleTick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    while (this.ticking) await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    if (this.brokerServer) await new Promise<void>((resolveClose) => this.brokerServer!.close(() => resolveClose()));
    this.brokerServer = null;
    if (this.launchBroker?.enabled) {
      await rm(join(this.leaseRoot, "broker.sock"), { force: true });
      await rm(join(this.leaseRoot, "broker-token"), { force: true });
    }
  }

  private async startLaunchBroker(): Promise<void> {
    const options = this.launchBroker!;
    const socketPath = join(this.leaseRoot, "broker.sock");
    await mkdir(this.leaseRoot, { recursive: true, mode: 0o700 });
    await rm(socketPath, { force: true });
    await writeFile(join(this.leaseRoot, "broker-token"), options.token, { mode: 0o600 });
    const server = createServer((socket) => {
      let input = "";
      let handled = false;
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        input += chunk;
        if (input.length > 16 * 1024) {
          handled = true;
          socket.destroy(new Error("heavyweight launch request exceeded 16 KiB"));
          return;
        }
        if (handled || !input.includes("\n")) return;
        handled = true;
        void this.handleLaunchRequest(input.trim()).then(
          (response) => socket.end(`${JSON.stringify(response)}\n`),
          (error) => {
            options.logger.warn({ err: error }, "could not launch transient heavyweight worker");
            socket.end(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
          }
        );
      });
      socket.on("error", () => undefined);
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(socketPath, resolveListen);
    });
    await chmod(socketPath, 0o600);
    this.brokerServer = server;
  }

  private async handleLaunchRequest(text: string): Promise<{ ok: true }> {
    const request = JSON.parse(text) as Record<string, unknown>;
    if (!safeToken(String(request.token ?? ""), this.launchBroker!.token)) throw new Error("unauthorized heavyweight launch request");
    const resourceUnit = String(request.resourceUnit ?? "");
    if (request.action === "stop" && RESOURCE_UNIT.test(resourceUnit)) {
      await this.runBrokerCommand("systemctl", ["--user", "stop", resourceUnit], 5_000);
      return { ok: true };
    }
    const runId = String(request.runId ?? "");
    const bootstrapSocket = resolve(String(request.bootstrapSocket ?? ""));
    if (request.action !== "launch" || !RUN_ID.test(runId) || !RESOURCE_UNIT.test(resourceUnit)) {
      throw new Error("heavyweight launch request is invalid");
    }
    const expectedRunRoot = resolve(this.leaseRoot, "runs", runId);
    if (!inside(expectedRunRoot, bootstrapSocket) || !/^bootstrap-[0-9]+-[a-f0-9]{6}\.sock$/.test(bootstrapSocket.slice(expectedRunRoot.length + 1))) {
      throw new Error("heavyweight bootstrap socket is outside its run directory");
    }
    const socketDetails = await lstat(bootstrapSocket).catch(() => null);
    if (!socketDetails?.isSocket() || socketDetails.isSymbolicLink()) throw new Error("heavyweight bootstrap socket is unavailable");
    await this.runBrokerCommand("systemd-run", [
      "--user", "--quiet", "--collect", "--service-type=exec",
      `--unit=${resourceUnit}`,
      "--property=StandardOutput=null", "--property=StandardError=null",
      process.execPath, this.launchBroker!.runnerPath, "--muxpilot-heavy-worker-bootstrap", bootstrapSocket
    ], 15_000);
    return { ok: true };
  }

  private async runBrokerCommand(command: string, args: string[], timeout: number): Promise<void> {
    if (this.launchBroker?.runCommand) return this.launchBroker.runCommand(command, args);
    await execFileAsync(command, args, {
      timeout,
      env: { ...process.env, ...this.launchBroker!.environment }
    });
  }

  private scheduleTick(): void {
    void this.tick().catch((error) => console.error("Muxpilot heavyweight scheduler tick failed", error));
  }

  async hasActive(workspaceId: string): Promise<boolean> {
    return (await this.list(workspaceId)).commands.length > 0;
  }

  async hasRunning(workspaceId: string): Promise<boolean> {
    return (await this.list(workspaceId)).commands.some((command) => RUNNING_STATES.has(command.state));
  }

  async sessionStatusForWorkspace(workspaceId: string): Promise<HeavyCommandSessionStatus> {
    return heavyCommandSessionStatus((await this.list(workspaceId)).commands);
  }

  async runningWorkspaceIds(): Promise<Set<string>> {
    return new Set((await this.runningOwners()).map((owner) => owner.workspaceId));
  }

  async runningResourceUnits(): Promise<Array<{ workspaceId: string; unit: string }>> {
    return (await this.runningOwners())
      .filter((owner): owner is HeavyCommand & { resourceUnit: string } => RESOURCE_UNIT.test(owner.resourceUnit ?? ""))
      .map((owner) => ({ workspaceId: owner.workspaceId, unit: owner.resourceUnit }));
  }

  async cancelWorkspace(workspaceId: string, reason: string): Promise<void> {
    await this.withSchedulerLock(async () => {
      for (const owner of await this.readPersistentOwners()) {
        if (owner.workspaceId !== workspaceId) continue;
        if (owner.state === "waiting" || owner.state === "reserved" || owner.state === "reporting") {
          await this.cancelOwner(owner, reason);
        } else if (owner.state === "acquiring" || RUNNING_STATES.has(owner.state)) {
          await writeFile(join(this.leaseRoot, "runs", owner.runId, COMPLETION_SUPPRESSION_FILE), reason, { mode: 0o600 });
          await sendControl(join(this.leaseRoot, "runs", owner.runId, "control.sock"), { action: "cancel", reason }).catch(() => null);
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
    if (command.state === "reporting") return "inactive";
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

      for (const owner of reserved) {
        await this.dispatchOwnerSafely(owner, "resume", () => this.dispatchResume(owner));
      }
      let currentOwners = await this.readPersistentOwners();
      await this.recoverExpiredOwners(currentOwners);
      currentOwners = await this.readPersistentOwners();
      for (const owner of currentOwners) {
        if (owner.state === "reporting" && !owner.completionSentAt) {
          await this.dispatchOwnerSafely(owner, "completion", () => this.dispatchCompletion(owner));
        }
      }
      await this.syncSessionStatuses(currentOwners);
    } finally {
      this.ticking = false;
    }
  }

  private async recoverExpiredOwners(owners: QueueOwner[]): Promise<void> {
    for (const owner of owners) {
      if (!RUNNING_STATES.has(owner.state) || !owner.startedAt || !owner.resourceUnit) continue;
      const startedAt = Date.parse(owner.startedAt);
      if (!Number.isFinite(startedAt) || Date.now() < startedAt + owner.deadlines.runtimeTimeoutMs + owner.deadlines.terminationGraceMs) continue;
      await this.recoverExpiredOwner(owner);
    }
  }

  private async recoverExpiredOwner(owner: QueueOwner): Promise<void> {
    const resourceUnit = owner.resourceUnit;
    if (!resourceUnit) return;
    if (await this.runtime.ownerProcessState(owner) === "inactive") return;
    const reason = `runtime exceeded ${formatElapsed(owner.deadlines.runtimeTimeoutMs)} while the heavyweight worker remained active`;
    const eligible = await this.withSchedulerLock(async () => {
      const current = await this.readQueueOwner(owner.runId);
      if (!current || !RUNNING_STATES.has(current.state) || !current.startedAt || current.resourceUnit !== resourceUnit) return false;
      const startedAt = Date.parse(current.startedAt);
      if (!Number.isFinite(startedAt) || Date.now() < startedAt + current.deadlines.runtimeTimeoutMs + current.deadlines.terminationGraceMs) return false;
      return true;
    });
    if (!eligible) return;
    try {
      await this.runtime.stopResourceUnit(resourceUnit);
    } catch (error) {
      console.error("Muxpilot heavyweight deadline recovery failed", {
        runId: owner.runId,
        workspaceId: owner.workspaceId,
        resourceUnit,
        error
      });
      return;
    }
    await this.withSchedulerLock(async () => {
      const current = await this.readQueueOwner(owner.runId);
      if (!current || current.resourceUnit !== resourceUnit || !RUNNING_STATES.has(current.state)) return;
      const finishedAt = new Date().toISOString();
      const slot = current.slot;
      current.state = "reporting";
      current.slot = null;
      current.exitCode = 124;
      current.signal = null;
      current.finishedAt = finishedAt;
      current.terminationReason = reason;
      current.heartbeatAt = finishedAt;
      await this.writeOwner(current);
      if (slot !== null) await this.releaseMatchingSlot(slot, current.runId);
    });
  }

  private async dispatchOwnerSafely(
    owner: QueueOwner,
    phase: "resume" | "completion",
    dispatch: () => Promise<void>
  ): Promise<void> {
    try {
      await dispatch();
    } catch (error) {
      console.error("Muxpilot heavyweight owner dispatch failed", {
        phase,
        runId: owner.runId,
        workspaceId: owner.workspaceId,
        error
      });
    }
  }

  private async syncSessionStatuses(owners: QueueOwner[]): Promise<void> {
    if (!this.coordinator) return;
    const persisted = owners.filter((owner) => ACTIVE_STATES.has(owner.state));
    const live = (await Promise.all(persisted.map((owner) => this.readOwner(owner.runId, owner.workspaceId))))
      .filter((owner): owner is HeavyCommand => owner !== null && ACTIVE_STATES.has(owner.state));
    const byWorkspace = new Map<string, HeavyCommand[]>();
    for (const owner of live) {
      const commands = byWorkspace.get(owner.workspaceId) ?? [];
      commands.push(owner);
      byWorkspace.set(owner.workspaceId, commands);
    }
    const inactive = [...this.activeStatusWorkspaces].filter((workspaceId) => !byWorkspace.has(workspaceId));
    for (const [workspaceId, commands] of byWorkspace) {
      await this.coordinator.syncHeavyCommandSessionStatus(workspaceId, heavyCommandSessionStatus(commands));
    }
    for (const workspaceId of inactive) {
      await this.coordinator.syncHeavyCommandSessionStatus(workspaceId, null);
    }
    this.activeStatusWorkspaces = new Set(byWorkspace.keys());
  }

  private async dispatchCompletion(owner: QueueOwner): Promise<void> {
    if (!this.coordinator) return;
    const sessionId = await this.coordinator.sessionIdForWorkspace(owner.workspaceId);
    if (!sessionId) {
      await this.cancelWorkspace(owner.workspaceId, "owning session is no longer available");
      return;
    }
    await this.withSchedulerLock(async () => {
      const current = await this.readQueueOwner(owner.runId);
      if (!current || current.state !== "reporting" || current.completionSentAt || !current.logPath || !current.startedAt || !current.finishedAt) return;
      current.heartbeatAt = new Date().toISOString();
      await this.writeOwner(current);
      const exitCode = current.exitCode ?? null;
      const signal = current.signal ?? null;
      const outcome = current.terminationReason || signal ? "terminated" : exitCode === 0 ? "passed" : "failed";
      const durationMs = Math.max(0, Date.parse(current.finishedAt) - Date.parse(current.startedAt));
      let outputTail: string | undefined;
      let outputTruncated: boolean | undefined;
      if (outcome !== "passed") {
        const output = await this.output(current.workspaceId, current.runId);
        if (output) {
          outputTail = utf8Tail(output.output, COMPLETION_TAIL_BYTES);
          outputTruncated = output.truncated || Buffer.byteLength(output.output) > COMPLETION_TAIL_BYTES;
        }
      }
      const message = serializeHeavyCommandQueueEvent({
        version: 1,
        kind: "run_completed",
        runId: current.runId,
        commandDisplay: current.commandDisplay,
        skill: "$muxpilot-heavy-command-queue",
        outcome,
        exitCode,
        signal,
        durationMs,
        logPath: current.logPath,
        ...(outputTail === undefined ? {} : { outputTail }),
        ...(outputTruncated === undefined ? {} : { outputTruncated })
      });
      if (!await this.coordinator!.resumeHeavyCommand(sessionId, message)) return;
      const sentAt = new Date().toISOString();
      current.state = "completed";
      current.completionSentAt = sentAt;
      current.heartbeatAt = sentAt;
      await this.writeOwner(current);
    });
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
    if ((owner.version === 2 || owner.version === 3) && typeof owner.runId === "string" && typeof owner.controlSocket === "string") {
      const runOwner = await this.readQueueOwner(owner.runId);
      if (!runOwner) {
        await rm(path, { recursive: true, force: true });
        return false;
      }
      const processState = await this.runtime.ownerProcessState(runOwner);
      if (processState === "active") return true;
      if (processState === "inactive") {
        await rm(path, { recursive: true, force: true });
        return false;
      }
      const response = await sendControl(owner.controlSocket, { action: "probe" }).catch(() => null);
      if (response?.ok && response.runId === owner.runId) return true;
      if (response) {
        await rm(path, { recursive: true, force: true });
        return false;
      }
      const heartbeat = typeof owner.heartbeatAt === "number" ? owner.heartbeatAt : Date.parse(String(owner.heartbeatAt));
      if (Number.isFinite(heartbeat) && Date.now() - heartbeat < SLOT_OWNER_STALE_MS) return true;
      await rm(path, { recursive: true, force: true });
      return false;
    }
    const heartbeat = typeof owner.heartbeatAt === "number" ? owner.heartbeatAt : Date.parse(String(owner.heartbeatAt));
    if (Number.isFinite(heartbeat) && Date.now() - heartbeat < 12 * 60 * 60 * 1000) return true;
    await rm(path, { recursive: true, force: true });
    return false;
  }

  private async releaseMatchingSlot(slot: number, runId: string): Promise<void> {
    const path = join(this.leaseRoot, `slot-${slot}`);
    const current = await readFile(join(path, "owner.json"), "utf8").then(JSON.parse).catch(() => null) as Record<string, unknown> | null;
    if (current?.runId === runId) await rm(path, { recursive: true, force: true });
  }

  private async cancelOwner(owner: QueueOwner, reason: string): Promise<void> {
    owner.state = "cancelled";
    owner.terminationReason = reason;
    owner.heartbeatAt = new Date().toISOString();
    await this.writeOwner(owner);
    if (owner.slot !== null) await this.releaseMatchingSlot(owner.slot, owner.runId);
  }

  private async readQueueOwners(): Promise<QueueOwner[]> {
    return (await this.readPersistentOwners()).filter((owner) => owner.state === "waiting" || owner.state === "reserved");
  }

  private async readPersistentOwners(): Promise<QueueOwner[]> {
    const owners: QueueOwner[] = [];
    for (const runId of await readdir(join(this.leaseRoot, "runs")).catch(() => [])) {
      const owner = await this.readQueueOwner(runId);
      if (owner) owners.push(owner);
    }
    return owners;
  }

  private async runningOwners(): Promise<HeavyCommand[]> {
    const owners = await this.readPersistentOwners();
    const liveOwners = await Promise.all(owners.map((owner) => this.readOwner(owner.runId, owner.workspaceId)));
    return liveOwners.filter((owner): owner is HeavyCommand => owner !== null && RUNNING_STATES.has(owner.state));
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
      const recordedState = owner.state;
      if (typeof owner.cwd !== "string" || typeof owner.commandDisplay !== "string" || typeof owner.queuedAt !== "string" || typeof owner.heartbeatAt !== "string") return null;
      const heartbeatAt = Date.parse(owner.heartbeatAt);
      if (!Number.isFinite(heartbeatAt) || !Number.isFinite(Date.parse(owner.queuedAt))) return null;
      if (owner.startedAt !== null && typeof owner.startedAt !== "string") return null;
      if (owner.lastOutputAt !== null && typeof owner.lastOutputAt !== "string") return null;
      if (Number(owner.version) >= 3 && ((owner.lastActivityAt !== null && typeof owner.lastActivityAt !== "string") || !validActivity(owner.activity))) return null;
      if (owner.logPath !== null && typeof owner.logPath !== "string") return null;
      if (owner.childPid !== null && (!Number.isInteger(owner.childPid) || Number(owner.childPid) <= 0)) return null;
      if (owner.wrapperPid !== undefined && owner.wrapperPid !== null && (!Number.isInteger(owner.wrapperPid) || Number(owner.wrapperPid) <= 0)) return null;
      if (owner.slot !== null && (!Number.isInteger(owner.slot) || Number(owner.slot) < 0)) return null;
      if (!validDeadlines(owner.deadlines) || (owner.packageDiagnostics !== null && !validPackageDiagnostics(owner.packageDiagnostics))) return null;
      if (owner.terminationReason !== null && typeof owner.terminationReason !== "string") return null;
      if (owner.resourceUnit !== null && owner.resourceUnit !== undefined && !RESOURCE_UNIT.test(String(owner.resourceUnit))) return null;
      if (ACTIVE_STATES.has(String(owner.state)) && Date.now() - heartbeatAt > ACTIVE_OWNER_STALE_MS) {
        const liveState = await this.liveStaleOwnerState(runPath, owner as unknown as QueueOwner);
        if (!liveState) return null;
        owner.state = liveState;
      }
      if (recordedState === "reporting") {
        if (!Number.isInteger(owner.exitCode) && owner.exitCode !== null) return null;
        if (owner.signal !== null && typeof owner.signal !== "string") return null;
        if (typeof owner.finishedAt !== "string" || !Number.isFinite(Date.parse(owner.finishedAt))) return null;
      }
      return owner as unknown as HeavyCommand;
    } catch {
      return null;
    }
  }

  private async liveStaleOwnerState(runPath: string, owner: QueueOwner): Promise<HeavyCommand["state"] | null> {
    const processState = await this.runtime.ownerProcessState(owner);
    if (processState === "active") return staleLiveState(owner.state);
    if (processState === "inactive") return null;
    if (typeof owner.controlSocket !== "string") return ownerWithinRuntimeGrace(owner) ? staleLiveState(owner.state) : null;
    const socketPath = resolve(owner.controlSocket);
    if (socketPath !== resolve(runPath, "control.sock")) return null;
    const details = await lstat(socketPath).catch(() => null);
    if (!details) return ownerWithinRuntimeGrace(owner) ? staleLiveState(owner.state) : null;
    if (!details.isSocket() || details.isSymbolicLink()) return null;
    const response = await sendControl(socketPath, { action: "probe" }).catch(() => null);
    if (!response) return ownerWithinRuntimeGrace(owner) ? staleLiveState(owner.state) : null;
    if (!response.ok || response.runId !== owner.runId || !ACTIVE_STATES.has(response.state ?? "")) return null;
    return response.state as HeavyCommand["state"];
  }
}

export type HeavyCommandSessionStatus = "queued" | "running" | "working" | null;

export function heavyCommandSessionStatus(commands: readonly Pick<HeavyCommand, "state">[]): HeavyCommandSessionStatus {
  if (commands.some((command) => RUNNING_STATES.has(command.state))) return "running";
  if (commands.some((command) => TRANSITION_STATES.has(command.state))) return "working";
  if (commands.some((command) => command.state === "waiting")) return "queued";
  return null;
}

interface QueueOwner extends Omit<HeavyCommand, "state"> {
  version: 4;
  state: HeavyCommand["state"] | "acquiring" | "cancelled" | "completed";
  runnerPath: string;
  runnerOptions: string[];
  wrapperPid?: number | null;
  controlSocket?: string | null;
  completionSentAt?: string | null;
}

class HostHeavyCommandRuntime implements HeavyCommandRuntime {
  constructor(private readonly launchBroker: HeavyCommandLaunchBrokerOptions | null) {}

  async ownerProcessState(owner: { wrapperPid?: number | null; resourceUnit?: string | null }): Promise<OwnerProcessState> {
    if (!owner.wrapperPid || !owner.resourceUnit || !RESOURCE_UNIT.test(owner.resourceUnit)) return "unknown";
    try {
      const cgroup = await readFile(`/proc/${owner.wrapperPid}/cgroup`, "utf8");
      return cgroup.split(/\r?\n/).some((line) => line.endsWith(`/${owner.resourceUnit}`)) ? "active" : "inactive";
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? "inactive" : "unknown";
    }
  }

  async stopResourceUnit(resourceUnit: string): Promise<void> {
    if (!this.launchBroker?.enabled || !RESOURCE_UNIT.test(resourceUnit)) throw new Error("managed heavyweight resource control is unavailable");
    if (this.launchBroker.runCommand) {
      await this.launchBroker.runCommand("systemctl", ["--user", "stop", resourceUnit]);
      return;
    }
    await execFileAsync("systemctl", ["--user", "stop", resourceUnit], {
      timeout: 5_000,
      env: { ...process.env, ...this.launchBroker.environment }
    });
  }
}

function staleLiveState(state: QueueOwner["state"]): HeavyCommand["state"] {
  return state === "running" ? "stalled" : state as HeavyCommand["state"];
}

function ownerWithinRuntimeGrace(owner: QueueOwner): boolean {
  if (!owner.startedAt) return false;
  const startedAt = Date.parse(owner.startedAt);
  return Number.isFinite(startedAt) && Date.now() < startedAt + owner.deadlines.runtimeTimeoutMs + owner.deadlines.terminationGraceMs;
}

function formatElapsed(milliseconds: number): string {
  if (milliseconds % 60_000 === 0) return `${milliseconds / 60_000}m`;
  if (milliseconds % 1_000 === 0) return `${milliseconds / 1_000}s`;
  return `${milliseconds}ms`;
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

function sendControl(path: string, payload: object): Promise<{ ok?: boolean; accepted?: boolean; runId?: string; state?: string }> {
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

function utf8Tail(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value);
  if (buffer.length <= maxBytes) return value;
  let start = buffer.length - maxBytes;
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start).toString("utf8");
}

function safeToken(candidate: string, expected: string): boolean {
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}
