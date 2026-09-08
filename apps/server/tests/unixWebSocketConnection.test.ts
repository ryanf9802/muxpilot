import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openUnixWebSocketJsonLineConnection } from "../src/services/sessionDrivers/unixWebSocketConnection.js";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("openUnixWebSocketJsonLineConnection", () => {
  it("upgrades a Unix socket and translates masked client and fragmented server text frames", async () => {
    const socketPath = await testSocketPath();
    let clientPayload: string | null = null;
    const server = createServer((socket) => {
      acceptUpgrade(socket, (remaining) => {
        const frame = readClientFrame(remaining);
        clientPayload = frame.payload.toString("utf8");
        socket.write(serverFrame(0x1, Buffer.from('{"jsonrpc":"2.0","id":1,'), false));
        socket.write(serverFrame(0x0, Buffer.from('"result":{"ok":true}}'), true));
      });
    });
    await listen(server, socketPath);

    const connection = await openUnixWebSocketJsonLineConnection(socketPath);
    const response = readLine(connection.output);
    connection.input.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');

    expect(await response).toBe('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n');
    expect(clientPayload).toBe('{"jsonrpc":"2.0","id":1,"method":"initialize"}');
    await connection.close();
    server.close();
    await once(server, "close");
  });

  it("rejects an invalid WebSocket accept value", async () => {
    const socketPath = await testSocketPath();
    const server = createServer((socket) => {
      socket.once("data", () => socket.end([
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Accept: invalid",
        "",
        ""
      ].join("\r\n")));
    });
    await listen(server, socketPath);

    await expect(openUnixWebSocketJsonLineConnection(socketPath)).rejects.toThrow("invalid WebSocket accept value");
    server.close();
    await once(server, "close");
  });

  it("reports oversized server frames without emitting an unhandled input-stream error", async () => {
    const socketPath = await testSocketPath();
    const server = createServer((socket) => {
      acceptUpgrade(socket, () => socket.write(oversizedServerFrameHeader(4 * 1024 * 1024 + 1)));
    });
    await listen(server, socketPath);

    const connection = await openUnixWebSocketJsonLineConnection(socketPath);
    const inputError = vi.fn();
    connection.input.on("error", inputError);
    const outputError = once(connection.output, "error");
    connection.input.write('{"method":"trigger"}\n');

    await expect(outputError).resolves.toMatchObject([{ message: "App-server WebSocket frame exceeded its size limit" }]);
    expect(inputError).not.toHaveBeenCalled();
    server.close();
    await once(server, "close");
  });
});

async function testSocketPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "muxpilot-ws-"));
  roots.push(root);
  return join(root, "app.sock");
}

async function listen(server: ReturnType<typeof createServer>, socketPath: string): Promise<void> {
  server.listen(socketPath);
  await once(server, "listening");
}

function acceptUpgrade(socket: Socket, onFrame: (remaining: Buffer) => void): void {
  let buffer = Buffer.alloc(0);
  const receive = (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    const boundary = buffer.indexOf("\r\n\r\n");
    if (boundary < 0) return;
    const request = buffer.subarray(0, boundary).toString("utf8");
    const key = /^Sec-WebSocket-Key:\s*(.+)$/im.exec(request)?.[1]?.trim();
    if (!key) throw new Error("missing WebSocket key");
    const accept = createHash("sha1").update(`${key}${GUID}`).digest("base64");
    buffer = buffer.subarray(boundary + 4);
    socket.off("data", receive);
    const receiveFrame = (chunk?: Buffer) => {
      if (chunk) buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 2) return;
      const encodedLength = buffer[1]! & 0x7f;
      const headerLength = encodedLength < 126 ? 6 : encodedLength === 126 ? 8 : 14;
      const payloadLength = encodedLength < 126 ? encodedLength : encodedLength === 126 ? buffer.readUInt16BE(2) : Number(buffer.readBigUInt64BE(2));
      if (buffer.length < headerLength + payloadLength) return;
      socket.off("data", receiveFrame);
      onFrame(buffer);
    };
    socket.on("data", receiveFrame);
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      ""
    ].join("\r\n"), () => receiveFrame());
  };
  socket.on("data", receive);
}

function readClientFrame(frame: Buffer): { payload: Buffer } {
  expect(frame[0]).toBe(0x81);
  expect(frame[1]! & 0x80).toBe(0x80);
  const encodedLength = frame[1]! & 0x7f;
  expect(encodedLength).toBeLessThan(126);
  const mask = frame.subarray(2, 6);
  const payload = Buffer.alloc(encodedLength);
  for (let index = 0; index < encodedLength; index += 1) payload[index] = frame[6 + index]! ^ mask[index % 4]!;
  return { payload };
}

function serverFrame(opcode: number, payload: Buffer, final: boolean): Buffer {
  expect(payload.length).toBeLessThan(126);
  return Buffer.concat([Buffer.from([(final ? 0x80 : 0) | opcode, payload.length]), payload]);
}

function oversizedServerFrameHeader(payloadLength: number): Buffer {
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payloadLength), 2);
  return header;
}

function readLine(output: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = "";
    const receive = (chunk: Buffer | string) => {
      value += chunk.toString();
      if (!value.includes("\n")) return;
      output.removeListener("data", receive);
      resolve(value);
    };
    output.on("data", receive);
    output.once("error", reject);
  });
}
