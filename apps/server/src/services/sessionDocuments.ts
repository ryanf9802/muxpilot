import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import type { SessionDocumentResponse, SessionDocumentsResponse } from "@muxpilot/core";
import { eventId } from "../utils/ids.js";

export const MAX_SESSION_DOCUMENTS = 100;
export const MAX_SESSION_DOCUMENT_BYTES = 256 * 1024;
export const MAX_SESSION_DOCUMENT_TOTAL_BYTES = 10 * 1024 * 1024;
const DOCUMENT_NAME = /^(?=.{1,128}$)[A-Za-z0-9][A-Za-z0-9._-]*\.md$/i;
const SANDBOX_METADATA_DIRECTORIES = new Set([".agents", ".codex", ".git"]);
const SCOPE_ID = /^[A-Za-z0-9_-]{8,128}$/;
const EXCHANGE_ID = /^[A-Za-z0-9_-]{8,128}$/;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export function isSessionDocumentName(name: string): boolean {
  return DOCUMENT_NAME.test(name);
}

export interface SessionDocumentSnapshot {
  name: string;
  contents: Buffer;
  updatedAt: string;
}

export interface BtwDocumentChanges {
  created: string[];
  updated: string[];
}

export type BtwDocumentApplyResult =
  | { status: "applied"; changes: BtwDocumentChanges }
  | { status: "conflict"; names: string[] };

interface BtwDocumentBaseline {
  version: 1;
  hashes: Record<string, string>;
}

export class SessionDocumentError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = "SessionDocumentError";
  }
}

export function isSessionDocumentCapacityError(error: unknown): error is SessionDocumentError {
  return error instanceof SessionDocumentError && error.statusCode === 413;
}

export class SessionDocumentService {
  constructor(private readonly sessionRoot: string) {}

  newScopeId(): string {
    return `documents-${eventId()}`;
  }

  async ensureScope(scopeId: string): Promise<string> {
    const root = this.scopeRoot(scopeId);
    const documents = this.documentsRoot(scopeId);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await mkdir(documents, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const details = await lstat(documents);
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new SessionDocumentError("Session documents directory is invalid", 409);
    }
    return root;
  }

  documentsRoot(scopeId: string): string {
    return join(this.scopeRoot(scopeId), "documents");
  }

  async list(scopeId: string): Promise<SessionDocumentsResponse> {
    const root = this.documentsRoot(scopeId);
    await this.ensureScope(scopeId);
    return {
      documents: await listDirectory(root),
      sampledAt: new Date().toISOString()
    };
  }

  async read(scopeId: string, name: string): Promise<SessionDocumentResponse> {
    requireDocumentName(name);
    const root = this.documentsRoot(scopeId);
    await this.ensureScope(scopeId);
    const document = await readDocumentFile(root, name);
    return {
      document: {
        name,
        sizeBytes: document.contents.length,
        updatedAt: document.updatedAt,
        content: decodeDocument(document.contents)
      }
    };
  }

  async snapshot(scopeId: string): Promise<SessionDocumentSnapshot[]> {
    const root = this.documentsRoot(scopeId);
    await this.ensureScope(scopeId);
    return snapshotDirectory(root);
  }

  async persistApprovedPlan(scopeId: string, messageSequence: number, plan: string): Promise<BtwDocumentChanges> {
    if (!Number.isSafeInteger(messageSequence) || messageSequence < 1) {
      throw new SessionDocumentError("Invalid approved plan message sequence", 400);
    }
    const name = `plan-${messageSequence}.md`;
    const documents = await this.snapshot(scopeId);
    const existingPlan = documents.find((document) => document.name.toLowerCase() === name.toLowerCase());
    const contents = Buffer.from(`${plan.replace(/\s+$/, "")}\n`, "utf8");
    if (existingPlan && (existingPlan.name !== name || !existingPlan.contents.equals(contents))) {
      throw new SessionDocumentError(`Approved plan document '${name}' already exists with different content`, 409);
    }

    const index = documents.find((document) => document.name.toLowerCase() === "index.md");
    const indexName = index?.name ?? "INDEX.md";
    const link = `- [${name}](${name}) — Approved plan from message ${messageSequence}.`;
    const currentIndex = index ? decodeDocument(index.contents) : "# Session documents\n";
    const nextIndex = currentIndex.includes(`](${name})`)
      ? currentIndex
      : `${currentIndex.trimEnd()}\n\n${link}\n`;

    const created: string[] = [];
    const updated: string[] = [];
    if (!existingPlan) created.push(name);
    if (!index) created.push(indexName);
    else if (nextIndex !== currentIndex) updated.push(indexName);
    if (created.length === 0 && updated.length === 0) return { created, updated };

    const replacements = new Map<string, SessionDocumentSnapshot>([
      [name.toLowerCase(), { name, contents, updatedAt: new Date().toISOString() }],
      [indexName.toLowerCase(), { name: indexName, contents: Buffer.from(nextIndex, "utf8"), updatedAt: new Date().toISOString() }]
    ]);
    await this.replace(scopeId, [
      ...documents.filter((document) => !replacements.has(document.name.toLowerCase())),
      ...replacements.values()
    ]);
    return { created, updated };
  }

  async prepareBtwStaging(scopeId: string, exchangeId: string): Promise<string> {
    const source = await this.snapshot(scopeId);
    const root = this.btwStagingRoot(scopeId, exchangeId);
    const documents = join(root, "documents");
    await rm(root, { recursive: true, force: true });
    await mkdir(documents, { recursive: true, mode: 0o700 });
    for (const document of source) {
      await writeFile(join(documents, document.name), document.contents, { mode: 0o600 });
    }
    const baseline: BtwDocumentBaseline = {
      version: 1,
      hashes: Object.fromEntries(source.map((document) => [document.name, documentHash(document.contents)]))
    };
    await writeFile(join(root, "baseline.json"), JSON.stringify(baseline), { mode: 0o600 });
    return documents;
  }

  async inspectBtwStaging(scopeId: string, exchangeId: string): Promise<BtwDocumentChanges> {
    const baseline = await this.readBtwBaseline(scopeId, exchangeId);
    const staged = await snapshotDirectory(join(this.btwStagingRoot(scopeId, exchangeId), "documents"));
    const stagedByName = new Map(staged.map((document) => [document.name, document]));
    const missing = Object.keys(baseline.hashes).filter((name) => !stagedByName.has(name));
    if (missing.length > 0) throw new SessionDocumentError(`BTW cannot delete or rename document '${missing[0]}'`, 409);
    return {
      created: staged.filter((document) => baseline.hashes[document.name] === undefined).map((document) => document.name),
      updated: staged.filter((document) => {
        const previous = baseline.hashes[document.name];
        return previous !== undefined && previous !== documentHash(document.contents);
      }).map((document) => document.name)
    };
  }

  async applyBtwStaging(scopeId: string, exchangeId: string): Promise<BtwDocumentApplyResult> {
    const baseline = await this.readBtwBaseline(scopeId, exchangeId);
    const stagingRoot = join(this.btwStagingRoot(scopeId, exchangeId), "documents");
    const staged = await snapshotDirectory(stagingRoot);
    const changes = await this.inspectBtwStaging(scopeId, exchangeId);
    const touched = [...changes.created, ...changes.updated];
    const current = await this.snapshot(scopeId);
    const currentByName = new Map(current.map((document) => [document.name.toLowerCase(), document]));
    const conflicts: string[] = [];
    for (const name of changes.created) {
      if (currentByName.has(name.toLowerCase())) conflicts.push(name);
    }
    for (const name of changes.updated) {
      const existing = currentByName.get(name.toLowerCase());
      if (!existing || existing.name !== name || documentHash(existing.contents) !== baseline.hashes[name]) conflicts.push(name);
    }
    if (conflicts.length > 0) return { status: "conflict", names: conflicts };

    const stagedByName = new Map(staged.map((document) => [document.name.toLowerCase(), document]));
    const touchedKeys = new Set(touched.map((name) => name.toLowerCase()));
    const merged = [
      ...current.filter((document) => !touchedKeys.has(document.name.toLowerCase())),
      ...touched.map((name) => stagedByName.get(name.toLowerCase())!).filter(Boolean)
    ];
    await this.replace(scopeId, merged);
    return { status: "applied", changes };
  }

  async cleanupBtwStaging(scopeId: string, exchangeId: string): Promise<void> {
    await rm(this.btwStagingRoot(scopeId, exchangeId), { recursive: true, force: true });
  }

  private async readBtwBaseline(scopeId: string, exchangeId: string): Promise<BtwDocumentBaseline> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(this.btwStagingRoot(scopeId, exchangeId), "baseline.json"), "utf8"));
    } catch {
      throw new SessionDocumentError("BTW document staging is unavailable", 409);
    }
    if (!parsed || typeof parsed !== "object" || (parsed as { version?: unknown }).version !== 1) {
      throw new SessionDocumentError("BTW document staging is invalid", 409);
    }
    const hashes = (parsed as { hashes?: unknown }).hashes;
    if (!hashes || typeof hashes !== "object" || Array.isArray(hashes)) {
      throw new SessionDocumentError("BTW document staging is invalid", 409);
    }
    const entries = Object.entries(hashes);
    if (entries.some(([name, hash]) => !isSessionDocumentName(name) || typeof hash !== "string" || !/^[a-f\d]{64}$/.test(hash))) {
      throw new SessionDocumentError("BTW document staging is invalid", 409);
    }
    return { version: 1, hashes: Object.fromEntries(entries) };
  }

  private btwStagingRoot(scopeId: string, exchangeId: string): string {
    if (!EXCHANGE_ID.test(exchangeId)) throw new SessionDocumentError("Invalid BTW exchange", 400);
    return join(this.scopeRoot(scopeId), "btw-staging", exchangeId);
  }

  async replace(scopeId: string, documents: SessionDocumentSnapshot[]): Promise<void> {
    validateSessionDocumentSnapshots(documents);
    const scopeRoot = this.scopeRoot(scopeId);
    await mkdir(scopeRoot, { recursive: true, mode: 0o700 });
    const destination = this.documentsRoot(scopeId);
    const temporary = join(scopeRoot, `documents-import-${eventId()}`);
    const backup = join(scopeRoot, `documents-backup-${eventId()}`);
    await mkdir(temporary, { mode: 0o700 });
    let backedUp = false;
    try {
      for (const document of documents) {
        await writeFile(join(temporary, document.name), document.contents, { mode: 0o600 });
      }
      await rename(destination, backup).then(
        () => { backedUp = true; },
        (error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }
      );
      await rename(temporary, destination);
      if (backedUp) await rm(backup, { recursive: true, force: true }).catch(() => undefined);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      if (backedUp) await rename(backup, destination).catch(() => undefined);
      throw error;
    }
  }

  async copy(sourceScopeId: string | null | undefined, destinationScopeId: string): Promise<void> {
    const documents = sourceScopeId ? await this.snapshot(sourceScopeId) : [];
    await this.replace(destinationScopeId, documents);
  }

  private scopeRoot(scopeId: string): string {
    if (!SCOPE_ID.test(scopeId)) throw new SessionDocumentError("Invalid document scope", 400);
    const root = resolve(this.sessionRoot);
    const candidate = resolve(root, scopeId);
    if (candidate === root || !candidate.startsWith(`${root}${sep}`)) throw new SessionDocumentError("Invalid document scope", 400);
    return candidate;
  }
}

async function listDirectory(root: string): Promise<SessionDocumentsResponse["documents"]> {
  const rootDetails = await lstat(root).catch(() => null);
  if (!rootDetails?.isDirectory() || rootDetails.isSymbolicLink()) {
    throw new SessionDocumentError("Session documents directory is invalid", 409);
  }
  const documents: SessionDocumentsResponse["documents"] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (await isEmptySandboxMetadataDirectory(root, entry.name, entry.isDirectory())) continue;
    requireDocumentName(entry.name);
    const document = await openDocument(root, entry.name);
    try {
      const details = await document.stat();
      if (!details.isFile()) throw new SessionDocumentError(`Document '${entry.name}' is not a regular file`, 409);
      documents.push({ name: entry.name, sizeBytes: details.size, updatedAt: details.mtime.toISOString() });
    } finally {
      await document.close();
    }
  }
  return documents.sort((first, second) => documentNameOrder(first.name, second.name));
}

async function readDocumentFile(root: string, name: string): Promise<SessionDocumentSnapshot> {
  const document = await openDocument(root, name, true);
  try {
    const details = await document.stat();
    if (!details.isFile()) throw new SessionDocumentError(`Document '${name}' is not a regular file`, 409);
    const contents = await document.readFile();
    decodeDocument(contents);
    return { name, contents, updatedAt: details.mtime.toISOString() };
  } finally {
    await document.close();
  }
}

async function openDocument(root: string, name: string, missingIsNotFound = false) {
  try {
    return await open(join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (missingIsNotFound && (error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SessionDocumentError("Document not found", 404);
    }
    throw new SessionDocumentError(`Document '${name}' is not a regular file`, 409);
  }
}

async function snapshotDirectory(root: string): Promise<SessionDocumentSnapshot[]> {
  const rootDetails = await lstat(root).catch(() => null);
  if (!rootDetails?.isDirectory() || rootDetails.isSymbolicLink()) {
    throw new SessionDocumentError("Session documents directory is invalid", 409);
  }
  const entries = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (await isEmptySandboxMetadataDirectory(root, entry.name, entry.isDirectory())) continue;
    entries.push(entry);
  }
  const names = entries.map((entry) => entry.name);
  if (names.length > MAX_SESSION_DOCUMENTS) throw new SessionDocumentError("Session has more than 100 documents", 413);

  const snapshots: SessionDocumentSnapshot[] = [];
  let totalBytes = 0;
  for (const name of names) {
    requireDocumentName(name);
    const path = join(root, name);
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      throw new SessionDocumentError(`Document '${name}' is not a regular file`, 409);
    }
    try {
      const details = await handle.stat();
      if (!details.isFile()) throw new SessionDocumentError(`Document '${name}' is not a regular file`, 409);
      if (details.size > MAX_SESSION_DOCUMENT_BYTES) {
        throw new SessionDocumentError(`Document '${name}' exceeds the 256 KiB limit`, 413);
      }
      totalBytes += details.size;
      if (totalBytes > MAX_SESSION_DOCUMENT_TOTAL_BYTES) {
        throw new SessionDocumentError("Session documents exceed the 10 MiB total limit", 413);
      }
      const contents = await handle.readFile();
      decodeDocument(contents);
      snapshots.push({ name, contents, updatedAt: details.mtime.toISOString() });
    } finally {
      await handle.close();
    }
  }
  return snapshots.sort((first, second) => documentNameOrder(first.name, second.name));
}

async function isEmptySandboxMetadataDirectory(root: string, name: string, isDirectory: boolean): Promise<boolean> {
  if (!isDirectory || !SANDBOX_METADATA_DIRECTORIES.has(name)) return false;
  try {
    return (await readdir(join(root, name))).length === 0;
  } catch {
    return false;
  }
}

function documentHash(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

function requireDocumentName(name: string): void {
  if (!isSessionDocumentName(name)) throw new SessionDocumentError("Invalid document name", 400);
}

function decodeDocument(contents: Buffer): string {
  try {
    return utf8Decoder.decode(contents);
  } catch {
    throw new SessionDocumentError("Document is not valid UTF-8 Markdown", 422);
  }
}

export function validateSessionDocumentSnapshots(documents: SessionDocumentSnapshot[]): void {
  if (documents.length > MAX_SESSION_DOCUMENTS) throw new SessionDocumentError("Session has more than 100 documents", 413);
  const names = new Set<string>();
  let totalBytes = 0;
  for (const document of documents) {
    requireDocumentName(document.name);
    const key = document.name.toLowerCase();
    if (names.has(key)) throw new SessionDocumentError(`Duplicate document '${document.name}'`, 409);
    names.add(key);
    if (document.contents.length > MAX_SESSION_DOCUMENT_BYTES) {
      throw new SessionDocumentError(`Document '${document.name}' exceeds the 256 KiB limit`, 413);
    }
    totalBytes += document.contents.length;
    if (totalBytes > MAX_SESSION_DOCUMENT_TOTAL_BYTES) {
      throw new SessionDocumentError("Session documents exceed the 10 MiB total limit", 413);
    }
    decodeDocument(document.contents);
  }
}

function documentNameOrder(first: string, second: string): number {
  if (first.toLowerCase() === "index.md") return -1;
  if (second.toLowerCase() === "index.md") return 1;
  return first.localeCompare(second, undefined, { sensitivity: "base" });
}
