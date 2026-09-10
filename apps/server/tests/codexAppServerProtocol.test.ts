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
    expect(request).toHaveBeenNthCalledWith(1, "thread/resume", { threadId: "thread-1", excludeTurns: true });
    expect(request).toHaveBeenNthCalledWith(2, "thread/read", { threadId: "thread-1", includeTurns: false });
  });

  it("hydrates turn summaries in bounded pages without requesting full history", async () => {
    const request = vi.fn(async (method: string, params: unknown) => {
      if (method === "thread/read") return { thread: { id: "thread-1", status: { type: "idle" } } };
      const cursor = (params as { cursor: string | null }).cursor;
      return cursor === null
        ? { data: [{ id: "turn-3" }, { id: "turn-2" }], nextCursor: "older" }
        : { data: [{ id: "turn-1" }], nextCursor: null };
    });
    const protocol = new CodexAppServerProtocol({ request } as ProtocolRequester);

    await expect(protocol.readThread("thread-1", true)).resolves.toMatchObject({
      thread: { id: "thread-1", turns: [{ id: "turn-1" }, { id: "turn-2" }, { id: "turn-3" }] }
    });
    expect(request).toHaveBeenNthCalledWith(1, "thread/read", { threadId: "thread-1", includeTurns: false });
    expect(request).toHaveBeenNthCalledWith(2, "thread/turns/list", {
      threadId: "thread-1",
      cursor: null,
      limit: 20,
      itemsView: "summary",
      sortDirection: "desc"
    });
    expect(request).toHaveBeenNthCalledWith(3, "thread/turns/list", {
      threadId: "thread-1",
      cursor: "older",
      limit: 20,
      itemsView: "summary",
      sortDirection: "desc"
    });
  });

  it("fails closed on repeated turn pagination cursors", async () => {
    const protocol = new CodexAppServerProtocol({
      request: async (method: string) => method === "thread/read"
        ? { thread: { id: "thread-1" } }
        : { data: [], nextCursor: "repeated" }
    });

    await expect(protocol.readThread("thread-1", true)).rejects.toThrow("repeated a cursor");
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
    await protocol.startTurn("thread-1", "", "client-image", {}, [
      { type: "text", text: "before" },
      { type: "localImage", path: "/tmp/screenshot.png" },
      { type: "text", text: "after" }
    ]);
    await protocol.interruptTurn("thread-1", "turn-1");
    await protocol.renameThread("thread-1", "New name");
    await protocol.updateThreadSettings("thread-1", { model: "gpt-5.6" });

    expect(request).toHaveBeenCalledWith("thread/start", { cwd: "/repo", model: "gpt-5.6" });
    expect(request).toHaveBeenCalledWith("thread/fork", { threadId: "thread-1", cwd: "/fork", excludeTurns: true });
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
    expect(request).toHaveBeenCalledWith("turn/start", {
      threadId: "thread-1",
      input: [
        { type: "text", text: "before" },
        { type: "localImage", path: "/tmp/screenshot.png" },
        { type: "text", text: "after" }
      ],
      clientUserMessageId: "client-image"
    });
    expect(request).toHaveBeenCalledWith("turn/interrupt", { threadId: "thread-1", turnId: "turn-1" });
  });

  it("resolves collaboration presets against the current default model", async () => {
    const request = vi.fn(async (method: string) => method === "model/list"
      ? { data: [{ model: "gpt-other", isDefault: false }, { model: "gpt-default", isDefault: true }] }
      : { data: [{ name: "Plan", mode: "plan", model: null, reasoning_effort: "medium" }] });
    const protocol = new CodexAppServerProtocol({ request } as ProtocolRequester);

    await expect(protocol.resolveDefaultCollaborationMode("plan")).resolves.toEqual({
      mode: "plan",
      settings: {
        model: "gpt-default",
        reasoning_effort: "medium",
        developer_instructions: null
      }
    });
    expect(request).toHaveBeenCalledWith("model/list", { limit: 100 });
    expect(request).toHaveBeenCalledWith("collaborationMode/list", {});
  });

  it("fails closed when default collaboration settings cannot be resolved", async () => {
    const missingDefault = new CodexAppServerProtocol({
      request: async (method) => method === "model/list" ? { data: [] } : { data: [{ mode: "plan" }] }
    });
    const missingMode = new CodexAppServerProtocol({
      request: async (method) => method === "model/list" ? { data: [{ model: "gpt-default", isDefault: true }] } : { data: [] }
    });

    await expect(missingDefault.resolveDefaultCollaborationMode("plan")).rejects.toThrow("no default model");
    await expect(missingMode.resolveDefaultCollaborationMode("plan")).rejects.toThrow("mode is unavailable");
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
