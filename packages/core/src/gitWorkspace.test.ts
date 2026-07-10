import { describe, expect, it } from "vitest";
import { normalizeGitWorkspaceSummary } from "./types.js";

describe("normalizeGitWorkspaceSummary", () => {
  it("neutralizes obsolete workspace state and errors", () => {
    expect(normalizeGitWorkspaceSummary({
      id: "legacy",
      state: "error",
      targetBranch: "main",
      targetSha: "a".repeat(40),
      sessionBranch: "muxpilot/legacy",
      worktreePath: "/tmp/legacy",
      lastError: "Revision HEAD does not resolve"
    })).toMatchObject({
      workflowVersion: 1,
      state: "idle",
      targetBranch: "main",
      sessionBranch: null,
      worktreePath: null,
      lastError: null
    });
  });

  it("preserves actionable errors from the current workflow", () => {
    expect(normalizeGitWorkspaceSummary({
      workflowVersion: 1,
      id: "current",
      state: "blocked",
      entryPath: "/repo",
      repoRoot: "/repo",
      targetBranch: "main",
      targetSha: "b".repeat(40),
      sessionBranch: "muxpilot/current",
      worktreePath: "/tmp/current",
      lastError: "Target checkout is dirty",
      updatedAt: "2026-07-10T00:00:00.000Z",
      dependencyLinks: []
    })).toMatchObject({ state: "blocked", lastError: "Target checkout is dirty" });
  });
});
