import { createConnection, type Socket } from "node:net";
import type { RuntimeProxyConnection } from "../providers/types.js";

const CONNECT_TIMEOUT_MS = 5_000;

/** Connects to a runtime that speaks newline-delimited JSON directly on a unix socket. */
export function openUnixJsonLineConnection(socketPath: string): Promise<RuntimeProxyConnection> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out connecting to runtime socket: ${socketPath}`));
    }, CONNECT_TIMEOUT_MS);
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.removeAllListeners("error");
      resolve(socketConnection(socket));
    });
  });
}

export function socketConnection(socket: Socket): RuntimeProxyConnection {
  // Transport errors surface through the readable side, which JsonRpcConnection observes.
  socket.on("error", () => undefined);
  return {
    input: socket,
    output: socket,
    close: () => new Promise((resolve) => {
      if (socket.destroyed) {
        resolve();
        return;
      }
      socket.end(() => {
        socket.destroy();
        resolve();
      });
      setTimeout(() => {
        socket.destroy();
        resolve();
      }, 500).unref();
    })
  };
}
