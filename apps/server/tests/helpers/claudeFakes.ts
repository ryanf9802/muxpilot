import type { Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { vi } from "vitest";
import type { QueryFactory } from "../../src/providers/claude/host/hostSession.js";

/**
 * A scripted Claude Agent SDK query. Tests push SDK messages into the iterator, and the fake records every user
 * message the code under test writes into the streaming prompt.
 */
export class FakeQuery {
  readonly prompts: SDKUserMessage[] = [];
  readonly interrupt = vi.fn(async () => undefined);
  readonly close = vi.fn(() => this.end());
  readonly setPermissionMode = vi.fn(async (_mode: string) => undefined);
  readonly setModel = vi.fn(async (_model?: string) => undefined);
  readonly applyFlagSettings = vi.fn(async (_flags: Record<string, unknown>) => undefined);
  readonly stopTask = vi.fn(async (_taskId: string) => undefined);
  readonly getContextUsage = vi.fn(async () => ({ totalTokens: 1 }));
  private readonly items: SDKMessage[] = [];
  private readonly waiters: Array<{ resolve(result: IteratorResult<SDKMessage>): void; reject(error: Error): void }> = [];
  private ended = false;
  private failure: Error | null = null;

  constructor(readonly prompt: AsyncIterable<SDKUserMessage>, readonly options: Options) {
    void (async () => {
      for await (const message of prompt) this.prompts.push(message);
    })();
  }

  push(message: unknown): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value: message as SDKMessage, done: false });
    else this.items.push(message as SDKMessage);
  }

  end(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
  }

  fail(error: Error): void {
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.failure) return Promise.reject(this.failure);
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
      }
    };
  }

  asQuery(): Query {
    return this as unknown as Query;
  }
}

/** Query factory that records each created fake query. */
export function fakeQueryFactory(): { factory: QueryFactory; queries: FakeQuery[]; latest(): FakeQuery } {
  const queries: FakeQuery[] = [];
  return {
    queries,
    factory: vi.fn(({ prompt, options }) => {
      const query = new FakeQuery(prompt, options);
      queries.push(query);
      return query.asQuery();
    }),
    latest: () => {
      const query = queries.at(-1);
      if (!query) throw new Error("No Claude query was created");
      return query;
    }
  };
}

/** Lets pending promise callbacks and async iterator steps run. */
export async function flush(times = 5): Promise<void> {
  for (let index = 0; index < times; index += 1) await new Promise((resolve) => setImmediate(resolve));
}
