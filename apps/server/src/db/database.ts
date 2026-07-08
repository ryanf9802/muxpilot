import { Worker } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import type {
  ChatMessage,
  CollaborationMode,
  ManagedSession,
  NotificationRuleScope,
  NotificationRuleType,
  NotificationSettings,
  OpenAIUsageDailyPoint,
  OpenAIUsageSummaryResponse,
  PushSubscriptionInput,
  QueuedInput,
  SessionModelSettings,
  SessionModelSelections,
  SessionEvent,
  SessionStatus,
  TranscriptItem,
  TranscriptRangeKind,
  TranscriptPageResponse
} from "@muxpilot/core";
import { buildExpandedTranscriptItems, buildTranscriptItems, hasCompleteProposedPlan, isDisplayableUserPromptText } from "@muxpilot/core";

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

interface NotificationRuleRow {
  scope: NotificationRuleScope;
  session_id: string;
  type: NotificationRuleType;
}

interface PushSubscriptionRow {
  endpoint: string;
  subscription_json: string;
}

export interface PushVapidKeys {
  publicKey: string;
  privateKey: string;
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

  listMessageRange(sessionId: string, fromSequence: number, toSequence: number): Promise<TranscriptPageResponse> {
    return this.call("listMessageRange", sessionId, fromSequence, toSequence) as Promise<TranscriptPageResponse>;
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

  getNotificationSettings(): Promise<NotificationSettings> {
    return this.call("getNotificationSettings") as Promise<NotificationSettings>;
  }

  setNotificationRule(
    scope: NotificationRuleScope,
    sessionId: string | null,
    type: NotificationRuleType,
    enabled: boolean,
    updatedAt: string
  ): Promise<NotificationSettings> {
    return this.call("setNotificationRule", scope, sessionId, type, enabled, updatedAt) as Promise<NotificationSettings>;
  }

  upsertPushSubscription(subscription: PushSubscriptionInput, updatedAt: string): Promise<void> {
    return this.call("upsertPushSubscription", subscription, updatedAt) as Promise<void>;
  }

  deletePushSubscription(endpoint: string): Promise<void> {
    return this.call("deletePushSubscription", endpoint) as Promise<void>;
  }

  listPushSubscriptions(): Promise<PushSubscriptionInput[]> {
    return this.call("listPushSubscriptions") as Promise<PushSubscriptionInput[]>;
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
        session.id,
        JSON.stringify(session),
        session.status,
        session.lastActivityAt,
        session.preview,
        session.unreadCount,
        session.archived ? 1 : 0,
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
    const pageItems = activeItems.slice(Math.max(0, activeItems.length - fallbackLimit));
    const firstPageSequence = pageItems[0]?.firstSequence ?? prompt.sequence;

    return transcriptItemsPage(sessionId, pageItems, {
      hasMoreBefore: this.hasMessageBefore(sessionId, firstPageSequence),
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
    return this.db
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
  }

  private collapsedRangeItem(
    sessionId: string,
    fromSequence: number,
    toSequence: number,
    rangeKind: TranscriptRangeKind
  ): Extract<TranscriptItem, { type: "range" }> | null {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS message_count,
           MIN(sequence) AS first_sequence,
           MAX(sequence) AS last_sequence
         FROM messages
         WHERE session_id = ?
           AND sequence >= ?
           AND sequence <= ?`
      )
      .get(sessionId, fromSequence, toSequence) as { message_count: number; first_sequence: number | null; last_sequence: number | null };
    if (!row.message_count || row.first_sequence === null || row.last_sequence === null) return null;
    return {
      type: "range",
      id: `${rangeKind}-${sessionId}-${row.first_sequence}-${row.last_sequence}-${row.message_count}`,
      rangeKind,
      label: collapsedRangeLabel(rangeKind, row.message_count),
      firstSequence: row.first_sequence,
      lastSequence: row.last_sequence,
      messageCount: row.message_count
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
    const pageItems = items.slice(Math.max(0, items.length - limit));

    return transcriptItemsPage(sessionId, pageItems, {
      hasMoreBefore: items.length > pageItems.length,
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

  getNotificationSettings(): NotificationSettings {
    const rows = this.db.prepare("SELECT scope, session_id, type FROM notification_rules ORDER BY scope, session_id, type").all() as unknown as NotificationRuleRow[];
    const settings: NotificationSettings = { globalRules: [], sessionRules: {} };
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

  setNotificationRule(
    scope: NotificationRuleScope,
    sessionId: string | null,
    type: NotificationRuleType,
    enabled: boolean,
    updatedAt: string
  ): NotificationSettings {
    const normalizedSessionId = scope === "global" ? "" : (sessionId ?? "");
    if (scope === "session" && !normalizedSessionId) throw new Error("Session notification rules require a session id");
    if (enabled) {
      this.db
        .prepare(
          `INSERT INTO notification_rules (scope, session_id, type, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(scope, session_id, type) DO UPDATE SET updated_at = excluded.updated_at`
        )
        .run(scope, normalizedSessionId, type, updatedAt);
    } else {
      this.db
        .prepare("DELETE FROM notification_rules WHERE scope = ? AND session_id = ? AND type = ?")
        .run(scope, normalizedSessionId, type);
    }
    return this.getNotificationSettings();
  }

  upsertPushSubscription(subscription: PushSubscriptionInput, updatedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (endpoint, subscription_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET
          subscription_json = excluded.subscription_json,
          updated_at = excluded.updated_at`
      )
      .run(subscription.endpoint, JSON.stringify(subscription), updatedAt);
  }

  deletePushSubscription(endpoint: string): void {
    this.db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
  }

  listPushSubscriptions(): PushSubscriptionInput[] {
    const rows = this.db.prepare("SELECT endpoint, subscription_json FROM push_subscriptions ORDER BY endpoint").all() as unknown as PushSubscriptionRow[];
    return rows.map((row) => JSON.parse(row.subscription_json) as PushSubscriptionInput);
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
      const match = this.db
        .prepare(
          `SELECT 1 AS found
           FROM messages
           WHERE session_id = ?
             AND role = 'user'
             AND text = ?
             AND timestamp >= ?
           LIMIT 1`
        )
        .get(sessionId, row.text, row.sent_at ?? row.updated_at) as { found: number } | undefined;
      if (!match) continue;
      this.deleteQueuedInput(sessionId, row.id);
      deleted += 1;
    }

    return deleted;
  }

  nextSequence(sessionId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM messages WHERE session_id = ?")
      .get(sessionId) as { next: number };
    return row.next;
  }

  getParserOffset(source: string): number {
    const row = this.db.prepare("SELECT byte_offset FROM parser_offsets WHERE source = ?").get(source) as
      | { byte_offset: number }
      | undefined;
    return row?.byte_offset ?? 0;
  }

  hasParserOffset(source: string): boolean {
    const row = this.db.prepare("SELECT 1 AS found FROM parser_offsets WHERE source = ?").get(source) as
      | { found: number }
      | undefined;
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

      CREATE INDEX IF NOT EXISTS idx_messages_session_sequence ON messages(session_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_sessions_activity ON managed_sessions(last_activity_at);
      CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_openai_usage_created_at ON openai_usage_events(created_at);
      CREATE INDEX IF NOT EXISTS idx_queued_inputs_session_status ON queued_inputs(session_id, status, created_at);
      CREATE INDEX IF NOT EXISTS idx_notification_rules_session ON notification_rules(session_id);
    `);
    this.addColumnIfMissing("session_summaries", "prompt_version", "TEXT NOT NULL DEFAULT 'activity-summary-v1'");
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
    if (rows.some((row) => row.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function normalizePreviewText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
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
