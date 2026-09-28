import { describe, expect, it, vi } from "vitest";
import { ClaudeAuthObserver } from "../src/providers/claude/auth.js";
import { probeClaudeCompatibility, type ClaudeProbeExecutor } from "../src/providers/claude/compatibility.js";

function runner(status: Record<string, unknown>) {
  return vi.fn(async (_args: string[]) => JSON.stringify(status));
}

const SIGNED_IN = {
  loggedIn: true,
  authMethod: "claude.ai",
  apiProvider: "firstParty",
  email: "dev@example.com",
  orgId: "org-1",
  orgName: "Example Org",
  subscriptionType: "max"
};

describe("ClaudeAuthObserver", () => {
  it("reports a signed-out CLI with recovery guidance", async () => {
    const run = runner({ loggedIn: false });
    const observer = new ClaudeAuthObserver("/config/claude", run);
    await expect(observer.observe()).resolves.toEqual({
      status: "signed_out",
      account: null,
      principal: null,
      error: "Claude authentication is required. Run `claude auth login` on the muxpilot host, then return to muxpilot."
    });
    expect(run).toHaveBeenCalledWith(["auth", "status", "--json"]);
    expect(observer.credentialWatch).toEqual({ directory: "/config/claude", filenames: [".credentials.json", ".claude.json"] });
  });

  it("reports a ready account", async () => {
    const observation = await new ClaudeAuthObserver("/c", runner(SIGNED_IN)).observe();
    expect(observation).toMatchObject({
      status: "ready",
      account: { type: "claude.ai", email: "dev@example.com", planType: "max", organization: "Example Org" },
      error: null
    });
    expect(observation.principal).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps the principal stable across token refreshes but changes it with the account or organization", async () => {
    const principal = async (status: Record<string, unknown>) => (await new ClaudeAuthObserver("/c", runner(status)).observe()).principal;
    const base = await principal(SIGNED_IN);
    // Token refreshes and plan or display changes do not alter account identity.
    expect(await principal({ ...SIGNED_IN, accessTokenExpiresAt: 123, subscriptionType: "pro", orgName: "Renamed" })).toBe(base);
    expect(await principal({ ...SIGNED_IN, email: "other@example.com" })).not.toBe(base);
    expect(await principal({ ...SIGNED_IN, orgId: "org-2" })).not.toBe(base);
    expect(await principal({ ...SIGNED_IN, authMethod: "api_key" })).not.toBe(base);
    expect(await principal({ ...SIGNED_IN, apiProvider: "bedrock" })).not.toBe(base);
  });

  it("re-reads an OAuth login that transiently reports no account identity", async () => {
    const statuses = [{ loggedIn: true, authMethod: "claude.ai" }, { loggedIn: true, authMethod: "claude.ai" }, SIGNED_IN];
    const run = vi.fn(async () => JSON.stringify(statuses.shift() ?? SIGNED_IN));
    const sleep = vi.fn(async () => undefined);
    const observation = await new ClaudeAuthObserver("/c", run, sleep).observe();
    expect(run).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(observation.principal).toBe((await new ClaudeAuthObserver("/c", runner(SIGNED_IN)).observe()).principal);
    // API-key logins legitimately have no account identity and are not re-read.
    const apiKey = runner({ loggedIn: true, authMethod: "api_key" });
    await new ClaudeAuthObserver("/c", apiKey, sleep).observe();
    expect(apiKey).toHaveBeenCalledTimes(1);
  });

  it("fails when the CLI output is not JSON", async () => {
    await expect(new ClaudeAuthObserver("/c", async () => "not json").observe()).rejects.toThrow();
  });

  it("recognizes authentication errors", () => {
    const observer = new ClaudeAuthObserver("/c", runner({}));
    expect(observer.isAuthenticationError("Not logged in · Please run /login")).toBe(true);
    expect(observer.isAuthenticationError("OAuth token has expired")).toBe(true);
    expect(observer.isAuthenticationError("Invalid API key")).toBe(true);
    expect(observer.isAuthenticationError("socket hang up")).toBe(false);
    expect(observer.recoveryMessage("Expired.")).toBe("Expired. Sign in with `claude auth login` on the muxpilot host, then return to muxpilot.");
  });
});

function executor(overrides: Partial<{ available: string[]; version: string | Error; sdk: string | null }> = {}): ClaudeProbeExecutor {
  const available = overrides.available ?? ["claude", "bwrap", "socat"];
  return {
    resolveExecutable: vi.fn(async (command: string) => {
      const name = command.split("/").at(-1)!;
      return available.includes(name) ? `/usr/bin/${name}` : null;
    }),
    claudeVersion: vi.fn(async () => {
      if (overrides.version instanceof Error) throw overrides.version;
      return overrides.version ?? "2.1.300 (Claude Code)\n";
    }),
    sdkVersion: () => (overrides.sdk === undefined ? "0.3.283" : overrides.sdk)
  };
}

const now = () => new Date("2026-09-27T12:00:00.000Z");

describe("probeClaudeCompatibility", () => {
  it("is available when Claude Code, the SDK, and sandbox tools are present", async () => {
    const probe = executor();
    await expect(probeClaudeCompatibility(true, null, probe, now)).resolves.toEqual({
      provider: "claude",
      status: "available",
      available: true,
      version: "2.1.300",
      detail: "Claude Code, the Agent SDK, and sandbox dependencies are available.",
      checkedAt: "2026-09-27T12:00:00.000Z",
      missingCapabilities: [],
      claudePath: "/usr/bin/claude"
    });
    expect(probe.resolveExecutable).toHaveBeenCalledWith("claude");
  });

  it("uses a configured executable", async () => {
    const probe = executor();
    await probeClaudeCompatibility(true, "/opt/claude/bin/claude", probe, now);
    expect(probe.resolveExecutable).toHaveBeenCalledWith("/opt/claude/bin/claude");
  });

  it("requires user systemd", async () => {
    await expect(probeClaudeCompatibility(false, null, executor(), now)).resolves.toMatchObject({
      status: "user_systemd_unavailable",
      available: false,
      missingCapabilities: ["user-systemd"],
      claudePath: null
    });
  });

  it("reports a missing binary", async () => {
    await expect(probeClaudeCompatibility(true, null, executor({ available: ["bwrap", "socat"] }), now)).resolves.toMatchObject({
      status: "missing_binary",
      available: false,
      missingCapabilities: ["claude"],
      claudePath: null
    });
  });

  it("reports a failed health probe with the first error line", async () => {
    await expect(probeClaudeCompatibility(true, null, executor({ version: new Error("segfault\nstack") }), now)).resolves.toMatchObject({
      status: "failed_health_probe",
      detail: "Claude Code health probe failed: segfault",
      claudePath: "/usr/bin/claude"
    });
  });

  it("requires the Agent SDK", async () => {
    await expect(probeClaudeCompatibility(true, null, executor({ sdk: null }), now)).resolves.toMatchObject({
      status: "incompatible_protocol",
      version: "2.1.300",
      missingCapabilities: ["claude-agent-sdk"]
    });
  });

  it("is sandbox_unavailable when bubblewrap or socat is missing", async () => {
    const both = await probeClaudeCompatibility(true, null, executor({ available: ["claude"] }), now);
    expect(both).toMatchObject({ status: "sandbox_unavailable", available: false, missingCapabilities: ["bubblewrap", "socat"] });
    expect(both.detail).toContain("sudo apt install bubblewrap socat");
    await expect(probeClaudeCompatibility(true, null, executor({ available: ["claude", "bwrap"] }), now))
      .resolves.toMatchObject({ status: "sandbox_unavailable", missingCapabilities: ["socat"] });
    await expect(probeClaudeCompatibility(true, null, executor({ available: ["claude", "socat"] }), now))
      .resolves.toMatchObject({ status: "sandbox_unavailable", missingCapabilities: ["bubblewrap"] });
  });

  it("tolerates unparseable version output", async () => {
    await expect(probeClaudeCompatibility(true, null, executor({ version: "dev build" }), now)).resolves.toMatchObject({ status: "available", version: null });
  });
});
