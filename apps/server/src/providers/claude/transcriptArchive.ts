import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { Logger } from "pino";

interface ArchiveMeta {
  threadId: string;
  nativePath: string;
  mirroredAt: string;
}

/**
 * Durable copies of Claude session transcripts. Claude Code deletes `projects/<slug>/<id>.jsonl` and the session's
 * `<id>/` directory (subagents, tool results) after `cleanupPeriodDays`, and any Claude process on the machine does
 * the sweep. muxpilot mirrors each session here and restores it to the native path before anything resumes it.
 *
 * Transcripts are append-only, so a copy only ever replaces a shorter one; restores never truncate native files.
 */
export class ClaudeTranscriptArchive {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(
    private readonly root: string,
    private readonly logger?: Pick<Logger, "warn" | "debug">,
    private readonly now: () => Date = () => new Date()
  ) {}

  /** Copies the native transcript and its session directory into the archive. */
  mirror(threadId: string | null, nativePath: string | null): Promise<void> {
    if (!threadId || !nativePath) return Promise.resolve();
    return this.serialize(threadId, async () => {
      const target = this.threadDir(threadId);
      const copied = await copyIfLonger(nativePath, join(target, "transcript.jsonl"));
      const sessionDir = sessionDirectory(nativePath);
      const copiedFiles = await copyTreeIfLonger(sessionDir, join(target, "session"));
      if (!copied && copiedFiles === 0 && await exists(join(target, "meta.json"))) return;
      if (!await exists(join(target, "transcript.jsonl"))) return;
      await writeAtomic(join(target, "meta.json"), JSON.stringify({
        threadId,
        nativePath,
        mirroredAt: this.now().toISOString()
      } satisfies ArchiveMeta));
    }).catch((error) => {
      this.logger?.warn({ err: error, threadId }, "Claude transcript archive mirror failed");
    });
  }

  /**
   * Restores an archived transcript whose native copy is missing or shorter. `nativePath` defaults to where the
   * transcript lived when it was archived. Returns whether the native transcript exists afterwards.
   */
  ensureRestored(threadId: string | null, nativePath?: string | null): Promise<boolean> {
    if (!threadId) return Promise.resolve(false);
    return this.serialize(threadId, async () => {
      const source = this.threadDir(threadId);
      const meta = await this.readMeta(threadId);
      const destination = nativePath ?? meta?.nativePath ?? null;
      if (!destination) return false;
      if (meta) {
        await copyIfLonger(join(source, "transcript.jsonl"), destination);
        await copyTreeIfLonger(join(source, "session"), sessionDirectory(destination));
      }
      return exists(destination);
    });
  }

  /** The archived transcript, for readers that only need the content (export). */
  async readTranscript(threadId: string): Promise<Buffer | null> {
    return readFile(join(this.threadDir(threadId), "transcript.jsonl")).catch(() => null);
  }

  async remove(threadId: string): Promise<void> {
    await this.serialize(threadId, () => rm(this.threadDir(threadId), { recursive: true, force: true }));
  }

  private async readMeta(threadId: string): Promise<ArchiveMeta | null> {
    try {
      const meta = JSON.parse(await readFile(join(this.threadDir(threadId), "meta.json"), "utf8")) as Partial<ArchiveMeta>;
      return typeof meta.nativePath === "string" && typeof meta.threadId === "string"
        ? { threadId: meta.threadId, nativePath: meta.nativePath, mirroredAt: String(meta.mirroredAt ?? "") }
        : null;
    } catch {
      return null;
    }
  }

  private threadDir(threadId: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(threadId) || threadId === "." || threadId === "..") {
      throw new Error(`Invalid Claude session id for archive: ${threadId}`);
    }
    return join(this.root, threadId);
  }

  private serialize<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(threadId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.tails.set(threadId, tail);
    void tail.finally(() => {
      if (this.tails.get(threadId) === tail) this.tails.delete(threadId);
    });
    return result;
  }
}

/** `projects/<slug>/<id>.jsonl` keeps subagent transcripts and tool results under `projects/<slug>/<id>/`. */
export function sessionDirectory(transcriptPath: string): string {
  return transcriptPath.replace(/\.jsonl$/, "");
}

async function copyIfLonger(source: string, destination: string): Promise<boolean> {
  const sourceSize = await fileSize(source);
  if (sourceSize === null) return false;
  const destinationSize = await fileSize(destination);
  if (destinationSize !== null && destinationSize >= sourceSize) return false;
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.tmp`;
  await copyFile(source, temporary);
  await rename(temporary, destination);
  return true;
}

async function copyTreeIfLonger(source: string, destination: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(source, { withFileTypes: true, recursive: true });
  } catch {
    return 0;
  }
  let copied = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const from = join(entry.parentPath, entry.name);
    if (await copyIfLonger(from, join(destination, relative(source, from)))) copied += 1;
  }
  return copied;
}

async function fileSize(path: string): Promise<number | null> {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  return (await fileSize(path)) !== null;
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, path);
}
