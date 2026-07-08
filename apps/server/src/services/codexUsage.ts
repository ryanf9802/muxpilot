import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Logger } from "pino";
import type {
  CodexModel,
  CodexUsageAccount,
  CodexUsageLimit,
  CodexUsageSummaryResponse
} from "@muxpilot/core";
import { nowIso } from "../utils/time.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 3000;
const FIVE_HOUR_WINDOW_MINS = 5 * 60;
const WEEKLY_WINDOW_MINS = 7 * 24 * 60;
const MODEL_CACHE_TTL_MS = 60_000;
const MODEL_FAILURE_CACHE_TTL_MS = 10_000;

interface JsonRpcSuccess {
  id: string | number;
  result: unknown;
}

interface JsonRpcFailure {
  id: string | number;
  error: {
    message?: unknown;
  };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface CodexAppServerClientOptions {
  codexHome: string;
  timeoutMs?: number;
  logger?: Pick<Logger, "warn" | "debug">;
}

export interface AccountReadResponse {
  account: CodexAccount | null;
  requiresOpenaiAuth: boolean;
}

type CodexAccount =
  | { type: "chatgpt"; email: string | null; planType: string | null }
  | { type: "apiKey" }
  | { type: "amazonBedrock" }
  | { type: string };

export interface RateLimitsReadResponse {
  rateLimits: RateLimitSnapshot;
  rateLimitsByLimitId: Record<string, RateLimitSnapshot | undefined> | null;
}

export interface RateLimitSnapshot {
  limitId: string | null;
  limitName: string | null;
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
  planType: string | null;
}

export interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export class CodexUsageService {
  private readonly client: CodexAppServerClient;

  constructor(options: CodexAppServerClientOptions) {
    this.client = new CodexAppServerClient(options);
  }

  async summary(): Promise<CodexUsageSummaryResponse> {
    const refreshedAt = nowIso();
    try {
      const account = await this.client.request<AccountReadResponse>("account/read", { refreshToken: false });
      if (!account.account) {
        return unavailable("Codex account authentication required.", refreshedAt, normalizeAccount(account.account));
      }

      const rateLimits = await this.client.request<RateLimitsReadResponse>("account/rateLimits/read");
      const normalized = normalizeCodexUsage(account, rateLimits, refreshedAt);
      return normalized;
    } catch (error) {
      return unavailable(error instanceof Error ? error.message : "Codex usage is unavailable.", refreshedAt);
    }
  }

  stop(): void {
    this.client.stop();
  }
}

export class CodexModelsService {
  private readonly client: CodexAppServerClient;
  private cache: { models: CodexModel[]; expiresAt: number } | null = null;

  constructor(options: CodexAppServerClientOptions) {
    this.client = new CodexAppServerClient(options);
  }

  async listModels(): Promise<CodexModel[]> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) return this.cache.models;

    try {
      const models: CodexModel[] = [];
      let cursor: string | null = null;
      do {
        const response: RawModelListResponse = await this.client.request<RawModelListResponse>("model/list", { cursor, includeHidden: false });
        models.push(...normalizeCodexModels(response));
        cursor = typeof response.nextCursor === "string" && response.nextCursor ? response.nextCursor : null;
      } while (cursor);

      this.cache = { models, expiresAt: now + MODEL_CACHE_TTL_MS };
      return models;
    } catch {
      this.cache = { models: [], expiresAt: now + MODEL_FAILURE_CACHE_TTL_MS };
      return [];
    }
  }

  stop(): void {
    this.client.stop();
  }
}

export class CodexAppServerClient {
  private readonly codexHome: string;
  private readonly timeoutMs: number;
  private readonly logger?: Pick<Logger, "warn" | "debug">;
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextRequestId = 1;
  private initialized: Promise<void> | null = null;
  private stdoutBuffer = "";
  private readonly pending = new Map<string | number, PendingRequest>();

  constructor(options: CodexAppServerClientOptions) {
    this.codexHome = options.codexHome;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.logger = options.logger;
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    await this.ensureInitialized();
    return this.send<T>(method, params);
  }

  stop(): void {
    if (!this.child) return;
    this.child.kill();
    this.child = null;
    this.initialized = null;
    this.rejectPending(new Error("Codex app-server stopped."));
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      this.start();
      this.initialized = this.send("initialize", {
        clientInfo: { name: "muxpilot", title: "muxpilot", version: "0.1.0" },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          optOutNotificationMethods: [
            "thread/started",
            "thread/status/changed",
            "thread/tokenUsage/updated",
            "account/rateLimits/updated",
            "remoteControl/status/changed"
          ]
        }
      })
        .then(() => undefined)
        .catch((error) => {
          this.initialized = null;
          throw error;
        });
    }
    return this.initialized;
  }

  private start(): void {
    if (this.child) return;
    this.child = spawn("codex", ["app-server", "--stdio"], {
      env: { ...process.env, CODEX_HOME: this.codexHome },
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.handleStdout(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => this.logger?.debug({ stderr: chunk }, "codex app-server stderr"));
    this.child.on("error", (error) => this.handleExit(error));
    this.child.on("exit", (code, signal) => this.handleExit(new Error(`Codex app-server exited (${signal ?? code ?? "unknown"}).`)));
  }

  private send<T = unknown>(method: string, params?: unknown): Promise<T> {
    const child = this.child;
    if (!child) return Promise.reject(new Error("Codex app-server is not running."));
    const id = this.nextRequestId++;
    const request = params === undefined ? { id, method } : { id, method, params };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
        this.stop();
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer
      });
      child.stdin.write(`${JSON.stringify(request)}\n`);
    });
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line) this.handleMessageLine(line);
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleMessageLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.logger?.warn({ line }, "ignored non-json codex app-server output");
      return;
    }

    if (!isResponse(message)) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if ("error" in message) {
      pending.reject(new Error(typeof message.error.message === "string" ? message.error.message : "Codex app-server request failed."));
      return;
    }
    pending.resolve(message.result);
  }

  private handleExit(error: Error): void {
    this.logger?.debug({ error }, "codex app-server closed");
    this.child = null;
    this.initialized = null;
    this.rejectPending(error);
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

interface RawModelListResponse {
  data?: unknown;
  nextCursor?: unknown;
}

export function normalizeCodexModels(response: RawModelListResponse): CodexModel[] {
  if (!Array.isArray(response.data)) return [];
  return response.data
    .map((value) => {
      const model = recordValue(value);
      const slug = stringValue(model?.model) ?? stringValue(model?.id);
      if (!slug) return null;
      return {
        id: stringValue(model?.id) ?? slug,
        model: slug,
        displayName: stringValue(model?.displayName) ?? slug,
        description: stringValue(model?.description) ?? "",
        hidden: Boolean(model?.hidden),
        isDefault: Boolean(model?.isDefault),
        supportedReasoningEfforts: reasoningEffortOptions(model?.supportedReasoningEfforts),
        defaultReasoningEffort: stringValue(model?.defaultReasoningEffort)
      } satisfies CodexModel;
    })
    .filter((model): model is CodexModel => Boolean(model))
    .filter((model) => !model.hidden);
}

export function normalizeCodexUsage(
  accountResponse: AccountReadResponse,
  rateLimitsResponse: RateLimitsReadResponse,
  refreshedAt: string
): CodexUsageSummaryResponse {
  const snapshot = selectCodexRateLimitSnapshot(rateLimitsResponse);
  return {
    available: true,
    error: null,
    refreshedAt,
    account: normalizeAccount(accountResponse.account),
    limits: {
      fiveHour: snapshot ? selectLimit(snapshot, "5h limit", "fiveHour") : null,
      weekly: snapshot ? selectLimit(snapshot, "Weekly limit", "weekly") : null
    }
  };
}

export function selectCodexRateLimitSnapshot(response: RateLimitsReadResponse): RateLimitSnapshot | null {
  return response.rateLimitsByLimitId?.codex ?? response.rateLimits ?? null;
}

function selectLimit(snapshot: RateLimitSnapshot, label: string, kind: "fiveHour" | "weekly"): CodexUsageLimit | null {
  const candidates = [
    { window: snapshot.primary, limitName: snapshot.limitName },
    { window: snapshot.secondary, limitName: snapshot.limitName }
  ];
  const targetMins = kind === "fiveHour" ? FIVE_HOUR_WINDOW_MINS : WEEKLY_WINDOW_MINS;
  const byDuration = candidates.find((candidate) => candidate.window?.windowDurationMins === targetMins);
  const byPosition = kind === "fiveHour" ? candidates[0] : candidates[1];
  const byName = candidates.find((candidate) => matchesLimitName(snapshot.limitName, kind) && candidate.window);
  const selected = byDuration ?? byName ?? byPosition;
  if (!selected?.window) return null;
  const usedPercent = clampPercent(selected.window.usedPercent);
  return {
    label,
    limitName: selected.limitName,
    usedPercent,
    remainingPercent: usedPercent === null ? null : clampPercent(100 - usedPercent),
    windowDurationMins: selected.window.windowDurationMins,
    resetsAt: selected.window.resetsAt
  };
}

function matchesLimitName(name: string | null, kind: "fiveHour" | "weekly"): boolean {
  if (!name) return false;
  const normalized = name.toLowerCase();
  return kind === "fiveHour"
    ? normalized.includes("five") || normalized.includes("5h") || normalized.includes("5-hour")
    : normalized.includes("weekly") || normalized.includes("week");
}

function normalizeAccount(account: CodexAccount | null): CodexUsageAccount | null {
  if (!account) return null;
  if (account.type === "chatgpt" && "email" in account) return { kind: "chatgpt", email: account.email, planType: account.planType };
  if (account.type === "apiKey") return { kind: "apiKey", email: null, planType: null };
  if (account.type === "amazonBedrock") return { kind: "amazonBedrock", email: null, planType: null };
  return { kind: "unknown", email: null, planType: null };
}

function unavailable(error: string, refreshedAt: string, account: CodexUsageAccount | null = null): CodexUsageSummaryResponse {
  return {
    available: false,
    error,
    refreshedAt,
    account,
    limits: { fiveHour: null, weekly: null }
  };
}

function clampPercent(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, value));
}

function isResponse(value: unknown): value is JsonRpcSuccess | JsonRpcFailure {
  if (!value || typeof value !== "object" || !("id" in value)) return false;
  return "result" in value || "error" in value;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function reasoningEffortOptions(value: unknown): CodexModel["supportedReasoningEfforts"] {
  if (!Array.isArray(value)) return [];
  return value
    .map((option) => {
      const record = recordValue(option);
      const reasoningEffort = stringValue(record?.reasoningEffort);
      if (!reasoningEffort) return null;
      return {
        reasoningEffort,
        description: stringValue(record?.description) ?? ""
      };
    })
    .filter((option): option is CodexModel["supportedReasoningEfforts"][number] => Boolean(option));
}
