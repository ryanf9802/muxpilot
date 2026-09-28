import type { AgentProviderKind, ProviderAuthStatus, ProviderCapabilities, ProviderDescriptor } from "@muxpilot/core";

const capabilities: Record<AgentProviderKind, ProviderCapabilities> = {
  codex: {
    fastMode: true, reasoningEffort: true, planMode: true, steer: true, fork: true, btw: true, approvalReview: true, hibernate: true,
    terminalAttach: true, resetCredits: true, tokenUsageHistory: true, usageLimits: true, goals: true, backgroundTerminals: true,
    transcriptTransfer: true, imageInput: true, rawTranscriptEvidence: true
  },
  claude: {
    fastMode: true, reasoningEffort: true, planMode: true, steer: true, fork: true, btw: true, approvalReview: false, hibernate: true,
    terminalAttach: false, resetCredits: false, tokenUsageHistory: true, usageLimits: true, goals: false, backgroundTerminals: false,
    transcriptTransfer: true, imageInput: true, rawTranscriptEvidence: true
  }
};

/** A ready, installed provider descriptor for tests; override any field to model other states. */
export function providerDescriptor(
  kind: AgentProviderKind,
  overrides: Partial<Omit<ProviderDescriptor, "auth" | "compatibility">> & {
    auth?: Partial<ProviderDescriptor["auth"]>;
    authStatus?: ProviderAuthStatus;
    compatibility?: Partial<ProviderDescriptor["compatibility"]>;
  } = {}
): ProviderDescriptor {
  const { auth, authStatus, compatibility, ...rest } = overrides;
  return {
    kind,
    displayName: kind === "claude" ? "Claude" : "Codex",
    enabled: true,
    capabilities: capabilities[kind],
    skillInvocation: kind === "claude" ? { prefix: "/", position: "start" } : { prefix: "$", position: "anywhere" },
    loginCommand: kind === "claude" ? "claude auth login" : "codex login",
    ...rest,
    compatibility: {
      provider: kind,
      status: "available",
      available: true,
      version: "1.0.0",
      detail: "ready",
      checkedAt: "2026-09-01T12:00:00.000Z",
      missingCapabilities: [],
      ...compatibility
    },
    auth: {
      provider: kind,
      status: authStatus ?? "ready",
      account: null,
      revision: 1,
      observedAt: "2026-09-01T12:00:00.000Z",
      error: null,
      admissionHeld: false,
      pendingSessionIds: [],
      ...auth
    }
  };
}
