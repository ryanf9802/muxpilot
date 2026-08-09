import { watch, type FSWatcher } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

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

export interface SessionMeta {
  sessionId: string;
  cwd: string | null;
  startedAtMs: number | null;
  cliVersion: string | null;
}

interface CatalogEntry {
  path: string;
  sizeBytes: number;
  updatedAtMs: number;
  meta: SessionMeta | null | undefined;
}

export interface CodexSessionStoreOptions {
  reconcileIntervalMs?: number;
  now?: () => number;
  walkFiles?: (root: string) => Promise<string[]>;
  readMeta?: (path: string) => Promise<SessionMeta | null>;
}

const DEFAULT_RECONCILE_INTERVAL_MS = 60_000;

export class CodexSessionStore {
  private readonly root: string;
  private readonly reconcileIntervalMs: number;
  private readonly now: () => number;
  private readonly walkFiles: (root: string) => Promise<string[]>;
  private readonly readMeta: (path: string) => Promise<SessionMeta | null>;
  private readonly catalog = new Map<string, CatalogEntry>();
  private readonly changedPaths = new Set<string>();
  private watcher: FSWatcher | null = null;
  private initialized = false;
  private forceReconcile = false;
  private nextReconcileAt = 0;
  private refreshPromise: Promise<void> | null = null;

  constructor(private readonly codexHome: string, options: CodexSessionStoreOptions = {}) {
    this.root = join(this.codexHome, "sessions");
    this.reconcileIntervalMs = options.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.walkFiles = options.walkFiles ?? walkJsonl;
    this.readMeta = options.readMeta ?? readSessionMeta;
  }

  async listRecent(limit = 200): Promise<CodexSessionFile[]> {
    await this.refreshCatalog();
    const recent = [...this.catalog.values()].sort(compareCatalogEntries);
    const sessions: CodexSessionFile[] = [];
    const batchSize = Math.max(25, Math.min(limit, 200));
    for (let offset = 0; offset < recent.length && sessions.length < limit; offset += batchSize) {
      const parsed = await Promise.all(
        recent.slice(offset, offset + batchSize).map((entry) => this.sessionFile(entry))
      );
      sessions.push(...parsed.filter((item): item is CodexSessionFile => item !== null));
    }
    return sessions.slice(0, limit);
  }

  async findBestForCwd(cwd: string): Promise<CodexSessionFile | null> {
    const sessions = await this.listRecent(300);
    return sessions.find((session) => session.cwd === cwd) ?? null;
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    this.changedPaths.clear();
  }

  private async refreshCatalog(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.performRefresh().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async performRefresh(): Promise<void> {
    if (!this.initialized || this.forceReconcile || this.now() >= this.nextReconcileAt) {
      await this.reconcileCatalog();
      this.ensureWatcher();
      return;
    }
    await this.applyChangedPaths();
  }

  private async reconcileCatalog(): Promise<void> {
    const files = await this.walkFiles(this.root).catch(() => []);
    const observed = await Promise.all(
      files.map(async (path) => ({ path, fileStat: await stat(path).catch(() => null) }))
    );
    const seen = new Set<string>();
    for (const { path, fileStat } of observed) {
      if (!fileStat?.isFile()) continue;
      seen.add(path);
      this.updateCatalogEntry(path, fileStat.size, fileStat.mtimeMs);
    }
    for (const path of this.catalog.keys()) {
      if (!seen.has(path)) this.catalog.delete(path);
    }
    this.changedPaths.clear();
    this.initialized = true;
    this.forceReconcile = false;
    this.nextReconcileAt = this.now() + this.reconcileIntervalMs;
  }

  private async applyChangedPaths(): Promise<void> {
    const paths = [...this.changedPaths];
    this.changedPaths.clear();
    await Promise.all(paths.map(async (path) => {
      const fileStat = await stat(path).catch(() => null);
      if (!fileStat?.isFile()) {
        this.catalog.delete(path);
        return;
      }
      this.updateCatalogEntry(path, fileStat.size, fileStat.mtimeMs);
    }));
  }

  private updateCatalogEntry(path: string, sizeBytes: number, updatedAtMs: number): void {
    const existing = this.catalog.get(path);
    const changed = !existing || existing.sizeBytes !== sizeBytes || existing.updatedAtMs !== updatedAtMs;
    this.catalog.set(path, {
      path,
      sizeBytes,
      updatedAtMs,
      meta: existing?.meta === null && changed ? undefined : existing?.meta
    });
  }

  private ensureWatcher(): void {
    if (this.watcher) return;
    try {
      this.watcher = watch(this.root, { recursive: true }, (_eventType, filename) => {
        if (!filename) {
          this.forceReconcile = true;
          return;
        }
        const relative = filename.toString();
        if (!relative.endsWith(".jsonl")) {
          this.forceReconcile = true;
          return;
        }
        this.changedPaths.add(resolve(this.root, relative));
      });
      this.watcher.on("error", () => {
        this.watcher?.close();
        this.watcher = null;
        this.nextReconcileAt = Math.min(this.nextReconcileAt, this.now() + this.reconcileIntervalMs);
      });
    } catch {
      this.nextReconcileAt = this.now() + this.reconcileIntervalMs;
    }
  }

  private async sessionFile(entry: CatalogEntry): Promise<CodexSessionFile | null> {
    if (entry.meta === undefined) entry.meta = await this.readMeta(entry.path);
    if (!entry.meta) return null;
    return {
      ...entry.meta,
      path: entry.path,
      updatedAtMs: entry.updatedAtMs,
      sizeBytes: entry.sizeBytes
    };
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

async function readSessionMeta(path: string): Promise<SessionMeta | null> {
  const firstChunk = await readFileChunk(path, 0, 256 * 1024);
  const firstLine = firstChunk.split("\n").find((line) => line.includes("\"session_meta\""));
  if (!firstLine) return null;

  try {
    const event = JSON.parse(firstLine) as SessionMetaLine;
    if (isSubagentSession(event.payload)) return null;
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

function isSubagentSession(payload: SessionMetaLine["payload"]): boolean {
  const source = payload.source;
  if (source && typeof source === "object" && "subagent" in source) return true;
  return Boolean(payload.id && payload.session_id && payload.id !== payload.session_id);
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

function compareCatalogEntries(first: CatalogEntry, second: CatalogEntry): number {
  return second.updatedAtMs - first.updatedAtMs || first.path.localeCompare(second.path);
}

function timestampMs(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}
