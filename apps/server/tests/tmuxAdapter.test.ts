import { describe, expect, it } from "vitest";
import {
  codexCommandArgs,
  codexStartupActionFromCapture,
  codexStartupErrorFromCapture,
  composerContainsInput,
  composerHasInput,
  inputSubmitDelayMs,
  isCodexDirectoryTrustPrompt,
  parsePaneLine,
  TmuxAdapter,
  tmuxNewCodexForkWindowArgs,
  tmuxNewCodexResumeWindowArgs,
  tmuxNewCodexWindowArgs,
  tmuxPasteBufferArgs
} from "../src/tmux/tmuxAdapter.js";

describe("parsePaneLine", () => {
  it("captures the tmux server generation for stable managed identities", () => {
    const pane = parsePaneLine([
      "$3", "muxpilot", "@40", "1", "task", "%40", "0", "1", "/repo", "codex", "Codex", "1234", "120x40",
      "3156", "1783898706"
    ].join("\t"));

    expect(pane).toMatchObject({
      sessionId: "$3",
      windowId: "@40",
      paneId: "%40",
      serverPid: 3156,
      sessionCreatedAt: 1783898706
    });
  });
});

describe("codexCommandArgs", () => {
  it("launches managed sessions in a neutral root with scoped writable directories", () => {
    expect(codexCommandArgs("/tmp/control", {
      isolatedWorkspace: true,
      writableRoots: ["/tmp/implementation", "/repo/.git"],
      developerInstructions: "Use $muxpilot-git-workflow.",
      environment: { MUXPILOT_GIT_WORKSPACE_ID: "workspace-1" }
    })).toEqual([
      "bash",
      expect.stringMatching(/scripts\/codex-launcher\.sh$/),
      "--",
      "env",
      "MUXPILOT_GIT_WORKSPACE_ID=workspace-1",
      "codex",
      "-c",
      "check_for_update_on_startup=false",
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

describe("isCodexDirectoryTrustPrompt", () => {
  it("recognizes the Codex project trust gate", () => {
    expect(isCodexDirectoryTrustPrompt([
      "> You are in /home/dev/.muxpilot/sessions/example",
      "Do you trust the contents of this directory? Working with untrusted contents comes with higher risk of prompt injection.",
      "› 1. Yes, continue",
      "  2. No, quit",
      "Press enter to continue"
    ].join("\n"))).toBe(true);
  });

  it("does not mistake the normal Codex screen for a trust gate", () => {
    expect(isCodexDirectoryTrustPrompt(">_ OpenAI Codex\nWhat can I help you build?")).toBe(false);
  });
});

describe("codexStartupActionFromCapture", () => {
  const trustPrompt = [
    "> You are in /home/dev/.muxpilot/sessions/example",
    "Do you trust the contents of this directory?",
    "› 1. Yes, continue",
    "  2. No, quit",
    "Press enter to continue"
  ].join("\n");

  it("accepts the active Codex project trust gate", () => {
    expect(codexStartupActionFromCapture(trustPrompt)).toBe("accept_trust");
  });

  it("does not keep pressing Enter for a stale trust gate above the ready screen", () => {
    const capture = [
      trustPrompt,
      "╭─────────────────────╮",
      "│ >_ OpenAI Codex (v0.147.0) │",
      "│ model: gpt-5.6-sol medium   │",
      "╯─────────────────────╯",
      "› Explain this codebase",
      "  gpt-5.6-sol medium · Context 100% left"
    ].join("\n");

    expect(codexStartupActionFromCapture(capture)).toBe("ready");
  });

  it("accepts a current trust gate below stale ready-screen history", () => {
    expect(codexStartupActionFromCapture([">_ OpenAI Codex", trustPrompt].join("\n"))).toBe("accept_trust");
  });
});

describe("codexStartupErrorFromCapture", () => {
  it("classifies an exhausted local database lock without persisting raw terminal output", () => {
    const error = codexStartupErrorFromCapture([
      "Codex couldn't start because another Codex process is using its local data.",
      "database is locked: private terminal detail",
      "MUXPILOT_CODEX_STARTUP_FAILED code=1 attempts=3"
    ].join("\n"));

    expect(error).toMatchObject({ reason: "database_locked" });
    expect(error?.message).toContain("local data is locked");
    expect(error?.message).not.toContain("private terminal detail");
  });

  it("classifies other terminal startup failures and ignores retries", () => {
    expect(codexStartupErrorFromCapture("MUXPILOT_CODEX_STARTUP_RETRY attempt=1 code=1")).toBeNull();
    expect(codexStartupErrorFromCapture("failed\nMUXPILOT_CODEX_STARTUP_FAILED code=1 attempts=3"))
      .toMatchObject({ reason: "exited" });
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

describe("verified input transport", () => {
  it("recognizes wrapped composer input without mistaking an empty composer for input", () => {
    expect(composerContainsInput("› first line\n  second line", "first line\nsecond line")).toBe(true);
    expect(composerHasInput("› \n\n  gpt-5.6-sol · Context 100% left")).toBe(false);
    expect(composerContainsInput("› \n\n  Type yes to continue", "yes")).toBe(false);
    expect(composerHasInput("\u001b[1m›\u001b[0m \u001b[2mAsk Codex to do anything\u001b[0m")).toBe(false);
    expect(composerContainsInput("\u001b[1m›\u001b[0m actual input", "actual input")).toBe(true);
    expect(composerContainsInput("› open \u001b]8;;https://example.com\u001b\\https://example.com\u001b]8;;\u001b\\", "open https://example.com")).toBe(true);
  });

  it("replays a paste once when Codex does not display the first paste", async () => {
    const adapter = new TmuxAdapter(["Enter"], { pasteVerifyTimeoutMs: 0, submitVerifyMs: 0, pollMs: 0 });
    let pasteCount = 0;
    let composer = "";
    const submits: string[][] = [];
    adapter.pasteText = async (_paneId, text) => {
      pasteCount += 1;
      if (pasteCount > 1) composer = text;
    };
    adapter.capturePane = async () => `› ${composer}`;
    adapter.sendKeys = async (_paneId, keys) => {
      submits.push(keys);
      composer = "";
    };

    await expect(adapter.sendInput("%1", "recover this prompt")).resolves.toEqual({
      pasteReplayCount: 1,
      submitKeyRetryCount: 0
    });
    expect(pasteCount).toBe(2);
    expect(submits).toEqual([["Enter"]]);
  });

  it("refuses to append input to an existing composer draft", async () => {
    const adapter = new TmuxAdapter(["Enter"], { pasteVerifyTimeoutMs: 0, submitVerifyMs: 0, pollMs: 0 });
    let pasted = false;
    adapter.capturePane = async () => "› existing draft";
    adapter.pasteText = async () => { pasted = true; };

    await expect(adapter.sendInput("%1", "new prompt")).rejects.toMatchObject({ reason: "composer_changed" });
    expect(pasted).toBe(false);
  });

  it("retries Enter when the submitted prompt remains composed", async () => {
    const adapter = new TmuxAdapter(["Enter"], { pasteVerifyTimeoutMs: 0, submitVerifyMs: 0, pollMs: 0 });
    let composer = "";
    const submits: string[][] = [];
    adapter.pasteText = async (_paneId, text) => { composer = text; };
    adapter.capturePane = async () => `› ${composer}`;
    adapter.sendKeys = async (_paneId, keys) => {
      submits.push(keys);
      if (submits.length > 1) composer = "";
    };

    await expect(adapter.sendInput("%1", "submit this prompt")).resolves.toEqual({
      pasteReplayCount: 0,
      submitKeyRetryCount: 1
    });
    expect(submits).toEqual([["Enter"], ["Enter"]]);
  });

  it("does not retry Enter after Codex visibly starts the turn", async () => {
    const adapter = new TmuxAdapter(["Enter"], { pasteVerifyTimeoutMs: 0, submitVerifyMs: 0, pollMs: 0 });
    let composer = "";
    const submits: string[][] = [];
    adapter.pasteText = async (_paneId, text) => { composer = text; };
    adapter.capturePane = async () => `› ${composer}\nWorking (esc to interrupt)`;
    adapter.sendKeys = async (_paneId, keys) => { submits.push(keys); };

    await expect(adapter.sendInput("%1", "already accepted")).resolves.toEqual({
      pasteReplayCount: 0,
      submitKeyRetryCount: 0
    });
    expect(submits).toEqual([["Enter"]]);
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
      "bash",
      expect.stringMatching(/scripts\/codex-launcher\.sh$/),
      "--",
      "codex",
      "-c",
      "check_for_update_on_startup=false"
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
      "bash",
      expect.stringMatching(/scripts\/codex-launcher\.sh$/),
      "--",
      "codex",
      "-c",
      "check_for_update_on_startup=false",
      "resume",
      "codex-session-id"
    ]);
  });

  it("builds a native Codex fork command for branched sessions", () => {
    const args = tmuxNewCodexForkWindowArgs("muxpilot", "/home/dev/workspace/example", "old-work-fork", "codex-session-id");

    expect(args).toEqual([
      "new-window",
      "-P",
      "-F",
      expect.any(String),
      "-t",
      "muxpilot:",
      "-n",
      "old-work-fork",
      "-c",
      "/home/dev/workspace/example",
      "bash",
      expect.stringMatching(/scripts\/codex-launcher\.sh$/),
      "--",
      "codex",
      "-c",
      "check_for_update_on_startup=false",
      "fork",
      "codex-session-id"
    ]);
  });
});
