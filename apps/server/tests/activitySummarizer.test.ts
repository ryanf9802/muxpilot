import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChatMessage, ManagedSession } from "@muxpilot/core";
import { AppDatabase } from "../src/db/database.js";
import {
  ACTIVITY_SUMMARY_PROMPT_VERSION,
  ActivitySummarizer,
  type ActivitySummaryResult,
  buildSummaryPrompt,
  type ActivitySummaryInput,
  type SummaryModelClient
} from "../src/services/activitySummarizer.js";

describe("ActivitySummarizer", () => {
  it("builds context from user prompts only", () => {
    const prompt = buildSummaryPrompt({
      session: testSession("session-1"),
      prompts: [
        testMessage("session-1", 1, "user", "Replace recent prompts with an active work summary."),
        {
          ...testMessage("session-1", 2, "tool", "x".repeat(500)),
          type: "command_output"
        }
      ]
    });

    expect(prompt).toContain("Repository: repo");
    expect(prompt).toContain("1. user prompt: Replace recent prompts");
    expect(prompt).toContain("Recent user prompts only");
    expect(prompt).toContain("Base the answer only on the prompts above");
    expect(prompt).toContain("memory jogger");
    expect(prompt).toContain("Use the user's exact keywords");
    expect(prompt).not.toContain("tool result");
    expect(prompt).not.toContain("x".repeat(20));
    expect(prompt).not.toContain("TW-358");
    expect(prompt).not.toContain("CSS grid input viewport overflow");
    expect(prompt).not.toContain("dashboard recent prompts");
  });

  it("refreshes a summary and publishes an update callback", async () => {
    const db = await tempDb();
    const session = testSession("session-2");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(session.id, 1, "user", "Implement activity summaries"));
    db.appendMessage(testMessage(session.id, 2, "assistant", "I am wiring the server service."));
    const client = new FakeSummaryClient("Wiring dashboard activity summaries into ingestion.");
    const updated: string[] = [];
    const summarizer = new ActivitySummarizer({
      db,
      client,
      debounceMs: 1,
      intervalMs: 60_000,
      onSummaryUpdated: (sessionId) => updated.push(sessionId),
      now: () => "2026-07-07T00:01:00.000Z",
      logger: { warn: () => undefined }
    });

    await expect(summarizer.refresh(session.id)).resolves.toBe(true);

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.prompts.map((message) => message.role)).toEqual(["user"]);
    expect(updated).toEqual([session.id]);
    expect(db.getSession(session.id)?.activitySummary).toBe("Wiring dashboard activity summaries into ingestion.");
    db.close();
  });

  it("records OpenAI usage returned by the model client", async () => {
    const db = await tempDb();
    const session = testSession("session-usage");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(session.id, 1, "user", "Track summary usage"));
    const client = new FakeSummaryClient({
      text: "Track summary usage",
      usage: {
        model: "gpt-4.1-mini",
        responseId: "resp_usage",
        createdAt: "2026-07-07T00:00:30.000Z",
        inputTokens: 1000,
        cachedInputTokens: 200,
        outputTokens: 50,
        totalTokens: 1050
      }
    });
    const summarizer = new ActivitySummarizer({
      db,
      client,
      pricingTable: {
        "gpt-4.1-mini": {
          inputUsdPerMillion: 1,
          cachedInputUsdPerMillion: 0.5,
          outputUsdPerMillion: 4
        }
      },
      debounceMs: 1,
      intervalMs: 60_000,
      onSummaryUpdated: () => undefined,
      logger: { warn: () => undefined }
    });

    await expect(summarizer.refresh(session.id)).resolves.toBe(true);

    const summary = db.summarizeOpenAIUsage(30, new Date("2026-07-07T12:00:00.000Z"));
    expect(summary.totals.requestCount).toBe(1);
    expect(summary.totals.inputTokens).toBe(1000);
    expect(summary.totals.cachedInputTokens).toBe(200);
    expect(summary.totals.outputTokens).toBe(50);
    expect(summary.totals.estimatedCostUsd).toBeCloseTo(0.0011);
    db.close();
  });

  it("does not refresh summaries while disabled", async () => {
    const db = await tempDb();
    const session = testSession("session-disabled");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(session.id, 1, "user", "Do not call OpenAI"));
    const client = new FakeSummaryClient("Should not be used");
    const summarizer = new ActivitySummarizer({
      db,
      client,
      enabled: false,
      debounceMs: 1,
      intervalMs: 60_000,
      onSummaryUpdated: () => undefined,
      logger: { warn: () => undefined }
    });

    await expect(summarizer.refresh(session.id)).resolves.toBe(false);

    expect(client.calls).toHaveLength(0);
    expect(db.getSession(session.id)?.activitySummary).toBeNull();
    db.close();
  });

  it("clears pending summary refreshes when disabled", async () => {
    const db = await tempDb();
    const session = testSession("session-pending-disabled");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(session.id, 1, "user", "Pending timer should be cancelled"));
    const client = new FakeSummaryClient("Should not run");
    const summarizer = new ActivitySummarizer({
      db,
      client,
      debounceMs: 5,
      intervalMs: 60_000,
      onSummaryUpdated: () => undefined,
      logger: { warn: () => undefined }
    });

    summarizer.schedule(session.id);
    summarizer.setEnabled(false);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(client.calls).toHaveLength(0);
    db.close();
  });

  it("does not send assistant or tool output to the model client", async () => {
    const db = await tempDb();
    const session = testSession("session-user-only");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(session.id, 1, "user", "Revenue graph y=0 bug"));
    db.appendMessage(testMessage(session.id, 2, "assistant", "I found the chart formatter issue."));
    db.appendMessage({
      ...testMessage(session.id, 3, "tool", "secret tool output that should not influence summary"),
      type: "command_output"
    });
    const client = new FakeSummaryClient("Revenue graph y=0 bug");
    const summarizer = new ActivitySummarizer({
      db,
      client,
      debounceMs: 1,
      intervalMs: 60_000,
      onSummaryUpdated: () => undefined,
      logger: { warn: () => undefined }
    });

    await expect(summarizer.refresh(session.id)).resolves.toBe(true);

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.prompts.map((message) => message.text)).toEqual(["Revenue graph y=0 bug"]);
    db.close();
  });

  it("removes filler phrasing from model output", async () => {
    const db = await tempDb();
    const session = testSession("session-filler");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(session.id, 1, "user", "Fix CSS grid input viewport overflow"));
    const client = new FakeSummaryClient("Currently, the focus is on CSS grid input viewport overflow.");
    const summarizer = new ActivitySummarizer({
      db,
      client,
      debounceMs: 1,
      intervalMs: 60_000,
      onSummaryUpdated: () => undefined,
      logger: { warn: () => undefined }
    });

    await expect(summarizer.refresh(session.id)).resolves.toBe(true);

    expect(db.getSession(session.id)?.activitySummary).toBe("CSS grid input viewport overflow.");
    db.close();
  });

  it("skips sessions without user messages", async () => {
    const db = await tempDb();
    const session = testSession("session-3");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(session.id, 1, "assistant", "Waiting."));
    const client = new FakeSummaryClient("Should not be used.");
    const summarizer = new ActivitySummarizer({
      db,
      client,
      debounceMs: 1,
      intervalMs: 60_000,
      onSummaryUpdated: () => undefined,
      logger: { warn: () => undefined }
    });

    await expect(summarizer.refresh(session.id)).resolves.toBe(false);

    expect(client.calls).toHaveLength(0);
    expect(db.getSession(session.id)?.activitySummary).toBeNull();
    db.close();
  });

  it("honors the per-session cooldown", async () => {
    const db = await tempDb();
    const session = testSession("session-4");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(session.id, 1, "user", "Initial request"));
    db.upsertActivitySummary(
      session.id,
      "Existing summary.",
      "2026-07-07T00:00:30.000Z",
      1,
      ACTIVITY_SUMMARY_PROMPT_VERSION
    );
    db.appendMessage(testMessage(session.id, 2, "assistant", "New progress"));
    const client = new FakeSummaryClient("Should wait.");
    const summarizer = new ActivitySummarizer({
      db,
      client,
      debounceMs: 1,
      intervalMs: 60_000,
      onSummaryUpdated: () => undefined,
      now: () => "2026-07-07T00:00:45.000Z",
      logger: { warn: () => undefined }
    });

    await expect(summarizer.refresh(session.id)).resolves.toBe(false);
    summarizer.stop();

    expect(client.calls).toHaveLength(0);
    expect(db.getSession(session.id)?.activitySummary).toBe("Existing summary.");
    db.close();
  });

  it("regenerates old prompt-version summaries even when source sequence is unchanged", async () => {
    const db = await tempDb();
    const session = testSession("session-old-version");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(session.id, 1, "user", "Dashboard recent prompts display"));
    db.upsertActivitySummary(
      session.id,
      "Currently, the focus is on dashboard recent prompts display.",
      "2026-07-07T00:00:30.000Z",
      1,
      "activity-summary-v1"
    );
    const client = new FakeSummaryClient("dashboard recent prompts display");
    const summarizer = new ActivitySummarizer({
      db,
      client,
      debounceMs: 1,
      intervalMs: 60_000,
      onSummaryUpdated: () => undefined,
      now: () => "2026-07-07T00:00:45.000Z",
      logger: { warn: () => undefined }
    });

    await expect(summarizer.refresh(session.id)).resolves.toBe(true);

    expect(client.calls).toHaveLength(1);
    expect(db.getSession(session.id)?.activitySummary).toBe("dashboard recent prompts display");
    db.close();
  });

  it("does not write a summary when the session source changes while the model is in flight", async () => {
    const db = await tempDb();
    const session = testSession("session-rebound");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(session.id, 1, "user", "Pane A prompt"));
    const client = new ControlledSummaryClient();
    const updated: string[] = [];
    const summarizer = new ActivitySummarizer({
      db,
      client,
      debounceMs: 1,
      intervalMs: 60_000,
      onSummaryUpdated: (sessionId) => updated.push(sessionId),
      logger: { warn: () => undefined }
    });

    const refresh = summarizer.refresh(session.id);
    await client.waitForCall();

    db.clearSessionTranscript(session.id);
    db.upsertSession(
      {
        ...session,
        codexSessionId: "codex-other",
        codexJsonlPath: "/tmp/other-codex.jsonl"
      },
      "2026-07-07T00:00:01.000Z"
    );
    db.appendMessage(testMessage(session.id, 1, "user", "Pane B prompt"));
    client.resolve("Pane A summary");

    await expect(refresh).resolves.toBe(false);
    summarizer.stop();

    expect(updated).toEqual([]);
    expect(db.getSession(session.id)?.activitySummary).toBeNull();
    expect(client.calls[0]?.prompts.map((message) => message.text)).toEqual(["Pane A prompt"]);
    db.close();
  });
});

class FakeSummaryClient implements SummaryModelClient {
  readonly calls: ActivitySummaryInput[] = [];

  constructor(private readonly response: string | ActivitySummaryResult) {}

  async summarize(input: ActivitySummaryInput): Promise<ActivitySummaryResult> {
    this.calls.push(input);
    return typeof this.response === "string" ? { text: this.response } : this.response;
  }
}

class ControlledSummaryClient implements SummaryModelClient {
  readonly calls: ActivitySummaryInput[] = [];
  private resolveResult: ((result: ActivitySummaryResult) => void) | null = null;
  private callStarted: (() => void) | null = null;
  private readonly callStartedPromise = new Promise<void>((resolve) => {
    this.callStarted = resolve;
  });

  async summarize(input: ActivitySummaryInput): Promise<ActivitySummaryResult> {
    this.calls.push(input);
    this.callStarted?.();
    return new Promise<ActivitySummaryResult>((resolve) => {
      this.resolveResult = resolve;
    });
  }

  async waitForCall(): Promise<void> {
    await this.callStartedPromise;
  }

  resolve(text: string): void {
    this.resolveResult?.({ text });
  }
}

async function tempDb(): Promise<AppDatabase> {
  const dir = await mkdtemp(join(tmpdir(), "muxpilot-summary-"));
  return new AppDatabase(join(dir, "test.db"));
}

function testSession(id: string): ManagedSession {
  return {
    id,
    tmux: {
      sessionId: "tmux-session",
      sessionName: "work",
      windowId: "@1",
      windowIndex: 1,
      windowName: "codex",
      paneId: "%1",
      paneIndex: 0,
      paneActive: true,
      cwd: "/repo",
      currentCommand: "node",
      title: "codex",
      pid: 123,
      size: "120x40"
    },
    repo: {
      root: "/repo",
      name: "repo",
      branch: "main",
      dirty: false,
      worktree: null
    },
    codexSessionId: "codex-session",
    codexJsonlPath: "/tmp/codex.jsonl",
    discoveryConfidence: "high",
    status: "working",
    lastActivityAt: null,
    preview: "",
    recentUserPrompts: [],
    activitySummary: null,
    activitySummaryGeneratedAt: null,
    activitySummarySourceSequence: null,
    inputMode: "default",
    models: { default: { model: null, reasoningEffort: null }, plan: { model: null, reasoningEffort: null } },
    transcriptSize: 0,
    unreadCount: 0,
    archived: false
  };
}

function testMessage(sessionId: string, sequence: number, role: ChatMessage["role"], text: string): ChatMessage {
  return {
    id: `${sessionId}-${sequence}`,
    sessionId,
    sequence,
    type: role === "tool" ? "tool_output" : role,
    role,
    timestamp: `2026-07-07T00:00:0${sequence}.000Z`,
    text,
    payload: {}
  };
}
