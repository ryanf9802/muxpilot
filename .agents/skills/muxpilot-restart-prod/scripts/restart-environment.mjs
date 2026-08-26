export function hostScopedHeavyEnvironment(environment) {
  return { ...environment, MUXPILOT_HEAVY_QUEUE_ENABLED: "0" };
}

const SESSION_SCOPE_PATTERN = /(?:^|\/)muxpilot-session-[a-f0-9]{24}\.scope(?:\/|$)/;
const RESTART_SCOPE_PATTERN = /(?:^|\/)muxpilot-prod-restart-\d+-[a-f0-9]{8}\.scope(?:\/|$)/;

export function isMuxpilotSessionCgroup(cgroup) {
  return SESSION_SCOPE_PATTERN.test(cgroup);
}

export function isRestartExecutionCgroup(cgroup) {
  return cgroup === "/init.scope" || RESTART_SCOPE_PATTERN.test(cgroup);
}

export function restartScopeUnitName(pid, suffix) {
  return `muxpilot-prod-restart-${pid}-${suffix}`;
}
