import { describe, expect, it } from "vitest";
import type { ManagedSession } from "@muxpilot/core";
import { ProviderRegistry, ProviderUnavailableError, UnknownProviderError } from "../src/providers/registry.js";
import { testProvider } from "./helpers/providers.js";

function session(kind: "codex" | "claude"): Pick<ManagedSession, "provider"> {
  return { provider: { kind, threadId: "t", transcriptPath: null } };
}

describe("ProviderRegistry", () => {
  it("routes sessions to their provider's driver", () => {
    const codexDriver = { kind: "codex" };
    const claudeDriver = { kind: "claude" };
    const registry = new ProviderRegistry([testProvider("codex", codexDriver), testProvider("claude", claudeDriver)], "claude");
    expect(registry.driverFor(session("codex"))).toBe(codexDriver);
    expect(registry.driverFor(session("claude"))).toBe(claudeDriver);
    expect(registry.defaultProvider()).toBe("claude");
    expect(registry.hasDrivers()).toBe(true);
  });

  it("fails closed for disabled and unavailable providers", () => {
    const registry = new ProviderRegistry([testProvider("codex", { kind: "codex" }), testProvider("claude", null)]);
    expect(() => registry.driverFor(session("claude"))).toThrow(ProviderUnavailableError);
    expect(() => registry.driverFor(session("claude"))).toThrow("Claude sessions are unavailable: unavailable in test");
    expect(() => new ProviderRegistry([testProvider("codex", null)]).driverFor(session("claude"))).toThrow(UnknownProviderError);
    expect(() => registry.get("gemini")).toThrow(UnknownProviderError);
  });

  it("falls back to an enabled default provider and rejects duplicates", () => {
    const registry = new ProviderRegistry([testProvider("claude", null)], "codex");
    expect(registry.defaultProvider()).toBe("claude");
    expect(() => registry.setDefaultProvider("codex")).toThrow(UnknownProviderError);
    expect(() => new ProviderRegistry([testProvider("codex", null), testProvider("codex", null)])).toThrow("already registered");
  });
});
