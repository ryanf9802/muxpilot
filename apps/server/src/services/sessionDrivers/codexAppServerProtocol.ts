import { isAbsolute } from "node:path";

export const REQUIRED_CLIENT_METHODS = [
  "initialize",
  "thread/start",
  "thread/resume",
  "thread/fork",
  "thread/read",
  "thread/name/set",
  "thread/settings/update",
  "thread/backgroundTerminals/list",
  "thread/backgroundTerminals/terminate",
  "skills/list",
  "model/list",
  "collaborationMode/list",
  "turn/start",
  "turn/steer",
  "turn/interrupt"
] as const;

export const REQUIRED_SERVER_REQUESTS = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request"
] as const;

export const REQUIRED_SERVER_NOTIFICATIONS = [
  "thread/started",
  "thread/status/changed",
  "thread/name/updated",
  "thread/tokenUsage/updated",
  "turn/started",
  "turn/completed",
  "turn/plan/updated",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/plan/delta",
  "item/commandExecution/outputDelta",
  "serverRequest/resolved"
] as const;

export const REQUIRED_PROTOCOL_FIELDS = [
  "clientUserMessageId",
  "threadId",
  "turnId",
  "cwd",
  "model",
  "reasoningEffort",
  "serviceTier"
] as const;

export interface AppServerProtocolCompatibility {
  compatible: boolean;
  missingCapabilities: string[];
}

export interface InitializeResponse {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

export interface ThreadIdentityResponse {
  thread: { id: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface ThreadLaunchSettings {
  cwd: string;
  model?: string | null;
  developerInstructions?: string | null;
  runtimeWorkspaceRoots?: string[] | null;
  serviceTier?: string | null;
}

export interface TurnIdentityResponse {
  turn: { id: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface TurnSteerResponse {
  turnId: string;
  [key: string]: unknown;
}

export interface ProtocolRequester {
  request<T>(method: string, params: unknown): Promise<T>;
}

export class CodexAppServerProtocol {
  constructor(private readonly rpc: ProtocolRequester) {}

  async initialize(clientVersion: string): Promise<InitializeResponse> {
    const response = await this.rpc.request<unknown>("initialize", {
      clientInfo: { name: "muxpilot", title: "muxpilot", version: clientVersion },
      capabilities: { experimentalApi: true }
    });
    return requireInitializeResponse(response);
  }

  async startThread(settings: ThreadLaunchSettings): Promise<ThreadIdentityResponse> {
    validateThreadSettings(settings);
    return requireThreadIdentityResponse(await this.rpc.request<unknown>("thread/start", settings));
  }

  async resumeThread(threadId: string, settings: Partial<ThreadLaunchSettings> = {}): Promise<ThreadIdentityResponse> {
    requireNonEmpty(threadId, "threadId");
    validateThreadSettings(settings);
    return requireThreadIdentityResponse(await this.rpc.request<unknown>("thread/resume", { ...settings, threadId }));
  }

  async forkThread(threadId: string, settings: Partial<ThreadLaunchSettings> = {}): Promise<ThreadIdentityResponse> {
    requireNonEmpty(threadId, "threadId");
    validateThreadSettings(settings);
    return requireThreadIdentityResponse(await this.rpc.request<unknown>("thread/fork", { ...settings, threadId }));
  }

  async readThread(threadId: string, includeTurns = true): Promise<ThreadIdentityResponse> {
    requireNonEmpty(threadId, "threadId");
    return requireThreadIdentityResponse(await this.rpc.request<unknown>("thread/read", { threadId, includeTurns }));
  }

  async startTurn(
    threadId: string,
    text: string,
    clientUserMessageId: string,
    options: Record<string, unknown> = {}
  ): Promise<TurnIdentityResponse> {
    requireNonEmpty(threadId, "threadId");
    requireNonEmpty(text, "text");
    requireNonEmpty(clientUserMessageId, "clientUserMessageId");
    return requireTurnIdentityResponse(await this.rpc.request<unknown>("turn/start", {
      ...options,
      threadId,
      input: [{ type: "text", text }],
      clientUserMessageId
    }));
  }

  async steerTurn(
    threadId: string,
    expectedTurnId: string,
    text: string,
    clientUserMessageId: string
  ): Promise<TurnSteerResponse> {
    requireNonEmpty(threadId, "threadId");
    requireNonEmpty(expectedTurnId, "expectedTurnId");
    requireNonEmpty(text, "text");
    requireNonEmpty(clientUserMessageId, "clientUserMessageId");
    return requireTurnSteerResponse(await this.rpc.request<unknown>("turn/steer", {
      threadId,
      expectedTurnId,
      input: [{ type: "text", text }],
      clientUserMessageId
    }));
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    requireNonEmpty(threadId, "threadId");
    requireNonEmpty(turnId, "turnId");
    await this.rpc.request<unknown>("turn/interrupt", { threadId, turnId });
  }

  async renameThread(threadId: string, name: string): Promise<void> {
    requireNonEmpty(threadId, "threadId");
    requireNonEmpty(name, "name");
    await this.rpc.request<unknown>("thread/name/set", { threadId, name });
  }

  async updateThreadSettings(threadId: string, settings: Record<string, unknown>): Promise<void> {
    requireNonEmpty(threadId, "threadId");
    await this.rpc.request<unknown>("thread/settings/update", { ...settings, threadId });
  }

  async listBackgroundTerminals(threadId: string): Promise<unknown> {
    requireNonEmpty(threadId, "threadId");
    return this.rpc.request<unknown>("thread/backgroundTerminals/list", { threadId });
  }

  async terminateBackgroundTerminal(threadId: string, processId: string): Promise<void> {
    requireNonEmpty(threadId, "threadId");
    requireNonEmpty(processId, "processId");
    await this.rpc.request<unknown>("thread/backgroundTerminals/terminate", { threadId, processId });
  }
}

export function checkGeneratedProtocolSchema(schemaText: string): AppServerProtocolCompatibility {
  let schema: unknown;
  try {
    schema = JSON.parse(schemaText);
  } catch {
    return { compatible: false, missingCapabilities: ["valid-generated-schema"] };
  }
  const serialized = JSON.stringify(schema);
  const missingCapabilities = [
    ...[...REQUIRED_CLIENT_METHODS, ...REQUIRED_SERVER_REQUESTS, ...REQUIRED_SERVER_NOTIFICATIONS]
      .filter((method) => !serialized.includes(JSON.stringify(method))),
    ...REQUIRED_PROTOCOL_FIELDS
      .filter((field) => !serialized.includes(JSON.stringify(field)))
      .map((field) => `field:${field}`)
  ];
  return { compatible: missingCapabilities.length === 0, missingCapabilities };
}

function requireInitializeResponse(value: unknown): InitializeResponse {
  if (!isRecord(value)) throw new Error("Codex initialize response is not an object");
  const { userAgent, codexHome, platformFamily, platformOs } = value;
  if (
    typeof userAgent !== "string" || !userAgent
    || typeof codexHome !== "string" || !isAbsolute(codexHome)
    || typeof platformFamily !== "string" || !platformFamily
    || typeof platformOs !== "string" || !platformOs
  ) {
    throw new Error("Codex initialize response is missing required identity fields");
  }
  return { userAgent, codexHome, platformFamily, platformOs };
}

function requireThreadIdentityResponse(value: unknown): ThreadIdentityResponse {
  if (!isRecord(value) || !isRecord(value.thread) || typeof value.thread.id !== "string" || !value.thread.id) {
    throw new Error("Codex thread response is missing thread.id");
  }
  return value as ThreadIdentityResponse;
}

function requireTurnIdentityResponse(value: unknown): TurnIdentityResponse {
  if (!isRecord(value) || !isRecord(value.turn) || typeof value.turn.id !== "string" || !value.turn.id) {
    throw new Error("Codex turn response is missing turn.id");
  }
  return value as TurnIdentityResponse;
}

function requireTurnSteerResponse(value: unknown): TurnSteerResponse {
  if (!isRecord(value) || typeof value.turnId !== "string" || !value.turnId) {
    throw new Error("Codex steer response is missing turnId");
  }
  return value as TurnSteerResponse;
}

function requireNonEmpty(value: string, name: string): void {
  if (!value.trim()) throw new Error(`${name} must not be empty`);
}

function validateThreadSettings(settings: Partial<ThreadLaunchSettings>): void {
  if (settings.cwd != null && !isAbsolute(settings.cwd)) throw new Error("cwd must be absolute");
  if (settings.runtimeWorkspaceRoots?.some((root) => !isAbsolute(root))) {
    throw new Error("runtimeWorkspaceRoots must be absolute");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
