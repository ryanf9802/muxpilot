import { describe, expect, it } from "vitest";
import {
  codexCommandArgs,
  inputSubmitDelayMs,
  tmuxNewCodexResumeWindowArgs,
  tmuxNewCodexWindowArgs,
  tmuxPasteBufferArgs
} from "../src/tmux/tmuxAdapter.js";

describe("codexCommandArgs", () => {
  it("launches managed sessions in a neutral root with scoped writable directories", () => {
    expect(codexCommandArgs("/tmp/control", {
      isolatedWorkspace: true,
      writableRoots: ["/tmp/implementation", "/repo/.git"],
      developerInstructions: "Use $muxpilot-git-workflow.",
      environment: { MUXPILOT_GIT_WORKSPACE_ID: "workspace-1" }
    })).toEqual([
      "env",
      "MUXPILOT_GIT_WORKSPACE_ID=workspace-1",
      "codex",
      "-c",
      'projects."/tmp/control".trust_level="trusted"',
      "-C",
      "/tmp/control",
      "-s",
      "workspace-write",
      "-c",
      "sandbox_workspace_write.writable_roots=[]",
      "-c",
      "sandbox_workspace_write.network_access=true",
      "--add-dir",
      "/tmp/implementation",
      "--add-dir",
      "/repo/.git",
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
    const args = tmuxNewCodexWindowArgs("muxpilot", "/home/dev/workspace/example", "make-warnings");

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
      "/home/dev/workspace/example",
      "codex",
      "-c",
      'projects."/home/dev/workspace/example".trust_level="trusted"'
    ]);
  });

  it("builds a Codex resume command for restorable sessions", () => {
    const args = tmuxNewCodexResumeWindowArgs("muxpilot", "/home/dev/workspace/example", "old-work", "codex-session-id");

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
      "/home/dev/workspace/example",
      "codex",
      "-c",
      'projects."/home/dev/workspace/example".trust_level="trusted"',
      "resume",
      "codex-session-id"
    ]);
  });
});
