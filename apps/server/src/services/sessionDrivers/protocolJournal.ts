import { chmod, lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const CAPABILITY_ID = /^[a-f0-9]{24}$/;
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_FILES = 3;
const DEFAULT_MAX_ENTRY_BYTES = 256 * 1024;

export type ProtocolJournalDirection = "client_to_server" | "server_to_client" | "connection" | "internal";
export type ProtocolJournalKind = "request" | "response" | "notification" | "transition" | "error";

export interface ProtocolJournalEntry {
  timestamp: string;
  direction: ProtocolJournalDirection;
  kind: ProtocolJournalKind;
  connectionId: string;
  id?: string | number | null;
  method?: string | null;
  payload?: unknown;
  error?: string | null;
}

export interface StoredProtocolJournalEntry extends ProtocolJournalEntry {
  truncated?: boolean;
  originalBytes?: number;
}

export interface AppServerCommandProcessOwnership {
  threadId: string;
  turnId: string;
  itemId: string;
  processId: string;
}

interface ProtocolJournalOptions {
  maxFileBytes?: number;
  maxFiles?: number;
  maxEntryBytes?: number;
}

export class ProtocolJournal {
  private tail: Promise<void> = Promise.resolve();
  private readonly maxFileBytes: number;
  private readonly maxFiles: number;
  private readonly maxEntryBytes: number;

  constructor(readonly path: string, options: ProtocolJournalOptions = {}) {
    if (!path.endsWith(".jsonl")) throw new Error("Protocol journal path must end in .jsonl");
    this.maxFileBytes = positiveInteger(options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES, "maxFileBytes");
    this.maxFiles = positiveInteger(options.maxFiles ?? DEFAULT_MAX_FILES, "maxFiles");
    this.maxEntryBytes = Math.min(
      positiveInteger(options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES, "maxEntryBytes"),
      this.maxFileBytes
    );
  }

  append(entry: ProtocolJournalEntry): Promise<void> {
    const operation = this.tail.catch(() => undefined).then(() => this.appendNow(entry));
    this.tail = operation;
    return operation;
  }

  async close(): Promise<void> {
    await this.tail;
  }

  async readTail(maxBytes: number): Promise<string> {
    await this.tail;
    const limit = positiveInteger(maxBytes, "maxBytes");
    const chunks: Buffer[] = [];
    let remaining = limit;
    for (let index = 0; index < this.maxFiles && remaining > 0; index += 1) {
      const path = rotatedPath(this.path, index);
      await secureExistingJournal(path);
      const content = await readFile(path).catch(() => null);
      if (!content) continue;
      const chunk = content.subarray(Math.max(0, content.length - remaining));
      chunks.unshift(chunk);
      remaining -= chunk.length;
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  async listActiveCommandProcesses(threadId: string): Promise<AppServerCommandProcessOwnership[]> {
    await this.tail;
    const active = new Map<string, AppServerCommandProcessOwnership>();
    for (let index = this.maxFiles - 1; index >= 0; index -= 1) {
      const path = rotatedPath(this.path, index);
      await secureExistingJournal(path);
      const content = await readFile(path, "utf8").catch(() => null);
      if (!content) continue;
      for (const line of content.split("\n")) {
        if (!line) continue;
        const entry = parseJournalEntry(line);
        if (!entry) continue;
        const notification = appServerNotification(entry);
        if (!notification || notification.threadId !== threadId) continue;
        const key = `${notification.itemId}\0${notification.processId}`;
        if (entry.method === "item/started" && notification.itemType === "commandExecution") {
          active.set(key, {
            threadId: notification.threadId,
            turnId: notification.turnId,
            itemId: notification.itemId,
            processId: notification.processId
          });
        } else if (entry.method === "item/completed") {
          active.delete(key);
        }
      }
    }
    return [...active.values()];
  }

  private async appendNow(entry: ProtocolJournalEntry): Promise<void> {
    await preparePrivateDirectory(dirname(this.path));
    await secureExistingJournal(this.path);
    const line = boundedEntryLine(entry, this.maxEntryBytes);
    const currentSize = await stat(this.path).then((metadata) => metadata.size).catch(() => 0);
    if (currentSize > 0 && currentSize + Buffer.byteLength(line) > this.maxFileBytes) await this.rotate();
    await writeFile(this.path, line, { encoding: "utf8", mode: 0o600, flag: "a" });
    await chmod(this.path, 0o600);
  }

  private async rotate(): Promise<void> {
    await rm(rotatedPath(this.path, this.maxFiles - 1), { force: true });
    for (let index = this.maxFiles - 2; index >= 0; index -= 1) {
      await rename(rotatedPath(this.path, index), rotatedPath(this.path, index + 1)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
}

function parseJournalEntry(line: string): StoredProtocolJournalEntry | null {
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as StoredProtocolJournalEntry
      : null;
  } catch {
    return null;
  }
}

function appServerNotification(entry: StoredProtocolJournalEntry | null): {
  threadId: string;
  turnId: string;
  itemId: string;
  processId: string;
  itemType: string | null;
} | null {
  if (!entry || entry.direction !== "server_to_client" || entry.kind !== "notification") return null;
  if (entry.method !== "item/started" && entry.method !== "item/completed") return null;
  const frame = record(entry.payload);
  const params = record(frame?.params);
  const item = record(params?.item);
  const threadId = stringValue(params?.threadId);
  const turnId = stringValue(params?.turnId);
  const itemId = stringValue(item?.id) ?? stringValue(params?.itemId);
  const processId = stringValue(item?.processId) ?? stringValue(params?.processId);
  if (!threadId || !turnId || !itemId || !processId) return null;
  return { threadId, turnId, itemId, processId, itemType: stringValue(item?.type) };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

export function protocolJournalPath(root: string, capabilityId: string): string {
  if (!CAPABILITY_ID.test(capabilityId)) throw new Error("Protocol journal capability id must be 24 lowercase hexadecimal characters");
  return join(root, capabilityId, "protocol.jsonl");
}

function boundedEntryLine(entry: ProtocolJournalEntry, maxBytes: number): string {
  const line = `${JSON.stringify(entry)}\n`;
  const originalBytes = Buffer.byteLength(line);
  if (originalBytes <= maxBytes) return line;
  const bounded: StoredProtocolJournalEntry = {
    timestamp: entry.timestamp,
    direction: entry.direction,
    kind: entry.kind,
    connectionId: entry.connectionId,
    id: entry.id,
    method: entry.method,
    error: truncateUtf8(entry.error ?? null, Math.max(0, maxBytes - 512)),
    payload: { omitted: true },
    truncated: true,
    originalBytes
  };
  let result = `${JSON.stringify(bounded)}\n`;
  if (Buffer.byteLength(result) <= maxBytes) return result;
  delete bounded.error;
  result = `${JSON.stringify(bounded)}\n`;
  if (Buffer.byteLength(result) <= maxBytes) return result;
  throw new Error("Protocol journal entry limit is too small for metadata");
}

function truncateUtf8(value: string | null, maxBytes: number): string | null {
  if (value === null || Buffer.byteLength(value) <= maxBytes) return value;
  let result = value;
  while (result && Buffer.byteLength(result) > maxBytes) result = result.slice(0, Math.floor(result.length * 0.75));
  return `${result}…`;
}

function rotatedPath(path: string, index: number): string {
  return index === 0 ? path : path.replace(/\.jsonl$/, `.${index}.jsonl`);
}

async function preparePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`Protocol journal path is not a private directory: ${path}`);
  await chmod(path, 0o700);
}

async function secureExistingJournal(path: string): Promise<void> {
  const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!metadata) return;
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Protocol journal is not a regular owned file: ${path}`);
  await chmod(path, 0o600);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}
