import type { Writable } from "node:stream";
import type { ProtocolJournal, ProtocolJournalEntry } from "./protocolJournal.js";
import type { RuntimeProxyConnection } from "./types.js";

const DEFAULT_MAX_FRAME_BYTES = 4 * 1024 * 1024;

type JsonRpcId = string | number;

interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcNotification {
  method: string;
  params: unknown;
}

export interface JsonRpcServerRequest extends JsonRpcNotification {
  id: JsonRpcId;
}

export interface JsonRpcConnectionHandlers {
  notification?(notification: JsonRpcNotification): void | Promise<void>;
  serverRequest?(request: JsonRpcServerRequest): void | Promise<void>;
  error?(error: Error): void;
}

export interface JsonRpcConnectionOptions {
  maxFrameBytes?: number;
}

type JournalWriter = Pick<ProtocolJournal, "append">;

export class JsonRpcResponseError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
    this.name = "JsonRpcResponseError";
  }
}

export class JsonRpcConnection {
  private nextRequestId = 1;
  private buffer = Buffer.alloc(0);
  private frameTail: Promise<void> = Promise.resolve();
  private writeTail: Promise<void> = Promise.resolve();
  private readonly pending = new Map<JsonRpcId, { resolve(value: unknown): void; reject(error: Error): void }>();
  private closed = false;
  private readonly maxFrameBytes: number;
  private readonly onData = (chunk: Buffer | string) => this.receive(chunk);
  private readonly onEnd = () => this.finishOutput();
  private readonly onOutputError = (error: Error) => this.endFromTransport(error);

  private constructor(
    readonly connectionId: string,
    private readonly proxy: RuntimeProxyConnection,
    private readonly journal: JournalWriter,
    private readonly handlers: JsonRpcConnectionHandlers,
    options: JsonRpcConnectionOptions
  ) {
    this.maxFrameBytes = positiveInteger(options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES, "maxFrameBytes");
    proxy.output.on("data", this.onData);
    proxy.output.once("end", this.onEnd);
    proxy.output.once("error", this.onOutputError);
  }

  static async connect(
    connectionId: string,
    proxy: RuntimeProxyConnection,
    journal: JournalWriter,
    handlers: JsonRpcConnectionHandlers = {},
    options: JsonRpcConnectionOptions = {}
  ): Promise<JsonRpcConnection> {
    const connection = new JsonRpcConnection(connectionId, proxy, journal, handlers, options);
    try {
      await connection.record({ direction: "connection", kind: "transition", payload: { state: "connected" } });
      return connection;
    } catch (error) {
      connection.closed = true;
      connection.detachOutput();
      await proxy.close().catch(() => undefined);
      throw error;
    }
  }

  request<T>(method: string, params: unknown): Promise<T> {
    this.requireOpen();
    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      void this.sendFrame({ jsonrpc: "2.0", id, method, params }, "request").catch((error) => {
        this.pending.delete(id);
        reject(asError(error));
      });
    });
  }

  notify(method: string, params: unknown): Promise<void> {
    this.requireOpen();
    return this.sendFrame({ jsonrpc: "2.0", method, params }, "notification");
  }

  respond(id: JsonRpcId, result: unknown): Promise<void> {
    this.requireOpen();
    return this.sendFrame({ jsonrpc: "2.0", id, result }, "response");
  }

  respondError(id: JsonRpcId, error: JsonRpcErrorObject): Promise<void> {
    this.requireOpen();
    return this.sendFrame({ jsonrpc: "2.0", id, error }, "response");
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.detachOutput();
    const error = new Error("App-server connection closed");
    this.rejectPending(error);
    await this.record({ direction: "connection", kind: "transition", payload: { state: "closed" } }).catch(() => undefined);
    await this.proxy.close();
  }

  private receive(chunk: Buffer | string): void {
    if (this.closed) return;
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    this.buffer = Buffer.concat([this.buffer, bytes]);
    if (this.buffer.length > this.maxFrameBytes && this.buffer.indexOf(0x0a) < 0) {
      this.fail(new Error(`App-server protocol frame exceeded ${this.maxFrameBytes} bytes`));
      return;
    }
    while (!this.closed) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) break;
      const line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (line.length === 0) continue;
      if (line.length > this.maxFrameBytes) {
        this.fail(new Error(`App-server protocol frame exceeded ${this.maxFrameBytes} bytes`));
        return;
      }
      const text = line.toString("utf8");
      this.frameTail = this.frameTail.then(() => this.handleFrame(text)).catch((error) => this.fail(asError(error)));
    }
    if (!this.closed && this.buffer.length > this.maxFrameBytes) {
      this.fail(new Error(`App-server protocol frame exceeded ${this.maxFrameBytes} bytes`));
    }
  }

  private async handleFrame(text: string): Promise<void> {
    if (this.closed) return;
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      throw new Error("App-server proxy emitted invalid JSON");
    }
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw new Error("App-server proxy emitted an invalid JSON-RPC frame");
    const value = frame as Record<string, unknown>;
    const id = jsonRpcId(value.id);
    const method = typeof value.method === "string" ? value.method : null;

    if (method && id !== null) {
      await this.record({ direction: "server_to_client", kind: "request", id, method, payload: value });
      await this.handlers.serverRequest?.({ id, method, params: value.params });
      return;
    }
    if (method) {
      await this.record({ direction: "server_to_client", kind: "notification", method, payload: value });
      await this.handlers.notification?.({ method, params: value.params });
      return;
    }
    if (id !== null && (Object.hasOwn(value, "result") || Object.hasOwn(value, "error"))) {
      await this.record({ direction: "server_to_client", kind: "response", id, payload: value });
      const pending = this.pending.get(id);
      if (!pending) return;
      if (Object.hasOwn(value, "error")) {
        const error = jsonRpcError(value.error);
        if (!error) throw new Error("App-server proxy emitted an invalid JSON-RPC error response");
        this.pending.delete(id);
        pending.reject(new JsonRpcResponseError(error.code, error.message, error.data));
      } else {
        this.pending.delete(id);
        pending.resolve(value.result);
      }
      return;
    }
    throw new Error("App-server proxy emitted an unrecognized JSON-RPC frame");
  }

  private sendFrame(frame: Record<string, unknown>, kind: "request" | "response" | "notification"): Promise<void> {
    const operation = this.writeTail.then(async () => {
      this.requireOpen();
      const id = jsonRpcId(frame.id);
      const method = typeof frame.method === "string" ? frame.method : null;
      await this.record({ direction: "client_to_server", kind, id, method, payload: frame });
      const line = `${JSON.stringify(frame)}\n`;
      if (Buffer.byteLength(line) > this.maxFrameBytes) throw new Error(`Outgoing app-server protocol frame exceeded ${this.maxFrameBytes} bytes`);
      await writeToProxy(this.proxy.input, line);
    });
    const guarded = operation.catch((error) => {
      this.fail(asError(error));
      throw error;
    });
    this.writeTail = guarded.catch(() => undefined);
    return guarded;
  }

  private endFromTransport(error: Error): void {
    if (this.closed) return;
    void this.frameTail.finally(() => this.fail(error));
  }

  private finishOutput(): void {
    if (this.closed) return;
    if (this.buffer.length > 0) {
      const text = this.buffer.toString("utf8");
      this.buffer = Buffer.alloc(0);
      this.frameTail = this.frameTail.then(() => this.handleFrame(text)).catch((error) => this.fail(asError(error)));
    }
    this.endFromTransport(new Error("App-server proxy closed"));
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.buffer = Buffer.alloc(0);
    this.detachOutput();
    this.rejectPending(error);
    void this.record({ direction: "internal", kind: "error", error: error.message }).catch(() => undefined);
    void this.proxy.close().catch(() => undefined);
    try {
      this.handlers.error?.(error);
    } catch {
      // Error observers cannot make a failed transport throw into the stream event loop.
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private detachOutput(): void {
    this.proxy.output.off("data", this.onData);
    this.proxy.output.off("end", this.onEnd);
    this.proxy.output.off("error", this.onOutputError);
  }

  private requireOpen(): void {
    if (this.closed) throw new Error("App-server connection is closed");
  }

  private record(entry: Omit<ProtocolJournalEntry, "timestamp" | "connectionId">): Promise<void> {
    return this.journal.append({ ...entry, timestamp: new Date().toISOString(), connectionId: this.connectionId });
  }
}

function jsonRpcId(value: unknown): JsonRpcId | null {
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value)) ? value : null;
}

function jsonRpcError(value: unknown): JsonRpcErrorObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const error = value as Record<string, unknown>;
  if (typeof error.code !== "number" || typeof error.message !== "string") return null;
  return { code: error.code, message: error.message, data: error.data };
}

function writeToProxy(stream: Writable, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(line, (error?: Error | null) => error ? reject(error) : resolve());
  });
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
