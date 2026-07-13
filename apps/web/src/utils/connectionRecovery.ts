export const CONNECTION_AUTO_RELOAD_FAILURE_THRESHOLD = 3;
export const CONNECTION_AUTO_RELOAD_STORAGE_KEY = "muxpilot.connection-auto-reload.v1";

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
    online: boolean;
    storage: () => Pick<Storage, "getItem" | "setItem">;
    reload: () => void;
  }
): boolean {
  if (
    failureCount < CONNECTION_AUTO_RELOAD_FAILURE_THRESHOLD
    || options.visibilityState !== "visible"
    || !options.online
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

export function installForegroundRecoveryListeners(onRecover: () => void): () => void {
  const handleVisibilityChange = () => {
    if (document.visibilityState === "visible") onRecover();
  };

  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("pageshow", onRecover);
  window.addEventListener("online", onRecover);

  return () => {
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    window.removeEventListener("pageshow", onRecover);
    window.removeEventListener("online", onRecover);
  };
}
