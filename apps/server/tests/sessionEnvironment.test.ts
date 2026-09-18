import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ManagedSession } from "@muxpilot/core";
import type { AppDatabase } from "../src/db/database.js";
import { SessionEnvironmentError, SessionEnvironmentService } from "../src/services/sessionEnvironment.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("SessionEnvironmentService", () => {
  it("stores write-only encrypted values and resolves parent inheritance with local overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-session-env-")); roots.push(root);
    const sessions = new Map<string, ManagedSession>([
      ["parent", session("parent")],
      ["child", session("child", "parent")]
    ]);
    const service = new SessionEnvironmentService(database(sessions), root);
    await service.initialize();
    await service.set("parent", "PAYLOCITY_SECRET", "parent-secret-value");
    const inherited = await service.describe("child");
    expect(inherited.variables).toEqual([expect.objectContaining({ name: "PAYLOCITY_SECRET", ownerSessionId: "parent", inherited: true })]);
    expect(JSON.stringify(inherited)).not.toContain("parent-secret-value");
    expect(await service.resolve("child")).toEqual({ PAYLOCITY_SECRET: "parent-secret-value" });

    await service.set("child", "PAYLOCITY_SECRET", "child-secret-value");
    expect(await service.resolve("child")).toEqual({ PAYLOCITY_SECRET: "child-secret-value" });
    const persisted = await readFile(join(root, "secrets", "session-environment.json"), "utf8");
    expect(persisted).not.toContain("parent-secret-value");
    expect(persisted).not.toContain("child-secret-value");
  });

  it("rejects reserved names and refuses to regenerate a missing key", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-session-env-")); roots.push(root);
    const sessions = new Map([["session", session("session")]]);
    const service = new SessionEnvironmentService(database(sessions), root);
    await service.initialize();
    await expect(service.set("session", "MUXPILOT_DOCUMENTS_DIR", "wrong")).rejects.toBeInstanceOf(SessionEnvironmentError);
    await service.set("session", "CLIENT_SECRET", "secret-value");
    await rm(join(root, "secrets", "session-environment.key"));
    await expect(new SessionEnvironmentService(database(sessions), root).initialize()).rejects.toThrow(/key is missing/i);
  });
});

function database(sessions: Map<string, ManagedSession>): AppDatabase {
  return { getSession: async (id: string) => sessions.get(id) ?? null } as AppDatabase;
}

function session(id: string, parentSessionId: string | null = null): ManagedSession {
  return {
    id, name: id, cwd: "/tmp", provider: { kind: "codex", threadId: id, rolloutPath: null },
    repo: { root: "/tmp", name: "test", branch: null }, codexSessionId: id, codexJsonlPath: null,
    discoveryConfidence: "high", status: "idle", lastActivityAt: null, preview: "", recentUserPrompts: [],
    approvalMode: "ask", inputMode: "default", models: { default: { model: null, reasoningEffort: null }, plan: { model: null, reasoningEffort: null } },
    transcriptSize: 0, unreadCount: 0, pinned: false, archived: false,
    ...(parentSessionId ? { agentOwnership: { parentSessionId, rootSessionId: parentSessionId, origin: "created", createdAt: new Date(0).toISOString(), workTokenBaseline: 0, workTokensUsed: 0, workTokenBudget: 1, completedAt: null, budgetExhaustedAt: null } } : {})
  };
}
