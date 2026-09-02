import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SESSION_SCOPE_PATTERN = /^muxpilot-session-[a-f0-9]{24}\.scope$/;
const SESSION_SERVICE_PATTERN = /^muxpilot-session-[a-f0-9]{24}\.service$/;

export type SessionScopeUnavailableReason = "disabled" | "user_systemd_unavailable";

export interface SessionScopeCapability {
  configured: boolean;
  available: boolean;
  unavailableReason: SessionScopeUnavailableReason | null;
  environment: Record<string, string>;
}

export type UserSystemdProbe = (environment: Record<string, string>) => Promise<void>;

export function userSystemdEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  uid: number | undefined = typeof process.getuid === "function" ? process.getuid() : undefined
): Record<string, string> {
  const runtimeDir = environment.XDG_RUNTIME_DIR ?? (uid === undefined ? null : `/run/user/${uid}`);
  if (!runtimeDir) return {};
  return {
    XDG_RUNTIME_DIR: runtimeDir,
    DBUS_SESSION_BUS_ADDRESS: environment.DBUS_SESSION_BUS_ADDRESS ?? `unix:path=${runtimeDir}/bus`
  };
}

export async function detectSessionScopeCapability(
  configured: boolean,
  probe: UserSystemdProbe = probeUserSystemd,
  environment = userSystemdEnvironment()
): Promise<SessionScopeCapability> {
  if (!configured) {
    return { configured: false, available: false, unavailableReason: "disabled", environment };
  }
  try {
    await probe(environment);
    return { configured: true, available: true, unavailableReason: null, environment };
  } catch {
    return { configured: true, available: false, unavailableReason: "user_systemd_unavailable", environment };
  }
}

export function sessionScopeName(capabilityId: string): string {
  return `muxpilot-session-${capabilityId}.scope`;
}

export function isMuxpilotSessionScope(scope: string | null | undefined): scope is string {
  return typeof scope === "string" && SESSION_SCOPE_PATTERN.test(scope);
}

export function isMuxpilotSessionResourceUnit(unit: string | null | undefined): unit is string {
  return typeof unit === "string" && (SESSION_SCOPE_PATTERN.test(unit) || SESSION_SERVICE_PATTERN.test(unit));
}

async function probeUserSystemd(environment: Record<string, string>): Promise<void> {
  const { stdout } = await execFileAsync("systemctl", [
    "--user", "show", "init.scope", "--property=Id", "--value"
  ], { timeout: 2000, env: { ...process.env, ...environment } });
  if (stdout.trim() !== "init.scope") throw new Error("user systemd init scope is unavailable");
}
