export const CONNECTION_AUTO_RELOAD_FAILURE_THRESHOLD = 3;
export const FOREGROUND_CONNECTION_AUTO_RELOAD_FAILURE_THRESHOLD = 1;
export const CONNECTION_AUTO_RELOAD_STORAGE_KEY = "muxpilot.connection-auto-reload.v2";
export const CONNECTION_AUTO_RELOAD_DELAYS_MS = [0, 10_000, 30_000] as const;
export const CONNECTION_RECOVERY_QUERY_PARAM = "muxpilot-recovery";
export const FOREGROUND_RECOVERY_COALESCE_MS = 50;

export interface ForegroundRecoveryEvent {
  startsNewCycle: boolean;
}

interface ConnectionAutoReloadState {
  attempts: number;
  lastAttemptAt: number;
}

type ConnectionAutoReloadStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function requestWithTimeout<T>(
  request: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  controller: AbortController
): Promise<T> {
  let timeout: number | null = null;
  let removeAbortListener: () => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const rejectAborted = () => reject(controller.signal.reason ?? new DOMException("The request was aborted.", "AbortError"));
    if (controller.signal.aborted) {
      rejectAborted();
      return;
    }

    controller.signal.addEventListener("abort", rejectAborted, { once: true });
    removeAbortListener = () => controller.signal.removeEventListener("abort", rejectAborted);
    timeout = window.setTimeout(() => {
      controller.abort(new DOMException(`The request timed out after ${timeoutMs}ms.`, "TimeoutError"));
    }, timeoutMs);
  });

  let pending: Promise<T>;
  try {
    pending = Promise.resolve(request(controller.signal));
  } catch (error) {
    pending = Promise.reject(error);
  }

  return Promise.race([pending, aborted]).finally(() => {
    if (timeout !== null) window.clearTimeout(timeout);
    removeAbortListener();
  });
}

export function attemptConnectionAutoReload(
  failureCount: number,
  options: {
    visibilityState: DocumentVisibilityState;
    failureThreshold?: number;
    storage: () => ConnectionAutoReloadStorage;
    currentUrl: () => string;
    now: () => number;
    reload: (url: string) => void;
  }
): boolean {
  if (
    failureCount < (options.failureThreshold ?? CONNECTION_AUTO_RELOAD_FAILURE_THRESHOLD)
    || options.visibilityState !== "visible"
  ) return false;

  try {
    const storage = options.storage();
    const current = readConnectionAutoReloadState(storage);
    const delay = CONNECTION_AUTO_RELOAD_DELAYS_MS[current.attempts];
    if (delay === undefined) return false;

    const now = options.now();
    if (current.attempts > 0 && now - current.lastAttemptAt < delay) return false;

    const next = { attempts: current.attempts + 1, lastAttemptAt: now };
    storage.setItem(CONNECTION_AUTO_RELOAD_STORAGE_KEY, JSON.stringify(next));
    options.reload(connectionRecoveryUrl(options.currentUrl(), `${now}-${next.attempts}`));
  } catch {
    return false;
  }

  return true;
}

export function forceConnectionAutoReload(options: {
  storage: () => ConnectionAutoReloadStorage;
  currentUrl: () => string;
  now: () => number;
  reload: (url: string) => void;
}): void {
  const now = options.now();
  try {
    const storage = options.storage();
    storage.removeItem(CONNECTION_AUTO_RELOAD_STORAGE_KEY);
    storage.setItem(CONNECTION_AUTO_RELOAD_STORAGE_KEY, JSON.stringify({ attempts: 1, lastAttemptAt: now }));
  } catch {
    // A manual recovery must still navigate when browser storage is unavailable.
  }
  options.reload(connectionRecoveryUrl(options.currentUrl(), `${now}-manual`));
}

export function clearConnectionAutoReload(storage: () => Pick<Storage, "removeItem">): void {
  try {
    storage().removeItem(CONNECTION_AUTO_RELOAD_STORAGE_KEY);
  } catch {
    // Recovery must still succeed when browser storage is unavailable.
  }
}

export function connectionRecoveryUrl(currentUrl: string, token: string): string {
  const url = new URL(currentUrl);
  url.searchParams.set(CONNECTION_RECOVERY_QUERY_PARAM, token);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function urlWithoutConnectionRecoveryToken(currentUrl: string): string | null {
  const url = new URL(currentUrl);
  if (!url.searchParams.has(CONNECTION_RECOVERY_QUERY_PARAM)) return null;
  url.searchParams.delete(CONNECTION_RECOVERY_QUERY_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function installForegroundRecoveryListeners(onRecover: (event: ForegroundRecoveryEvent) => void): () => void {
  let sawHidden = document.visibilityState === "hidden";
  let startsNewCycle = false;
  let recoveryTimer: number | null = null;

  const scheduleRecovery = (nextCycle: boolean) => {
    startsNewCycle ||= nextCycle;
    if (recoveryTimer !== null) return;
    recoveryTimer = window.setTimeout(() => {
      recoveryTimer = null;
      const event = { startsNewCycle };
      startsNewCycle = false;
      onRecover(event);
    }, FOREGROUND_RECOVERY_COALESCE_MS);
  };

  const handleVisibilityChange = () => {
    if (document.visibilityState === "hidden") {
      sawHidden = true;
      return;
    }
    scheduleRecovery(sawHidden);
    sawHidden = false;
  };
  const handlePageShow = (event: PageTransitionEvent) => {
    scheduleRecovery(sawHidden || event.persisted);
    sawHidden = false;
  };
  const handleOnline = () => scheduleRecovery(true);
  const handleFreeze = () => {
    sawHidden = true;
  };
  const handleResume = () => {
    scheduleRecovery(true);
    sawHidden = false;
  };

  document.addEventListener("visibilitychange", handleVisibilityChange);
  document.addEventListener("freeze", handleFreeze);
  document.addEventListener("resume", handleResume);
  window.addEventListener("pageshow", handlePageShow);
  window.addEventListener("online", handleOnline);

  return () => {
    if (recoveryTimer !== null) window.clearTimeout(recoveryTimer);
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    document.removeEventListener("freeze", handleFreeze);
    document.removeEventListener("resume", handleResume);
    window.removeEventListener("pageshow", handlePageShow);
    window.removeEventListener("online", handleOnline);
  };
}

function readConnectionAutoReloadState(storage: Pick<Storage, "getItem">): ConnectionAutoReloadState {
  const value = storage.getItem(CONNECTION_AUTO_RELOAD_STORAGE_KEY);
  if (!value) return { attempts: 0, lastAttemptAt: 0 };
  try {
    const parsed = JSON.parse(value) as Partial<ConnectionAutoReloadState>;
    if (
      !Number.isInteger(parsed.attempts)
      || parsed.attempts! < 0
      || !Number.isFinite(parsed.lastAttemptAt)
      || parsed.lastAttemptAt! < 0
    ) return { attempts: 0, lastAttemptAt: 0 };
    return { attempts: parsed.attempts!, lastAttemptAt: parsed.lastAttemptAt! };
  } catch {
    return { attempts: 0, lastAttemptAt: 0 };
  }
}
