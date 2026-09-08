const HEAVY_EXECUTION_KEYS = [
  "MUXPILOT_HEAVY_BROKER_SOCKET",
  "MUXPILOT_HEAVY_BROKER_TOKEN",
  "MUXPILOT_HEAVY_COMPLETION_ENABLED",
  "MUXPILOT_HEAVY_QUEUE_ENABLED",
  "MUXPILOT_HEAVY_RUN_ID"
];

export function hostScopedRestartEnvironment(environment) {
  const direct = { ...environment };
  for (const key of HEAVY_EXECUTION_KEYS) delete direct[key];
  return direct;
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
