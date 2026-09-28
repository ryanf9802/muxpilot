import type { Logger } from "pino";
import type { CanUseTool, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  btwDocumentInstructions,
  btwErrorMessage,
  btwReadOnlyInstructions,
  type BtwEngine,
  type BtwGeneration,
  type BtwGenerationListener,
  type BtwGenerationRequest
} from "../shared/btw.js";
import { InputQueue, type QueryFactory } from "./host/hostSession.js";
import { isWithinWritableRoots } from "./host/permissionPolicy.js";

const READ_TOOLS = ["Read", "Grep", "Glob"];
const DOCUMENT_TOOLS = ["Write", "Edit"];
const BTW_MAX_TURNS = 24;
const FALLBACK_ERROR = "Claude could not answer this BTW question.";

export interface ClaudeBtwEngineOptions {
  claudePath: string;
  configDir: string;
  environment: Record<string, string | undefined>;
  queryFactory: QueryFactory;
  logger?: Pick<Logger, "warn" | "debug">;
}

/**
 * Answers BTW questions in a throwaway, unpersisted fork of the session's Claude conversation. The fork gets
 * read tools only, plus Write/Edit confined to the document staging directory when documents are enabled.
 */
export class ClaudeBtwEngine implements BtwEngine {
  private readonly active = new Set<AbortController>();

  constructor(private readonly options: ClaudeBtwEngineOptions) {}

  start(): void {
    // Each answer runs its own short-lived query.
  }

  stop(): void {
    for (const controller of this.active) controller.abort();
    this.active.clear();
  }

  invalidateAuthentication(): void {
    // No long-lived client holds credentials between answers.
  }

  async generate(request: BtwGenerationRequest, listener: BtwGenerationListener): Promise<BtwGeneration> {
    const controller = new AbortController();
    let interrupted = false;
    let disposed = false;
    const generation: BtwGeneration = {
      interrupt: async () => {
        interrupted = true;
        controller.abort();
      },
      dispose: async () => {
        disposed = true;
        controller.abort();
        this.active.delete(controller);
      }
    };
    if (request.signal.aborted) return generation;
    request.signal.addEventListener("abort", () => {
      interrupted = true;
      controller.abort();
    }, { once: true });
    this.active.add(controller);

    const input = new InputQueue();
    input.push({
      type: "user",
      parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "text", text: request.question }] }
    } satisfies SDKUserMessage);
    input.close();
    const documentsRoot = request.documentsRoot;
    const instructions = documentsRoot
      ? btwDocumentInstructions("Claude", documentsRoot, request.sourceCwd)
      : btwReadOnlyInstructions("Claude", request.documentsUnavailable);
    const canUseTool: CanUseTool = async (toolName, toolInput) => {
      if (READ_TOOLS.includes(toolName)) return { behavior: "allow", updatedInput: toolInput };
      if (documentsRoot && DOCUMENT_TOOLS.includes(toolName)) {
        const path = typeof toolInput.file_path === "string" ? toolInput.file_path : null;
        if (path && isWithinWritableRoots(path, { cwd: documentsRoot, writableRoots: [] })) {
          return { behavior: "allow", updatedInput: toolInput };
        }
        return { behavior: "deny", message: `BTW answers may only write inside ${documentsRoot}.` };
      }
      return { behavior: "deny", message: "BTW answers cannot use this tool." };
    };
    const model = request.session.models?.default?.model ?? undefined;
    const query = this.options.queryFactory({
      prompt: input,
      options: {
        cwd: request.session.cwd,
        pathToClaudeCodeExecutable: this.options.claudePath,
        env: { ...this.options.environment, CLAUDE_CONFIG_DIR: this.options.configDir },
        resume: request.sourceThreadId,
        forkSession: true,
        persistSession: false,
        ...(model ? { model } : {}),
        effort: "low",
        includePartialMessages: true,
        tools: documentsRoot ? [...READ_TOOLS, ...DOCUMENT_TOOLS] : READ_TOOLS,
        ...(documentsRoot ? { additionalDirectories: [documentsRoot] } : {}),
        maxTurns: BTW_MAX_TURNS,
        settingSources: [],
        permissionMode: "default",
        abortController: controller,
        systemPrompt: { type: "preset", preset: "claude_code", append: instructions, snapshot: false },
        canUseTool
      }
    });

    const emit = (callback: () => void) => {
      if (!disposed) callback();
    };
    void (async () => {
      let emitted = false;
      try {
        for await (const message of query as AsyncIterable<SDKMessage>) {
          const delta = textDelta(message, emitted);
          if (delta) {
            emitted = true;
            emit(() => listener.delta(delta));
            continue;
          }
          if (message.type !== "result") continue;
          if (interrupted) emit(() => listener.interrupted());
          else if (message.subtype === "success" && !message.is_error) emit(() => listener.completed());
          else emit(() => listener.failed(resultError(message)));
          return;
        }
        emit(() => interrupted ? listener.interrupted() : listener.failed("Claude stopped before answering this BTW question."));
      } catch (error) {
        if (interrupted || controller.signal.aborted) emit(() => listener.interrupted());
        else {
          this.options.logger?.debug({ err: error }, "Claude BTW query failed");
          emit(() => listener.failed(btwErrorMessage(error, FALLBACK_ERROR)));
        }
      } finally {
        this.active.delete(controller);
      }
    })();
    return generation;
  }
}

/** Top-level assistant text deltas; later text blocks are separated from earlier ones by a blank line. */
function textDelta(message: SDKMessage, emitted: boolean): string | null {
  if (message.type !== "stream_event" || message.parent_tool_use_id !== null) return null;
  const event = message.event;
  if (event.type === "content_block_start" && event.content_block.type === "text" && emitted) return "\n\n";
  if (event.type === "content_block_delta" && event.delta.type === "text_delta" && event.delta.text) return event.delta.text;
  return null;
}

function resultError(message: Extract<SDKMessage, { type: "result" }>): string {
  if (message.subtype === "success") return btwErrorMessage(message.result, FALLBACK_ERROR);
  if (message.subtype === "error_max_turns") return "Claude reached the BTW turn limit before answering.";
  return btwErrorMessage(message.errors?.join(" ") ?? "", FALLBACK_ERROR);
}
