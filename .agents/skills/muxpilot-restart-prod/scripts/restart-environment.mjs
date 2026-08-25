export function hostScopedHeavyEnvironment(environment) {
  return { ...environment, MUXPILOT_HEAVY_QUEUE_ENABLED: "0" };
}
