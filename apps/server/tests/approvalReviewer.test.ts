import { describe, expect, it, vi } from "vitest";
import { ApprovalReviewer, parseApprovalReview } from "../src/providers/codex/approvalReviewer.js";

describe("approval reviewer responses", () => {
  it("accepts a structured decision and bounds its explanation", () => {
    expect(parseApprovalReview('{"decision":"approve","explanation":"Required by the task"}')).toEqual({
      decision: "approve",
      explanation: "Required by the task"
    });
  });

  it("rejects malformed and unsupported decisions", () => {
    expect(() => parseApprovalReview("approve")).toThrow("no JSON");
    expect(() => parseApprovalReview('{"decision":"allow","explanation":"ok"}')).toThrow("invalid decision");
    expect(() => parseApprovalReview('{"decision":"escalate","explanation":""}')).toThrow("no explanation");
  });
});

describe("ApprovalReviewer", () => {
  it("constrains the review turn to a decision schema and reads only the final answer", async () => {
    const client = new FakeReviewerClient();
    const reviewer = new ApprovalReviewer("/codex", undefined, client as never);
    const review = reviewer.review(
      { name: "demo", cwd: "/repo", recentUserPrompts: ["Append a line"], provider: { kind: "codex", threadId: "source", transcriptPath: null } } as never,
      { kind: "command", title: "Run printf", command: "printf x >> notes.txt", toolName: null, cwd: "/repo", reason: null, prefixRule: null } as never,
      { model: "gpt-review", reasoningEffort: "low" }
    );
    await vi.waitFor(() => expect(client.requests.map((request) => request.method)).toContain("turn/start"));
    expect(client.requests.find((request) => request.method === "turn/start")?.params).toMatchObject({
      outputSchema: { required: ["decision", "explanation"], properties: { decision: { enum: ["approve", "deny", "escalate"] } } }
    });
    // Commentary streams before the answer; only the final answer holds the decision.
    client.emit({ method: "item/agentMessage/delta", params: { threadId: "review", delta: "Checking the request. " } });
    client.emit({ method: "item/completed", params: { threadId: "review", item: { type: "agentMessage", phase: "commentary", text: "Checking the request." } } });
    client.emit({ method: "item/completed", params: { threadId: "review", item: { type: "agentMessage", phase: "final_answer", text: '{"decision":"approve","explanation":"Matches the request"}' } } });
    client.emit({ method: "turn/completed", params: { threadId: "review", turn: { id: "turn", status: "completed" } } });
    await expect(review).resolves.toEqual({ decision: "approve", explanation: "Matches the request" });
    reviewer.stop();
  });
});

class FakeReviewerClient {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  private readonly listeners = new Set<(message: { method?: string; params?: unknown; id?: number }) => void>();

  async initialize(): Promise<void> {}

  async request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    if (method === "thread/fork") return { thread: { id: "review" } } as T;
    if (method === "turn/start") return { turn: { id: "turn" } } as T;
    return {} as T;
  }

  respondError(): void {}

  subscribe(listener: (message: { method?: string; params?: unknown }) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeClose(): () => void {
    return () => undefined;
  }

  emit(message: { method: string; params: unknown }): void {
    for (const listener of this.listeners) listener(message);
  }

  stop(): void {}
}
