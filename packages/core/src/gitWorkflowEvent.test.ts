import { describe, expect, it } from "vitest";
import {
  extractGitWorkflowEvents,
  gitWorkflowEventContext,
  gitWorkflowEventDirection,
  gitWorkflowEventSummary,
  normalizeGitWorkflowEvent,
  serializeGitWorkflowEvent
} from "./gitWorkflowEvent.js";

const created = {
  version: 1 as const,
  eventId: "mwf-012345abcdef",
  kind: "worktree_created" as const,
  operation: "begin" as const,
  workspaceId: "workspace-a",
  targetBranch: "main",
  sessionBranch: "muxpilot/workspace-a/task",
  worktreePath: "/tmp/task",
  skill: "$muxpilot-git-workflow" as const
};

describe("Git workflow transcript events", () => {
  it("round-trips a structured event", () => {
    const raw = serializeGitWorkflowEvent(created);
    expect(normalizeGitWorkflowEvent(raw)).toEqual({ event: created, rawText: raw });
    expect(gitWorkflowEventSummary(created)).toBe("Implementation worktree created");
    expect(gitWorkflowEventDirection(created)).toBe("Agent → Git");
    expect(gitWorkflowEventContext(created)).toBe("muxpilot/workspace-a/task → main");
  });

  it("extracts multiple events embedded in ordinary tool output", () => {
    const integrated = serializeGitWorkflowEvent({
      ...created,
      eventId: "mwf-fedcba654321",
      kind: "integration_completed",
      operation: "finish",
      targetSha: "0123456789abcdef",
      cleanup: "removed"
    });
    expect(extractGitWorkflowEvents(`before\n${serializeGitWorkflowEvent(created)}\n${integrated}\nafter`))
      .toHaveLength(2);
    expect(normalizeGitWorkflowEvent(`prefix\n${serializeGitWorkflowEvent(created)}`)).toBeNull();
  });

  it("rejects malformed and incomplete events", () => {
    expect(normalizeGitWorkflowEvent("<muxpilot_git_workflow>{\"version\":2}</muxpilot_git_workflow>"))
      .toBeNull();
    expect(normalizeGitWorkflowEvent(serializeGitWorkflowEvent({ ...created, sessionBranch: "" })))
      .toBeNull();
  });

  it("formats attention and failure events", () => {
    const blocked = {
      ...created,
      kind: "workflow_blocked" as const,
      operation: "finish" as const,
      error: "Target checkout has uncommitted changes"
    };
    expect(gitWorkflowEventSummary(blocked)).toBe("Git workflow blocked");
    expect(gitWorkflowEventDirection(blocked)).toBe("Git → Agent");
    expect(gitWorkflowEventContext(blocked, 16)).toBe("Target checkout…");
  });
});
