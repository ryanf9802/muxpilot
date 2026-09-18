import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SessionEnvironmentResponse, SessionEnvironmentVariable } from "@muxpilot/core";
import type { AppDatabase } from "../db/database.js";

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const RESERVED = /^(?:CODEX(?:_.*)?|MUXPILOT(?:_.*)?|PATH|HOME|SHELL|USER|LOGNAME|PWD|OLDPWD|TMPDIR|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|DOCKER_HOST|NODE_OPTIONS)$/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface StoredEntry { nonce: string; ciphertext: string; tag: string; updatedAt: string }
interface StoreFile { version: 1; revisions: Record<string, number>; applied: Record<string, number>; parents: Record<string, string>; keys: Record<string, StoredEntry>; entries: Record<string, Record<string, StoredEntry>> }

export class SessionEnvironmentError extends Error {
  constructor(message: string, readonly statusCode = 400) { super(message); }
}

export class SessionEnvironmentService {
  private readonly keyPath: string;
  private readonly storePath: string;
  private key: Buffer | null = null;
  private store: StoreFile = { version: 1, revisions: {}, applied: {}, parents: {}, keys: {}, entries: {} };
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly lifecycle = new Map<string, { revision: number; state: "applying" | "error"; error?: string }>();

  constructor(private readonly db: AppDatabase, dataDir: string) {
    this.keyPath = join(dataDir, "secrets", "session-environment.key");
    this.storePath = join(dataDir, "secrets", "session-environment.json");
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.keyPath), { recursive: true, mode: 0o700 });
    const existingKey = await readFile(this.keyPath).catch(() => null);
    const existingStore = await readFile(this.storePath, "utf8").catch(() => null);
    if (!existingKey) {
      if (existingStore) throw new SessionEnvironmentError("Session environment key is missing; refusing to replace it while encrypted values exist", 500);
      this.key = randomBytes(KEY_BYTES);
      await writeFile(this.keyPath, this.key, { mode: 0o600, flag: "wx" });
    } else {
      if (existingKey.length !== KEY_BYTES) throw new SessionEnvironmentError("Session environment key is invalid", 500);
      this.key = existingKey;
      await chmod(this.keyPath, 0o600);
    }
    if (existingStore) this.store = parseStore(existingStore);
  }

  async describe(sessionId: string): Promise<SessionEnvironmentResponse> {
    if (!await this.db.getSession(sessionId)) throw new SessionEnvironmentError("Session not found", 404);
    const chain = await this.ownerChain(sessionId);
    const seen = new Set<string>();
    const variables: SessionEnvironmentVariable[] = [];
    for (const ownerId of chain) {
      for (const [name, entry] of Object.entries(this.store.entries[ownerId] ?? {})) {
        if (seen.has(name)) continue;
        seen.add(name);
        variables.push({ name, ownerSessionId: ownerId, inherited: ownerId !== sessionId, updatedAt: entry.updatedAt });
      }
    }
    const desiredRevision = this.effectiveRevision(chain);
    const appliedRevision = this.store.applied[sessionId] ?? 0;
    const sortedVariables = variables.sort((a, b) => a.name.localeCompare(b.name));
    const lifecycle = this.lifecycle.get(sessionId);
    if (desiredRevision === appliedRevision) {
      this.lifecycle.delete(sessionId);
      return { variables: sortedVariables, desiredRevision, appliedRevision, state: "applied" };
    }
    return {
      variables: sortedVariables,
      desiredRevision,
      appliedRevision,
      state: lifecycle?.revision === desiredRevision ? lifecycle.state : "pending",
      error: lifecycle?.revision === desiredRevision ? lifecycle.error ?? null : null
    };
  }

  async set(sessionId: string, name: string, value: string): Promise<SessionEnvironmentResponse> {
    return this.mutate(async () => {
      await this.requireSession(sessionId);
      validateName(name);
      if (!value.length) throw new SessionEnvironmentError("Variable value cannot be empty");
      if (/[\0\r\n]/.test(value)) throw new SessionEnvironmentError("Variable value cannot contain null bytes or line breaks");
      const now = new Date().toISOString();
      this.store.entries[sessionId] ??= {};
      this.store.entries[sessionId]![name] = this.encryptWithKey(value, this.sessionKey(sessionId, now), now);
      this.bump(sessionId);
      await this.persist();
      return this.describe(sessionId);
    });
  }

  async delete(sessionId: string, name: string): Promise<SessionEnvironmentResponse> {
    return this.mutate(async () => {
      await this.requireSession(sessionId);
      if (!this.store.entries[sessionId]?.[name]) throw new SessionEnvironmentError("Session-owned variable not found", 404);
      delete this.store.entries[sessionId]![name];
      this.bump(sessionId);
      await this.persist();
      return this.describe(sessionId);
    });
  }

  async resolve(sessionId: string): Promise<Record<string, string>> {
    return (await this.resolveForLaunch(sessionId)).environment;
  }

  async resolveForLaunch(sessionId: string): Promise<{ environment: Record<string, string>; revision: number }> {
    const result: Record<string, string> = {};
    const chain = await this.ownerChain(sessionId);
    for (const ownerId of chain) {
      for (const [name, entry] of Object.entries(this.store.entries[ownerId] ?? {})) {
        if (!(name in result)) result[name] = this.decryptWithKey(entry, this.sessionKey(ownerId));
      }
    }
    return { environment: result, revision: this.effectiveRevision(chain) };
  }

  async markApplied(sessionId: string, revision?: number): Promise<void> {
    await this.mutate(async () => {
      this.store.applied[sessionId] = revision ?? this.effectiveRevision(await this.ownerChain(sessionId));
      await this.persist();
      this.lifecycle.delete(sessionId);
    });
  }

  async affectedSessionIds(ownerSessionId: string): Promise<string[]> {
    const affected: string[] = [];
    for (const session of await this.db.listSessions(false, false)) {
      if ((await this.ownerChain(session.id)).includes(ownerSessionId)) affected.push(session.id);
    }
    return affected;
  }

  async markApplying(sessionId: string): Promise<void> {
    const { desiredRevision } = await this.describe(sessionId);
    this.lifecycle.set(sessionId, { revision: desiredRevision, state: "applying" });
  }

  async markError(sessionId: string, error: string): Promise<void> {
    const { desiredRevision } = await this.describe(sessionId);
    this.lifecycle.set(sessionId, { revision: desiredRevision, state: "error", error });
  }

  async exportOwned(sessionId: string): Promise<Record<string, string>> {
    return Object.fromEntries(Object.entries(this.store.entries[sessionId] ?? {}).map(([name, value]) => [name, this.decryptWithKey(value, this.sessionKey(sessionId))]));
  }

  async importOwned(sessionId: string, values: Record<string, string>, parentSessionId?: string | null): Promise<void> {
    await this.mutate(async () => {
      const now = new Date().toISOString();
      this.store.entries[sessionId] = Object.fromEntries(Object.entries(values).map(([name, value]) => {
        validateName(name);
        return [name, this.encryptWithKey(value, this.sessionKey(sessionId, now), now)];
      }));
      if (parentSessionId) this.store.parents[sessionId] = parentSessionId;
      else delete this.store.parents[sessionId];
      this.bump(sessionId);
      await this.persist();
    });
  }

  async setReferenceParent(sessionId: string, parentSessionId: string | null): Promise<void> {
    await this.mutate(async () => {
      if (parentSessionId) this.store.parents[sessionId] = parentSessionId;
      else delete this.store.parents[sessionId];
      await this.persist();
    });
  }

  async requiredAncestors(sessionIds: readonly string[]): Promise<string[]> {
    const selected = new Set(sessionIds);
    for (const id of [...selected]) for (const owner of (await this.ownerChain(id)).slice(1)) selected.add(owner);
    return [...selected];
  }

  private async ownerChain(sessionId: string): Promise<string[]> {
    const chain: string[] = [];
    const seen = new Set<string>();
    let id: string | null = sessionId;
    while (id && !seen.has(id)) {
      chain.push(id); seen.add(id);
      const session = await this.db.getSession(id);
      id = session?.agentOwnership?.parentSessionId ?? this.store.parents[id] ?? null;
    }
    return chain;
  }

  private effectiveRevision(chain: string[]): number {
    if (chain.every((id) => (this.store.revisions[id] ?? 0) === 0)) return 0;
    let hash = 2166136261;
    for (const id of chain) { hash ^= this.store.revisions[id] ?? 0; hash = Math.imul(hash, 16777619); }
    return hash >>> 0;
  }
  private bump(id: string): void { this.store.revisions[id] = (this.store.revisions[id] ?? 0) + 1; }
  private async requireSession(id: string): Promise<void> { if (!await this.db.getSession(id)) throw new SessionEnvironmentError("Session not found", 404); }
  private sessionKey(sessionId: string, updatedAt = new Date().toISOString()): Buffer {
    const stored = this.store.keys[sessionId];
    if (stored) return Buffer.from(this.decryptWithKey(stored, this.requireKey()), "base64");
    if (Object.keys(this.store.entries[sessionId] ?? {}).length > 0) {
      throw new SessionEnvironmentError(`Encryption key for session '${sessionId}' is missing`, 500);
    }
    const key = randomBytes(KEY_BYTES);
    this.store.keys[sessionId] = this.encryptWithKey(key.toString("base64"), this.requireKey(), updatedAt);
    return key;
  }
  private encryptWithKey(value: string, key: Buffer, updatedAt: string): StoredEntry {
    const nonce = randomBytes(NONCE_BYTES); const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return { nonce: nonce.toString("base64"), ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64"), updatedAt };
  }
  private decryptWithKey(entry: StoredEntry, key: Buffer): string {
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(entry.nonce, "base64"));
      decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(entry.ciphertext, "base64")), decipher.final()]).toString("utf8");
    } catch { throw new SessionEnvironmentError("A saved session variable could not be decrypted", 500); }
  }
  private requireKey(): Buffer { if (!this.key) throw new SessionEnvironmentError("Session environment store is not initialized", 500); return this.key; }
  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.catch(() => undefined).then(operation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }
  private async persist(): Promise<void> {
    const temporary = `${this.storePath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(this.store), { mode: 0o600 });
    await rename(temporary, this.storePath); await chmod(this.storePath, 0o600);
  }
}

function validateName(name: string): void {
  if (!NAME.test(name)) throw new SessionEnvironmentError("Variable name must use letters, numbers, and underscores and cannot start with a number");
  if (RESERVED.test(name)) throw new SessionEnvironmentError(`Variable '${name}' is reserved by the session runtime`);
}
function parseStore(raw: string): StoreFile {
  const value = JSON.parse(raw) as StoreFile;
  if (value.version !== 1 || !value.entries || !value.revisions || !value.applied || !value.parents || !value.keys) throw new SessionEnvironmentError("Session environment store is invalid", 500);
  return value;
}
