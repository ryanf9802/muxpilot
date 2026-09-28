import { describe, expect, it } from "vitest";
import {
  isAgentProviderKind,
  normalizeLegacySessionRecord,
  providerDisplayName,
  sessionThreadId,
  sessionTranscriptPath
} from "./provider.js";
import { sessionHistoryIdentity } from "./types.js";

describe("provider kinds", () => {
  it("recognizes supported providers only", () => {
    expect(isAgentProviderKind("codex")).toBe(true);
    expect(isAgentProviderKind("claude")).toBe(true);
    expect(isAgentProviderKind("gemini")).toBe(false);
    expect(isAgentProviderKind(undefined)).toBe(false);
    expect(providerDisplayName("claude")).toBe("Claude");
    expect(providerDisplayName("codex")).toBe("Codex");
  });
});

describe("normalizeLegacySessionRecord", () => {
  it("moves legacy Codex identity fields into the provider reference", () => {
    const normalized = normalizeLegacySessionRecord({
      id: "app-1",
      provider: { kind: "codex", threadId: null, rolloutPath: "/codex/rollout.jsonl" },
      runtime: { kind: "systemd_service", unit: "u", socketPath: "/s", state: "connected", codexVersion: "0.150.0" },
      codexSessionId: "thread-1",
      codexJsonlPath: "/codex/legacy.jsonl",
      forkedFrom: { codexSessionId: "thread-0", sessionId: "app-0", sessionName: "source" }
    });
    expect(normalized).toEqual({
      id: "app-1",
      provider: { kind: "codex", threadId: "thread-1", transcriptPath: "/codex/rollout.jsonl" },
      runtime: { kind: "systemd_service", unit: "u", socketPath: "/s", state: "connected", agentVersion: "0.150.0" },
      forkedFrom: { provider: "codex", threadId: "thread-0", sessionId: "app-0", sessionName: "source" }
    });
  });

  it("defaults records without a provider to Codex and uses the legacy transcript path", () => {
    const normalized = normalizeLegacySessionRecord({ id: "old", codexSessionId: "t", codexJsonlPath: "/p.jsonl" });
    expect((normalized as Record<string, unknown>).provider).toEqual({ kind: "codex", threadId: "t", transcriptPath: "/p.jsonl" });
    expect(sessionThreadId(normalized as never)).toBe("t");
    expect(sessionTranscriptPath(normalized as never)).toBe("/p.jsonl");
  });

  it("is idempotent for provider-neutral records", () => {
    const current = {
      id: "app-2",
      provider: { kind: "claude", threadId: "abc", transcriptPath: "/claude/abc.jsonl" },
      runtime: { kind: "systemd_service", unit: "u", socketPath: "/s", state: "connected", agentVersion: "2.1.0" },
      forkedFrom: { provider: "claude", threadId: "src", sessionId: null, sessionName: "src" }
    };
    expect(normalizeLegacySessionRecord(current)).toEqual(current);
    expect(normalizeLegacySessionRecord(normalizeLegacySessionRecord(current))).toEqual(current);
  });

  it("drops unusable fork origins", () => {
    expect(normalizeLegacySessionRecord({ forkedFrom: { sessionName: "x" } }).forkedFrom).toBeNull();
  });
});

describe("sessionHistoryIdentity", () => {
  it("keeps legacy Codex identities and scopes by provider", () => {
    expect(sessionHistoryIdentity({ sessionId: "s", provider: "codex", threadId: "t", gitWorkspace: null })).toBe("codex:t");
    expect(sessionHistoryIdentity({ sessionId: "s", provider: "claude", threadId: "t", gitWorkspace: null })).toBe("claude:t");
  });
});
