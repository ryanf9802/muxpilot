import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AppServerCompatibility } from "@muxpilot/core";

const execFileAsync = promisify(execFile);
const REQUIRED_PROTOCOL_CAPABILITIES = [
  "initialize",
  "thread/start",
  "thread/resume",
  "thread/fork",
  "thread/read",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
  "item/completed",
  "serverRequest/resolved"
] as const;

export interface AppServerProbeExecutor {
  codexVersion(): Promise<string>;
  appServerHelp(): Promise<string>;
  proxyHelp(): Promise<string>;
  protocolSchema(): Promise<string>;
}

export async function probeAppServerCompatibility(
  userSystemdAvailable: boolean,
  executor: AppServerProbeExecutor = new CodexCliAppServerProbeExecutor(),
  now: () => Date = () => new Date()
): Promise<AppServerCompatibility> {
  const checkedAt = now().toISOString();
  if (!userSystemdAvailable) {
    return {
      status: "user_systemd_unavailable",
      available: false,
      codexVersion: null,
      detail: "A persistent user-systemd manager is required for app-server sessions.",
      checkedAt,
      missingCapabilities: ["user-systemd"]
    };
  }

  let version: string | null = null;
  try {
    const versionOutput = await executor.codexVersion();
    version = codexVersionFromOutput(versionOutput);
    const appServerHelp = await executor.appServerHelp();
    const proxyHelp = await executor.proxyHelp();
    const schema = await executor.protocolSchema();
    const missingCapabilities: string[] = REQUIRED_PROTOCOL_CAPABILITIES.filter((capability) =>
      !schema.includes(JSON.stringify(capability))
    );
    if (!appServerHelp.includes("--listen") || !appServerHelp.includes("unix://")) {
      missingCapabilities.push("unix-listen");
    }
    if (!proxyHelp.includes("--sock")) missingCapabilities.push("unix-proxy");
    if (missingCapabilities.length > 0) {
      return {
        status: "incompatible_codex_protocol",
        available: false,
        codexVersion: version,
        detail: `Codex app-server is missing required capabilities: ${missingCapabilities.join(", ")}.`,
        checkedAt,
        missingCapabilities
      };
    }
    return {
      status: "available",
      available: true,
      codexVersion: version,
      detail: "Codex app-server, Unix socket proxying, and the required protocol methods are available.",
      checkedAt,
      missingCapabilities: []
    };
  } catch (error) {
    return {
      status: "failed_health_probe",
      available: false,
      codexVersion: version,
      detail: `Codex app-server health probe failed: ${probeErrorMessage(error)}`,
      checkedAt,
      missingCapabilities: []
    };
  }
}

export class CodexCliAppServerProbeExecutor implements AppServerProbeExecutor {
  async codexVersion(): Promise<string> {
    return (await execFileAsync("codex", ["--version"], { timeout: 5_000 })).stdout;
  }

  async appServerHelp(): Promise<string> {
    return (await execFileAsync("codex", ["app-server", "--help"], { timeout: 5_000 })).stdout;
  }

  async proxyHelp(): Promise<string> {
    return (await execFileAsync("codex", ["app-server", "proxy", "--help"], { timeout: 5_000 })).stdout;
  }

  async protocolSchema(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "muxpilot-app-server-schema-"));
    try {
      await execFileAsync("codex", ["app-server", "generate-json-schema", "--experimental", "--out", directory], {
        timeout: 15_000
      });
      return await readFile(join(directory, "codex_app_server_protocol.v2.schemas.json"), "utf8");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

function codexVersionFromOutput(output: string): string | null {
  return output.match(/\b(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\b/)?.[1] ?? null;
}

function probeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n", 1)[0]?.trim() || "unknown error";
}
