import type { EventBus } from "../../services/eventBus.js";
import { ProjectionReconciler, type AppServerProjectionStore, type ProjectionAdapter } from "../shared/projectionReconciler.js";
import type { DriverEvent } from "../types.js";
import { projectAppServerEvent } from "./events.js";

export const codexProjectionAdapter: ProjectionAdapter = {
  project: projectAppServerEvent,
  authenticationFailure,
  isInteractiveServerRequest,
  accountUpdatedMethod: "account/updated"
};

/** The shared projection pipeline configured for Codex app-server notifications. */
export class CodexAppServerReconciler extends ProjectionReconciler {
  constructor(
    store: AppServerProjectionStore,
    events: Pick<EventBus, "publish">,
    onAuthenticationFailure?: (sessionId: string, error: string) => void,
    onAccountUpdated?: () => void
  ) {
    super(store, events, codexProjectionAdapter, onAuthenticationFailure, onAccountUpdated);
  }
}

export function authenticationFailure(method: string, value: unknown): string | null {
  const root = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const turn = root?.turn && typeof root.turn === "object" && !Array.isArray(root.turn) ? root.turn as Record<string, unknown> : null;
  if (method !== "connection/error" && !(method === "turn/completed" && turn?.status === "failed")) return null;
  const text = collectErrorText(value).join(" ");
  if (!/unauthori[sz]ed|access token|refresh token|logged out|signed in to another account|authentication required/i.test(text)) return null;
  const sanitized = text
    .replace(/((?:access|refresh|id)[_-]?token|api[_-]?key|authorization)\s*[:=]\s*["']?[^"',\s}]+/gi, "$1=[credential redacted]")
    .replace(/(?:sk-|sess-|Bearer\s+)[A-Za-z0-9._-]+/gi, "[credential redacted]")
    .slice(0, 800) || "Codex account authentication required.";
  return `${sanitized} Manage Codex authentication with the Codex CLI, then return to muxpilot.`;
}

function collectErrorText(value: unknown, depth = 0): string[] {
  if (depth > 5) return [];
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item) => collectErrorText(item, depth + 1));
  return Object.values(value as Record<string, unknown>).flatMap((item) => collectErrorText(item, depth + 1));
}

function isInteractiveServerRequest(event: DriverEvent): boolean {
  const params = event.params;
  return Boolean(
    [
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
      "item/tool/requestUserInput"
    ].includes(event.method)
    && params
    && typeof params === "object"
    && !Array.isArray(params)
    && "requestId" in params
    && "params" in params
  );
}
