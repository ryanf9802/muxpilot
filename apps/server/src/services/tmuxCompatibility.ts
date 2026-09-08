import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SessionDriverKind, TmuxCompatibility } from "@muxpilot/core";

const execFileAsync = promisify(execFile);

type ProbeRunner = () => Promise<{ stdout: string | Buffer }>;

export async function probeTmuxCompatibility(
  run: ProbeRunner = () => execFileAsync("tmux", ["-V"], { timeout: 5_000, maxBuffer: 64 * 1024 })
): Promise<TmuxCompatibility> {
  const checkedAt = new Date().toISOString();
  try {
    const result = await run();
    const version = String(result.stdout).trim() || null;
    return {
      status: "available",
      available: true,
      version,
      detail: version ? `tmux is available (${version}).` : "tmux is available.",
      checkedAt
    };
  } catch (error) {
    if (isExecutableMissing(error)) {
      return {
        status: "executable_missing",
        available: false,
        version: null,
        detail: "tmux is not installed. Install tmux and restart muxpilot to enable the legacy runtime.",
        checkedAt
      };
    }
    return {
      status: "probe_failed",
      available: false,
      version: null,
      detail: `tmux availability could not be verified. ${errorMessage(error)} Restart muxpilot after correcting the problem.`,
      checkedAt
    };
  }
}

export function assertConfiguredTmuxAvailable(
  defaultDriver: SessionDriverKind,
  compatibility: TmuxCompatibility
): void {
  if (defaultDriver === "codex_tmux" && !compatibility.available) {
    throw new Error(`MUXPILOT_DEFAULT_SESSION_DRIVER=codex_tmux requires tmux. ${compatibility.detail}`);
  }
}

function isExecutableMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : String(error).trim();
  return message || "The compatibility probe failed.";
}
