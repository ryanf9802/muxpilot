import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => ({ ...await importOriginal<typeof import("node:child_process")>(), spawn: vi.fn() }));

import { CodexAppServerClient } from "../src/services/codexUsage.js";

function appServer() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn()
  });
  const requests: Array<{ id: number; method: string }> = [];
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (line: string) => {
    const request = JSON.parse(line) as { id?: number; method: string };
    if (request.id === undefined) return;
    requests.push({ id: request.id, method: request.method });
    if (request.method === "initialize") queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`));
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcessWithoutNullStreams);
  return { child, requests, respond: (id: number, result: unknown) => child.stdout.write(`${JSON.stringify({ id, result })}\n`) };
}

describe("CodexAppServerClient read deadlines", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(spawn).mockReset();
  });

  it("allows a usage read to finish after three seconds within its fifteen second deadline", async () => {
    vi.useFakeTimers();
    const server = appServer();
    const client = new CodexAppServerClient({ codexHome: "/tmp/codex" });
    await client.initialize();
    const read = client.request("account/rateLimits/read", undefined, 15_000, { stopOnTimeout: false });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(3_100);
    const id = server.requests.find((request) => request.method === "account/rateLimits/read")!.id;
    server.respond(id, { rateLimits: {} });
    await expect(read).resolves.toEqual({ rateLimits: {} });
    expect(server.child.kill).not.toHaveBeenCalled();
    client.stop();
  });

  it("times out only one read, ignores its late response, and completes a sibling read", async () => {
    vi.useFakeTimers();
    const server = appServer();
    const client = new CodexAppServerClient({ codexHome: "/tmp/codex" });
    await client.initialize();
    const slow = client.request("account/rateLimits/read", undefined, 15_000, { stopOnTimeout: false });
    const sibling = client.request("account/usage/read", undefined, 20_000, { stopOnTimeout: false });
    const slowFailure = expect(slow).rejects.toThrow("account/rateLimits/read");
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(15_000);
    await slowFailure;
    expect(server.child.kill).not.toHaveBeenCalled();
    server.respond(server.requests.find((request) => request.method === "account/rateLimits/read")!.id, { ignored: true });
    server.respond(server.requests.find((request) => request.method === "account/usage/read")!.id, { summary: "fresh" });
    await expect(sibling).resolves.toEqual({ summary: "fresh" });
    client.stop();
  });
});
