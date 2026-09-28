import type { Logger } from "pino";
import {
  btwDocumentInstructions,
  btwReadOnlyInstructions,
  type BtwEngine,
  type BtwGeneration,
  type BtwGenerationListener,
  type BtwGenerationRequest
} from "../shared/btw.js";
import { CodexAppServerClient, type CodexAppServerMessage } from "./usage.js";

const BTW_INTERACTIVE_ERROR = "BTW questions cannot request interactive input or approval.";

export interface BtwAppServerClient {
  initialize(): Promise<void>;
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  respond(id: string | number, result: unknown): void;
  respondError(id: string | number, message: string, code?: number): void;
  subscribe(listener: (message: CodexAppServerMessage) => void): () => void;
  subscribeClose(listener: (error: Error) => void): () => void;
  stop(): void;
}

interface ThreadForkResponse {
  thread?: { id?: unknown };
}

interface TurnStartResponse {
  turn?: { id?: unknown };
}

/** Answers BTW questions in ephemeral forks on a dedicated Codex app-server. */
export class CodexBtwEngine implements BtwEngine {
  private readonly listeners = new Map<string, BtwGenerationListener>();
  private readonly unsubscribeMessage: () => void;
  private readonly unsubscribeClose: () => void;

  constructor(
    private readonly client: BtwAppServerClient,
    private readonly logger?: Pick<Logger, "warn" | "debug">
  ) {
    this.unsubscribeMessage = this.client.subscribe((message) => this.handleMessage(message));
    this.unsubscribeClose = this.client.subscribeClose((error) => this.handleClose(error));
  }

  static create(options: { codexHome: string; logger?: Pick<Logger, "warn" | "debug">; timeoutMs?: number }): CodexBtwEngine {
    return new CodexBtwEngine(
      new CodexAppServerClient({ codexHome: options.codexHome, timeoutMs: options.timeoutMs ?? 10_000, logger: options.logger }),
      options.logger
    );
  }

  start(): void {
    void this.client.initialize().catch((error) => {
      this.logger?.warn({ err: error }, "BTW Codex app-server warmup failed; the next question will retry");
    });
  }

  stop(): void {
    this.listeners.clear();
    this.unsubscribeMessage();
    this.unsubscribeClose();
    this.client.stop();
  }

  invalidateAuthentication(): void {
    if (this.listeners.size === 0) this.client.stop();
  }

  async generate(request: BtwGenerationRequest, listener: BtwGenerationListener): Promise<BtwGeneration> {
    const fork = await this.client.request<ThreadForkResponse>("thread/fork", forkParams(request));
    const threadId = stringValue(fork.thread?.id);
    if (!threadId) throw new Error("Codex app-server did not return a BTW thread id");
    this.listeners.set(threadId, listener);
    let turnId: string | null = null;
    let disposed = false;
    const generation: BtwGeneration = {
      interrupt: async () => {
        if (!turnId) return;
        try {
          await this.client.request("turn/interrupt", { threadId, turnId });
        } catch (error) {
          this.logger?.debug({ err: error, threadId }, "BTW turn interrupt failed");
        }
      },
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        if (this.listeners.get(threadId) === listener) this.listeners.delete(threadId);
        try {
          await this.client.request("thread/unsubscribe", { threadId });
        } catch (error) {
          this.logger?.debug({ err: error, threadId }, "BTW thread unsubscribe failed");
        }
      }
    };
    if (request.signal.aborted) return generation;
    try {
      let turn: TurnStartResponse;
      try {
        turn = await this.startTurn(threadId, request, true);
      } catch (error) {
        if (!isUnsupportedEffortError(error)) throw error;
        turn = await this.startTurn(threadId, request, false);
      }
      turnId = stringValue(turn.turn?.id);
      if (!turnId) throw new Error("Codex app-server did not return a BTW turn id");
    } catch (error) {
      await generation.dispose();
      throw error;
    }
    return generation;
  }

  private startTurn(threadId: string, request: BtwGenerationRequest, lowEffort: boolean): Promise<TurnStartResponse> {
    return this.client.request<TurnStartResponse>("turn/start", {
      threadId,
      input: [{ type: "text", text: request.question }],
      ...(lowEffort ? { effort: "low" } : {}),
      summary: "none",
      approvalPolicy: "never",
      sandboxPolicy: request.documentsRoot
        ? {
            type: "workspaceWrite",
            writableRoots: [request.documentsRoot],
            networkAccess: false,
            excludeTmpdirEnvVar: true,
            excludeSlashTmp: true
          }
        : { type: "readOnly", networkAccess: false }
    });
  }

  private handleMessage(message: CodexAppServerMessage): void {
    if (message.id !== undefined && message.method) {
      this.denyServerRequest(message.id, message.method);
      return;
    }
    if (!message.method) return;
    const params = recordValue(message.params);
    const threadId = stringValue(params?.threadId);
    const listener = threadId ? this.listeners.get(threadId) : undefined;
    if (!listener) return;

    if (message.method === "item/agentMessage/delta") {
      const delta = stringValue(params?.delta);
      if (delta) listener.delta(delta);
      return;
    }
    if (message.method === "turn/completed") {
      const turn = recordValue(params?.turn);
      const status = stringValue(turn?.status);
      if (status === "interrupted") listener.interrupted();
      else if (status === "completed") listener.completed();
      else if (status === "failed") {
        listener.failed(stringValue(recordValue(turn?.error)?.message) ?? "Codex could not answer this BTW question.");
      }
    }
  }

  private denyServerRequest(id: string | number, method: string): void {
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      this.client.respond(id, { decision: "decline" });
      return;
    }
    if (method === "item/tool/requestUserInput") {
      this.client.respond(id, { answers: {} });
      return;
    }
    if (method === "mcpServer/elicitation/request") {
      this.client.respond(id, { action: "decline" });
      return;
    }
    if (method === "applyPatchApproval" || method === "execCommandApproval") {
      this.client.respond(id, { decision: { denied: { rejection: BTW_INTERACTIVE_ERROR } } });
      return;
    }
    this.client.respondError(id, BTW_INTERACTIVE_ERROR);
  }

  private handleClose(error: Error): void {
    const listeners = [...this.listeners.values()];
    this.listeners.clear();
    const message = `Codex app-server stopped: ${error instanceof Error ? error.message : String(error)}`;
    for (const listener of listeners) listener.closed(message);
  }
}

function forkParams(request: BtwGenerationRequest): Record<string, unknown> {
  if (!request.documentsRoot) {
    return {
      threadId: request.sourceThreadId,
      ephemeral: true,
      excludeTurns: true,
      approvalPolicy: "never",
      sandbox: "read-only",
      developerInstructions: btwReadOnlyInstructions("Codex", request.documentsUnavailable)
    };
  }
  return {
    threadId: request.sourceThreadId,
    ephemeral: true,
    excludeTurns: true,
    approvalPolicy: "never",
    sandbox: "workspace-write",
    cwd: request.documentsRoot,
    runtimeWorkspaceRoots: [request.documentsRoot],
    developerInstructions: btwDocumentInstructions("Codex", request.documentsRoot, request.sourceCwd)
  };
}

function isUnsupportedEffortError(error: unknown): boolean {
  return error instanceof Error && /effort|reasoning/i.test(error.message);
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
