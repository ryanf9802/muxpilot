import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  RuntimeEvidence,
  RuntimeProxyConnection,
  RuntimeStartSpec,
  RuntimeSupervisor,
  SystemdSessionRuntimeRef
} from "./types.js";
import { openUnixWebSocketJsonLineConnection } from "./unixWebSocketConnection.js";

const CAPABILITY_ID = /^[a-f0-9]{24}$/;
const APP_SERVER_UNIT = /^muxpilot-session-([a-f0-9]{24})\.service$/;
const ENVIRONMENT_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MCP_SERVER_NAME = /^[A-Za-z0-9_-]+$/;
const DEFAULT_START_TIMEOUT_MS = 30_000;
const DEFAULT_SOCKET_POLL_MS = 50;
const MAX_UNIX_SOCKET_PATH_BYTES = 107;
const execFileAsync = promisify(execFile);

interface CommandResult {
  stdout: string;
}

interface SupervisorDependencies {
  run(command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }): Promise<CommandResult>;
  openProxy(socketPath: string): RuntimeProxyConnection | Promise<RuntimeProxyConnection>;
  socketReady(socketPath: string): Promise<boolean>;
  delay(ms: number): Promise<void>;
  now(): number;
}

interface SystemdAppServerSupervisorOptions {
  startTimeoutMs?: number;
  socketPollMs?: number;
  executablePath?: string;
  socketRoot?: string;
  legacySocketRoots?: string[];
}

export class SystemdAppServerSupervisor implements RuntimeSupervisor {
  private readonly runtimeRoot: string;
  private readonly socketRoot: string;
  private readonly legacySocketRoots: string[];
  private readonly dependencies: SupervisorDependencies;
  private readonly startTimeoutMs: number;
  private readonly socketPollMs: number;
  private readonly executablePath: string | null;

  constructor(
    runtimeRoot: string,
    dependencies: Partial<SupervisorDependencies> = {},
    options: SystemdAppServerSupervisorOptions = {}
  ) {
    this.runtimeRoot = resolve(runtimeRoot);
    this.socketRoot = resolve(options.socketRoot ?? runtimeRoot);
    this.legacySocketRoots = (options.legacySocketRoots ?? []).map((root) => resolve(root));
    this.dependencies = { ...defaultDependencies(), ...dependencies };
    this.startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    this.socketPollMs = options.socketPollMs ?? DEFAULT_SOCKET_POLL_MS;
    this.executablePath = options.executablePath ?? process.env.PATH ?? null;
  }

  async start(spec: RuntimeStartSpec): Promise<SystemdSessionRuntimeRef> {
    validateMcpServers(spec.mcpServers);
    const paths = runtimePaths(this.runtimeRoot, spec.capabilityId, this.socketRoot);
    validateSocketPath(paths.socketPath);
    await preparePrivateDirectory(this.runtimeRoot);
    await preparePrivateDirectory(paths.directory);
    await preparePrivateDirectory(this.socketRoot);
    await preparePrivateDirectory(paths.socketDirectory);
    const environment = {
      ...spec.environment,
      ...(this.executablePath ? { PATH: this.executablePath } : {}),
      CODEX_HOME: spec.codexHome
    };
    const nextEnvironment = environmentFileContents(environment);
    const environmentMatches = await readFile(paths.environmentPath, "utf8").then((current) => current === nextEnvironment).catch(() => false);

    const runtime: SystemdSessionRuntimeRef = {
      kind: "systemd_service",
      unit: paths.unit,
      socketPath: paths.socketPath,
      state: "starting",
      codexVersion: spec.codexVersion
    };
    const existing = await this.inspect(runtime);
    if (existing.activeState === "active" && existing.socketPresent && environmentMatches) return { ...runtime, state: "connected" };
    if (existing.activeState && existing.activeState !== "inactive") {
      await this.dependencies.run("systemctl", ["--user", "stop", paths.unit]).catch(() => undefined);
    }
    await writeEnvironmentFile(paths.environmentPath, nextEnvironment);
    await rm(paths.socketPath, { force: true });
    await this.dependencies.run("systemctl", ["--user", "reset-failed", paths.unit]).catch(() => undefined);
    await this.dependencies.run("systemd-run", systemdRunArgs(spec, paths));
    await this.waitUntilReady(runtime);
    return { ...runtime, state: "connected" };
  }

  async reconnect(runtime: SystemdSessionRuntimeRef): Promise<RuntimeProxyConnection> {
    this.requireOwnedRuntime(runtime);
    const evidence = await this.inspect(runtime);
    if (evidence.activeState !== "active" || !evidence.socketPresent) {
      throw new Error(`App-server runtime is not connectable: ${runtime.unit}`);
    }
    return await this.dependencies.openProxy(runtime.socketPath);
  }

  async stop(runtime: SystemdSessionRuntimeRef): Promise<SystemdSessionRuntimeRef> {
    this.requireOwnedRuntime(runtime);
    try {
      await this.dependencies.run("systemctl", ["--user", "stop", runtime.unit]);
    } catch (error) {
      if (!isMissingSystemdUnitError(error)) throw error;
    }
    await rm(runtime.socketPath, { force: true });
    await rm(join(dirname(runtime.socketPath), "environment"), { force: true });
    return { ...runtime, state: "stopped" };
  }

  async inspect(runtime: SystemdSessionRuntimeRef): Promise<RuntimeEvidence> {
    this.requireOwnedRuntime(runtime);
    const properties: Record<string, string> = await this.dependencies.run("systemctl", [
      "--user", "show", runtime.unit,
      "--property=ActiveState",
      "--property=SubState",
      "--property=MainPID",
      "--property=ControlGroup",
      "--no-pager"
    ]).then(({ stdout }) => parseSystemdProperties(stdout)).catch(() => ({}));
    const mainPid = Number(properties.MainPID);
    return {
      runtime,
      activeState: properties.ActiveState ?? null,
      subState: properties.SubState ?? null,
      mainPid: Number.isSafeInteger(mainPid) && mainPid > 0 ? mainPid : null,
      controlGroup: properties.ControlGroup || null,
      socketPresent: await this.dependencies.socketReady(runtime.socketPath),
      attachmentCommand: `codex --remote ${shellQuote(`unix://${runtime.socketPath}`)}`
    };
  }

  private async waitUntilReady(runtime: SystemdSessionRuntimeRef): Promise<void> {
    const deadline = this.dependencies.now() + this.startTimeoutMs;
    while (this.dependencies.now() <= deadline) {
      const evidence = await this.inspect(runtime);
      if (evidence.activeState === "active" && evidence.socketPresent) return;
      if (evidence.activeState === "failed") throw new Error(`App-server service failed during startup: ${runtime.unit}`);
      await this.dependencies.delay(this.socketPollMs);
    }
    throw new Error(`Timed out waiting for app-server socket: ${runtime.socketPath}`);
  }

  private requireOwnedRuntime(runtime: SystemdSessionRuntimeRef): void {
    const capabilityId = runtime.unit.match(APP_SERVER_UNIT)?.[1];
    if (!capabilityId) throw new Error(`Refusing non-muxpilot app-server unit: ${runtime.unit}`);
    const ownedSocketPaths = [this.socketRoot, ...this.legacySocketRoots]
      .map((socketRoot) => runtimePaths(this.runtimeRoot, capabilityId, socketRoot).socketPath);
    if (!ownedSocketPaths.includes(runtime.socketPath)) {
      throw new Error(`Refusing app-server socket outside its owned runtime path: ${runtime.socketPath}`);
    }
  }
}

function isMissingSystemdUnitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const stderr = typeof error === "object" && error !== null && "stderr" in error
    ? String(error.stderr)
    : "";
  return /\bUnit\s+muxpilot-session-[0-9a-f]{24}\.service\s+not (?:found|loaded)\.\s*$/m.test(`${message}\n${stderr}`);
}

export function appServerServiceUnit(capabilityId: string): string {
  requireCapabilityId(capabilityId);
  return `muxpilot-session-${capabilityId}.service`;
}

export function runtimePaths(runtimeRoot: string, capabilityId: string, socketRoot = runtimeRoot): {
  directory: string;
  socketDirectory: string;
  socketPath: string;
  environmentPath: string;
  unit: string;
} {
  requireCapabilityId(capabilityId);
  const directory = join(runtimeRoot, capabilityId);
  const socketDirectory = join(socketRoot, capabilityId);
  return {
    directory,
    socketDirectory,
    socketPath: join(socketDirectory, "app-server.sock"),
    environmentPath: join(socketDirectory, "environment"),
    unit: appServerServiceUnit(capabilityId)
  };
}

function validateSocketPath(socketPath: string): void {
  const byteLength = Buffer.byteLength(socketPath);
  if (byteLength > MAX_UNIX_SOCKET_PATH_BYTES) {
    throw new Error(
      `App-server socket path is ${byteLength} bytes; the maximum supported length is ${MAX_UNIX_SOCKET_PATH_BYTES}. ` +
      `Use a shorter XDG_RUNTIME_DIR: ${socketPath}`
    );
  }
}

function systemdRunArgs(spec: RuntimeStartSpec, paths: ReturnType<typeof runtimePaths>): string[] {
  const configArgs = [
    "-c", "check_for_update_on_startup=false",
    "-c", "sandbox_workspace_write.network_access=true"
  ];
  for (const server of spec.mcpServers) {
    configArgs.push(
      "-c", `mcp_servers.${server.name}.command=${JSON.stringify(server.command)}`,
      "-c", `mcp_servers.${server.name}.args=${JSON.stringify(server.args)}`
    );
    if (server.defaultToolsApprovalMode) {
      configArgs.push(
        "-c",
        `mcp_servers.${server.name}.default_tools_approval_mode=${JSON.stringify(server.defaultToolsApprovalMode)}`
      );
    }
  }
  return [
    "--user",
    `--unit=${paths.unit}`,
    "--quiet",
    "--collect",
    `--working-directory=${spec.cwd}`,
    "--property=Type=exec",
    "--property=Restart=on-failure",
    "--property=RestartSec=1s",
    "--property=StartLimitIntervalSec=60s",
    "--property=StartLimitBurst=3",
    "--property=KillMode=control-group",
    `--property=EnvironmentFile=${paths.environmentPath}`,
    "codex",
    ...configArgs,
    "app-server",
    "--listen",
    `unix://${paths.socketPath}`
  ];
}

function validateMcpServers(servers: RuntimeStartSpec["mcpServers"]): void {
  const names = new Set<string>();
  for (const server of servers) {
    if (!MCP_SERVER_NAME.test(server.name)) throw new Error(`Invalid app-server MCP server name: ${server.name}`);
    if (!server.command.trim()) throw new Error(`Missing command for app-server MCP server: ${server.name}`);
    if (names.has(server.name)) throw new Error(`Duplicate app-server MCP server name: ${server.name}`);
    names.add(server.name);
  }
}

async function preparePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`App-server runtime path is not a private directory: ${path}`);
  await chmod(path, 0o700);
}

function environmentFileContents(environment: Record<string, string>): string {
  const lines = Object.entries(environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => {
      if (!ENVIRONMENT_KEY.test(key)) throw new Error(`Invalid app-server environment key: ${key}`);
      if (/[\0\r\n]/.test(value)) throw new Error(`Invalid app-server environment value for ${key}`);
      return `${key}="${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
    });
  return `${lines.join("\n")}\n`;
}

async function writeEnvironmentFile(path: string, contents: string): Promise<void> {
  await rm(path, { force: true });
  await writeFile(path, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await chmod(path, 0o600);
}

function requireCapabilityId(capabilityId: string): void {
  if (!CAPABILITY_ID.test(capabilityId)) throw new Error("App-server capability id must be 24 lowercase hexadecimal characters");
}

function parseSystemdProperties(output: string): Record<string, string> {
  return Object.fromEntries(output.split(/\r?\n/).filter(Boolean).map((line) => {
    const separator = line.indexOf("=");
    return separator < 0 ? [line, ""] : [line.slice(0, separator), line.slice(separator + 1)];
  }));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function defaultDependencies(): SupervisorDependencies {
  return {
    run: async (command, args, options) => {
      const { stdout } = await execFileAsync(command, args, options);
      return { stdout: typeof stdout === "string" ? stdout : stdout.toString() };
    },
    openProxy: (socketPath) => openUnixWebSocketJsonLineConnection(socketPath),
    socketReady: async (socketPath) => lstat(socketPath).then((value) => value.isSocket()).catch(() => false),
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now()
  };
}
