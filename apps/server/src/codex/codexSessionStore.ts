import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export interface CodexSessionFile {
  sessionId: string;
  path: string;
  cwd: string | null;
  startedAtMs: number | null;
  updatedAtMs: number;
  sizeBytes: number;
  cliVersion: string | null;
}

interface SessionMetaLine {
  timestamp?: string;
  type: "session_meta";
  payload: {
    session_id?: string;
    id?: string;
    timestamp?: string;
    cwd?: string;
    cli_version?: string;
    source?: unknown;
  };
}

export class CodexSessionStore {
  constructor(private readonly codexHome: string) {}

  async listRecent(limit = 200): Promise<CodexSessionFile[]> {
    const root = join(this.codexHome, "sessions");
    const files = await walkJsonl(root).catch(() => []);
    const stats = await Promise.all(
      files.map(async (path) => ({
        path,
        stat: await stat(path)
      }))
    );

    const recent = stats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    const sessions: CodexSessionFile[] = [];
    const batchSize = Math.max(25, Math.min(limit, 200));
    for (let offset = 0; offset < recent.length && sessions.length < limit; offset += batchSize) {
      const parsed = await Promise.all(
        recent.slice(offset, offset + batchSize).map(async ({ path, stat: fileStat }) => {
          const meta = await readSessionMeta(path);
          if (!meta) return null;
          return {
            sessionId: meta.sessionId,
            path,
            cwd: meta.cwd,
            startedAtMs: meta.startedAtMs,
            updatedAtMs: fileStat.mtimeMs,
            sizeBytes: fileStat.size,
            cliVersion: meta.cliVersion
          } satisfies CodexSessionFile;
        })
      );
      sessions.push(...parsed.filter((item): item is CodexSessionFile => item !== null));
    }

    return sessions.slice(0, limit);
  }

  async findBestForCwd(cwd: string): Promise<CodexSessionFile | null> {
    const sessions = await this.listRecent(300);
    return sessions.find((session) => session.cwd === cwd) ?? null;
  }
}

async function walkJsonl(root: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) {
        out.push(...(await walkJsonl(path)));
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        out.push(path);
      }
    })
  );
  return out;
}

async function readSessionMeta(
  path: string
): Promise<{ sessionId: string; cwd: string | null; startedAtMs: number | null; cliVersion: string | null } | null> {
  const firstChunk = await readFileChunk(path, 0, 256 * 1024);
  const firstLine = firstChunk.split("\n").find((line) => line.includes("\"session_meta\""));
  if (!firstLine) return null;

  try {
    const event = JSON.parse(firstLine) as SessionMetaLine;
    if (isSubagentSource(event.payload.source)) return null;
    const sessionId = event.payload.session_id ?? event.payload.id;
    if (!sessionId) return null;
    return {
      sessionId,
      cwd: event.payload.cwd ?? null,
      startedAtMs: timestampMs(event.payload.timestamp ?? event.timestamp),
      cliVersion: event.payload.cli_version ?? null
    };
  } catch {
    return null;
  }
}

function isSubagentSource(source: unknown): boolean {
  return Boolean(source && typeof source === "object" && "subagent" in source);
}

async function readFileChunk(path: string, position: number, length: number): Promise<string> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await file.read(buffer, 0, length, position);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await file.close();
  }
}

function timestampMs(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}
