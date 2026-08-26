import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import type { SessionDocumentResponse, SessionDocumentsResponse } from "@muxpilot/core";
import { eventId } from "../utils/ids.js";

export const MAX_SESSION_DOCUMENTS = 100;
export const MAX_SESSION_DOCUMENT_BYTES = 256 * 1024;
export const MAX_SESSION_DOCUMENT_TOTAL_BYTES = 10 * 1024 * 1024;
const DOCUMENT_NAME = /^(?=.{1,128}$)[A-Za-z0-9][A-Za-z0-9._-]*\.md$/i;
const SCOPE_ID = /^[A-Za-z0-9_-]{8,128}$/;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export function isSessionDocumentName(name: string): boolean {
  return DOCUMENT_NAME.test(name);
}

export interface SessionDocumentSnapshot {
  name: string;
  contents: Buffer;
  updatedAt: string;
}

export class SessionDocumentError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = "SessionDocumentError";
  }
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
    const snapshots = await this.snapshot(scopeId);
    return {
      documents: snapshots.map(({ name, contents, updatedAt }) => ({ name, sizeBytes: contents.length, updatedAt })),
      sampledAt: new Date().toISOString()
    };
  }

  async read(scopeId: string, name: string): Promise<SessionDocumentResponse> {
    requireDocumentName(name);
    const document = (await this.snapshot(scopeId)).find((candidate) => candidate.name === name);
    if (!document) throw new SessionDocumentError("Document not found", 404);
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
    const entries = await readdir(root, { withFileTypes: true });
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
