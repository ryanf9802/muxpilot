import { createHash, randomBytes } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { PassThrough, Writable } from "node:stream";
import type { RuntimeProxyConnection } from "./types.js";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_HANDSHAKE_BYTES = 16 * 1024;
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const HANDSHAKE_TIMEOUT_MS = 5_000;

export async function openUnixWebSocketJsonLineConnection(socketPath: string): Promise<RuntimeProxyConnection> {
  const socket = createConnection(socketPath);
  const output = new PassThrough();
  let closed = false;
  let handshakeComplete = false;
  let receiveBuffer = Buffer.alloc(0);
  let fragmentedOpcode: number | null = null;
  let fragmentedPayloads: Buffer[] = [];
  let fragmentedBytes = 0;
  let inputBuffer = "";

  const fail = (error: Error) => {
    if (closed) return;
    closed = true;
    socket.destroy();
    output.destroy(error);
    input.destroy();
  };

  const input = new Writable({
    write(chunk, _encoding, callback) {
      if (closed) {
        callback(new Error("App-server WebSocket connection is closed"));
        return;
      }
      inputBuffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      const frames: Buffer[] = [];
      while (true) {
        const newline = inputBuffer.indexOf("\n");
        if (newline < 0) break;
        const message = inputBuffer.slice(0, newline);
        inputBuffer = inputBuffer.slice(newline + 1);
        if (message) frames.push(clientFrame(0x1, Buffer.from(message)));
      }
      if (frames.length === 0) {
        callback();
        return;
      }
      socket.write(Buffer.concat(frames), callback);
    },
    final(callback) {
      if (inputBuffer) {
        const message = inputBuffer;
        inputBuffer = "";
        socket.write(clientFrame(0x1, Buffer.from(message)), callback);
        return;
      }
      callback();
    }
  });

  const key = randomBytes(16).toString("base64");
  const expectedAccept = createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
  const handshake = new Promise<void>((resolveHandshake, rejectHandshake) => {
    const timer = setTimeout(() => rejectHandshake(new Error("Timed out upgrading the app-server Unix socket to WebSocket")), HANDSHAKE_TIMEOUT_MS);
    const reject = (error: Error) => {
      clearTimeout(timer);
      rejectHandshake(error);
    };
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write([
        "GET / HTTP/1.1",
        "Host: localhost",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        "",
        ""
      ].join("\r\n"));
    });
    socket.on("data", (chunk) => {
      receiveBuffer = Buffer.concat([receiveBuffer, chunk]);
      if (!handshakeComplete) {
        const boundary = receiveBuffer.indexOf("\r\n\r\n");
        if (boundary < 0) {
          if (receiveBuffer.length > MAX_HANDSHAKE_BYTES) reject(new Error("App-server WebSocket handshake exceeded its size limit"));
          return;
        }
        const response = receiveBuffer.subarray(0, boundary).toString("utf8");
        receiveBuffer = receiveBuffer.subarray(boundary + 4);
        try {
          validateHandshake(response, expectedAccept);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        handshakeComplete = true;
        clearTimeout(timer);
        socket.off("error", reject);
        socket.on("error", fail);
        resolveHandshake();
      }
      if (handshakeComplete) {
        try {
          consumeFrames();
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });
  });

  socket.once("close", () => {
    if (closed) return;
    closed = true;
    output.end();
    input.destroy();
  });

  function consumeFrames() {
    while (receiveBuffer.length >= 2) {
      const first = receiveBuffer[0]!;
      const second = receiveBuffer[1]!;
      if ((first & 0x70) !== 0) throw new Error("App-server WebSocket used unsupported reserved frame bits");
      if ((second & 0x80) !== 0) throw new Error("App-server WebSocket sent a masked server frame");
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (receiveBuffer.length < 4) return;
        length = receiveBuffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (receiveBuffer.length < 10) return;
        const extended = receiveBuffer.readBigUInt64BE(2);
        if (extended > BigInt(MAX_MESSAGE_BYTES)) throw new Error("App-server WebSocket frame exceeded its size limit");
        length = Number(extended);
        offset = 10;
      }
      if (length > MAX_MESSAGE_BYTES) throw new Error("App-server WebSocket frame exceeded its size limit");
      if (receiveBuffer.length < offset + length) return;
      const payload = receiveBuffer.subarray(offset, offset + length);
      receiveBuffer = receiveBuffer.subarray(offset + length);

      if (opcode === 0x8) {
        closed = true;
        socket.end(clientFrame(0x8, payload.subarray(0, 125)));
        output.end();
        input.destroy();
        return;
      }
      if (opcode === 0x9) {
        socket.write(clientFrame(0xA, payload));
        continue;
      }
      if (opcode === 0xA) continue;
      if (opcode !== 0x0 && opcode !== 0x1) throw new Error("App-server WebSocket emitted a non-text message");
      if (opcode === 0x1) {
        if (fragmentedOpcode !== null) throw new Error("App-server WebSocket started a message before completing the prior message");
        fragmentedOpcode = opcode;
        fragmentedPayloads = [];
        fragmentedBytes = 0;
      } else if (fragmentedOpcode === null) {
        throw new Error("App-server WebSocket emitted an unexpected continuation frame");
      }
      fragmentedPayloads.push(payload);
      fragmentedBytes += payload.length;
      if (fragmentedBytes > MAX_MESSAGE_BYTES) throw new Error("App-server WebSocket message exceeded its size limit");
      if (!fin) continue;
      output.write(Buffer.concat(fragmentedPayloads, fragmentedBytes));
      output.write("\n");
      fragmentedOpcode = null;
      fragmentedPayloads = [];
      fragmentedBytes = 0;
    }
  }

  try {
    await handshake;
  } catch (error) {
    closed = true;
    socket.destroy();
    output.destroy();
    input.destroy();
    throw error;
  }

  return {
    input,
    output,
    close: async () => {
      if (closed) return;
      closed = true;
      socket.end(clientFrame(0x8, Buffer.alloc(0)));
      output.end();
      input.destroy();
    }
  };
}

function validateHandshake(response: string, expectedAccept: string) {
  const lines = response.split("\r\n");
  if (!/^HTTP\/1\.[01] 101\b/.test(lines[0] ?? "")) throw new Error("App-server Unix socket refused the WebSocket upgrade");
  const headers = new Map(lines.slice(1).map((line) => {
    const separator = line.indexOf(":");
    return [line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim()];
  }));
  if (headers.get("upgrade")?.toLowerCase() !== "websocket") throw new Error("App-server Unix socket returned an invalid Upgrade header");
  if (!headers.get("connection")?.toLowerCase().split(/\s*,\s*/).includes("upgrade")) {
    throw new Error("App-server Unix socket returned an invalid Connection header");
  }
  if (headers.get("sec-websocket-accept") !== expectedAccept) throw new Error("App-server Unix socket returned an invalid WebSocket accept value");
}

function clientFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4);
  const lengthBytes = payload.length < 126 ? 0 : payload.length <= 0xffff ? 2 : 8;
  const header = Buffer.alloc(2 + lengthBytes + mask.length);
  header[0] = 0x80 | opcode;
  header[1] = 0x80 | (lengthBytes === 0 ? payload.length : lengthBytes === 2 ? 126 : 127);
  if (lengthBytes === 2) header.writeUInt16BE(payload.length, 2);
  if (lengthBytes === 8) header.writeBigUInt64BE(BigInt(payload.length), 2);
  mask.copy(header, 2 + lengthBytes);
  const masked = Buffer.allocUnsafe(payload.length);
  for (let index = 0; index < payload.length; index += 1) masked[index] = payload[index]! ^ mask[index % 4]!;
  return Buffer.concat([header, masked]);
}
