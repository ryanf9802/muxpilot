import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import type {
  AgentSessionOwnership,
  ApprovalMode,
  ApprovalReviewerSettings,
  BtwExchange,
  ChatMessage,
  CollaborationMode,
  GitWorkspaceSummary,
  NotificationDeliveryChannel,
  NotificationDeliverySettings,
  ManagedSession,
  NotificationRuleScope,
  NotificationRuleType,
  NotificationSettings,
  PromptHistoryResult,
  PushSubscriptionInput,
  QueuedInput,
  SessionHistoryResult,
  SessionRecoveryIncident,
  SessionModelSettings,
  SessionModelSelections,
  SessionDirectorySuggestion,
  SessionStatus,
  SessionContextUsage,
  TranscriptItem,
  TranscriptPageResponse,
  TranscriptSearchResponse
} from "@muxpilot/core";
import {
  buildExpandedTranscriptItems,
  buildTranscriptItems,
  hasCompleteProposedPlan,
  isDisplayableUserPromptText,
  normalizeGitWorkspaceSummary,
  normalizeSessionWaitEvent,
  normalizeSubagentNotificationText,
  normalizeUserContextText,
  sessionHistoryIdentity,
  sessionWaitEventFromPayload,
  sessionWaitEventSummary,
  withSessionWaitEventPayload
} from "@muxpilot/core";

const UNRESTRICTED_REMOTE_ACCESS_SETTING = "unrestricted_remote_access_enabled";
const PUSH_VAPID_KEYS_SETTING = "push_vapid_keys";
const PROMPT_INDEX_BACKFILLED_SETTING = "prompt_index_backfilled_v1";
const SESSION_RECOVERY_RUNTIME_SETTING = "session_recovery_runtime_v1";
const SESSION_RECOVERY_INCIDENT_SETTING = "session_recovery_incident_v1";
const GLOBAL_MODEL_SETTINGS = "global_model_settings_v1";
const APPROVAL_REVIEWER_SETTINGS = "approval_reviewer_settings_v1";
const TRANSCRIPT_SCAN_CHUNK_SIZE = 256;

export interface SessionRecoveryRuntimeState {
  runId: string;
  cleanShutdown: boolean;
  updatedAt: string;
  sessionIds: string[];
}

export interface PersistedAgentWait {
  actorSessionId: string;
  sessionIds: string[];
  mode: "any" | "all";
  expiresAt: number;
  readyAt: number | null;
}

export interface ApprovalContextState {
  messages: ChatMessage[];
  hasContext: boolean;
}

interface SessionRow {
  id: string;
  data_json: string;
  status: SessionStatus;
  last_activity_at: string | null;
  preview: string;
  unread_count: number;
  archived: number;
  updated_at: string;
}

interface MessageRow {
  id: string;
  session_id: string;
  sequence: number;
  type: string;
  role: string;
  timestamp: string;
  text: string;
  payload_json: string;
}

interface PromptHistoryRow extends MessageRow {
  session_data_json: string;
}

interface PromptIndexRow {
  message_id: string;
  session_id: string;
  sequence: number;
  timestamp: string;
  text: string;
  session_data_json: string;
}

interface SessionHistoryMatchRow {
  session_rowid: number;
  session_id: string;
  session_data_json: string;
  git_workspace_data_json: string | null;
  status: SessionStatus;
  last_activity_at: string | null;
  archived: number;
  match_sequence: number;
  match_timestamp: string;
  match_text: string;
  rank: number;
}

interface SessionHistoryNameRow {
  session_id: string;
  session_data_json: string;
  git_workspace_data_json: string | null;
  status: SessionStatus;
  last_activity_at: string | null;
  archived: number;
}

export interface MessagePage {
  messages: ChatMessage[];
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
}

interface QueuedInputRow {
  id: string;
  session_id: string;
  text: string;
  content_json: string | null;
  mode: string;
  status: string;
  error: string | null;
  codex_session_id: string | null;
  codex_jsonl_path: string | null;
  actor_session_id: string | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
}

export type AppServerRequestState = "pending" | "responded" | "resolved";

export interface PersistedAppServerRequest {
  sessionId: string;
  requestId: string | number;
  method: string;
  params: unknown;
  threadId: string;
  turnId: string;
  state: AppServerRequestState;
  response: unknown | null;
  receivedAt: string;
  lastSeenAt: string;
  respondedAt: string | null;
  resolvedAt: string | null;
}

export type ReceivedAppServerRequest = Pick<
  PersistedAppServerRequest,
  "sessionId" | "requestId" | "method" | "params" | "threadId" | "turnId" | "receivedAt" | "lastSeenAt"
>;

interface AppServerRequestRow {
  session_id: string;
  request_id_json: string;
  method: string;
  params_json: string;
  thread_id: string;
  turn_id: string;
  state: AppServerRequestState;
  response_json: string | null;
  received_at: string;
  last_seen_at: string;
  responded_at: string | null;
  resolved_at: string | null;
}

export interface AppServerProjectionInput {
  sessionId: string;
  threadId: string;
  turnId: string | null;
  itemId: string | null;
  clientMessageId: string | null;
  method: string;
  status: SessionStatus | null;
  message: Omit<ChatMessage, "sessionId" | "sequence"> | null;
  evidence: unknown;
  observedAt: string;
}

export interface AppServerReconciliationState {
  sessionId: string;
  threadId: string;
  turnId: string | null;
  itemId: string | null;
  clientMessageId: string | null;
  method: string;
  status: SessionStatus | null;
  evidence: unknown;
  observedAt: string;
}

export interface AppServerProjectionResult {
  message: ChatMessage | null;
  messageInserted: boolean;
  messageChanged: boolean;
  statusChanged: boolean;
  state: AppServerReconciliationState;
}

export interface AppServerProjectionRepairResult {
  messagesRemoved: number;
  processesRemoved: number;
  reconciliationReset: boolean;
}

export interface AppServerCommandProcess {
  sessionId: string;
  threadId: string;
  turnId: string;
  itemId: string;
  processId: string;
  observedAt: string;
}

interface AppServerCommandProcessRow {
  session_id: string;
  thread_id: string;
  turn_id: string;
  item_id: string;
  process_id: string;
  observed_at: string;
}

interface AppServerReconciliationRow {
  session_id: string;
  thread_id: string;
  turn_id: string | null;
  item_id: string | null;
  client_message_id: string | null;
  method: string;
  status: SessionStatus | null;
  evidence_json: string;
  observed_at: string;
}

interface CodexItemMessageRow {
  session_id: string;
  thread_id: string;
  turn_id: string;
  item_id: string;
  message_id: string;
  app_server_message_id: string | null;
  rollout_message_id: string | null;
  app_server_observed_at: string | null;
  rollout_observed_at: string | null;
}

interface ImageSubmissionCleanupRow extends MessageRow {
  mapped_thread_id: string | null;
  mapped_turn_id: string | null;
  mapped_item_id: string | null;
  mapped_message_id: string | null;
  app_server_message_id: string | null;
  rollout_message_id: string | null;
  app_server_observed_at: string | null;
  rollout_observed_at: string | null;
}

interface CodexItemMessageIdentity {
  threadId: string;
  turnId: string;
  itemId: string;
}

interface MessageWriteResult {
  message: ChatMessage | null;
  inserted: boolean;
  changed: boolean;
}

const APP_SERVER_SESSION_STATUSES = new Set<SessionStatus>([
  "idle", "generating", "executing", "working", "running", "planning", "queued", "waiting",
  "approval", "question", "plan_ready", "blocked", "input_failed", "startup_failed", "missing", "unknown"
]);

interface BtwExchangeRow {
  id: string;
  session_id: string;
  question: string;
  answer: string;
  status: string;
  error: string | null;
  created_at: string;
  first_token_at: string | null;
  completed_at: string | null;
  document_operation_json: string | null;
}

interface QueuedInputEchoCandidateRow {
  text: string;
  timestamp: string;
}

interface NotificationRuleRow {
  device_id?: string;
  scope: NotificationRuleScope;
  session_id: string;
  type: NotificationRuleType;
}

interface PushSubscriptionRow {
  device_id?: string;
  endpoint: string;
  subscription_json: string;
}

interface NotificationDeviceSettingsRow {
  device_id: string;
  push_enabled: number;
  sound_enabled: number;
}

interface SessionRepositoryRow {
  path: string;
  label: string;
  repo_root: string | null;
  branch: string | null;
  last_activity_at: string | null;
  updated_at: string;
}

interface GitWorkspaceRow {
  id: string;
  session_id: string | null;
  data_json: string;
  updated_at: string;
}

export interface StoredGitWorkspace {
  id: string;
  sessionId: string | null;
  sessionName?: string;
  commonGitDir: string;
  targetRef?: string;
  controlPath?: string;
  implementationRoot?: string;
  recoveryRef?: string | null;
  helperToken: string;
  summary: GitWorkspaceSummary;
  createdAt: string;
  updatedAt: string;
}

export type TouchedSessionRepository = Omit<SessionDirectorySuggestion, "source">;

export interface PushVapidKeys {
  publicKey: string;
  privateKey: string;
}

export interface StoredPushSubscription extends PushSubscriptionInput {
  deviceId: string;
}

type DbMethod = keyof SyncAppDatabase;

interface DbWorkerResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export class AppDatabase {
  private readonly worker: Worker | null;
  private readonly inline: SyncAppDatabase | null;
  private nextRequestId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  constructor(path: string) {
    if (process.env.VITEST) {
      this.inline = new SyncAppDatabase(path);
      this.worker = null;
      return;
    }

    this.inline = null;
    this.worker = new Worker(new URL("./databaseWorker.js", import.meta.url), { workerData: { path } });
    this.worker.on("message", (message: DbWorkerResponse) => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error ?? "Database worker failed"));
    });
    this.worker.on("error", (error) => {
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
  }

  async close(): Promise<void> {
    if (this.inline) {
      this.inline.close();
      return;
    }
    if (!this.worker) return;
    await this.call("close");
    await this.worker.terminate();
  }

  upsertSession(session: ManagedSession, updatedAt: string, rejectIfNewer = false): Promise<void> {
    return this.call("upsertSession", session, updatedAt, rejectIfNewer) as Promise<void>;
  }

  rekeySession(
    oldSessionId: string,
    session: ManagedSession,
    parserOffsetMove: { from: string; to: string } | null,
    updatedAt: string
  ): Promise<ManagedSession | null> {
    return this.call("rekeySession", oldSessionId, session, parserOffsetMove, updatedAt) as Promise<ManagedSession | null>;
  }

  setSessionStatus(sessionId: string, status: SessionStatus, updatedAt: string): Promise<void> {
    return this.call("setSessionStatus", sessionId, status, updatedAt) as Promise<void>;
  }

  markSessionArchived(sessionId: string, archived: boolean, updatedAt: string): Promise<void> {
    return this.call("markSessionArchived", sessionId, archived, updatedAt) as Promise<void>;
  }

  setSessionPinned(sessionId: string, pinned: boolean, updatedAt: string): Promise<ManagedSession | null> {
    return this.call("setSessionPinned", sessionId, pinned, updatedAt) as Promise<ManagedSession | null>;
  }

  setSessionInitializing(sessionId: string, initializing: boolean, updatedAt: string): Promise<ManagedSession | null> {
    return this.call("setSessionInitializing", sessionId, initializing, updatedAt) as Promise<ManagedSession | null>;
  }

  setSessionInitializationResult(
    sessionId: string,
    status: SessionStatus,
    startupError: string | null,
    updatedAt: string
  ): Promise<ManagedSession | null> {
    return this.call("setSessionInitializationResult", sessionId, status, startupError, updatedAt) as Promise<ManagedSession | null>;
  }

  setSessionInputMode(sessionId: string, inputMode: CollaborationMode, updatedAt: string): Promise<ManagedSession | null> {
    return this.call("setSessionInputMode", sessionId, inputMode, updatedAt) as Promise<ManagedSession | null>;
  }

  setSessionFastMode(sessionId: string, fastMode: boolean, updatedAt: string): Promise<ManagedSession | null> {
    return this.call("setSessionFastMode", sessionId, fastMode, updatedAt) as Promise<ManagedSession | null>;
  }

  setSessionApprovalMode(sessionId: string, mode: ApprovalMode, updatedAt: string): Promise<ManagedSession | null> {
    return this.call("setSessionApprovalMode", sessionId, mode, updatedAt) as Promise<ManagedSession | null>;
  }

  setSessionModelSettings(
    sessionId: string,
    mode: CollaborationMode,
    model: string,
    reasoningEffort: string | null,
    updatedAt: string,
    fastModeAvailable?: boolean | null,
    fastMode?: boolean | null
  ): Promise<ManagedSession | null> {
    return this.call("setSessionModelSettings", sessionId, mode, model, reasoningEffort, updatedAt, fastModeAvailable, fastMode) as Promise<ManagedSession | null>;
  }

  setSessionContextUsage(sessionId: string, contextUsage: SessionContextUsage, updatedAt: string): Promise<ManagedSession | null> {
    return this.call("setSessionContextUsage", sessionId, contextUsage, updatedAt) as Promise<ManagedSession | null>;
  }

  setSessionAgentOwnership(sessionId: string, ownership: AgentSessionOwnership | null, updatedAt: string): Promise<ManagedSession | null> {
    return this.call("setSessionAgentOwnership", sessionId, ownership, updatedAt) as Promise<ManagedSession | null>;
  }

  completeAgentSession(sessionId: string, completedAt: string): Promise<ManagedSession | null> {
    return this.call("completeAgentSession", sessionId, completedAt) as Promise<ManagedSession | null>;
  }

  setSessionOrchestrationAvailable(sessionId: string, available: boolean, updatedAt: string): Promise<ManagedSession | null> {
    return this.call("setSessionOrchestrationAvailable", sessionId, available, updatedAt) as Promise<ManagedSession | null>;
  }

  setSessionResourceScope(sessionId: string, resourceScope: string | null, updatedAt: string): Promise<ManagedSession | null> {
    return this.call("setSessionResourceScope", sessionId, resourceScope, updatedAt) as Promise<ManagedSession | null>;
  }

  setSessionDocumentScope(sessionId: string, documentScopeId: string, updatedAt: string): Promise<ManagedSession | null> {
    return this.call("setSessionDocumentScope", sessionId, documentScopeId, updatedAt) as Promise<ManagedSession | null>;
  }

  setSessionGitWorkspace(sessionId: string, workspace: GitWorkspaceSummary, updatedAt: string): Promise<ManagedSession | null> {
    return this.call("setSessionGitWorkspace", sessionId, workspace, updatedAt) as Promise<ManagedSession | null>;
  }

  listAgentWaits(): Promise<PersistedAgentWait[]> {
    return this.call("listAgentWaits") as Promise<PersistedAgentWait[]>;
  }

  upsertAgentWait(wait: PersistedAgentWait, updatedAt: string): Promise<void> {
    return this.call("upsertAgentWait", wait, updatedAt) as Promise<void>;
  }

  deleteAgentWait(actorSessionId: string): Promise<void> {
    return this.call("deleteAgentWait", actorSessionId) as Promise<void>;
  }

  putBtwExchange(exchange: BtwExchange): Promise<void> {
    return this.call("putBtwExchange", exchange) as Promise<void>;
  }

  getBtwExchange(sessionId: string, exchangeId: string): Promise<BtwExchange | null> {
    return this.call("getBtwExchange", sessionId, exchangeId) as Promise<BtwExchange | null>;
  }

  listBtwExchanges(sessionId: string, limit = 50): Promise<BtwExchange[]> {
    return this.call("listBtwExchanges", sessionId, limit) as Promise<BtwExchange[]>;
  }

  activeBtwExchange(sessionId: string): Promise<BtwExchange | null> {
    return this.call("activeBtwExchange", sessionId) as Promise<BtwExchange | null>;
  }

  listRunningBtwExchanges(): Promise<BtwExchange[]> {
    return this.call("listRunningBtwExchanges") as Promise<BtwExchange[]>;
  }

  failBtwExchange(sessionId: string, exchangeId: string, error: string, completedAt: string): Promise<BtwExchange | null> {
    return this.call("failBtwExchange", sessionId, exchangeId, error, completedAt) as Promise<BtwExchange | null>;
  }

  failRunningBtwExchanges(error: string, completedAt: string): Promise<BtwExchange[]> {
    return this.call("failRunningBtwExchanges", error, completedAt) as Promise<BtwExchange[]>;
  }

  listSessions(includeArchived = false, includeMissing = true): Promise<ManagedSession[]> {
    return this.call("listSessions", includeArchived, includeMissing) as Promise<ManagedSession[]>;
  }

  getSession(sessionId: string): Promise<ManagedSession | null> {
    return this.call("getSession", sessionId) as Promise<ManagedSession | null>;
  }

  upsertGitWorkspace(workspace: StoredGitWorkspace, updatedAt: string): Promise<void> {
    return this.call("upsertGitWorkspace", workspace, updatedAt) as Promise<void>;
  }

  bindGitWorkspace(workspaceId: string, sessionId: string, updatedAt: string): Promise<void> {
    return this.call("bindGitWorkspace", workspaceId, sessionId, updatedAt) as Promise<void>;
  }

  getGitWorkspace(workspaceId: string): Promise<StoredGitWorkspace | null> {
    return this.call("getGitWorkspace", workspaceId) as Promise<StoredGitWorkspace | null>;
  }

  getGitWorkspaceBySession(sessionId: string): Promise<StoredGitWorkspace | null> {
    return this.call("getGitWorkspaceBySession", sessionId) as Promise<StoredGitWorkspace | null>;
  }

  listGitWorkspaces(): Promise<StoredGitWorkspace[]> {
    return this.call("listGitWorkspaces") as Promise<StoredGitWorkspace[]>;
  }

  addRepositoryApprovalRule(commonGitDir: string, prefixRule: string[], createdAt: string): Promise<void> {
    return this.call("addRepositoryApprovalRule", commonGitDir, prefixRule, createdAt) as Promise<void>;
  }

  hasRepositoryApprovalRule(commonGitDir: string, prefixRule: string[]): Promise<boolean> {
    return this.call("hasRepositoryApprovalRule", commonGitDir, prefixRule) as Promise<boolean>;
  }

  upsertTouchedRepository(repository: TouchedSessionRepository, updatedAt: string): Promise<void> {
    return this.call("upsertTouchedRepository", repository, updatedAt) as Promise<void>;
  }

  dismissSessionDirectory(path: string, dismissedAt: string): Promise<void> {
    return this.call("dismissSessionDirectory", path, dismissedAt) as Promise<void>;
  }

  listDismissedSessionDirectories(): Promise<string[]> {
    return this.call("listDismissedSessionDirectories") as Promise<string[]>;
  }

  listTouchedRepositories(limit = 100): Promise<SessionDirectorySuggestion[]> {
    return this.call("listTouchedRepositories", limit) as Promise<SessionDirectorySuggestion[]>;
  }

  appendMessage(message: ChatMessage): Promise<boolean> {
    return this.call("appendMessage", message) as Promise<boolean>;
  }

  appendMessageWithNextSequence(message: Omit<ChatMessage, "sequence">): Promise<ChatMessage | null> {
    return this.call("appendMessageWithNextSequence", message) as Promise<ChatMessage | null>;
  }

  latestUserMessage(sessionId: string): Promise<ChatMessage | null> {
    return this.call("latestUserMessage", sessionId) as Promise<ChatMessage | null>;
  }

  queuedSubmissionMessage(sessionId: string, queuedInputId: string): Promise<ChatMessage | null> {
    return this.call("queuedSubmissionMessage", sessionId, queuedInputId) as Promise<ChatMessage | null>;
  }

  activeApprovalContext(sessionId: string): Promise<ApprovalContextState> {
    return this.call("activeApprovalContext", sessionId) as Promise<ApprovalContextState>;
  }

  latestTurnLifecycleMessage(sessionId: string): Promise<ChatMessage | null> {
    return this.call("latestTurnLifecycleMessage", sessionId) as Promise<ChatMessage | null>;
  }

  latestAssistantMessage(sessionId: string): Promise<ChatMessage | null> {
    return this.call("latestAssistantMessage", sessionId) as Promise<ChatMessage | null>;
  }

  latestPlanReadyMessage(sessionId: string): Promise<ChatMessage | null> {
    return this.call("latestPlanReadyMessage", sessionId) as Promise<ChatMessage | null>;
  }

  updateMessageText(message: ChatMessage, text: string): Promise<ChatMessage | null> {
    return this.call("updateMessageText", message, text) as Promise<ChatMessage | null>;
  }

  updateMessagePayload(message: ChatMessage, payload: Record<string, unknown>): Promise<ChatMessage | null> {
    return this.call("updateMessagePayload", message, payload) as Promise<ChatMessage | null>;
  }

  updateMuxpilotSubmission(message: ChatMessage, changes: Record<string, unknown>): Promise<ChatMessage | null> {
    return this.call("updateMuxpilotSubmission", message, changes) as Promise<ChatMessage | null>;
  }

  listMessages(sessionId: string, afterSequence = 0): Promise<ChatMessage[]> {
    return this.call("listMessages", sessionId, afterSequence) as Promise<ChatMessage[]>;
  }

  getMessage(sessionId: string, messageId: string): Promise<ChatMessage | null> {
    return this.call("getMessage", sessionId, messageId) as Promise<ChatMessage | null>;
  }

  listPromptHistory(query: string, limit: number): Promise<PromptHistoryResult[]> {
    return this.call("listPromptHistory", query, limit) as Promise<PromptHistoryResult[]>;
  }

  listSessionHistory(query: string, limit: number): Promise<SessionHistoryResult[]> {
    return this.call("listSessionHistory", query, limit) as Promise<SessionHistoryResult[]>;
  }

  listRecentMessages(sessionId: string, limit: number): Promise<TranscriptPageResponse> {
    return this.call("listRecentMessages", sessionId, limit) as Promise<TranscriptPageResponse>;
  }

  listActiveTailMessages(sessionId: string, fallbackLimit: number): Promise<TranscriptPageResponse> {
    return this.call("listActiveTailMessages", sessionId, fallbackLimit) as Promise<TranscriptPageResponse>;
  }

  listEarliestMessages(sessionId: string, limit: number): Promise<TranscriptPageResponse> {
    return this.call("listEarliestMessages", sessionId, limit) as Promise<TranscriptPageResponse>;
  }

  listMessagesBefore(sessionId: string, beforeSequence: number, limit: number): Promise<TranscriptPageResponse> {
    return this.call("listMessagesBefore", sessionId, beforeSequence, limit) as Promise<TranscriptPageResponse>;
  }

  listMessagesAfterPage(sessionId: string, afterSequence: number, limit: number): Promise<TranscriptPageResponse> {
    return this.call("listMessagesAfterPage", sessionId, afterSequence, limit) as Promise<TranscriptPageResponse>;
  }

  listMessagesAround(sessionId: string, aroundSequence: number, limit: number): Promise<TranscriptPageResponse> {
    return this.call("listMessagesAround", sessionId, aroundSequence, limit) as Promise<TranscriptPageResponse>;
  }

  listMessageRange(sessionId: string, fromSequence: number, toSequence: number): Promise<TranscriptPageResponse> {
    return this.call("listMessageRange", sessionId, fromSequence, toSequence) as Promise<TranscriptPageResponse>;
  }

  searchMessages(sessionId: string, query: string, limit: number): Promise<TranscriptSearchResponse> {
    return this.call("searchMessages", sessionId, query, limit) as Promise<TranscriptSearchResponse>;
  }

  clearSessionTranscript(sessionId: string): Promise<void> {
    return this.call("clearSessionTranscript", sessionId) as Promise<void>;
  }

  getGlobalModelSettings(): Promise<SessionModelSelections> {
    return this.call("getGlobalModelSettings") as Promise<SessionModelSelections>;
  }

  setGlobalModelSettings(
    mode: CollaborationMode,
    model: string,
    reasoningEffort: string | null,
    updatedAt: string
  ): Promise<SessionModelSelections> {
    return this.call("setGlobalModelSettings", mode, model, reasoningEffort, updatedAt) as Promise<SessionModelSelections>;
  }

  getApprovalReviewerSettings(): Promise<ApprovalReviewerSettings> {
    return this.call("getApprovalReviewerSettings") as Promise<ApprovalReviewerSettings>;
  }

  setApprovalReviewerSettings(settings: ApprovalReviewerSettings, updatedAt: string): Promise<ApprovalReviewerSettings> {
    return this.call("setApprovalReviewerSettings", settings, updatedAt) as Promise<ApprovalReviewerSettings>;
  }

  getUnrestrictedRemoteAccessEnabled(): Promise<boolean> {
    return this.call("getUnrestrictedRemoteAccessEnabled") as Promise<boolean>;
  }

  setUnrestrictedRemoteAccessEnabled(enabled: boolean): Promise<boolean> {
    return this.call("setUnrestrictedRemoteAccessEnabled", enabled) as Promise<boolean>;
  }

  getNotificationSettings(deviceId: string): Promise<NotificationSettings> {
    return this.call("getNotificationSettings", deviceId) as Promise<NotificationSettings>;
  }

  listNotificationSettings(): Promise<Record<string, NotificationSettings>> {
    return this.call("listNotificationSettings") as Promise<Record<string, NotificationSettings>>;
  }

  setNotificationRule(
    deviceId: string,
    scope: NotificationRuleScope,
    sessionId: string | null,
    type: NotificationRuleType,
    enabled: boolean,
    updatedAt: string
  ): Promise<NotificationSettings> {
    return this.call("setNotificationRule", deviceId, scope, sessionId, type, enabled, updatedAt) as Promise<NotificationSettings>;
  }

  setNotificationDeliverySetting(
    deviceId: string,
    channel: NotificationDeliveryChannel,
    enabled: boolean,
    updatedAt: string
  ): Promise<NotificationSettings> {
    return this.call("setNotificationDeliverySetting", deviceId, channel, enabled, updatedAt) as Promise<NotificationSettings>;
  }

  upsertPushSubscription(deviceId: string, subscription: PushSubscriptionInput, updatedAt: string): Promise<void> {
    return this.call("upsertPushSubscription", deviceId, subscription, updatedAt) as Promise<void>;
  }

  deletePushSubscription(deviceId: string, endpoint: string): Promise<void> {
    return this.call("deletePushSubscription", deviceId, endpoint) as Promise<void>;
  }

  listPushSubscriptions(deviceId?: string): Promise<StoredPushSubscription[]> {
    return this.call("listPushSubscriptions", deviceId) as Promise<StoredPushSubscription[]>;
  }

  getPushVapidKeys(): Promise<PushVapidKeys | null> {
    return this.call("getPushVapidKeys") as Promise<PushVapidKeys | null>;
  }

  setPushVapidKeys(keys: PushVapidKeys, updatedAt: string): Promise<PushVapidKeys> {
    return this.call("setPushVapidKeys", keys, updatedAt) as Promise<PushVapidKeys>;
  }

  latestApprovalMessage(sessionId: string): Promise<ChatMessage | null> {
    return this.call("latestApprovalMessage", sessionId) as Promise<ChatMessage | null>;
  }

  latestQuestionMessage(sessionId: string, appServerRequestOnly = false): Promise<ChatMessage | null> {
    return this.call("latestQuestionMessage", sessionId, appServerRequestOnly) as Promise<ChatMessage | null>;
  }

  latestQuestionAnswerMessage(sessionId: string, questionId: string, afterSequence: number): Promise<ChatMessage | null> {
    return this.call("latestQuestionAnswerMessage", sessionId, questionId, afterSequence) as Promise<ChatMessage | null>;
  }

  listQueuedInputs(sessionId: string): Promise<QueuedInput[]> {
    return this.call("listQueuedInputs", sessionId) as Promise<QueuedInput[]>;
  }

  getQueuedInput(sessionId: string, queuedInputId: string): Promise<QueuedInput | null> {
    return this.call("getQueuedInput", sessionId, queuedInputId) as Promise<QueuedInput | null>;
  }

  appendQueuedInput(input: QueuedInput): Promise<void> {
    return this.call("appendQueuedInput", input) as Promise<void>;
  }

  upsertAppServerRequest(request: ReceivedAppServerRequest): Promise<PersistedAppServerRequest> {
    return this.call("upsertAppServerRequest", request) as Promise<PersistedAppServerRequest>;
  }

  listUnresolvedAppServerRequests(sessionId: string): Promise<PersistedAppServerRequest[]> {
    return this.call("listUnresolvedAppServerRequests", sessionId) as Promise<PersistedAppServerRequest[]>;
  }

  claimAppServerRequestResponse(
    sessionId: string,
    requestId: string | number,
    response: unknown,
    respondedAt: string
  ): Promise<PersistedAppServerRequest | null> {
    return this.call("claimAppServerRequestResponse", sessionId, requestId, response, respondedAt) as Promise<PersistedAppServerRequest | null>;
  }

  resolveAppServerRequest(sessionId: string, requestId: string | number, resolvedAt: string): Promise<boolean> {
    return this.call("resolveAppServerRequest", sessionId, requestId, resolvedAt) as Promise<boolean>;
  }

  resolveAppServerTurnRequests(sessionId: string, threadId: string, turnId: string, resolvedAt: string): Promise<number> {
    return this.call("resolveAppServerTurnRequests", sessionId, threadId, turnId, resolvedAt) as Promise<number>;
  }

  applyAppServerProjection(projection: AppServerProjectionInput): Promise<AppServerProjectionResult> {
    return this.call("applyAppServerProjection", projection) as Promise<AppServerProjectionResult>;
  }

  getAppServerReconciliationState(sessionId: string): Promise<AppServerReconciliationState | null> {
    return this.call("getAppServerReconciliationState", sessionId) as Promise<AppServerReconciliationState | null>;
  }

  repairAppServerProjectionThread(sessionId: string, threadId: string): Promise<AppServerProjectionRepairResult> {
    return this.call("repairAppServerProjectionThread", sessionId, threadId) as Promise<AppServerProjectionRepairResult>;
  }

  upsertAppServerCommandProcess(process: AppServerCommandProcess): Promise<void> {
    return this.call("upsertAppServerCommandProcess", process) as Promise<void>;
  }

  removeAppServerCommandProcess(sessionId: string, threadId: string, itemId: string, processId: string): Promise<boolean> {
    return this.call("removeAppServerCommandProcess", sessionId, threadId, itemId, processId) as Promise<boolean>;
  }

  removeAppServerTurnCommandProcesses(sessionId: string, threadId: string, turnId: string): Promise<number> {
    return this.call("removeAppServerTurnCommandProcesses", sessionId, threadId, turnId) as Promise<number>;
  }

  clearAppServerCommandProcesses(sessionId: string): Promise<number> {
    return this.call("clearAppServerCommandProcesses", sessionId) as Promise<number>;
  }

  listAppServerCommandProcesses(sessionId: string, threadId: string): Promise<AppServerCommandProcess[]> {
    return this.call("listAppServerCommandProcesses", sessionId, threadId) as Promise<AppServerCommandProcess[]>;
  }

  updateQueuedInput(input: QueuedInput): Promise<void> {
    return this.call("updateQueuedInput", input) as Promise<void>;
  }

  deleteQueuedInput(sessionId: string, queuedInputId: string): Promise<void> {
    return this.call("deleteQueuedInput", sessionId, queuedInputId) as Promise<void>;
  }

  deleteEchoedSentQueuedInputs(sessionId: string): Promise<number> {
    return this.call("deleteEchoedSentQueuedInputs", sessionId) as Promise<number>;
  }

  nextSequence(sessionId: string): Promise<number> {
    return this.call("nextSequence", sessionId) as Promise<number>;
  }

  getParserOffset(source: string): Promise<number> {
    return this.call("getParserOffset", source) as Promise<number>;
  }

  listParserOffsets(): Promise<Record<string, number>> {
    return this.call("listParserOffsets") as Promise<Record<string, number>>;
  }

  hasParserOffset(source: string): Promise<boolean> {
    return this.call("hasParserOffset", source) as Promise<boolean>;
  }

  setParserOffset(source: string, offset: number, parserVersion: string, updatedAt: string): Promise<void> {
    return this.call("setParserOffset", source, offset, parserVersion, updatedAt) as Promise<void>;
  }

  resetParserOffset(source: string): Promise<void> {
    return this.call("resetParserOffset", source) as Promise<void>;
  }

  addAudit(actor: string, action: string, target: string, result: string, timestamp: string): Promise<void> {
    return this.call("addAudit", actor, action, target, result, timestamp) as Promise<void>;
  }

  getSessionRecoveryRuntime(): Promise<SessionRecoveryRuntimeState | null> {
    return this.call("getSessionRecoveryRuntime") as Promise<SessionRecoveryRuntimeState | null>;
  }

  setSessionRecoveryRuntime(state: SessionRecoveryRuntimeState): Promise<void> {
    return this.call("setSessionRecoveryRuntime", state) as Promise<void>;
  }

  getSessionRecoveryIncident(): Promise<SessionRecoveryIncident | null> {
    return this.call("getSessionRecoveryIncident") as Promise<SessionRecoveryIncident | null>;
  }

  setSessionRecoveryIncident(incident: SessionRecoveryIncident | null, updatedAt: string): Promise<void> {
    return this.call("setSessionRecoveryIncident", incident, updatedAt) as Promise<void>;
  }

  private call(method: DbMethod, ...args: unknown[]): Promise<unknown> {
    if (this.inline) {
      const value = Reflect.apply(this.inline[method] as unknown as (...args: unknown[]) => unknown, this.inline, args);
      return value as Promise<unknown>;
    }
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error("Database worker is not available"));
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, method, args });
    });
  }
}

export class SyncAppDatabase {
  private readonly db: DatabaseSync;
  private readonly recentUserPromptsCache = new Map<string, string[]>();

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    try {
      this.migrate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  upsertSession(session: ManagedSession, updatedAt: string, rejectIfNewer = false): void {
    const existingRow = this.db.prepare("SELECT * FROM managed_sessions WHERE id = ?").get(session.id) as SessionRow | undefined;
    if (rejectIfNewer && existingRow && existingRow.updated_at > updatedAt) return;
    const existing = existingRow ? this.hydrateSession(existingRow) : null;
    const nextSession: ManagedSession = {
      ...session,
      initializing: existing ? existing.initializing === true : session.initializing === true,
      pinned: existing?.pinned ?? session.pinned ?? false,
      contextUsage: existing?.contextUsage ?? session.contextUsage ?? null,
      agentOwnership: existing?.agentOwnership ?? session.agentOwnership ?? null,
      orchestrationAvailable: existing?.orchestrationAvailable ?? session.orchestrationAvailable ?? false,
      resourceUnit: session.resourceUnit ?? existing?.resourceUnit ?? session.resourceScope ?? existing?.resourceScope ?? null,
      resourceScope: session.resourceScope ?? existing?.resourceScope ?? null,
      documentScopeId: session.documentScopeId ?? existing?.documentScopeId ?? null
    };
    this.db
      .prepare(
        `INSERT INTO managed_sessions
          (id, data_json, status, last_activity_at, preview, unread_count, archived, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          data_json=excluded.data_json,
          status=excluded.status,
          last_activity_at=excluded.last_activity_at,
          preview=excluded.preview,
          unread_count=managed_sessions.unread_count,
          archived=excluded.archived,
          updated_at=excluded.updated_at`
      )
      .run(
        nextSession.id,
        JSON.stringify(nextSession),
        nextSession.status,
        nextSession.lastActivityAt,
        nextSession.preview,
        nextSession.unreadCount,
        nextSession.archived ? 1 : 0,
        updatedAt
      );
  }

  rekeySession(
    oldSessionId: string,
    session: ManagedSession,
    parserOffsetMove: { from: string; to: string } | null,
    updatedAt: string
  ): ManagedSession | null {
    const oldRow = this.db.prepare("SELECT * FROM managed_sessions WHERE id = ?").get(oldSessionId) as SessionRow | undefined;
    if (!oldRow) return null;

    const existing = this.hydrateSession(oldRow);
    const nextSession: ManagedSession = {
      ...session,
      pinned: existing.pinned,
      archived: session.archived,
      contextUsage: existing.contextUsage ?? session.contextUsage ?? null,
      agentOwnership: existing.agentOwnership ?? session.agentOwnership ?? null,
      orchestrationAvailable: session.orchestrationAvailable ?? existing.orchestrationAvailable ?? false,
      resourceUnit: session.resourceUnit ?? existing.resourceUnit ?? session.resourceScope ?? existing.resourceScope ?? null,
      resourceScope: session.resourceScope ?? existing.resourceScope ?? null,
      documentScopeId: session.documentScopeId ?? existing.documentScopeId ?? null
    };
    const archived = nextSession.archived ? 1 : 0;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (oldSessionId === nextSession.id) {
        this.db
          .prepare(
            `UPDATE managed_sessions
             SET data_json = ?,
                 status = ?,
                 last_activity_at = ?,
                 preview = ?,
                 archived = ?,
                 updated_at = ?
             WHERE id = ?`
          )
          .run(
            JSON.stringify(nextSession),
            nextSession.status,
            nextSession.lastActivityAt,
            nextSession.preview,
            archived,
            updatedAt,
            oldSessionId
          );
      } else {
        this.db.prepare("DELETE FROM managed_sessions WHERE id = ?").run(nextSession.id);
        this.db
          .prepare(
            `INSERT INTO managed_sessions
              (id, data_json, status, last_activity_at, preview, unread_count, archived, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            nextSession.id,
            JSON.stringify(nextSession),
            nextSession.status,
            nextSession.lastActivityAt,
            nextSession.preview,
            oldRow.unread_count,
            archived,
            updatedAt
          );
        this.rekeySessionReferences(oldSessionId, nextSession.id);
        this.rekeyAgentRelationships(oldSessionId, nextSession.id);
        this.db.prepare("DELETE FROM managed_sessions WHERE id = ?").run(oldSessionId);
      }

      if (parserOffsetMove && parserOffsetMove.from !== parserOffsetMove.to) {
        this.db.prepare("DELETE FROM parser_offsets WHERE source = ?").run(parserOffsetMove.to);
        this.db.prepare("UPDATE parser_offsets SET source = ?, updated_at = ? WHERE source = ?").run(
          parserOffsetMove.to,
          updatedAt,
          parserOffsetMove.from
        );
      }

      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return this.getSession(nextSession.id);
  }

  private rekeySessionReferences(oldSessionId: string, newSessionId: string): void {
    this.recentUserPromptsCache.delete(oldSessionId);
    this.recentUserPromptsCache.delete(newSessionId);
    this.db.prepare("UPDATE messages SET session_id = ? WHERE session_id = ?").run(newSessionId, oldSessionId);
    this.db.prepare("UPDATE session_prompt_index SET session_id = ? WHERE session_id = ?").run(newSessionId, oldSessionId);
    this.db.prepare("UPDATE queued_inputs SET session_id = ? WHERE session_id = ?").run(newSessionId, oldSessionId);
    this.db.prepare("UPDATE queued_inputs SET actor_session_id = ? WHERE actor_session_id = ?").run(newSessionId, oldSessionId);
    this.db.prepare("UPDATE app_server_requests SET session_id = ? WHERE session_id = ?").run(newSessionId, oldSessionId);
    this.db.prepare("UPDATE app_server_reconciliation SET session_id = ? WHERE session_id = ?").run(newSessionId, oldSessionId);
    this.db.prepare("UPDATE app_server_command_processes SET session_id = ? WHERE session_id = ?").run(newSessionId, oldSessionId);
    this.db.prepare("UPDATE codex_item_messages SET session_id = ? WHERE session_id = ?").run(newSessionId, oldSessionId);
    this.db.prepare("UPDATE btw_exchanges SET session_id = ? WHERE session_id = ?").run(newSessionId, oldSessionId);
    this.db.prepare("UPDATE agent_session_waits SET actor_session_id = ? WHERE actor_session_id = ?").run(newSessionId, oldSessionId);
    const waitRows = this.db.prepare("SELECT actor_session_id, wait_json FROM agent_session_waits")
      .all() as unknown as Array<{ actor_session_id: string; wait_json: string }>;
    for (const row of waitRows) {
      const wait = JSON.parse(row.wait_json) as PersistedAgentWait;
      const updated = {
        ...wait,
        actorSessionId: wait.actorSessionId === oldSessionId ? newSessionId : wait.actorSessionId,
        sessionIds: wait.sessionIds.map((id) => id === oldSessionId ? newSessionId : id)
      };
      if (JSON.stringify(updated) !== JSON.stringify(wait)) {
        this.db.prepare("UPDATE agent_session_waits SET wait_json = ? WHERE actor_session_id = ?")
          .run(JSON.stringify(updated), row.actor_session_id);
      }
    }
    this.db.prepare("UPDATE notification_rules SET session_id = ? WHERE session_id = ?").run(newSessionId, oldSessionId);
    this.db.prepare("UPDATE notification_device_rules SET session_id = ? WHERE session_id = ?").run(newSessionId, oldSessionId);
    this.db.prepare("UPDATE events SET session_id = ? WHERE session_id = ?").run(newSessionId, oldSessionId);
    this.db.prepare("UPDATE git_workspaces SET session_id = ? WHERE session_id = ?").run(newSessionId, oldSessionId);
  }

  private rekeyAgentRelationships(oldSessionId: string, newSessionId: string): void {
    const rows = this.db.prepare("SELECT id, data_json FROM managed_sessions").all() as unknown as Array<Pick<SessionRow, "id" | "data_json">>;
    for (const row of rows) {
      const session = JSON.parse(row.data_json) as ManagedSession;
      const ownership = session.agentOwnership;
      if (!ownership || (ownership.parentSessionId !== oldSessionId && ownership.rootSessionId !== oldSessionId)) continue;
      session.agentOwnership = {
        ...ownership,
        parentSessionId: ownership.parentSessionId === oldSessionId ? newSessionId : ownership.parentSessionId,
        rootSessionId: ownership.rootSessionId === oldSessionId ? newSessionId : ownership.rootSessionId
      };
      this.db.prepare("UPDATE managed_sessions SET data_json = ? WHERE id = ?").run(JSON.stringify(session), row.id);
    }
  }

  setSessionStatus(sessionId: string, status: SessionStatus, updatedAt: string): void {
    const existing = this.getSession(sessionId);
    const dataJson = existing ? JSON.stringify({ ...existing, status }) : null;
    this.db
      .prepare("UPDATE managed_sessions SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, updatedAt, sessionId);
    if (dataJson) {
      this.db
        .prepare("UPDATE managed_sessions SET data_json = ? WHERE id = ?")
        .run(dataJson, sessionId);
    }
  }

  markSessionArchived(sessionId: string, archived: boolean, updatedAt: string): void {
    this.db
      .prepare("UPDATE managed_sessions SET archived = ?, updated_at = ? WHERE id = ?")
      .run(archived ? 1 : 0, updatedAt, sessionId);
  }

  setSessionPinned(sessionId: string, pinned: boolean, updatedAt: string): ManagedSession | null {
    const existing = this.getSession(sessionId);
    if (!existing) return null;
    const next = { ...existing, pinned };
    this.db
      .prepare("UPDATE managed_sessions SET data_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(next), updatedAt, sessionId);
    return this.getSession(sessionId);
  }

  setSessionInitializing(sessionId: string, initializing: boolean, updatedAt: string): ManagedSession | null {
    const existing = this.getSession(sessionId);
    if (!existing) return null;
    const next = { ...existing, initializing };
    this.db
      .prepare("UPDATE managed_sessions SET data_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(next), updatedAt, sessionId);
    return this.getSession(sessionId);
  }

  setSessionInitializationResult(
    sessionId: string,
    status: SessionStatus,
    startupError: string | null,
    updatedAt: string
  ): ManagedSession | null {
    const existing = this.getSession(sessionId);
    if (!existing) return null;
    const next = { ...existing, status, initializing: false, startupError };
    this.db
      .prepare("UPDATE managed_sessions SET data_json = ?, status = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(next), status, updatedAt, sessionId);
    return this.getSession(sessionId);
  }

  setSessionInputMode(sessionId: string, inputMode: CollaborationMode, updatedAt: string): ManagedSession | null {
    const existing = this.getSession(sessionId);
    if (!existing) return null;
    const next = { ...existing, inputMode };
    this.db
      .prepare("UPDATE managed_sessions SET data_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(next), updatedAt, sessionId);
    return this.getSession(sessionId);
  }

  setSessionFastMode(sessionId: string, fastMode: boolean, updatedAt: string): ManagedSession | null {
    const existing = this.getSession(sessionId);
    if (!existing) return null;
    const next = { ...existing, fastMode };
    this.db
      .prepare("UPDATE managed_sessions SET data_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(next), updatedAt, sessionId);
    return this.getSession(sessionId);
  }

  setSessionApprovalMode(sessionId: string, approvalMode: ApprovalMode, updatedAt: string): ManagedSession | null {
    return this.updateSessionData(sessionId, { approvalMode }, updatedAt);
  }

  setSessionModelSettings(
    sessionId: string,
    mode: CollaborationMode,
    model: string,
    reasoningEffort: string | null,
    updatedAt: string,
    fastModeAvailable?: boolean | null,
    fastMode?: boolean | null
  ): ManagedSession | null {
    const existing = this.getSession(sessionId);
    if (!existing) return null;
    const next = {
      ...existing,
      models: withSessionModelSettings(existing.models, mode, model, reasoningEffort),
      ...(fastModeAvailable === undefined ? {} : { fastModeAvailable }),
      ...(fastMode === undefined ? {} : { fastMode })
    };
    this.db
      .prepare("UPDATE managed_sessions SET data_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(next), updatedAt, sessionId);
    return this.getSession(sessionId);
  }

  setSessionContextUsage(sessionId: string, contextUsage: SessionContextUsage, updatedAt: string): ManagedSession | null {
    return this.updateSessionData(sessionId, { contextUsage }, updatedAt);
  }

  setSessionAgentOwnership(sessionId: string, agentOwnership: AgentSessionOwnership | null, updatedAt: string): ManagedSession | null {
    return this.updateSessionData(sessionId, { agentOwnership }, updatedAt);
  }

  completeAgentSession(sessionId: string, completedAt: string): ManagedSession | null {
    const existing = this.getSession(sessionId);
    if (!existing?.agentOwnership) return existing;
    const next: ManagedSession = {
      ...existing,
      status: "missing",
      agentOwnership: { ...existing.agentOwnership, completedAt }
    };
    this.db
      .prepare("UPDATE managed_sessions SET data_json = ?, status = 'missing', updated_at = ? WHERE id = ?")
      .run(JSON.stringify(next), completedAt, sessionId);
    return this.getSession(sessionId);
  }

  setSessionOrchestrationAvailable(sessionId: string, orchestrationAvailable: boolean, updatedAt: string): ManagedSession | null {
    return this.updateSessionData(sessionId, { orchestrationAvailable }, updatedAt);
  }

  setSessionResourceScope(sessionId: string, resourceScope: string | null, updatedAt: string): ManagedSession | null {
    return this.updateSessionData(sessionId, { resourceScope }, updatedAt);
  }

  setSessionDocumentScope(sessionId: string, documentScopeId: string, updatedAt: string): ManagedSession | null {
    return this.updateSessionData(sessionId, { documentScopeId }, updatedAt);
  }

  setSessionGitWorkspace(sessionId: string, workspace: GitWorkspaceSummary, updatedAt: string): ManagedSession | null {
    const existing = this.getSession(sessionId);
    if (!existing) return null;
    return this.updateSessionData(sessionId, {
      gitWorkspace: workspace,
      repo: { ...existing.repo, branch: workspace.targetBranch }
    }, updatedAt);
  }

  listAgentWaits(): PersistedAgentWait[] {
    const rows = this.db.prepare("SELECT wait_json FROM agent_session_waits ORDER BY actor_session_id")
      .all() as unknown as Array<{ wait_json: string }>;
    return rows.flatMap((row) => {
      try { return [JSON.parse(row.wait_json) as PersistedAgentWait]; } catch { return []; }
    });
  }

  upsertAgentWait(wait: PersistedAgentWait, updatedAt: string): void {
    this.db.prepare(
      `INSERT INTO agent_session_waits (actor_session_id, wait_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(actor_session_id) DO UPDATE SET wait_json=excluded.wait_json, updated_at=excluded.updated_at`
    ).run(wait.actorSessionId, JSON.stringify(wait), updatedAt);
  }

  deleteAgentWait(actorSessionId: string): void {
    this.db.prepare("DELETE FROM agent_session_waits WHERE actor_session_id = ?").run(actorSessionId);
  }

  putBtwExchange(exchange: BtwExchange): void {
    this.db.prepare(
      `INSERT INTO btw_exchanges
        (id, session_id, question, answer, status, error, created_at, first_token_at, completed_at, document_operation_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         question=excluded.question,
         answer=excluded.answer,
         status=excluded.status,
         error=excluded.error,
         first_token_at=excluded.first_token_at,
         completed_at=excluded.completed_at,
         document_operation_json=excluded.document_operation_json`
    ).run(
      exchange.id,
      exchange.sessionId,
      exchange.question,
      exchange.answer,
      exchange.status,
      exchange.error,
      exchange.createdAt,
      exchange.firstTokenAt,
      exchange.completedAt,
      exchange.documentOperation ? JSON.stringify(exchange.documentOperation) : null
    );
  }

  getBtwExchange(sessionId: string, exchangeId: string): BtwExchange | null {
    const row = this.db.prepare("SELECT * FROM btw_exchanges WHERE session_id = ? AND id = ?")
      .get(sessionId, exchangeId) as BtwExchangeRow | undefined;
    return row ? hydrateBtwExchange(row) : null;
  }

  listBtwExchanges(sessionId: string, limit = 50): BtwExchange[] {
    const boundedLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
    const rows = this.db.prepare(
      `SELECT * FROM btw_exchanges
       WHERE session_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    ).all(sessionId, boundedLimit) as unknown as BtwExchangeRow[];
    return rows.map(hydrateBtwExchange).reverse();
  }

  activeBtwExchange(sessionId: string): BtwExchange | null {
    const row = this.db.prepare(
      `SELECT * FROM btw_exchanges
       WHERE session_id = ? AND status = 'running'
       ORDER BY created_at DESC
       LIMIT 1`
    ).get(sessionId) as BtwExchangeRow | undefined;
    return row ? hydrateBtwExchange(row) : null;
  }

  listRunningBtwExchanges(): BtwExchange[] {
    const rows = this.db.prepare(
      "SELECT * FROM btw_exchanges WHERE status = 'running' ORDER BY created_at"
    ).all() as unknown as BtwExchangeRow[];
    return rows.map(hydrateBtwExchange);
  }

  failBtwExchange(sessionId: string, exchangeId: string, error: string, completedAt: string): BtwExchange | null {
    this.db.prepare(
      `UPDATE btw_exchanges
       SET status = 'failed', error = ?, completed_at = ?
       WHERE session_id = ? AND id = ? AND status = 'running'`
    ).run(error, completedAt, sessionId, exchangeId);
    return this.getBtwExchange(sessionId, exchangeId);
  }

  failRunningBtwExchanges(error: string, completedAt: string): BtwExchange[] {
    const rows = this.db.prepare("SELECT * FROM btw_exchanges WHERE status = 'running'")
      .all() as unknown as BtwExchangeRow[];
    this.db.prepare(
      `UPDATE btw_exchanges
       SET status = 'failed', error = ?, completed_at = ?
       WHERE status = 'running'`
    ).run(error, completedAt);
    return rows.map((row) => ({
      ...hydrateBtwExchange(row),
      status: "failed" as const,
      error,
      completedAt
    }));
  }

  private updateSessionData(sessionId: string, changes: Partial<ManagedSession>, updatedAt: string): ManagedSession | null {
    const existing = this.getSession(sessionId);
    if (!existing) return null;
    const next = { ...existing, ...changes };
    this.db.prepare("UPDATE managed_sessions SET data_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(next), updatedAt, sessionId);
    return this.getSession(sessionId);
  }

  listSessions(includeArchived = false, includeMissing = true): ManagedSession[] {
    const rows = this.db
      .prepare(
        `SELECT managed_sessions.*
         FROM managed_sessions
         WHERE (? = 1 OR archived = 0)
           AND (? = 1 OR status <> 'missing')
         ORDER BY managed_sessions.id ASC`
      )
      .all(includeArchived ? 1 : 0, includeMissing ? 1 : 0) as unknown as SessionRow[];

    return rows
      .map((row) => this.hydrateSession(row))
      .sort((first, second) => compareSessionsByActivity(first, second));
  }

  getSession(sessionId: string): ManagedSession | null {
    const row = this.db.prepare("SELECT * FROM managed_sessions WHERE id = ?").get(sessionId) as SessionRow | undefined;
    if (!row) return null;
    return this.hydrateSession(row);
  }

  upsertGitWorkspace(workspace: StoredGitWorkspace, updatedAt: string): void {
    const next = { ...workspace, updatedAt };
    this.db
      .prepare(
        `INSERT INTO git_workspaces (id, session_id, data_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           session_id=excluded.session_id,
           data_json=excluded.data_json,
           updated_at=excluded.updated_at`
      )
      .run(next.id, next.sessionId, JSON.stringify(next), updatedAt);
  }

  bindGitWorkspace(workspaceId: string, sessionId: string, updatedAt: string): void {
    const workspace = this.getGitWorkspace(workspaceId);
    if (workspace) this.upsertGitWorkspace({ ...workspace, sessionId }, updatedAt);
  }

  getGitWorkspace(workspaceId: string): StoredGitWorkspace | null {
    const row = this.db.prepare("SELECT * FROM git_workspaces WHERE id = ?").get(workspaceId) as GitWorkspaceRow | undefined;
    return row ? hydrateGitWorkspace(row) : null;
  }

  getGitWorkspaceBySession(sessionId: string): StoredGitWorkspace | null {
    const row = this.db.prepare("SELECT * FROM git_workspaces WHERE session_id = ?").get(sessionId) as GitWorkspaceRow | undefined;
    return row ? hydrateGitWorkspace(row) : null;
  }

  listGitWorkspaces(): StoredGitWorkspace[] {
    return (this.db.prepare("SELECT * FROM git_workspaces ORDER BY updated_at DESC").all() as unknown as GitWorkspaceRow[]).map(hydrateGitWorkspace);
  }

  addRepositoryApprovalRule(commonGitDir: string, prefixRule: string[], createdAt: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO repository_approval_rules
          (common_git_dir, prefix_rule_json, created_at)
         VALUES (?, ?, ?)`
      )
      .run(commonGitDir, JSON.stringify(prefixRule), createdAt);
  }

  hasRepositoryApprovalRule(commonGitDir: string, prefixRule: string[]): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM repository_approval_rules
           WHERE common_git_dir = ? AND prefix_rule_json = ?`
        )
        .get(commonGitDir, JSON.stringify(prefixRule))
    );
  }

  upsertTouchedRepository(repository: TouchedSessionRepository, updatedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO session_repositories
          (path, label, repo_root, branch, last_activity_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
          label=excluded.label,
          repo_root=excluded.repo_root,
          branch=excluded.branch,
          last_activity_at=CASE
            WHEN excluded.last_activity_at IS NULL THEN session_repositories.last_activity_at
            WHEN session_repositories.last_activity_at IS NULL THEN excluded.last_activity_at
            WHEN excluded.last_activity_at > session_repositories.last_activity_at THEN excluded.last_activity_at
            ELSE session_repositories.last_activity_at
          END,
          updated_at=excluded.updated_at`
      )
      .run(
        repository.path,
        repository.label,
        repository.repoRoot,
        repository.branch,
        repository.lastActivityAt,
        updatedAt
      );
    if (repository.lastActivityAt) {
      this.db
        .prepare("DELETE FROM dismissed_session_directories WHERE path = ? AND dismissed_at < ?")
        .run(repository.path, repository.lastActivityAt);
    }
  }

  dismissSessionDirectory(path: string, dismissedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO dismissed_session_directories (path, dismissed_at)
         VALUES (?, ?)
         ON CONFLICT(path) DO UPDATE SET dismissed_at=excluded.dismissed_at`
      )
      .run(path, dismissedAt);
  }

  listDismissedSessionDirectories(): string[] {
    return (this.db.prepare("SELECT path FROM dismissed_session_directories").all() as unknown as Array<{ path: string }>)
      .map((row) => row.path);
  }

  listTouchedRepositories(limit = 100): SessionDirectorySuggestion[] {
    const rows = this.db
      .prepare(
        `SELECT path, label, repo_root, branch, last_activity_at, updated_at
         FROM session_repositories
         ORDER BY COALESCE(last_activity_at, updated_at) DESC, label ASC, path ASC
         LIMIT ?`
      )
      .all(limit) as unknown as SessionRepositoryRow[];

    return rows.map((row) => ({
      path: row.path,
      label: row.label,
      repoRoot: row.repo_root,
      branch: row.branch,
      source: "recent",
      lastActivityAt: row.last_activity_at
    }));
  }

  appendMessage(message: ChatMessage): boolean {
    return this.writeMessage(message).changed;
  }

  appendMessageWithNextSequence(message: Omit<ChatMessage, "sequence">): ChatMessage | null {
    const sequenced = { ...message, sequence: this.nextSequence(message.sessionId) };
    return this.appendMessage(sequenced) ? sequenced : null;
  }

  private writeMessage(message: ChatMessage): MessageWriteResult {
    if (this.reconcileMuxpilotSubmissionEcho(message)) return { message: null, inserted: false, changed: false };
    if (!isMuxpilotSubmissionMessage(message) && this.isDuplicateUserEcho(message)) {
      return { message: null, inserted: false, changed: false };
    }
    if (this.isDuplicateSessionWaitEvent(message)) return { message: null, inserted: false, changed: false };

    const itemIdentity = this.codexItemMessageIdentity(message);
    if (itemIdentity) return this.writeCodexItemMessage(message, itemIdentity);

    const inserted = this.insertMessage(message);
    return { message: inserted ? message : null, inserted, changed: inserted };
  }

  private insertMessage(message: ChatMessage): boolean {

    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO messages
          (id, session_id, sequence, type, role, timestamp, text, payload_json)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM managed_sessions WHERE id = ?)`
      )
      .run(
        message.id,
        message.sessionId,
        message.sequence,
        message.type,
        message.role,
        message.timestamp,
        message.text,
        JSON.stringify(message.payload),
        message.sessionId
      );

    if (Number(result.changes) > 0) {
      this.upsertPromptIndexMessage(message);
      if (message.role === "user") this.recentUserPromptsCache.delete(message.sessionId);
      this.db
        .prepare(
          `UPDATE managed_sessions
           SET last_activity_at = ?,
               preview = CASE WHEN ? = 'user' THEN ? ELSE preview END,
               unread_count = unread_count + 1
           WHERE id = ?`
        )
        .run(message.timestamp, message.role, message.text.slice(0, 280), message.sessionId);
      return true;
    }

    return false;
  }

  private writeCodexItemMessage(
    incoming: ChatMessage,
    identity: CodexItemMessageIdentity
  ): MessageWriteResult {
    const source = incoming.payload.source === "codex_app_server" ? "app_server" : "rollout";
    if (source === "app_server" && incoming.type === "question_request") {
      this.rekeyLegacyRolloutQuestion(incoming.sessionId, identity);
    }
    let existing = this.db.prepare(
      `SELECT * FROM codex_item_messages
       WHERE session_id = ? AND thread_id = ? AND turn_id = ? AND item_id = ?`
    ).get(incoming.sessionId, identity.threadId, identity.turnId, identity.itemId) as CodexItemMessageRow | undefined;
    existing ??= this.equivalentPlanItemMessage(incoming, identity, source);

    if (!existing) {
      const inserted = this.insertMessage(incoming);
      if (!inserted) return { message: null, inserted: false, changed: false };
      this.db.prepare(
        `INSERT INTO codex_item_messages
          (session_id, thread_id, turn_id, item_id, message_id,
           app_server_message_id, rollout_message_id, app_server_observed_at, rollout_observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        incoming.sessionId,
        identity.threadId,
        identity.turnId,
        identity.itemId,
        incoming.id,
        source === "app_server" ? incoming.id : null,
        source === "rollout" ? incoming.id : null,
        source === "app_server" ? incoming.timestamp : null,
        source === "rollout" ? incoming.timestamp : null
      );
      return { message: incoming, inserted: true, changed: true };
    }

    this.db.prepare(
      `UPDATE codex_item_messages SET
        app_server_message_id = CASE WHEN ? = 'app_server' THEN ? ELSE app_server_message_id END,
        rollout_message_id = CASE WHEN ? = 'rollout' THEN ? ELSE rollout_message_id END,
        app_server_observed_at = CASE WHEN ? = 'app_server' THEN ? ELSE app_server_observed_at END,
        rollout_observed_at = CASE WHEN ? = 'rollout' THEN ? ELSE rollout_observed_at END
       WHERE session_id = ? AND thread_id = ? AND turn_id = ? AND item_id = ?`
    ).run(
      source, incoming.id,
      source, incoming.id,
      source, incoming.timestamp,
      source, incoming.timestamp,
      existing.session_id, existing.thread_id, existing.turn_id, existing.item_id
    );

    if (source === "rollout" || existing.app_server_message_id !== null) {
      return { message: null, inserted: false, changed: false };
    }

    const row = this.db.prepare("SELECT * FROM messages WHERE id = ? AND session_id = ?")
      .get(existing.message_id, incoming.sessionId) as MessageRow | undefined;
    if (!row) throw new Error(`Codex item message disappeared: ${incoming.sessionId}:${existing.message_id}`);
    const previous = hydrateMessage(row);
    const authoritative: ChatMessage = {
      ...incoming,
      id: row.id,
      sessionId: row.session_id,
      sequence: row.sequence,
      payload: { ...previous.payload, ...incoming.payload }
    };
    this.deletePromptIndexMessage(row.id);
    this.db.prepare(
      `UPDATE messages
       SET type = ?, role = ?, timestamp = ?, text = ?, payload_json = ?
       WHERE id = ? AND session_id = ?`
    ).run(
      authoritative.type,
      authoritative.role,
      authoritative.timestamp,
      authoritative.text,
      JSON.stringify(authoritative.payload),
      authoritative.id,
      authoritative.sessionId
    );
    this.upsertPromptIndexMessage(authoritative);
    if (authoritative.role === "user") this.recentUserPromptsCache.delete(authoritative.sessionId);
    this.db.prepare(
      `UPDATE managed_sessions
       SET last_activity_at = CASE
             WHEN last_activity_at IS NULL OR ? > last_activity_at THEN ?
             ELSE last_activity_at
           END,
           preview = CASE
             WHEN ? = 'user' AND (last_activity_at IS NULL OR ? >= last_activity_at) THEN ?
             ELSE preview
           END
       WHERE id = ?`
    ).run(
      authoritative.timestamp,
      authoritative.timestamp,
      authoritative.role,
      authoritative.timestamp,
      authoritative.text.slice(0, 280),
      authoritative.sessionId
    );
    return { message: authoritative, inserted: false, changed: true };
  }

  private equivalentPlanItemMessage(
    incoming: ChatMessage,
    identity: CodexItemMessageIdentity,
    source: "app_server" | "rollout"
  ): CodexItemMessageRow | undefined {
    const incomingPlan = canonicalProposedPlan(incoming);
    if (incomingPlan === null) return undefined;
    const candidates = this.db.prepare(
      `SELECT codex_item_messages.*
       FROM codex_item_messages
       JOIN messages ON messages.id = codex_item_messages.message_id
       WHERE codex_item_messages.session_id = ?
         AND codex_item_messages.thread_id = ?
         AND codex_item_messages.turn_id = ?
         AND codex_item_messages.item_id <> ?
         AND messages.type = 'assistant'
         AND messages.role = 'assistant'
         AND CASE WHEN ? = 'app_server'
           THEN codex_item_messages.app_server_message_id IS NULL
           ELSE codex_item_messages.rollout_message_id IS NULL
         END`
    ).all(
      incoming.sessionId,
      identity.threadId,
      identity.turnId,
      identity.itemId,
      source
    ) as unknown as CodexItemMessageRow[];
    return candidates.find((candidate) => {
      const row = this.db.prepare("SELECT * FROM messages WHERE id = ? AND session_id = ?")
        .get(candidate.message_id, incoming.sessionId) as MessageRow | undefined;
      return row !== undefined && canonicalProposedPlan(hydrateMessage(row)) === incomingPlan;
    });
  }

  private rekeyLegacyRolloutQuestion(sessionId: string, identity: CodexItemMessageIdentity): void {
    const legacy = this.db.prepare(
      `SELECT codex_item_messages.item_id
       FROM codex_item_messages
       JOIN messages ON messages.id = codex_item_messages.message_id
       WHERE codex_item_messages.session_id = ?
         AND codex_item_messages.thread_id = ?
         AND codex_item_messages.turn_id = ?
         AND codex_item_messages.app_server_message_id IS NULL
         AND messages.type = 'question_request'
         AND json_extract(messages.payload_json, '$.question.id') = ?
       LIMIT 1`
    ).get(sessionId, identity.threadId, identity.turnId, identity.itemId) as { item_id: string } | undefined;
    if (!legacy || legacy.item_id === identity.itemId) return;
    const target = this.db.prepare(
      `SELECT 1 FROM codex_item_messages
       WHERE session_id = ? AND thread_id = ? AND turn_id = ? AND item_id = ?`
    ).get(sessionId, identity.threadId, identity.turnId, identity.itemId);
    if (target) return;
    this.db.prepare(
      `UPDATE codex_item_messages SET item_id = ?
       WHERE session_id = ? AND thread_id = ? AND turn_id = ? AND item_id = ?`
    ).run(identity.itemId, sessionId, identity.threadId, identity.turnId, legacy.item_id);
  }

  private codexItemMessageIdentity(message: ChatMessage): CodexItemMessageIdentity | null {
    const marker = recordValue(message.payload.codexItemIdentity);
    const turnId = nonemptyStringValue(marker?.turnId);
    const itemId = nonemptyStringValue(marker?.itemId);
    if (!turnId || !itemId) return null;
    const explicitThreadId = nonemptyStringValue(marker?.threadId);
    if (explicitThreadId) return { threadId: explicitThreadId, turnId, itemId };
    const row = this.db.prepare("SELECT data_json FROM managed_sessions WHERE id = ?")
      .get(message.sessionId) as Pick<SessionRow, "data_json"> | undefined;
    if (!row) return null;
    try {
      const session = recordValue(JSON.parse(row.data_json));
      const provider = recordValue(session?.provider);
      const threadId = nonemptyStringValue(provider?.threadId) ?? nonemptyStringValue(session?.codexSessionId);
      return threadId ? { threadId, turnId, itemId } : null;
    } catch {
      return null;
    }
  }

  private isDuplicateSessionWaitEvent(message: ChatMessage): boolean {
    const event = sessionWaitEventFromPayload(message.payload);
    if (message.role !== "system" || message.type !== "status" || !event) return false;
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE session_id = ? AND role = 'system' AND type = 'status'
         ORDER BY sequence DESC
         LIMIT 20`
      )
      .all(message.sessionId) as unknown as MessageRow[];
    return rows.some((row) => {
      if (!timestampsAreNear(row.timestamp, message.timestamp)) return false;
      try {
        const candidate = sessionWaitEventFromPayload(JSON.parse(row.payload_json) as Record<string, unknown>);
        return candidate !== null && JSON.stringify(candidate) === JSON.stringify(event);
      } catch {
        return false;
      }
    });
  }

  private reconcileMuxpilotSubmissionEcho(message: ChatMessage): boolean {
    if (message.role !== "user" || isMuxpilotSubmissionMessage(message)) return false;
    const marker = recordValue(message.payload.codexItemIdentity);
    const clientMessageId = nonemptyStringValue(marker?.clientMessageId);
    const exactRow = clientMessageId
      ? this.db.prepare("SELECT * FROM messages WHERE id = ? AND session_id = ?")
          .get(clientMessageId, message.sessionId) as MessageRow | undefined
      : undefined;
    const candidates = exactRow
      ? []
      : (this.db.prepare(
          `SELECT * FROM messages
           WHERE session_id = ?
             AND role = 'user'
             AND json_type(payload_json, '$.muxpilotSubmission') = 'object'
           ORDER BY sequence DESC
           LIMIT 20`
        ).all(message.sessionId) as unknown as MessageRow[]).map(hydrateMessage);
    const identity = this.codexItemMessageIdentity(message);
    const turnIdentityCandidates = identity
      ? candidates.filter((candidate) => {
          const submission = recordValue(candidate.payload.muxpilotSubmission);
          return submission?.threadId === identity.threadId && submission.turnId === identity.turnId;
        })
      : [];
    const turnIdentityMatch = turnIdentityCandidates.length === 1 ? turnIdentityCandidates[0] : undefined;
    const submitted = exactRow
      ? hydrateMessage(exactRow)
      : turnIdentityMatch ?? candidates.find((candidate) =>
          candidate.text === message.text &&
          isMuxpilotSubmissionMessage(candidate) &&
          timestampsAreNear(submissionAttemptTimestamp(candidate), message.timestamp)
        );
    if (
      !submitted ||
      !isMuxpilotSubmissionMessage(submitted) ||
      (!exactRow && !turnIdentityMatch && submitted.text !== message.text) ||
      (!exactRow && !turnIdentityMatch && !timestampsAreNear(submissionAttemptTimestamp(submitted), message.timestamp))
    ) return false;

    const muxpilotSubmission = recordValue(submitted.payload.muxpilotSubmission);
    const source = message.payload.source === "codex_app_server" ? "app_server" : "rollout";
    const reconciledPayload = muxpilotSubmission
      ? {
          ...submitted.payload,
          ...message.payload,
          muxpilotSubmission: muxpilotSubmission.state === "acknowledged"
            ? muxpilotSubmission
            : {
                ...muxpilotSubmission,
                state: "acknowledged",
                deliveryPhase: "acknowledged",
                acknowledgedBy: "user_echo",
                failureReason: null
              }
        }
      : message.payload;
    this.removeReconciledSubmissionDuplicate(message, submitted);
    const mapped = identity
      ? this.db.prepare(
          `SELECT * FROM codex_item_messages
           WHERE session_id = ? AND message_id = ?`
        ).get(message.sessionId, submitted.id) as CodexItemMessageRow | undefined
      : undefined;
    if (identity && mapped) {
      if (source === "app_server" && mapped.app_server_message_id === null) {
        this.db.prepare(
          `UPDATE messages
           SET type = ?, payload_json = ?
           WHERE id = ? AND session_id = ?`
        ).run(message.type, JSON.stringify(reconciledPayload), submitted.id, submitted.sessionId);
      }
      this.db.prepare(
        `UPDATE codex_item_messages SET
          app_server_message_id = CASE WHEN ? = 'app_server' THEN ? ELSE app_server_message_id END,
          rollout_message_id = CASE WHEN ? = 'rollout' THEN ? ELSE rollout_message_id END,
          app_server_observed_at = CASE WHEN ? = 'app_server' THEN ? ELSE app_server_observed_at END,
          rollout_observed_at = CASE WHEN ? = 'rollout' THEN ? ELSE rollout_observed_at END
         WHERE session_id = ? AND message_id = ?`
      ).run(
        source, message.id,
        source, message.id,
        source, message.timestamp,
        source, message.timestamp,
        message.sessionId, submitted.id
      );
      return true;
    }

    const result = this.db
      .prepare(
        `UPDATE messages
         SET type = ?, payload_json = ?
         WHERE id = ? AND session_id = ?`
      )
      .run(message.type, JSON.stringify(reconciledPayload), submitted.id, submitted.sessionId);
    if (Number(result.changes) > 0) {
      if (identity) {
        this.db.prepare(
          `INSERT OR IGNORE INTO codex_item_messages
            (session_id, thread_id, turn_id, item_id, message_id,
             app_server_message_id, rollout_message_id, app_server_observed_at, rollout_observed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          message.sessionId,
          identity.threadId,
          identity.turnId,
          identity.itemId,
          submitted.id,
          source === "app_server" ? message.id : null,
          source === "rollout" ? message.id : null,
          source === "app_server" ? message.timestamp : null,
          source === "rollout" ? message.timestamp : null
        );
      }
    }
    return Number(result.changes) > 0;
  }

  private removeReconciledSubmissionDuplicate(incoming: ChatMessage, submitted: ChatMessage): void {
    if (incoming.id === submitted.id) return;
    this.deletePromptIndexMessage(incoming.id);
    const removed = this.db.prepare("DELETE FROM messages WHERE id = ? AND session_id = ?")
      .run(incoming.id, incoming.sessionId);
    if (Number(removed.changes) === 0) return;
    this.db.prepare(
      `UPDATE managed_sessions
       SET unread_count = MAX(0, unread_count - 1),
           preview = CASE WHEN preview = ? THEN ? ELSE preview END
       WHERE id = ?`
    ).run(incoming.text.slice(0, 280), submitted.text.slice(0, 280), incoming.sessionId);
    this.recentUserPromptsCache.delete(incoming.sessionId);
  }

  private isDuplicateUserEcho(message: ChatMessage): boolean {
    if (message.role !== "user") return false;
    const previousUser = this.latestUserMessage(message.sessionId);
    if (!previousUser || previousUser.text !== message.text) return false;
    return (
      isResponseItemUserMessage(message) !== isResponseItemUserMessage(previousUser) &&
      timestampsAreNear(previousUser.timestamp, message.timestamp)
    );
  }

  latestUserMessage(sessionId: string): ChatMessage | null {
    const row = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE session_id = ? AND role = 'user'
         ORDER BY sequence DESC
         LIMIT 1`
      )
      .get(sessionId) as MessageRow | undefined;
    return row ? hydrateMessage(row) : null;
  }

  queuedSubmissionMessage(sessionId: string, queuedInputId: string): ChatMessage | null {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE session_id = ? AND role = 'user'
         ORDER BY sequence DESC`
      )
      .all(sessionId) as unknown as MessageRow[];
    for (const row of rows) {
      const message = hydrateMessage(row);
      const submission = recordValue(message.payload.muxpilotSubmission);
      if (submission?.queuedInputId === queuedInputId) return message;
    }
    return null;
  }

  activeApprovalContext(sessionId: string): ApprovalContextState {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE session_id = ?
           AND sequence > COALESCE(
             (SELECT MAX(sequence) FROM messages WHERE session_id = ? AND role IN ('user', 'assistant')),
             0
           )
           AND type IN ('approval_request', 'tool_call', 'tool_output', 'command_output')
         ORDER BY sequence ASC`
      )
      .all(sessionId, sessionId) as unknown as MessageRow[];
    const messages = rows.map(hydrateMessage);
    const completedCallIds = new Set(
      messages
        .filter((message) => message.type === "tool_output" || message.type === "command_output")
        .map(toolCallId)
        .filter((callId): callId is string => Boolean(callId))
    );
    const activeMessages = messages
      .filter((message) => {
        if (message.type === "approval_request") return true;
        if (message.type !== "tool_call") return false;
        const callId = toolCallId(message);
        return !callId || !completedCallIds.has(callId);
      })
      .reverse();
    return {
      messages: activeMessages,
      hasContext: messages.some((message) => message.type === "approval_request" || message.type === "tool_call")
    };
  }

  latestTurnLifecycleMessage(sessionId: string): ChatMessage | null {
    const row = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE session_id = ?
           AND type = 'status'
           AND text IN ('task_started', 'task_complete', 'turn_complete', 'turn_aborted')
         ORDER BY sequence DESC
         LIMIT 1`
      )
      .get(sessionId) as MessageRow | undefined;
    return row ? hydrateMessage(row) : null;
  }

  latestAssistantMessage(sessionId: string): ChatMessage | null {
    const row = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE session_id = ?
           AND role = 'assistant'
           AND sequence > COALESCE(
             (SELECT MAX(sequence) FROM messages WHERE session_id = ? AND role = 'user'),
             0
           )
         ORDER BY sequence DESC
         LIMIT 1`
      )
      .get(sessionId, sessionId) as MessageRow | undefined;
    return row ? hydrateMessage(row) : null;
  }

  latestPlanReadyMessage(sessionId: string): ChatMessage | null {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE session_id = ?
           AND role = 'assistant'
           AND type = 'assistant'
           AND sequence > COALESCE(
             (SELECT MAX(sequence) FROM messages WHERE session_id = ? AND role = 'user'),
             0
           )
         ORDER BY sequence DESC`
      )
      .all(sessionId, sessionId) as unknown as MessageRow[];
    const message = rows
      .map(hydrateMessage)
      .find((candidate) => hasCompleteProposedPlan(candidate.text) && !candidate.payload.interactionOutcome);
    return message ?? null;
  }

  updateMessageText(message: ChatMessage, text: string): ChatMessage | null {
    const result = this.db
      .prepare(
        `UPDATE messages
         SET text = ?
         WHERE id = ? AND session_id = ?`
      )
      .run(text, message.id, message.sessionId);

    if (Number(result.changes) === 0) return null;
    this.deletePromptIndexMessage(message.id);
    this.upsertPromptIndexMessage({ ...message, text });
    if (message.role === "user") {
      this.recentUserPromptsCache.delete(message.sessionId);
      this.db
        .prepare(
          `UPDATE managed_sessions
           SET preview = ?
           WHERE id = ?`
        )
        .run(text.slice(0, 280), message.sessionId);
    }
    return { ...message, text };
  }

  updateMessagePayload(message: ChatMessage, payload: Record<string, unknown>): ChatMessage | null {
    const result = this.db
      .prepare(
        `UPDATE messages
         SET payload_json = ?
         WHERE id = ? AND session_id = ?`
      )
      .run(JSON.stringify(payload), message.id, message.sessionId);
    return Number(result.changes) > 0 ? { ...message, payload } : null;
  }

  updateMuxpilotSubmission(message: ChatMessage, changes: Record<string, unknown>): ChatMessage | null {
    const row = this.db.prepare("SELECT * FROM messages WHERE id = ? AND session_id = ?")
      .get(message.id, message.sessionId) as MessageRow | undefined;
    if (!row) return null;
    const current = hydrateMessage(row);
    const submission = recordValue(current.payload.muxpilotSubmission) ?? {};
    const payload = {
      ...current.payload,
      muxpilotSubmission: { ...submission, ...changes }
    };
    const result = this.db
      .prepare(
        `UPDATE messages
         SET payload_json = ?
         WHERE id = ? AND session_id = ?`
      )
      .run(JSON.stringify(payload), current.id, current.sessionId);
    return Number(result.changes) > 0 ? { ...current, payload } : null;
  }

  listMessages(sessionId: string, afterSequence = 0): ChatMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE session_id = ? AND sequence > ?
         ORDER BY sequence ASC`
      )
      .all(sessionId, afterSequence) as unknown as MessageRow[];

    return rows.map(hydrateMessage);
  }

  getMessage(sessionId: string, messageId: string): ChatMessage | null {
    const row = this.db.prepare("SELECT * FROM messages WHERE session_id = ? AND id = ?")
      .get(sessionId, messageId) as MessageRow | undefined;
    return row ? hydrateMessage(row) : null;
  }

  listPromptHistory(query: string, limit: number): PromptHistoryResult[] {
    const normalizedQuery = ftsPromptQuery(query);
    if (!normalizedQuery) {
      const rows = this.db
        .prepare(
          `SELECT prompt_index.message_id, prompt_index.session_id, prompt_index.sequence, prompt_index.timestamp, prompt_index.text,
                  managed_sessions.data_json AS session_data_json
           FROM session_prompt_index AS prompt_index
           INNER JOIN managed_sessions ON managed_sessions.id = prompt_index.session_id
           ORDER BY prompt_index.timestamp DESC, prompt_index.sequence DESC
           LIMIT ?`
        )
        .all(limit) as unknown as PromptIndexRow[];
      return rows.map(promptHistoryResultFromIndex);
    }

    const rows = this.db
      .prepare(
        `SELECT prompt_index.message_id, prompt_index.session_id, prompt_index.sequence, prompt_index.timestamp, prompt_index.text,
                managed_sessions.data_json AS session_data_json
         FROM session_prompt_index AS prompt_index
         INNER JOIN managed_sessions ON managed_sessions.id = prompt_index.session_id
         WHERE session_prompt_index MATCH ?
         ORDER BY bm25(session_prompt_index), prompt_index.timestamp DESC, prompt_index.sequence DESC
         LIMIT ?`
      )
      .all(normalizedQuery, limit) as unknown as PromptIndexRow[];

    return rows.map(promptHistoryResultFromIndex);
  }

  listSessionHistory(query: string, limit: number): SessionHistoryResult[] {
    const normalizedQuery = ftsPromptQuery(query);
    if (!normalizedQuery) return collapseSessionHistory(this.recentRestorableSessionHistory(limit * 2), limit);

    const rows = this.db
      .prepare(
        `SELECT managed_sessions.rowid AS session_rowid,
                managed_sessions.id AS session_id,
                managed_sessions.data_json AS session_data_json,
                git_workspaces.data_json AS git_workspace_data_json,
                managed_sessions.status,
                managed_sessions.last_activity_at,
                managed_sessions.archived,
                prompt_index.sequence AS match_sequence,
                prompt_index.timestamp AS match_timestamp,
                prompt_index.text AS match_text,
                bm25(session_prompt_index) AS rank
         FROM session_prompt_index AS prompt_index
         INNER JOIN managed_sessions ON managed_sessions.id = prompt_index.session_id
         LEFT JOIN git_workspaces ON git_workspaces.session_id = managed_sessions.id
         WHERE session_prompt_index MATCH ?
         ORDER BY rank ASC, prompt_index.timestamp DESC, prompt_index.sequence DESC
         LIMIT ?`
      )
      .all(normalizedQuery, Math.max(limit * 12, 80)) as unknown as SessionHistoryMatchRow[];

    const bySession = new Map<string, { row: SessionHistoryMatchRow; prompts: SessionHistoryResult["matchedPrompts"] }>();
    for (const row of rows) {
      const session = JSON.parse(row.session_data_json) as ManagedSession;
      if (!session.codexSessionId) continue;
      const current = bySession.get(row.session_id);
      const prompt = {
        sequence: row.match_sequence,
        timestamp: row.match_timestamp,
        text: normalizePreviewText(row.match_text)
      };
      if (current) {
        if (current.prompts.length < 3 && !current.prompts.some((item) => item.sequence === prompt.sequence)) {
          current.prompts.push(prompt);
        }
        continue;
      }
      bySession.set(row.session_id, { row, prompts: [prompt] });
    }

    const promptMatches = [...bySession.values()].map(({ row, prompts }) => sessionHistoryResultFromMatchRow(row, prompts));
    const nameRows = this.db
      .prepare(
        `SELECT managed_sessions.id AS session_id,
                managed_sessions.data_json AS session_data_json,
                git_workspaces.data_json AS git_workspace_data_json,
                managed_sessions.status,
                managed_sessions.last_activity_at,
                managed_sessions.archived
         FROM managed_sessions
         LEFT JOIN git_workspaces ON git_workspaces.session_id = managed_sessions.id`
      )
      .all() as unknown as SessionHistoryNameRow[];
    const nameMatches = nameRows
      .filter((row) => {
        const session = JSON.parse(row.session_data_json) as ManagedSession;
        return Boolean(session.codexSessionId) && sessionNameMatchesQuery(session.name, query);
      })
      .map(sessionHistoryResultFromNameRow);

    return collapseSessionHistory([...promptMatches, ...nameMatches], limit);
  }

  listRecentMessages(sessionId: string, limit: number): TranscriptPageResponse {
    const pageItems = this.scanTranscriptItemsBackward(sessionId, Number.MAX_SAFE_INTEGER, limit, "items");
    const firstSequence = pageItems[0]?.firstSequence ?? Number.MAX_SAFE_INTEGER;

    return transcriptItemsPage(sessionId, pageItems, {
      hasMoreBefore: this.hasMessageBefore(sessionId, firstSequence),
      hasMoreAfter: false
    });
  }

  listActiveTailMessages(sessionId: string, fallbackLimit: number): TranscriptPageResponse {
    const prompt = this.latestDisplayableUserPrompt(sessionId);
    if (!prompt) return this.listRecentMessages(sessionId, fallbackLimit);

    const previousOutput = this.latestAssistantOutputBefore(sessionId, prompt.sequence);
    const activeItems = this.compactActiveTailItems(sessionId, prompt, previousOutput, fallbackLimit);
    const activePageItems = activeTailPageItems(activeItems, fallbackLimit);
    const remaining = Math.max(0, fallbackLimit - topLevelTranscriptItemCount(activePageItems));
    const olderItems =
      remaining > 0 ? this.listTranscriptItemsBefore(sessionId, activePageItems[0]?.firstSequence ?? prompt.sequence, remaining) : [];
    const pageItems = [...olderItems, ...activePageItems];
    const firstLoadedSequence = pageItems[0]?.firstSequence ?? prompt.sequence;

    return transcriptItemsPage(sessionId, pageItems, {
      hasMoreBefore: this.hasTopLevelTranscriptItemBefore(sessionId, firstLoadedSequence),
      hasMoreAfter: false
    });
  }

  listEarliestMessages(sessionId: string, limit: number): TranscriptPageResponse {
    const pageItems = this.scanTranscriptItemsForward(sessionId, 0, limit, false);
    const lastSequence = pageItems.at(-1)?.lastSequence ?? 0;

    return transcriptItemsPage(sessionId, pageItems, {
      hasMoreBefore: false,
      hasMoreAfter: this.hasMessageAfter(sessionId, lastSequence)
    });
  }

  private latestDisplayableUserPrompt(sessionId: string): MessageRow | null {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE session_id = ? AND role = 'user'
         ORDER BY sequence DESC`
      )
      .iterate(sessionId) as unknown as Iterable<MessageRow>;

    for (const row of rows) {
      if (isDisplayableUserPromptText(row.text)) return row;
    }
    return null;
  }

  private latestAssistantOutputBefore(sessionId: string, sequence: number): MessageRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE session_id = ?
           AND sequence < ?
           AND role = 'assistant'
           AND type IN ('assistant', 'assistant_update')
         ORDER BY sequence DESC
         LIMIT 1`
      )
      .get(sessionId, sequence) as MessageRow | undefined;
    return row ?? null;
  }

  private activeTailOutputAnchorSequence(sessionId: string, output: MessageRow): number {
    if (output.type !== "assistant") return output.sequence;
    const previous = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE session_id = ? AND sequence < ?
         ORDER BY sequence DESC
         LIMIT 1`
      )
      .get(sessionId, output.sequence) as MessageRow | undefined;
    if (previous?.role === "assistant" && previous.type === "assistant_update" && previous.text === output.text) {
      return previous.sequence;
    }
    return output.sequence;
  }

  private transcriptBoundaryAnchorSequence(sessionId: string, sequence: number): number {
    const row = this.db
      .prepare(`SELECT * FROM messages WHERE session_id = ? AND sequence = ?`)
      .get(sessionId, sequence) as MessageRow | undefined;
    return row?.role === "assistant" ? this.activeTailOutputAnchorSequence(sessionId, row) : sequence;
  }

  private compactActiveTailItems(
    sessionId: string,
    prompt: MessageRow,
    previousOutput: MessageRow | null,
    limit: number
  ): TranscriptItem[] {
    const firstSequence = previousOutput ? this.activeTailOutputAnchorSequence(sessionId, previousOutput) : prompt.sequence;
    return this.scanTranscriptItemsBackwardWithin(sessionId, firstSequence, limit);
  }

  private listTranscriptItemsBefore(sessionId: string, beforeSequence: number, limit: number): TranscriptItem[] {
    const boundarySequence = this.transcriptBoundaryAnchorSequence(sessionId, beforeSequence);
    const pageItems = this.scanTranscriptItemsBackward(sessionId, boundarySequence, limit, "topLevel");
    return topLevelTranscriptItemCount(pageItems) > 0 ? pageItems : [];
  }

  listMessagesBefore(sessionId: string, beforeSequence: number, limit: number): TranscriptPageResponse {
    const boundarySequence = this.transcriptBoundaryAnchorSequence(sessionId, beforeSequence);
    const pageItems = this.scanTranscriptItemsBackward(sessionId, boundarySequence, limit, "topLevel");
    const firstSequence = pageItems[0]?.firstSequence ?? boundarySequence;

    return transcriptItemsPage(sessionId, pageItems, {
      hasMoreBefore: this.hasTopLevelTranscriptItemBefore(sessionId, firstSequence),
      hasMoreAfter: pageItems.length > 0
    });
  }

  listMessagesAfterPage(sessionId: string, afterSequence: number, limit: number): TranscriptPageResponse {
    const pageItems = this.scanTranscriptItemsForward(sessionId, afterSequence, limit, false);
    const lastSequence = pageItems.at(-1)?.lastSequence ?? afterSequence;

    return transcriptItemsPage(sessionId, pageItems, {
      hasMoreBefore: pageItems.length > 0,
      hasMoreAfter: this.hasMessageAfter(sessionId, lastSequence)
    });
  }

  listMessagesAround(sessionId: string, aroundSequence: number, limit: number): TranscriptPageResponse {
    const beforeLimit = Math.floor((limit - 1) / 2);
    const afterLimit = Math.max(0, limit - beforeLimit - 1);
    const beforeItems = this.scanExpandedItemsBackward(sessionId, aroundSequence, beforeLimit);
    const targetRows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE session_id = ? AND sequence = ?`
      )
      .all(sessionId, aroundSequence) as unknown as MessageRow[];
    const targetItems = buildExpandedTranscriptItems(targetRows.map(hydrateMessage));
    const afterItems = this.scanExpandedItemsForward(sessionId, aroundSequence, afterLimit);
    const items = [...beforeItems, ...targetItems, ...afterItems];
    const targetIndex = items.findIndex((item) => item.firstSequence <= aroundSequence && item.lastSequence >= aroundSequence);
    if (targetIndex < 0) {
      return transcriptItemsPage(sessionId, [], {
        hasMoreBefore: this.hasMessageBefore(sessionId, aroundSequence),
        hasMoreAfter: this.hasMessageAfter(sessionId, aroundSequence)
      });
    }

    let start = Math.max(0, targetIndex - beforeLimit);
    let end = Math.min(items.length, start + limit);
    start = Math.max(0, end - limit);
    const pageItems = items.slice(start, end);
    const firstSequence = pageItems[0]?.firstSequence ?? aroundSequence;
    const lastSequence = pageItems.at(-1)?.lastSequence ?? aroundSequence;

    return transcriptItemsPage(sessionId, pageItems, {
      hasMoreBefore: this.hasMessageBefore(sessionId, firstSequence),
      hasMoreAfter: this.hasMessageAfter(sessionId, lastSequence)
    });
  }

  private hasTopLevelTranscriptItemBefore(sessionId: string, sequence: number): boolean {
    const boundarySequence = this.transcriptBoundaryAnchorSequence(sessionId, sequence);
    return topLevelTranscriptItemCount(this.scanTranscriptItemsBackward(sessionId, boundarySequence, 1, "topLevel")) > 0;
  }

  private scanTranscriptItemsBackward(
    sessionId: string,
    beforeSequence: number,
    limit: number,
    countMode: "items" | "topLevel"
  ): TranscriptItem[] {
    if (limit <= 0) return [];
    let cursor = beforeSequence;
    let rows: MessageRow[] = [];
    while (true) {
      const batch = this.db
        .prepare(
          `SELECT * FROM messages
           WHERE session_id = ? AND sequence < ?
           ORDER BY sequence DESC
           LIMIT ?`
        )
        .all(sessionId, cursor, TRANSCRIPT_SCAN_CHUNK_SIZE) as unknown as MessageRow[];
      if (batch.length === 0) return selectTranscriptTail(buildTranscriptItems(rows.map(hydrateMessage)), limit, countMode);
      rows = [...batch.reverse(), ...rows];
      cursor = rows[0]!.sequence;
      const items = buildTranscriptItems(rows.map(hydrateMessage));
      const selected = selectTranscriptTail(items, limit, countMode);
      const enough = countMode === "topLevel"
        ? topLevelTranscriptItemCount(selected) >= limit
        : selected.length >= limit;
      const stableBoundary = selected.length > 0 && items[0] !== selected[0];
      if (batch.length < TRANSCRIPT_SCAN_CHUNK_SIZE || (enough && stableBoundary)) return selected;
    }
  }

  private scanTranscriptItemsBackwardWithin(sessionId: string, minimumSequence: number, limit: number): TranscriptItem[] {
    if (limit <= 0) return [];
    let cursor = Number.MAX_SAFE_INTEGER;
    let rows: MessageRow[] = [];
    while (true) {
      const batch = this.db
        .prepare(
          `SELECT * FROM messages
           WHERE session_id = ? AND sequence >= ? AND sequence < ?
           ORDER BY sequence DESC
           LIMIT ?`
        )
        .all(sessionId, minimumSequence, cursor, TRANSCRIPT_SCAN_CHUNK_SIZE) as unknown as MessageRow[];
      if (batch.length === 0) return activeTailPageItems(buildTranscriptItems(rows.map(hydrateMessage)), limit);
      rows = [...batch.reverse(), ...rows];
      cursor = rows[0]!.sequence;
      const items = buildTranscriptItems(rows.map(hydrateMessage));
      const selected = activeTailPageItems(items, limit);
      const enough = topLevelTranscriptItemCount(selected) >= limit;
      const stableBoundary = selected.length > 0 && items[0] !== selected[0];
      if (batch.length < TRANSCRIPT_SCAN_CHUNK_SIZE || (enough && stableBoundary)) return selected;
    }
  }

  private scanTranscriptItemsForward(sessionId: string, afterSequence: number, limit: number, expanded: boolean): TranscriptItem[] {
    if (limit <= 0) return [];
    let cursor = afterSequence;
    const rows: MessageRow[] = [];
    while (true) {
      const batch = this.db
        .prepare(
          `SELECT * FROM messages
           WHERE session_id = ? AND sequence > ?
           ORDER BY sequence ASC
           LIMIT ?`
        )
        .all(sessionId, cursor, TRANSCRIPT_SCAN_CHUNK_SIZE) as unknown as MessageRow[];
      if (batch.length === 0) return (expanded ? buildExpandedTranscriptItems : buildTranscriptItems)(rows.map(hydrateMessage)).slice(0, limit);
      rows.push(...batch);
      cursor = rows.at(-1)!.sequence;
      const items = (expanded ? buildExpandedTranscriptItems : buildTranscriptItems)(rows.map(hydrateMessage));
      const selected = items.slice(0, limit);
      const stableBoundary = selected.length >= limit && items.at(-1) !== selected.at(-1);
      if (batch.length < TRANSCRIPT_SCAN_CHUNK_SIZE || stableBoundary) return selected;
    }
  }

  private scanExpandedItemsBackward(sessionId: string, beforeSequence: number, limit: number): TranscriptItem[] {
    if (limit <= 0) return [];
    let cursor = beforeSequence;
    let rows: MessageRow[] = [];
    while (true) {
      const batch = this.db
        .prepare(
          `SELECT * FROM messages
           WHERE session_id = ? AND sequence < ?
           ORDER BY sequence DESC
           LIMIT ?`
        )
        .all(sessionId, cursor, TRANSCRIPT_SCAN_CHUNK_SIZE) as unknown as MessageRow[];
      if (batch.length === 0) return buildExpandedTranscriptItems(rows.map(hydrateMessage)).slice(-limit);
      rows = [...batch.reverse(), ...rows];
      cursor = rows[0]!.sequence;
      const items = buildExpandedTranscriptItems(rows.map(hydrateMessage));
      const selected = items.slice(-limit);
      if (batch.length < TRANSCRIPT_SCAN_CHUNK_SIZE || (selected.length >= limit && items[0] !== selected[0])) return selected;
    }
  }

  private scanExpandedItemsForward(sessionId: string, afterSequence: number, limit: number): TranscriptItem[] {
    return this.scanTranscriptItemsForward(sessionId, afterSequence, limit, true);
  }

  private hasMessageBefore(sessionId: string, sequence: number): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS found
         FROM messages
         WHERE session_id = ? AND sequence < ?
         LIMIT 1`
      )
      .get(sessionId, sequence) as { found: number } | undefined;
    return Boolean(row);
  }

  private hasMessageAfter(sessionId: string, sequence: number): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS found
         FROM messages
         WHERE session_id = ? AND sequence > ?
         LIMIT 1`
      )
      .get(sessionId, sequence) as { found: number } | undefined;
    return Boolean(row);
  }

  listMessageRange(sessionId: string, fromSequence: number, toSequence: number): TranscriptPageResponse {
    const start = Math.min(fromSequence, toSequence);
    const end = Math.max(fromSequence, toSequence);
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE session_id = ? AND sequence >= ? AND sequence <= ?
         ORDER BY sequence ASC`
      )
      .all(sessionId, start, end) as unknown as MessageRow[];

    return {
      sessionId,
      codexSessionId: null,
      codexJsonlPath: null,
      items: buildExpandedTranscriptItems(rows.map(hydrateMessage)),
      hasMoreBefore: false,
      hasMoreAfter: false
    };
  }

  searchMessages(sessionId: string, query: string, limit: number): TranscriptSearchResponse {
    const normalizedQuery = normalizeTranscriptSearchText(query);
    if (!normalizedQuery) {
      return {
        sessionId,
        codexSessionId: null,
        codexJsonlPath: null,
        query: "",
        matches: [],
        total: 0
      };
    }

    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE session_id = ?
         ORDER BY sequence ASC`
      )
      .all(sessionId) as unknown as MessageRow[];
    const matches = rows.flatMap((row) => {
      const message = hydrateMessage(row);
      const searchable = searchableTranscriptText(message);
      if (!normalizeTranscriptSearchText(searchable).includes(normalizedQuery)) return [];
      return [
        {
          sequence: message.sequence,
          messageId: message.id,
          itemId: message.id,
          firstSequence: message.sequence,
          lastSequence: message.sequence,
          role: message.role,
          type: message.type,
          timestamp: message.timestamp,
          preview: transcriptSearchPreview(searchable, query)
        }
      ];
    });

    return {
      sessionId,
      codexSessionId: null,
      codexJsonlPath: null,
      query: query.trim(),
      matches: matches.slice(0, limit),
      total: matches.length
    };
  }

  clearSessionTranscript(sessionId: string): void {
    this.recentUserPromptsCache.delete(sessionId);
    this.db.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId);
    this.db.prepare("DELETE FROM session_prompt_index WHERE session_id = ?").run(sessionId);
    this.db.prepare("DELETE FROM queued_inputs WHERE session_id = ?").run(sessionId);
    this.db
      .prepare(
        `UPDATE managed_sessions
         SET last_activity_at = NULL,
             preview = '',
             unread_count = 0
         WHERE id = ?`
      )
      .run(sessionId);
  }

  getGlobalModelSettings(): SessionModelSelections {
    return sessionModels(parseStoredJson<unknown>(this.getSetting(GLOBAL_MODEL_SETTINGS)));
  }

  setGlobalModelSettings(
    mode: CollaborationMode,
    model: string,
    reasoningEffort: string | null,
    updatedAt: string
  ): SessionModelSelections {
    const settings = withSessionModelSettings(this.getGlobalModelSettings(), mode, model, reasoningEffort);
    this.setSetting(GLOBAL_MODEL_SETTINGS, JSON.stringify(settings), updatedAt);
    return settings;
  }

  getApprovalReviewerSettings(): ApprovalReviewerSettings {
    const stored = parseStoredJson<unknown>(this.getSetting(APPROVAL_REVIEWER_SETTINGS));
    if (stored && typeof stored === "object" && !Array.isArray(stored)) {
      const value = stored as Record<string, unknown>;
      if (typeof value.model === "string" && value.model.trim()) {
        return {
          model: value.model,
          reasoningEffort: typeof value.reasoningEffort === "string" ? value.reasoningEffort : null
        };
      }
    }
    return { model: "gpt-5.6-luna", reasoningEffort: "low" };
  }

  setApprovalReviewerSettings(settings: ApprovalReviewerSettings, updatedAt: string): ApprovalReviewerSettings {
    this.setSetting(APPROVAL_REVIEWER_SETTINGS, JSON.stringify(settings), updatedAt);
    return settings;
  }

  getUnrestrictedRemoteAccessEnabled(): boolean {
    return this.getBooleanSetting(UNRESTRICTED_REMOTE_ACCESS_SETTING, false);
  }

  setUnrestrictedRemoteAccessEnabled(enabled: boolean): boolean {
    this.setBooleanSetting(UNRESTRICTED_REMOTE_ACCESS_SETTING, enabled);
    return enabled;
  }

  getNotificationSettings(deviceId: string): NotificationSettings {
    const normalizedDeviceId = normalizeNotificationDeviceId(deviceId);
    const rows = this.db
      .prepare("SELECT scope, session_id, type FROM notification_device_rules WHERE device_id = ? ORDER BY scope, session_id, type")
      .all(normalizedDeviceId) as unknown as NotificationRuleRow[];
    return notificationSettingsFromRows(rows, this.getNotificationDeliverySettings(normalizedDeviceId));
  }

  listNotificationSettings(): Record<string, NotificationSettings> {
    const rows = this.db
      .prepare("SELECT device_id, scope, session_id, type FROM notification_device_rules ORDER BY device_id, scope, session_id, type")
      .all() as unknown as NotificationRuleRow[];
    const settingsRows = this.db
      .prepare("SELECT device_id, push_enabled, sound_enabled FROM notification_device_settings ORDER BY device_id")
      .all() as unknown as NotificationDeviceSettingsRow[];
    const deviceIds = new Set<string>();
    for (const row of rows) if (row.device_id) deviceIds.add(row.device_id);
    for (const row of settingsRows) deviceIds.add(row.device_id);

    const rulesByDevice = new Map<string, NotificationRuleRow[]>();
    for (const row of rows) {
      const deviceId = row.device_id;
      if (!deviceId) continue;
      const deviceRows = rulesByDevice.get(deviceId) ?? [];
      deviceRows.push(row);
      rulesByDevice.set(deviceId, deviceRows);
    }
    const deliveryByDevice = new Map(settingsRows.map((row) => [row.device_id, notificationDeliverySettingsFromRow(row)]));
    const settings: Record<string, NotificationSettings> = {};
    for (const deviceId of deviceIds) {
      settings[deviceId] = notificationSettingsFromRows(rulesByDevice.get(deviceId) ?? [], deliveryByDevice.get(deviceId) ?? defaultNotificationDeliverySettings());
    }
    return settings;
  }

  setNotificationRule(
    deviceId: string,
    scope: NotificationRuleScope,
    sessionId: string | null,
    type: NotificationRuleType,
    enabled: boolean,
    updatedAt: string
  ): NotificationSettings {
    const normalizedDeviceId = normalizeNotificationDeviceId(deviceId);
    this.ensureNotificationDeviceSettings(normalizedDeviceId, updatedAt);
    const normalizedSessionId = scope === "global" ? "" : (sessionId ?? "");
    if (scope === "session" && !normalizedSessionId) throw new Error("Session notification rules require a session id");
    if (enabled) {
      this.db
        .prepare(
          `INSERT INTO notification_device_rules (device_id, scope, session_id, type, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(device_id, scope, session_id, type) DO UPDATE SET updated_at = excluded.updated_at`
        )
        .run(normalizedDeviceId, scope, normalizedSessionId, type, updatedAt);
    } else {
      this.db
        .prepare("DELETE FROM notification_device_rules WHERE device_id = ? AND scope = ? AND session_id = ? AND type = ?")
        .run(normalizedDeviceId, scope, normalizedSessionId, type);
    }
    return this.getNotificationSettings(normalizedDeviceId);
  }

  setNotificationDeliverySetting(
    deviceId: string,
    channel: NotificationDeliveryChannel,
    enabled: boolean,
    updatedAt: string
  ): NotificationSettings {
    const normalizedDeviceId = normalizeNotificationDeviceId(deviceId);
    this.ensureNotificationDeviceSettings(normalizedDeviceId, updatedAt);
    const column = channel === "push" ? "push_enabled" : "sound_enabled";
    this.db.prepare(`UPDATE notification_device_settings SET ${column} = ?, updated_at = ? WHERE device_id = ?`).run(enabled ? 1 : 0, updatedAt, normalizedDeviceId);
    return this.getNotificationSettings(normalizedDeviceId);
  }

  private getNotificationDeliverySettings(deviceId: string): NotificationDeliverySettings {
    const row = this.db
      .prepare("SELECT device_id, push_enabled, sound_enabled FROM notification_device_settings WHERE device_id = ?")
      .get(deviceId) as NotificationDeviceSettingsRow | undefined;
    return row ? notificationDeliverySettingsFromRow(row) : defaultNotificationDeliverySettings();
  }

  private ensureNotificationDeviceSettings(deviceId: string, updatedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO notification_device_settings (device_id, push_enabled, sound_enabled, updated_at)
         VALUES (?, 0, 1, ?)
         ON CONFLICT(device_id) DO NOTHING`
      )
      .run(deviceId, updatedAt);
  }

  upsertPushSubscription(deviceId: string, subscription: PushSubscriptionInput, updatedAt: string): void {
    const normalizedDeviceId = normalizeNotificationDeviceId(deviceId);
    this.ensureNotificationDeviceSettings(normalizedDeviceId, updatedAt);
    this.db
      .prepare(
        `INSERT INTO notification_push_subscriptions (device_id, endpoint, subscription_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(device_id, endpoint) DO UPDATE SET
          subscription_json = excluded.subscription_json,
          updated_at = excluded.updated_at`
      )
      .run(normalizedDeviceId, subscription.endpoint, JSON.stringify(subscription), updatedAt);
  }

  deletePushSubscription(deviceId: string, endpoint: string): void {
    const normalizedDeviceId = normalizeNotificationDeviceId(deviceId);
    this.db.prepare("DELETE FROM notification_push_subscriptions WHERE device_id = ? AND endpoint = ?").run(normalizedDeviceId, endpoint);
  }

  listPushSubscriptions(deviceId?: string): StoredPushSubscription[] {
    const normalizedDeviceId = deviceId ? normalizeNotificationDeviceId(deviceId) : null;
    const rows = normalizedDeviceId
      ? (this.db
          .prepare("SELECT device_id, endpoint, subscription_json FROM notification_push_subscriptions WHERE device_id = ? ORDER BY endpoint")
          .all(normalizedDeviceId) as unknown as PushSubscriptionRow[])
      : (this.db
          .prepare("SELECT device_id, endpoint, subscription_json FROM notification_push_subscriptions ORDER BY device_id, endpoint")
          .all() as unknown as PushSubscriptionRow[]);
    return rows.map((row) => ({ ...(JSON.parse(row.subscription_json) as PushSubscriptionInput), deviceId: row.device_id ?? "" }));
  }

  getPushVapidKeys(): PushVapidKeys | null {
    const value = this.getSetting(PUSH_VAPID_KEYS_SETTING);
    return value ? (JSON.parse(value) as PushVapidKeys) : null;
  }

  setPushVapidKeys(keys: PushVapidKeys, updatedAt: string): PushVapidKeys {
    this.setSetting(PUSH_VAPID_KEYS_SETTING, JSON.stringify(keys), updatedAt);
    return keys;
  }

  getSessionRecoveryRuntime(): SessionRecoveryRuntimeState | null {
    return parseStoredJson<SessionRecoveryRuntimeState>(this.getSetting(SESSION_RECOVERY_RUNTIME_SETTING));
  }

  setSessionRecoveryRuntime(state: SessionRecoveryRuntimeState): void {
    this.setSetting(SESSION_RECOVERY_RUNTIME_SETTING, JSON.stringify(state), state.updatedAt);
  }

  getSessionRecoveryIncident(): SessionRecoveryIncident | null {
    return parseStoredJson<SessionRecoveryIncident>(this.getSetting(SESSION_RECOVERY_INCIDENT_SETTING));
  }

  setSessionRecoveryIncident(incident: SessionRecoveryIncident | null, updatedAt: string): void {
    this.setSetting(SESSION_RECOVERY_INCIDENT_SETTING, JSON.stringify(incident), updatedAt);
  }

  private getBooleanSetting(key: string, defaultValue: boolean): boolean {
    const value = this.getSetting(key);
    if (value === null) return defaultValue;
    return value === "true";
  }

  private setBooleanSetting(key: string, enabled: boolean): void {
    this.setSetting(key, enabled ? "true" : "false", new Date().toISOString());
  }

  private getSetting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  private setSetting(key: string, value: string, updatedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
          value=excluded.value,
          updated_at=excluded.updated_at`
      )
      .run(key, value, updatedAt);
  }

  latestApprovalMessage(sessionId: string): ChatMessage | null {
    const row = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE session_id = ? AND type = 'approval_request'
         ORDER BY sequence DESC
         LIMIT 1`
      )
      .get(sessionId) as MessageRow | undefined;

    if (!row) return null;
    return {
      id: row.id,
      sessionId: row.session_id,
      sequence: row.sequence,
      type: row.type as ChatMessage["type"],
      role: row.role as ChatMessage["role"],
      timestamp: row.timestamp,
      text: row.text,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>
    };
  }

  latestQuestionMessage(sessionId: string, appServerRequestOnly = false): ChatMessage | null {
    const row = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE session_id = ? AND type = 'question_request'
           AND (? = 0 OR (
             json_extract(payload_json, '$.source') = 'codex_app_server'
             AND json_extract(payload_json, '$.method') = 'item/tool/requestUserInput'
           ))
         ORDER BY sequence DESC
         LIMIT 1`
      )
      .get(sessionId, appServerRequestOnly ? 1 : 0) as MessageRow | undefined;

    if (!row) return null;
    return hydrateMessage(row);
  }

  latestQuestionAnswerMessage(sessionId: string, questionId: string, afterSequence: number): ChatMessage | null {
    if (!questionId) return null;
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE session_id = ?
           AND sequence > ?
           AND role = 'tool'
           AND type IN ('tool_output', 'command_output')
         ORDER BY sequence DESC`
      )
      .all(sessionId, afterSequence) as unknown as MessageRow[];
    const row = rows.find((candidate) => isQuestionAnswerOutput(candidate, questionId));
    return row ? hydrateMessage(row) : null;
  }

  listQueuedInputs(sessionId: string): QueuedInput[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM queued_inputs
         WHERE session_id = ?
         ORDER BY created_at ASC, id ASC`
      )
      .all(sessionId) as unknown as QueuedInputRow[];

    return rows.map(hydrateQueuedInput);
  }

  getQueuedInput(sessionId: string, queuedInputId: string): QueuedInput | null {
    const row = this.db
      .prepare("SELECT * FROM queued_inputs WHERE session_id = ? AND id = ?")
      .get(sessionId, queuedInputId) as QueuedInputRow | undefined;
    return row ? hydrateQueuedInput(row) : null;
  }

  appendQueuedInput(input: QueuedInput): void {
    this.db
      .prepare(
        `INSERT INTO queued_inputs
          (id, session_id, text, content_json, mode, status, error, codex_session_id, codex_jsonl_path, actor_session_id, created_at, updated_at, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.id,
        input.sessionId,
        input.text,
        input.content ? JSON.stringify(input.content) : null,
        input.mode,
        input.status,
        input.error,
        input.codexSessionId,
        input.codexJsonlPath,
        input.actorSessionId,
        input.createdAt,
        input.updatedAt,
        input.sentAt
      );
  }

  upsertAppServerRequest(request: ReceivedAppServerRequest): PersistedAppServerRequest {
    validateAppServerRequest(request);
    const requestIdJson = appServerRequestIdJson(request.requestId);
    const paramsJson = serializeAppServerJson(request.params, "params");
    const existing = this.db.prepare(
      "SELECT * FROM app_server_requests WHERE session_id = ? AND request_id_json = ?"
    ).get(request.sessionId, requestIdJson) as AppServerRequestRow | undefined;
    if (existing && !sameAppServerRequest(existing, request)) {
      this.db.prepare(
        `UPDATE app_server_requests
         SET method = ?, params_json = ?, thread_id = ?, turn_id = ?, state = 'pending', response_json = NULL,
             received_at = ?, last_seen_at = ?, responded_at = NULL, resolved_at = NULL
         WHERE session_id = ? AND request_id_json = ?`
      ).run(
        request.method,
        paramsJson,
        request.threadId,
        request.turnId,
        request.receivedAt,
        request.lastSeenAt,
        request.sessionId,
        requestIdJson
      );
      return this.requireAppServerRequest(request.sessionId, request.requestId);
    }
    this.db.prepare(
      `INSERT INTO app_server_requests
        (session_id, request_id_json, method, params_json, thread_id, turn_id, state, response_json,
         received_at, last_seen_at, responded_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, NULL, NULL)
       ON CONFLICT(session_id, request_id_json) DO UPDATE SET
        method=excluded.method,
        params_json=excluded.params_json,
        thread_id=excluded.thread_id,
        turn_id=excluded.turn_id,
        last_seen_at=excluded.last_seen_at`
    ).run(
      request.sessionId,
      requestIdJson,
      request.method,
      paramsJson,
      request.threadId,
      request.turnId,
      request.receivedAt,
      request.lastSeenAt
    );
    return this.requireAppServerRequest(request.sessionId, request.requestId);
  }

  listUnresolvedAppServerRequests(sessionId: string): PersistedAppServerRequest[] {
    const rows = this.db.prepare(
      `SELECT * FROM app_server_requests
       WHERE session_id = ? AND state != 'resolved'
       ORDER BY received_at ASC, request_id_json ASC`
    ).all(sessionId) as unknown as AppServerRequestRow[];
    return rows.map(hydrateAppServerRequest);
  }

  claimAppServerRequestResponse(
    sessionId: string,
    requestId: string | number,
    response: unknown,
    respondedAt: string
  ): PersistedAppServerRequest | null {
    const result = this.db.prepare(
      `UPDATE app_server_requests
       SET state = 'responded', response_json = ?, responded_at = ?
       WHERE session_id = ? AND request_id_json = ? AND state = 'pending'`
    ).run(serializeAppServerJson(response, "response"), respondedAt, sessionId, appServerRequestIdJson(requestId));
    return result.changes === 1 ? this.requireAppServerRequest(sessionId, requestId) : null;
  }

  resolveAppServerRequest(sessionId: string, requestId: string | number, resolvedAt: string): boolean {
    const pending = this.db.prepare(
      "SELECT * FROM app_server_requests WHERE session_id = ? AND request_id_json = ? AND state = 'pending'"
    ).get(sessionId, appServerRequestIdJson(requestId)) as AppServerRequestRow | undefined;
    const result = this.db.prepare(
      `UPDATE app_server_requests
       SET state = 'resolved', resolved_at = ?
       WHERE session_id = ? AND request_id_json = ? AND state != 'resolved'`
    ).run(resolvedAt, sessionId, appServerRequestIdJson(requestId));
    if (result.changes === 1 && pending) this.recordClosedInteraction(hydrateAppServerRequest(pending), resolvedAt);
    return result.changes === 1;
  }

  resolveAppServerTurnRequests(sessionId: string, threadId: string, turnId: string, resolvedAt: string): number {
    const pending = this.db.prepare(
      `SELECT * FROM app_server_requests
       WHERE session_id = ? AND thread_id = ? AND turn_id = ? AND state = 'pending'`
    ).all(sessionId, threadId, turnId) as unknown as AppServerRequestRow[];
    const result = this.db.prepare(
      `UPDATE app_server_requests
       SET state = 'resolved', resolved_at = ?
       WHERE session_id = ? AND thread_id = ? AND turn_id = ? AND state != 'resolved'`
    ).run(resolvedAt, sessionId, threadId, turnId);
    for (const request of pending) this.recordClosedInteraction(hydrateAppServerRequest(request), resolvedAt);
    return Number(result.changes);
  }

  private recordClosedInteraction(request: PersistedAppServerRequest, resolvedAt: string): void {
    const rows = this.db.prepare(
      `SELECT * FROM messages
       WHERE session_id = ? AND type IN ('approval_request', 'question_request')`
    ).all(request.sessionId) as unknown as MessageRow[];
    for (const row of rows) {
      const message = hydrateMessage(row);
      const identity = recordValue(message.payload.appServerIdentity);
      const detail = recordValue(message.payload.approval) ?? recordValue(message.payload.question);
      if (identity?.threadId !== request.threadId || identity?.turnId !== request.turnId || detail?.requestId !== request.requestId) continue;
      if (message.payload.interactionOutcome) return;
      const kind = message.type === "approval_request" ? "approval" : "question";
      this.updateMessagePayload(message, {
        ...message.payload,
        interactionOutcome: { kind, status: "closed", submittedAt: resolvedAt }
      });
      return;
    }
  }

  applyAppServerProjection(projection: AppServerProjectionInput): AppServerProjectionResult {
    validateAppServerProjection(projection);
    const existingSession = this.db.prepare("SELECT status, data_json FROM managed_sessions WHERE id = ?")
      .get(projection.sessionId) as Pick<SessionRow, "status" | "data_json"> | undefined;
    if (!existingSession) throw new Error(`App-server projection session does not exist: ${projection.sessionId}`);
    const evidenceJson = serializeAppServerJson(projection.evidence, "projection evidence");
    let message: ChatMessage | null = null;
    let messageInserted = false;
    let messageChanged = false;
    const statusChanged = projection.status !== null && existingSession.status !== projection.status;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (projection.message) {
        const write = this.writeMessage({
          ...projection.message,
          sessionId: projection.sessionId,
          sequence: this.nextSequence(projection.sessionId)
        });
        message = write.message;
        messageInserted = write.inserted;
        messageChanged = write.changed;
      }
      if (projection.status !== null) {
        const sessionData = JSON.parse(existingSession.data_json) as Record<string, unknown>;
        this.db.prepare(
          "UPDATE managed_sessions SET status = ?, data_json = ?, updated_at = ? WHERE id = ?"
        ).run(
          projection.status,
          JSON.stringify({ ...sessionData, status: projection.status }),
          projection.observedAt,
          projection.sessionId
        );
      }
      this.db.prepare(
        `INSERT INTO app_server_reconciliation
          (session_id, thread_id, turn_id, item_id, client_message_id, method, status, evidence_json, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
          thread_id=excluded.thread_id,
          turn_id=excluded.turn_id,
          item_id=excluded.item_id,
          client_message_id=excluded.client_message_id,
          method=excluded.method,
          status=COALESCE(excluded.status, app_server_reconciliation.status),
          evidence_json=excluded.evidence_json,
          observed_at=excluded.observed_at`
      ).run(
        projection.sessionId,
        projection.threadId,
        projection.turnId,
        projection.itemId,
        projection.clientMessageId,
        projection.method,
        projection.status,
        evidenceJson,
        projection.observedAt
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    const state = this.getAppServerReconciliationState(projection.sessionId);
    if (!state) throw new Error(`App-server projection state was not persisted: ${projection.sessionId}`);
    return { message: messageChanged ? message : null, messageInserted, messageChanged, statusChanged, state };
  }

  getAppServerReconciliationState(sessionId: string): AppServerReconciliationState | null {
    const row = this.db.prepare("SELECT * FROM app_server_reconciliation WHERE session_id = ?")
      .get(sessionId) as AppServerReconciliationRow | undefined;
    return row ? hydrateAppServerReconciliation(row) : null;
  }

  repairAppServerProjectionThread(sessionId: string, threadId: string): AppServerProjectionRepairResult {
    if (!sessionId.trim() || !threadId.trim()) throw new Error("App-server projection repair requires session and thread identity");
    const foreignMessages = this.db.prepare(
      `SELECT messages.id, messages.role
       FROM messages
       JOIN codex_item_messages ON codex_item_messages.message_id = messages.id
       WHERE codex_item_messages.session_id = ? AND codex_item_messages.thread_id != ?`
    ).all(sessionId, threadId) as unknown as Array<Pick<MessageRow, "id" | "role">>;
    const reconciliation = this.db.prepare(
      "SELECT thread_id FROM app_server_reconciliation WHERE session_id = ?"
    ).get(sessionId) as { thread_id: string } | undefined;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const message of foreignMessages) {
        this.deletePromptIndexMessage(message.id);
        this.db.prepare("DELETE FROM messages WHERE id = ? AND session_id = ?").run(message.id, sessionId);
      }
      if (foreignMessages.some((message) => message.role === "user")) this.recentUserPromptsCache.delete(sessionId);
      const processesRemoved = Number(this.db.prepare(
        "DELETE FROM app_server_command_processes WHERE session_id = ? AND thread_id != ?"
      ).run(sessionId, threadId).changes);
      const reconciliationReset = reconciliation !== undefined && reconciliation.thread_id !== threadId;
      if (reconciliationReset) {
        this.db.prepare("DELETE FROM app_server_reconciliation WHERE session_id = ?").run(sessionId);
      }
      this.db.exec("COMMIT");
      return { messagesRemoved: foreignMessages.length, processesRemoved, reconciliationReset };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  upsertAppServerCommandProcess(process: AppServerCommandProcess): void {
    validateAppServerCommandProcess(process);
    this.db.prepare(
      `INSERT INTO app_server_command_processes
        (session_id, thread_id, turn_id, item_id, process_id, observed_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, thread_id, item_id) DO UPDATE SET
        turn_id=excluded.turn_id,
        process_id=excluded.process_id,
        observed_at=excluded.observed_at`
    ).run(process.sessionId, process.threadId, process.turnId, process.itemId, process.processId, process.observedAt);
  }

  removeAppServerCommandProcess(sessionId: string, threadId: string, itemId: string, processId: string): boolean {
    const result = this.db.prepare(
      `DELETE FROM app_server_command_processes
       WHERE session_id = ? AND thread_id = ? AND item_id = ? AND process_id = ?`
    ).run(sessionId, threadId, itemId, processId);
    return result.changes === 1;
  }

  removeAppServerTurnCommandProcesses(sessionId: string, threadId: string, turnId: string): number {
    return Number(this.db.prepare(
      `DELETE FROM app_server_command_processes WHERE session_id = ? AND thread_id = ? AND turn_id = ?`
    ).run(sessionId, threadId, turnId).changes);
  }

  clearAppServerCommandProcesses(sessionId: string): number {
    return Number(this.db.prepare(
      "DELETE FROM app_server_command_processes WHERE session_id = ?"
    ).run(sessionId).changes);
  }

  listAppServerCommandProcesses(sessionId: string, threadId: string): AppServerCommandProcess[] {
    const rows = this.db.prepare(
      `SELECT * FROM app_server_command_processes
       WHERE session_id = ? AND thread_id = ? ORDER BY observed_at, item_id`
    ).all(sessionId, threadId) as unknown as AppServerCommandProcessRow[];
    return rows.map((row) => ({
      sessionId: row.session_id,
      threadId: row.thread_id,
      turnId: row.turn_id,
      itemId: row.item_id,
      processId: row.process_id,
      observedAt: row.observed_at
    }));
  }

  private requireAppServerRequest(sessionId: string, requestId: string | number): PersistedAppServerRequest {
    const row = this.db.prepare(
      "SELECT * FROM app_server_requests WHERE session_id = ? AND request_id_json = ?"
    ).get(sessionId, appServerRequestIdJson(requestId)) as AppServerRequestRow | undefined;
    if (!row) throw new Error(`App-server request was not persisted: ${sessionId}`);
    return hydrateAppServerRequest(row);
  }

  updateQueuedInput(input: QueuedInput): void {
    this.db
      .prepare(
        `UPDATE queued_inputs
         SET text = ?,
             content_json = ?,
             mode = ?,
             status = ?,
             error = ?,
             codex_session_id = ?,
             codex_jsonl_path = ?,
             actor_session_id = ?,
             updated_at = ?,
             sent_at = ?
         WHERE session_id = ? AND id = ?`
      )
      .run(
        input.text,
        input.content ? JSON.stringify(input.content) : null,
        input.mode,
        input.status,
        input.error,
        input.codexSessionId,
        input.codexJsonlPath,
        input.actorSessionId,
        input.updatedAt,
        input.sentAt,
        input.sessionId,
        input.id
      );
  }

  deleteQueuedInput(sessionId: string, queuedInputId: string): void {
    this.db.prepare("DELETE FROM queued_inputs WHERE session_id = ? AND id = ?").run(sessionId, queuedInputId);
  }

  deleteEchoedSentQueuedInputs(sessionId: string): number {
    const rows = this.db
      .prepare("SELECT * FROM queued_inputs WHERE session_id = ? AND status = 'sent'")
      .all(sessionId) as unknown as QueuedInputRow[];
    let deleted = 0;

    for (const row of rows) {
      const exactMatch = this.db
        .prepare(
          `SELECT 1 AS found
           FROM messages
           WHERE session_id = ?
             AND role = 'user'
             AND text = ?
             AND timestamp >= ?
           LIMIT 1`
        )
        .get(sessionId, row.text, row.created_at) as { found: number } | undefined;
      if (!exactMatch && !this.hasNormalizedQueuedInputEcho(sessionId, row)) continue;
      this.deleteQueuedInput(sessionId, row.id);
      deleted += 1;
    }

    return deleted;
  }

  private hasNormalizedQueuedInputEcho(sessionId: string, row: QueuedInputRow): boolean {
    const queuedFingerprint = queuedInputEchoFingerprint(row.text);
    if (!queuedFingerprint) return false;
    const candidates = this.db
      .prepare(
        `SELECT text, timestamp
         FROM messages
         WHERE session_id = ?
           AND role = 'user'
           AND timestamp >= ?
         ORDER BY timestamp ASC`
      )
      .all(sessionId, row.created_at) as unknown as QueuedInputEchoCandidateRow[];
    return candidates.some((candidate) => queuedInputEchoFingerprint(candidate.text) === queuedFingerprint);
  }

  nextSequence(sessionId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM messages WHERE session_id = ?")
      .get(sessionId) as { next: number };
    return row.next;
  }

  getParserOffset(source: string): number {
    const row = this.db.prepare("SELECT byte_offset FROM parser_offsets WHERE source = ?").get(source) as { byte_offset: number } | undefined;
    return row?.byte_offset ?? 0;
  }

  listParserOffsets(): Record<string, number> {
    const rows = this.db.prepare("SELECT source, byte_offset FROM parser_offsets").all() as unknown as Array<{
      source: string;
      byte_offset: number;
    }>;
    return Object.fromEntries(rows.map((row) => [row.source, row.byte_offset]));
  }

  hasParserOffset(source: string): boolean {
    const row = this.db.prepare("SELECT 1 AS found FROM parser_offsets WHERE source = ?").get(source) as { found: number } | undefined;
    return Boolean(row);
  }

  setParserOffset(source: string, offset: number, parserVersion: string, updatedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO parser_offsets (source, byte_offset, parser_version, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(source) DO UPDATE SET
          byte_offset=excluded.byte_offset,
          parser_version=excluded.parser_version,
          updated_at=excluded.updated_at`
      )
      .run(source, offset, parserVersion, updatedAt);
  }

  resetParserOffset(source: string): void {
    this.db.prepare("DELETE FROM parser_offsets WHERE source = ?").run(source);
  }

  addAudit(actor: string, action: string, target: string, result: string, timestamp: string): void {
    this.db
      .prepare("INSERT INTO audit_log (actor, action, target, result, timestamp) VALUES (?, ?, ?, ?, ?)")
      .run(actor, action, target, result, timestamp);
  }

  private recentRestorableSessionHistory(limit: number): SessionHistoryResult[] {
    return this.listSessions(true)
      .filter((session) => Boolean(session.codexSessionId))
      .slice(0, limit)
      .map((session) => sessionHistoryResultFromSession(
        session,
        session.recentUserPrompts.map((text, index) => ({
          sequence: Math.max(0, session.transcriptSize - index),
          timestamp: session.lastActivityAt ?? "",
          text
        })),
        this.getGitWorkspaceBySession(session.id)?.summary ?? null
      ));
  }

  private upsertPromptIndexMessage(message: ChatMessage): void {
    if (message.role !== "user" || isAgentAuthoredMessage(message) || !isDisplayableUserPromptText(message.text)) return;
    this.deletePromptIndexMessage(message.id);
    this.db
      .prepare(
        `INSERT INTO session_prompt_index (text, message_id, session_id, sequence, timestamp)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(message.text, message.id, message.sessionId, message.sequence, message.timestamp);
  }

  private deletePromptIndexMessage(messageId: string): void {
    this.db.prepare("DELETE FROM session_prompt_index WHERE message_id = ?").run(messageId);
  }

  private hydrateSession(row: SessionRow): ManagedSession {
    const session = JSON.parse(row.data_json) as ManagedSession;
    const gitWorkspace = normalizeGitWorkspaceSummary(session.gitWorkspace);
    const recentUserPrompts = this.recentUserPrompts(row.id);
    return {
      ...session,
      repo: gitWorkspace ? { ...session.repo, branch: gitWorkspace.targetBranch } : session.repo,
      status: row.status,
      initializing: session.initializing === true,
      startupError: typeof session.startupError === "string" ? session.startupError : null,
      lastActivityAt: row.last_activity_at ?? this.latestMessageAt(row.id),
      preview: recentUserPrompts[0] ?? "",
      recentUserPrompts,
      approvalMode: approvalMode(session.approvalMode),
      inputMode: collaborationMode(session.inputMode) ?? "default",
      models: sessionModels(session.models),
      fastMode: typeof session.fastMode === "boolean" ? session.fastMode : null,
      fastModeAvailable: typeof session.fastModeAvailable === "boolean" ? session.fastModeAvailable : null,
      transcriptSize: this.messageCount(row.id),
      transcriptSyncing: session.transcriptSyncing === true,
      unreadCount: row.unread_count,
      pinned: session.pinned === true,
      archived: row.archived === 1,
      gitWorkspace
    };
  }

  private recentUserPrompts(sessionId: string): string[] {
    const cached = this.recentUserPromptsCache.get(sessionId);
    if (cached) return cached;
    // session_id is intentionally UNINDEXED in the FTS table; use the message index and stop after two prompts.
    const rows = this.db
      .prepare(
        `SELECT text, payload_json FROM messages
         WHERE session_id = ? AND role = 'user'
         ORDER BY sequence DESC`
      )
      .iterate(sessionId) as unknown as Iterable<Pick<MessageRow, "text" | "payload_json">>;
    const prompts: string[] = [];
    for (const row of rows) {
      if (isAgentAuthoredPayload(row.payload_json)) continue;
      if (!isDisplayableUserPromptText(row.text)) continue;
      const text = normalizePreviewText(row.text);
      if (text) prompts.push(text);
      if (prompts.length === 2) break;
    }
    this.recentUserPromptsCache.set(sessionId, prompts);
    return prompts;
  }

  private latestMessageAt(sessionId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT timestamp
         FROM messages
         WHERE session_id = ?
         ORDER BY sequence DESC
         LIMIT 1`
      )
      .get(sessionId) as Pick<MessageRow, "timestamp"> | undefined;

    return row?.timestamp ?? null;
  }

  private messageCount(sessionId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM messages WHERE session_id = ?")
      .get(sessionId) as { count: number } | undefined;

    return row?.count ?? 0;
  }

  private migrate(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS managed_sessions (
        id TEXT PRIMARY KEY,
        data_json TEXT NOT NULL,
        status TEXT NOT NULL,
        last_activity_at TEXT,
        preview TEXT NOT NULL DEFAULT '',
        unread_count INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        role TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        text TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        UNIQUE(session_id, sequence),
        FOREIGN KEY(session_id) REFERENCES managed_sessions(id) ON DELETE CASCADE
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS session_prompt_index USING fts5(
        text,
        message_id UNINDEXED,
        session_id UNINDEXED,
        sequence UNINDEXED,
        timestamp UNINDEXED,
        tokenize = 'unicode61'
      );

      CREATE TABLE IF NOT EXISTS parser_offsets (
        source TEXT PRIMARY KEY,
        byte_offset INTEGER NOT NULL,
        parser_version TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        session_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        timestamp TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT NOT NULL,
        result TEXT NOT NULL,
        timestamp TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS queued_inputs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        text TEXT NOT NULL,
        content_json TEXT,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        codex_session_id TEXT,
        codex_jsonl_path TEXT,
        actor_session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sent_at TEXT,
        FOREIGN KEY(session_id) REFERENCES managed_sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS app_server_requests (
        session_id TEXT NOT NULL,
        request_id_json TEXT NOT NULL,
        method TEXT NOT NULL,
        params_json TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending', 'responded', 'resolved')),
        response_json TEXT,
        received_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        responded_at TEXT,
        resolved_at TEXT,
        PRIMARY KEY(session_id, request_id_json),
        FOREIGN KEY(session_id) REFERENCES managed_sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS app_server_reconciliation (
        session_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        turn_id TEXT,
        item_id TEXT,
        client_message_id TEXT,
        method TEXT NOT NULL,
        status TEXT,
        evidence_json TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES managed_sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS app_server_command_processes (
        session_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        process_id TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        PRIMARY KEY(session_id, thread_id, item_id),
        FOREIGN KEY(session_id) REFERENCES managed_sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS codex_item_messages (
        session_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        app_server_message_id TEXT,
        rollout_message_id TEXT,
        app_server_observed_at TEXT,
        rollout_observed_at TEXT,
        PRIMARY KEY(session_id, thread_id, turn_id, item_id),
        UNIQUE(message_id),
        FOREIGN KEY(session_id) REFERENCES managed_sessions(id) ON DELETE CASCADE,
        FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS btw_exchanges (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        question TEXT NOT NULL,
        answer TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        first_token_at TEXT,
        completed_at TEXT,
        document_operation_json TEXT,
        FOREIGN KEY(session_id) REFERENCES managed_sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS agent_session_waits (
        actor_session_id TEXT PRIMARY KEY,
        wait_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(actor_session_id) REFERENCES managed_sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS notification_rules (
        scope TEXT NOT NULL,
        session_id TEXT NOT NULL DEFAULT '',
        type TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(scope, session_id, type)
      );

      CREATE TABLE IF NOT EXISTS push_subscriptions (
        endpoint TEXT PRIMARY KEY,
        subscription_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS notification_device_settings (
        device_id TEXT PRIMARY KEY,
        push_enabled INTEGER NOT NULL DEFAULT 0,
        sound_enabled INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS notification_device_rules (
        device_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        session_id TEXT NOT NULL DEFAULT '',
        type TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(device_id, scope, session_id, type),
        FOREIGN KEY(device_id) REFERENCES notification_device_settings(device_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS notification_push_subscriptions (
        device_id TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        subscription_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(device_id, endpoint),
        FOREIGN KEY(device_id) REFERENCES notification_device_settings(device_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS session_repositories (
        path TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        repo_root TEXT,
        branch TEXT,
        last_activity_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS dismissed_session_directories (
        path TEXT PRIMARY KEY,
        dismissed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS git_workspaces (
        id TEXT PRIMARY KEY,
        session_id TEXT UNIQUE,
        data_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS repository_approval_rules (
        common_git_dir TEXT NOT NULL,
        prefix_rule_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(common_git_dir, prefix_rule_json)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session_sequence ON messages(session_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_messages_role_timestamp ON messages(role, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_sessions_activity ON managed_sessions(last_activity_at);
      CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_queued_inputs_session_status ON queued_inputs(session_id, status, created_at);
      CREATE INDEX IF NOT EXISTS idx_app_server_requests_session_state ON app_server_requests(session_id, state, received_at);
      CREATE INDEX IF NOT EXISTS idx_btw_exchanges_session_created ON btw_exchanges(session_id, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_btw_exchanges_one_running ON btw_exchanges(session_id) WHERE status = 'running';
      CREATE INDEX IF NOT EXISTS idx_notification_rules_session ON notification_rules(session_id);
      CREATE INDEX IF NOT EXISTS idx_notification_device_rules_session ON notification_device_rules(session_id);
      CREATE INDEX IF NOT EXISTS idx_notification_push_subscriptions_endpoint ON notification_push_subscriptions(endpoint);
      CREATE INDEX IF NOT EXISTS idx_session_repositories_activity ON session_repositories(COALESCE(last_activity_at, updated_at));
      CREATE INDEX IF NOT EXISTS idx_git_workspaces_session ON git_workspaces(session_id);
    `);
    this.db.exec("DROP TABLE IF EXISTS session_summaries; DROP TABLE IF EXISTS openai_usage_events;");
    this.db.prepare("DELETE FROM app_settings WHERE key = 'activity_summaries_enabled'").run();
    this.addColumnIfMissing("queued_inputs", "actor_session_id", "TEXT");
    this.addColumnIfMissing("queued_inputs", "content_json", "TEXT");
    this.addColumnIfMissing("btw_exchanges", "document_operation_json", "TEXT");
    this.removePersistedContextGuards();
    this.normalizePersistedSessionWaitMessages();
    this.removeDuplicateAppServerQuestionMessages();
    this.removeDuplicateAppServerPlanMessages();
    this.removeDuplicateImageSubmissionEchoes();
    this.backfillInteractionOutcomes();
    this.backfillPromptIndexIfNeeded();
    this.backfillSessionRepositories();
  }

  private backfillPromptIndexIfNeeded(): void {
    if (this.getSetting(PROMPT_INDEX_BACKFILLED_SETTING) === "true") return;
    this.db.prepare("DELETE FROM session_prompt_index").run();
    const rows = this.db
      .prepare(
        `SELECT *
         FROM messages
         WHERE role = 'user'
           AND text <> ''
         ORDER BY session_id ASC, sequence ASC`
      )
      .all() as unknown as MessageRow[];
    for (const row of rows) this.upsertPromptIndexMessage(hydrateMessage(row));
    this.setSetting(PROMPT_INDEX_BACKFILLED_SETTING, "true", new Date().toISOString());
  }

  private removePersistedContextGuards(): void {
    const rows = this.db.prepare("SELECT id, data_json, status FROM managed_sessions").all() as unknown as Array<Pick<SessionRow, "id" | "data_json" | "status">>;
    const update = this.db.prepare("UPDATE managed_sessions SET data_json = ?, status = ? WHERE id = ?");
    for (const row of rows) {
      const session = JSON.parse(row.data_json) as ManagedSession;
      const ownership = session.agentOwnership as (AgentSessionOwnership & Record<string, unknown>) | null | undefined;
      if (!ownership || (!("contextPausedAt" in ownership) && !("highContextApprovedAt" in ownership))) continue;
      const wasContextPaused = typeof ownership.contextPausedAt === "string" && ownership.contextPausedAt.length > 0;
      delete ownership.contextPausedAt;
      delete ownership.highContextApprovedAt;
      const status = wasContextPaused && !ownership.budgetExhaustedAt && row.status === "blocked" ? "waiting" : row.status;
      session.status = status;
      update.run(JSON.stringify(session), status, row.id);
    }
  }

  private normalizePersistedSessionWaitMessages(): void {
    const queuedRows = this.db
      .prepare("SELECT id, text FROM queued_inputs WHERE LTRIM(text) LIKE '<muxpilot_session_wait>%'")
      .all() as unknown as Array<{ id: string; text: string }>;
    const rawRows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE role = 'user' AND LTRIM(text) LIKE '<muxpilot_session_wait>%'
         ORDER BY session_id, sequence`
      )
      .all() as unknown as MessageRow[];
    if (queuedRows.length === 0 && rawRows.length === 0) return;
    const systemRows = this.db
      .prepare("SELECT * FROM messages WHERE role = 'system' AND type = 'status'")
      .all() as unknown as MessageRow[];
    const deletedBySession = new Map<string, number>();

    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of queuedRows) {
        if (normalizeSessionWaitEvent(row.text)) this.db.prepare("DELETE FROM queued_inputs WHERE id = ?").run(row.id);
      }
      for (const row of rawRows) {
        const normalized = normalizeSessionWaitEvent(row.text);
        if (!normalized) continue;
        const duplicate = systemRows.some((candidate) => {
          if (candidate.session_id !== row.session_id || !timestampsAreNear(candidate.timestamp, row.timestamp)) return false;
          try {
            const event = sessionWaitEventFromPayload(JSON.parse(candidate.payload_json) as Record<string, unknown>);
            return event !== null && JSON.stringify(event) === JSON.stringify(normalized.event);
          } catch {
            return false;
          }
        });
        this.deletePromptIndexMessage(row.id);
        if (duplicate) {
          this.db.prepare("DELETE FROM messages WHERE id = ?").run(row.id);
          deletedBySession.set(row.session_id, (deletedBySession.get(row.session_id) ?? 0) + 1);
          continue;
        }
        let payload: Record<string, unknown> = {};
        try { payload = JSON.parse(row.payload_json) as Record<string, unknown>; } catch { /* Preserve a valid event even if its old wrapper payload is malformed. */ }
        this.db
          .prepare("UPDATE messages SET type = 'status', role = 'system', text = ?, payload_json = ? WHERE id = ?")
          .run(sessionWaitEventSummary(normalized.event), JSON.stringify(withSessionWaitEventPayload(payload, normalized)), row.id);
        systemRows.push({
          ...row,
          type: "status",
          role: "system",
          text: sessionWaitEventSummary(normalized.event),
          payload_json: JSON.stringify(withSessionWaitEventPayload(payload, normalized))
        });
      }
      for (const [sessionId, deleted] of deletedBySession) {
        this.db.prepare("UPDATE managed_sessions SET unread_count = MAX(0, unread_count - ?) WHERE id = ?").run(deleted, sessionId);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private removeDuplicateAppServerQuestionMessages(): void {
    const rows = this.db.prepare(
      `SELECT DISTINCT rollout.message_id, rollout.session_id
       FROM codex_item_messages AS rollout
       JOIN messages AS rollout_message ON rollout_message.id = rollout.message_id
       JOIN messages AS app_server_message
         ON app_server_message.session_id = rollout.session_id
        AND app_server_message.type = 'question_request'
        AND json_extract(app_server_message.payload_json, '$.source') = 'codex_app_server'
        AND json_extract(app_server_message.payload_json, '$.method') = 'item/tool/requestUserInput'
        AND json_extract(app_server_message.payload_json, '$.appServerIdentity.threadId') = rollout.thread_id
        AND json_extract(app_server_message.payload_json, '$.appServerIdentity.turnId') = rollout.turn_id
        AND json_extract(app_server_message.payload_json, '$.appServerIdentity.itemId') = json_extract(rollout_message.payload_json, '$.question.id')
       WHERE rollout_message.type = 'question_request'
         AND rollout.app_server_message_id IS NULL
         AND rollout.rollout_message_id IS NOT NULL`
    ).all() as unknown as Array<{ message_id: string; session_id: string }>;
    if (rows.length === 0) return;
    const removedBySession = new Map<string, number>();
    const remove = this.db.prepare("DELETE FROM messages WHERE id = ? AND session_id = ?");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const result = remove.run(row.message_id, row.session_id);
        if (result.changes === 1) {
          removedBySession.set(row.session_id, (removedBySession.get(row.session_id) ?? 0) + 1);
        }
      }
      for (const [sessionId, removed] of removedBySession) {
        this.db.prepare("UPDATE managed_sessions SET unread_count = MAX(0, unread_count - ?) WHERE id = ?")
          .run(removed, sessionId);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private removeDuplicateImageSubmissionEchoes(): void {
    const rows = this.db.prepare(
      `SELECT messages.*,
              codex_item_messages.thread_id AS mapped_thread_id,
              codex_item_messages.turn_id AS mapped_turn_id,
              codex_item_messages.item_id AS mapped_item_id,
              codex_item_messages.message_id AS mapped_message_id,
              codex_item_messages.app_server_message_id,
              codex_item_messages.rollout_message_id,
              codex_item_messages.app_server_observed_at,
              codex_item_messages.rollout_observed_at
       FROM messages
       LEFT JOIN codex_item_messages ON codex_item_messages.message_id = messages.id
       WHERE messages.role = 'user'
       ORDER BY messages.session_id, messages.sequence`
    ).all() as unknown as ImageSubmissionCleanupRow[];
    const groups = new Map<string, ImageSubmissionCleanupRow[]>();
    for (const row of rows) {
      const message = hydrateMessage(row);
      const submission = recordValue(message.payload.muxpilotSubmission);
      const threadId = row.mapped_thread_id ?? nonemptyStringValue(submission?.threadId);
      const turnId = row.mapped_turn_id ?? nonemptyStringValue(submission?.turnId);
      if (!threadId || !turnId) continue;
      const key = JSON.stringify([row.session_id, threadId, turnId]);
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    const removedBySession = new Map<string, number>();

    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const group of groups.values()) {
        const submissions = group.filter((row) => isStructuredImageSubmission(hydrateMessage(row)));
        if (submissions.length !== 1) continue;
        const submissionRow = submissions[0]!;
        const submission = hydrateMessage(submissionRow);
        let retainedMapping = submissionRow.mapped_message_id ? submissionRow : null;
        for (const duplicateRow of group) {
          if (duplicateRow.id === submissionRow.id) continue;
          if (!isMatchingRuntimeImageEcho(submission, hydrateMessage(duplicateRow))) continue;
          if (!duplicateRow.mapped_message_id) continue;
          if (retainedMapping) {
            this.db.prepare(
              `UPDATE codex_item_messages SET
                 app_server_message_id = COALESCE(app_server_message_id, ?),
                 rollout_message_id = COALESCE(rollout_message_id, ?),
                 app_server_observed_at = COALESCE(app_server_observed_at, ?),
                 rollout_observed_at = COALESCE(rollout_observed_at, ?)
               WHERE session_id = ? AND thread_id = ? AND turn_id = ? AND item_id = ?`
            ).run(
              duplicateRow.app_server_message_id,
              duplicateRow.rollout_message_id,
              duplicateRow.app_server_observed_at,
              duplicateRow.rollout_observed_at,
              retainedMapping.session_id,
              retainedMapping.mapped_thread_id,
              retainedMapping.mapped_turn_id,
              retainedMapping.mapped_item_id
            );
            this.db.prepare(
              "DELETE FROM codex_item_messages WHERE session_id = ? AND thread_id = ? AND turn_id = ? AND item_id = ?"
            ).run(duplicateRow.session_id, duplicateRow.mapped_thread_id, duplicateRow.mapped_turn_id, duplicateRow.mapped_item_id);
          } else {
            this.db.prepare(
              `UPDATE codex_item_messages SET message_id = ?
               WHERE session_id = ? AND thread_id = ? AND turn_id = ? AND item_id = ?`
            ).run(submissionRow.id, duplicateRow.session_id, duplicateRow.mapped_thread_id, duplicateRow.mapped_turn_id, duplicateRow.mapped_item_id);
            retainedMapping = { ...duplicateRow, id: submissionRow.id, mapped_message_id: submissionRow.id };
          }
          this.deletePromptIndexMessage(duplicateRow.id);
          const removed = this.db.prepare("DELETE FROM messages WHERE id = ? AND session_id = ?")
            .run(duplicateRow.id, duplicateRow.session_id);
          if (Number(removed.changes) > 0) {
            removedBySession.set(duplicateRow.session_id, (removedBySession.get(duplicateRow.session_id) ?? 0) + 1);
            this.db.prepare(
              `UPDATE managed_sessions
               SET preview = CASE WHEN preview = ? THEN ? ELSE preview END
               WHERE id = ?`
            ).run(duplicateRow.text.slice(0, 280), submission.text.slice(0, 280), duplicateRow.session_id);
          }
        }
      }
      for (const [sessionId, removed] of removedBySession) {
        this.db.prepare("UPDATE managed_sessions SET unread_count = MAX(0, unread_count - ?) WHERE id = ?")
          .run(removed, sessionId);
        this.recentUserPromptsCache.delete(sessionId);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private removeDuplicateAppServerPlanMessages(): void {
    const rows = this.db.prepare(
      `SELECT codex_item_messages.*, messages.id, messages.sequence, messages.type, messages.role,
              messages.timestamp, messages.text, messages.payload_json
       FROM codex_item_messages
       JOIN messages ON messages.id = codex_item_messages.message_id
       WHERE messages.type = 'assistant' AND messages.role = 'assistant'
       ORDER BY codex_item_messages.session_id, codex_item_messages.thread_id,
                codex_item_messages.turn_id, messages.sequence`
    ).all() as unknown as Array<CodexItemMessageRow & MessageRow>;
    const removedBySession = new Map<string, number>();
    const consumed = new Set<string>();

    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const appServerRow of rows) {
        if (!appServerRow.app_server_message_id || appServerRow.rollout_message_id || consumed.has(appServerRow.message_id)) continue;
        const appServerMessage = hydrateMessage(appServerRow);
        const plan = canonicalProposedPlan(appServerMessage);
        if (plan === null) continue;
        const rolloutRow = rows.find((candidate) =>
          candidate.session_id === appServerRow.session_id
          && candidate.thread_id === appServerRow.thread_id
          && candidate.turn_id === appServerRow.turn_id
          && candidate.rollout_message_id !== null
          && candidate.app_server_message_id === null
          && !consumed.has(candidate.message_id)
          && canonicalProposedPlan(hydrateMessage(candidate)) === plan
        );
        if (!rolloutRow) continue;

        const retained = appServerRow.sequence <= rolloutRow.sequence ? appServerRow : rolloutRow;
        const discarded = retained.message_id === appServerRow.message_id ? rolloutRow : appServerRow;
        const previous = hydrateMessage(retained);
        const authoritative: ChatMessage = {
          ...appServerMessage,
          id: retained.message_id,
          sessionId: retained.session_id,
          sequence: retained.sequence,
          payload: { ...hydrateMessage(rolloutRow).payload, ...appServerMessage.payload }
        };
        this.db.prepare(
          `UPDATE messages SET type = ?, role = ?, timestamp = ?, text = ?, payload_json = ?
           WHERE id = ? AND session_id = ?`
        ).run(
          authoritative.type,
          authoritative.role,
          authoritative.timestamp,
          authoritative.text,
          JSON.stringify(authoritative.payload),
          retained.message_id,
          retained.session_id
        );
        this.db.prepare(
          `UPDATE codex_item_messages
           SET app_server_message_id = ?, rollout_message_id = ?,
               app_server_observed_at = ?, rollout_observed_at = ?
           WHERE session_id = ? AND thread_id = ? AND turn_id = ? AND item_id = ?`
        ).run(
          appServerRow.app_server_message_id,
          rolloutRow.rollout_message_id,
          appServerRow.app_server_observed_at,
          rolloutRow.rollout_observed_at,
          retained.session_id,
          retained.thread_id,
          retained.turn_id,
          retained.item_id
        );
        this.db.prepare(
          "DELETE FROM codex_item_messages WHERE session_id = ? AND thread_id = ? AND turn_id = ? AND item_id = ?"
        ).run(discarded.session_id, discarded.thread_id, discarded.turn_id, discarded.item_id);
        this.db.prepare("DELETE FROM messages WHERE id = ? AND session_id = ?")
          .run(discarded.message_id, discarded.session_id);
        this.deletePromptIndexMessage(previous.id);
        this.upsertPromptIndexMessage(authoritative);
        consumed.add(retained.message_id);
        consumed.add(discarded.message_id);
        removedBySession.set(retained.session_id, (removedBySession.get(retained.session_id) ?? 0) + 1);
      }
      for (const [sessionId, removed] of removedBySession) {
        this.db.prepare("UPDATE managed_sessions SET unread_count = MAX(0, unread_count - ?) WHERE id = ?")
          .run(removed, sessionId);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private backfillInteractionOutcomes(): void {
    const plans = this.db.prepare(
      `SELECT * FROM messages
       WHERE role = 'assistant' AND type = 'assistant'
       ORDER BY session_id, sequence`
    ).all() as unknown as MessageRow[];
    for (const row of plans) {
      const message = hydrateMessage(row);
      if (canonicalProposedPlan(message) === null || message.payload.interactionOutcome) continue;
      const nextUser = this.db.prepare(
        `SELECT * FROM messages
         WHERE session_id = ? AND role = 'user' AND sequence > ?
         ORDER BY sequence LIMIT 1`
      ).get(row.session_id, row.sequence) as MessageRow | undefined;
      if (!nextUser) continue;
      const decision = historicalPlanDecision(nextUser.text);
      if (!decision) continue;
      this.updateMessagePayload(message, {
        ...message.payload,
        interactionOutcome: { kind: "plan", status: "answered", decision, submittedAt: nextUser.timestamp }
      });
    }

    const requests = this.db.prepare(
      "SELECT * FROM app_server_requests WHERE state IN ('responded', 'resolved') ORDER BY received_at"
    ).all() as unknown as AppServerRequestRow[];
    for (const row of requests) {
      const request = hydrateAppServerRequest(row);
      const messages = this.db.prepare(
        `SELECT * FROM messages
         WHERE session_id = ? AND type IN ('approval_request', 'question_request')`
      ).all(request.sessionId) as unknown as MessageRow[];
      for (const messageRow of messages) {
        const message = hydrateMessage(messageRow);
        if (message.payload.interactionOutcome) continue;
        const identity = recordValue(message.payload.appServerIdentity);
        const detail = recordValue(message.payload.approval) ?? recordValue(message.payload.question);
        if (identity?.threadId !== request.threadId || identity?.turnId !== request.turnId || detail?.requestId !== request.requestId) continue;
        const outcome = historicalRequestOutcome(message.type, request);
        this.updateMessagePayload(message, { ...message.payload, interactionOutcome: outcome });
        break;
      }
    }
  }

  private backfillSessionRepositories(): void {
    const rows = this.db.prepare("SELECT data_json, updated_at FROM managed_sessions").all() as unknown as Array<{
      data_json: string;
      updated_at: string;
    }>;
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO session_repositories
        (path, label, repo_root, branch, last_activity_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const row of rows) {
      const session = JSON.parse(row.data_json) as ManagedSession;
      const workspace = normalizeGitWorkspaceSummary(session.gitWorkspace);
      const path = session.repo.root ?? session.cwd;
      if (!path) continue;
      insert.run(
        path,
        session.repo.name || path,
        session.repo.root,
        workspace?.targetBranch ?? session.repo.branch,
        session.lastActivityAt,
        row.updated_at
      );
    }
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
    if (rows.some((row) => row.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function isAgentAuthoredMessage(message: ChatMessage): boolean {
  const submission = message.payload.muxpilotSubmission;
  if (!submission || typeof submission !== "object" || Array.isArray(submission)) return false;
  const actor = (submission as Record<string, unknown>).actor;
  return Boolean(actor && typeof actor === "object" && !Array.isArray(actor) && (actor as Record<string, unknown>).kind === "session");
}

function isAgentAuthoredPayload(payloadJson: string): boolean {
  try { return isAgentAuthoredMessage({ payload: JSON.parse(payloadJson) } as ChatMessage); } catch { return false; }
}

function hydrateGitWorkspace(row: GitWorkspaceRow): StoredGitWorkspace {
  const workspace = JSON.parse(row.data_json) as StoredGitWorkspace;
  return {
    ...workspace,
    helperToken: workspace.helperToken ?? "",
    sessionId: row.session_id,
    updatedAt: row.updated_at,
    summary: workspace.summary
  };
}

const NOTIFICATION_DEVICE_ID_PATTERN = /^[a-zA-Z0-9_-]{8,80}$/;

function normalizeNotificationDeviceId(deviceId: string): string {
  const normalized = deviceId.trim();
  if (!NOTIFICATION_DEVICE_ID_PATTERN.test(normalized)) throw new Error("Invalid notification device id");
  return normalized;
}

function defaultNotificationDeliverySettings(): NotificationDeliverySettings {
  return { pushEnabled: false, soundEnabled: true };
}

function notificationDeliverySettingsFromRow(row: NotificationDeviceSettingsRow): NotificationDeliverySettings {
  return { pushEnabled: row.push_enabled === 1, soundEnabled: row.sound_enabled !== 0 };
}

function notificationSettingsFromRows(rows: NotificationRuleRow[], delivery: NotificationDeliverySettings): NotificationSettings {
  const settings: NotificationSettings = { globalRules: [], sessionRules: {}, delivery };
  for (const row of rows) {
    if (row.scope === "global") {
      settings.globalRules.push(row.type);
    } else {
      if (!settings.sessionRules[row.session_id]) settings.sessionRules[row.session_id] = [];
      settings.sessionRules[row.session_id]!.push(row.type);
    }
  }
  return settings;
}

function queuedInputEchoFingerprint(text: string): string | null {
  const fingerprint = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  if (fingerprint.length < 16 && fingerprint.split(" ").filter(Boolean).length < 3) return null;
  return fingerprint || null;
}

function normalizePreviewText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function promptHistoryResult(row: PromptHistoryRow): PromptHistoryResult {
  const session = JSON.parse(row.session_data_json) as ManagedSession;
  const workspace = normalizeGitWorkspaceSummary(session.gitWorkspace);
  return {
    id: row.id,
    sessionId: row.session_id,
    sequence: row.sequence,
    timestamp: row.timestamp,
    text: row.text,
    sessionName: session.name || row.session_id,
    repoName: session.repo.name,
    repoBranch: workspace?.targetBranch ?? session.repo.branch,
    cwd: session.cwd
  };
}

function promptHistoryResultFromIndex(row: PromptIndexRow): PromptHistoryResult {
  return promptHistoryResult({
    id: row.message_id,
    session_id: row.session_id,
    sequence: row.sequence,
    type: "user",
    role: "user",
    timestamp: row.timestamp,
    text: row.text,
    payload_json: "{}",
    session_data_json: row.session_data_json
  });
}

function sessionHistoryResultFromMatchRow(
  row: SessionHistoryMatchRow,
  matchedPrompts: SessionHistoryResult["matchedPrompts"]
): SessionHistoryResult {
  const session = JSON.parse(row.session_data_json) as ManagedSession;
  const workspace = row.git_workspace_data_json ? (JSON.parse(row.git_workspace_data_json) as StoredGitWorkspace).summary : null;
  return sessionHistoryResultFromSession(
    {
      ...session,
      status: row.status,
      lastActivityAt: row.last_activity_at ?? session.lastActivityAt,
      archived: row.archived === 1
    },
    matchedPrompts,
    workspace
  );
}

function sessionHistoryResultFromNameRow(row: SessionHistoryNameRow): SessionHistoryResult {
  const session = JSON.parse(row.session_data_json) as ManagedSession;
  const workspace = row.git_workspace_data_json ? (JSON.parse(row.git_workspace_data_json) as StoredGitWorkspace).summary : null;
  return sessionHistoryResultFromSession(
    {
      ...session,
      status: row.status,
      lastActivityAt: row.last_activity_at ?? session.lastActivityAt,
      archived: row.archived === 1
    },
    [],
    workspace
  );
}

function sessionHistoryResultFromSession(
  session: ManagedSession,
  matchedPrompts: SessionHistoryResult["matchedPrompts"],
  gitWorkspace: GitWorkspaceSummary | null
): SessionHistoryResult {
  const workspace = normalizeGitWorkspaceSummary(gitWorkspace);
  return {
    sessionId: session.id,
    codexSessionId: session.codexSessionId ?? "",
    codexJsonlPath: session.codexJsonlPath,
    status: session.status,
    archived: session.archived,
    sessionName: session.name,
    repoName: session.repo.name,
    repoBranch: workspace?.targetBranch ?? session.repo.branch,
    cwd: session.cwd,
    lastActivityAt: session.lastActivityAt,
    transcriptSize: session.transcriptSize,
    matchedPrompts,
    gitWorkspace: workspace ? {
      id: workspace.id,
      worktreePath: workspace.worktreePath,
      sessionBranch: workspace.sessionBranch,
      targetBranch: workspace.targetBranch
    } : null
  };
}

function collapseSessionHistory(results: SessionHistoryResult[], limit: number): SessionHistoryResult[] {
  const byIdentity = new Map<string, SessionHistoryResult>();
  for (const result of results) {
    if (!result.codexSessionId) continue;
    const identity = sessionHistoryIdentity(result);
    const current = byIdentity.get(identity);
    if (!current || compareSessionHistoryPreference(result, current) < 0) {
      byIdentity.set(identity, result);
    } else if (current.matchedPrompts.length < 3) {
      current.matchedPrompts.push(...result.matchedPrompts.slice(0, 3 - current.matchedPrompts.length));
    }
  }
  return [...byIdentity.values()].sort(compareSessionHistoryResults).slice(0, limit);
}

function compareSessionHistoryPreference(first: SessionHistoryResult, second: SessionHistoryResult): number {
  const firstLive = first.status !== "missing" && !first.archived;
  const secondLive = second.status !== "missing" && !second.archived;
  if (firstLive !== secondLive) return firstLive ? -1 : 1;
  return compareSessionHistoryResults(first, second);
}

function compareSessionHistoryResults(first: SessionHistoryResult, second: SessionHistoryResult): number {
  const firstTime = first.lastActivityAt ? Date.parse(first.lastActivityAt) : Number.NEGATIVE_INFINITY;
  const secondTime = second.lastActivityAt ? Date.parse(second.lastActivityAt) : Number.NEGATIVE_INFINITY;
  if (firstTime !== secondTime) return secondTime - firstTime;
  return first.sessionName.localeCompare(second.sessionName) || first.sessionId.localeCompare(second.sessionId);
}

function ftsPromptQuery(query: string): string {
  const tokens = query
    .trim()
    .toLowerCase()
    .match(/[\p{L}\p{N}_-]+/gu)
    ?.map((token) => token.replace(/"/g, "\"\""))
    .filter(Boolean)
    .slice(0, 12) ?? [];
  return tokens.map((token) => `"${token}"*`).join(" AND ");
}

function sessionNameMatchesQuery(name: string, query: string): boolean {
  const nameTokens = name.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  const queryTokens = query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  return queryTokens.length > 0 && queryTokens.every((queryToken) =>
    nameTokens.some((nameToken) => nameToken.startsWith(queryToken))
  );
}

function parseStoredJson<T>(value: string | null): T | null {
  if (!value || value === "null") return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function searchableTranscriptText(message: ChatMessage): string {
  if (message.role === "user") {
    const normalized = normalizeUserContextText(message.text);
    if (normalized.kind === "hidden") return "";
    return normalized.text;
  }
  if (message.role === "assistant") return stripAssistantSideChannelBlocks(message.text);
  return message.text;
}

function normalizeTranscriptSearchText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function transcriptSearchPreview(text: string, query: string): string {
  const normalizedText = text.replace(/\s+/g, " ").trim();
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedText) return "";
  const index = normalizedQuery ? normalizedText.toLowerCase().indexOf(normalizedQuery) : -1;
  const start = Math.max(0, index < 0 ? 0 : index - 70);
  const end = Math.min(normalizedText.length, start + 180);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < normalizedText.length ? "..." : "";
  return `${prefix}${normalizedText.slice(start, end)}${suffix}`;
}

function stripAssistantSideChannelBlocks(text: string): string {
  return text
    .replace(/<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/g, "")
    .replace(/<\/?codex-proposed-plan[^>]*>/g, "")
    .trim();
}

function canonicalProposedPlan(message: Pick<ChatMessage, "type" | "role" | "text">): string | null {
  if (message.type !== "assistant" || message.role !== "assistant") return null;
  const text = stripAssistantSideChannelBlocks(message.text).replace(/\r\n/g, "\n");
  const openTag = "<proposed_plan>";
  const closeTag = "</proposed_plan>";
  let cursor = 0;
  let plan: string | null = null;
  while (cursor < text.length) {
    const open = text.indexOf(openTag, cursor);
    if (open === -1) break;
    const close = text.indexOf(closeTag, open + openTag.length);
    if (close === -1) break;
    plan = text.slice(open + openTag.length, close).trim();
    cursor = close + closeTag.length;
  }
  return plan;
}

function compareSessionsByActivity(first: ManagedSession, second: ManagedSession): number {
  const firstTime = first.lastActivityAt ? Date.parse(first.lastActivityAt) : Number.NEGATIVE_INFINITY;
  const secondTime = second.lastActivityAt ? Date.parse(second.lastActivityAt) : Number.NEGATIVE_INFINITY;
  if (firstTime !== secondTime) return secondTime - firstTime;
  return first.id.localeCompare(second.id);
}

function collaborationMode(value: unknown): CollaborationMode | null {
  if (value === "default" || value === "plan") return value;
  return null;
}

function approvalMode(value: unknown): ApprovalMode {
  return value === "auto" || value === "full" ? value : "ask";
}

function sessionModels(value: unknown): SessionModelSelections {
  if (!value || typeof value !== "object") return emptySessionModels();
  const record = value as Partial<Record<CollaborationMode, unknown>>;
  return {
    default: sessionModelSettings(record.default),
    plan: sessionModelSettings(record.plan)
  };
}

function emptySessionModels(): SessionModelSelections {
  return { default: emptySessionModelSettings(), plan: emptySessionModelSettings() };
}

function emptySessionModelSettings(): SessionModelSettings {
  return { model: null, reasoningEffort: null };
}

function sessionModelSettings(value: unknown): SessionModelSettings {
  if (typeof value === "string") return { model: value.trim() ? value : null, reasoningEffort: null };
  if (!value || typeof value !== "object") return emptySessionModelSettings();
  const record = value as { model?: unknown; reasoningEffort?: unknown };
  return {
    model: typeof record.model === "string" && record.model.trim() ? record.model : null,
    reasoningEffort: typeof record.reasoningEffort === "string" && record.reasoningEffort.trim() ? record.reasoningEffort : null
  };
}

function withSessionModelSettings(
  current: SessionModelSelections,
  mode: CollaborationMode,
  model: string,
  reasoningEffort: string | null
): SessionModelSelections {
  return {
    ...sessionModels(current),
    [mode]: { model, reasoningEffort }
  };
}

function hydrateMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    sequence: row.sequence,
    type: row.type as ChatMessage["type"],
    role: row.role as ChatMessage["role"],
    timestamp: row.timestamp,
    text: row.text,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>
  };
}

function hydrateQueuedInput(row: QueuedInputRow): QueuedInput {
  return {
    id: row.id,
    sessionId: row.session_id,
    text: row.text,
    content: row.content_json ? JSON.parse(row.content_json) as QueuedInput["content"] : undefined,
    mode: collaborationMode(row.mode) ?? "default",
    status: queuedInputStatus(row.status),
    error: row.error,
    codexSessionId: row.codex_session_id,
    codexJsonlPath: row.codex_jsonl_path,
    actorSessionId: row.actor_session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sentAt: row.sent_at
  };
}

function hydrateAppServerRequest(row: AppServerRequestRow): PersistedAppServerRequest {
  return {
    sessionId: row.session_id,
    requestId: JSON.parse(row.request_id_json) as string | number,
    method: row.method,
    params: JSON.parse(row.params_json) as unknown,
    threadId: row.thread_id,
    turnId: row.turn_id,
    state: row.state,
    response: row.response_json === null ? null : JSON.parse(row.response_json) as unknown,
    receivedAt: row.received_at,
    lastSeenAt: row.last_seen_at,
    respondedAt: row.responded_at,
    resolvedAt: row.resolved_at
  };
}

function hydrateAppServerReconciliation(row: AppServerReconciliationRow): AppServerReconciliationState {
  return {
    sessionId: row.session_id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    itemId: row.item_id,
    clientMessageId: row.client_message_id,
    method: row.method,
    status: row.status,
    evidence: JSON.parse(row.evidence_json) as unknown,
    observedAt: row.observed_at
  };
}

function validateAppServerRequest(request: ReceivedAppServerRequest): void {
  for (const [name, value] of [
    ["sessionId", request.sessionId],
    ["method", request.method],
    ["threadId", request.threadId],
    ["turnId", request.turnId],
    ["receivedAt", request.receivedAt],
    ["lastSeenAt", request.lastSeenAt]
  ] as const) {
    if (!value.trim()) throw new Error(`App-server request ${name} must not be empty`);
  }
  appServerRequestIdJson(request.requestId);
  serializeAppServerJson(request.params, "params");
}

function validateAppServerProjection(projection: AppServerProjectionInput): void {
  for (const [name, value] of [
    ["sessionId", projection.sessionId],
    ["threadId", projection.threadId],
    ["method", projection.method],
    ["observedAt", projection.observedAt]
  ] as const) {
    if (!value.trim()) throw new Error(`App-server projection ${name} must not be empty`);
  }
  for (const [name, value] of [
    ["turnId", projection.turnId],
    ["itemId", projection.itemId],
    ["clientMessageId", projection.clientMessageId]
  ] as const) {
    if (value !== null && !value.trim()) throw new Error(`App-server projection ${name} must not be empty`);
  }
  if (projection.status !== null && !APP_SERVER_SESSION_STATUSES.has(projection.status)) {
    throw new Error(`App-server projection status is invalid: ${String(projection.status)}`);
  }
  if (projection.message) serializeAppServerJson(projection.message.payload, "projection message payload");
}

function validateAppServerCommandProcess(process: AppServerCommandProcess): void {
  for (const [name, value] of Object.entries(process)) {
    if (typeof value !== "string" || !value.trim()) throw new Error(`App-server command process ${name} must not be empty`);
  }
}

function appServerRequestIdJson(requestId: string | number): string {
  if (typeof requestId === "string") return JSON.stringify(requestId);
  if (typeof requestId === "number" && Number.isSafeInteger(requestId)) return JSON.stringify(requestId);
  throw new Error("App-server request id must be a string or safe integer");
}

function serializeAppServerJson(value: unknown, name: string): string {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("undefined JSON result");
    return serialized;
  } catch {
    throw new Error(`App-server request ${name} must be JSON serializable`);
  }
}

function hydrateBtwExchange(row: BtwExchangeRow): BtwExchange {
  const status = row.status === "completed" || row.status === "failed" || row.status === "cancelled"
    ? row.status
    : "running";
  return {
    id: row.id,
    sessionId: row.session_id,
    question: row.question,
    answer: row.answer,
    status,
    error: row.error,
    createdAt: row.created_at,
    firstTokenAt: row.first_token_at,
    completedAt: row.completed_at,
    documentOperation: parseBtwDocumentOperation(row.document_operation_json)
  };
}

function parseBtwDocumentOperation(value: string | null): BtwExchange["documentOperation"] {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const validPhase = parsed?.phase === "waiting" || parsed?.phase === "retrying" || parsed?.phase === "notifying"
      || parsed?.phase === "applied" || parsed?.phase === "conflict";
    if (
      !validPhase
      || !stringArray(parsed.created)
      || !stringArray(parsed.updated)
      || !Number.isInteger(parsed.retryCount)
      || (parsed.retryCount as number) < 0
    ) return null;
    return {
      phase: parsed.phase as NonNullable<BtwExchange["documentOperation"]>["phase"],
      created: parsed.created,
      updated: parsed.updated,
      retryCount: parsed.retryCount as number
    };
  } catch {
    return null;
  }
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function historicalPlanDecision(text: string): "implement" | "clear_context_implement" | null {
  if (text.trim() === "Implement the plan.") return "implement";
  if (text.startsWith("A previous agent produced the plan below to accomplish the user's task.")) {
    return "clear_context_implement";
  }
  return null;
}

function historicalRequestOutcome(messageType: ChatMessage["type"], request: PersistedAppServerRequest): Record<string, unknown> {
  const submittedAt = request.respondedAt ?? request.resolvedAt ?? request.lastSeenAt;
  if (!request.response) {
    return { kind: messageType === "approval_request" ? "approval" : "question", status: "closed", submittedAt };
  }
  const response = recordValue(request.response) ?? {};
  if (messageType === "question_request") {
    const answers = recordValue(response.answers);
    return answers
      ? { kind: "question", status: "answered", answers, submittedAt }
      : { kind: "question", status: "closed", submittedAt };
  }
  const rawDecision = response.decision;
  let decision: string | null = null;
  if (rawDecision === "accept") decision = "approve_once";
  else if (rawDecision === "acceptForSession") decision = "approve_for_session";
  else if (rawDecision === "decline") decision = "deny";
  else if (recordValue(rawDecision)?.acceptWithExecpolicyAmendment) decision = "approve_for_prefix";
  else if (response.scope === "session") decision = "approve_for_session";
  else if (response.scope === "turn") decision = Object.keys(recordValue(response.permissions) ?? {}).length > 0 ? "approve_once" : "deny";
  return decision
    ? { kind: "approval", status: "answered", decision, submittedAt }
    : { kind: "approval", status: "closed", submittedAt };
}

function queuedInputStatus(value: unknown): QueuedInput["status"] {
  if (value === "queued" || value === "sending" || value === "sent" || value === "failed") return value;
  return "queued";
}

function isQuestionAnswerOutput(row: MessageRow, questionId: string): boolean {
  const payload = parseJsonObject(row.payload_json);
  const item = recordValue(payload?.payload);
  if (item?.type !== "function_call_output" || item.call_id !== questionId) return false;
  return isQuestionAnswerText(stringValue(item.output) ?? row.text);
}

function isQuestionAnswerText(text: string): boolean {
  const payload = parseJsonObject(text);
  const answers = recordValue(payload?.answers);
  if (!answers) return false;
  return Object.values(answers).some((value) => {
    const answer = recordValue(value);
    return Array.isArray(answer?.answers) && answer.answers.some((item) => typeof item === "string" && item.trim());
  });
}

function parseJsonObject(text: unknown): Record<string, unknown> | null {
  if (typeof text !== "string") return null;
  try {
    const value = JSON.parse(text) as unknown;
    return recordValue(value);
  } catch {
    return null;
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function sameAppServerRequest(existing: AppServerRequestRow, request: ReceivedAppServerRequest): boolean {
  if (
    existing.method !== request.method ||
    existing.thread_id !== request.threadId ||
    existing.turn_id !== request.turnId
  ) return false;
  const existingItemId = stringValue(parseJsonObject(existing.params_json)?.itemId);
  const receivedItemId = stringValue(recordValue(request.params)?.itemId);
  return existingItemId === null && receivedItemId === null ? true : existingItemId === receivedItemId;
}

function nonemptyStringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function transcriptItemsPage(
  sessionId: string,
  items: TranscriptPageResponse["items"],
  page: Pick<TranscriptPageResponse, "hasMoreBefore" | "hasMoreAfter">
): TranscriptPageResponse {
  return {
    sessionId,
    codexSessionId: null,
    codexJsonlPath: null,
    items,
    hasMoreBefore: page.hasMoreBefore,
    hasMoreAfter: page.hasMoreAfter
  };
}

function activeTailPageItems(items: TranscriptItem[], limit: number): TranscriptItem[] {
  let remaining = limit;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item && isTopLevelTranscriptItem(item)) remaining -= 1;
    if (remaining === 0) return items.slice(index);
  }
  return items;
}

function selectTranscriptTail(items: TranscriptItem[], limit: number, countMode: "items" | "topLevel"): TranscriptItem[] {
  return countMode === "topLevel"
    ? activeTailPageItems(items, limit)
    : items.slice(Math.max(0, items.length - limit));
}

function topLevelTranscriptItemCount(items: TranscriptItem[]): number {
  return items.filter(isTopLevelTranscriptItem).length;
}

function isTopLevelTranscriptItem(item: TranscriptItem): boolean {
  return item.type !== "range";
}

function isResponseItemUserMessage(message: ChatMessage): boolean {
  const payload = message.payload;
  const item = recordValue(payload.payload);
  return payload.type === "response_item" && item?.type === "message" && item.role === "user";
}

function toolCallId(message: ChatMessage): string | null {
  return stringValue(recordValue(message.payload.payload)?.call_id);
}

function isMuxpilotSubmissionMessage(message: ChatMessage): boolean {
  return recordValue(message.payload.muxpilotSubmission) !== null;
}

function structuredImageIds(message: ChatMessage): string[] {
  if (!Array.isArray(message.payload.content)) return [];
  return message.payload.content.flatMap((part) => {
    const value = recordValue(part);
    return value?.type === "image" && typeof value.id === "string" && value.id.length > 0 ? [value.id] : [];
  });
}

function isStructuredImageSubmission(message: ChatMessage): boolean {
  return isMuxpilotSubmissionMessage(message) && structuredImageIds(message).length > 0;
}

function isMatchingRuntimeImageEcho(submission: ChatMessage, candidate: ChatMessage): boolean {
  if (candidate.role !== "user" || isMuxpilotSubmissionMessage(candidate)) return false;
  if (candidate.payload.source !== "rollout" && candidate.payload.source !== "codex_app_server") return false;
  const imageIds = structuredImageIds(submission);
  const markup = [...candidate.text.matchAll(/<image\b[^>]*\bpath=(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>\s*<\/image>/gi)];
  const imagePaths = markup.map((match) => match[1] ?? match[2] ?? match[3] ?? "");
  if (imageIds.length === 0 || imagePaths.length !== imageIds.length) return false;
  if (imageIds.some((id, index) => !imagePaths[index]?.endsWith(`/${id}`) && imagePaths[index] !== id)) return false;
  const textWithoutImages = candidate.text
    .replace(/\s*<image\b[^>]*\bpath=(?:"[^"]*"|'[^']*'|[^\s>]+)[^>]*>\s*<\/image>/gi, "")
    .trim();
  return textWithoutImages === submission.text.trim();
}

function submissionAttemptTimestamp(message: ChatMessage): string {
  const submission = recordValue(message.payload.muxpilotSubmission);
  return typeof submission?.lastAttemptAt === "string" ? submission.lastAttemptAt : message.timestamp;
}

function timestampsAreNear(first: string, second: string): boolean {
  const firstMs = Date.parse(first);
  const secondMs = Date.parse(second);
  if (!Number.isFinite(firstMs) || !Number.isFinite(secondMs)) return first === second;
  return Math.abs(firstMs - secondMs) <= 5_000;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
