import type { SessionModelSelections } from "./types.js";

export const AGENT_PROVIDER_KINDS = ["codex", "claude"] as const;

export type AgentProviderKind = (typeof AGENT_PROVIDER_KINDS)[number];

export const DEFAULT_AGENT_PROVIDER: AgentProviderKind = "codex";

export function isAgentProviderKind(value: unknown): value is AgentProviderKind {
  return typeof value === "string" && (AGENT_PROVIDER_KINDS as readonly string[]).includes(value);
}

export function providerDisplayName(kind: AgentProviderKind): string {
  return kind === "claude" ? "Claude" : "Codex";
}

export function providerLoginCommand(kind: AgentProviderKind): string {
  return kind === "claude" ? "claude auth login" : "codex login";
}

/** Provider-level feature support. Per-session driver operations remain in `SessionCapabilities`. */
export interface ProviderCapabilities {
  fastMode: boolean;
  reasoningEffort: boolean;
  planMode: boolean;
  steer: boolean;
  fork: boolean;
  btw: boolean;
  approvalReview: boolean;
  hibernate: boolean;
  terminalAttach: boolean;
  resetCredits: boolean;
  tokenUsageHistory: boolean;
  usageLimits: boolean;
  goals: boolean;
  backgroundTerminals: boolean;
  transcriptTransfer: boolean;
  imageInput: boolean;
  rawTranscriptEvidence: boolean;
  /** The provider runs its own subagents and background tasks, shown in muxpilot's Agents view. */
  nativeAgents: boolean;
}

export type ProviderCompatibilityStatus =
  | "available"
  | "disabled"
  | "missing_binary"
  | "user_systemd_unavailable"
  | "incompatible_protocol"
  | "sandbox_unavailable"
  | "failed_health_probe";

export interface ProviderCompatibility {
  provider: AgentProviderKind;
  status: ProviderCompatibilityStatus;
  available: boolean;
  version: string | null;
  detail: string;
  checkedAt: string;
  missingCapabilities: string[];
}

export type ProviderAuthStatus =
  | "checking"
  | "ready"
  | "signed_out"
  | "authentication_required"
  | "temporarily_unavailable";

export interface ProviderAuthAccount {
  type: string;
  email: string | null;
  planType: string | null;
  organization?: string | null;
}

export interface ProviderAuthState {
  provider: AgentProviderKind;
  status: ProviderAuthStatus;
  account: ProviderAuthAccount | null;
  revision: number;
  observedAt: string;
  error: string | null;
  admissionHeld: boolean;
  pendingSessionIds: string[];
}

export interface ProviderSkillInvocation {
  /** Character that introduces a skill reference in the composer. */
  prefix: "$" | "/";
  /** Whether the reference may appear anywhere or only at the start of the message. */
  position: "anywhere" | "start";
}

export interface ProviderDescriptor {
  kind: AgentProviderKind;
  displayName: string;
  enabled: boolean;
  compatibility: ProviderCompatibility;
  capabilities: ProviderCapabilities;
  auth: ProviderAuthState;
  skillInvocation: ProviderSkillInvocation;
  loginCommand: string;
}

export interface ProvidersResponse {
  defaultProvider: AgentProviderKind;
  providers: ProviderDescriptor[];
}

export interface UpdateDefaultProviderRequest {
  provider: AgentProviderKind;
}

export type ProviderAccountStatus = "authenticated" | "signed_out" | "unknown";

export interface ProviderUsageAccount {
  /** Provider-specific account kind, e.g. `chatgpt`, `apiKey`, `claudeAi`. */
  kind: string;
  email: string | null;
  planType: string | null;
}

export interface ProviderUsageLimit {
  /** Stable limit identity, e.g. `five_hour`, `weekly`, `weekly_opus`. */
  id: string;
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

export interface ProviderUsageSummary {
  provider: AgentProviderKind;
  available: boolean;
  error: string | null;
  refreshedAt: string;
  accountStatus: ProviderAccountStatus;
  account: ProviderUsageAccount | null;
  limits: ProviderUsageLimit[];
  /** Codex-only usage reset tokens; null for providers without reset credits. */
  resetCredits: CodexRateLimitResetCredits | null;
}

export interface ProviderTokenUsageDailyPoint {
  date: string;
  tokens: number;
}

export interface ProviderTokenUsageResponse {
  provider: AgentProviderKind;
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
  points: ProviderTokenUsageDailyPoint[] | null;
}

export interface ConsumeCodexResetCreditRequest {
  idempotencyKey: string;
  creditId?: string | null;
}

export type ConsumeCodexResetCreditOutcome = "reset" | "alreadyRedeemed" | "nothingToReset" | "noCredit";

export interface ConsumeCodexResetCreditResponse {
  outcome: ConsumeCodexResetCreditOutcome;
  summary: ProviderUsageSummary;
}

export interface ReasoningEffortOption {
  reasoningEffort: string;
  description: string;
}

export interface AgentModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
  supportedReasoningEfforts: ReasoningEffortOption[];
  defaultReasoningEffort: string | null;
  supportsFastMode: boolean;
}

export interface ProviderModelCatalogResponse {
  provider: AgentProviderKind;
  models: AgentModel[];
  defaults: SessionModelSelections;
}

export type AgentSkillSource = "user" | "system" | "plugin" | "workspace" | "project";

export interface AgentSkill {
  name: string;
  description: string;
  source: AgentSkillSource;
  pluginName?: string;
}

export interface AgentSkillsResponse {
  skills: AgentSkill[];
}

interface ThreadIdentity {
  provider?: { threadId?: string | null; transcriptPath?: string | null } | null;
}

/** The provider-native conversation id (Codex thread id, Claude session id). */
export function sessionThreadId(session: ThreadIdentity): string | null {
  return session.provider?.threadId ?? null;
}

/** The provider-native transcript file (Codex rollout JSONL, Claude project JSONL). */
export function sessionTranscriptPath(session: ThreadIdentity): string | null {
  return session.provider?.transcriptPath ?? null;
}

/** Stable identity of a provider conversation across muxpilot session records. */
export function providerThreadIdentity(kind: AgentProviderKind, threadId: string): string {
  return `${kind}:${threadId}`;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/**
 * Converts a persisted session record written before multi-provider support into the provider-neutral shape.
 * Legacy records are always Codex sessions; the function is idempotent for current records.
 */
export function normalizeLegacySessionRecord<T extends Record<string, unknown>>(raw: T): T {
  const record: Record<string, unknown> = { ...raw };
  const legacyThreadId = stringOrNull(record.codexSessionId);
  const legacyTranscriptPath = stringOrNull(record.codexJsonlPath);
  const provider = record.provider && typeof record.provider === "object"
    ? { ...(record.provider as Record<string, unknown>) }
    : {};
  const kind = isAgentProviderKind(provider.kind) ? provider.kind : DEFAULT_AGENT_PROVIDER;
  record.provider = {
    kind,
    threadId: stringOrNull(provider.threadId) ?? legacyThreadId,
    transcriptPath: stringOrNull(provider.transcriptPath) ?? stringOrNull(provider.rolloutPath) ?? legacyTranscriptPath
  };
  delete record.codexSessionId;
  delete record.codexJsonlPath;
  if (record.runtime && typeof record.runtime === "object") {
    const runtime = { ...(record.runtime as Record<string, unknown>) };
    if (!("agentVersion" in runtime)) runtime.agentVersion = stringOrNull(runtime.codexVersion);
    delete runtime.codexVersion;
    record.runtime = runtime;
  }
  if (record.forkedFrom && typeof record.forkedFrom === "object") {
    const origin = record.forkedFrom as Record<string, unknown>;
    const threadId = stringOrNull(origin.threadId) ?? stringOrNull(origin.codexSessionId);
    record.forkedFrom = threadId
      ? {
          provider: isAgentProviderKind(origin.provider) ? origin.provider : kind,
          threadId,
          sessionId: stringOrNull(origin.sessionId),
          sessionName: typeof origin.sessionName === "string" ? origin.sessionName : ""
        }
      : null;
  }
  return record as T;
}
