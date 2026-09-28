/**
 * JSON-RPC contract between muxpilot and a per-session Claude host process.
 *
 * The host owns one Claude Agent SDK query in streaming-input mode. It stays deliberately thin: it translates
 * SDK traffic into this protocol, applies muxpilot's tool permission policy, and holds interactive requests
 * while muxpilot is disconnected. Transcript projection happens in muxpilot so projection fixes never require
 * restarting a running session.
 */

export const CLAUDE_HOST_PROTOCOL_VERSION = 1;

export type HostTurnStatus = "inProgress" | "completed" | "interrupted" | "failed";

export interface HostTurn {
  id: string;
  status: HostTurnStatus;
  /** Present for failed turns; `codexErrorInfo` carries a provider-neutral failure code. */
  error?: { message: string; codexErrorInfo?: string | null } | null;
  /** `[{ type: "plan" }]` when the turn proposed a plan for operator review. */
  items?: Array<{ type: string }>;
}

export interface HostThreadStatus {
  type: "idle" | "active" | "notLoaded";
  activeFlags?: Array<"waitingOnApproval" | "waitingOnUserInput">;
}

export type HostRequestMethod = "claude/approval" | "claude/question";

export interface HostPendingRequest {
  requestId: string;
  method: HostRequestMethod;
  params: HostApprovalParams | HostQuestionParams;
  openedAt: string;
}

export type HostApprovalCategory = "command" | "patch" | "tool" | "permissions";

export interface HostApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  toolName: string;
  category: HostApprovalCategory;
  title: string;
  command: string | null;
  cwd: string | null;
  reason: string | null;
  /** Bash command prefix that can be remembered for the session, when the CLI suggested one. */
  prefixRule: string[] | null;
  /** The subagent that asked, when the request did not come from the main conversation. */
  agentId?: string | null;
  agentLabel?: string | null;
  input: Record<string, unknown>;
}

export interface HostQuestionParams {
  threadId: string;
  turnId: string;
  itemId: string;
  questions: Array<{
    id: string;
    header: string;
    question: string;
    options: Array<{ label: string; description: string }>;
    multiSelect: boolean;
  }>;
}

export type HostApprovalResponse =
  | { behavior: "allow"; scope: "once" | "session" | "prefix" }
  | { behavior: "deny"; message?: string };

export type HostQuestionResponse =
  | { answers: Record<string, { answers: string[] }> }
  | { cancelled: true };

export interface HostSessionState {
  sessionId: string;
  cwd: string;
  transcriptPath: string | null;
  status: HostThreadStatus;
  activeTurn: HostTurn | null;
  latestTurn: HostTurn | null;
  pendingRequests: HostPendingRequest[];
  backgroundTasks: HostBackgroundTask[];
  /** Subagents, background shells and workflows Claude Code started in this session, newest last. */
  agents: HostAgent[];
  permissionMode: "default" | "plan";
  /** The Claude Code permission mode actually in effect (acceptEdits, plan or auto). */
  effectivePermissionMode: HostPermissionMode;
  approvalMode: HostApprovalMode;
  /** Native auto mode was requested but this account or model cannot use it. */
  autoUnavailable: boolean;
  /** Pending ScheduleWakeup / Cron work, which only fires while the runtime is alive. */
  schedules: HostSchedules;
  model: string | null;
  effort: string | null;
  fastMode: boolean | null;
}

/** muxpilot's approval routing; `auto` maps to Claude's native auto-approval classifier. */
export type HostApprovalMode = "ask" | "auto" | "full";

export type HostPermissionMode = "acceptEdits" | "plan" | "auto" | "default";

export interface HostSchedules {
  wakeupDueAt: string | null;
  cronJobIds: string[];
}

/** One Claude Code task (subagent, background shell, monitor or workflow) as reported by `task_*` events. */
export interface HostAgent {
  /** Task id; for subagents it is also the agent id of `subagents/agent-<id>.jsonl`. */
  taskId: string;
  /** The Agent/Task (or Bash) tool call that started it. */
  toolUseId: string | null;
  /** Claude Code task type, e.g. local_agent, local_bash, monitor, local_workflow. */
  taskType: string | null;
  subagentType: string | null;
  description: string;
  status: "running" | "paused" | "completed" | "failed" | "stopped";
  backgrounded: boolean;
  depth: number | null;
  lastToolName: string | null;
  /** Latest one-line progress summary, or the final summary once finished. */
  summary: string | null;
  error: string | null;
  usage: { totalTokens: number; toolUses: number; durationMs: number } | null;
  /** Housekeeping tasks Claude Code hides from activity indicators. */
  ambient: boolean;
  startedAt: string;
  updatedAt: string;
}

export interface HostBackgroundTask {
  taskId: string;
  toolUseId: string | null;
  turnId: string | null;
  description: string;
}

export interface HostMcpServer {
  name: string;
  command: string;
  args: string[];
}

/** Launch configuration applied when the host opens (or reopens) its SDK query. */
export interface HostLaunchConfig {
  model: string | null;
  effort: string | null;
  fastMode: boolean | null;
  permissionMode: "default" | "plan";
  approvalMode?: HostApprovalMode;
  systemPromptAppend: string | null;
  mcpServers: HostMcpServer[];
  /** Directories Claude may write without approval (cwd is always included). */
  writableRoots: string[];
  /** Unix sockets sandboxed commands may connect to (git broker, heavy queue, Docker guard). */
  allowUnixSockets: string[];
  settingSources: Array<"user" | "project" | "local">;
  pluginDirs: string[];
  /** Absolute path of the Claude Code executable. */
  claudePath: string;
}

export interface HostInputPart {
  type: "text" | "image";
  /** Text for text parts; an absolute image path for image parts. */
  value: string;
  mimeType?: string;
}

export interface InitializeParams {
  protocolVersion: number;
  clientVersion: string;
}

export interface InitializeResult {
  protocolVersion: number;
  hostVersion: string;
  sdkVersion: string | null;
  claudeVersion: string | null;
  hostInstanceId: string;
  state: HostSessionState | null;
}

export interface SessionOpenParams {
  mode: "start" | "resume" | "fork";
  /** New session id for `start` and `fork`. */
  sessionId: string;
  /** Existing conversation for `resume` and `fork`. */
  sourceSessionId?: string;
  cwd: string;
  launch: HostLaunchConfig;
  /** Replace an already-open session (clear-context implementation). */
  replace?: boolean;
}

export interface TurnStartParams {
  clientMessageId: string;
  messageUuid: string;
  content: HostInputPart[];
  mode: "default" | "plan";
  approvalMode?: HostApprovalMode;
  model: string | null;
  effort: string | null;
  fastMode: boolean | null;
}

export interface TurnSteerParams {
  expectedTurnId: string;
  clientMessageId: string;
  messageUuid: string;
  content: HostInputPart[];
}

export interface TurnReceipt {
  turnId: string;
  messageUuid: string;
}

export type HostInterruptOutcome = "interrupted" | "already_idle";

export interface SettingsUpdateParams {
  model?: string | null;
  effort?: string | null;
  permissionMode?: "default" | "plan";
  approvalMode?: HostApprovalMode;
  fastMode?: boolean | null;
}

/** JSON-RPC error codes the host returns for rejected operations. */
export const HOST_ERROR = {
  turnActive: -32010,
  noActiveTurn: -32011,
  notOpen: -32012,
  unknownRequest: -32013,
  invalidParams: -32602
} as const;

/** Notification methods sent from the host to muxpilot. */
export const HOST_NOTIFICATION = {
  sdkMessage: "sdk/message",
  /** The session's subagent and background task list changed; carries the full list. */
  agentsChanged: "agents/changed",
  /** Claude changed its own mode (EnterPlanMode) or native auto became unavailable. */
  modeChanged: "mode/changed",
  turnStarted: "turn/started",
  turnCompleted: "turn/completed",
  threadStatus: "thread/status/changed",
  inputAccepted: "input/accepted",
  requestOpened: "request/opened",
  requestResolved: "serverRequest/resolved",
  planProposed: "plan/proposed",
  authFailed: "auth/failed",
  hostError: "host/error"
} as const;

/**
 * Deterministic message uuid for a muxpilot submission. The Claude transcript keeps the supplied uuid, so input
 * reconciliation can find a submission even after the host restarts.
 */
export function submissionMessageUuid(sessionId: string, clientMessageId: string, sha256Hex: (value: string) => string): string {
  const hex = sha256Hex(`muxpilot-submission:${sessionId}:${clientMessageId}`).slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}

/** Claude Code's project directory name for a working directory. */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}
