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

  async resumeThread(threadId: string): Promise<ThreadIdentityResponse> {
    return requireThreadIdentityResponse(await this.rpc.request<unknown>("thread/resume", { threadId }));
  }

  async readThread(threadId: string, includeTurns = true): Promise<ThreadIdentityResponse> {
    return requireThreadIdentityResponse(await this.rpc.request<unknown>("thread/read", { threadId, includeTurns }));
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
