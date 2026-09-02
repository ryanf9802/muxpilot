import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CODEX_GOAL_STATUSES, CodexGoalStore } from "../src/codex/codexGoalStore.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("CodexGoalStore", () => {
  it("normalizes every supported status and advances only active elapsed time", async () => {
    const codexHome = await goalDatabase();
    const database = new DatabaseSync(join(codexHome, "goals_1.sqlite"));
    const insert = database.prepare(
      `INSERT INTO thread_goals
        (thread_id, objective, status, token_budget, tokens_used, time_used_seconds, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const [index, status] of CODEX_GOAL_STATUSES.entries()) {
      insert.run(`thread-${status}`, `${status} objective`, status, index === 0 ? 1_000_000 : null, 100 + index, 15, 1_000, 10_000);
    }
    database.close();

    const store = new CodexGoalStore(codexHome, { now: () => 20_900 });
    const telemetry = store.read(CODEX_GOAL_STATUSES.map((status) => `thread-${status}`));

    expect(telemetry.available).toBe(true);
    expect(telemetry.sampledAt).toBe("1970-01-01T00:00:20.900Z");
    expect(telemetry.goals.size).toBe(CODEX_GOAL_STATUSES.length);
    for (const [index, status] of CODEX_GOAL_STATUSES.entries()) {
      expect(telemetry.goals.get(`thread-${status}`)).toEqual({
        objective: `${status} objective`,
        status,
        elapsedSeconds: status === "active" ? 25 : 15,
        tokensUsed: 100 + index,
        tokenBudget: index === 0 ? 1_000_000 : null,
        createdAt: "1970-01-01T00:00:01.000Z",
        updatedAt: "1970-01-01T00:00:10.000Z",
        sampledAt: "1970-01-01T00:00:20.900Z"
      });
    }
  });

  it("returns an available empty result when requested threads have no goals", async () => {
    const codexHome = await goalDatabase();
    const telemetry = new CodexGoalStore(codexHome, { now: () => 1_000 }).read(["missing-thread"]);

    expect(telemetry).toMatchObject({ available: true, sampledAt: "1970-01-01T00:00:01.000Z" });
    expect(telemetry.goals.size).toBe(0);
  });

  it("keeps inspection usable when the goal database is missing or incompatible", async () => {
    const missingHome = await temporaryDirectory();
    const missing = new CodexGoalStore(missingHome, { now: () => 1_000 }).read(["thread-1"]);
    expect(missing).toMatchObject({ available: false, sampledAt: "1970-01-01T00:00:01.000Z" });
    expect(missing.goals.size).toBe(0);

    const incompatibleHome = await temporaryDirectory();
    const database = new DatabaseSync(join(incompatibleHome, "goals_1.sqlite"));
    database.exec("CREATE TABLE unrelated (id TEXT PRIMARY KEY)");
    database.close();
    const incompatible = new CodexGoalStore(incompatibleHome, { now: () => 2_000 }).read(["thread-1"]);
    expect(incompatible).toMatchObject({ available: false, sampledAt: "1970-01-01T00:00:02.000Z" });
    expect(incompatible.goals.size).toBe(0);
  });
});

async function goalDatabase(): Promise<string> {
  const path = await temporaryDirectory();
  const database = new DatabaseSync(join(path, "goals_1.sqlite"));
  database.exec(`
    CREATE TABLE thread_goals (
      thread_id TEXT PRIMARY KEY NOT NULL,
      objective TEXT NOT NULL,
      status TEXT NOT NULL,
      token_budget INTEGER,
      tokens_used INTEGER NOT NULL,
      time_used_seconds INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )
  `);
  database.close();
  return path;
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "muxpilot-goals-"));
  temporaryDirectories.push(path);
  return path;
}
