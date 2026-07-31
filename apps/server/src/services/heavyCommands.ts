import type { HeavyCommand, HeavyCommandOutputResponse, HeavyCommandsResponse } from "@muxpilot/core";
import { createConnection } from "node:net";
import { lstat, open, readFile, readdir, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

const ACTIVE_STATES = new Set(["waiting", "running", "stalled", "terminating"]);
const RUN_ID = /^[a-z0-9]+-[a-f0-9]{12}$/;
const MAX_OWNER_BYTES = 256 * 1024;
const MAX_TAIL_BYTES = 128 * 1024;

export class HeavyCommandService {
  constructor(
    private readonly leaseRoot: string,
    private readonly sessionRoot: string
  ) {}

  async list(workspaceId: string): Promise<HeavyCommandsResponse> {
    const commands: HeavyCommand[] = [];
    for (const runId of await readdir(join(this.leaseRoot, "runs")).catch(() => [])) {
      if (!RUN_ID.test(runId)) continue;
      const command = await this.readOwner(runId, workspaceId);
      if (command && ACTIVE_STATES.has(command.state)) commands.push(command);
    }
    commands.sort((left, right) => left.queuedAt.localeCompare(right.queuedAt));
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
    const socketPath = join(this.leaseRoot, "runs", runId, "control.sock");
    const response = await sendControl(socketPath, { action: "terminate" }).catch(() => null);
    if (!response?.ok) return "inactive";
    return response.accepted ? "accepted" : "inactive";
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
      if (owner.version !== 2 || owner.runId !== runId || owner.workspaceId !== workspaceId) return null;
      if (typeof owner.state !== "string" || !Array.isArray(owner.command) || !owner.command.every((part) => typeof part === "string")) return null;
      if (typeof owner.cwd !== "string" || typeof owner.commandDisplay !== "string" || typeof owner.queuedAt !== "string" || typeof owner.heartbeatAt !== "string") return null;
      const heartbeatAt = Date.parse(owner.heartbeatAt);
      if (!Number.isFinite(heartbeatAt) || !Number.isFinite(Date.parse(owner.queuedAt))) return null;
      if (ACTIVE_STATES.has(owner.state) && Date.now() - heartbeatAt > 60_000) return null;
      if (owner.startedAt !== null && typeof owner.startedAt !== "string") return null;
      if (owner.lastOutputAt !== null && typeof owner.lastOutputAt !== "string") return null;
      if (owner.logPath !== null && typeof owner.logPath !== "string") return null;
      if (owner.childPid !== null && (!Number.isInteger(owner.childPid) || Number(owner.childPid) <= 0)) return null;
      if (owner.slot !== null && (!Number.isInteger(owner.slot) || Number(owner.slot) < 0)) return null;
      if (!validDeadlines(owner.deadlines)) return null;
      if (owner.packageDiagnostics !== null && !validPackageDiagnostics(owner.packageDiagnostics)) return null;
      if (owner.terminationReason !== null && typeof owner.terminationReason !== "string") return null;
      return owner as unknown as HeavyCommand;
    } catch {
      return null;
    }
  }
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

function inside(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}
