import { request as httpRequest, createServer } from "node:http";
import { createConnection, type Socket } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DockerResourceProxy } from "../src/services/dockerResourceProxy.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("DockerResourceProxy", () => {
  it("labels creates, preserves stricter limits, and reports daemon failures clearly", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-docker-proxy-"));
    roots.push(root);
    const daemonSocket = join(root, "daemon.sock");
    const proxySocket = join(root, "proxy.sock");
    const received: Array<{ url: string; payload: Record<string, any> }> = [];
    const daemon = createServer((request, response) => {
      if (request.url === "/events") {
        response.writeHead(200, { "content-type": "application/json" });
        response.write('{"status":"one"}\n');
        setTimeout(() => response.end('{"status":"two"}\n'), 10);
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        received.push({
          url: request.url ?? "",
          payload: JSON.parse(Buffer.concat(chunks).toString("utf8"))
        });
        response.writeHead(request.url?.includes("/create") ? 201 : 200, { "content-type": "application/json" });
        response.end(JSON.stringify(request.url?.includes("/create") ? { Id: "managed-container" } : {}));
      });
    });
    await new Promise<void>((resolve) => daemon.listen(daemonSocket, resolve));
    const logger = { info: vi.fn(), warn: vi.fn() };
    const proxy = new DockerResourceProxy({
      socketPath: proxySocket,
      daemonSocketPath: daemonSocket,
      memorySoftPercent: 15,
      memoryHardPercent: 20,
      cpuPercent: 25
    }, logger);
    await proxy.start();

    const strictMemory = 64 * 1024 ** 2;
    const created = await request(proxySocket, "POST", "/v1.47/containers/create", {
      Image: "example",
      HostConfig: { Memory: strictMemory }
    }, {
      "x-muxpilot-heavy-run": "mabc123-012345abcdef",
      "x-muxpilot-workspace": "workspace_123"
    });
    expect(created.status).toBe(201);
    expect(received[0]?.payload.Labels).toMatchObject({
      "com.muxpilot.managed": "true",
      "com.muxpilot.resource-pool": "shared",
      "com.muxpilot.heavy-run": "mabc123-012345abcdef",
      "com.muxpilot.workspace": "workspace_123"
    });
    expect(received[0]?.payload.HostConfig.Memory).toBe(strictMemory);
    expect(received[0]?.payload.HostConfig.MemoryReservation).toBe(strictMemory);
    expect(received[0]?.payload.HostConfig.NanoCpus).toBeGreaterThan(0);
    expect(received[0]?.payload.HostConfig.PidsLimit).toBe(512);

    await request(proxySocket, "POST", "/v1.47/containers/managed-container/update", {
      Memory: strictMemory / 2,
      PidsLimit: 100
    });
    expect(received[1]?.payload).toMatchObject({
      Memory: strictMemory / 2,
      MemoryReservation: strictMemory / 2,
      PidsLimit: 100
    });
    expect((await request(proxySocket, "GET", "/events")).body).toBe(
      '{"status":"one"}\n{"status":"two"}\n'
    );

    await proxy.close();
    const failedProxy = new DockerResourceProxy({
      socketPath: proxySocket,
      daemonSocketPath: join(root, "missing.sock"),
      memorySoftPercent: 15,
      memoryHardPercent: 20,
      cpuPercent: 25
    }, logger);
    await failedProxy.start();
    const failed = await request(proxySocket, "GET", "/version");
    expect(failed.status).toBe(502);
    expect(failed.body).toContain("could not reach");
    await failedProxy.close();
    await new Promise<void>((resolve) => daemon.close(() => resolve()));
  });

  it("mounts linked-worktree Git metadata read-only for heavyweight containers", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-docker-proxy-"));
    roots.push(root);
    const daemonSocket = join(root, "daemon.sock");
    const proxySocket = join(root, "proxy.sock");
    const commonA = join(root, "repo-a", ".git");
    const commonB = join(root, "repo-b", ".git");
    const worktreeA = join(root, "worktree-a");
    const worktreeB = join(root, "worktree-b");
    const malformed = join(root, "malformed");
    for (const [commonDir, worktree, name] of [
      [commonA, worktreeA, "task-a"],
      [commonB, worktreeB, "task-b"]
    ]) {
      const gitDir = join(commonDir, "worktrees", name);
      await mkdir(gitDir, { recursive: true });
      await mkdir(worktree, { recursive: true });
      await writeFile(join(worktree, ".git"), `gitdir: ${gitDir}\n`);
      await writeFile(join(gitDir, "commondir"), "../..\n");
    }
    await mkdir(malformed);
    await writeFile(join(malformed, ".git"), "gitdir: /etc\n");

    const received: Array<Record<string, any>> = [];
    const daemon = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ Id: `container-${received.length}` }));
      });
    });
    await new Promise<void>((resolve) => daemon.listen(daemonSocket, resolve));
    const proxy = new DockerResourceProxy({
      socketPath: proxySocket, daemonSocketPath: daemonSocket,
      memorySoftPercent: 15, memoryHardPercent: 20, cpuPercent: 25
    }, { info: vi.fn(), warn: vi.fn() });
    await proxy.start();

    const payload = {
      Image: "example",
      HostConfig: { Binds: [`${worktreeA}:/src-a:ro`, `${malformed}:/broken:ro`] },
      Mounts: [{ Type: "bind", Source: worktreeB, Target: "/src-b", ReadOnly: true }]
    };
    await request(proxySocket, "POST", "/v1.47/containers/create", payload, {
      "x-muxpilot-heavy-run": "mabc123-012345abcdef"
    });
    expect(received[0]?.HostConfig.Binds).toEqual([
      `${worktreeA}:/src-a:ro`,
      `${malformed}:/broken:ro`,
      `${commonA}:${commonA}:ro`,
      `${commonB}:${commonB}:ro`
    ]);

    await request(proxySocket, "POST", "/v1.47/containers/create", payload);
    expect(received[1]?.HostConfig.Binds).toEqual(payload.HostConfig.Binds);

    await proxy.close();
    await new Promise<void>((resolve) => daemon.close(() => resolve()));
  });

  it("does not override an existing bind at the linked-worktree metadata target", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-docker-proxy-"));
    roots.push(root);
    const daemonSocket = join(root, "daemon.sock");
    const proxySocket = join(root, "proxy.sock");
    const commonDir = join(root, "repo", ".git");
    const gitDir = join(commonDir, "worktrees", "task");
    const worktree = join(root, "worktree");
    await mkdir(gitDir, { recursive: true });
    await mkdir(worktree);
    await writeFile(join(worktree, ".git"), `gitdir: ${gitDir}\n`);
    await writeFile(join(gitDir, "commondir"), "../..\n");
    let received: Record<string, any> = {};
    const daemon = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        received = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ Id: "container" }));
      });
    });
    await new Promise<void>((resolve) => daemon.listen(daemonSocket, resolve));
    const proxy = new DockerResourceProxy({
      socketPath: proxySocket, daemonSocketPath: daemonSocket,
      memorySoftPercent: 15, memoryHardPercent: 20, cpuPercent: 25
    }, { info: vi.fn(), warn: vi.fn() });
    await proxy.start();
    const conflicting = `${join(root, "other")}:${commonDir}:ro`;
    await request(proxySocket, "POST", "/v1.47/containers/create", {
      Image: "example", HostConfig: { Binds: [`${worktree}:/src:ro`, conflicting] }
    }, { "x-muxpilot-heavy-run": "mabc123-012345abcdef" });
    expect(received.HostConfig.Binds).toEqual([`${worktree}:/src:ro`, conflicting]);
    await proxy.close();
    await new Promise<void>((resolve) => daemon.close(() => resolve()));
  });

  it("times out a start acknowledged by Docker that remains created", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-docker-proxy-"));
    roots.push(root);
    const daemonSocket = join(root, "daemon.sock");
    const proxySocket = join(root, "proxy.sock");
    const daemon = createServer((request, response) => {
      if (request.url?.endsWith("/start")) {
        response.writeHead(204);
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ State: { Status: request.url?.includes("/running/json") ? "running" : "created" } }));
    });
    await new Promise<void>((resolve) => daemon.listen(daemonSocket, resolve));
    const proxy = new DockerResourceProxy({
      socketPath: proxySocket, daemonSocketPath: daemonSocket,
      memorySoftPercent: 15, memoryHardPercent: 20, cpuPercent: 25,
      lifecycleStartTimeoutMs: 30
    }, { info: vi.fn(), warn: vi.fn() });
    await proxy.start();
    const response = await request(proxySocket, "POST", "/v1.47/containers/stuck/start");
    expect(response.status).toBe(504);
    expect(response.body).toContain("timed out waiting");
    expect((await request(proxySocket, "POST", "/v1.47/containers/running/start")).status).toBe(204);
    await proxy.close();
    await new Promise<void>((resolve) => daemon.close(() => resolve()));
  });

  it("times out a stuck pre-start attach upgrade", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-docker-proxy-"));
    roots.push(root);
    const daemonSocket = join(root, "daemon.sock");
    const proxySocket = join(root, "proxy.sock");
    let daemonUpgrade: Socket | null = null;
    const daemon = createServer();
    daemon.on("upgrade", (_request, socket) => { daemonUpgrade = socket; });
    await new Promise<void>((resolve) => daemon.listen(daemonSocket, resolve));
    const proxy = new DockerResourceProxy({
      socketPath: proxySocket, daemonSocketPath: daemonSocket,
      memorySoftPercent: 15, memoryHardPercent: 20, cpuPercent: 25,
      lifecycleStartTimeoutMs: 30
    }, { info: vi.fn(), warn: vi.fn() });
    await proxy.start();
    const response = await upgrade(proxySocket, "/v1.47/containers/stuck/attach?stream=1");
    expect(response).toContain("504 Gateway Timeout");
    expect(response).toContain("attach handshake");
    await proxy.close();
    daemonUpgrade?.destroy();
    await new Promise<void>((resolve) => daemon.close(() => resolve()));
  });

  it("times out a stuck pre-start attach streaming request", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-docker-proxy-"));
    roots.push(root);
    const daemonSocket = join(root, "daemon.sock");
    const proxySocket = join(root, "proxy.sock");
    const daemon = createServer(() => undefined);
    await new Promise<void>((resolve) => daemon.listen(daemonSocket, resolve));
    const proxy = new DockerResourceProxy({
      socketPath: proxySocket, daemonSocketPath: daemonSocket,
      memorySoftPercent: 15, memoryHardPercent: 20, cpuPercent: 25,
      lifecycleStartTimeoutMs: 30
    }, { info: vi.fn(), warn: vi.fn() });
    await proxy.start();
    const response = await request(proxySocket, "POST", "/v1.47/containers/stuck/attach?stream=1");
    expect(response.status).toBe(504);
    expect(response.body).toContain("attach handshake");
    await proxy.close();
    await new Promise<void>((resolve) => daemon.close(() => resolve()));
  });

  it("flushes streaming attach headers before Docker sends body data", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-docker-proxy-"));
    roots.push(root);
    const daemonSocket = join(root, "daemon.sock");
    const proxySocket = join(root, "proxy.sock");
    let finishDaemonResponse = () => undefined;
    const daemon = createServer((_request, response) => {
      finishDaemonResponse = () => response.end();
      response.writeHead(200, { "content-type": "application/vnd.docker.raw-stream" });
      response.flushHeaders();
    });
    await new Promise<void>((resolve) => daemon.listen(daemonSocket, resolve));
    const proxy = new DockerResourceProxy({
      socketPath: proxySocket, daemonSocketPath: daemonSocket,
      memorySoftPercent: 15, memoryHardPercent: 20, cpuPercent: 25,
      lifecycleStartTimeoutMs: 1_000
    }, { info: vi.fn(), warn: vi.fn() });
    await proxy.start();
    expect(await responseHeaders(proxySocket, "/v1.47/containers/stuck/attach?stream=1")).toBe(200);
    finishDaemonResponse();
    await proxy.close();
    await new Promise<void>((resolve) => daemon.close(() => resolve()));
  });

  it("reaps containers whose heavyweight owner disappeared", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-docker-proxy-"));
    roots.push(root);
    const daemonSocket = join(root, "daemon.sock");
    const proxySocket = join(root, "proxy.sock");
    const heavyRoot = join(root, "heavy");
    const runId = "mabc123-012345abcdef";
    await mkdir(join(heavyRoot, "runs", runId), { recursive: true });
    await writeFile(join(heavyRoot, "runs", runId, "owner.json"), JSON.stringify({
      state: "running", heartbeatAt: new Date().toISOString()
    }));
    const deleted: string[] = [];
    const daemon = createServer((request, response) => {
      if (request.method === "GET" && request.url?.startsWith("/containers/json")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify([{ Id: "orphan", State: "created", Labels: { "com.muxpilot.managed": "true", "com.muxpilot.heavy-run": runId } }]));
      } else if (request.method === "DELETE") {
        deleted.push(request.url ?? "");
        response.writeHead(204); response.end();
      } else { response.writeHead(200); response.end("{}"); }
    });
    await new Promise<void>((resolve) => daemon.listen(daemonSocket, resolve));
    const proxy = new DockerResourceProxy({
      socketPath: proxySocket, daemonSocketPath: daemonSocket,
      memorySoftPercent: 15, memoryHardPercent: 20, cpuPercent: 25,
      heavyValidationDir: heavyRoot, orphanReapIntervalMs: 10, orphanGraceMs: 1
    }, { info: vi.fn(), warn: vi.fn() });
    await proxy.start();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(deleted).toContain("/containers/orphan?force=true");
    await proxy.close();
    await new Promise<void>((resolve) => daemon.close(() => resolve()));
  });
});

function request(socketPath: string, method: string, path: string, payload?: object, headers: Record<string, string> = {}) {
  const body = payload ? Buffer.from(JSON.stringify(payload)) : Buffer.alloc(0);
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const next = httpRequest({
      socketPath,
      method,
      path,
      headers: { "content-type": "application/json", "content-length": String(body.length), ...headers }
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    next.on("error", reject);
    next.end(body);
  });
}

function upgrade(socketPath: string, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let response = "";
    socket.setEncoding("utf8");
    socket.setTimeout(1_000, () => socket.destroy(new Error("upgrade test timed out")));
    socket.once("connect", () => socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n`));
    socket.on("data", (chunk) => { response += chunk; });
    socket.once("end", () => resolve(response));
    socket.once("error", reject);
  });
}

function responseHeaders(socketPath: string, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const next = httpRequest({ socketPath, method: "POST", path }, (response) => {
      clearTimeout(timer);
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    const timer = setTimeout(() => next.destroy(new Error("streaming response headers were not flushed")), 250);
    next.once("error", reject);
    next.end();
  });
}
