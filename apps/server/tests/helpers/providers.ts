import type { AgentProviderKind, ProviderCapabilities } from "@muxpilot/core";
import { ProviderRegistry } from "../../src/providers/registry.js";
import type { AgentProvider, AgentSessionDriver } from "../../src/providers/types.js";

export const TEST_CAPABILITIES: ProviderCapabilities = {
  fastMode: true,
  reasoningEffort: true,
  planMode: true,
  steer: true,
  fork: true,
  btw: true,
  approvalReview: true,
  hibernate: true,
  terminalAttach: true,
  resetCredits: false,
  tokenUsageHistory: false,
  usageLimits: true,
  goals: false,
  backgroundTerminals: true,
  transcriptTransfer: true,
  imageInput: true,
  rawTranscriptEvidence: false
};

/** A scripted provider for SessionManager and route tests. */
export function testProvider(
  kind: AgentProviderKind,
  driver: unknown | null,
  overrides: Partial<AgentProvider> = {}
): AgentProvider {
  return {
    kind,
    displayName: kind === "claude" ? "Claude" : "Codex",
    capabilities: TEST_CAPABILITIES,
    skillInvocation: kind === "claude" ? { prefix: "/", position: "start" } : { prefix: "$", position: "anywhere" },
    compatibility: () => ({
      provider: kind,
      status: driver ? "available" : "failed_health_probe",
      available: Boolean(driver),
      version: null,
      detail: driver ? "ready" : "unavailable in test",
      checkedAt: "2026-09-27T00:00:00.000Z",
      missingCapabilities: []
    }),
    driver: driver as AgentSessionDriver | null,
    ...overrides
  };
}

/** Registry with a single Codex provider backed by `driver` (or none). */
export function testProviders(driver: unknown | null = null, extra: AgentProvider[] = []): ProviderRegistry {
  return new ProviderRegistry([testProvider("codex", driver), ...extra], "codex");
}
