import type { Logger } from "pino";
import type { ApprovalRequest, ApprovalReviewerSettings, ManagedSession } from "@muxpilot/core";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { approvalReviewInstructions, approvalReviewPrompt, parseApprovalReview } from "../shared/approvalReview.js";
import type { ApprovalReviewEngine, ApprovalReviewResult } from "../types.js";
import { InputQueue, type QueryFactory } from "./host/hostSession.js";
import type { ClaudeTranscriptArchive } from "./transcriptArchive.js";

const REVIEW_TIMEOUT_MS = 60_000;

export interface ClaudeApprovalReviewerOptions {
  claudePath: string;
  configDir: string;
  environment: Record<string, string | undefined>;
  queryFactory: QueryFactory;
  archive?: Pick<ClaudeTranscriptArchive, "ensureRestored">;
  logger?: Pick<Logger, "warn" | "debug">;
}

/**
 * Reviews a pending approval in a throwaway fork of the session's conversation, so the reviewer sees the same
 * context without tools, persistence, or any effect on the live session.
 */
export class ClaudeApprovalReviewer implements ApprovalReviewEngine {
  private readonly active = new Set<AbortController>();

  constructor(private readonly options: ClaudeApprovalReviewerOptions) {}

  start(): void {
    // Reviews start a fresh fork per request; there is nothing to warm up.
  }

  stop(): void {
    for (const controller of this.active) controller.abort();
    this.active.clear();
  }

  invalidateAuthentication(): void {
    this.stop();
  }

  async review(session: ManagedSession, approval: ApprovalRequest, settings: ApprovalReviewerSettings): Promise<ApprovalReviewResult> {
    const threadId = session.provider.kind === "claude" ? session.provider.threadId : null;
    if (!threadId) throw new Error("Session has no Claude conversation to review");
    await this.options.archive?.ensureRestored(threadId, session.provider.transcriptPath);
    const controller = new AbortController();
    this.active.add(controller);
    const timer = setTimeout(() => controller.abort(), REVIEW_TIMEOUT_MS);
    const input = new InputQueue();
    input.push({
      type: "user",
      parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "text", text: approvalReviewPrompt(session, approval) }] }
    } satisfies SDKUserMessage);
    input.close();
    try {
      const query = this.options.queryFactory({
        prompt: input,
        options: {
          cwd: session.cwd,
          pathToClaudeCodeExecutable: this.options.claudePath,
          env: { ...this.options.environment, CLAUDE_CONFIG_DIR: this.options.configDir },
          resume: threadId,
          forkSession: true,
          persistSession: false,
          model: settings.model,
          ...(settings.reasoningEffort ? { effort: settings.reasoningEffort as never } : {}),
          tools: [],
          maxTurns: 1,
          settingSources: [],
          permissionMode: "dontAsk",
          abortController: controller,
          systemPrompt: { type: "preset", preset: "claude_code", append: approvalReviewInstructions("Claude"), snapshot: false },
          canUseTool: async () => ({ behavior: "deny", message: "The approval reviewer cannot use tools." })
        }
      });
      let text = "";
      for await (const message of query) {
        if (message.type === "assistant" && message.parent_tool_use_id === null) {
          for (const block of message.message.content) if (block.type === "text") text += block.text;
        }
        if (message.type === "result") {
          if (message.subtype === "success" && !text) text = message.result;
          break;
        }
      }
      return parseApprovalReview(text);
    } catch (error) {
      if (controller.signal.aborted) throw new Error("Claude approval review timed out");
      throw error;
    } finally {
      clearTimeout(timer);
      this.active.delete(controller);
    }
  }
}
