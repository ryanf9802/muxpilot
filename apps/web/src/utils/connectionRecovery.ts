export function requestWithTimeout<T>(
  request: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  controller: AbortController
): Promise<T> {
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  return request(controller.signal).finally(() => window.clearTimeout(timeout));
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
