import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
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
const DEFAULT_START_TIMEOUT_MS = 30_000;
const DEFAULT_SOCKET_POLL_MS = 50;
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
}

export class SystemdAppServerSupervisor implements RuntimeSupervisor {
  private readonly runtimeRoot: string;
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
    this.dependencies = { ...defaultDependencies(), ...dependencies };
    this.startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    this.socketPollMs = options.socketPollMs ?? DEFAULT_SOCKET_POLL_MS;
    this.executablePath = options.executablePath ?? process.env.PATH ?? null;
  }

  async start(spec: RuntimeStartSpec): Promise<SystemdSessionRuntimeRef> {
    const paths = runtimePaths(this.runtimeRoot, spec.capabilityId);
    await preparePrivateDirectory(this.runtimeRoot);
    await preparePrivateDirectory(paths.directory);
    await writeEnvironmentFile(paths.environmentPath, {
      ...spec.environment,
      ...(this.executablePath ? { PATH: this.executablePath } : {}),
      CODEX_HOME: spec.codexHome
    });

    const runtime: SystemdSessionRuntimeRef = {
      kind: "systemd_service",
      unit: paths.unit,
      socketPath: paths.socketPath,
      state: "starting",
      codexVersion: spec.codexVersion
    };
    const existing = await this.inspect(runtime);
    if (existing.activeState === "active" && existing.socketPresent) return { ...runtime, state: "connected" };
    if (existing.activeState && existing.activeState !== "inactive") {
      await this.dependencies.run("systemctl", ["--user", "stop", paths.unit]).catch(() => undefined);
    }
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
    await this.dependencies.run("systemctl", ["--user", "stop", runtime.unit]);
    await rm(runtime.socketPath, { force: true });
    return { ...runtime, state: "stopped" };
  }

  async inspect(runtime: SystemdSessionRuntimeRef): Promise<RuntimeEvidence> {
    this.requireOwnedRuntime(runtime);
    const properties = await this.dependencies.run("systemctl", [
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
    const expected = runtimePaths(this.runtimeRoot, capabilityId);
    if (runtime.socketPath !== expected.socketPath) {
      throw new Error(`Refusing app-server socket outside its owned runtime path: ${runtime.socketPath}`);
    }
  }
}

export function appServerServiceUnit(capabilityId: string): string {
  requireCapabilityId(capabilityId);
  return `muxpilot-session-${capabilityId}.service`;
}

export function runtimePaths(runtimeRoot: string, capabilityId: string): {
  directory: string;
  socketPath: string;
  environmentPath: string;
  unit: string;
} {
  requireCapabilityId(capabilityId);
  const directory = join(runtimeRoot, capabilityId);
  return {
    directory,
    socketPath: join(directory, "app-server.sock"),
    environmentPath: join(directory, "environment"),
    unit: appServerServiceUnit(capabilityId)
  };
}

function systemdRunArgs(spec: RuntimeStartSpec, paths: ReturnType<typeof runtimePaths>): string[] {
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
    "app-server",
    "--listen",
    `unix://${paths.socketPath}`
  ];
}

async function preparePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`App-server runtime path is not a private directory: ${path}`);
  await chmod(path, 0o700);
}

async function writeEnvironmentFile(path: string, environment: Record<string, string>): Promise<void> {
  const lines = Object.entries(environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => {
      if (!ENVIRONMENT_KEY.test(key)) throw new Error(`Invalid app-server environment key: ${key}`);
      if (/[\0\r\n]/.test(value)) throw new Error(`Invalid app-server environment value for ${key}`);
      return `${key}="${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
    });
  await rm(path, { force: true });
  await writeFile(path, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
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
      return execFileAsync(command, args, options);
    },
    openProxy: (socketPath) => openUnixWebSocketJsonLineConnection(socketPath),
    socketReady: async (socketPath) => lstat(socketPath).then((value) => value.isSocket()).catch(() => false),
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now()
  };
}
