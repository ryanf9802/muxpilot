import type { Readable, Writable } from "node:stream";
import type {
  AgentProviderRef,
  ApprovalDecision,
  CollaborationMode,
  ManagedSession,
  PlanActionChoice,
  QuestionAnswerRequest,
  SessionCapabilities,
  SessionModelSettings,
  SessionRuntimeRef
} from "@muxpilot/core";

export interface McpServerLaunchConfig {
  name: string;
  command: string;
  args: string[];
  defaultToolsApprovalMode?: "auto" | "prompt" | "approve";
}

export interface AgentSessionLaunchOptions {
  isolatedWorkspace?: boolean;
  writableRoots?: string[];
  developerInstructions?: string;
  environment?: Record<string, string>;
  mcpServers?: McpServerLaunchConfig[];
  resourceUnitName?: string;
  resourceUnitEnvironment?: Record<string, string>;
  model?: string | null;
  reasoningEffort?: string | null;
  fastMode?: boolean | null;
}

export interface AgentSessionLaunchSpec {
  sessionId: string;
  name: string;
  cwd: string;
  options: AgentSessionLaunchOptions;
  sourceThreadId?: string;
}

export interface AgentSessionLaunchResult {
  sessionId: string;
  provider: AgentProviderRef;
  runtime: SessionRuntimeRef;
  capabilities: SessionCapabilities;
  ready: Promise<void>;
}

export interface DriverInputReceipt {
  clientMessageId: string;
  threadId: string;
  turnId: string;
  acceptedAt: string;
}

export interface DriverPlanActionRequest {
  plan: string | null;
  clientMessageId: string | null;
  launchOptions?: AgentSessionLaunchOptions;
}

export interface DriverPlanActionResult {
  provider: AgentProviderRef;
  receipt: DriverInputReceipt | null;
}

export interface DriverEvent {
  method: string;
  params: unknown;
  receivedAt: string;
}

export interface DriverSubscription {
  close(): Promise<void>;
}

export interface AgentSessionDriver {
  readonly kind: "codex_app_server";
  readonly capabilities: SessionCapabilities;
  start(spec: AgentSessionLaunchSpec): Promise<AgentSessionLaunchResult>;
  resume(spec: AgentSessionLaunchSpec): Promise<AgentSessionLaunchResult>;
  fork(spec: AgentSessionLaunchSpec): Promise<AgentSessionLaunchResult>;
  subscribe(session: ManagedSession, onEvent: (event: DriverEvent) => void): Promise<DriverSubscription>;
  sendMessage(session: ManagedSession, text: string, clientMessageId: string): Promise<DriverInputReceipt>;
  reconcileInput(session: ManagedSession, clientMessageId: string): Promise<DriverInputReceipt | null>;
  steer(session: ManagedSession, text: string, clientMessageId: string): Promise<DriverInputReceipt>;
  interrupt(session: ManagedSession, expectedTurnId: string | null): Promise<void>;
  kill(session: ManagedSession): Promise<void>;
  answerApproval(session: ManagedSession, requestId: string | number, decision: ApprovalDecision): Promise<void>;
  answerQuestion(session: ManagedSession, requestId: string | number, answer: QuestionAnswerRequest): Promise<void>;
  hibernationBlockers(session: ManagedSession): Promise<string[]>;
  hibernate(session: ManagedSession): Promise<SystemdSessionRuntimeRef>;
  runtimeEvidence(session: ManagedSession): Promise<RuntimeEvidence>;
  choosePlanAction(
    session: ManagedSession,
    action: PlanActionChoice,
    request: DriverPlanActionRequest
  ): Promise<DriverPlanActionResult>;
  setPreferences(session: ManagedSession, preferences: {
    mode?: CollaborationMode;
    model?: SessionModelSettings;
    fastMode?: boolean;
  }): Promise<void>;
  rename(session: ManagedSession, name: string): Promise<void>;
}

export type SystemdSessionRuntimeRef = Extract<SessionRuntimeRef, { kind: "systemd_service" }>;

export interface RuntimeStartSpec {
  sessionId: string;
  capabilityId: string;
  cwd: string;
  codexHome: string;
  codexVersion: string | null;
  environment: Record<string, string>;
  mcpServers: McpServerLaunchConfig[];
}

export interface RuntimeProxyConnection {
  input: Writable;
  output: Readable;
  close(): Promise<void>;
}

export interface RuntimeEvidence {
  runtime: SystemdSessionRuntimeRef;
  activeState: string | null;
  subState: string | null;
  mainPid: number | null;
  controlGroup: string | null;
  socketPresent: boolean;
  attachmentCommand: string;
}

export interface RuntimeSupervisor {
  start(spec: RuntimeStartSpec): Promise<SystemdSessionRuntimeRef>;
  reconnect(runtime: SystemdSessionRuntimeRef): Promise<RuntimeProxyConnection>;
  stop(runtime: SystemdSessionRuntimeRef): Promise<SystemdSessionRuntimeRef>;
  inspect(runtime: SystemdSessionRuntimeRef): Promise<RuntimeEvidence>;
}
