const DEFAULT_SLOW_REQUEST_MS = 250;

export type RequestLogLevel = "warn" | "error" | null;

export function slowRequestThresholdMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MUXPILOT_SLOW_REQUEST_MS;
  if (raw === undefined || raw === "") return DEFAULT_SLOW_REQUEST_MS;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_SLOW_REQUEST_MS;
}

export function requestLogLevel(statusCode: number, elapsedMs: number, slowThresholdMs: number): RequestLogLevel {
  if (statusCode >= 500) return "error";
  if (statusCode >= 400 || elapsedMs >= slowThresholdMs) return "warn";
  return null;
}
