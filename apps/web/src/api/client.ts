import type {
  ApprovalResponse,
  ActivitySummarySettingsResponse,
  CodexModelsResponse,
  CodexSkillsResponse,
  CodexUsageSummaryResponse,
  CollaborationMode,
  AccessResponse,
  ConnectivityResponse,
  CreateSessionRequest,
  ManagedSession,
  MeResponse,
  OpenAIUsageSummaryResponse,
  QueuedInput,
  QueuedInputResponse,
  QuestionAnswerRequest,
  RemoteAccessResponse,
  QuestionResponse,
  ResolveApprovalRequest,
  SessionDirectoriesResponse,
  SessionActionResponse,
  SessionAction,
  TranscriptPageResponse,
  UpdateActivitySummarySettingsRequest,
  UpdateRemoteAccessSettingsRequest
} from "@muxpilot/core";

export const AUTH_EXPIRED_EVENT = "muxpilot-auth-expired";

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
  if (init?.body !== undefined && !headers.has("Content-Type")) {
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
  before?: number;
  limit?: number;
  position?: "oldest";
}

export const api = {
  me: () => json<MeResponse>("/api/me"),
  access: (accessKey: string) =>
    json<AccessResponse>("/api/access", { method: "POST", body: JSON.stringify({ accessKey }) }),
  logout: () => json<{ ok: true }>("/api/logout", { method: "POST" }),
  connectivity: () => json<ConnectivityResponse>("/api/connectivity"),
  remoteAccess: () => json<RemoteAccessResponse>("/api/remote-access"),
  revokeRemoteAccess: () => json<RemoteAccessResponse>("/api/remote-access/revoke", { method: "POST" }),
  updateRemoteAccessSettings: (request: UpdateRemoteAccessSettingsRequest) =>
    json<RemoteAccessResponse>("/api/remote-access/settings", { method: "PATCH", body: JSON.stringify(request) }),
  codexSkills: (sessionId?: string) => json<CodexSkillsResponse>(sessionId ? `/api/sessions/${sessionId}/skills` : "/api/codex/skills"),
  codexModels: () => json<CodexModelsResponse>("/api/codex/models"),
  sessions: (q = "", status = "") =>
    json<{ sessions: ManagedSession[] }>(`/api/sessions?q=${encodeURIComponent(q)}&status=${encodeURIComponent(status)}`),
  sessionDirectories: () => json<SessionDirectoriesResponse>("/api/session-directories"),
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
    json<SessionActionResponse>(`/api/sessions/${id}/actions`, { method: "POST", body: JSON.stringify(action) })
};

function messageQueryString(query: MessageQuery): string {
  const params = new URLSearchParams();
  if (query.after !== undefined) params.set("after", String(query.after));
  if (query.before !== undefined) params.set("before", String(query.before));
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.position !== undefined) params.set("position", query.position);
  const value = params.toString();
  return value ? `?${value}` : "";
}

export function eventSocket(): WebSocket {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return new WebSocket(`${proto}://${location.host}/api/events`);
}
