import type { ManagedSession } from "@muxpilot/core";

/** One BTW answer attempt: a read-only (or document-scoped) fork of the source conversation. */
export interface BtwGenerationRequest {
  session: ManagedSession;
  /** Provider conversation the side question forks from. */
  sourceThreadId: string;
  question: string;
  /** Staging directory the answer may write session documents into; null for a read-only answer. */
  documentsRoot: string | null;
  sourceCwd: string | null;
  /** True when document editing was requested but is unavailable for this attempt. */
  documentsUnavailable: boolean;
  /** Aborted when the operator cancels before the engine has started generating. */
  signal: AbortSignal;
}

/** Callbacks for one generation. Engines stop calling them once the generation is disposed. */
export interface BtwGenerationListener {
  delta(text: string): void;
  completed(): void;
  interrupted(): void;
  failed(message: string): void;
  /** The engine's transport stopped; the generation is gone and needs no cleanup. */
  closed(message: string): void;
}

export interface BtwGeneration {
  interrupt(): Promise<void>;
  dispose(): Promise<void>;
}

/** Provider-specific backend that answers BTW side questions. */
export interface BtwEngine {
  start(): void;
  stop(): void;
  /** Called on sign-out while the engine has no active generations. */
  invalidateAuthentication(): void;
  generate(request: BtwGenerationRequest, listener: BtwGenerationListener): Promise<BtwGeneration>;
}

export function btwReadOnlyInstructions(providerName: string, documentsUnavailable: boolean): string {
  const base = `You are answering one quick side question from a snapshot of another ${providerName} conversation.
Answer directly and concisely. Do not continue, steer, or modify the source task.
This thread is strictly read-only: do not edit files, change repository state, send messages, create goals, delegate work, request user input, use network access, or perform external side effects.
You may inspect local files with read-only tools only when needed to answer accurately.
If the snapshot is incomplete or the answer cannot be established safely, say so briefly.`;
  return documentsUnavailable
    ? `${base}\nDocument editing is unavailable for this request because the session document limits were exceeded. Answer without creating or changing documents.`
    : base;
}

export function btwDocumentInstructions(providerName: string, documentsRoot: string, sourceCwd: string | null): string {
  return `You are answering one quick side request from a snapshot of another ${providerName} conversation.
Answer directly and concisely. Do not continue, steer, interrupt, or message the source task.
You may create or update Markdown session documents only when the operator explicitly asks you to do so. The only writable directory is ${JSON.stringify(documentsRoot)}.
Keep INDEX.md current when creating documents. Do not delete or rename documents. Do not edit repository files, change repository state, create goals, delegate work, request user input, use network access, or perform any other side effect.
The source workspace path is ${sourceCwd ? JSON.stringify(sourceCwd) : "unavailable"}; inspect it read-only only when needed for accurate document content.
If the snapshot is incomplete or the request cannot be completed safely, say so briefly.`;
}

export function btwErrorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 1_000) || fallback;
}
