import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import type { ProviderCompatibility } from "@muxpilot/core";
import { claudeAgentSdkVersion } from "./sdkVersion.js";

const execFileAsync = promisify(execFile);

export interface ClaudeProbeExecutor {
  resolveExecutable(command: string): Promise<string | null>;
  claudeVersion(claudePath: string): Promise<string>;
  sdkVersion(): string | null;
}

export interface ClaudeCompatibility extends ProviderCompatibility {
  /** Resolved Claude Code executable used by every session runtime. */
  claudePath: string | null;
}

/**
 * Probes whether Claude sessions can run on this host. Sandboxing is mandatory: without bubblewrap and socat the
 * provider is unavailable rather than running Claude unsandboxed.
 */
export async function probeClaudeCompatibility(
  userSystemdAvailable: boolean,
  configuredExecutable: string | null,
  executor: ClaudeProbeExecutor = new ClaudeCliProbeExecutor(),
  now: () => Date = () => new Date()
): Promise<ClaudeCompatibility> {
  const checkedAt = now().toISOString();
  const result = (
    status: ProviderCompatibility["status"],
    detail: string,
    version: string | null,
    claudePath: string | null,
    missingCapabilities: string[] = []
  ): ClaudeCompatibility => ({
    provider: "claude",
    status,
    available: status === "available",
    version,
    detail,
    checkedAt,
    missingCapabilities,
    claudePath
  });
  if (!userSystemdAvailable) {
    return result("user_systemd_unavailable", "A persistent user-systemd manager is required for Claude sessions.", null, null, ["user-systemd"]);
  }
  const claudePath = await executor.resolveExecutable(configuredExecutable ?? "claude");
  if (!claudePath) {
    return result("missing_binary", "Claude Code is not installed. Install it and sign in with `claude auth login`.", null, null, ["claude"]);
  }
  let version: string | null = null;
  try {
    version = (await executor.claudeVersion(claudePath)).match(/\d+\.\d+\.\d+/)?.[0] ?? null;
  } catch (error) {
    return result("failed_health_probe", `Claude Code health probe failed: ${firstLine(error)}`, null, claudePath);
  }
  if (!executor.sdkVersion()) {
    return result("incompatible_protocol", "The Claude Agent SDK is not installed in muxpilot's server package.", version, claudePath, ["claude-agent-sdk"]);
  }
  const missing = [];
  if (!await executor.resolveExecutable("bwrap")) missing.push("bubblewrap");
  if (!await executor.resolveExecutable("socat")) missing.push("socat");
  if (missing.length > 0) {
    return result(
      "sandbox_unavailable",
      `Claude sessions run sandboxed and need ${missing.join(" and ")}. Install ${missing.join(" and ")} (for example \`sudo apt install ${missing.map((name) => name === "bubblewrap" ? "bubblewrap" : name).join(" ")}\`) and restart muxpilot.`,
      version,
      claudePath,
      missing
    );
  }
  return result("available", "Claude Code, the Agent SDK, and sandbox dependencies are available.", version, claudePath);
}

export class ClaudeCliProbeExecutor implements ClaudeProbeExecutor {
  async resolveExecutable(command: string): Promise<string | null> {
    try {
      const located = command.includes("/")
        ? command
        : (await execFileAsync("sh", ["-c", `command -v -- "$1"`, "sh", command], { timeout: 5_000 })).stdout.trim();
      return located ? await realpath(located) : null;
    } catch {
      return null;
    }
  }

  async claudeVersion(claudePath: string): Promise<string> {
    return (await execFileAsync(claudePath, ["--version"], { timeout: 10_000 })).stdout;
  }

  sdkVersion(): string | null {
    return claudeAgentSdkVersion();
  }
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n", 1)[0]?.trim() || "unknown error";
}
