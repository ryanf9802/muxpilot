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
