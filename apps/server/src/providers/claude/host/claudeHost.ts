import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { JsonRpcConnection, type JsonRpcServerRequest } from "../../../runtime/jsonRpcConnection.js";
import { socketConnection } from "../../../runtime/unixJsonLineConnection.js";
import { claudeAgentSdkVersion } from "../sdkVersion.js";
import { HostOperationError, HostSession, type PersistedHostState } from "./hostSession.js";
import {
  CLAUDE_HOST_PROTOCOL_VERSION,
  HOST_ERROR,
  type InitializeResult,
  type SessionOpenParams,
  type SettingsUpdateParams,
  type TurnStartParams,
  type TurnSteerParams
} from "./protocol.js";

const execFileAsync = promisify(execFile);
const HOST_VERSION = "1";
const STATE_FILE = "host-state.json";
/** Pending approvals can wait for the operator indefinitely; the host never issues timed requests. */
const REQUEST_TIMEOUT_MS = 24 * 60 * 60_000;

interface HostArguments {
  socketPath: string;
  stateDir: string;
  configDir: string;
}

/** Entry point for one Claude session runtime launched as a user systemd service. */
export async function runClaudeHost(args: HostArguments): Promise<void> {
  const hostInstanceId = randomUUID();
  const log = (message: string, detail?: unknown) => {
    process.stderr.write(`${new Date().toISOString()} ${message}${detail === undefined ? "" : ` ${formatDetail(detail)}`}\n`);
  };
  let connection: JsonRpcConnection | null = null;
  const session = new HostSession({
    queryFactory: (params) => query(params),
    notify: (method, params) => {
      void connection?.notify(method, params).catch(() => undefined);
    },
    configDir: args.configDir,
    environment: claudeRuntimeEnvironment(process.env),
    persistState: (state) => persistState(args.stateDir, state),
    log
  });
  const persisted = await loadState(args.stateDir);
  if (persisted) session.restorePersisted(persisted);
  const versions = await runtimeVersions(persisted?.launch.claudePath ?? null);

  const handle = async (request: JsonRpcServerRequest): Promise<unknown> => {
    const params = (request.params ?? {}) as Record<string, unknown>;
    switch (request.method) {
      case "initialize": {
        if (params.protocolVersion !== CLAUDE_HOST_PROTOCOL_VERSION) {
          throw new HostOperationError(HOST_ERROR.invalidParams, `Unsupported host protocol version: ${String(params.protocolVersion)}`);
        }
        const result: InitializeResult = {
          protocolVersion: CLAUDE_HOST_PROTOCOL_VERSION,
          hostVersion: HOST_VERSION,
          sdkVersion: versions.sdk,
          claudeVersion: versions.claude,
          hostInstanceId,
          state: session.isOpen() ? session.state() : null
        };
        queueMicrotask(() => session.replayPendingRequests());
        return result;
      }
      case "session/open": return session.open(params as unknown as SessionOpenParams);
      case "state/read": return session.state();
      case "turn/start": return session.startTurn(params as unknown as TurnStartParams);
      case "turn/steer": return session.steerTurn(params as unknown as TurnSteerParams);
      case "turn/interrupt": return { outcome: await session.interrupt(typeof params.turnId === "string" ? params.turnId : null) };
      case "input/lookup": return session.lookupInput(String(params.clientMessageId ?? ""));
      case "request/respond": {
        const accepted = session.respond(String(params.requestId ?? ""), params.response);
        return { accepted };
      }
      case "settings/update": {
        await session.updateSettings(params as SettingsUpdateParams);
        return {};
      }
      case "tasks/list": return { tasks: session.listTasks() };
      case "tasks/stop": {
        await session.stopTask(String(params.taskId ?? ""));
        return {};
      }
      case "context/read": return session.contextUsage();
      case "shutdown": {
        if (session.hasActiveTurn() && params.force !== true) {
          throw new HostOperationError(HOST_ERROR.turnActive, "Cannot shut down while a Claude turn is active");
        }
        setTimeout(() => void shutdown(0), 50);
        return {};
      }
      default:
        throw new HostOperationError(-32601, `Unknown host method: ${request.method}`);
    }
  };

  const server = createServer((socket: Socket) => {
    // muxpilot has exactly one live client; a new connection replaces a half-open one after a server restart.
    const previous = connection;
    connection = null;
    void previous?.close().catch(() => undefined);
    let opened!: Promise<JsonRpcConnection>;
    opened = JsonRpcConnection.connect(`claude-host-${randomUUID()}`, socketConnection(socket), { append: async () => undefined }, {
      serverRequest: async (request) => {
        const current = await opened;
        try {
          const result = await handle(request);
          await current.respond(request.id, result ?? null);
        } catch (error) {
          const code = error instanceof HostOperationError ? error.code : -32000;
          await current.respondError(request.id, { code, message: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
        }
      },
      error: (error) => log("client connection closed", error.message)
    }, { requestTimeoutMs: REQUEST_TIMEOUT_MS });
    opened.then((value) => {
      connection = value;
    }).catch((error) => log("client connection failed", error));
  });

  await mkdir(args.stateDir, { recursive: true, mode: 0o700 });
  await rm(args.socketPath, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(args.socketPath, () => resolve());
  });
  log("claude host listening", { socket: args.socketPath, restored: Boolean(persisted) });

  let stopping = false;
  async function shutdown(code: number): Promise<void> {
    if (stopping) return;
    stopping = true;
    await session.close().catch(() => undefined);
    await connection?.close().catch(() => undefined);
    server.close();
    await rm(args.socketPath, { force: true }).catch(() => undefined);
    process.exit(code);
  }
  process.once("SIGTERM", () => void shutdown(0));
  process.once("SIGINT", () => void shutdown(0));
}

async function loadState(stateDir: string): Promise<PersistedHostState | null> {
  try {
    return JSON.parse(await readFile(join(stateDir, STATE_FILE), "utf8")) as PersistedHostState;
  } catch {
    return null;
  }
}

async function persistState(stateDir: string, state: PersistedHostState): Promise<void> {
  const target = join(stateDir, STATE_FILE);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
  await rename(temporary, target);
}

async function runtimeVersions(claudePath: string | null): Promise<{ sdk: string | null; claude: string | null }> {
  const sdk = claudeAgentSdkVersion();
  let claude: string | null = null;
  if (claudePath) {
    claude = await execFileAsync(claudePath, ["--version"], { timeout: 10_000 })
      .then(({ stdout }) => stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? null)
      .catch(() => null);
  }
  return { sdk, claude };
}

function formatDetail(detail: unknown): string {
  if (detail instanceof Error) return detail.message;
  if (typeof detail === "string") return detail;
  try { return JSON.stringify(detail); } catch { return String(detail); }
}

export function parseHostArguments(argv: string[]): HostArguments {
  const value = (flag: string): string => {
    const index = argv.indexOf(flag);
    const result = index >= 0 ? argv[index + 1] : undefined;
    if (!result) throw new Error(`Missing ${flag}`);
    return result;
  };
  return { socketPath: value("--socket"), stateDir: value("--state-dir"), configDir: value("--config-dir") };
}

/**
 * Environment for the Claude CLI. API-key variables are removed so sessions use the CLI-managed login unless the
 * operator opts in, and nested-agent markers from a parent Claude process never leak into a session.
 */
export function claudeRuntimeEnvironment(environment: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = { ...environment, DISABLE_AUTOUPDATER: "1" };
  if (environment.MUXPILOT_CLAUDE_ALLOW_API_KEY !== "1") {
    delete result.ANTHROPIC_API_KEY;
    delete result.ANTHROPIC_AUTH_TOKEN;
  }
  delete result.CLAUDECODE;
  delete result.CLAUDE_CODE_ENTRYPOINT;
  delete result.CLAUDE_CODE_SSE_PORT;
  return result;
}
