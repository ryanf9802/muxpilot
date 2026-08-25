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
  it("launches session tooling inside its own resource scope", () => {
    expect(codexCommandArgs("/tmp/control", {
      resourceScopeName: "muxpilot-session-child.scope",
      resourceScopeEnvironment: {
        XDG_RUNTIME_DIR: "/run/user/1000",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus"
      },
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      fastMode: true,
      mcpServers: [{ name: "muxpilot_sessions", command: "/usr/bin/node", args: ["/app/mcp.mjs", "/run/capability.json"] }]
    })).toEqual([
      "env",
      "XDG_RUNTIME_DIR=/run/user/1000",
      "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus",
      "systemd-run",
      "--user",
      "--scope",
      "--quiet",
      "--collect",
      "--unit=muxpilot-session-child.scope",
      "bash",
      expect.stringMatching(/scripts\/codex-launcher\.sh$/),
      "--",
      "codex",
      "-c",
      "check_for_update_on_startup=false",
      "-m",
      "gpt-5.6-sol",
      "-c",
      'model_reasoning_effort="high"',
      "-c",
      'service_tier="priority"',
      "-c",
      'mcp_servers.muxpilot_sessions.command="/usr/bin/node"',
      "-c",
      'mcp_servers.muxpilot_sessions.args=["/app/mcp.mjs","/run/capability.json"]'
    ]);
  });

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

  it("recognizes the current Codex ready footer", () => {
    const capture = [
      "› Ask Codex to do anything",
      "  gpt-5.6-sol medium · ~/.muxpilot/sessions/example · Ready"
    ].join("\n");

    expect(codexStartupActionFromCapture(capture)).toBe("ready");
  });

  it("accepts a current trust gate below stale ready-screen history", () => {
    const staleReadyScreen = [
      ">_ OpenAI Codex",
      "› Ask Codex to do anything",
      "  gpt-5.6-sol medium · ~/.muxpilot/sessions/old · Ready"
    ].join("\n");

    expect(codexStartupActionFromCapture([staleReadyScreen, trustPrompt].join("\n"))).toBe("accept_trust");
  });

  it("does not treat ordinary ready text as the Codex ready footer", () => {
    expect(codexStartupActionFromCapture("The task is ready for review.\nStatus · Ready")).toBe("wait");
  });

  it("waits through the transient Codex header shown before the trust gate", () => {
    const capture = [
      "╭─────────────────────╮",
      "│ >_ OpenAI Codex (v0.149.1) │",
      "│ model: loading              │",
      "╰─────────────────────╯",
      "› Ask Codex to do anything",
      "  ? for shortcuts"
    ].join("\n");

    expect(codexStartupActionFromCapture(capture)).toBe("wait");
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

  it("recognizes collapsed Codex paste placeholders only when their character counts match", () => {
    expect(composerContainsInput("› [Pasted Content 1028 chars]", `${"a".repeat(1027)} `)).toBe(true);
    expect(composerContainsInput("› [Pasted Content 4086 chars][Pasted Content 1022 chars]", "a".repeat(5108))).toBe(true);
    expect(composerContainsInput("› [Pasted Content 1027 chars]", "a".repeat(1028))).toBe(false);
    expect(composerContainsInput("› before [Pasted Content 1021 chars]", "a".repeat(1028))).toBe(false);
  });

  it("ignores the matching slash-command suggestion below the composer", () => {
    const capture = "› /fast\n \n  /fast  1.5x speed, increased usage\n \n  gpt-5.6-sol medium · Context 80% left";

    expect(composerContainsInput(capture, "/fast ")).toBe(true);
    expect(composerContainsInput(capture, "/slow ")).toBe(false);
  });

  it("recognizes a long prompt across terminal hard-wrap boundaries", () => {
    const prefix = "Use the new teamweave database skill. ";
    const filler = "attributes and filters ".repeat(20);
    const suffix = "before we $generate-custom-integration-requirements";
    const prompt = `${prefix}${filler}${suffix}`;
    const capture = `› ${prefix}${filler}\n  before we $generate-\n  custom-integration-requirements`;

    expect(composerContainsInput(capture, prompt)).toBe(true);
  });

  it("recognizes a medium prompt when terminal wrapping splits a token", () => {
    const prompt = `${"review this change carefully ".repeat(7)}$muxpilot-git-workflow`;
    expect(prompt.length).toBeLessThanOrEqual(256);
    const capture = `› ${prompt.slice(0, 74)}\n  ${prompt.slice(74, 149)}\n  ${prompt.slice(149)}`;

    expect(composerContainsInput(capture, prompt)).toBe(true);
  });

  it("preserves blank lines inside multiline composer input", () => {
    const prompt = [
      "create new branch off up-to-date origin/dev `tw-1228-gantt-bar-weights-edges` to implement this",
      "",
      "teamweave/ui gantt chart with show weight active, non-full edges of the assignment bars do not receive the editable weight unless they fill a full cell. We need to make it so that we can see and edit the weight for these incomplete edges "
    ].join("\n");
    const capture = [
      "› create new branch off up-to-date origin/dev `tw-1228-gantt-bar-weights-edges`",
      "  to implement this",
      " ",
      "  teamweave/ui gantt chart with show weight active, non-full edges of the",
      "  assignment bars do not receive the editable weight unless they fill a full",
      "  cell. We need to make it so that we can see and edit the weight for these",
      "  incomplete edges",
      " ",
      "  gpt-5.6-sol high fast · Context 100% left · Plan mode"
    ].join("\n");

    expect(prompt.length).toBeGreaterThan(256);
    expect(composerContainsInput(capture, prompt)).toBe(true);
  });

  it("does not treat a longer composer draft as the expected prompt", () => {
    expect(composerContainsInput("› preserved prompt with appended text", "preserved prompt")).toBe(false);
  });

  it("ignores autocomplete suggestions below a standalone slash command", () => {
    const capture = [
      "• Working (esc to interrupt)",
      "",
      "› /fast",
      "",
      "  /fast  1.5x speed, increased usage"
    ].join("\n");

    expect(composerContainsInput(capture, "/fast")).toBe(true);
    expect(composerContainsInput(capture, "/slow")).toBe(false);
  });

  it("ignores status content below the composer separator", () => {
    const prompt = "preserved prompt that wraps across a terminal line";
    const capture = `› preserved prompt that wraps\n  across a terminal line\n\n  gpt-5.6-sol · Context 100% left`;

    expect(composerContainsInput(capture, prompt)).toBe(true);
    expect(composerContainsInput(`› ${prompt}\n  gpt-5.6-sol · Context 100% left`, prompt)).toBe(true);
  });

  it("replays a paste once when Codex does not display the first paste", async () => {
    const adapter = new TmuxAdapter(["Enter"], { pasteVerifyTimeoutMs: 0, pasteSettleMs: 0, submitVerifyMs: 0, pollMs: 0 });
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

  it("does not replay a paste when an unverified draft is visible", async () => {
    const adapter = new TmuxAdapter(["Enter"], { pasteVerifyTimeoutMs: 0, pasteSettleMs: 0, submitVerifyMs: 0, pollMs: 0 });
    let pasteCount = 0;
    let captureCount = 0;
    adapter.pasteText = async () => { pasteCount += 1; };
    adapter.capturePane = async () => captureCount++ === 0 ? "› " : "› unexpected visible draft";

    await expect(adapter.sendInput("%1", "expected prompt")).rejects.toMatchObject({ reason: "composer_changed" });
    expect(pasteCount).toBe(1);
  });

  it("refuses to append input to an existing composer draft", async () => {
    const adapter = new TmuxAdapter(["Enter"], { pasteVerifyTimeoutMs: 0, pasteSettleMs: 0, submitVerifyMs: 0, pollMs: 0 });
    let pasted = false;
    adapter.capturePane = async () => "› existing draft";
    adapter.pasteText = async () => { pasted = true; };

    await expect(adapter.sendInput("%1", "new prompt")).rejects.toMatchObject({ reason: "composer_changed" });
    expect(pasted).toBe(false);
  });

  it("retries Enter when the submitted prompt remains composed", async () => {
    const adapter = new TmuxAdapter(["Enter"], { pasteVerifyTimeoutMs: 0, pasteSettleMs: 0, submitVerifyMs: 0, pollMs: 0 });
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

  it("submits a slash command while its autocomplete suggestion is visible", async () => {
    const adapter = new TmuxAdapter(["Enter"], { pasteVerifyTimeoutMs: 0, pasteSettleMs: 0, submitVerifyMs: 0, pollMs: 0 });
    let composer = "";
    const submits: string[][] = [];
    adapter.pasteText = async (_paneId, text) => { composer = text; };
    adapter.capturePane = async () => composer
      ? `• Working (esc to interrupt)\n\n› ${composer}\n\n  /fast  1.5x speed, increased usage`
      : "› ";
    adapter.sendKeys = async (_paneId, keys) => {
      submits.push(keys);
      composer = "";
    };

    await expect(adapter.sendInput("%1", "/fast")).resolves.toEqual({
      pasteReplayCount: 0,
      submitKeyRetryCount: 0
    });
    expect(submits).toEqual([["Enter"]]);
  });

  it("does not retry Enter after Codex visibly starts the turn", async () => {
    const adapter = new TmuxAdapter(["Enter"], { pasteVerifyTimeoutMs: 0, pasteSettleMs: 0, submitVerifyMs: 0, pollMs: 0 });
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

  it("submits matching text already preserved in the composer without pasting", async () => {
    const adapter = new TmuxAdapter(["Enter"], { pasteSettleMs: 0, submitVerifyMs: 0 });
    let composer = "preserved prompt";
    let pasted = false;
    const submits: string[][] = [];
    adapter.capturePane = async () => `› ${composer}`;
    adapter.pasteText = async () => { pasted = true; };
    adapter.sendKeys = async (_paneId, keys) => {
      submits.push(keys);
      composer = "";
    };

    await expect(adapter.submitComposedInput("%1", "preserved prompt")).resolves.toEqual({
      pasteReplayCount: 0,
      submitKeyRetryCount: 0
    });
    expect(pasted).toBe(false);
    expect(submits).toEqual([["Enter"]]);
  });

  it("refuses to submit different preserved composer text", async () => {
    const adapter = new TmuxAdapter(["Enter"], { pasteSettleMs: 0, submitVerifyMs: 0 });
    const submits: string[][] = [];
    adapter.capturePane = async () => "› another draft";
    adapter.sendKeys = async (_paneId, keys) => { submits.push(keys); };

    await expect(adapter.submitComposedInput("%1", "preserved prompt")).rejects.toMatchObject({
      reason: "composer_changed"
    });
    expect(submits).toEqual([]);
  });

  it("submits a collapsed paste placeholder without replaying the paste", async () => {
    const adapter = new TmuxAdapter(["Enter"], { pasteSettleMs: 0, pasteVerifyTimeoutMs: 0, submitVerifyMs: 0, pollMs: 0 });
    const prompt = "a".repeat(1028);
    let composer = "";
    let pasteCount = 0;
    const submits: string[][] = [];
    adapter.pasteText = async (_paneId, text) => {
      pasteCount += 1;
      composer = `[Pasted Content ${text.length} chars]`;
    };
    adapter.capturePane = async () => `› ${composer}`;
    adapter.sendKeys = async (_paneId, keys) => {
      submits.push(keys);
      composer = "";
    };

    await expect(adapter.sendInput("%1", prompt)).resolves.toEqual({
      pasteReplayCount: 0,
      submitKeyRetryCount: 0
    });
    expect(pasteCount).toBe(1);
    expect(submits).toEqual([["Enter"]]);
  });

  it("submits an already composed matching placeholder without pasting again", async () => {
    const adapter = new TmuxAdapter(["Enter"], { pasteSettleMs: 0, pasteVerifyTimeoutMs: 0, submitVerifyMs: 0, pollMs: 0 });
    const prompt = "a".repeat(1028);
    let composer = `[Pasted Content ${prompt.length} chars]`;
    let pasteCount = 0;
    const submits: string[][] = [];
    adapter.capturePane = async () => `› ${composer}`;
    adapter.pasteText = async () => { pasteCount += 1; };
    adapter.sendKeys = async (_paneId, keys) => {
      submits.push(keys);
      composer = "";
    };

    await expect(adapter.submitComposedInput("%1", prompt)).resolves.toEqual({
      pasteReplayCount: 0,
      submitKeyRetryCount: 0
    });
    expect(pasteCount).toBe(0);
    expect(submits).toEqual([["Enter"]]);
  });

  it("does not submit an existing matching placeholder outside a retry", async () => {
    const adapter = new TmuxAdapter(["Enter"], { pasteSettleMs: 0, pasteVerifyTimeoutMs: 0, submitVerifyMs: 0, pollMs: 0 });
    const prompt = "a".repeat(1028);
    let pasted = false;
    adapter.capturePane = async () => `› [Pasted Content ${prompt.length} chars]`;
    adapter.pasteText = async () => { pasted = true; };

    await expect(adapter.sendInput("%1", prompt)).rejects.toMatchObject({ reason: "composer_changed" });
    expect(pasted).toBe(false);
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
