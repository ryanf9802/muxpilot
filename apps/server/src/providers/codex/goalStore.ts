import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

export const CODEX_GOAL_STATUSES = [
  "active",
  "paused",
  "blocked",
  "usage_limited",
  "budget_limited",
  "complete"
] as const;

export type CodexGoalStatus = typeof CODEX_GOAL_STATUSES[number];

export interface CodexGoalSnapshot {
  objective: string;
  status: CodexGoalStatus;
  elapsedSeconds: number;
  tokensUsed: number;
  tokenBudget: number | null;
  createdAt: string;
  updatedAt: string;
  sampledAt: string;
}

export interface CodexGoalTelemetry {
  available: boolean;
  sampledAt: string;
  goals: Map<string, CodexGoalSnapshot>;
}

export interface CodexGoalReader {
  read(threadIds: string[]): CodexGoalTelemetry;
}

interface CodexGoalRow {
  thread_id: unknown;
  objective: unknown;
  status: unknown;
  token_budget: unknown;
  tokens_used: unknown;
  time_used_seconds: unknown;
  created_at_ms: unknown;
  updated_at_ms: unknown;
}

export interface CodexGoalStoreOptions {
  now?: () => number;
}

export class CodexGoalStore implements CodexGoalReader {
  private readonly path: string;
  private readonly now: () => number;

  constructor(codexHome: string, options: CodexGoalStoreOptions = {}) {
    this.path = join(codexHome, "goals_1.sqlite");
    this.now = options.now ?? Date.now;
  }

  read(threadIds: string[]): CodexGoalTelemetry {
    const sampledAtMs = this.now();
    const sampledAt = new Date(sampledAtMs).toISOString();
    const goals = new Map<string, CodexGoalSnapshot>();
    let database: DatabaseSync | null = null;
    try {
      database = new DatabaseSync(this.path, { readOnly: true });
      const requested = [...new Set(threadIds.filter(Boolean))];
      if (requested.length === 0) return { available: true, sampledAt, goals };
      const placeholders = requested.map(() => "?").join(", ");
      const rows = database.prepare(
        `SELECT thread_id, objective, status, token_budget, tokens_used,
                time_used_seconds, created_at_ms, updated_at_ms
           FROM thread_goals
          WHERE thread_id IN (${placeholders})`
      ).all(...requested) as unknown as CodexGoalRow[];
      for (const row of rows) {
        if (typeof row.thread_id !== "string") continue;
        const goal = normalizeGoal(row, sampledAtMs, sampledAt);
        if (goal) goals.set(row.thread_id, goal);
      }
      return { available: true, sampledAt, goals };
    } catch {
      return { available: false, sampledAt, goals };
    } finally {
      database?.close();
    }
  }
}

function normalizeGoal(row: CodexGoalRow, sampledAtMs: number, sampledAt: string): CodexGoalSnapshot | null {
  if (typeof row.objective !== "string" || !isGoalStatus(row.status)) return null;
  const tokensUsed = nonnegativeSafeInteger(row.tokens_used);
  const elapsedAtUpdate = nonnegativeSafeInteger(row.time_used_seconds);
  const createdAtMs = nonnegativeSafeInteger(row.created_at_ms);
  const updatedAtMs = nonnegativeSafeInteger(row.updated_at_ms);
  const tokenBudget = row.token_budget === null ? null : nonnegativeSafeInteger(row.token_budget);
  if (tokensUsed === null || elapsedAtUpdate === null || createdAtMs === null || updatedAtMs === null || (row.token_budget !== null && tokenBudget === null)) {
    return null;
  }
  const activeSeconds = row.status === "active" ? Math.floor(Math.max(0, sampledAtMs - updatedAtMs) / 1_000) : 0;
  return {
    objective: row.objective,
    status: row.status,
    elapsedSeconds: elapsedAtUpdate + activeSeconds,
    tokensUsed,
    tokenBudget,
    createdAt: new Date(createdAtMs).toISOString(),
    updatedAt: new Date(updatedAtMs).toISOString(),
    sampledAt
  };
}

function isGoalStatus(value: unknown): value is CodexGoalStatus {
  return typeof value === "string" && (CODEX_GOAL_STATUSES as readonly string[]).includes(value);
}

function nonnegativeSafeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
