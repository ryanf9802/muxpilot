import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { TmuxPane } from "@muxpilot/core";

const execFileAsync = promisify(execFile);
const SEP = "\t";
const MIN_INPUT_SUBMIT_DELAY_MS = 80;
const MAX_INPUT_SUBMIT_DELAY_MS = 2500;
const CODEX_STARTUP_POLL_INTERVAL_MS = 50;
const CODEX_STARTUP_TIMEOUT_MS = 5000;
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
  "#{pane_width}x#{pane_height}"
].join(SEP);

export interface CodexLaunchOptions {
  isolatedWorkspace?: boolean;
  writableRoots?: string[];
  developerInstructions?: string;
  environment?: Record<string, string>;
}

export class TmuxAdapter {
  constructor(private readonly inputSubmitKeys: string[] = ["Enter"]) {}

  async listPanes(): Promise<TmuxPane[]> {
    const { stdout } = await execFileAsync("tmux", ["list-panes", "-a", "-F", PANE_FORMAT]);
    return stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(parsePaneLine);
  }

  async createCodexWindowInMuxpilotSession(cwd: string, name: string, options: CodexLaunchOptions = {}): Promise<TmuxPane> {
    if (await this.hasSession("muxpilot")) return this.createCodexWindow("muxpilot", cwd, name, options);
    return this.createMuxpilotSession(cwd, name, options);
  }

  async createCodexResumeWindowInMuxpilotSession(cwd: string, name: string, codexSessionId: string, options: CodexLaunchOptions = {}): Promise<TmuxPane> {
    if (await this.hasSession("muxpilot")) return this.createCodexResumeWindow("muxpilot", cwd, name, codexSessionId, options);
    return this.createMuxpilotResumeSession(cwd, name, codexSessionId, options);
  }

  private async createCodexWindow(targetSessionId: string, cwd: string, name: string, options: CodexLaunchOptions): Promise<TmuxPane> {
    const { stdout } = await execFileAsync("tmux", tmuxNewCodexWindowArgs(targetSessionId, cwd, name, options));
    const line = stdout.trim().split("\n").find(Boolean);
    if (!line) throw new Error("tmux did not return a pane for the new Codex window");
    return this.prepareCodexPane(parsePaneLine(line));
  }

  private async createCodexResumeWindow(targetSessionId: string, cwd: string, name: string, codexSessionId: string, options: CodexLaunchOptions): Promise<TmuxPane> {
    const { stdout } = await execFileAsync("tmux", tmuxNewCodexResumeWindowArgs(targetSessionId, cwd, name, codexSessionId, options));
    const line = stdout.trim().split("\n").find(Boolean);
    if (!line) throw new Error("tmux did not return a pane for the resumed Codex window");
    return this.prepareCodexPane(parsePaneLine(line));
  }

  private async createMuxpilotSession(cwd: string, name: string, options: CodexLaunchOptions): Promise<TmuxPane> {
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
    return this.prepareCodexPane(parsePaneLine(line));
  }

  private async createMuxpilotResumeSession(cwd: string, name: string, codexSessionId: string, options: CodexLaunchOptions): Promise<TmuxPane> {
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
      ...codexCommandArgs(cwd, options, codexSessionId)
    ]);
    const line = stdout.trim().split("\n").find(Boolean);
    if (!line) throw new Error("tmux did not return a pane for the resumed Codex session");
    return this.prepareCodexPane(parsePaneLine(line));
  }

  private async prepareCodexPane(pane: TmuxPane): Promise<TmuxPane> {
    const deadline = Date.now() + CODEX_STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const capture = await this.capturePane(pane.paneId, 40).catch(() => "");
      if (isCodexDirectoryTrustPrompt(capture)) {
        await this.sendKeys(pane.paneId, ["Enter"]);
        await delay(250);
        return pane;
      }
      if (isCodexReadyScreen(capture)) return pane;
      await delay(CODEX_STARTUP_POLL_INTERVAL_MS);
    }
    return pane;
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

  async sendInput(paneId: string, text: string): Promise<void> {
    await this.pasteText(paneId, text);
    await delay(inputSubmitDelayMs(text));
    await this.sendKeys(paneId, this.inputSubmitKeys);
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
}

export function inputSubmitDelayMs(text: string): number {
  return Math.min(MAX_INPUT_SUBMIT_DELAY_MS, MIN_INPUT_SUBMIT_DELAY_MS + Math.floor(text.length / 8));
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
    ...codexCommandArgs(cwd, options, codexSessionId)
  ];
}

export function codexCommandArgs(cwd: string, options: CodexLaunchOptions = {}, resumeSessionId?: string): string[] {
  const args = Object.keys(options.environment ?? {}).length
    ? ["env", ...Object.entries(options.environment ?? {}).map(([key, value]) => `${key}=${value}`), "codex"]
    : ["codex"];
  if (options.isolatedWorkspace) {
    args.push("-C", cwd, "-s", "workspace-write", "-c", "sandbox_workspace_write.writable_roots=[]", "-c", "sandbox_workspace_write.network_access=true");
    for (const root of options.writableRoots ?? []) args.push("--add-dir", root);
  }
  if (options.developerInstructions) args.push("-c", `developer_instructions=${JSON.stringify(options.developerInstructions)}`);
  if (resumeSessionId) args.push("resume", resumeSessionId);
  return args;
}

export function isCodexDirectoryTrustPrompt(text: string): boolean {
  return text.includes("Do you trust the contents of this directory?") && text.includes("Yes, continue") && text.includes("No, quit");
}

function isCodexReadyScreen(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes("openai codex") ||
    normalized.includes("use /skills to list available skills") ||
    normalized.includes("context left") ||
    normalized.includes("gpt-")
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePaneLine(line: string): TmuxPane {
  const fields = line.split(SEP);
  return {
    sessionId: fields[0] ?? "",
    sessionName: fields[1] ?? "",
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
