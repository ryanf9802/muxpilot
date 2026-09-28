import { mkdir, open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import type { Options, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentModel,
  ProviderModelCatalogResponse,
  ProviderTokenUsageResponse,
  ProviderUsageAccount,
  ProviderUsageLimit,
  ProviderUsageSummary,
  SessionModelSelections
} from "@muxpilot/core";
import { nowIso } from "../../utils/time.js";
import type { ProviderModelCatalog, ProviderUsageService } from "../types.js";
import { InputQueue, type QueryFactory } from "./host/hostSession.js";

const CONTROL_TIMEOUT_MS = 15_000;
const CONTROL_IDLE_MS = 5 * 60_000;
const USAGE_CACHE_MS = 10_000;
const MODEL_CACHE_MS = 60_000;
const HISTORY_CACHE_MS = 60_000;

const LIMITS: Array<{ key: string; id: string; label: string; windowDurationMins: number }> = [
  { key: "five_hour", id: "five_hour", label: "5h limit", windowDurationMins: 300 },
  { key: "seven_day", id: "weekly", label: "Weekly limit", windowDurationMins: 10_080 },
  { key: "seven_day_opus", id: "weekly_opus", label: "Weekly Opus limit", windowDurationMins: 10_080 },
  { key: "seven_day_sonnet", id: "weekly_sonnet", label: "Weekly Sonnet limit", windowDurationMins: 10_080 }
];

export interface ClaudeControlOptions {
  claudePath: string;
  configDir: string;
  environment: Record<string, string | undefined>;
  /** Private working directory for the idle control session. */
  workDir: string;
  queryFactory: QueryFactory;
  logger?: Pick<Logger, "warn" | "debug">;
}

class ControlSessionReplacedError extends Error {}

/**
 * An idle Claude SDK session used only for control requests (account, models, plan usage). No user message is
 * ever sent, so it makes no model calls and persists no transcript.
 */
export class ClaudeControlClient {
  private query: Query | null = null;
  private input: InputQueue | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: ClaudeControlOptions) {}

  async run<T>(operation: (query: Query) => Promise<T>): Promise<T> {
    try {
      return await this.runOnce(operation);
    } catch (error) {
      if (!(error instanceof ControlSessionReplacedError)) throw error;
      // An account change restarted the control session mid-request; ask the new session once.
      return (await this.runOnce(operation, false));
    }
  }

  private async runOnce<T>(operation: (query: Query) => Promise<T>, retryable = true): Promise<T> {
    const query = await this.ensureQuery();
    this.touch();
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        operation(query),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Claude control request timed out")), CONTROL_TIMEOUT_MS);
        })
      ]);
    } catch (error) {
      if (this.query !== query) {
        if (retryable) throw new ControlSessionReplacedError();
        throw error;
      }
      this.stop();
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Restarts the control session so the next request observes the current account. */
  invalidate(): void {
    this.stop();
  }

  stop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.input?.close();
    this.query?.close();
    this.query = null;
    this.input = null;
  }

  private async ensureQuery(): Promise<Query> {
    if (this.query) return this.query;
    await mkdir(this.options.workDir, { recursive: true, mode: 0o700 });
    const input = new InputQueue();
    const options: Options = {
      cwd: this.options.workDir,
      pathToClaudeCodeExecutable: this.options.claudePath,
      env: { ...this.options.environment, CLAUDE_CONFIG_DIR: this.options.configDir },
      persistSession: false,
      settingSources: [],
      tools: [],
      permissionMode: "default",
      stderr: (data) => this.options.logger?.debug({ stderr: data.slice(0, 500) }, "claude control stderr")
    };
    this.input = input;
    this.query = this.options.queryFactory({ prompt: input as AsyncIterable<SDKUserMessage>, options });
    return this.query;
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), CONTROL_IDLE_MS);
    this.idleTimer.unref?.();
  }
}

/** Claude plan usage from the SDK usage probe, refreshed by live rate-limit events from running sessions. */
export class ClaudeUsageService implements ProviderUsageService {
  private cache: { summary: ProviderUsageSummary; expiresAt: number } | null = null;
  private inFlight: Promise<ProviderUsageSummary> | null = null;
  private readonly live = new Map<string, { usedPercent: number; resetsAt: number | null; observedAt: number }>();

  constructor(
    private readonly control: ClaudeControlClient,
    private readonly history: ClaudeTokenHistory,
    private readonly now: () => number = () => Date.now()
  ) {}

  async summary(force = false): Promise<ProviderUsageSummary> {
    if (!force && this.cache && this.cache.expiresAt > this.now()) return this.withLive(this.cache.summary);
    if (!force && this.inFlight) return this.withLive(await this.inFlight);
    const request = this.load();
    this.inFlight = request;
    try {
      const summary = await request;
      this.cache = { summary, expiresAt: this.now() + USAGE_CACHE_MS };
      return this.withLive(summary);
    } finally {
      if (this.inFlight === request) this.inFlight = null;
    }
  }

  tokenUsage(days: 7 | 30, force = false): Promise<ProviderTokenUsageResponse> {
    return this.history.tokenUsage(days, force);
  }

  /**
   * Records a `rate_limit_event` reported by a live Claude session. The SDK reports one window per event
   * (`rateLimitType`, `utilization`, `resetsAt`); a `unifiedWindows` map is also accepted.
   */
  observeRateLimit(info: Record<string, unknown>): void {
    const windows = objectValue(info.unifiedWindows)
      ?? (typeof info.rateLimitType === "string" ? { [info.rateLimitType]: info } : null);
    const observedAt = this.now();
    for (const limit of LIMITS) {
      const window = objectValue(windows?.[limit.key]);
      const utilization = numberValue(window?.utilization);
      if (utilization === null) continue;
      this.live.set(limit.id, {
        usedPercent: clampPercent(utilization <= 1 ? utilization * 100 : utilization),
        resetsAt: numberValue(window?.resetsAt),
        observedAt
      });
    }
  }

  invalidateAuthentication(): void {
    this.cache = null;
    this.inFlight = null;
    this.live.clear();
    this.control.invalidate();
  }

  stop(): void {
    this.control.stop();
  }

  private async load(): Promise<ProviderUsageSummary> {
    const refreshedAt = nowIso();
    let account: ProviderUsageAccount | null = null;
    try {
      const info = await this.control.run((query) => query.accountInfo());
      account = usageAccount(info as unknown as Record<string, unknown>);
      const usage = await this.control.run((query) => query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }));
      const rateLimits = objectValue((usage as unknown as Record<string, unknown>).rate_limits);
      if (account && !account.planType) account.planType = stringValue((usage as unknown as Record<string, unknown>).subscription_type);
      return {
        provider: "claude",
        available: true,
        error: null,
        refreshedAt,
        accountStatus: "authenticated",
        account,
        limits: LIMITS.flatMap((limit) => {
          const window = objectValue(rateLimits?.[limit.key]);
          const utilization = numberValue(window?.utilization);
          if (!window || utilization === null) return [];
          const resetsAt = stringValue(window.resets_at);
          const usedPercent = clampPercent(utilization);
          return [{
            id: limit.id,
            label: limit.label,
            limitName: null,
            usedPercent,
            remainingPercent: clampPercent(100 - usedPercent),
            windowDurationMins: limit.windowDurationMins,
            resetsAt: resetsAt ? Math.floor(Date.parse(resetsAt) / 1_000) : null
          } satisfies ProviderUsageLimit];
        }),
        resetCredits: null
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Claude usage is unavailable.";
      return {
        provider: "claude",
        available: false,
        error: message,
        refreshedAt,
        accountStatus: /not logged in|\/login|authentication/i.test(message) ? "signed_out" : account ? "authenticated" : "unknown",
        account,
        limits: [],
        resetCredits: null
      };
    }
  }

  /** Newer live observations override the last probe for matching limits. */
  private withLive(summary: ProviderUsageSummary): ProviderUsageSummary {
    if (this.live.size === 0) return summary;
    const probedAt = Date.parse(summary.refreshedAt);
    const limits = summary.limits.map((limit) => {
      const live = this.live.get(limit.id);
      if (!live || live.observedAt <= probedAt) return limit;
      return {
        ...limit,
        usedPercent: live.usedPercent,
        remainingPercent: clampPercent(100 - live.usedPercent),
        resetsAt: live.resetsAt ?? limit.resetsAt
      };
    });
    for (const definition of LIMITS) {
      const live = this.live.get(definition.id);
      if (!live || limits.some((limit) => limit.id === definition.id)) continue;
      limits.push({
        id: definition.id,
        label: definition.label,
        limitName: null,
        usedPercent: live.usedPercent,
        remainingPercent: clampPercent(100 - live.usedPercent),
        windowDurationMins: definition.windowDurationMins,
        resetsAt: live.resetsAt
      });
    }
    return { ...summary, limits };
  }
}

export class ClaudeModelsService implements ProviderModelCatalog {
  private cache: { catalog: ProviderModelCatalogResponse; expiresAt: number } | null = null;

  constructor(private readonly control: ClaudeControlClient) {}

  async catalog(): Promise<ProviderModelCatalogResponse> {
    if (this.cache && this.cache.expiresAt > Date.now()) return this.cache.catalog;
    try {
      const models = (await this.control.run((query) => query.supportedModels())).map((model): AgentModel => {
        const efforts = model.supportsEffort === false ? [] : model.supportedEffortLevels ?? [];
        return {
          id: model.value,
          model: model.value,
          displayName: model.displayName,
          description: model.description,
          hidden: false,
          isDefault: model.value === "default",
          supportedReasoningEfforts: efforts.map((effort) => ({ reasoningEffort: effort, description: effortDescription(effort) })),
          defaultReasoningEffort: efforts.includes("high") ? "high" : efforts[0] ?? null,
          supportsFastMode: model.supportsFastMode === true
        };
      });
      const preferred = models.find((model) => model.isDefault) ?? models[0] ?? null;
      const defaults: SessionModelSelections = {
        default: { model: preferred?.model ?? null, reasoningEffort: preferred?.defaultReasoningEffort ?? null },
        plan: { model: preferred?.model ?? null, reasoningEffort: preferred?.defaultReasoningEffort ?? null }
      };
      const catalog: ProviderModelCatalogResponse = { provider: "claude", models, defaults };
      this.cache = { catalog, expiresAt: Date.now() + MODEL_CACHE_MS };
      return catalog;
    } catch {
      const empty: ProviderModelCatalogResponse = {
        provider: "claude",
        models: [],
        defaults: { default: { model: null, reasoningEffort: null }, plan: { model: null, reasoningEffort: null } }
      };
      this.cache = { catalog: empty, expiresAt: Date.now() + 10_000 };
      return empty;
    }
  }

  invalidateAuthentication(): void {
    this.cache = null;
  }

  stop(): void {
    // The shared control client is stopped by the usage service.
  }
}

interface FileUsage {
  size: number;
  mtimeMs: number;
  offset: number;
  daily: Map<string, number>;
  seen: Set<string>;
}

/** Daily Claude token totals aggregated incrementally from local session transcripts. */
export class ClaudeTokenHistory {
  private readonly files = new Map<string, FileUsage>();
  private cache: { response: Omit<ProviderTokenUsageResponse, "days" | "points"> & { daily: Map<string, number> }; expiresAt: number } | null = null;

  constructor(private readonly projectsDir: string) {}

  async tokenUsage(days: 7 | 30, force = false): Promise<ProviderTokenUsageResponse> {
    try {
      if (force || !this.cache || this.cache.expiresAt <= Date.now()) await this.refresh();
      const { daily, ...response } = this.cache!.response;
      return { ...response, days, points: recentDays(daily, days) };
    } catch (error) {
      return {
        provider: "claude",
        available: false,
        error: error instanceof Error ? error.message : "Claude token history is unavailable.",
        refreshedAt: nowIso(),
        days,
        summary: null,
        points: null
      };
    }
  }

  private async refresh(): Promise<void> {
    const paths = await transcriptFiles(this.projectsDir);
    for (const path of paths) await this.scan(path);
    for (const path of this.files.keys()) if (!paths.includes(path)) this.files.delete(path);
    const daily = new Map<string, number>();
    for (const usage of this.files.values()) {
      for (const [day, tokens] of usage.daily) daily.set(day, (daily.get(day) ?? 0) + tokens);
    }
    const values = [...daily.values()];
    const streaks = dayStreaks(daily);
    this.cache = {
      response: {
        provider: "claude",
        available: true,
        error: null,
        refreshedAt: nowIso(),
        summary: {
          lifetimeTokens: values.reduce((total, value) => total + value, 0),
          peakDailyTokens: values.length > 0 ? Math.max(...values) : 0,
          longestRunningTurnSec: null,
          currentStreakDays: streaks.current,
          longestStreakDays: streaks.longest
        },
        daily
      },
      expiresAt: Date.now() + HISTORY_CACHE_MS
    };
  }

  private async scan(path: string): Promise<void> {
    const metadata = await stat(path).catch(() => null);
    if (!metadata?.isFile()) return;
    let usage = this.files.get(path);
    if (usage && usage.size === metadata.size && usage.mtimeMs === metadata.mtimeMs) return;
    if (!usage || metadata.size < usage.offset) {
      usage = { size: 0, mtimeMs: 0, offset: 0, daily: new Map(), seen: new Set() };
      this.files.set(path, usage);
    }
    const file = await open(path, "r");
    try {
      const length = metadata.size - usage.offset;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, usage.offset);
      const text = buffer.subarray(0, bytesRead).toString("utf8");
      const complete = text.lastIndexOf("\n") + 1;
      for (const line of text.slice(0, complete).split("\n")) {
        if (!line.includes('"usage"')) continue;
        try {
          const record = JSON.parse(line) as Record<string, unknown>;
          const message = objectValue(record.message);
          const tokens = objectValue(message?.usage);
          const id = stringValue(message?.id);
          const timestamp = stringValue(record.timestamp);
          if (record.type !== "assistant" || !tokens || !id || !timestamp || usage.seen.has(id)) continue;
          usage.seen.add(id);
          const total = (numberValue(tokens.input_tokens) ?? 0)
            + (numberValue(tokens.cache_creation_input_tokens) ?? 0)
            + (numberValue(tokens.output_tokens) ?? 0);
          const day = timestamp.slice(0, 10);
          usage.daily.set(day, (usage.daily.get(day) ?? 0) + total);
        } catch {
          // Partial or foreign records do not contribute usage.
        }
      }
      usage.offset += Buffer.byteLength(text.slice(0, complete));
      usage.size = metadata.size;
      usage.mtimeMs = metadata.mtimeMs;
    } finally {
      await file.close();
    }
  }
}

async function transcriptFiles(root: string): Promise<string[]> {
  const projects = await readdir(root, { withFileTypes: true }).catch(() => []);
  const files = await Promise.all(projects.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const directory = join(root, entry.name);
    const children = await readdir(directory, { withFileTypes: true }).catch(() => []);
    return children.filter((child) => child.isFile() && child.name.endsWith(".jsonl")).map((child) => join(directory, child.name));
  }));
  return files.flat();
}

function recentDays(daily: Map<string, number>, days: number): Array<{ date: string; tokens: number }> {
  const points: Array<{ date: string; tokens: number }> = [];
  const today = new Date();
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - offset)).toISOString().slice(0, 10);
    points.push({ date, tokens: daily.get(date) ?? 0 });
  }
  return points;
}

function dayStreaks(daily: Map<string, number>): { current: number; longest: number } {
  const active = new Set([...daily].filter(([, tokens]) => tokens > 0).map(([day]) => day));
  let longest = 0;
  let run = 0;
  let previous: number | null = null;
  for (const day of [...active].sort()) {
    const value = Date.parse(`${day}T00:00:00Z`);
    run = previous !== null && value - previous === 86_400_000 ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = value;
  }
  let current = 0;
  const cursor = new Date();
  for (;;) {
    const day = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate() - current)).toISOString().slice(0, 10);
    if (!active.has(day)) break;
    current += 1;
  }
  return { current, longest };
}

function usageAccount(info: Record<string, unknown>): ProviderUsageAccount {
  const provider = stringValue(info.apiProvider);
  const kind = provider && provider !== "firstParty"
    ? provider
    : (stringValue(info.subscriptionType) || stringValue(info.tokenSource) === "oauth") ? "claudeAi" : "apiKey";
  return { kind, email: stringValue(info.email), planType: stringValue(info.subscriptionType) };
}

function effortDescription(effort: string): string {
  switch (effort) {
    case "low": return "Fastest responses with minimal thinking";
    case "medium": return "Balanced thinking";
    case "high": return "Deep reasoning";
    case "xhigh": return "Deeper reasoning";
    case "max": return "Maximum effort";
    default: return effort;
  }
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
