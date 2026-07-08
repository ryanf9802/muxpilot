export type SessionStatus =
  | "idle"
  | "generating"
  | "executing"
  | "working"
  | "planning"
  | "waiting"
  | "approval"
  | "question"
  | "plan_ready"
  | "blocked"
  | "missing"
  | "unknown";

export type CollaborationMode = "default" | "plan";

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

export interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
  supportedReasoningEfforts: CodexReasoningEffortOption[];
  defaultReasoningEffort: string | null;
}

export interface CodexReasoningEffortOption {
  reasoningEffort: string;
  description: string;
}

export interface CodexModelsResponse {
  models: CodexModel[];
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

export interface TmuxPane {
  sessionId: string;
  sessionName: string;
  windowId: string;
  windowIndex: number;
  windowName: string;
  paneId: string;
  paneIndex: number;
  paneActive: boolean;
  cwd: string;
  currentCommand: string;
  title: string;
  pid: number;
  size: string;
}

export interface RepoMetadata {
  root: string | null;
  name: string;
  branch: string | null;
  dirty: boolean;
  worktree: string | null;
}

export interface ManagedSession {
  id: string;
  tmux: TmuxPane;
  repo: RepoMetadata;
  codexSessionId: string | null;
  codexJsonlPath: string | null;
  discoveryConfidence: "high" | "medium" | "low";
  status: SessionStatus;
  lastActivityAt: string | null;
  preview: string;
  recentUserPrompts: string[];
  activitySummary: string | null;
  activitySummaryGeneratedAt: string | null;
  activitySummarySourceSequence: number | null;
  inputMode: CollaborationMode;
  models: SessionModelSelections;
  transcriptSize: number;
  unreadCount: number;
  archived: boolean;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  sequence: number;
  type: MessageType;
  role: "user" | "assistant" | "system" | "tool";
  timestamp: string;
  text: string;
  payload: Record<string, unknown>;
}

export type ApprovalKind = "command" | "tool" | "patch" | "permissions";

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  messageId: string;
  kind: ApprovalKind;
  title: string;
  command: string | null;
  toolName: string | null;
  cwd: string | null;
  reason: string | null;
  prefixRule: string[] | null;
  createdAt: string;
}

export type ApprovalDecision = "approve_once" | "approve_for_prefix" | "deny";

export interface ResolveApprovalRequest {
  decision: ApprovalDecision;
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
}

export interface QuestionResponse {
  question: QuestionRequest | null;
}

export type QueuedInputStatus = "queued" | "sending" | "sent" | "failed";

export interface QueuedInput {
  id: string;
  sessionId: string;
  text: string;
  mode: CollaborationMode;
  status: QueuedInputStatus;
  error: string | null;
  codexSessionId: string | null;
  codexJsonlPath: string | null;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
}

export interface QueuedInputResponse {
  queuedInputs: QueuedInput[];
}

export interface CreateQueuedInputRequest {
  text: string;
  mode?: CollaborationMode;
}

export interface UpdateQueuedInputRequest {
  text: string;
  mode?: CollaborationMode;
}

export interface SessionEvent {
  id: string;
  type: "session.updated" | "message.appended" | "status.changed" | "notification.created" | "queue.updated";
  sessionId: string;
  payload: unknown;
  timestamp: string;
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
  mode?: CollaborationMode;
}

export interface CreateSessionRequest {
  sourceSessionId: string;
  name: string;
}

export type PlanActionChoice = "implement" | "clear_context_implement" | "stay_in_plan";

export type SessionAction =
  | { type: "interrupt" }
  | { type: "archiveTranscript" }
  | { type: "setInputMode"; mode: CollaborationMode }
  | { type: "setModelSettings"; mode: CollaborationMode; model: string; reasoningEffort?: string | null }
  | { type: "choosePlanAction"; action: PlanActionChoice }
  | { type: "rename"; name: string }
  | { type: "detach" }
  | { type: "kill" };

export interface SessionActionResponse {
  ok: true;
  session: ManagedSession | null;
}

export interface SessionListResponse {
  sessions: ManagedSession[];
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
  items: TranscriptItem[];
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
}

export interface OpenAIUsageDailyPoint {
  date: string;
  requestCount: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number | null;
}

export interface OpenAIUsageSummaryResponse {
  configured: boolean;
  activitySummariesEnabled: boolean;
  days: number;
  points: OpenAIUsageDailyPoint[];
  totals: Omit<OpenAIUsageDailyPoint, "date">;
  unpricedModels: string[];
}

export interface ActivitySummarySettingsResponse {
  enabled: boolean;
}

export interface UpdateActivitySummarySettingsRequest {
  enabled: boolean;
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

export interface CodexUsageSummaryResponse {
  available: boolean;
  error: string | null;
  refreshedAt: string;
  account: CodexUsageAccount | null;
  limits: {
    fiveHour: CodexUsageLimit | null;
    weekly: CodexUsageLimit | null;
  };
}
