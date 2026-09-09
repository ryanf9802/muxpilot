import { describe, expect, it } from "vitest";
import type { ManagedSession } from "@muxpilot/core";
import { dashboardSessionSummary, sessionMatchesQuery } from "../src/api/routes.js";

describe("dashboard session summaries", () => {
  it("bounds dashboard-only text and omits dependency-link detail", () => {
    const session = testSession();
    session.recentUserPrompts = ["first", "x".repeat(600), "third"];
    session.activitySummary = "y".repeat(600);
    session.preview = "duplicate transcript preview";
    session.gitWorkspace = {
      id: "workspace-1",
      sessionId: session.id,
      mode: "git",
      entryPath: "/repo",
      repoRoot: "/repo",
      targetBranch: "main",
      workBranch: "work",
      worktreePath: "/worktree",
      baseCommit: "abc",
      state: "active",
      createdAt: "2026-09-08T00:00:00.000Z",
      updatedAt: "2026-09-08T00:00:00.000Z",
      dependencyLinks: [{ path: "node_modules", target: "/repo/node_modules", created: true }]
    };

    const summary = dashboardSessionSummary(session);

    expect(summary.preview).toBe("");
    expect(summary.recentUserPrompts).toEqual(["first", "x".repeat(512)]);
    expect(summary.activitySummary).toBe("y".repeat(512));
    expect(summary.gitWorkspace?.dependencyLinks).toEqual([]);
    expect(session.gitWorkspace.dependencyLinks).toHaveLength(1);
    expect(summary.provider).toEqual(session.provider);
    expect(summary).not.toHaveProperty("runtime");
    expect(summary).not.toHaveProperty("resourceUnit");
    expect(summary.codexJsonlPath).toBeNull();
    expect(summary.models).toEqual({
      default: { model: null, reasoningEffort: null },
      plan: { model: null, reasoningEffort: null }
    });
  });

  it("preserves completed children while suppressing their large preview fields", () => {
    const session = testSession();
    session.agentOwnership = {
      parentSessionId: "parent",
      rootSessionId: "parent",
      origin: "created",
      createdAt: "2026-09-08T00:00:00.000Z",
      workTokenBaseline: 0,
      workTokenBudget: 10_000,
      completedAt: "2026-09-08T01:00:00.000Z"
    };
    session.recentUserPrompts = ["large history"];
    session.activitySummary = "large summary";

    expect(dashboardSessionSummary(session)).toMatchObject({
      id: session.id,
      recentUserPrompts: [],
      activitySummary: null,
      agentOwnership: expect.objectContaining({
        parentSessionId: "parent",
        rootSessionId: "parent",
        completedAt: "2026-09-08T01:00:00.000Z"
      })
    });
  });

  it("searches the full source record before projection", () => {
    const session = testSession();
    session.name = "Architecture Refactor";
    session.cwd = "/workspace/teamweave";
    session.recentUserPrompts = ["needle beyond dashboard preview"];

    expect(sessionMatchesQuery(session, "architecture")).toBe(true);
    expect(sessionMatchesQuery(session, "teamweave")).toBe(true);
    expect(sessionMatchesQuery(session, "beyond dashboard")).toBe(true);
    expect(sessionMatchesQuery(session, "not present")).toBe(false);
  });
});

function testSession(): ManagedSession {
  return {
    id: "session-1",
    name: "Session",
    cwd: "/repo",
    provider: { kind: "codex", threadId: "codex-session", rolloutPath: "/tmp/codex.jsonl" },
    repo: { root: "/repo", name: "repo", branch: "main", dirty: false, worktree: null },
    codexSessionId: "codex-session",
    codexJsonlPath: null,
    discoveryConfidence: "high",
    status: "idle",
    lastActivityAt: null,
    preview: "",
    recentUserPrompts: [],
    activitySummary: null,
    activitySummaryGeneratedAt: null,
    activitySummarySourceSequence: null,
    inputMode: "default",
    models: { default: { model: null, reasoningEffort: null }, plan: { model: null, reasoningEffort: null } },
    transcriptSize: 0,
    unreadCount: 0,
    pinned: false,
    archived: false
  };
}
