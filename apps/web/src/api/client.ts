import type {
  ApprovalResponse,
  ActivitySummarySettingsResponse,
  CodexSkillsResponse,
  CodexUsageSummaryResponse,
  CollaborationMode,
  AccessResponse,
  ConnectivityResponse,
  CreateSessionRequest,
  GitRepositoryProbe,
  MuxpilotGitSkillStatus,
  ManagedSession,
  MeResponse,
  NotificationSettings,
  OpenAIUsageSummaryResponse,
  PromptHistoryResponse,
  PushKeyResponse,
  PushSubscriptionInput,
  QueuedInput,
  QueuedInputResponse,
  QuestionAnswerRequest,
  RemoteAccessResponse,
  RestoreSessionResponse,
  QuestionResponse,
  ResolveApprovalRequest,
  SessionDirectoriesResponse,
  SessionHistoryResponse,
  SessionActionResponse,
  SessionAction,
  SessionTransferImportRequest,
  SessionTransferImportResponse,
  SessionTransferInspectResponse,
  TranscriptPageResponse,
  TranscriptSearchResponse,
  UpdateNotificationSettingRequest,
  UpdateActivitySummarySettingsRequest,
  UpdateRemoteAccessSettingsRequest
} from "@muxpilot/core";

export const AUTH_EXPIRED_EVENT = "muxpilot-auth-expired";
const NOTIFICATION_DEVICE_ID_STORAGE_KEY = "muxpilot.notification-device-id.v1";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function isUnauthorizedError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(url, {
    ...init,
    credentials: "include",
    headers
  });
  if (!response.ok) {
    if (response.status === 401) dispatchAuthExpired();
    throw new ApiError((await response.text()) || response.statusText, response.status);
  }
  return (await response.json()) as T;
}

function dispatchAuthExpired(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
}

interface MessageQuery {
  after?: number;
  around?: number;
  before?: number;
  limit?: number;
  position?: "oldest";
}

export const api = {
  me: (signal?: AbortSignal) => json<MeResponse>("/api/me", { signal }),
  access: (accessKey: string) =>
    json<AccessResponse>("/api/access", { method: "POST", body: JSON.stringify({ accessKey }) }),
  logout: () => json<{ ok: true }>("/api/logout", { method: "POST" }),
  connectivity: () => json<ConnectivityResponse>("/api/connectivity"),
  remoteAccess: () => json<RemoteAccessResponse>("/api/remote-access"),
  revokeRemoteAccess: () => json<RemoteAccessResponse>("/api/remote-access/revoke", { method: "POST" }),
  updateRemoteAccessSettings: (request: UpdateRemoteAccessSettingsRequest) =>
    json<RemoteAccessResponse>("/api/remote-access/settings", { method: "PATCH", body: JSON.stringify(request) }),
  notificationSettings: () => json<NotificationSettings>(`/api/notifications/settings?deviceId=${encodeURIComponent(notificationDeviceId())}`),
  updateNotificationSetting: (request: UpdateNotificationSettingRequest) =>
    json<NotificationSettings>("/api/notifications/settings", { method: "PATCH", body: JSON.stringify(request) }),
  notificationPushKey: () => json<PushKeyResponse>("/api/notifications/push-key"),
  upsertPushSubscription: (request: PushSubscriptionInput) =>
    json<{ ok: true }>(`/api/notifications/push-subscriptions?deviceId=${encodeURIComponent(notificationDeviceId())}`, { method: "POST", body: JSON.stringify(request) }),
  deletePushSubscription: (endpoint: string) =>
    json<{ ok: true }>(`/api/notifications/push-subscriptions?deviceId=${encodeURIComponent(notificationDeviceId())}`, { method: "DELETE", body: JSON.stringify({ endpoint }) }),
  codexSkills: (sessionId?: string) => json<CodexSkillsResponse>(sessionId ? `/api/sessions/${sessionId}/skills` : "/api/codex/skills"),
  gitWorkflowSkillStatus: () => json<MuxpilotGitSkillStatus>("/api/codex/skills/muxpilot-git-workflow/status"),
  sessions: (q = "", status = "") =>
    json<{ sessions: ManagedSession[] }>(`/api/sessions?q=${encodeURIComponent(q)}&status=${encodeURIComponent(status)}`),
  transferableSessions: () => json<{ sessions: ManagedSession[] }>("/api/sessions?includeArchived=true&includeAll=true"),
  promptHistory: (q = "", limit = 30) => json<PromptHistoryResponse>(`/api/prompt-history?q=${encodeURIComponent(q)}&limit=${limit}`),
  sessionHistory: (q = "", limit = 40) => json<SessionHistoryResponse>(`/api/session-history?q=${encodeURIComponent(q)}&limit=${limit}`),
  restoreSession: (id: string) =>
    json<RestoreSessionResponse>(`/api/session-history/${encodeURIComponent(id)}/restore`, { method: "POST" }),
  sessionDirectories: () => json<SessionDirectoriesResponse>("/api/session-directories"),
  dismissSessionDirectory: (path: string) =>
    json<{ ok: true }>("/api/session-directories", { method: "DELETE", body: JSON.stringify({ path }) }),
  sessionTransferStatus: () => json<{ encryptionEnabled: boolean }>("/api/session-transfers/status"),
  inspectSessionTransfer: async (file: File) => {
    const response = await fetch("/api/session-transfers/inspect", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/vnd.muxpilot.session" },
      body: file
    });
    if (!response.ok) throw new ApiError(await responseError(response), response.status);
    return await response.json() as SessionTransferInspectResponse;
  },
  importSessionTransfer: (request: SessionTransferImportRequest) =>
    json<SessionTransferImportResponse>("/api/session-transfers/import", { method: "POST", body: JSON.stringify(request) }),
  cancelSessionTransfer: (token: string) =>
    json<{ ok: true }>(`/api/session-transfers/${encodeURIComponent(token)}`, { method: "DELETE" }),
  exportSessionTransfer: async (sessionIds: string[]) => {
    const response = await fetch("/api/session-transfers/export", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionIds })
    });
    if (!response.ok) throw new ApiError(await responseError(response), response.status);
    return { blob: await response.blob(), filename: downloadFilename(response.headers.get("Content-Disposition")) };
  },
  gitRepositoryProbe: (cwd: string) => json<GitRepositoryProbe>(`/api/git/repository-probe?cwd=${encodeURIComponent(cwd)}`),
  createSession: (request: CreateSessionRequest) =>
    json<{ session: ManagedSession }>("/api/sessions", { method: "POST", body: JSON.stringify(request) }),
  openaiUsageSummary: (days = 30) => json<OpenAIUsageSummaryResponse>(`/api/openai-usage/summary?days=${days}`),
  updateActivitySummarySettings: (request: UpdateActivitySummarySettingsRequest) =>
    json<ActivitySummarySettingsResponse>("/api/activity-summaries/settings", {
      method: "PATCH",
      body: JSON.stringify(request)
    }),
  codexUsageSummary: () => json<CodexUsageSummaryResponse>("/api/codex-usage/summary"),
  session: (id: string) => json<{ session: ManagedSession }>(`/api/sessions/${id}`),
  messages: (id: string, query: MessageQuery = {}) =>
    json<TranscriptPageResponse>(`/api/sessions/${id}/messages${messageQueryString(query)}`),
  messageSearch: (id: string, query: string, limit = 100) =>
    json<TranscriptSearchResponse>(`/api/sessions/${id}/messages/search?q=${encodeURIComponent(query)}&limit=${limit}`),
  messageRange: (id: string, from: number, to: number) =>
    json<TranscriptPageResponse>(`/api/sessions/${id}/messages/range?from=${from}&to=${to}`),
  approval: (id: string) => json<ApprovalResponse>(`/api/sessions/${id}/approval`),
  resolveApproval: (id: string, request: ResolveApprovalRequest) =>
    json<{ ok: true }>(`/api/sessions/${id}/approval`, { method: "POST", body: JSON.stringify(request) }),
  question: (id: string) => json<QuestionResponse>(`/api/sessions/${id}/question`),
  answerQuestion: (id: string, request: QuestionAnswerRequest) =>
    json<{ ok: true }>(`/api/sessions/${id}/question`, { method: "POST", body: JSON.stringify(request) }),
  queuedInputs: (id: string) => json<QueuedInputResponse>(`/api/sessions/${id}/queued-inputs`),
  enqueueInput: (id: string, text: string, mode?: CollaborationMode) =>
    json<{ queuedInput: QueuedInput }>(`/api/sessions/${id}/queued-inputs`, { method: "POST", body: JSON.stringify({ text, mode }) }),
  updateQueuedInput: (id: string, queuedId: string, text: string, mode?: CollaborationMode) =>
    json<{ queuedInput: QueuedInput }>(`/api/sessions/${id}/queued-inputs/${queuedId}`, {
      method: "PATCH",
      body: JSON.stringify({ text, mode })
    }),
  deleteQueuedInput: (id: string, queuedId: string) =>
    json<{ ok: true }>(`/api/sessions/${id}/queued-inputs/${queuedId}`, { method: "DELETE" }),
  send: (id: string, text: string, mode?: CollaborationMode) =>
    json<{ ok: true }>(`/api/sessions/${id}/input`, { method: "POST", body: JSON.stringify({ text, mode }) }),
  action: (id: string, action: SessionAction) =>
    json<SessionActionResponse>(`/api/sessions/${id}/actions`, { method: "POST", body: JSON.stringify(action) }),
};

async function responseError(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as { error?: string };
    return parsed.error ?? text;
  } catch { return text || response.statusText; }
}

function downloadFilename(disposition: string | null): string {
  return disposition?.match(/filename="([^"]+)"/)?.[1] ?? "muxpilot-sessions.mpsession";
}

function messageQueryString(query: MessageQuery): string {
  const params = new URLSearchParams();
  if (query.after !== undefined) params.set("after", String(query.after));
  if (query.around !== undefined) params.set("around", String(query.around));
  if (query.before !== undefined) params.set("before", String(query.before));
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.position !== undefined) params.set("position", query.position);
  const value = params.toString();
  return value ? `?${value}` : "";
}

export function eventSocket(): WebSocket {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return new WebSocket(`${proto}://${location.host}/api/events?deviceId=${encodeURIComponent(notificationDeviceId())}`);
}

export function notificationDeviceId(): string {
  if (typeof window === "undefined") return fallbackNotificationDeviceId();
  try {
    const existing = window.localStorage.getItem(NOTIFICATION_DEVICE_ID_STORAGE_KEY);
    if (existing && isNotificationDeviceId(existing)) return existing;
    const next = newNotificationDeviceId();
    window.localStorage.setItem(NOTIFICATION_DEVICE_ID_STORAGE_KEY, next);
    return next;
  } catch {
    return fallbackNotificationDeviceId();
  }
}

function newNotificationDeviceId(): string {
  const randomId = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  return `device-${randomId.replace(/[^a-zA-Z0-9_-]/g, "")}`.slice(0, 80);
}

function fallbackNotificationDeviceId(): string {
  return "device-fallback";
}

function isNotificationDeviceId(value: string): boolean {
  return /^[a-zA-Z0-9_-]{8,80}$/.test(value);
}
