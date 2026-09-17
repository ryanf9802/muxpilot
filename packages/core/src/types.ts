export type SessionStatus =
  | "idle"
  | "generating"
  | "executing"
  | "working"
  | "running"
  | "planning"
  | "queued"
  | "waiting"
  | "approval"
  | "question"
  | "plan_ready"
  | "blocked"
  | "input_failed"
  | "startup_failed"
  | "missing"
  | "unknown";

export type SessionDisplayStatus = SessionStatus | "completed";

export function canToggleFastMode(status: SessionStatus): boolean {
  return status === "idle"
    || status === "waiting"
    || status === "generating"
    || status === "executing"
    || status === "working"
    || status === "running"
    || status === "planning";
}

export type CollaborationMode = "default" | "plan";

export type ApprovalMode = "ask" | "auto" | "full";

export interface ApprovalReviewerSettings {
  model: string;
  reasoningEffort: string | null;
}

export interface ApprovalReviewerSettingsResponse {
  settings: ApprovalReviewerSettings;
}

export interface SessionModelSettings {
  model: string | null;
  reasoningEffort: string | null;
}

export interface SessionModelSelections {
  default: SessionModelSettings;
  plan: SessionModelSettings;
}

export type CodexSkillSource = "user" | "system" | "plugin" | "workspace";

export interface CodexSkill {
  name: string;
  description: string;
  source: CodexSkillSource;
  pluginName?: string;
}

export interface CodexSkillsResponse {
  skills: CodexSkill[];
}

export interface MuxpilotGitSkillStatus {
  status: "missing" | "outdated" | "current";
  path: string;
}

export interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
  supportedReasoningEfforts: CodexReasoningEffortOption[];
  defaultReasoningEffort: string | null;
  serviceTiers: CodexServiceTier[];
}

export interface CodexServiceTier {
  id: string;
  name: string;
  description: string;
}

export interface CodexReasoningEffortOption {
  reasoningEffort: string;
  description: string;
}

export interface CodexModelCatalogResponse {
  models: CodexModel[];
  defaults: SessionModelSelections;
}

export interface GlobalModelSettingsResponse {
  settings: SessionModelSelections;
}

export interface UpdateGlobalModelSettingsRequest {
  mode: CollaborationMode;
  model: string;
  reasoningEffort: string | null;
}

export type MessageType =
  | "user"
  | "assistant"
  | "assistant_update"
  | "system"
  | "tool_call"
  | "tool_output"
  | "command_output"
  | "status"
  | "approval_request"
  | "question_request"
  | "parser_notice";

export type AgentProviderKind = "codex";

export interface AgentProviderRef {
  kind: AgentProviderKind;
  threadId: string | null;
  rolloutPath: string | null;
}

export interface SessionRuntimeRef {
  kind: "systemd_service";
  unit: string;
  socketPath: string;
  state: "starting" | "connected" | "hibernated" | "stopped" | "failed";
  codexVersion: string | null;
}

export interface SessionCapabilities {
  start: boolean;
  sendMessage: boolean;
  steer: boolean;
  resume: boolean;
  fork: boolean;
  verifiedInput: boolean;
  interrupt: boolean;
  kill: boolean;
  approvals: boolean;
  questions: boolean;
  planActions: boolean;
  fastMode: boolean;
  terminalAttach: boolean;
  hibernate: boolean;
}

export type AppServerCompatibilityStatus =
  | "available"
  | "user_systemd_unavailable"
  | "incompatible_codex_protocol"
  | "failed_health_probe";

export interface AppServerCompatibility {
  status: AppServerCompatibilityStatus;
  available: boolean;
  codexVersion: string | null;
  detail: string;
  checkedAt: string;
  missingCapabilities: string[];
}

export interface RepoMetadata {
  root: string | null;
  name: string;
  branch: string | null;
  dirty: boolean;
  worktree: string | null;
}

export interface GitDependencyLink {
  kind: "node" | "python" | "composer" | "bundler";
  relativePath: string;
  sourcePath: string;
  linked: boolean;
}

export type GitWorkspaceState = "idle" | "worktree" | "integrating" | "blocked" | "failed";

export interface GitWorkspaceSummary {
  workflowVersion: 1;
  id: string;
  state: GitWorkspaceState;
  entryPath: string;
  repoRoot: string;
  targetBranch: string;
  targetSha: string;
  sessionBranch: string | null;
  worktreePath: string | null;
  lastError: string | null;
  updatedAt: string;
  dependencyLinks: GitDependencyLink[];
}

const GIT_WORKSPACE_STATES: readonly GitWorkspaceState[] = ["idle", "worktree", "integrating", "blocked", "failed"];

/** Converts persisted or historical workspace data into the UI-safe local workflow shape. */
export function normalizeGitWorkspaceSummary(value: unknown): GitWorkspaceSummary | null {
  if (!value || typeof value !== "object") return null;
  const workspace = value as Record<string, unknown>;
  if (typeof workspace.id !== "string" || typeof workspace.targetBranch !== "string") return null;
  const current = workspace.workflowVersion === 1;
  const state = current && GIT_WORKSPACE_STATES.includes(workspace.state as GitWorkspaceState)
    ? workspace.state as GitWorkspaceState
    : "idle";
  const errorState = state === "blocked" || state === "failed";
  return {
    workflowVersion: 1,
    id: workspace.id,
    state,
    entryPath: typeof workspace.entryPath === "string" ? workspace.entryPath : "",
    repoRoot: typeof workspace.repoRoot === "string" ? workspace.repoRoot : "",
    targetBranch: workspace.targetBranch,
    targetSha: typeof workspace.targetSha === "string" ? workspace.targetSha : "",
    sessionBranch: current && typeof workspace.sessionBranch === "string" ? workspace.sessionBranch : null,
    worktreePath: current && typeof workspace.worktreePath === "string" ? workspace.worktreePath : null,
    lastError: current && errorState && typeof workspace.lastError === "string" ? workspace.lastError : null,
    updatedAt: current && typeof workspace.updatedAt === "string" ? workspace.updatedAt : "",
    dependencyLinks: current && Array.isArray(workspace.dependencyLinks)
      ? workspace.dependencyLinks as GitDependencyLink[]
      : []
  };
}

export interface SessionResourceUsage {
  memoryCurrentBytes: number;
  memoryHighBytes: number;
  memoryMaxBytes: number;
  cpuPercent: number | null;
  cpuLimitPercent: number;
  sampledAt: string;
}

export interface SessionContextUsage {
  activeTokens: number;
  contextWindowTokens: number;
  contextPercent: number;
  lifetimeInputTokens: number;
  lifetimeCachedInputTokens: number;
  lifetimeOutputTokens: number;
  lifetimeReasoningTokens: number;
  lifetimeTotalTokens: number;
  lifetimeWorkTokens: number;
  sampledAt: string;
}

export interface AgentSessionOwnership {
  parentSessionId: string;
  rootSessionId: string;
  origin: "created" | "claimed";
  createdAt: string;
  workTokenBaseline: number;
  workTokensUsed?: number;
  workTokenLastObserved?: number;
  workTokenLastSampledAt?: string | null;
  workTokenBudget: number;
  completedAt: string | null;
  budgetExhaustedAt?: string | null;
}

export interface AgentSessionSummary {
  liveDescendantCount: number;
  totalDescendantCount: number;
  worstStatus: SessionStatus | null;
  worstStatusSessionId: string | null;
}

export type HeavyCommandState = "waiting" | "reserved" | "running" | "stalled" | "terminating" | "reporting";

export interface HeavyCommandPackageDiagnostics {
  declared: string | null;
  resolvedPath: string | null;
  resolvedVersion: string | null;
  storePath: string | null;
  cachePaths: Record<string, { path: string; writable: boolean }>;
  warnings: string[];
}

export interface HeavyCommand {
  runId: string;
  workspaceId: string;
  state: HeavyCommandState;
  command: string[];
  commandDisplay: string;
  cwd: string;
  childPid: number | null;
  slot: number | null;
  queuedAt: string;
  startedAt: string | null;
  lastOutputAt: string | null;
  lastActivityAt?: string | null;
  activity?: {
    processCount: number;
    cpuTicks: number;
    ioBytes: number;
    runningContainers: number;
    createdContainers: number;
  };
  heartbeatAt: string;
  logPath: string | null;
  deadlines: {
    inactivityWarnMs: number;
    inactivityTimeoutMs: number;
    runtimeTimeoutMs: number;
    terminationGraceMs: number;
  };
  packageDiagnostics: HeavyCommandPackageDiagnostics | null;
  terminationReason: string | null;
  exitCode?: number | null;
  signal?: string | null;
  finishedAt?: string | null;
  resourceUnit?: string | null;
  resumeSentAt?: string | null;
  resumeDeadlineAt?: string | null;
  queuePosition?: number | null;
}

export interface HeavyCommandsResponse {
  commands: HeavyCommand[];
  sampledAt: string;
}

export interface HeavyCommandOutputResponse {
  runId: string;
  output: string;
  truncated: boolean;
}

export interface SessionForkOrigin {
  codexSessionId: string;
  sessionId: string | null;
  sessionName: string;
}

export interface ManagedSession {
  id: string;
  /** Stable display name independent of the process transport. */
  name: string;
  /** Stable working directory independent of the process transport. */
  cwd: string;
  provider: AgentProviderRef;
  runtime?: SessionRuntimeRef;
  capabilities?: SessionCapabilities;
  repo: RepoMetadata;
  codexSessionId: string | null;
  codexJsonlPath: string | null;
  discoveryConfidence: "high" | "medium" | "low";
  status: SessionStatus;
  initializing?: boolean;
  startupError?: string | null;
  authenticationError?: string | null;
  authenticationResumeRequired?: boolean;
  runtimeUnavailableReason?: string | null;
  lastActivityAt: string | null;
  preview: string;
  recentUserPrompts: string[];
  approvalMode: ApprovalMode;
  inputMode: CollaborationMode;
  models: SessionModelSelections;
  fastMode?: boolean | null;
  fastModeAvailable?: boolean | null;
  transcriptSize: number;
  transcriptSyncing?: boolean;
  unreadCount: number;
  pinned: boolean;
  archived: boolean;
  forkedFrom?: SessionForkOrigin | null;
  gitWorkspace?: GitWorkspaceSummary | null;
  resourceUsage?: SessionResourceUsage | null;
  /** Provider-neutral service/cgroup unit. `resourceScope` remains as a legacy alias. */
  resourceUnit?: string | null;
  resourceScope?: string | null;
  contextUsage?: SessionContextUsage | null;
  agentOwnership?: AgentSessionOwnership | null;
  agentSummary?: AgentSessionSummary | null;
  orchestrationAvailable?: boolean;
  documentScopeId?: string | null;
}

export interface SessionDocumentSummary {
  name: string;
  sizeBytes: number;
  updatedAt: string;
}

export interface SessionDocumentsResponse {
  documents: SessionDocumentSummary[];
  sampledAt: string;
}

export interface SessionDocumentResponse {
  document: SessionDocumentSummary & { content: string };
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  sequence: number;
  type: MessageType;
  role: "user" | "assistant" | "system" | "tool";
  timestamp: string;
  text: string;
  payload: Record<string, unknown> & { interactionOutcome?: TranscriptInteractionOutcome; content?: MessageContentPart[] };
}

export type MessageContentPart =
  | { type: "text"; text: string }
  | { type: "image"; id: string; mimeType: "image/png" | "image/jpeg" | "image/webp" };

export type ApprovalKind = "command" | "tool" | "patch" | "permissions";

export type ApprovalDecision =
  | "approve_once"
  | "approve_for_session"
  | "approve_always"
  | "approve_for_prefix"
  | "deny";

export interface ApprovalOption {
  decision: ApprovalDecision;
  label: string;
  description: string;
}

export interface ApprovalRequest {
  id: string;
  /** Exact JSON-RPC request identity for structured runtimes. */
  requestId?: string | number;
  sessionId: string;
  messageId: string;
  kind: ApprovalKind;
  title: string;
  command: string | null;
  toolName: string | null;
  cwd: string | null;
  reason: string | null;
  prefixRule: string[] | null;
  options: ApprovalOption[];
  createdAt: string;
  reviewStatus?: "reviewing" | "escalated";
  reviewerModel?: string;
  reviewerExplanation?: string;
}

export interface ResolveApprovalRequest {
  decision: ApprovalDecision;
  messageId?: string;
}

export interface ApprovalResponse {
  approval: ApprovalRequest | null;
}

export interface QuestionOption {
  label: string;
  description: string;
}

export interface QuestionPrompt {
  id: string;
  header: string;
  question: string;
  options: QuestionOption[];
}

export interface QuestionRequest {
  id: string;
  /** Exact JSON-RPC request identity for structured runtimes. */
  requestId?: string | number;
  sessionId: string;
  messageId: string;
  questions: QuestionPrompt[];
  autoResolutionMs: number | null;
  createdAt: string;
  expiresAt: string | null;
  countdownStartedAt: string | null;
  countdownExpiresAt: string | null;
}

export interface QuestionAnswer {
  answers: string[];
}

export interface QuestionAnswerRequest {
  answers: Record<string, QuestionAnswer>;
  messageId?: string;
}

export interface QuestionResponse {
  question: QuestionRequest | null;
}

export interface SessionSnapshotResponse {
  session: ManagedSession;
  messages: TranscriptPageResponse;
  approval: ApprovalRequest | null;
  question: QuestionRequest | null;
  queuedInputs: QueuedInput[];
  sampledAt: string;
}

export type QueuedInputStatus = "queued" | "sending" | "sent" | "failed";

export interface QueuedInput {
  id: string;
  sessionId: string;
  text: string;
  content?: MessageContentPart[];
  mode: CollaborationMode;
  status: QueuedInputStatus;
  error: string | null;
  codexSessionId: string | null;
  codexJsonlPath: string | null;
  actorSessionId: string | null;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
}

export interface QueuedInputResponse {
  queuedInputs: QueuedInput[];
}

export interface CreateQueuedInputRequest {
  text: string;
  content?: MessageContentPart[];
  mode?: CollaborationMode;
}

export interface UpdateQueuedInputRequest {
  text: string;
  content?: MessageContentPart[];
  mode?: CollaborationMode;
}

export type BtwExchangeStatus = "running" | "completed" | "failed" | "cancelled";

export type BtwDocumentOperationPhase = "waiting" | "retrying" | "notifying" | "applied" | "conflict";

export interface BtwDocumentOperation {
  phase: BtwDocumentOperationPhase;
  created: string[];
  updated: string[];
  retryCount: number;
}

export interface BtwExchange {
  id: string;
  sessionId: string;
  question: string;
  answer: string;
  status: BtwExchangeStatus;
  error: string | null;
  documentWarning?: string | null;
  createdAt: string;
  firstTokenAt: string | null;
  completedAt: string | null;
  documentOperation?: BtwDocumentOperation | null;
}

export interface CreateBtwExchangeRequest {
  text: string;
}

export interface BtwExchangeResponse {
  exchange: BtwExchange;
}

export interface BtwExchangesResponse {
  exchanges: BtwExchange[];
}

export interface BtwDeltaPayload {
  exchangeId: string;
  delta: string;
  firstTokenAt: string | null;
}

export interface SessionEvent {
  id: string;
  type:
    | "session.updated"
    | "message.appended"
    | "status.changed"
    | "notification.created"
    | "notification.triggered"
    | "queue.updated"
    | "btw.started"
    | "btw.delta"
    | "btw.updated"
    | "btw.finished"
    | "documents.updated"
    | "codex.auth.updated";
  sessionId: string;
  payload: unknown;
  timestamp: string;
}

export type NotificationRuleType = "done_task" | "approval_gate" | "status_change";
export type NotificationRuleScope = "global" | "session";
export type NotificationDeliveryChannel = "push" | "sound";

export interface NotificationDeliverySettings {
  pushEnabled: boolean;
  soundEnabled: boolean;
}

export interface NotificationSettings {
  globalRules: NotificationRuleType[];
  sessionRules: Record<string, NotificationRuleType[]>;
  delivery: NotificationDeliverySettings;
}

export interface UpdateNotificationRuleSettingRequest {
  deviceId: string;
  setting: "rule";
  scope: NotificationRuleScope;
  sessionId?: string;
  type: NotificationRuleType;
  enabled: boolean;
}

export interface UpdateNotificationDeliverySettingRequest {
  deviceId: string;
  setting: "delivery";
  channel: NotificationDeliveryChannel;
  enabled: boolean;
}

export type UpdateNotificationSettingRequest = UpdateNotificationRuleSettingRequest | UpdateNotificationDeliverySettingRequest;

export interface NotificationTriggeredPayload {
  deviceId: string;
  sessionId: string;
  sessionName: string;
  sourceSessionId?: string;
  sourceSessionName?: string;
  rules: NotificationRuleType[];
  previousStatus: SessionStatus;
  status: SessionStatus;
  severity: "red" | "yellow" | "green";
  title: string;
  body: string;
  url: string;
}

export interface PushSubscriptionKeys {
  p256dh: string;
  auth: string;
}

export interface PushSubscriptionInput {
  endpoint: string;
  expirationTime?: number | null;
  keys: PushSubscriptionKeys;
}

export interface PushKeyResponse {
  publicKey: string;
}

export type AccessMode = "local" | "token" | "unrestricted";
export type SessionHostMode = "local";

export interface AccessRequest {
  accessKey: string;
}

export interface AccessResponse {
  ok: boolean;
}

export interface MeResponse {
  accessGranted: boolean;
  accessKeyRequired: boolean;
  accessMode: AccessMode;
  sessionHostMode: SessionHostMode;
}

export interface ConnectivityResponse {
  bindHost: string;
  webProtocol: "http" | "https";
  backendPort: number;
  webPort: number;
  accessMode: AccessMode;
  accessKeyRequired: boolean;
  unrestrictedRemoteAccess: boolean;
  phoneAccessAvailable: boolean;
  primaryUrl: string | null;
  urls: string[];
  lanAddresses: string[];
  warnings: string[];
}

export interface UpdateRemoteAccessSettingsRequest {
  unrestrictedRemoteAccess: boolean;
}

export interface RemoteAccessResponse extends ConnectivityResponse {
  accessKey: string;
  primaryAccessUrl: string | null;
  accessUrls: string[];
  pwaTrust: PwaTrustInfo;
}

export interface PwaTrustInfo {
  available: boolean;
  port: number | null;
  primaryUrl: string | null;
  urls: string[];
  warnings: string[];
}

export interface SendInputRequest {
  text: string;
  content?: MessageContentPart[];
  mode?: CollaborationMode;
  delivery?: "auto" | "steer";
}

export type SendInputResponse =
  | { ok: true; session: ManagedSession; message: ChatMessage; queuedInput: null }
  | { ok: true; session: null; message: null; queuedInput: QueuedInput };

export type CreateSessionRequest =
  | {
      cwd: string;
      name: string;
      workspace: {
        mode: "git";
        targetBranch: string;
      };
    }
  | { cwd: string; name: string; workspace?: { mode: "directory" } };

export interface ForkSessionRequest {
  name: string;
}

export interface ForkSessionResponse {
  session: ManagedSession;
}

export interface GitRepositoryProbe {
  isGit: boolean;
  bare: boolean;
  incompatibleReason: string | null;
  repoRoot: string | null;
  repoName: string;
  currentBranch: string | null;
  dirty: boolean;
  localBranches: string[];
  remotes: string[];
}

export interface SessionHistoryPromptMatch {
  sequence: number;
  timestamp: string;
  text: string;
}

export interface SessionHistoryResult {
  sessionId: string;
  codexSessionId: string;
  codexJsonlPath: string | null;
  status: SessionStatus;
  archived: boolean;
  sessionName: string;
  repoName: string;
  repoBranch: string | null;
  cwd: string;
  lastActivityAt: string | null;
  transcriptSize: number;
  matchedPrompts: SessionHistoryPromptMatch[];
  gitWorkspace: Pick<GitWorkspaceSummary, "id" | "worktreePath" | "sessionBranch" | "targetBranch"> | null;
}

export function sessionHistoryIdentity(result: Pick<SessionHistoryResult, "sessionId" | "codexSessionId" | "gitWorkspace">): string {
  return result.gitWorkspace ? `workspace:${result.gitWorkspace.id}` : `codex:${result.codexSessionId || result.sessionId}`;
}

export interface SessionHistoryResponse {
  results: SessionHistoryResult[];
}

export interface RestoreSessionResponse {
  session: ManagedSession;
  restored: boolean;
}

export type RestoreSessionRequest = Record<string, never>;

export interface SessionRecoveryCandidate extends SessionHistoryResult {
  previousStatus: SessionStatus;
}

export interface SessionRecoveryIncident {
  id: string;
  detectedAt: string;
  sessions: SessionRecoveryCandidate[];
}

export interface SessionRecoveryResponse {
  incident: SessionRecoveryIncident | null;
}

export interface RestoreSessionRecoveryRequest {
  incidentId: string;
  sessionIds: string[];
}

export interface RestoreSessionRecoveryResult {
  sourceSessionId: string;
  status: "restored" | "reused_live" | "failed";
  session: ManagedSession | null;
  error: string | null;
}

export interface RestoreSessionRecoveryResponse {
  results: RestoreSessionRecoveryResult[];
  incident: SessionRecoveryIncident | null;
}

export interface SessionTransferExportRequest {
  sessionIds: string[];
}

export interface SessionTransferPreviewSession {
  codexSessionId: string;
  sessionName: string;
  sourceCwd: string;
  repoName: string;
  workspaceMode: "directory" | "git";
  targetBranch: string | null;
  transcriptBytes: number;
  lastActivityAt: string | null;
  documentCount: number;
}

export interface SessionTransferPreviewBranch {
  branchName: string;
  tipSha: string;
  objectFormat: "sha1" | "sha256";
  bundleMode: "upstream_delta" | "full" | "none";
  upstreamRemote: string | null;
  upstreamMergeRef: string | null;
  upstreamBaseSha: string | null;
}

export interface SessionTransferMappingRequirement {
  sourceCwd: string;
  repoName: string;
  workspaceMode: "directory" | "git";
  targetBranch: string | null;
  branches: SessionTransferPreviewBranch[];
}

export interface SessionTransferInspectResponse {
  token: string;
  encrypted: boolean;
  expiresAt: string;
  formatVersion: 2 | 3 | 4 | 5 | 6;
  sessions: SessionTransferPreviewSession[];
  mappings: SessionTransferMappingRequirement[];
}

export interface SessionTransferImportMapping {
  sourceCwd: string;
  destinationCwd: string;
  targetBranch?: string;
}

export interface SessionTransferImportRequest {
  token: string;
  mappings: SessionTransferImportMapping[];
}

export interface SessionTransferImportResult {
  codexSessionId: string;
  sessionName: string;
  status: "resumed" | "reused_live" | "kept_existing" | "resume_failed";
  sessionId: string | null;
  error: string | null;
}

export interface SessionTransferImportBranchResult {
  sourceCwd: string;
  destinationCwd: string;
  branchName: string;
  status: "created" | "fast_forwarded" | "reused" | "kept_newer";
  upstreamStatus: "restored" | "kept_existing" | "unavailable" | "none";
  warning: string | null;
}

export interface SessionTransferImportResponse {
  results: SessionTransferImportResult[];
  branches: SessionTransferImportBranchResult[];
}

export interface SessionDirectorySuggestion {
  path: string;
  label: string;
  repoRoot: string | null;
  branch: string | null;
  source: "active" | "recent";
  lastActivityAt: string | null;
}

export interface SessionDirectoriesResponse {
  directories: SessionDirectorySuggestion[];
}

export type PlanActionChoice = "implement" | "clear_context_implement" | "stay_in_plan";

export interface TranscriptInteractionOutcome {
  kind: "plan" | "approval" | "question";
  status: "answered" | "failed" | "closed";
  submittedAt: string;
  decision?: PlanActionChoice | ApprovalDecision;
  answers?: Record<string, QuestionAnswer>;
  error?: string;
  resolvedBy?: "user" | "auto" | "full";
  reviewerModel?: string;
  reviewerExplanation?: string;
}

export type SessionAction =
  | { type: "interrupt" }
  | { type: "archiveTranscript" }
  | { type: "setInputMode"; mode: CollaborationMode }
  | { type: "setModelSettings"; mode: CollaborationMode; model: string; reasoningEffort: string | null }
  | { type: "setApprovalMode"; mode: ApprovalMode }
  | { type: "setFastMode"; enabled: boolean }
  | { type: "setAgentParent"; parentSessionId: string | null }
  | { type: "choosePlanAction"; action: PlanActionChoice; messageId: string }
  | { type: "extendAgentBudget"; additionalTokens: number; reason: string }
  | { type: "retryInputDelivery" }
  | { type: "dismissInputDeliveryFailure" }
  | { type: "resumeAfterAuthentication" }
  | { type: "rename"; name: string }
  | { type: "pin" }
  | { type: "unpin" }
  | { type: "detach" }
  | { type: "hibernate" }
  | { type: "wake" }
  | { type: "kill" };

export interface SessionActionResponse {
  ok: true;
  session: ManagedSession | null;
}

export interface SessionListResponse {
  sessions: ManagedSession[];
}

/** Dashboard-safe Git shape. Dependency-link details remain available from full session APIs. */
export type DashboardGitWorkspaceSummary = Omit<GitWorkspaceSummary, "dependencyLinks"> & {
  dependencyLinks: [];
};

/**
 * A structurally compatible session record with bounded preview content and a slim Git workspace.
 * Full transcript, document, and workspace state remains available from the session APIs.
 */
export type DashboardSessionSummary = Omit<ManagedSession, "gitWorkspace" | "runtime" | "resourceUnit"> & {
  gitWorkspace?: DashboardGitWorkspaceSummary | null;
};

export interface SessionSummaryListResponse {
  sessions: DashboardSessionSummary[];
}

export interface PromptHistoryResult {
  id: string;
  sessionId: string;
  sequence: number;
  timestamp: string;
  text: string;
  sessionName: string;
  repoName: string;
  repoBranch: string | null;
  cwd: string;
}

export interface PromptHistoryResponse {
  results: PromptHistoryResult[];
}

export interface MessageListResponse {
  messages: ChatMessage[];
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
}

export type TranscriptRangeKind = "activity" | "stack";

export interface TranscriptMessageItem {
  type: "message";
  id: string;
  message: ChatMessage;
  firstSequence: number;
  lastSequence: number;
}

export interface TranscriptUserActionItem {
  type: "user_action";
  id: string;
  message: ChatMessage;
  firstSequence: number;
  lastSequence: number;
}

export interface TranscriptRangeItem {
  type: "range";
  id: string;
  rangeKind: TranscriptRangeKind;
  label: string;
  firstSequence: number;
  lastSequence: number;
  messageCount: number;
}

export type TranscriptItem = TranscriptMessageItem | TranscriptUserActionItem | TranscriptRangeItem;

export interface TranscriptPageResponse {
  sessionId: string;
  codexSessionId: string | null;
  codexJsonlPath: string | null;
  items: TranscriptItem[];
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
}

export interface TranscriptSearchMatch {
  sequence: number;
  messageId: string;
  itemId: string;
  firstSequence: number;
  lastSequence: number;
  role: ChatMessage["role"];
  type: MessageType;
  timestamp: string;
  preview: string;
}

export interface TranscriptSearchResponse {
  sessionId: string;
  codexSessionId: string | null;
  codexJsonlPath: string | null;
  query: string;
  matches: TranscriptSearchMatch[];
  total: number;
}

export type CodexAccountKind = "chatgpt" | "apiKey" | "amazonBedrock" | "unknown";

export interface CodexUsageAccount {
  kind: CodexAccountKind;
  email: string | null;
  planType: string | null;
}

export interface CodexUsageLimit {
  label: string;
  limitName: string | null;
  usedPercent: number | null;
  remainingPercent: number | null;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface CodexRateLimitResetCredit {
  id: string;
  resetType: string;
  status: string;
  grantedAt: number;
  expiresAt: number | null;
  title: string | null;
  description: string | null;
}

export interface CodexRateLimitResetCredits {
  availableCount: number;
  credits: CodexRateLimitResetCredit[] | null;
}

export interface CodexUsageSummaryResponse {
  available: boolean;
  error: string | null;
  refreshedAt: string;
  account: CodexUsageAccount | null;
  limits: {
    fiveHour: CodexUsageLimit | null;
    weekly: CodexUsageLimit | null;
  };
  resetCredits: CodexRateLimitResetCredits | null;
}

export type CodexAuthLifecycleStatus =
  | "checking"
  | "ready"
  | "signed_out"
  | "authentication_required"
  | "temporarily_unavailable";

export interface CodexAuthAccount {
  type: string;
  email: string | null;
  planType: string | null;
}

export interface CodexAuthState {
  status: CodexAuthLifecycleStatus;
  account: CodexAuthAccount | null;
  revision: number;
  observedAt: string;
  error: string | null;
  admissionHeld: boolean;
  pendingSessionIds: string[];
}

export interface CodexTokenUsageDailyPoint {
  date: string;
  tokens: number;
}

export interface CodexTokenUsageResponse {
  available: boolean;
  error: string | null;
  refreshedAt: string;
  days: 7 | 30;
  summary: {
    lifetimeTokens: number | null;
    peakDailyTokens: number | null;
    longestRunningTurnSec: number | null;
    currentStreakDays: number | null;
    longestStreakDays: number | null;
  } | null;
  points: CodexTokenUsageDailyPoint[] | null;
}

export interface ConsumeCodexResetCreditRequest {
  idempotencyKey: string;
  creditId?: string | null;
}

export type ConsumeCodexResetCreditOutcome = "reset" | "alreadyRedeemed" | "nothingToReset" | "noCredit";

export interface ConsumeCodexResetCreditResponse {
  outcome: ConsumeCodexResetCreditOutcome;
  summary: CodexUsageSummaryResponse;
}
