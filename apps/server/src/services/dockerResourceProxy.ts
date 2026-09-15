import { request as httpRequest, createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createConnection } from "node:net";
import { chmod, mkdir, readFile, rm, stat } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { Duplex } from "node:stream";

const CREATE_PATH = /\/containers\/create(?:\?|$)/;
const UPDATE_PATH = /\/containers\/([^/]+)\/update(?:\?|$)/;
const ACTION_PATH = /\/containers\/([^/]+)\/(start|stop|kill|restart|delete)(?:\?|$)/;
const ATTACH_PATH = /\/containers\/[^/]+\/attach(?:\/ws)?(?:\?|$)/;
const DELETE_PATH = /\/containers\/([^/?]+)(?:\?|$)/;
const MAX_MUTATED_BODY_BYTES = 16 * 1024 * 1024;
const HEAVY_RUN_ID = /^[a-z0-9]+-[a-f0-9]{12}$/;
const WORKSPACE_ID = /^[A-Za-z0-9_-]{6,128}$/;

export interface DockerResourceProxyConfig {
  socketPath: string;
  daemonSocketPath?: string;
  memorySoftPercent: number;
  memoryHardPercent: number;
  cpuPercent: number;
  pidsLimit?: number;
  lifecycleStartTimeoutMs?: number;
  reconciliationIntervalMs?: number;
  heavyValidationDir?: string;
  orphanReapIntervalMs?: number;
  orphanGraceMs?: number;
}

interface ManagedContainer {
  id: string;
  running: boolean;
  requested: DockerLimits;
  aliases: Set<string>;
}

interface DockerLimits {
  MemoryReservation?: number;
  Memory?: number;
  MemorySwap?: number;
  NanoCpus?: number;
  PidsLimit?: number;
}

interface DockerBindMount {
  Type?: string;
  Source?: string;
  Target?: string;
  ReadOnly?: boolean;
}

interface DockerCreatePayload {
  Labels?: Record<string, string>;
  HostConfig?: DockerLimits & Record<string, unknown> & { Binds?: string[] };
  Mounts?: DockerBindMount[];
}

interface Logger {
  info(values: object, message: string): void;
  warn(values: object, message: string): void;
}

export class DockerResourceProxy {
  private readonly daemonSocketPath: string;
  private readonly containers = new Map<string, ManagedContainer>();
  private readonly orphanFirstSeen = new Map<string, number>();
  private accountingQueue: Promise<void> = Promise.resolve();
  private reconciliationTimer: NodeJS.Timeout | null = null;
  private orphanTimer: NodeJS.Timeout | null = null;
  private server = createServer((request, response) => void this.handle(request, response));

  constructor(private readonly config: DockerResourceProxyConfig, private readonly logger: Logger) {
    this.daemonSocketPath = config.daemonSocketPath ?? "/var/run/docker.sock";
    this.server.on("upgrade", (request, socket, head) => this.handleUpgrade(request, socket, head));
  }

  async start(): Promise<void> {
    await mkdir(dirname(this.config.socketPath), { recursive: true });
    await rm(this.config.socketPath, { force: true });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.server.once("error", onError);
      this.server.listen(this.config.socketPath, () => {
        this.server.off("error", onError);
        resolve();
      });
    });
    await chmod(this.config.socketPath, 0o600);
    this.reconciliationTimer = setInterval(
      () => void this.serializeAccounting(() => this.reconcileAndRebalance()).catch((error) => {
        this.logger.warn({ err: error }, "Docker container accounting reconciliation failed");
      }),
      this.config.reconciliationIntervalMs ?? 15_000
    );
    if (this.config.heavyValidationDir) {
      const reap = () => void this.serializeAccounting(() => this.reapOrphans()).catch((error) => {
        this.logger.warn({ err: error }, "Docker heavyweight orphan reaper failed");
      });
      this.orphanTimer = setInterval(reap, this.config.orphanReapIntervalMs ?? 15_000);
      reap();
    }
    this.logger.info({ socketPath: this.config.socketPath }, "Docker resource proxy started");
  }

  async close(): Promise<void> {
    if (this.reconciliationTimer) clearInterval(this.reconciliationTimer);
    if (this.orphanTimer) clearInterval(this.orphanTimer);
    const closed = new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.server.closeAllConnections();
    await closed;
    await this.accountingQueue.catch(() => undefined);
    await rm(this.config.socketPath, { force: true });
  }

  dockerHost(): string {
    return `unix://${this.config.socketPath}`;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method === "POST" && CREATE_PATH.test(request.url ?? "")) {
        await this.serializeAccounting(() => this.handleCreate(request, response));
        return;
      }
      if (request.method === "POST" && UPDATE_PATH.test(request.url ?? "")) {
        await this.serializeAccounting(() => this.handleUpdate(request, response));
        return;
      }
      const lifecycle = request.method === "POST" ? (request.url ?? "").match(ACTION_PATH) : null;
      const deleted = request.method === "DELETE" ? (request.url ?? "").match(DELETE_PATH) : null;
      if (lifecycle || deleted) {
        await this.serializeAccounting(() => this.handleLifecycle(request, response, lifecycle, deleted));
      } else {
        const attachTimeoutMs = ATTACH_PATH.test(request.url ?? "")
          ? this.config.lifecycleStartTimeoutMs ?? 60_000
          : undefined;
        await forwardStreaming(
          this.daemonSocketPath,
          request,
          response,
          () => undefined,
          attachTimeoutMs
        );
      }
    } catch (error) {
      this.logger.warn({ err: error }, "Docker proxy request failed");
      const timedOut = error instanceof DockerLifecycleTimeout;
      if (!response.headersSent) response.writeHead(timedOut ? 504 : 502, { "content-type": "application/json" });
      response.end(JSON.stringify({
        message: timedOut ? error.message : `muxpilot Docker guard could not reach ${this.daemonSocketPath}`
      }));
    }
  }

  private async handleCreate(request: IncomingMessage, response: ServerResponse): Promise<void> {
    await this.reconcile();
    const body = await readBody(request);
    const payload = JSON.parse(body.toString("utf8")) as DockerCreatePayload;
    const heavyRun = headerValue(request, "x-muxpilot-heavy-run");
    const workspace = headerValue(request, "x-muxpilot-workspace");
    const validHeavyRun = Boolean(heavyRun && HEAVY_RUN_ID.test(heavyRun));
    payload.Labels = {
      ...payload.Labels,
      "com.muxpilot.managed": "true",
      "com.muxpilot.resource-pool": "shared",
      ...(validHeavyRun ? { "com.muxpilot.heavy-run": heavyRun! } : {}),
      ...(workspace && WORKSPACE_ID.test(workspace) ? { "com.muxpilot.workspace": workspace } : {})
    };
    const hostConfig = payload.HostConfig ?? {};
    const gitBinds = validHeavyRun ? await linkedWorktreeGitBinds(hostConfig.Binds, payload.Mounts) : [];
    const requested = pickLimits(hostConfig);
    payload.HostConfig = {
      ...hostConfig,
      ...(gitBinds.length > 0 ? { Binds: [...(hostConfig.Binds ?? []), ...gitBinds] } : {}),
      ...effectiveLimits(requested, this.poolLimits(this.runningCount() + 1))
    };
    const encoded = Buffer.from(JSON.stringify(payload));
    const forwarded = await forwardRequest(this.daemonSocketPath, request, encoded);
    response.writeHead(forwarded.statusCode, forwarded.headers);
    response.end(forwarded.body);
    if (forwarded.statusCode >= 200 && forwarded.statusCode < 300) {
      const result = JSON.parse(forwarded.body.toString("utf8")) as { Id?: string };
      if (result.Id) this.containers.set(result.Id, {
        id: result.Id, running: false, requested, aliases: new Set([result.Id])
      });
    }
  }

  private async handleLifecycle(
    request: IncomingMessage,
    response: ServerResponse,
    action: RegExpMatchArray | null,
    deleted: RegExpMatchArray | null
  ): Promise<void> {
    await this.reconcile();
    const target = action?.[1] ?? deleted?.[1];
    const managed = target ? this.findContainer(target) : undefined;
    const operation = action?.[2];
    if (managed && (operation === "start" || operation === "restart") && !managed.running) {
      await this.rebalance(managed.id);
    }
    const timeoutMs = operation === "start" ? this.config.lifecycleStartTimeoutMs ?? 60_000 : undefined;
    const startedAt = Date.now();
    const forwarded = await forwardRequest(this.daemonSocketPath, request, undefined, timeoutMs);
    try {
      if (forwarded.statusCode < 300 && operation === "start" && target) {
        await this.waitForStarted(target, Math.max(1, (timeoutMs ?? 60_000) - (Date.now() - startedAt)));
      }
    } catch (error) {
      await this.reconcileAndRebalance();
      throw error;
    }
    if ((forwarded.statusCode < 300 || (deleted && forwarded.statusCode === 404)) && managed && deleted) {
      this.containers.delete(managed.id);
    }
    if (forwarded.statusCode < 300 || forwarded.statusCode === 404) await this.reconcileAndRebalance();
    else if (managed && (operation === "start" || operation === "restart")) await this.rebalance();
    response.writeHead(forwarded.statusCode, forwarded.headers);
    response.end(forwarded.body);
  }

  private async handleUpdate(request: IncomingMessage, response: ServerResponse): Promise<void> {
    await this.reconcile();
    const id = (request.url ?? "").match(UPDATE_PATH)?.[1];
    const managed = id ? this.findContainer(id) : null;
    if (!managed) {
      await forwardStreaming(this.daemonSocketPath, request, response, () => undefined);
      return;
    }
    const body = await readBody(request);
    const payload = JSON.parse(body.toString("utf8")) as DockerLimits & Record<string, unknown>;
    const requested = { ...managed.requested, ...pickLimits(payload) };
    const running = Math.max(1, this.runningCount());
    const guarded = {
      ...payload,
      ...effectiveLimits(requested, this.poolLimits(running))
    };
    const forwarded = await forwardRequest(this.daemonSocketPath, request, Buffer.from(JSON.stringify(guarded)));
    response.writeHead(forwarded.statusCode, forwarded.headers);
    response.end(forwarded.body);
    if (forwarded.statusCode < 300) managed.requested = requested;
  }

  private async rebalance(includeId?: string, allowMissingRetry = true): Promise<void> {
    const running = [...this.containers.values()].filter((container) => container.running);
    const includesStoppedContainer = Boolean(includeId && this.containers.get(includeId)?.running === false);
    const pool = this.poolLimits(Math.max(1, running.length + (includesStoppedContainer ? 1 : 0)));
    for (const container of running) {
      const result = await this.updateContainer(container.id, effectiveLimits(container.requested, pool));
      if (result === "missing") {
        if (!allowMissingRetry) throw new Error(`Docker container ${container.id} remained missing during resource rebalance`);
        await this.reconcile();
        return this.rebalance(includeId && this.containers.has(includeId) ? includeId : undefined, false);
      }
    }
  }

  private async updateContainer(id: string, limits: DockerLimits): Promise<"updated" | "missing"> {
    const response = await rawDockerRequest(
      this.daemonSocketPath,
      "POST",
      `/containers/${encodeURIComponent(id)}/update`,
      Buffer.from(JSON.stringify(limits)),
      { "content-type": "application/json" },
      5_000
    );
    if (response.statusCode === 404) return "missing";
    if (response.statusCode >= 300) {
      const detail = response.body.toString("utf8").trim().slice(0, 512);
      throw new Error(`Docker rejected resource rebalance for ${id} with HTTP ${response.statusCode}${detail ? `: ${detail}` : ""}`);
    }
    return "updated";
  }

  private serializeAccounting<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.accountingQueue.then(operation, operation);
    this.accountingQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private findContainer(target: string): ManagedContainer | undefined {
    const exact = [...this.containers.values()].find((container) => container.aliases.has(target));
    if (exact) return exact;
    const partial = [...this.containers.values()].filter((container) => container.id.startsWith(target));
    return partial.length === 1 ? partial[0] : undefined;
  }

  private async reconcileAndRebalance(): Promise<void> {
    const changed = await this.reconcile();
    if (changed) await this.rebalance();
  }

  private async reconcile(): Promise<boolean> {
    const filters = encodeURIComponent(JSON.stringify({ label: ["com.muxpilot.managed=true"] }));
    const response = await rawDockerRequest(
      this.daemonSocketPath, "GET", `/containers/json?all=1&filters=${filters}`, Buffer.alloc(0), {}, 5_000
    );
    if (response.statusCode >= 300) throw new Error(`Docker container reconciliation failed with HTTP ${response.statusCode}`);
    const listed: unknown = JSON.parse(response.body.toString("utf8"));
    if (!Array.isArray(listed)) throw new Error("Docker container reconciliation returned a malformed listing");
    const next = new Map<string, ManagedContainer>();
    for (const value of listed) {
      if (!value || typeof value !== "object") throw new Error("Docker container reconciliation returned a malformed entry");
      const item = value as { Id?: unknown; Names?: unknown; State?: unknown };
      if (typeof item.Id !== "string" || typeof item.State !== "string") {
        throw new Error("Docker container reconciliation returned a malformed entry");
      }
      const existing = this.containers.get(item.Id);
      let requested = existing?.requested;
      if (!requested) {
        const inspected = await rawDockerRequest(
          this.daemonSocketPath, "GET", `/containers/${encodeURIComponent(item.Id)}/json`, Buffer.alloc(0), {}, 5_000
        );
        if (inspected.statusCode >= 300) throw new Error(`Docker container inspection failed for ${item.Id} with HTTP ${inspected.statusCode}`);
        const detail = JSON.parse(inspected.body.toString("utf8")) as { HostConfig?: DockerLimits };
        if (!detail || typeof detail !== "object" || !detail.HostConfig || typeof detail.HostConfig !== "object") {
          throw new Error(`Docker container inspection returned malformed limits for ${item.Id}`);
        }
        requested = pickLimits(detail.HostConfig);
      }
      const aliases = new Set<string>([item.Id]);
      if (Array.isArray(item.Names)) {
        for (const name of item.Names) if (typeof name === "string") aliases.add(name.replace(/^\//, ""));
      }
      next.set(item.Id, {
        id: item.Id,
        running: ["running", "paused", "restarting"].includes(item.State),
        requested,
        aliases
      });
    }
    const before = [...this.containers.values()].map(({ id, running }) => `${id}:${running}`).sort().join("|");
    const after = [...next.values()].map(({ id, running }) => `${id}:${running}`).sort().join("|");
    this.containers.clear();
    for (const [id, container] of next) this.containers.set(id, container);
    return before !== after;
  }

  private runningCount(): number {
    return [...this.containers.values()].filter((container) => container.running).length;
  }

  private poolLimits(divisor: number): DockerLimits {
    const soft = totalmem() * this.config.memorySoftPercent / 100 / divisor;
    const hard = totalmem() * this.config.memoryHardPercent / 100 / divisor;
    const cpuNano = cpus().length * this.config.cpuPercent / 100 * 1_000_000_000 / divisor;
    return {
      MemoryReservation: Math.floor(soft),
      Memory: Math.floor(hard),
      MemorySwap: Math.floor(hard * 2),
      NanoCpus: Math.floor(cpuNano),
      PidsLimit: this.config.pidsLimit ?? 512
    };
  }

  private async reapOrphans(): Promise<void> {
    const filters = encodeURIComponent(JSON.stringify({ label: ["com.muxpilot.managed=true", "com.muxpilot.heavy-run"] }));
    const response = await rawDockerRequest(this.daemonSocketPath, "GET", `/containers/json?all=1&filters=${filters}`, Buffer.alloc(0), {}, 5_000);
    if (response.statusCode >= 300) throw new Error(`Docker orphan listing failed with HTTP ${response.statusCode}`);
    const containers = JSON.parse(response.body.toString("utf8")) as Array<{ Id?: string; Labels?: Record<string, string>; State?: string }>;
    const present = new Set<string>();
    let removedContainer = false;
    for (const container of containers) {
      const id = container.Id;
      const runId = container.Labels?.["com.muxpilot.heavy-run"];
      if (!id || !runId || !HEAVY_RUN_ID.test(runId)) continue;
      present.add(id);
      const abnormal = await this.abnormallyEnded(runId);
      if (!abnormal) { this.orphanFirstSeen.delete(id); continue; }
      const firstSeen = this.orphanFirstSeen.get(id) ?? Date.now();
      this.orphanFirstSeen.set(id, firstSeen);
      if (Date.now() - firstSeen < (this.config.orphanGraceMs ?? 60_000)) continue;
      const removed = await rawDockerRequest(this.daemonSocketPath, "DELETE", `/containers/${encodeURIComponent(id)}?force=true`, Buffer.alloc(0), {}, 5_000);
      if (removed.statusCode < 300 || removed.statusCode === 404) {
        this.orphanFirstSeen.delete(id);
        this.containers.delete(id);
        removedContainer = true;
        this.logger.info({ containerId: id, runId }, "Removed orphaned heavyweight container");
      }
    }
    for (const id of this.orphanFirstSeen.keys()) if (!present.has(id)) this.orphanFirstSeen.delete(id);
    if (removedContainer) await this.reconcileAndRebalance();
  }

  private async abnormallyEnded(runId: string): Promise<boolean> {
    const root = this.config.heavyValidationDir;
    if (!root) return false;
    try {
      const owner = JSON.parse(await readFile(`${root}/runs/${runId}/owner.json`, "utf8")) as Record<string, unknown>;
      if (owner.state === "completed" && !owner.terminationReason && (owner.exitCode === 0 || owner.exitCode === undefined)) return false;
      if (["waiting", "running", "stalled", "terminating"].includes(String(owner.state))) {
        const heartbeat = Date.parse(String(owner.heartbeatAt));
        if (!Number.isFinite(heartbeat) || Date.now() - heartbeat > 60_000) return true;
        return !await probeControlSocket(`${root}/runs/${runId}/control.sock`);
      }
      return true;
    } catch {
      return true;
    }
  }

  private async waitForStarted(id: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      try {
        const inspected = await rawDockerRequest(
          this.daemonSocketPath, "GET", `/containers/${encodeURIComponent(id)}/json`, Buffer.alloc(0), {}, Math.min(1_000, remaining)
        );
        if (inspected.statusCode === 404) return;
        if (inspected.statusCode < 300) {
          const container = JSON.parse(inspected.body.toString("utf8")) as { State?: { Status?: string } };
          if (container.State?.Status && container.State.Status !== "created") return;
        }
      } catch {
        // Retry bounded inspection until the lifecycle deadline expires.
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(100, Math.max(1, deadline - Date.now()))));
    }
    throw new DockerLifecycleTimeout(timeoutMs);
  }

  private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    let timedOut = false;
    const upstream = httpRequest({
      socketPath: this.daemonSocketPath,
      method: request.method,
      path: request.url,
      headers: request.headers
    }, (response) => {
      clearTimeout(timer);
      socket.write(
        `HTTP/${response.httpVersion} ${response.statusCode} ${response.statusMessage}\r\n` +
        Object.entries(response.headers).map(([key, value]) => `${key}: ${value}\r\n`).join("") +
        "\r\n"
      );
      response.pipe(socket);
    });
    const timer = ATTACH_PATH.test(request.url ?? "") ? setTimeout(() => {
      timedOut = true;
      this.logger.warn({ url: request.url }, "Docker attach handshake timed out");
      upstream.destroy();
      socket.end(
        "HTTP/1.1 504 Gateway Timeout\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n" +
        JSON.stringify({ message: `muxpilot Docker guard timed out waiting ${Math.ceil((this.config.lifecycleStartTimeoutMs ?? 60_000) / 1_000)}s for the container attach handshake` })
      );
    }, this.config.lifecycleStartTimeoutMs ?? 60_000) : undefined;
    upstream.on("upgrade", (response, upstreamSocket, upstreamHead) => {
      clearTimeout(timer);
      socket.write(
        `HTTP/${response.httpVersion} ${response.statusCode} ${response.statusMessage}\r\n` +
        Object.entries(response.headers).map(([key, value]) => `${key}: ${value}\r\n`).join("") +
        "\r\n"
      );
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) upstreamSocket.write(head);
      upstreamSocket.pipe(socket).pipe(upstreamSocket);
    });
    upstream.on("error", () => { clearTimeout(timer); if (!timedOut) socket.destroy(); });
    upstream.end();
  }
}

function probeControlSocket(path: string): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const socket = createConnection(path);
    let settled = false;
    const finish = (alive: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveProbe(alive);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once("connect", () => socket.write(`${JSON.stringify({ action: "probe" })}\n`));
    socket.on("data", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function headerValue(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  return typeof value === "string" ? value : Array.isArray(value) ? value[0] ?? null : null;
}

function effectiveLimits(requested: DockerLimits, allowance: DockerLimits): DockerLimits {
  const limits = Object.fromEntries(Object.entries(allowance).map(([key, limit]) => {
    const caller = requested[key as keyof DockerLimits];
    return [key, typeof caller === "number" && caller > 0 ? Math.min(caller, limit) : limit];
  })) as DockerLimits;
  if (limits.Memory && limits.MemoryReservation && limits.MemoryReservation > limits.Memory) {
    limits.MemoryReservation = limits.Memory;
  }
  return limits;
}

function pickLimits(hostConfig: DockerLimits): DockerLimits {
  return Object.fromEntries(
    ["MemoryReservation", "Memory", "MemorySwap", "NanoCpus", "PidsLimit"]
      .filter((key) => typeof hostConfig[key as keyof DockerLimits] === "number")
      .map((key) => [key, hostConfig[key as keyof DockerLimits]])
  );
}

async function linkedWorktreeGitBinds(binds: string[] | undefined, mounts: DockerBindMount[] | undefined): Promise<string[]> {
  const sources = new Set<string>();
  const targets = new Set<string>();
  for (const bind of Array.isArray(binds) ? binds : []) {
    const parsed = parseBind(bind);
    if (!parsed) continue;
    sources.add(parsed.source);
    targets.add(parsed.target);
  }
  for (const mount of Array.isArray(mounts) ? mounts : []) {
    if (mount.Type !== "bind" || !mount.Source || !mount.Target) continue;
    sources.add(mount.Source);
    targets.add(mount.Target);
  }

  const additions: string[] = [];
  for (const source of sources) {
    const commonDir = await linkedWorktreeCommonDir(source);
    if (!commonDir || targets.has(commonDir)) continue;
    targets.add(commonDir);
    additions.push(`${commonDir}:${commonDir}:ro`);
  }
  return additions;
}

function parseBind(bind: string): { source: string; target: string } | null {
  const separator = bind.indexOf(":");
  if (separator < 1) return null;
  const nextSeparator = bind.indexOf(":", separator + 1);
  const source = bind.slice(0, separator);
  const target = bind.slice(separator + 1, nextSeparator < 0 ? undefined : nextSeparator);
  return source.startsWith("/") && target.startsWith("/") ? { source, target } : null;
}

async function linkedWorktreeCommonDir(source: string): Promise<string | null> {
  try {
    const pointer = (await readFile(join(source, ".git"), "utf8")).trim();
    if (!pointer.startsWith("gitdir:")) return null;
    const pointerPath = pointer.slice("gitdir:".length).trim();
    if (!pointerPath) return null;
    const gitDir = resolve(source, pointerPath);
    const commonPointer = (await readFile(join(gitDir, "commondir"), "utf8")).trim();
    if (!commonPointer) return null;
    const commonDir = resolve(gitDir, commonPointer);
    const worktreeRoot = `${join(commonDir, "worktrees")}${sep}`;
    if (!gitDir.startsWith(worktreeRoot) || !(await stat(commonDir)).isDirectory()) return null;
    return commonDir;
  } catch {
    return null;
  }
}

async function forwardRequest(socketPath: string, incoming: IncomingMessage, replacementBody?: Buffer, timeoutMs?: number) {
  const body = replacementBody ?? await readBody(incoming);
  const headers = { ...incoming.headers, "content-length": String(body.length) };
  delete headers["transfer-encoding"];
  return rawDockerRequest(socketPath, incoming.method ?? "GET", incoming.url ?? "/", body, headers, timeoutMs);
}

async function forwardStreaming(
  socketPath: string,
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  onSuccess: () => void,
  timeoutMs?: number
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout | null = null;
    const upstream = httpRequest({
      socketPath,
      method: incoming.method,
      path: incoming.url,
      headers: incoming.headers
    }, (response) => {
      if (timer) clearTimeout(timer);
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      outgoing.flushHeaders();
      response.pipe(outgoing);
      response.on("end", () => {
        if ((response.statusCode ?? 500) < 300) onSuccess();
        resolve();
      });
    });
    upstream.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    if (timeoutMs) timer = setTimeout(() => upstream.destroy(
      new DockerLifecycleTimeout(timeoutMs, "container attach handshake")
    ), timeoutMs);
    incoming.pipe(upstream);
  });
}

class DockerLifecycleTimeout extends Error {
  constructor(timeoutMs: number, operation = "container start operation") {
    super(`muxpilot Docker guard timed out waiting ${Math.ceil(timeoutMs / 1_000)}s for the ${operation}`);
  }
}

async function rawDockerRequest(
  socketPath: string,
  method: string,
  path: string,
  body: Buffer,
  headers: Record<string, string | string[] | undefined> = {},
  timeoutMs?: number
): Promise<{ statusCode: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | null = null;
    const request = httpRequest({ socketPath, method, path, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        if (timer) clearTimeout(timer);
        resolve({ statusCode: response.statusCode ?? 502, headers: response.headers, body: Buffer.concat(chunks) });
      });
    });
    request.on("error", (error) => { if (timer) clearTimeout(timer); reject(error); });
    if (timeoutMs) timer = setTimeout(() => request.destroy(
      path.match(ACTION_PATH)?.[2] === "start"
        ? new DockerLifecycleTimeout(timeoutMs)
        : new Error(`Docker API request timed out after ${timeoutMs}ms`)
    ), timeoutMs);
    request.end(body);
  });
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_MUTATED_BODY_BYTES) throw new Error("Docker API request is too large for muxpilot guard");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
