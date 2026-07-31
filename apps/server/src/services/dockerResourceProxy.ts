import { request as httpRequest, createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmod, mkdir, rm } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { dirname } from "node:path";
import type { Duplex } from "node:stream";

const CREATE_PATH = /\/containers\/create(?:\?|$)/;
const UPDATE_PATH = /\/containers\/([^/]+)\/update(?:\?|$)/;
const ACTION_PATH = /\/containers\/([^/]+)\/(start|stop|kill|restart|delete)(?:\?|$)/;
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
}

interface ManagedContainer {
  id: string;
  running: boolean;
  requested: DockerLimits;
}

interface DockerLimits {
  MemoryReservation?: number;
  Memory?: number;
  MemorySwap?: number;
  NanoCpus?: number;
  PidsLimit?: number;
}

interface Logger {
  info(values: object, message: string): void;
  warn(values: object, message: string): void;
}

export class DockerResourceProxy {
  private readonly daemonSocketPath: string;
  private readonly containers = new Map<string, ManagedContainer>();
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
    this.logger.info({ socketPath: this.config.socketPath }, "Docker resource proxy started");
  }

  async close(): Promise<void> {
    const closed = new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.server.closeAllConnections();
    await closed;
    await rm(this.config.socketPath, { force: true });
  }

  dockerHost(): string {
    return `unix://${this.config.socketPath}`;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method === "POST" && CREATE_PATH.test(request.url ?? "")) {
        await this.handleCreate(request, response);
        return;
      }
      if (request.method === "POST" && UPDATE_PATH.test(request.url ?? "")) {
        await this.handleUpdate(request, response);
        return;
      }
      await forwardStreaming(this.daemonSocketPath, request, response, () => this.observeLifecycle(request));
    } catch (error) {
      this.logger.warn({ err: error }, "Docker proxy request failed");
      if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({
        message: `muxpilot Docker guard could not reach ${this.daemonSocketPath}`
      }));
    }
  }

  private async handleCreate(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readBody(request);
    const payload = JSON.parse(body.toString("utf8")) as {
      Labels?: Record<string, string>;
      HostConfig?: DockerLimits & Record<string, unknown>;
    };
    const heavyRun = headerValue(request, "x-muxpilot-heavy-run");
    const workspace = headerValue(request, "x-muxpilot-workspace");
    payload.Labels = {
      ...payload.Labels,
      "com.muxpilot.managed": "true",
      "com.muxpilot.resource-pool": "shared",
      ...(heavyRun && HEAVY_RUN_ID.test(heavyRun) ? { "com.muxpilot.heavy-run": heavyRun } : {}),
      ...(workspace && WORKSPACE_ID.test(workspace) ? { "com.muxpilot.workspace": workspace } : {})
    };
    const requested = pickLimits(payload.HostConfig ?? {});
    payload.HostConfig = {
      ...(payload.HostConfig ?? {}),
      ...effectiveLimits(requested, this.poolLimits(this.runningCount() + 1))
    };
    const encoded = Buffer.from(JSON.stringify(payload));
    const forwarded = await forwardRequest(this.daemonSocketPath, request, encoded);
    response.writeHead(forwarded.statusCode, forwarded.headers);
    response.end(forwarded.body);
    if (forwarded.statusCode >= 200 && forwarded.statusCode < 300) {
      const result = JSON.parse(forwarded.body.toString("utf8")) as { Id?: string };
      if (result.Id) this.containers.set(result.Id, { id: result.Id, running: false, requested });
    }
  }

  private observeLifecycle(request: IncomingMessage): void {
    const url = request.url ?? "";
    const action = url.match(ACTION_PATH);
    if (action) {
      const container = this.containers.get(action[1]!);
      if (container) {
        container.running = action[2] === "start" || action[2] === "restart";
        void this.rebalance();
      }
      return;
    }
    if (request.method === "DELETE") {
      const deleted = url.match(DELETE_PATH);
      if (deleted && this.containers.delete(deleted[1]!)) void this.rebalance();
    }
  }

  private async handleUpdate(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const id = (request.url ?? "").match(UPDATE_PATH)?.[1];
    const managed = id ? this.containers.get(id) : null;
    if (!managed) {
      await forwardStreaming(this.daemonSocketPath, request, response, () => undefined);
      return;
    }
    const body = await readBody(request);
    const payload = JSON.parse(body.toString("utf8")) as DockerLimits & Record<string, unknown>;
    managed.requested = { ...managed.requested, ...pickLimits(payload) };
    const running = Math.max(1, this.runningCount());
    const guarded = {
      ...payload,
      ...effectiveLimits(managed.requested, this.poolLimits(running))
    };
    const forwarded = await forwardRequest(this.daemonSocketPath, request, Buffer.from(JSON.stringify(guarded)));
    response.writeHead(forwarded.statusCode, forwarded.headers);
    response.end(forwarded.body);
  }

  private async rebalance(): Promise<void> {
    const running = [...this.containers.values()].filter((container) => container.running);
    const pool = this.poolLimits(Math.max(1, running.length));
    await Promise.all(running.map((container) => this.updateContainer(
      container.id,
      effectiveLimits(container.requested, pool)
    ).catch((error) => this.logger.warn({ err: error, containerId: container.id }, "Docker container rebalance failed"))));
  }

  private async updateContainer(id: string, limits: DockerLimits): Promise<void> {
    await rawDockerRequest(this.daemonSocketPath, "POST", `/containers/${encodeURIComponent(id)}/update`, Buffer.from(JSON.stringify(limits)));
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

  private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const upstream = httpRequest({
      socketPath: this.daemonSocketPath,
      method: request.method,
      path: request.url,
      headers: request.headers
    });
    upstream.on("upgrade", (response, upstreamSocket, upstreamHead) => {
      socket.write(
        `HTTP/${response.httpVersion} ${response.statusCode} ${response.statusMessage}\r\n` +
        Object.entries(response.headers).map(([key, value]) => `${key}: ${value}\r\n`).join("") +
        "\r\n"
      );
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) upstreamSocket.write(head);
      upstreamSocket.pipe(socket).pipe(upstreamSocket);
    });
    upstream.on("error", () => socket.destroy());
    upstream.end();
  }
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

async function forwardRequest(socketPath: string, incoming: IncomingMessage, replacementBody?: Buffer) {
  const body = replacementBody ?? await readBody(incoming);
  const headers = { ...incoming.headers, "content-length": String(body.length) };
  delete headers["transfer-encoding"];
  return rawDockerRequest(socketPath, incoming.method ?? "GET", incoming.url ?? "/", body, headers);
}

async function forwardStreaming(
  socketPath: string,
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  onSuccess: () => void
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const upstream = httpRequest({
      socketPath,
      method: incoming.method,
      path: incoming.url,
      headers: incoming.headers
    }, (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
      response.on("end", () => {
        if ((response.statusCode ?? 500) < 300) onSuccess();
        resolve();
      });
    });
    upstream.on("error", reject);
    incoming.pipe(upstream);
  });
}

async function rawDockerRequest(
  socketPath: string,
  method: string,
  path: string,
  body: Buffer,
  headers: Record<string, string | string[] | undefined> = {}
): Promise<{ statusCode: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ socketPath, method, path, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        statusCode: response.statusCode ?? 502,
        headers: response.headers,
        body: Buffer.concat(chunks)
      }));
    });
    request.on("error", reject);
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
