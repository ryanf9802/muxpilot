// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONNECTION_AUTO_RELOAD_DELAYS_MS,
  CONNECTION_AUTO_RELOAD_FAILURE_THRESHOLD,
  CONNECTION_AUTO_RELOAD_STORAGE_KEY,
  CONNECTION_RECOVERY_QUERY_PARAM,
  FOREGROUND_CONNECTION_AUTO_RELOAD_FAILURE_THRESHOLD,
  FOREGROUND_RECOVERY_COALESCE_MS,
  attemptConnectionAutoReload,
  clearConnectionAutoReload,
  connectionRecoveryUrl,
  forceConnectionAutoReload,
  installForegroundRecoveryListeners,
  requestWithTimeout,
  urlWithoutConnectionRecoveryToken
} from "./connectionRecovery.js";

afterEach(() => {
  window.sessionStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("requestWithTimeout", () => {
  it("rejects at the deadline even when the request ignores abort", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const request = vi.fn(() => new Promise<never>(() => undefined));

    const result = requestWithTimeout(request, 5000, controller);
    const rejection = expect(result).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(5000);

    await rejection;
    expect(controller.signal.aborted).toBe(true);
  });

  it("settles when an uncooperative request is externally aborted", async () => {
    const controller = new AbortController();
    const result = requestWithTimeout(() => new Promise<never>(() => undefined), 5000, controller);

    controller.abort();

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
  });

  it("allows a fresh request to succeed after a prior request times out", async () => {
    vi.useFakeTimers();
    const firstController = new AbortController();
    const first = requestWithTimeout(() => new Promise<never>(() => undefined), 5000, firstController);
    const firstRejection = expect(first).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(5000);
    await firstRejection;

    await expect(requestWithTimeout(async () => "connected", 5000, new AbortController())).resolves.toBe("connected");
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
  it("performs three delayed reload attempts without entering a reload loop", () => {
    let now = 1_000;
    const reload = vi.fn();
    const options = {
      visibilityState: "visible" as const,
      storage: () => window.sessionStorage,
      currentUrl: () => "https://muxpilot.test/sessions/abc?view=chat#latest",
      now: () => now,
      reload
    };

    expect(attemptConnectionAutoReload(CONNECTION_AUTO_RELOAD_FAILURE_THRESHOLD - 1, options)).toBe(false);
    expect(attemptConnectionAutoReload(CONNECTION_AUTO_RELOAD_FAILURE_THRESHOLD, options)).toBe(true);
    expect(attemptConnectionAutoReload(CONNECTION_AUTO_RELOAD_FAILURE_THRESHOLD + 1, options)).toBe(false);
    expect(reload).toHaveBeenLastCalledWith(
      `/sessions/abc?view=chat&${CONNECTION_RECOVERY_QUERY_PARAM}=1000-1#latest`
    );

    now += CONNECTION_AUTO_RELOAD_DELAYS_MS[1] - 1;
    expect(attemptConnectionAutoReload(CONNECTION_AUTO_RELOAD_FAILURE_THRESHOLD + 2, options)).toBe(false);
    now += 1;
    expect(attemptConnectionAutoReload(CONNECTION_AUTO_RELOAD_FAILURE_THRESHOLD + 3, options)).toBe(true);

    now += CONNECTION_AUTO_RELOAD_DELAYS_MS[2] - 1;
    expect(attemptConnectionAutoReload(CONNECTION_AUTO_RELOAD_FAILURE_THRESHOLD + 4, options)).toBe(false);
    now += 1;
    expect(attemptConnectionAutoReload(CONNECTION_AUTO_RELOAD_FAILURE_THRESHOLD + 5, options)).toBe(true);
    now += CONNECTION_AUTO_RELOAD_DELAYS_MS[2];
    expect(attemptConnectionAutoReload(CONNECTION_AUTO_RELOAD_FAILURE_THRESHOLD + 6, options)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(3);
  });

  it("reloads immediately for a failed foreground probe", () => {
    const reload = vi.fn();

    expect(attemptConnectionAutoReload(1, {
      visibilityState: "visible",
      failureThreshold: FOREGROUND_CONNECTION_AUTO_RELOAD_FAILURE_THRESHOLD,
      storage: () => window.sessionStorage,
      currentUrl: () => "https://muxpilot.test/",
      now: () => 1_000,
      reload
    })).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload while hidden or unable to record the guard", () => {
    const reload = vi.fn();
    const storage = () => window.sessionStorage;

    expect(attemptConnectionAutoReload(3, {
      visibilityState: "hidden",
      storage,
      currentUrl: () => "https://muxpilot.test/",
      now: () => 1_000,
      reload
    })).toBe(false);
    expect(attemptConnectionAutoReload(3, {
      visibilityState: "visible",
      storage: () => { throw new Error("Storage unavailable"); },
      currentUrl: () => "https://muxpilot.test/",
      now: () => 1_000,
      reload
    })).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("allows a future outage to reload after connectivity succeeds", () => {
    window.sessionStorage.setItem(CONNECTION_AUTO_RELOAD_STORAGE_KEY, "attempted");

    clearConnectionAutoReload(() => window.sessionStorage);

    expect(window.sessionStorage.getItem(CONNECTION_AUTO_RELOAD_STORAGE_KEY)).toBeNull();
  });

  it("forces a route-preserving manual reload even when storage is unavailable", () => {
    const reload = vi.fn();

    forceConnectionAutoReload({
      storage: () => { throw new Error("Storage unavailable"); },
      currentUrl: () => "https://muxpilot.test/sessions/abc?view=chat#latest",
      now: () => 1_000,
      reload
    });

    expect(reload).toHaveBeenCalledWith(
      `/sessions/abc?view=chat&${CONNECTION_RECOVERY_QUERY_PARAM}=1000-manual#latest`
    );
  });
});

describe("connection recovery URLs", () => {
  it("adds, replaces, and removes only the temporary recovery token", () => {
    const current = "https://muxpilot.test/sessions/abc?view=chat#latest";
    const recovery = connectionRecoveryUrl(current, "first");
    const replaced = connectionRecoveryUrl(`https://muxpilot.test${recovery}`, "second");

    expect(recovery).toBe(`/sessions/abc?view=chat&${CONNECTION_RECOVERY_QUERY_PARAM}=first#latest`);
    expect(replaced).toBe(`/sessions/abc?view=chat&${CONNECTION_RECOVERY_QUERY_PARAM}=second#latest`);
    expect(urlWithoutConnectionRecoveryToken(`https://muxpilot.test${replaced}`)).toBe("/sessions/abc?view=chat#latest");
    expect(urlWithoutConnectionRecoveryToken(current)).toBeNull();
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
    expect(recover).toHaveBeenLastCalledWith({ startsNewCycle: true });
    removeListeners();
  });

  it("starts a new recovery cycle when Chrome freezes and resumes the page", async () => {
    vi.useFakeTimers();
    const recover = vi.fn();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const removeListeners = installForegroundRecoveryListeners(recover);

    document.dispatchEvent(new Event("freeze"));
    document.dispatchEvent(new Event("resume"));
    await vi.advanceTimersByTimeAsync(FOREGROUND_RECOVERY_COALESCE_MS);

    expect(recover).toHaveBeenCalledWith({ startsNewCycle: true });
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
