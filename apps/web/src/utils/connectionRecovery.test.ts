// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONNECTION_AUTO_RELOAD_FAILURE_THRESHOLD,
  CONNECTION_AUTO_RELOAD_STORAGE_KEY,
  FOREGROUND_CONNECTION_AUTO_RELOAD_FAILURE_THRESHOLD,
  FOREGROUND_RECOVERY_COALESCE_MS,
  attemptConnectionAutoReload,
  clearConnectionAutoReload,
  installForegroundRecoveryListeners,
  requestWithTimeout
} from "./connectionRecovery.js";

afterEach(() => {
  window.sessionStorage.clear();
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

describe("connection reload escalation", () => {
  it("reloads once after repeated visible failures", () => {
    const reload = vi.fn();
    const options = {
      visibilityState: "visible" as const,
      storage: () => window.sessionStorage,
      reload
    };

    expect(attemptConnectionAutoReload(CONNECTION_AUTO_RELOAD_FAILURE_THRESHOLD - 1, options)).toBe(false);
    expect(attemptConnectionAutoReload(CONNECTION_AUTO_RELOAD_FAILURE_THRESHOLD, options)).toBe(true);
    expect(attemptConnectionAutoReload(CONNECTION_AUTO_RELOAD_FAILURE_THRESHOLD + 1, options)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads immediately for a failed foreground probe", () => {
    const reload = vi.fn();

    expect(attemptConnectionAutoReload(1, {
      visibilityState: "visible",
      failureThreshold: FOREGROUND_CONNECTION_AUTO_RELOAD_FAILURE_THRESHOLD,
      storage: () => window.sessionStorage,
      reload
    })).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload while hidden or unable to record the guard", () => {
    const reload = vi.fn();
    const storage = () => window.sessionStorage;

    expect(attemptConnectionAutoReload(3, { visibilityState: "hidden", storage, reload })).toBe(false);
    expect(attemptConnectionAutoReload(3, {
      visibilityState: "visible",
      storage: () => { throw new Error("Storage unavailable"); },
      reload
    })).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("allows a future outage to reload after connectivity succeeds", () => {
    window.sessionStorage.setItem(CONNECTION_AUTO_RELOAD_STORAGE_KEY, "attempted");

    clearConnectionAutoReload(() => window.sessionStorage);

    expect(window.sessionStorage.getItem(CONNECTION_AUTO_RELOAD_STORAGE_KEY)).toBeNull();
  });
});

describe("installForegroundRecoveryListeners", () => {
  it("coalesces foreground signals and identifies a new hidden-to-visible cycle", async () => {
    vi.useFakeTimers();
    const recover = vi.fn();
    let visibilityState: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibilityState);
    const removeListeners = installForegroundRecoveryListeners(recover);

    visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("pageshow"));
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(FOREGROUND_RECOVERY_COALESCE_MS);

    expect(recover).toHaveBeenCalledTimes(1);
    expect(recover).toHaveBeenLastCalledWith({ startsNewCycle: true });

    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(FOREGROUND_RECOVERY_COALESCE_MS);

    expect(recover).toHaveBeenCalledTimes(2);
    expect(recover).toHaveBeenLastCalledWith({ startsNewCycle: false });
    removeListeners();
  });

  it("ignores hidden visibility changes, cancels pending recovery, and removes every listener", async () => {
    vi.useFakeTimers();
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
    await vi.advanceTimersByTimeAsync(FOREGROUND_RECOVERY_COALESCE_MS);
    expect(recover).not.toHaveBeenCalled();
  });
});
