import type { ChatMessage, ManagedSession } from "@muxpilot/core";
import type { AppDatabase } from "../db/database.js";
import { eventId } from "../utils/ids.js";
import { nowIso } from "../utils/time.js";
import { estimateOpenAICost, type OpenAIModelPricingTable } from "./openaiPricing.js";

export const ACTIVITY_SUMMARY_PROMPT_VERSION = "activity-summary-v4-session-content-only";

export interface SummaryModelClient {
  summarize(input: ActivitySummaryInput): Promise<ActivitySummaryResult>;
}

export interface ActivitySummaryInput {
  session: ManagedSession;
  prompts: ChatMessage[];
}

export interface ActivitySummaryResult {
  text: string;
  usage?: OpenAIResponseUsage;
}

export interface OpenAIResponseUsage {
  model: string;
  responseId: string | null;
  createdAt: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

interface ActivitySummarizerOptions {
  db: AppDatabase;
  client: SummaryModelClient | null;
  pricingTable?: OpenAIModelPricingTable;
  debounceMs: number;
  intervalMs: number;
  enabled?: boolean;
  onSummaryUpdated: (sessionId: string) => void;
  now?: () => string;
  logger?: Pick<Console, "warn">;
}

export class ActivitySummarizer {
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private readonly inFlight = new Set<string>();
  private readonly now: () => string;
  private readonly logger: Pick<Console, "warn">;
  private enabled: boolean;

  constructor(private readonly options: ActivitySummarizerOptions) {
    this.now = options.now ?? nowIso;
    this.logger = options.logger ?? console;
    this.enabled = options.enabled ?? true;
  }

  schedule(sessionId: string, delayMs = this.options.debounceMs): void {
    if (!this.enabled) return;
    if (!this.options.client) return;
    const existing = this.pending.get(sessionId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.pending.delete(sessionId);
      void this.refresh(sessionId);
    }, Math.max(0, delayMs));
    this.pending.set(sessionId, timer);
  }

  stop(): void {
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.stop();
  }

  async refresh(sessionId: string): Promise<boolean> {
    if (!this.enabled) return false;
    const client = this.options.client;
    if (!client || this.inFlight.has(sessionId)) return false;

    const session = await this.options.db.getSession(sessionId);
    if (!session || session.archived || session.status === "missing") return false;

    const latestSequence = await this.options.db.latestMessageSequence(sessionId);
    if (latestSequence === 0) return false;

    const existing = await this.options.db.getActivitySummary(sessionId);
    const currentPrompt = existing?.prompt_version === ACTIVITY_SUMMARY_PROMPT_VERSION;
    if (existing && currentPrompt && existing.source_sequence >= latestSequence) return false;

    const remainingCooldown = currentPrompt ? this.remainingCooldownMs(existing?.generated_at ?? null) : 0;
    if (remainingCooldown > 0) {
      this.schedule(sessionId, remainingCooldown);
      return false;
    }

    const prompts = await this.options.db.listRecentUserPromptsForSummary(sessionId);
    if (prompts.length === 0) return false;
    const source = sessionSummarySource(session);

    this.inFlight.add(sessionId);
    try {
      const result = await client.summarize({ session, prompts });
      const summary = normalizeSummary(result.text);
      if (!summary) return false;
      const currentSession = await this.options.db.getSession(sessionId);
      if (!currentSession || currentSession.archived || currentSession.status === "missing") return false;
      if (!sameSessionSummarySource(source, sessionSummarySource(currentSession))) {
        if ((await this.options.db.latestMessageSequence(sessionId)) > 0) this.schedule(sessionId, 0);
        return false;
      }
      if (result.usage) await this.recordUsage(sessionId, result.usage);
      await this.options.db.upsertActivitySummary(sessionId, summary, this.now(), latestSequence, ACTIVITY_SUMMARY_PROMPT_VERSION);
      this.options.onSummaryUpdated(sessionId);
      return true;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Activity summary failed for ${sessionId}: ${text}`);
      return false;
    } finally {
      this.inFlight.delete(sessionId);
    }
  }

  private remainingCooldownMs(generatedAt: string | null): number {
    if (!generatedAt) return 0;
    const generatedAtMs = Date.parse(generatedAt);
    if (!Number.isFinite(generatedAtMs)) return 0;
    const elapsed = Date.parse(this.now()) - generatedAtMs;
    return Math.max(0, this.options.intervalMs - elapsed);
  }

  private async recordUsage(sessionId: string, usage: OpenAIResponseUsage): Promise<void> {
    const estimate = estimateOpenAICost(this.options.pricingTable ?? {}, usage.model, usage);
    await this.options.db.recordOpenAIUsage({
      id: eventId(),
      source: "activity_summary",
      sourceId: sessionId,
      model: usage.model,
      responseId: usage.responseId,
      createdAt: usage.createdAt,
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      estimatedCostUsd: estimate.estimatedCostUsd,
      pricingStatus: estimate.pricingStatus
    });
  }
}

export class OpenAIActivitySummaryClient implements SummaryModelClient {
  constructor(
    private readonly apiKey: string,
    private readonly model: string
  ) {}

  async summarize(input: ActivitySummaryInput): Promise<ActivitySummaryResult> {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: this.model,
        input: [
          {
            role: "system",
            content:
              "Write compact memory joggers for a Codex session dashboard using only the user's prompts. Be brief and concrete. Use keywords, filenames, ticket ids, UI labels, errors, and domain terms from the prompts. Start with the object or problem. Do not mention Codex responses, tool output, status, or inferred progress. Do not start with filler like Currently, Working on, Focus, Fixing, Implementing, Reviewing, or Summarizing. No markdown, labels, quotes, or speculation."
          },
          {
            role: "user",
            content: buildSummaryPrompt(input)
          }
        ],
        max_output_tokens: 50
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI response ${response.status}: ${await response.text()}`);
    }

    const data = (await response.json()) as OpenAIResponse;
    return {
      text: extractResponseText(data),
      usage: extractUsage(data, this.model)
    };
  }
}

export function buildSummaryPrompt(input: ActivitySummaryInput): string {
  const context = compactPrompts(input.prompts)
    .map((message) => `${message.sequence}. user prompt: ${message.text}`)
    .join("\n");

  return [
    `Repository: ${input.session.repo.name}`,
    `Branch: ${input.session.repo.branch ?? "unknown"}`,
    "",
    "Recent user prompts only:",
    context,
    "",
    "Return a memory jogger for this session, not a prose activity report.",
    "Target 4 to 12 words, max 120 characters.",
    "Use the user's exact keywords where they identify the work.",
    "Base the answer only on the prompts above. Ignore what Codex did, said, ran, or output.",
    "Avoid: Currently, the focus is on; Currently fixing; Working on; Implementing; Reviewing recent code changes."
  ].join("\n");
}

function compactPrompts(prompts: ChatMessage[]): Array<{ sequence: number; text: string }> {
  return prompts
    .filter((message) => message.role === "user")
    .map((message) => {
      const text = truncate(normalizeText(message.text), 700);
      return text ? { sequence: message.sequence, text } : null;
    })
    .filter((message): message is { sequence: number; text: string } => Boolean(message));
}

function normalizeSummary(text: string): string {
  const cleaned = text
    .replace(/\s+/g, " ")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(
      /^(currently,\s*)?(the\s+focus\s+is\s+on|focused\s+on|working\s+on|currently\s+working\s+on|currently\s+fixing|currently\s+simplifying|currently\s+implementing|currently\s+reviewing|fixing|implementing|reviewing|summarizing)\s+/i,
      ""
    )
    .replace(/^(is|are|to)\s+/i, "")
    .trim();
  return truncate(cleaned, 140);
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

interface SessionSummarySource {
  sessionId: string;
  codexSessionId: string | null;
  codexJsonlPath: string | null;
}

function sessionSummarySource(session: ManagedSession): SessionSummarySource {
  return {
    sessionId: session.id,
    codexSessionId: session.codexSessionId,
    codexJsonlPath: session.codexJsonlPath
  };
}

function sameSessionSummarySource(previous: SessionSummarySource, next: SessionSummarySource): boolean {
  return (
    previous.sessionId === next.sessionId &&
    previous.codexSessionId === next.codexSessionId &&
    previous.codexJsonlPath === next.codexJsonlPath
  );
}

interface OpenAIResponse {
  id?: unknown;
  model?: unknown;
  created_at?: unknown;
  output_text?: unknown;
  output?: Array<{
    content?: Array<{
      text?: unknown;
      type?: unknown;
    }>;
  }>;
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
    total_tokens?: unknown;
    input_tokens_details?: {
      cached_tokens?: unknown;
    };
  };
}

function extractResponseText(data: OpenAIResponse): string {
  if (typeof data.output_text === "string") return data.output_text;

  const parts =
    data.output?.flatMap((item) =>
      item.content?.map((content) => (typeof content.text === "string" ? content.text : "")).filter(Boolean) ?? []
    ) ?? [];

  return parts.join("\n");
}

function extractUsage(data: OpenAIResponse, fallbackModel: string): OpenAIResponseUsage | undefined {
  if (!data.usage) return undefined;

  const inputTokens = integerValue(data.usage.input_tokens);
  const outputTokens = integerValue(data.usage.output_tokens);
  const totalTokens = integerValue(data.usage.total_tokens);
  if (inputTokens === null && outputTokens === null && totalTokens === null) return undefined;

  return {
    model: typeof data.model === "string" && data.model ? data.model : fallbackModel,
    responseId: typeof data.id === "string" && data.id ? data.id : null,
    createdAt: createdAtIso(data.created_at),
    inputTokens: inputTokens ?? 0,
    cachedInputTokens: integerValue(data.usage.input_tokens_details?.cached_tokens) ?? 0,
    outputTokens: outputTokens ?? 0,
    totalTokens: totalTokens ?? (inputTokens ?? 0) + (outputTokens ?? 0)
  };
}

function integerValue(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.floor(value));
}

function createdAtIso(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString();
  }
  return new Date().toISOString();
}
