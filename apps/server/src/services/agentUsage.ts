import type { AgentSessionOwnership, SessionContextUsage } from "@muxpilot/core";

export function agentWorkTokensUsed(
  ownership: AgentSessionOwnership,
  usage: SessionContextUsage | null | undefined
): number {
  if (Number.isFinite(ownership.workTokensUsed)) return Math.max(0, ownership.workTokensUsed ?? 0);
  if (!usage || !sampleIsAfterOwnership(usage.sampledAt, ownership.createdAt)) return 0;
  return usage.lifetimeWorkTokens >= ownership.workTokenBaseline
    ? usage.lifetimeWorkTokens - ownership.workTokenBaseline
    : usage.lifetimeWorkTokens;
}

export function accountAgentWorkTokens(
  ownership: AgentSessionOwnership,
  usage: SessionContextUsage
): AgentSessionOwnership {
  const previousObserved = ownership.workTokenLastObserved;
  const previousSampledAt = ownership.workTokenLastSampledAt;
  const used = agentWorkTokensUsed(ownership, usage);
  if (!Number.isFinite(previousObserved) || !previousSampledAt) {
    if (!sampleIsAfterOwnership(usage.sampledAt, ownership.createdAt)) return ownership;
    return {
      ...ownership,
      workTokensUsed: used,
      workTokenLastObserved: usage.lifetimeWorkTokens,
      workTokenLastSampledAt: usage.sampledAt
    };
  }
  if (!isNewerSample(usage.sampledAt, previousSampledAt)) return ownership;
  const delta = usage.lifetimeWorkTokens >= previousObserved!
    ? usage.lifetimeWorkTokens - previousObserved!
    : usage.lifetimeWorkTokens;
  return {
    ...ownership,
    workTokensUsed: used + delta,
    workTokenLastObserved: usage.lifetimeWorkTokens,
    workTokenLastSampledAt: usage.sampledAt
  };
}

function sampleIsAfterOwnership(sampledAt: string, createdAt: string): boolean {
  const sampled = Date.parse(sampledAt);
  const created = Date.parse(createdAt);
  return Number.isFinite(sampled) && Number.isFinite(created) ? sampled > created : true;
}

function isNewerSample(candidate: string, previous: string): boolean {
  const candidateMs = Date.parse(candidate);
  const previousMs = Date.parse(previous);
  if (Number.isFinite(candidateMs) && Number.isFinite(previousMs)) return candidateMs > previousMs;
  return candidate > previous;
}
