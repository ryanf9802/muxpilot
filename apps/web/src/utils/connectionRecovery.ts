export const CONNECTION_AUTO_RELOAD_FAILURE_THRESHOLD = 3;
export const FOREGROUND_CONNECTION_AUTO_RELOAD_FAILURE_THRESHOLD = 1;
export const CONNECTION_AUTO_RELOAD_STORAGE_KEY = "muxpilot.connection-auto-reload.v1";
export const FOREGROUND_RECOVERY_COALESCE_MS = 50;

export interface ForegroundRecoveryEvent {
  startsNewCycle: boolean;
}

export function requestWithTimeout<T>(
  request: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  controller: AbortController
): Promise<T> {
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  return request(controller.signal).finally(() => window.clearTimeout(timeout));
}

export function attemptConnectionAutoReload(
  failureCount: number,
  options: {
    visibilityState: DocumentVisibilityState;
    failureThreshold?: number;
    storage: () => Pick<Storage, "getItem" | "setItem">;
    reload: () => void;
  }
): boolean {
  if (
    failureCount < (options.failureThreshold ?? CONNECTION_AUTO_RELOAD_FAILURE_THRESHOLD)
    || options.visibilityState !== "visible"
  ) return false;

  try {
    const storage = options.storage();
    if (storage.getItem(CONNECTION_AUTO_RELOAD_STORAGE_KEY)) return false;
    storage.setItem(CONNECTION_AUTO_RELOAD_STORAGE_KEY, new Date().toISOString());
  } catch {
    return false;
  }

  options.reload();
  return true;
}

export function clearConnectionAutoReload(storage: () => Pick<Storage, "removeItem">): void {
  try {
    storage().removeItem(CONNECTION_AUTO_RELOAD_STORAGE_KEY);
  } catch {
    // Recovery must still succeed when browser storage is unavailable.
  }
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
  const handleOnline = () => scheduleRecovery(false);

  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("pageshow", handlePageShow);
  window.addEventListener("online", handleOnline);

  return () => {
    if (recoveryTimer !== null) window.clearTimeout(recoveryTimer);
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    window.removeEventListener("pageshow", handlePageShow);
    window.removeEventListener("online", handleOnline);
  };
}
