import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { TmuxPane } from "@muxpilot/core";

const execFileAsync = promisify(execFile);
const SEP = "\t";
const MIN_INPUT_SUBMIT_DELAY_MS = 80;
const MAX_INPUT_SUBMIT_DELAY_MS = 2500;
const INPUT_PASTE_VERIFY_MIN_MS = 500;
const INPUT_SUBMIT_VERIFY_MS = 500;
const INPUT_VERIFY_POLL_MS = 50;
const CODEX_STARTUP_POLL_INTERVAL_MS = 50;
const CODEX_STARTUP_TIMEOUT_MS = 60_000;
const CODEX_STARTUP_CAPTURE_FAILURE_LIMIT = 20;
const CODEX_STARTUP_FAILED_MARKER = "MUXPILOT_CODEX_STARTUP_FAILED";
const CODEX_LAUNCHER_PATH = fileURLToPath(new URL("../../../../scripts/codex-launcher.sh", import.meta.url));
const PANE_FORMAT = [
  "#{session_id}",
  "#{session_name}",
  "#{window_id}",
  "#{window_index}",
  "#{window_name}",
  "#{pane_id}",
  "#{pane_index}",
  "#{pane_active}",
  "#{pane_current_path}",
  "#{pane_current_command}",
  "#{pane_title}",
  "#{pane_pid}",
  "#{pane_width}x#{pane_height}",
  "#{pid}",
  "#{session_created}"
].join(SEP);

export interface CodexLaunchOptions {
  isolatedWorkspace?: boolean;
  writableRoots?: string[];
  developerInstructions?: string;
  environment?: Record<string, string>;
}

export interface CodexPaneLaunch {
  pane: TmuxPane;
  ready: Promise<void>;
}

export type CodexContinuation = { mode: "resume" | "fork"; sessionId: string };

export class CodexStartupError extends Error {
  constructor(message: string, readonly reason: "database_locked" | "exited" | "pane_closed" | "timeout") {
    super(message);
    this.name = "CodexStartupError";
  }
}

export interface InputTransportResult {
  pasteReplayCount: number;
  submitKeyRetryCount: number;
}

export interface InputVerificationOptions {
  pasteVerifyTimeoutMs?: number;
  submitVerifyMs?: number;
  pollMs?: number;
}

export class InputTransportError extends Error {
  constructor(
    message: string,
    readonly reason: "paste_not_observed" | "composer_changed" | "tmux_failed",
    readonly result: InputTransportResult
  ) {
    super(message);
    this.name = "InputTransportError";
  }
}

export class TmuxAdapter {
  constructor(
    private readonly inputSubmitKeys: string[] = ["Enter"],
    private readonly inputVerification: InputVerificationOptions = {}
  ) {}

  async listPanes(): Promise<TmuxPane[]> {
    const { stdout } = await execFileAsync("tmux", ["list-panes", "-a", "-F", PANE_FORMAT]);
    return stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(parsePaneLine);
  }

  async createCodexWindowInMuxpilotSession(cwd: string, name: string, options: CodexLaunchOptions = {}): Promise<CodexPaneLaunch> {
    if (await this.hasSession("muxpilot")) return this.createCodexWindow("muxpilot", cwd, name, options);
    return this.createMuxpilotSession(cwd, name, options);
  }

  async createCodexResumeWindowInMuxpilotSession(cwd: string, name: string, codexSessionId: string, options: CodexLaunchOptions = {}): Promise<CodexPaneLaunch> {
    if (await this.hasSession("muxpilot")) return this.createCodexResumeWindow("muxpilot", cwd, name, codexSessionId, options);
    return this.createMuxpilotResumeSession(cwd, name, codexSessionId, options);
  }

  async createCodexForkWindowInMuxpilotSession(cwd: string, name: string, codexSessionId: string, options: CodexLaunchOptions = {}): Promise<CodexPaneLaunch> {
    if (await this.hasSession("muxpilot")) return this.createCodexForkWindow("muxpilot", cwd, name, codexSessionId, options);
    return this.createMuxpilotForkSession(cwd, name, codexSessionId, options);
  }

  private async createCodexWindow(targetSessionId: string, cwd: string, name: string, options: CodexLaunchOptions): Promise<CodexPaneLaunch> {
    const { stdout } = await execFileAsync("tmux", tmuxNewCodexWindowArgs(targetSessionId, cwd, name, options));
    const line = stdout.trim().split("\n").find(Boolean);
    if (!line) throw new Error("tmux did not return a pane for the new Codex window");
    return this.launchCodexPane(parsePaneLine(line));
  }

  private async createCodexResumeWindow(targetSessionId: string, cwd: string, name: string, codexSessionId: string, options: CodexLaunchOptions): Promise<CodexPaneLaunch> {
    const { stdout } = await execFileAsync("tmux", tmuxNewCodexResumeWindowArgs(targetSessionId, cwd, name, codexSessionId, options));
    const line = stdout.trim().split("\n").find(Boolean);
    if (!line) throw new Error("tmux did not return a pane for the resumed Codex window");
    return this.launchCodexPane(parsePaneLine(line));
  }

  private async createCodexForkWindow(targetSessionId: string, cwd: string, name: string, codexSessionId: string, options: CodexLaunchOptions): Promise<CodexPaneLaunch> {
    const { stdout } = await execFileAsync("tmux", tmuxNewCodexForkWindowArgs(targetSessionId, cwd, name, codexSessionId, options));
    const line = stdout.trim().split("\n").find(Boolean);
    if (!line) throw new Error("tmux did not return a pane for the forked Codex window");
    return this.launchCodexPane(parsePaneLine(line));
  }

  private async createMuxpilotSession(cwd: string, name: string, options: CodexLaunchOptions): Promise<CodexPaneLaunch> {
    const { stdout } = await execFileAsync("tmux", [
      "new-session",
      "-d",
      "-P",
      "-F",
      PANE_FORMAT,
      "-s",
      "muxpilot",
      "-n",
      name,
      "-c",
      cwd,
      ...codexCommandArgs(cwd, options)
    ]);
    const line = stdout.trim().split("\n").find(Boolean);
    if (!line) throw new Error("tmux did not return a pane for the new Codex session");
    return this.launchCodexPane(parsePaneLine(line));
  }

  private async createMuxpilotResumeSession(cwd: string, name: string, codexSessionId: string, options: CodexLaunchOptions): Promise<CodexPaneLaunch> {
    const { stdout } = await execFileAsync("tmux", [
      "new-session",
      "-d",
      "-P",
      "-F",
      PANE_FORMAT,
      "-s",
      "muxpilot",
      "-n",
      name,
      "-c",
      cwd,
      ...codexCommandArgs(cwd, options, { mode: "resume", sessionId: codexSessionId })
    ]);
    const line = stdout.trim().split("\n").find(Boolean);
    if (!line) throw new Error("tmux did not return a pane for the resumed Codex session");
    return this.launchCodexPane(parsePaneLine(line));
  }

  private async createMuxpilotForkSession(cwd: string, name: string, codexSessionId: string, options: CodexLaunchOptions): Promise<CodexPaneLaunch> {
    const { stdout } = await execFileAsync("tmux", [
      "new-session",
      "-d",
      "-P",
      "-F",
      PANE_FORMAT,
      "-s",
      "muxpilot",
      "-n",
      name,
      "-c",
      cwd,
      ...codexCommandArgs(cwd, options, { mode: "fork", sessionId: codexSessionId })
    ]);
    const line = stdout.trim().split("\n").find(Boolean);
    if (!line) throw new Error("tmux did not return a pane for the forked Codex session");
    return this.launchCodexPane(parsePaneLine(line));
  }

  private launchCodexPane(pane: TmuxPane): CodexPaneLaunch {
    return { pane, ready: this.prepareCodexPane(pane) };
  }

  private async prepareCodexPane(pane: TmuxPane): Promise<void> {
    const deadline = Date.now() + CODEX_STARTUP_TIMEOUT_MS;
    let captureFailures = 0;
    while (Date.now() < deadline) {
      let capture: string;
      try {
        capture = await this.capturePane(pane.paneId, 80);
        captureFailures = 0;
      } catch {
        captureFailures += 1;
        if (captureFailures >= CODEX_STARTUP_CAPTURE_FAILURE_LIMIT) {
          throw new CodexStartupError("Codex exited before startup completed.", "pane_closed");
        }
        await delay(CODEX_STARTUP_POLL_INTERVAL_MS);
        continue;
      }
      const startupError = codexStartupErrorFromCapture(capture);
      if (startupError) throw startupError;
      const startupAction = codexStartupActionFromCapture(capture);
      if (startupAction === "accept_trust") {
        await this.sendKeys(pane.paneId, ["Enter"]);
        await delay(250);
        continue;
      }
      if (startupAction === "ready") return;
      await delay(CODEX_STARTUP_POLL_INTERVAL_MS);
    }
    throw new CodexStartupError("Codex did not become ready within 60 seconds.", "timeout");
  }

  private async hasSession(sessionName: string): Promise<boolean> {
    try {
      await execFileAsync("tmux", ["has-session", "-t", sessionName]);
      return true;
    } catch {
      return false;
    }
  }

  async capturePane(paneId: string, lines = 160, includeAnsi = false): Promise<string> {
    const args = ["capture-pane", "-p", "-J", "-S", `-${lines}`, "-t", paneId];
    if (includeAnsi) args.splice(2, 0, "-e");
    const { stdout } = await execFileAsync("tmux", args, { maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  }

  async sendInput(paneId: string, text: string): Promise<InputTransportResult | void> {
    const result: InputTransportResult = { pasteReplayCount: 0, submitKeyRetryCount: 0 };
    try {
      const initialCapture = await this.capturePane(paneId, 100, true);
      if (composerHasInput(initialCapture)) {
        throw new InputTransportError("The Codex composer already contains input", "composer_changed", result);
      }
      await this.pasteText(paneId, text);
      if (!await this.waitForComposerInput(paneId, text)) {
        result.pasteReplayCount = 1;
        await this.pasteText(paneId, text);
        if (!await this.waitForComposerInput(paneId, text)) {
          throw new InputTransportError("Codex did not display the pasted input", "paste_not_observed", result);
        }
      }

      await this.submitInput(paneId);
      await delay(this.inputVerification.submitVerifyMs ?? INPUT_SUBMIT_VERIFY_MS);
      const capture = await this.capturePane(paneId, inputVerificationCaptureLines(text), true);
      if (composerContainsInput(capture, text) && !captureShowsActiveTurn(capture)) {
        result.submitKeyRetryCount = 1;
        await this.submitInput(paneId);
      }
      return result;
    } catch (error) {
      if (error instanceof InputTransportError) throw error;
      throw new InputTransportError(
        error instanceof Error ? error.message : String(error),
        "tmux_failed",
        result
      );
    }
  }

  async pasteText(paneId: string, text: string): Promise<void> {
    const bufferName = `muxpilot-${Date.now()}`;
    await this.loadBuffer(bufferName, text);
    try {
      await execFileAsync("tmux", tmuxPasteBufferArgs(bufferName, paneId));
    } finally {
      await execFileAsync("tmux", ["delete-buffer", "-b", bufferName]).catch(() => undefined);
    }
  }

  async sendKeys(paneId: string, keys: string[]): Promise<void> {
    if (keys.length === 0) throw new Error("At least one tmux key is required");
    await execFileAsync("tmux", ["send-keys", "-t", paneId, ...keys]);
  }

  async submitInput(paneId: string): Promise<void> {
    await this.sendKeys(paneId, this.inputSubmitKeys);
  }

  async interrupt(paneId: string): Promise<void> {
    await execFileAsync("tmux", ["send-keys", "-t", paneId, "C-c"]);
  }

  async renameWindow(paneId: string, name: string): Promise<void> {
    await execFileAsync("tmux", ["rename-window", "-t", paneId, name]);
  }

  async killPane(paneId: string): Promise<void> {
    await execFileAsync("tmux", ["kill-pane", "-t", paneId]);
  }

  private async loadBuffer(bufferName: string, text: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("tmux", ["load-buffer", "-b", bufferName, "-"]);
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`tmux load-buffer exited with ${code}`));
      });
      child.stdin.end(text);
    });
  }

  private async waitForComposerInput(paneId: string, text: string): Promise<boolean> {
    const timeoutMs = this.inputVerification.pasteVerifyTimeoutMs ?? Math.max(INPUT_PASTE_VERIFY_MIN_MS, inputSubmitDelayMs(text));
    const deadline = Date.now() + timeoutMs;
    do {
      const capture = await this.capturePane(paneId, inputVerificationCaptureLines(text), true);
      if (composerContainsInput(capture, text)) return true;
      await delay(this.inputVerification.pollMs ?? INPUT_VERIFY_POLL_MS);
    } while (Date.now() < deadline);
    return false;
  }
}

export function inputSubmitDelayMs(text: string): number {
  return Math.min(MAX_INPUT_SUBMIT_DELAY_MS, MIN_INPUT_SUBMIT_DELAY_MS + Math.floor(text.length / 8));
}

export function inputVerificationCaptureLines(text: string, paneWidth = 120): number {
  const contentWidth = Math.max(20, paneWidth - 4);
  return Math.min(4000, Math.max(100, Math.ceil(text.length / contentWidth) + 30));
}

export function composerContainsInput(capture: string, text: string): boolean {
  const lines = capture.trimEnd().split("\n");
  const composerIndex = lines.findLastIndex(isComposerLine);
  if (composerIndex < 0) return false;
  if (composerUsesDimPlaceholder(lines[composerIndex]!)) return false;
  const firstLine = normalizeComposerText(visibleComposerLine(lines[composerIndex]!));
  const composer = normalizeComposerText([
    firstLine,
    ...lines.slice(composerIndex + 1)
  ].join("\n"));
  const expected = normalizeComposerText(text);
  if (!expected) return false;
  if (!text.includes("\n") && expected.length <= 64) return firstLine === expected;
  const expectedFirstLine = normalizeComposerText(text.split("\n", 1)[0] ?? "");
  const prefix = (expectedFirstLine || expected).slice(0, 64);
  if (!firstLine.startsWith(prefix)) return false;
  if (expected.length <= 256) return composer.includes(expected);
  const suffix = expected.slice(-128);
  const prefixIndex = composer.indexOf(prefix);
  return prefixIndex >= 0 && composer.indexOf(suffix, prefixIndex + prefix.length) >= 0;
}

export function composerHasInput(capture: string): boolean {
  const lines = capture.trimEnd().split("\n");
  const composer = lines.findLast(isComposerLine);
  if (!composer) return false;
  const visible = visibleComposerLine(composer).trim();
  if (!visible) return false;
  if (composer.includes("\u001b[")) return !composerUsesDimPlaceholder(composer);
  return !isKnownComposerPlaceholder(visible);
}

function normalizeComposerText(text: string): string {
  return stripTerminalFormatting(text).replace(/\s+/g, " ").trim();
}

function captureShowsActiveTurn(capture: string): boolean {
  const lines = capture.trimEnd().split("\n");
  const composerIndex = lines.findLastIndex(isComposerLine);
  const activeIndex = lines.findLastIndex((line) => {
    const normalized = stripTerminalFormatting(line).toLowerCase();
    return normalized.includes("working (") || normalized.includes("esc to interrupt");
  });
  return activeIndex > composerIndex;
}

function isComposerLine(line: string): boolean {
  return /^\s*›(?!\s*\d+\.)/.test(stripTerminalFormatting(line));
}

function visibleComposerLine(line: string): string {
  return stripTerminalFormatting(line).replace(/^\s*›\s?/, "");
}

function composerUsesDimPlaceholder(line: string): boolean {
  const composerMarker = line.indexOf("›");
  return composerMarker >= 0 && line.indexOf("\u001b[2m", composerMarker) >= 0;
}

function isKnownComposerPlaceholder(text: string): boolean {
  return text === "Ask Codex to do anything" ||
    text === "Explain this codebase" ||
    text === "Plan {feature}" ||
    text === "Implement {feature}";
}

function stripTerminalFormatting(text: string): string {
  return text
    .replace(/\u001b\][^\u0007]*?(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

export function tmuxPasteBufferArgs(bufferName: string, paneId: string): string[] {
  return ["paste-buffer", "-d", "-p", "-r", "-b", bufferName, "-t", paneId];
}

export function tmuxNewCodexWindowArgs(targetSessionId: string, cwd: string, name: string, options: CodexLaunchOptions = {}): string[] {
  return [
    "new-window",
    "-P",
    "-F",
    PANE_FORMAT,
    "-t",
    `${targetSessionId}:`,
    "-n",
    name,
    "-c",
    cwd,
    ...codexCommandArgs(cwd, options)
  ];
}

export function tmuxNewCodexResumeWindowArgs(targetSessionId: string, cwd: string, name: string, codexSessionId: string, options: CodexLaunchOptions = {}): string[] {
  return [
    "new-window",
    "-P",
    "-F",
    PANE_FORMAT,
    "-t",
    `${targetSessionId}:`,
    "-n",
    name,
    "-c",
    cwd,
    ...codexCommandArgs(cwd, options, { mode: "resume", sessionId: codexSessionId })
  ];
}

export function tmuxNewCodexForkWindowArgs(targetSessionId: string, cwd: string, name: string, codexSessionId: string, options: CodexLaunchOptions = {}): string[] {
  return [
    "new-window",
    "-P",
    "-F",
    PANE_FORMAT,
    "-t",
    `${targetSessionId}:`,
    "-n",
    name,
    "-c",
    cwd,
    ...codexCommandArgs(cwd, options, { mode: "fork", sessionId: codexSessionId })
  ];
}

export function codexCommandArgs(cwd: string, options: CodexLaunchOptions = {}, continuation?: CodexContinuation): string[] {
  const codexArgs = Object.keys(options.environment ?? {}).length
    ? ["env", ...Object.entries(options.environment ?? {}).map(([key, value]) => `${key}=${value}`), "codex"]
    : ["codex"];
  codexArgs.push("-c", "check_for_update_on_startup=false");
  if (options.isolatedWorkspace) {
    codexArgs.push("-C", cwd, "-s", "workspace-write", "-c", "sandbox_workspace_write.writable_roots=[]", "-c", "sandbox_workspace_write.network_access=true");
    for (const root of options.writableRoots ?? []) codexArgs.push("--add-dir", root);
  }
  if (options.developerInstructions) codexArgs.push("-c", `developer_instructions=${JSON.stringify(options.developerInstructions)}`);
  if (continuation) codexArgs.push(continuation.mode, continuation.sessionId);
  return ["bash", CODEX_LAUNCHER_PATH, "--", ...codexArgs];
}

export function codexStartupErrorFromCapture(text: string): CodexStartupError | null {
  if (!isCodexStartupFailureCapture(text)) return null;
  const normalized = text.toLowerCase();
  if (normalized.includes("database is locked") || normalized.includes("another codex process is using its local data")) {
    return new CodexStartupError(
      "Codex couldn't start because its local data is locked. Restart WSL or close other Codex processes, then create the session again.",
      "database_locked"
    );
  }
  return new CodexStartupError(
    "Codex exited before startup completed. Review the tmux pane output, then create the session again.",
    "exited"
  );
}

export function isCodexStartupFailureCapture(text: string): boolean {
  return text.includes(CODEX_STARTUP_FAILED_MARKER);
}

export function isCodexDirectoryTrustPrompt(text: string): boolean {
  return text.includes("Do you trust the contents of this directory?") && text.includes("Yes, continue") && text.includes("No, quit");
}

export function codexStartupActionFromCapture(text: string): "accept_trust" | "ready" | "wait" {
  const trustPromptIndex = text.lastIndexOf("Do you trust the contents of this directory?");
  const readyScreenIndex = codexReadyScreenIndex(text);
  if (readyScreenIndex > trustPromptIndex) return "ready";
  if (trustPromptIndex >= 0 && isCodexDirectoryTrustPrompt(text.slice(trustPromptIndex))) return "accept_trust";
  return readyScreenIndex >= 0 ? "ready" : "wait";
}

function codexReadyScreenIndex(text: string): number {
  const normalized = text.toLowerCase();
  return Math.max(
    normalized.lastIndexOf("openai codex"),
    normalized.lastIndexOf("use /skills to list available skills"),
    normalized.lastIndexOf("context left"),
    normalized.lastIndexOf("gpt-")
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parsePaneLine(line: string): TmuxPane {
  const fields = line.split(SEP);
  return {
    sessionId: fields[0] ?? "",
    sessionName: fields[1] ?? "",
    serverPid: optionalPositiveInteger(fields[13]),
    sessionCreatedAt: optionalPositiveInteger(fields[14]),
    windowId: fields[2] ?? "",
    windowIndex: Number(fields[3] ?? 0),
    windowName: fields[4] ?? "",
    paneId: fields[5] ?? "",
    paneIndex: Number(fields[6] ?? 0),
    paneActive: fields[7] === "1",
    cwd: fields[8] ?? "",
    currentCommand: fields[9] ?? "",
    title: fields[10] ?? "",
    pid: Number(fields[11] ?? 0),
    size: fields[12] ?? ""
  };
}

function optionalPositiveInteger(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
