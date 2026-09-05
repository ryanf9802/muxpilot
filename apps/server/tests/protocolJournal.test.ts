import { appendFile, mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProtocolJournal, protocolJournalPath, type ProtocolJournalEntry } from "../src/services/sessionDrivers/protocolJournal.js";

const capabilityId = "0123456789abcdef01234567";

describe("ProtocolJournal", () => {
  it("serializes concurrent appends into a private JSONL journal", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-protocol-journal-"));
    const path = protocolJournalPath(root, capabilityId);
    const journal = new ProtocolJournal(path);
    await Promise.all(Array.from({ length: 20 }, (_, index) => journal.append(entry(index))));
    await journal.close();

    const records = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as ProtocolJournalEntry);
    expect(records.map((record) => record.id)).toEqual(Array.from({ length: 20 }, (_, index) => index));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, capabilityId))).mode & 0o777).toBe(0o700);
  });

  it("rotates deterministically and reads a bounded newest-first tail in chronological order", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-protocol-rotation-"));
    const path = protocolJournalPath(root, capabilityId);
    const journal = new ProtocolJournal(path, { maxFileBytes: 260, maxFiles: 3, maxEntryBytes: 220 });
    for (let index = 0; index < 12; index += 1) await journal.append(entry(index, { text: `payload-${index}-${"x".repeat(30)}` }));

    const files = (await readdir(join(root, capabilityId))).sort();
    expect(files).toEqual(["protocol.1.jsonl", "protocol.2.jsonl", "protocol.jsonl"]);
    await expect(files.reduce(async (totalPromise, file) => (await totalPromise) + (await stat(join(root, capabilityId, file))).size, Promise.resolve(0)))
      .resolves.toBeLessThanOrEqual(780);
    const tail = await journal.readTail(360);
    expect(tail).toContain('"id":11');
    expect(tail.indexOf('"id":10')).toBeLessThan(tail.indexOf('"id":11'));
  });

  it("omits oversized payloads while retaining routing evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-protocol-truncate-"));
    const path = protocolJournalPath(root, capabilityId);
    const journal = new ProtocolJournal(path, { maxFileBytes: 512, maxEntryBytes: 300 });
    await journal.append(entry(7, { secret: "x".repeat(5_000) }));

    const record = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(record).toMatchObject({
      direction: "client_to_server",
      kind: "request",
      id: 7,
      method: "turn/start",
      payload: { omitted: true },
      truncated: true
    });
    expect(record.originalBytes).toEqual(expect.any(Number));
    expect(await stat(path).then((metadata) => metadata.size)).toBeLessThanOrEqual(300);
  });

  it("rebuilds exact active command ownership and ignores malformed journal lines", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-protocol-processes-"));
    const path = protocolJournalPath(root, capabilityId);
    const journal = new ProtocolJournal(path);
    await journal.append(notification("item/started", "turn-old", "item-old", "process-old"));
    await journal.append(notification("item/started", "turn-active", "item-active", "process-active"));
    await journal.append(notification("item/completed", "turn-old", "item-old", "process-old"));
    await journal.append(notification("item/started", "other-turn", "other-item", "other-process", "other-thread"));
    await appendFile(path, "{truncated\n", "utf8");

    expect(await journal.listActiveCommandProcesses("thread-1")).toEqual([{
      threadId: "thread-1",
      turnId: "turn-active",
      itemId: "item-active",
      processId: "process-active"
    }]);
  });

  it("rejects traversal identifiers and invalid bounds", () => {
    expect(() => protocolJournalPath("/tmp/journal", "../escape")).toThrow(/24 lowercase hexadecimal/);
    expect(() => new ProtocolJournal("/tmp/protocol.jsonl", { maxFiles: 0 })).toThrow("maxFiles must be a positive integer");
    expect(() => new ProtocolJournal("/tmp/protocol.log")).toThrow("must end in .jsonl");
  });
});

function entry(id: number, payload: unknown = { text: "hello" }): ProtocolJournalEntry {
  return {
    timestamp: `2026-09-01T12:00:${String(id).padStart(2, "0")}.000Z`,
    direction: "client_to_server",
    kind: "request",
    connectionId: "connection-1",
    id,
    method: "turn/start",
    payload
  };
}

function notification(
  method: "item/started" | "item/completed",
  turnId: string,
  itemId: string,
  processId: string,
  threadId = "thread-1"
): ProtocolJournalEntry {
  return {
    timestamp: "2026-09-01T12:00:00.000Z",
    direction: "server_to_client",
    kind: "notification",
    connectionId: "connection-1",
    method,
    payload: {
      jsonrpc: "2.0",
      method,
      params: {
        threadId,
        turnId,
        item: { id: itemId, type: "commandExecution", processId }
      }
    }
  };
}
