import { Worker } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import type {
  ChatMessage,
  CollaborationMode,
  NotificationDeliveryChannel,
  NotificationDeliverySettings,
  ManagedSession,
  NotificationRuleScope,
  NotificationRuleType,
  NotificationSettings,
  OpenAIUsageDailyPoint,
  OpenAIUsageSummaryResponse,
  PromptHistoryResult,
  PushSubscriptionInput,
  QueuedInput,
  SessionModelSettings,
  SessionModelSelections,
  SessionDirectorySuggestion,
  SessionEvent,
  SessionStatus,
  TranscriptItem,
  TranscriptRangeKind,
  TranscriptPageResponse,
  TranscriptSearchResponse
} from "@muxpilot/core";
import {
  buildExpandedTranscriptItems,
  buildTranscriptItems,
  hasCompleteProposedPlan,
  isDisplayableUserPromptText,
  normalizeSubagentNotificationText,
  normalizeUserContextText
} from "@muxpilot/core";

type StoredOpenAIUsageSummary = Omit<OpenAIUsageSummaryResponse, "configured" | "activitySummariesEnabled">;
const ACTIVITY_SUMMARIES_ENABLED_SETTING = "activity_summaries_enabled";
const UNRESTRICTED_REMOTE_ACCESS_SETTING = "unrestricted_remote_access_enabled";
const PUSH_VAPID_KEYS_SETTING = "push_vapid_keys";

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

export interface MessagePage {
  messages: ChatMessage[];
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
}

interface EventRow {
  id: string;
  type: SessionEvent["type"];
  session_id: string;
  payload_json: string;
  timestamp: string;
}

interface SessionSummaryRow {
  summary: string;
  generated_at: string;
  source_sequence: number;
  prompt_version: string;
}

interface QueuedInputRow {
  id: string;
  session_id: string;
  text: string;
  mode: string;
  status: string;
  error: string | null;
  codex_session_id: string | null;
  codex_jsonl_path: string | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
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

export type TouchedSessionRepository = Omit<SessionDirectorySuggestion, "source">;

export interface PushVapidKeys {
  publicKey: string;
  privateKey: string;
}

export interface StoredPushSubscription extends PushSubscriptionInput {
  deviceId: string;
}

export interface OpenAIUsageEventInput {
  id: string;
  source: "activity_summary";
  sourceId: string;
  model: string;
  responseId: string | null;
  createdAt: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number | null;
  pricingStatus: "priced" | "unpriced";
}

interface OpenAIUsageEventRow {
  created_at: string;
  model: string;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  estimated_cost_usd: number | null;
  pricing_status: "priced" | "unpriced";
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

  upsertSession(session: ManagedSession, updatedAt: string): Promise<void> {
    return this.call("upsertSession", session, updatedAt) as Promise<void>;
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

  setSessionInputMode(sessionId: string, inputMode: CollaborationMode, updatedAt: string): Promise<ManagedSession | null> {
    return this.call("setSessionInputMode", sessionId, inputMode, updatedAt) as Promise<ManagedSession | null>;
  }

  setSessionModelSettings(
    sessionId: string,
    mode: CollaborationMode,
    model: string,
    reasoningEffort: string | null,
    updatedAt: string
  ): Promise<ManagedSession | null> {
    return this.call("setSessionModelSettings", sessionId, mode, model, reasoningEffort, updatedAt) as Promise<ManagedSession | null>;
  }

  listSessions(includeArchived = false): Promise<ManagedSession[]> {
    return this.call("listSessions", includeArchived) as Promise<ManagedSession[]>;
  }

  getSession(sessionId: string): Promise<ManagedSession | null> {
    return this.call("getSession", sessionId) as Promise<ManagedSession | null>;
  }

  upsertTouchedRepository(repository: TouchedSessionRepository, updatedAt: string): Promise<void> {
    return this.call("upsertTouchedRepository", repository, updatedAt) as Promise<void>;
  }

  listTouchedRepositories(limit = 100): Promise<SessionDirectorySuggestion[]> {
    return this.call("listTouchedRepositories", limit) as Promise<SessionDirectorySuggestion[]>;
  }

  appendMessage(message: ChatMessage): Promise<boolean> {
    return this.call("appendMessage", message) as Promise<boolean>;
  }

  latestUserMessage(sessionId: string): Promise<ChatMessage | null> {
    return this.call("latestUserMessage", sessionId) as Promise<ChatMessage | null>;
  }

  latestMessage(sessionId: string): Promise<ChatMessage | null> {
    return this.call("latestMessage", sessionId) as Promise<ChatMessage | null>;
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

  listMessages(sessionId: string, afterSequence = 0): Promise<ChatMessage[]> {
    return this.call("listMessages", sessionId, afterSequence) as Promise<ChatMessage[]>;
  }

  listPromptHistory(query: string, limit: number): Promise<PromptHistoryResult[]> {
    return this.call("listPromptHistory", query, limit) as Promise<PromptHistoryResult[]>;
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

  listRecentUserPromptsForSummary(sessionId: string, limit = 12): Promise<ChatMessage[]> {
    return this.call("listRecentUserPromptsForSummary", sessionId, limit) as Promise<ChatMessage[]>;
  }

  latestMessageSequence(sessionId: string): Promise<number> {
    return this.call("latestMessageSequence", sessionId) as Promise<number>;
  }

  clearSessionTranscript(sessionId: string): Promise<void> {
    return this.call("clearSessionTranscript", sessionId) as Promise<void>;
  }

  getActivitySummary(sessionId: string): Promise<SessionSummaryRow | null> {
    return this.call("getActivitySummary", sessionId) as Promise<SessionSummaryRow | null>;
  }

  upsertActivitySummary(
    sessionId: string,
    summary: string,
    generatedAt: string,
    sourceSequence: number,
    promptVersion = "manual"
  ): Promise<void> {
    return this.call("upsertActivitySummary", sessionId, summary, generatedAt, sourceSequence, promptVersion) as Promise<void>;
  }

  recordOpenAIUsage(input: OpenAIUsageEventInput): Promise<void> {
    return this.call("recordOpenAIUsage", input) as Promise<void>;
  }

  summarizeOpenAIUsage(days = 30, now = new Date()): Promise<StoredOpenAIUsageSummary> {
    return this.call("summarizeOpenAIUsage", days, now) as Promise<StoredOpenAIUsageSummary>;
  }

  getActivitySummariesEnabled(): Promise<boolean> {
    return this.call("getActivitySummariesEnabled") as Promise<boolean>;
  }

  setActivitySummariesEnabled(enabled: boolean): Promise<boolean> {
    return this.call("setActivitySummariesEnabled", enabled) as Promise<boolean>;
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

  latestQuestionMessage(sessionId: string): Promise<ChatMessage | null> {
    return this.call("latestQuestionMessage", sessionId) as Promise<ChatMessage | null>;
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

  hasParserOffset(source: string): Promise<boolean> {
    return this.call("hasParserOffset", source) as Promise<boolean>;
  }

  setParserOffset(source: string, offset: number, parserVersion: string, updatedAt: string): Promise<void> {
    return this.call("setParserOffset", source, offset, parserVersion, updatedAt) as Promise<void>;
  }

  resetParserOffset(source: string): Promise<void> {
    return this.call("resetParserOffset", source) as Promise<void>;
  }

  appendEvent(event: SessionEvent): Promise<void> {
    return this.call("appendEvent", event) as Promise<void>;
  }

  addAudit(actor: string, action: string, target: string, result: string, timestamp: string): Promise<void> {
    return this.call("addAudit", actor, action, target, result, timestamp) as Promise<void>;
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

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  upsertSession(session: ManagedSession, updatedAt: string): void {
    const existing = this.getSession(session.id);
    const nextSession = { ...session, pinned: existing?.pinned ?? session.pinned ?? false };
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

  setSessionInputMode(sessionId: string, inputMode: CollaborationMode, updatedAt: string): ManagedSession | null {
    const existing = this.getSession(sessionId);
    if (!existing) return null;
    const next = { ...existing, inputMode };
    this.db
      .prepare("UPDATE managed_sessions SET data_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(next), updatedAt, sessionId);
    return this.getSession(sessionId);
  }

  setSessionModelSettings(
    sessionId: string,
    mode: CollaborationMode,
    model: string,
    reasoningEffort: string | null,
    updatedAt: string
  ): ManagedSession | null {
    const existing = this.getSession(sessionId);
    if (!existing) return null;
    const next = { ...existing, models: withSessionModelSettings(existing.models, mode, model, reasoningEffort) };
    this.db
      .prepare("UPDATE managed_sessions SET data_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(next), updatedAt, sessionId);
    return this.getSession(sessionId);
  }

  listSessions(includeArchived = false): ManagedSession[] {
    const rows = this.db
      .prepare(
        `SELECT managed_sessions.*
         FROM managed_sessions
         WHERE (? = 1 OR archived = 0)
         ORDER BY managed_sessions.id ASC`
      )
      .all(includeArchived ? 1 : 0) as unknown as SessionRow[];

    return rows
      .map((row) => this.hydrateSession(row))
      .sort((first, second) => compareSessionsByActivity(first, second));
  }

  getSession(sessionId: string): ManagedSession | null {
    const row = this.db.prepare("SELECT * FROM managed_sessions WHERE id = ?").get(sessionId) as SessionRow | undefined;
    if (!row) return null;
    return this.hydrateSession(row);
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
    if (this.isDuplicateUserEcho(message)) return false;

    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO messages
          (id, session_id, sequence, type, role, timestamp, text, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        message.id,
        message.sessionId,
        message.sequence,
        message.type,
        message.role,
        message.timestamp,
        message.text,
        JSON.stringify(message.payload)
      );

    if (Number(result.changes) > 0) {
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

  latestMessage(sessionId: string): ChatMessage | null {
    const row = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE session_id = ?
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
    const row = rows.find((candidate) => hasCompleteProposedPlan(candidate.text));
    return row ? hydrateMessage(row) : null;
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
    if (message.role === "user") {
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

  listPromptHistory(query: string, limit: number): PromptHistoryResult[] {
    const normalizedQuery = query.trim().toLowerCase();
    const rows = this.db
      .prepare(
        `SELECT messages.*, managed_sessions.data_json AS session_data_json
         FROM messages
         INNER JOIN managed_sessions ON managed_sessions.id = messages.session_id
         WHERE messages.role = 'user'
           AND messages.text <> ''
         ORDER BY messages.timestamp DESC, messages.sequence DESC`
      )
      .all() as unknown as PromptHistoryRow[];

    const matches = rows
      .filter((row) => isDisplayableUserPromptText(row.text))
      .map((row, index) => ({
        row,
        score: normalizedQuery ? promptHistoryScore(row.text, normalizedQuery) : 0,
        index
      }))
      .filter((match): match is { row: PromptHistoryRow; score: number; index: number } => match.score !== null)
      .sort((first, second) => first.score - second.score || second.row.timestamp.localeCompare(first.row.timestamp) || first.index - second.index)
      .slice(0, limit);

    return matches.map(({ row }) => promptHistoryResult(row));
  }

  listRecentMessages(sessionId: string, limit: number): TranscriptPageResponse {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE session_id = ?
         ORDER BY sequence ASC`
      )
      .all(sessionId) as unknown as MessageRow[];
    const items = buildTranscriptItems(rows.map(hydrateMessage));
    const pageItems = items.slice(Math.max(0, items.length - limit));

    return transcriptItemsPage(sessionId, pageItems, {
      hasMoreBefore: items.length > pageItems.length,
      hasMoreAfter: false
    });
  }

  listActiveTailMessages(sessionId: string, fallbackLimit: number): TranscriptPageResponse {
    const prompt = this.latestDisplayableUserPrompt(sessionId);
    if (!prompt) return this.listRecentMessages(sessionId, fallbackLimit);

    const previousOutput = this.latestAssistantOutputBefore(sessionId, prompt.sequence);
    const activeItems = this.compactActiveTailItems(sessionId, prompt, previousOutput);
    const activePageItems = activeTailPageItems(activeItems, fallbackLimit);
    const remaining = Math.max(0, fallbackLimit - topLevelTranscriptItemCount(activePageItems));
    const olderItems =
      remaining > 0 ? this.listTranscriptItemsBefore(sessionId, activePageItems[0]?.firstSequence ?? prompt.sequence, remaining) : [];
    const pageItems = [...olderItems, ...activePageItems];
    const firstLoadedSequence = pageItems[0]?.firstSequence ?? prompt.sequence;

    return transcriptItemsPage(sessionId, pageItems, {
      hasMoreBefore: this.topLevelMessageCountBefore(sessionId, firstLoadedSequence) > 0,
      hasMoreAfter: false
    });
  }

  listEarliestMessages(sessionId: string, limit: number): TranscriptPageResponse {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE session_id = ?
         ORDER BY sequence ASC`
      )
      .all(sessionId) as unknown as MessageRow[];
    const items = buildTranscriptItems(rows.map(hydrateMessage));
    const pageItems = items.slice(0, limit);

    return transcriptItemsPage(sessionId, pageItems, {
      hasMoreBefore: false,
      hasMoreAfter: items.length > pageItems.length
    });
  }

  private latestDisplayableUserPrompt(sessionId: string): MessageRow | null {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE session_id = ? AND role = 'user'
         ORDER BY sequence DESC`
      )
      .all(sessionId) as unknown as MessageRow[];

    return rows.find((row) => isDisplayableUserPromptText(row.text)) ?? null;
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

  private compactActiveTailItems(sessionId: string, prompt: MessageRow, previousOutput: MessageRow | null): TranscriptItem[] {
    const boundaryRows = [
      previousOutput,
      prompt,
      ...this.activeTailBoundaryRowsAfterPrompt(sessionId, prompt.sequence)
    ].filter((row): row is MessageRow => Boolean(row));
    const items: TranscriptItem[] = [];
    let previousSequence = previousOutput ? this.activeTailOutputAnchorSequence(sessionId, previousOutput) - 1 : prompt.sequence - 1;
    let inPromptTurn = false;
    let afterVisibleAssistant = false;

    for (const row of boundaryRows) {
      const rangeKind: TranscriptRangeKind = inPromptTurn && !afterVisibleAssistant ? "activity" : "stack";
      appendRangeItem(items, this.collapsedRangeItem(sessionId, previousSequence + 1, row.sequence - 1, rangeKind));
      items.push(...buildTranscriptItems([hydrateMessage(row)]));
      previousSequence = row.sequence;
      if (row.sequence === prompt.sequence) {
        inPromptTurn = true;
        afterVisibleAssistant = false;
      } else if (inPromptTurn && row.role === "assistant" && row.type === "assistant") {
        afterVisibleAssistant = true;
      }
    }

    const tailKind: TranscriptRangeKind = inPromptTurn && !afterVisibleAssistant ? "activity" : "stack";
    appendRangeItem(items, this.collapsedRangeItem(sessionId, previousSequence + 1, Number.MAX_SAFE_INTEGER, tailKind));
    return items;
  }

  private activeTailBoundaryRowsAfterPrompt(sessionId: string, promptSequence: number): MessageRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE session_id = ?
           AND sequence > ?
           AND (
             role = 'user'
             OR type = 'question_request'
             OR (
               role = 'assistant'
               AND type = 'assistant'
               AND payload_json NOT LIKE '%"type":"event_msg"%'
               AND sequence = (
                 SELECT MAX(sequence)
                 FROM messages
                 WHERE session_id = ?
                   AND sequence > ?
                   AND role = 'assistant'
                   AND type = 'assistant'
                   AND payload_json NOT LIKE '%"type":"event_msg"%'
               )
             )
           )
         ORDER BY sequence ASC`
      )
      .all(sessionId, promptSequence, sessionId, promptSequence) as unknown as MessageRow[];
    return rows.filter(isActiveTailBoundaryRow);
  }

  private listTranscriptItemsBefore(sessionId: string, beforeSequence: number, limit: number): TranscriptItem[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE session_id = ? AND sequence < ?
         ORDER BY sequence ASC`
      )
      .all(sessionId, beforeSequence) as unknown as MessageRow[];
    const pageItems = activeTailPageItems(buildTranscriptItems(rows.map(hydrateMessage)), limit);
    return topLevelTranscriptItemCount(pageItems) > 0 ? pageItems : [];
  }

  private collapsedRangeItem(
    sessionId: string,
    fromSequence: number,
    toSequence: number,
    rangeKind: TranscriptRangeKind
  ): Extract<TranscriptItem, { type: "range" }> | null {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE session_id = ?
           AND sequence >= ?
           AND sequence <= ?
         ORDER BY sequence ASC`
      )
      .all(sessionId, fromSequence, toSequence) as unknown as MessageRow[];
    const rangeRows = rows.filter((row) => !isHiddenUserContextRow(row));
    const first = rangeRows[0];
    const last = rangeRows.at(-1) ?? first;
    if (!first || !last) return null;
    return {
      type: "range",
      id: `${rangeKind}-${sessionId}-${first.sequence}-${last.sequence}-${rangeRows.length}`,
      rangeKind,
      label: collapsedRangeLabel(rangeKind, rangeRows.length),
      firstSequence: first.sequence,
      lastSequence: last.sequence,
      messageCount: rangeRows.length
    };
  }

  listMessagesBefore(sessionId: string, beforeSequence: number, limit: number): TranscriptPageResponse {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE session_id = ? AND sequence < ?
         ORDER BY sequence ASC`
      )
      .all(sessionId, beforeSequence) as unknown as MessageRow[];
    const items = buildTranscriptItems(rows.map(hydrateMessage));
    const pageItems = activeTailPageItems(items, limit);

    return transcriptItemsPage(sessionId, pageItems, {
      hasMoreBefore: topLevelTranscriptItemCount(items) > topLevelTranscriptItemCount(pageItems),
      hasMoreAfter: pageItems.length > 0
    });
  }

  listMessagesAfterPage(sessionId: string, afterSequence: number, limit: number): TranscriptPageResponse {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE session_id = ? AND sequence > ?
         ORDER BY sequence ASC`
      )
      .all(sessionId, afterSequence) as unknown as MessageRow[];
    const items = buildTranscriptItems(rows.map(hydrateMessage));
    const pageItems = items.slice(0, limit);

    return transcriptItemsPage(sessionId, pageItems, {
      hasMoreBefore: pageItems.length > 0,
      hasMoreAfter: items.length > pageItems.length
    });
  }

  listMessagesAround(sessionId: string, aroundSequence: number, limit: number): TranscriptPageResponse {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE session_id = ?
         ORDER BY sequence ASC`
      )
      .all(sessionId) as unknown as MessageRow[];
    const items = buildExpandedTranscriptItems(rows.map(hydrateMessage));
    const targetIndex = items.findIndex((item) => item.firstSequence <= aroundSequence && item.lastSequence >= aroundSequence);
    if (targetIndex < 0) {
      return transcriptItemsPage(sessionId, [], {
        hasMoreBefore: this.hasMessageBefore(sessionId, aroundSequence),
        hasMoreAfter: this.hasMessageAfter(sessionId, aroundSequence)
      });
    }

    const beforeCount = Math.floor((limit - 1) / 2);
    let start = Math.max(0, targetIndex - beforeCount);
    let end = Math.min(items.length, start + limit);
    start = Math.max(0, end - limit);
    const pageItems = items.slice(start, end);

    return transcriptItemsPage(sessionId, pageItems, {
      hasMoreBefore: start > 0,
      hasMoreAfter: end < items.length
    });
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

  private topLevelMessageCountBefore(sessionId: string, sequence: number): number {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE session_id = ? AND sequence < ?
         ORDER BY sequence ASC`
      )
      .all(sessionId, sequence) as unknown as MessageRow[];
    return topLevelTranscriptItemCount(buildTranscriptItems(rows.map(hydrateMessage)));
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

  listRecentUserPromptsForSummary(sessionId: string, limit = 12): ChatMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE session_id = ?
           AND text <> ''
           AND role = 'user'
         ORDER BY sequence DESC`
      )
      .all(sessionId) as unknown as MessageRow[];

    return rows
      .filter((row) => isDisplayableUserPromptText(row.text))
      .slice(0, limit)
      .reverse()
      .map(hydrateMessage);
  }

  latestMessageSequence(sessionId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(sequence), 0) AS latest FROM messages WHERE session_id = ?")
      .get(sessionId) as { latest: number };
    return row.latest;
  }

  clearSessionTranscript(sessionId: string): void {
    this.db.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId);
    this.db.prepare("DELETE FROM session_summaries WHERE session_id = ?").run(sessionId);
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

  getActivitySummary(sessionId: string): SessionSummaryRow | null {
    const row = this.db
      .prepare("SELECT summary, generated_at, source_sequence, prompt_version FROM session_summaries WHERE session_id = ?")
      .get(sessionId) as SessionSummaryRow | undefined;
    return row ?? null;
  }

  upsertActivitySummary(
    sessionId: string,
    summary: string,
    generatedAt: string,
    sourceSequence: number,
    promptVersion = "manual"
  ): void {
    this.db
      .prepare(
        `INSERT INTO session_summaries (session_id, summary, generated_at, source_sequence, prompt_version)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
          summary=excluded.summary,
          generated_at=excluded.generated_at,
          source_sequence=excluded.source_sequence,
          prompt_version=excluded.prompt_version`
      )
      .run(sessionId, summary, generatedAt, sourceSequence, promptVersion);
  }

  recordOpenAIUsage(input: OpenAIUsageEventInput): void {
    this.db
      .prepare(
        `INSERT INTO openai_usage_events
          (id, source, source_id, model, response_id, created_at, input_tokens, cached_input_tokens,
           output_tokens, total_tokens, estimated_cost_usd, pricing_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.id,
        input.source,
        input.sourceId,
        input.model,
        input.responseId,
        input.createdAt,
        input.inputTokens,
        input.cachedInputTokens,
        input.outputTokens,
        input.totalTokens,
        input.estimatedCostUsd,
        input.pricingStatus
      );
  }

  summarizeOpenAIUsage(days = 30, now = new Date()): StoredOpenAIUsageSummary {
    const safeDays = Math.max(1, Math.min(365, Math.floor(days)));
    const bucketStart = startOfLocalDay(now);
    bucketStart.setDate(bucketStart.getDate() - (safeDays - 1));
    const bucketEnd = startOfLocalDay(now);
    bucketEnd.setDate(bucketEnd.getDate() + 1);

    const points = createDailyBuckets(bucketStart, safeDays);
    const pointByDate = new Map(points.map((point) => [point.date, point]));
    const unpricedModels = new Set<string>();
    const rows = this.db
      .prepare(
        `SELECT created_at, model, input_tokens, cached_input_tokens, output_tokens, total_tokens,
                estimated_cost_usd, pricing_status
         FROM openai_usage_events
         WHERE source = 'activity_summary'
           AND created_at >= ?
           AND created_at < ?
         ORDER BY created_at ASC`
      )
      .all(bucketStart.toISOString(), bucketEnd.toISOString()) as unknown as OpenAIUsageEventRow[];

    for (const row of rows) {
      const date = localDateKey(new Date(row.created_at));
      const point = pointByDate.get(date);
      if (!point) continue;
      point.requestCount += 1;
      point.inputTokens += row.input_tokens;
      point.cachedInputTokens += row.cached_input_tokens;
      point.outputTokens += row.output_tokens;
      point.totalTokens += row.total_tokens;
      if (row.pricing_status === "unpriced" || row.estimated_cost_usd === null) {
        point.estimatedCostUsd = null;
        unpricedModels.add(row.model);
      } else if (point.estimatedCostUsd !== null) {
        point.estimatedCostUsd += row.estimated_cost_usd;
      }
    }

    return {
      days: safeDays,
      points,
      totals: summarizeDailyPoints(points),
      unpricedModels: Array.from(unpricedModels).sort()
    };
  }

  getActivitySummariesEnabled(): boolean {
    const row = this.db
      .prepare("SELECT value FROM app_settings WHERE key = ?")
      .get(ACTIVITY_SUMMARIES_ENABLED_SETTING) as { value: string } | undefined;
    return row?.value !== "false";
  }

  setActivitySummariesEnabled(enabled: boolean): boolean {
    this.setBooleanSetting(ACTIVITY_SUMMARIES_ENABLED_SETTING, enabled);
    return enabled;
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

  latestQuestionMessage(sessionId: string): ChatMessage | null {
    const row = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE session_id = ? AND type = 'question_request'
         ORDER BY sequence DESC
         LIMIT 1`
      )
      .get(sessionId) as MessageRow | undefined;

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
          (id, session_id, text, mode, status, error, codex_session_id, codex_jsonl_path, created_at, updated_at, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.id,
        input.sessionId,
        input.text,
        input.mode,
        input.status,
        input.error,
        input.codexSessionId,
        input.codexJsonlPath,
        input.createdAt,
        input.updatedAt,
        input.sentAt
      );
  }

  updateQueuedInput(input: QueuedInput): void {
    this.db
      .prepare(
        `UPDATE queued_inputs
         SET text = ?,
             mode = ?,
             status = ?,
             error = ?,
             codex_session_id = ?,
             codex_jsonl_path = ?,
             updated_at = ?,
             sent_at = ?
         WHERE session_id = ? AND id = ?`
      )
      .run(
        input.text,
        input.mode,
        input.status,
        input.error,
        input.codexSessionId,
        input.codexJsonlPath,
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

  appendEvent(event: SessionEvent): void {
    this.db
      .prepare("INSERT INTO events (id, type, session_id, payload_json, timestamp) VALUES (?, ?, ?, ?, ?)")
      .run(event.id, event.type, event.sessionId, JSON.stringify(event.payload), event.timestamp);
  }

  addAudit(actor: string, action: string, target: string, result: string, timestamp: string): void {
    this.db
      .prepare("INSERT INTO audit_log (actor, action, target, result, timestamp) VALUES (?, ?, ?, ?, ?)")
      .run(actor, action, target, result, timestamp);
  }

  private hydrateSession(row: SessionRow): ManagedSession {
    const session = JSON.parse(row.data_json) as ManagedSession;
    const recentUserPrompts = this.recentUserPrompts(row.id);
    const activitySummary = this.getActivitySummary(row.id);
    return {
      ...session,
      status: row.status,
      lastActivityAt: row.last_activity_at ?? this.latestMessageAt(row.id),
      preview: recentUserPrompts[0] ?? "",
      recentUserPrompts,
      activitySummary: activitySummary?.summary ?? null,
      activitySummaryGeneratedAt: activitySummary?.generated_at ?? null,
      activitySummarySourceSequence: activitySummary?.source_sequence ?? null,
      inputMode: collaborationMode(session.inputMode) ?? "default",
      models: sessionModels(session.models),
      transcriptSize: this.messageCount(row.id),
      unreadCount: row.unread_count,
      pinned: session.pinned === true,
      archived: row.archived === 1
    };
  }

  private recentUserPrompts(sessionId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT text FROM messages
         WHERE session_id = ? AND role = 'user' AND text <> ''
         ORDER BY sequence DESC`
      )
      .all(sessionId) as unknown as Pick<MessageRow, "text">[];

    return rows
      .filter((row) => isDisplayableUserPromptText(row.text))
      .slice(0, 2)
      .map((row) => normalizePreviewText(row.text))
      .filter(Boolean);
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

      CREATE TABLE IF NOT EXISTS session_summaries (
        session_id TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        source_sequence INTEGER NOT NULL,
        prompt_version TEXT NOT NULL DEFAULT 'activity-summary-v1',
        FOREIGN KEY(session_id) REFERENCES managed_sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS openai_usage_events (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        source_id TEXT NOT NULL,
        model TEXT NOT NULL,
        response_id TEXT,
        created_at TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        cached_input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_cost_usd REAL,
        pricing_status TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS queued_inputs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        text TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        codex_session_id TEXT,
        codex_jsonl_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sent_at TEXT,
        FOREIGN KEY(session_id) REFERENCES managed_sessions(id) ON DELETE CASCADE
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

      CREATE INDEX IF NOT EXISTS idx_messages_session_sequence ON messages(session_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_messages_role_timestamp ON messages(role, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_sessions_activity ON managed_sessions(last_activity_at);
      CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_openai_usage_created_at ON openai_usage_events(created_at);
      CREATE INDEX IF NOT EXISTS idx_queued_inputs_session_status ON queued_inputs(session_id, status, created_at);
      CREATE INDEX IF NOT EXISTS idx_notification_rules_session ON notification_rules(session_id);
      CREATE INDEX IF NOT EXISTS idx_notification_device_rules_session ON notification_device_rules(session_id);
      CREATE INDEX IF NOT EXISTS idx_notification_push_subscriptions_endpoint ON notification_push_subscriptions(endpoint);
      CREATE INDEX IF NOT EXISTS idx_session_repositories_activity ON session_repositories(COALESCE(last_activity_at, updated_at));
    `);
    this.addColumnIfMissing("session_summaries", "prompt_version", "TEXT NOT NULL DEFAULT 'activity-summary-v1'");
    this.backfillSessionRepositories();
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
      const path = session.repo.root ?? session.tmux.cwd;
      if (!path) continue;
      insert.run(
        path,
        session.repo.name || path,
        session.repo.root,
        session.repo.branch,
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
  return {
    id: row.id,
    sessionId: row.session_id,
    sequence: row.sequence,
    timestamp: row.timestamp,
    text: row.text,
    sessionName: session.tmux.windowName || session.tmux.sessionName || row.session_id,
    repoName: session.repo.name,
    repoBranch: session.repo.branch,
    cwd: session.tmux.cwd
  };
}

function promptHistoryScore(text: string, normalizedQuery: string): number | null {
  if (!normalizedQuery) return 0;
  const normalizedText = text.toLowerCase();
  if (normalizedText === normalizedQuery) return 0;
  if (normalizedText.startsWith(normalizedQuery)) return 10 + normalizedText.length - normalizedQuery.length;
  const substringIndex = normalizedText.indexOf(normalizedQuery);
  if (substringIndex >= 0) return 100 + substringIndex + normalizedText.length - normalizedQuery.length;

  let cursor = 0;
  let previousIndex = -1;
  let score = 500;
  for (const char of normalizedQuery) {
    const nextIndex = normalizedText.indexOf(char, cursor);
    if (nextIndex < 0) return null;
    if (previousIndex >= 0) score += nextIndex - previousIndex - 1;
    if (isPromptHistoryWordBoundary(normalizedText, nextIndex)) score -= 8;
    previousIndex = nextIndex;
    cursor = nextIndex + 1;
  }
  return score + normalizedText.length - normalizedQuery.length;
}

function isPromptHistoryWordBoundary(value: string, index: number): boolean {
  if (index === 0) return true;
  return /[\s_\-/:.]/.test(value[index - 1] ?? "");
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
    mode: collaborationMode(row.mode) ?? "default",
    status: queuedInputStatus(row.status),
    error: row.error,
    codexSessionId: row.codex_session_id,
    codexJsonlPath: row.codex_jsonl_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sentAt: row.sent_at
  };
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

function appendRangeItem(items: TranscriptItem[], item: Extract<TranscriptItem, { type: "range" }> | null): void {
  if (item) items.push(item);
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

function topLevelTranscriptItemCount(items: TranscriptItem[]): number {
  return items.filter(isTopLevelTranscriptItem).length;
}

function isTopLevelTranscriptItem(item: TranscriptItem): boolean {
  return item.type !== "range";
}

function isActiveTailBoundaryRow(row: MessageRow): boolean {
  if (row.role !== "user") return true;
  const normalized = normalizeUserContextText(row.text);
  if (normalized.kind === "message") return true;
  return normalized.kind === "action" && !normalizeSubagentNotificationText(row.text);
}

function isHiddenUserContextRow(row: MessageRow): boolean {
  return row.role === "user" && normalizeUserContextText(row.text).kind === "hidden";
}

function collapsedRangeLabel(kind: TranscriptRangeKind, count: number): string {
  if (kind === "activity") return `${count} intermediate ${pluralize(count, "item")}`;
  return `${count} ${pluralize(count, "event")}`;
}

function pluralize(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

function isResponseItemUserMessage(message: ChatMessage): boolean {
  const payload = message.payload;
  const item = recordValue(payload.payload);
  return payload.type === "response_item" && item?.type === "message" && item.role === "user";
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

function createDailyBuckets(start: Date, days: number): OpenAIUsageDailyPoint[] {
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return {
      date: localDateKey(date),
      requestCount: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0
    };
  });
}

function summarizeDailyPoints(points: OpenAIUsageDailyPoint[]): Omit<OpenAIUsageDailyPoint, "date"> {
  const totals: Omit<OpenAIUsageDailyPoint, "date"> = {
    requestCount: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0
  };

  for (const point of points) {
    totals.requestCount += point.requestCount;
    totals.inputTokens += point.inputTokens;
    totals.cachedInputTokens += point.cachedInputTokens;
    totals.outputTokens += point.outputTokens;
    totals.totalTokens += point.totalTokens;
    if (point.estimatedCostUsd === null) {
      totals.estimatedCostUsd = null;
    } else if (totals.estimatedCostUsd !== null) {
      totals.estimatedCostUsd += point.estimatedCostUsd;
    }
  }

  return totals;
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function localDateKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}
