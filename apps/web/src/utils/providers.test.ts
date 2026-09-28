import { describe, expect, it } from "vitest";
import { providerDescriptor } from "../testing/providerFixtures.js";
import {
  formatUsageAccount,
  providerAuthStatusLabel,
  providerCompatibilityLabel,
  providerCreateAvailability,
  providerLabel,
  providerUnavailableReason,
  resolveInitialProvider,
  sessionProvider,
  sessionThreadId,
  shouldShowProviderBadges
} from "./providers.js";

describe("provider identity", () => {
  it("labels providers and defaults legacy sessions to Codex", () => {
    expect(providerLabel("claude")).toBe("Claude");
    expect(providerLabel("codex")).toBe("Codex");
    expect(sessionProvider({ provider: { kind: "claude" } })).toBe("claude");
    expect(sessionProvider({})).toBe("codex");
    expect(sessionProvider({ provider: { kind: "unknown" } })).toBe("codex");
    expect(sessionProvider(null)).toBe("codex");
    expect(sessionThreadId({ provider: { threadId: "thread-1", transcriptPath: null } })).toBe("thread-1");
    expect(sessionThreadId({})).toBeNull();
  });
});

describe("providerCreateAvailability", () => {
  it("allows a ready, installed provider", () => {
    expect(providerCreateAvailability(providerDescriptor("claude"))).toEqual({ selectable: true, blocking: null, warning: null, loginCommand: null });
  });

  it.each([
    ["missing descriptor", null, "Provider status could not be loaded."],
    ["disabled provider", providerDescriptor("claude", { enabled: false }), "Claude is disabled on this host."],
    ["missing binary", providerDescriptor("claude", { compatibility: { status: "missing_binary", available: false, detail: "claude not found" } }), "Claude is not installed on this host."],
    ["failed health probe", providerDescriptor("codex", { compatibility: { status: "failed_health_probe", available: false, detail: "Health probe timed out." } }), "Health probe timed out."]
  ])("blocks a %s without a login command", (_label, descriptor, blocking) => {
    expect(providerCreateAvailability(descriptor)).toEqual({ selectable: false, blocking, warning: null, loginCommand: null });
  });

  it.each([
    ["signed_out", "Claude is signed out. Run claude auth login on the host, then check again."],
    ["authentication_required", "Claude needs to sign in again. Run claude auth login on the host, then check again."]
  ] as const)("blocks %s providers and names the host login command", (authStatus, blocking) => {
    expect(providerCreateAvailability(providerDescriptor("claude", { authStatus }))).toEqual({
      selectable: false,
      blocking,
      warning: null,
      loginCommand: "claude auth login"
    });
  });

  it("keeps providers selectable with a warning while authentication is uncertain", () => {
    expect(providerCreateAvailability(providerDescriptor("codex", { authStatus: "checking" }))).toMatchObject({
      selectable: true,
      blocking: null,
      warning: "Checking Codex authentication…"
    });
    expect(providerCreateAvailability(providerDescriptor("codex", { auth: { status: "temporarily_unavailable", error: "network down" } }))).toMatchObject({
      selectable: true,
      blocking: null,
      warning: expect.stringContaining("network down")
    });
  });
});

describe("resolveInitialProvider", () => {
  const codex = providerDescriptor("codex");
  const claude = providerDescriptor("claude");
  const signedOutClaude = providerDescriptor("claude", { authStatus: "signed_out" });

  it("prefers the parent session provider, then the last used, then the server default", () => {
    expect(resolveInitialProvider({ parent: "claude", lastUsed: "codex", serverDefault: "codex", providers: [codex, claude] })).toBe("claude");
    expect(resolveInitialProvider({ parent: null, lastUsed: "claude", serverDefault: "codex", providers: [codex, claude] })).toBe("claude");
    expect(resolveInitialProvider({ parent: null, lastUsed: null, serverDefault: "claude", providers: [codex, claude] })).toBe("claude");
  });

  it("skips unselectable preferences and falls back to any selectable provider", () => {
    expect(resolveInitialProvider({ parent: "claude", lastUsed: "claude", serverDefault: "claude", providers: [codex, signedOutClaude] })).toBe("codex");
    expect(resolveInitialProvider({ parent: null, lastUsed: null, serverDefault: null, providers: [signedOutClaude, codex] })).toBe("codex");
  });

  it("keeps the strongest preference when nothing is selectable", () => {
    const signedOutCodex = providerDescriptor("codex", { authStatus: "signed_out" });
    expect(resolveInitialProvider({ parent: null, lastUsed: "claude", serverDefault: "codex", providers: [signedOutCodex, signedOutClaude] })).toBe("claude");
    expect(resolveInitialProvider({ providers: [] })).toBe("codex");
  });
});

describe("provider status copy", () => {
  it("describes runtime compatibility", () => {
    expect(providerCompatibilityLabel(providerDescriptor("codex", { compatibility: { version: "0.152.0" } }))).toBe("Codex 0.152.0 is available.");
    expect(providerCompatibilityLabel(providerDescriptor("codex", {
      compatibility: { status: "user_systemd_unavailable", available: false, version: null, detail: "A persistent user-systemd manager is required." }
    }))).toBe("A persistent user-systemd manager is required.");
    expect(providerCompatibilityLabel(null)).toBe("Provider status could not be loaded.");
    expect(providerUnavailableReason(providerDescriptor("claude"))).toBeNull();
    expect(providerUnavailableReason(providerDescriptor("claude", { compatibility: { status: "missing_binary", available: false } }))).toBe("Claude is not installed on this host.");
    expect(providerUnavailableReason(null, "claude")).toBe("Claude status could not be loaded.");
  });

  it("labels authentication states", () => {
    expect(providerAuthStatusLabel("ready")).toBe("Signed in");
    expect(providerAuthStatusLabel("signed_out")).toBe("Signed out");
    expect(providerAuthStatusLabel("authentication_required")).toBe("Sign-in required");
  });

  it("formats provider accounts", () => {
    expect(formatUsageAccount("codex", { kind: "chatgpt", email: "dev@example.com", planType: "plus" })).toBe("dev@example.com");
    expect(formatUsageAccount("codex", { kind: "chatgpt", email: null, planType: null })).toBe("ChatGPT");
    expect(formatUsageAccount("codex", { kind: "apiKey", email: null, planType: null })).toBe("API key");
    expect(formatUsageAccount("codex", { kind: "amazonBedrock", email: "x@example.com", planType: null })).toBe("Amazon Bedrock");
    expect(formatUsageAccount("claude", { kind: "claudeAi", email: null, planType: "max" })).toBe("Claude account");
    expect(formatUsageAccount("claude", null, "signed_out")).toBe("Not signed in");
    expect(formatUsageAccount("claude", null)).toBe("Account status unavailable");
  });
});

describe("shouldShowProviderBadges", () => {
  it("shows badges only when more than one provider is enabled or sessions mix providers", () => {
    const codexSession = { provider: { kind: "codex" } };
    const claudeSession = { provider: { kind: "claude" } };
    expect(shouldShowProviderBadges([providerDescriptor("codex")], [codexSession])).toBe(false);
    expect(shouldShowProviderBadges([providerDescriptor("codex"), providerDescriptor("claude")], [codexSession])).toBe(true);
    expect(shouldShowProviderBadges([providerDescriptor("codex"), providerDescriptor("claude", { enabled: false })], [codexSession])).toBe(false);
    expect(shouldShowProviderBadges([providerDescriptor("codex")], [codexSession, claudeSession])).toBe(true);
  });
});
