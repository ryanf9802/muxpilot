import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexSessionStore, type SessionMeta } from "../src/codex/codexSessionStore.js";

const stores: CodexSessionStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.stop();
});

describe("CodexSessionStore catalog", () => {
  it("reuses discovery and metadata between the one-minute reconciliation sweeps", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "muxpilot-codex-store-"));
    const sessionsRoot = join(codexHome, "sessions");
    const path = join(sessionsRoot, "session.jsonl");
    await mkdir(sessionsRoot, { recursive: true });
    await writeFile(path, "{}\n");
    let now = 1_000;
    const walkFiles = vi.fn(async () => [path]);
    const meta: SessionMeta = { sessionId: "codex-1", cwd: "/repo", startedAtMs: 1, cliVersion: "test" };
    const readMeta = vi.fn(async () => meta);
    const store = new CodexSessionStore(codexHome, { now: () => now, reconcileIntervalMs: 60_000, walkFiles, readMeta });
    stores.push(store);

    expect(await store.listRecent()).toHaveLength(1);
    expect(await store.listRecent()).toHaveLength(1);
    expect(walkFiles).toHaveBeenCalledTimes(1);
    expect(readMeta).toHaveBeenCalledTimes(1);

    now += 60_000;
    expect(await store.listRecent()).toHaveLength(1);
    expect(walkFiles).toHaveBeenCalledTimes(2);
    expect(readMeta).toHaveBeenCalledTimes(1);
  });
});
