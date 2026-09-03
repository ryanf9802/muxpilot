import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { JsonRpcConnection, JsonRpcResponseError, type JsonRpcConnectionHandlers } from "../src/services/sessionDrivers/jsonRpcConnection.js";
import type { ProtocolJournalEntry } from "../src/services/sessionDrivers/protocolJournal.js";
import type { RuntimeProxyConnection } from "../src/services/sessionDrivers/types.js";

describe("JsonRpcConnection", () => {
  it("correlates ordered requests and journals both directions", async () => {
    const harness = await createHarness();
    const result = harness.connection.request<{ thread: { id: string } }>("thread/start", { cwd: "/repo" });
    await settle();
    expect(lines(harness.input)).toEqual([{ jsonrpc: "2.0", id: 1, method: "thread/start", params: { cwd: "/repo" } }]);

    harness.output.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { thread: { id: "thread-1" } } })}\n`);
    await expect(result).resolves.toEqual({ thread: { id: "thread-1" } });
    expect(harness.entries.map((entry) => [entry.direction, entry.kind, entry.id, entry.method])).toEqual([
      ["connection", "transition", undefined, undefined],
      ["client_to_server", "request", 1, "thread/start"],
      ["server_to_client", "response", 1, undefined]
    ]);
  });

  it("delivers additive notifications and server requests in arrival order", async () => {
    const notifications: string[] = [];
    const requests: string[] = [];
    const harness = await createHarness({
      notification: async ({ method }) => { notifications.push(method); },
      serverRequest: async ({ id, method }) => { requests.push(`${id}:${method}`); }
    });
    harness.output.write(`${JSON.stringify({ jsonrpc: "2.0", method: "future/additive", params: { value: true } })}\n`);
    harness.output.write(`${JSON.stringify({ jsonrpc: "2.0", id: "approval-1", method: "item/commandExecution/requestApproval", params: {} })}\n`);
    await settle();
    await settle();

    expect(notifications).toEqual(["future/additive"]);
    expect(requests).toEqual(["approval-1:item/commandExecution/requestApproval"]);
    await harness.connection.respond("approval-1", { decision: "accept" });
    expect(lines(harness.input).at(-1)).toEqual({ jsonrpc: "2.0", id: "approval-1", result: { decision: "accept" } });
  });

  it("rejects protocol errors and every pending request on disconnect", async () => {
    const harness = await createHarness();
    const failed = harness.connection.request("thread/read", { threadId: "missing" });
    await settle();
    harness.output.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "missing" } })}\n`);
    await expect(failed).rejects.toEqual(expect.objectContaining({ code: -32000, message: "missing" } satisfies Partial<JsonRpcResponseError>));

    const pending = harness.connection.request("thread/read", { threadId: "thread-1" });
    await settle();
    harness.output.end();
    await expect(pending).rejects.toThrow("App-server proxy closed");
    expect(() => harness.connection.notify("thread/read", {})).toThrow("App-server connection is closed");
  });

  it("fails closed on invalid or oversized frames", async () => {
    const errors: Error[] = [];
    const invalid = await createHarness({ error: (error) => errors.push(error) });
    invalid.output.write("not json\n");
    await settle();
    await settle();
    expect(errors[0]?.message).toBe("App-server proxy emitted invalid JSON");

    const oversizedErrors: Error[] = [];
    const oversized = await createHarness({ error: (error) => oversizedErrors.push(error) }, 32);
    oversized.output.write("x".repeat(33));
    await settle();
    expect(oversizedErrors[0]?.message).toContain("exceeded 32 bytes");
  });

  it("closes the proxy when durable connection journaling fails", async () => {
    const proxy: RuntimeProxyConnection = {
      input: new PassThrough(),
      output: new PassThrough(),
      close: vi.fn(async () => undefined)
    };
    await expect(JsonRpcConnection.connect("connection-1", proxy, {
      append: async () => { throw new Error("journal unavailable"); }
    })).rejects.toThrow("journal unavailable");
    expect(proxy.close).toHaveBeenCalledOnce();
  });

  it("fails the connection when an unanswered request exceeds its bound", async () => {
    vi.useFakeTimers();
    try {
      const harness = await createHarness({}, 1024, 25);
      const timedOut = harness.connection.request("initialize", {});
      const timedOutAssertion = expect(timedOut).rejects.toThrow("timed out after 25ms: initialize");
      await vi.advanceTimersByTimeAsync(25);
      await timedOutAssertion;
      expect(harness.close).toHaveBeenCalledOnce();
      expect(() => harness.connection.request("thread/read", { threadId: "thread-1" })).toThrow("connection is closed");
    } finally {
      vi.useRealTimers();
    }
  });
});

async function createHarness(
  handlers: JsonRpcConnectionHandlers = {},
  maxFrameBytes = 1024,
  requestTimeoutMs = 30_000
): Promise<{
  connection: JsonRpcConnection;
  input: PassThrough;
  output: PassThrough;
  entries: ProtocolJournalEntry[];
  close: ReturnType<typeof vi.fn>;
}> {
  const input = new PassThrough();
  const output = new PassThrough();
  const entries: ProtocolJournalEntry[] = [];
  const close = vi.fn(async () => undefined);
  const proxy: RuntimeProxyConnection = { input, output, close };
  const connection = await JsonRpcConnection.connect("connection-1", proxy, {
    append: async (entry) => { entries.push(entry); }
  }, handlers, { maxFrameBytes, requestTimeoutMs });
  return { connection, input, output, entries, close };
}

function lines(stream: PassThrough): unknown[] {
  return stream.read()?.toString("utf8").trim().split("\n").filter(Boolean).map((line: string) => JSON.parse(line)) ?? [];
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}
