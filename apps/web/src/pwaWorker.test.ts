import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

describe("PWA service worker", () => {
  it("refreshes the offline shell after a successful navigation", async () => {
    const response = basicResponse("current UI");
    const harness = workerHarness(vi.fn(async () => response));
    const event = harness.fetchEvent("https://muxpilot.test/sessions/one", "navigate");

    const result = await event.response;
    await Promise.resolve();

    expect(result).toBe(response);
    expect(harness.cache.put).toHaveBeenCalledWith("/", expect.objectContaining({ body: "current UI" }));
  });

  it("uses the most recent shell when navigation fails", async () => {
    const cached = basicResponse("cached UI");
    const harness = workerHarness(vi.fn(async () => { throw new Error("offline"); }), cached);
    const event = harness.fetchEvent("https://muxpilot.test/sessions/one", "navigate");

    await expect(event.response).resolves.toBe(cached);
    expect(harness.caches.match).toHaveBeenCalledWith("/");
  });

  it("does not intercept API requests", () => {
    const harness = workerHarness(vi.fn());

    const event = harness.fetchEvent("https://muxpilot.test/api/me", "cors");

    expect(event.response).toBeUndefined();
  });

  it("waits for an explicit activation message", () => {
    const harness = workerHarness(vi.fn());

    expect(harness.skipWaiting).not.toHaveBeenCalled();
    const waitUntil = vi.fn();
    harness.listeners.message!({ data: { type: "SKIP_WAITING" }, waitUntil });
    expect(harness.skipWaiting).toHaveBeenCalledTimes(1);
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });
});

function workerHarness(fetch: ReturnType<typeof vi.fn>, cachedShell?: unknown) {
  const listeners: Record<string, (event: any) => void> = {};
  const cache = {
    addAll: vi.fn(async () => undefined),
    put: vi.fn(async () => undefined)
  };
  const caches = {
    open: vi.fn(async () => cache),
    keys: vi.fn(async () => []),
    delete: vi.fn(async () => true),
    match: vi.fn(async () => cachedShell)
  };
  const skipWaiting = vi.fn(async () => undefined);
  const self = {
    addEventListener: (name: string, listener: (event: any) => void) => { listeners[name] = listener; },
    skipWaiting,
    clients: { claim: vi.fn(async () => undefined), matchAll: vi.fn(async () => []), openWindow: vi.fn() },
    registration: { showNotification: vi.fn() },
    location: { origin: "https://muxpilot.test" }
  };
  const Response = { error: vi.fn(() => ({ error: true })) };
  const source = readFileSync(new URL("../sw-template.js", import.meta.url), "utf8")
    .replace("__MUXPILOT_BUILD_ID__", "test-build");
  vm.runInNewContext(source, { self, caches, fetch, location: self.location, URL, Response });

  return {
    cache,
    caches,
    listeners,
    skipWaiting,
    fetchEvent(url: string, mode: string) {
      let response: Promise<unknown> | undefined;
      listeners.fetch!({
        request: { method: "GET", url, mode },
        respondWith(value: Promise<unknown>) { response = value; }
      });
      return { response };
    }
  };
}

function basicResponse(body: string) {
  return {
    body,
    status: 200,
    type: "basic",
    clone() { return { ...this }; }
  };
}
