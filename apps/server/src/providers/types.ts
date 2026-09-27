import type { Readable, Writable } from "node:stream";
import type {
  AgentProviderKind,
  AgentProviderRef,
  ApprovalDecision,
  CollaborationMode,
  ManagedSession,
  PlanActionChoice,
  QuestionAnswerRequest,
  SessionCapabilities,
  SessionModelSettings,
  ProviderAuthState,
  ProviderCapabilities,
  ProviderCompatibility,
  ProviderSkillInvocation,
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
  launchDisposition: "started" | "reused";
  capabilities: SessionCapabilities;
  ready: Promise<void>;
}

export interface DriverInputReceipt {
  clientMessageId: string;
  threadId: string;
  turnId: string;
  acceptedAt: string;
}

export type DriverInterruptOutcome = "interrupted" | "interrupted_cleanup_pending" | "cleanup_completed" | "already_idle";
export type DriverInterruptIntent = "operator" | "budget_guard";

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

/** Receives runtime events for projection into muxpilot state. */
export interface DriverEventSink {
  handle(sessionId: string, event: DriverEvent): Promise<void>;
  restore(sessionId: string, threadId: string, status: unknown, latestTurn: Record<string, unknown> | null, restoredAt: string): Promise<void>;
  recordIntentionalInterruption?(
    sessionId: string,
    threadId: string,
    turnId: string,
    intent: DriverInterruptIntent,
    observedAt: string
  ): Promise<void>;
}

export interface DriverSubscription {
  close(): Promise<void>;
}

export interface AgentSessionDriver {
  readonly kind: AgentProviderKind;
  readonly capabilities: SessionCapabilities;
  start(spec: AgentSessionLaunchSpec): Promise<AgentSessionLaunchResult>;
  resume(spec: AgentSessionLaunchSpec): Promise<AgentSessionLaunchResult>;
  fork(spec: AgentSessionLaunchSpec): Promise<AgentSessionLaunchResult>;
  subscribe(session: ManagedSession, onEvent: (event: DriverEvent) => void): Promise<DriverSubscription>;
  sendMessage(session: ManagedSession, text: string, clientMessageId: string, content?: import("@muxpilot/core").MessageContentPart[]): Promise<DriverInputReceipt>;
  reconcileInput(session: ManagedSession, clientMessageId: string): Promise<DriverInputReceipt | null>;
  steer(session: ManagedSession, text: string, clientMessageId: string, content?: import("@muxpilot/core").MessageContentPart[]): Promise<DriverInputReceipt>;
  interrupt(session: ManagedSession, expectedTurnId: string | null, intent?: DriverInterruptIntent): Promise<DriverInterruptOutcome>;
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
  agentVersion: string | null;
  /** Provider runtime argv, given the private socket and state directory owned by this runtime. */
  command(paths: { socketPath: string; directory: string }): string[];
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
  start(spec: RuntimeStartSpec): Promise<SystemdSessionRuntimeRef & { launchDisposition?: "started" | "reused" }>;
  reconnect(runtime: SystemdSessionRuntimeRef): Promise<RuntimeProxyConnection>;
  stop(runtime: SystemdSessionRuntimeRef): Promise<SystemdSessionRuntimeRef>;
  inspect(runtime: SystemdSessionRuntimeRef): Promise<RuntimeEvidence>;
}

/**
 * Everything muxpilot needs from one agent provider (Codex, Claude). Session behavior that differs by
 * provider is reached through this bundle; provider-neutral orchestration stays in SessionManager.
 */
export interface AgentProvider {
  readonly kind: AgentProviderKind;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;
  readonly skillInvocation: ProviderSkillInvocation;
  /** Startup compatibility probe result; an unavailable provider has no driver. */
  compatibility(): ProviderCompatibility;
  readonly driver: AgentSessionDriver | null;
  readonly auth: ProviderAuthGate;
}

/** The authentication surface SessionManager and routes use; implemented by ProviderAuthLifecycle. */
export interface ProviderAuthGate {
  state(): ProviderAuthState;
  /** Throws ProviderAuthUnavailableError unless the account is signed in. */
  assertAvailable(): void;
  /** Throws unless signed in and no account change is still being reconciled. */
  assertReady(): void;
  refresh(): Promise<ProviderAuthState>;
}
