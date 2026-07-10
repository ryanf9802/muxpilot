import { describe, expect, it } from "vitest";
import {
  codexCommandArgs,
  inputSubmitDelayMs,
  tmuxNewCodexResumeWindowArgs,
  tmuxNewCodexWindowArgs,
  tmuxPasteBufferArgs
} from "../src/tmux/tmuxAdapter.js";

describe("codexCommandArgs", () => {
  it("locks managed sessions to their worktree and carries inspection capabilities", () => {
    expect(codexCommandArgs("/tmp/worktree", {
      isolatedWorkspace: true,
      developerInstructions: "Use $muxpilot-git-workflow.",
      environment: { MUXPILOT_GIT_WORKSPACE_ID: "workspace-1" }
    })).toEqual([
      "env",
      "MUXPILOT_GIT_WORKSPACE_ID=workspace-1",
      "codex",
      "-C",
      "/tmp/worktree",
      "-s",
      "workspace-write",
      "-c",
      "sandbox_workspace_write.writable_roots=[]",
      "-c",
      "sandbox_workspace_write.network_access=true",
      "-c",
      'developer_instructions="Use $muxpilot-git-workflow."'
    ]);
  });
});

describe("inputSubmitDelayMs", () => {
  it("keeps short commands fast and gives larger pastes time to settle", () => {
    expect(inputSubmitDelayMs("hello")).toBe(80);
    expect(inputSubmitDelayMs("a".repeat(5108))).toBeGreaterThanOrEqual(700);
  });

  it("caps the delay for very large pasted input", () => {
    expect(inputSubmitDelayMs("a".repeat(200_000))).toBe(2500);
  });
});

describe("tmuxPasteBufferArgs", () => {
  it("uses bracketed paste and preserves newlines so Codex receives one complete paste event", () => {
    expect(tmuxPasteBufferArgs("muxpilot-123", "%7")).toEqual([
      "paste-buffer",
      "-d",
      "-p",
      "-r",
      "-b",
      "muxpilot-123",
      "-t",
      "%7"
    ]);
  });
});

describe("tmuxNewCodexWindowArgs", () => {
  it("targets the shared session without requesting the active window index", () => {
    const args = tmuxNewCodexWindowArgs("muxpilot", "/home/ryanf/workspace/teamweave", "make-warnings");

    expect(args).toEqual([
      "new-window",
      "-P",
      "-F",
      expect.any(String),
      "-t",
      "muxpilot:",
      "-n",
      "make-warnings",
      "-c",
      "/home/ryanf/workspace/teamweave",
      "codex"
    ]);
  });

  it("builds a Codex resume command for restorable sessions", () => {
    const args = tmuxNewCodexResumeWindowArgs("muxpilot", "/home/ryanf/workspace/muxpilot", "old-work", "codex-session-id");

    expect(args).toEqual([
      "new-window",
      "-P",
      "-F",
      expect.any(String),
      "-t",
      "muxpilot:",
      "-n",
      "old-work",
      "-c",
      "/home/ryanf/workspace/muxpilot",
      "codex",
      "resume",
      "codex-session-id"
    ]);
  });
});
