// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { installForegroundRecoveryListeners, requestWithTimeout } from "./connectionRecovery.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("requestWithTimeout", () => {
  it("aborts a connectivity request that does not settle", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const request = vi.fn((signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));

    const result = requestWithTimeout(request, 5000, controller);
    const rejection = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(5000);

    await rejection;
    expect(controller.signal.aborted).toBe(true);
  });

  it("clears the timeout after a request settles", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();

    await expect(requestWithTimeout(async () => "connected", 5000, controller)).resolves.toBe("connected");
    await vi.advanceTimersByTimeAsync(5000);

    expect(controller.signal.aborted).toBe(false);
  });
});

describe("installForegroundRecoveryListeners", () => {
  it("recovers for visible, pageshow, and online events", () => {
    const recover = vi.fn();
    const removeListeners = installForegroundRecoveryListeners(recover);

    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("pageshow"));
    window.dispatchEvent(new Event("online"));

    expect(recover).toHaveBeenCalledTimes(3);
    removeListeners();
  });

  it("ignores hidden visibility changes and removes every listener", () => {
    const recover = vi.fn();
    const visibilityState = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const removeListeners = installForegroundRecoveryListeners(recover);

    document.dispatchEvent(new Event("visibilitychange"));
    expect(recover).not.toHaveBeenCalled();

    removeListeners();
    visibilityState.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("pageshow"));
    window.dispatchEvent(new Event("online"));
    expect(recover).not.toHaveBeenCalled();
  });
});
