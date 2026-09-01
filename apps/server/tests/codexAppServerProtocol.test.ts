import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  checkGeneratedProtocolSchema,
  CodexAppServerProtocol,
  REQUIRED_CLIENT_METHODS,
  REQUIRED_PROTOCOL_FIELDS,
  REQUIRED_SERVER_NOTIFICATIONS,
  REQUIRED_SERVER_REQUESTS,
  type ProtocolRequester
} from "../src/services/sessionDrivers/codexAppServerProtocol.js";

describe("CodexAppServerProtocol", () => {
  it("matches the normalized Codex 0.152.0 initialize fixture", async () => {
    const fixture = JSON.parse(await readFile(fileURLToPath(new URL("./fixtures/codex-app-server-0.152.0.json", import.meta.url)), "utf8"));
    const request = vi.fn(async () => fixture.initializeResponse.result);
    const protocol = new CodexAppServerProtocol({ request } as ProtocolRequester);

    await expect(protocol.initialize("0.1.0")).resolves.toEqual(fixture.initializeResponse.result);
    expect(request).toHaveBeenCalledWith("initialize", fixture.initializeRequest.params);
  });

  it("validates resumed and read thread identity", async () => {
    const request = vi.fn(async (method: string) => ({ thread: { id: method === "thread/resume" ? "resumed" : "read" } }));
    const protocol = new CodexAppServerProtocol({ request } as ProtocolRequester);
    await expect(protocol.resumeThread("thread-1")).resolves.toMatchObject({ thread: { id: "resumed" } });
    await expect(protocol.readThread("thread-1", false)).resolves.toMatchObject({ thread: { id: "read" } });
    expect(request).toHaveBeenNthCalledWith(1, "thread/resume", { threadId: "thread-1" });
    expect(request).toHaveBeenNthCalledWith(2, "thread/read", { threadId: "thread-1", includeTurns: false });
  });

  it("uses structured thread lifecycle and turn input shapes", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "turn/start") return { turn: { id: "turn-1" } };
      if (method === "turn/steer") return { turnId: "turn-1" };
      if (method.startsWith("thread/") && !method.includes("settings") && !method.includes("name")) {
        return { thread: { id: method === "thread/fork" ? "thread-2" : "thread-1" } };
      }
      return {};
    });
    const protocol = new CodexAppServerProtocol({ request } as ProtocolRequester);

    await protocol.startThread({ cwd: "/repo", model: "gpt-5.6" });
    await protocol.forkThread("thread-1", { cwd: "/fork" });
    await protocol.startTurn("thread-1", "hello", "client-1", { collaborationMode: { mode: "default" } });
    await protocol.steerTurn("thread-1", "turn-1", "one more thing", "client-2");
    await protocol.interruptTurn("thread-1", "turn-1");
    await protocol.renameThread("thread-1", "New name");
    await protocol.updateThreadSettings("thread-1", { model: "gpt-5.6" });

    expect(request).toHaveBeenCalledWith("thread/start", { cwd: "/repo", model: "gpt-5.6" });
    expect(request).toHaveBeenCalledWith("thread/fork", { threadId: "thread-1", cwd: "/fork" });
    expect(request).toHaveBeenCalledWith("turn/start", {
      threadId: "thread-1",
      input: [{ type: "text", text: "hello" }],
      clientUserMessageId: "client-1",
      collaborationMode: { mode: "default" }
    });
    expect(request).toHaveBeenCalledWith("turn/steer", {
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      input: [{ type: "text", text: "one more thing" }],
      clientUserMessageId: "client-2"
    });
    expect(request).toHaveBeenCalledWith("turn/interrupt", { threadId: "thread-1", turnId: "turn-1" });
  });

  it("fails closed on malformed turn responses and unsafe empty identifiers", async () => {
    const protocol = new CodexAppServerProtocol({ request: async () => ({}) });
    await expect(protocol.startTurn("thread-1", "message", "client-1")).rejects.toThrow("missing turn.id");
    await expect(protocol.steerTurn("thread-1", "turn-1", "message", "client-1")).rejects.toThrow("missing turnId");
    await expect(protocol.startTurn("thread-1", " ", "client-1")).rejects.toThrow("text must not be empty");
    await expect(protocol.interruptTurn("thread-1", "")).rejects.toThrow("turnId must not be empty");
  });

  it("fails closed on malformed identity responses", async () => {
    const protocol = new CodexAppServerProtocol({ request: async () => ({}) });
    await expect(protocol.initialize("0.1.0")).rejects.toThrow("missing required identity fields");
    await expect(protocol.resumeThread("thread-1")).rejects.toThrow("missing thread.id");
  });

  it("checks methods, server requests, notifications, and correlation fields", () => {
    const complete = JSON.stringify({
      methods: [...REQUIRED_CLIENT_METHODS, ...REQUIRED_SERVER_REQUESTS, ...REQUIRED_SERVER_NOTIFICATIONS],
      fields: REQUIRED_PROTOCOL_FIELDS
    });
    expect(checkGeneratedProtocolSchema(complete)).toEqual({ compatible: true, missingCapabilities: [] });
    expect(checkGeneratedProtocolSchema(JSON.stringify({ methods: ["initialize"], fields: [] }))).toMatchObject({
      compatible: false,
      missingCapabilities: expect.arrayContaining(["thread/resume", "item/tool/requestUserInput", "turn/completed", "field:clientUserMessageId"])
    });
    expect(checkGeneratedProtocolSchema("not json")).toEqual({ compatible: false, missingCapabilities: ["valid-generated-schema"] });
  });
});
