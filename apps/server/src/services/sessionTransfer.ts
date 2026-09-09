import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import { extract, pack } from "tar-stream";
import { nanoid } from "nanoid";
import type {
  AgentProviderRef,
  CollaborationMode,
  ManagedSession,
  SessionModelSelections,
  SessionForkOrigin,
  SessionTransferImportBranchResult,
  SessionTransferImportMapping,
  SessionTransferImportResponse,
  SessionTransferInspectResponse,
  SessionTransferMappingRequirement
} from "@muxpilot/core";
import type { AppDatabase } from "../db/database.js";
import {
  exportPortableGitBranch,
  importPortableGitBranches,
  type PortableGitBranch
} from "./gitBranchTransfer.js";
import type { SessionManager } from "./sessionManager.js";
import {
  MAX_SESSION_DOCUMENT_BYTES,
  MAX_SESSION_DOCUMENTS,
  MAX_SESSION_DOCUMENT_TOTAL_BYTES,
  isSessionDocumentName,
  validateSessionDocumentSnapshots,
  type SessionDocumentSnapshot
} from "./sessionDocuments.js";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const MAGIC = Buffer.from("MPSESSN2", "ascii");
const FLAG_ENCRYPTED = 1;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const TOKEN_TTL_MS = 30 * 60_000;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_SESSIONS = 500;

export interface PortableSession {
  codexSessionId: string;
  sessionName: string;
  sourceCwd: string;
  repoName: string;
  workspaceMode: "directory" | "git";
  targetBranch: string | null;
  inputMode: CollaborationMode;
  models: SessionModelSelections;
  fastMode?: boolean | null;
  pinned: boolean;
  forkedFrom?: SessionForkOrigin | null;
  lastActivityAt: string | null;
  transcriptEntry: string;
  transcriptBytes: number;
  transcriptSha256: string;
  gitBranchId?: string | null;
  documents?: PortableDocument[];
  provider?: AgentProviderRef;
  name?: string;
  cwd?: string;
}

const PORTABLE_SESSION_KEYS = new Set<keyof PortableSession>([
  "codexSessionId", "sessionName", "sourceCwd", "repoName", "workspaceMode", "targetBranch",
  "inputMode", "models", "fastMode", "pinned", "forkedFrom", "lastActivityAt", "transcriptEntry",
  "transcriptBytes", "transcriptSha256", "gitBranchId", "documents", "provider", "name", "cwd"
]);

export interface PortableDocument {
  name: string;
  entry: string;
  bytes: number;
  sha256: string;
}

interface Manifest {
  formatVersion: 6;
  createdAt: string;
  sessions: PortableSession[];
  gitBranches: PortableGitBranch[];
}

export interface SessionTransferExport {
  contents: Buffer;
  filename: string;
}

interface StagedTransfer {
  path: string;
  encrypted: boolean;
  manifest: Manifest;
  expiresAtMs: number;
}

export class SessionTransferError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
  }
}

export class SessionTransferService {
  private readonly staged = new Map<string, StagedTransfer>();
  private readonly stagingDir = join(tmpdir(), `muxpilot-session-transfers-${process.pid}`);

  constructor(
    private readonly db: AppDatabase,
    private readonly manager: SessionManager,
    private readonly encryptionKey?: string
  ) {}

  encryptionEnabled(): boolean {
    return Boolean(this.encryptionKey);
  }

  async initialize(): Promise<void> {
    await rm(this.stagingDir, { recursive: true, force: true });
    await mkdir(this.stagingDir, { recursive: true, mode: 0o700 });
  }

  async export(sessionIds: string[]): Promise<SessionTransferExport> {
    const uniqueIds = [...new Set(sessionIds)];
    if (uniqueIds.length === 0) throw new SessionTransferError("Select at least one session");
    if (uniqueIds.length > MAX_SESSIONS) throw new SessionTransferError(`At most ${MAX_SESSIONS} sessions can be exported`);

    const createdAt = new Date().toISOString();
    const manifest: Manifest = { formatVersion: 6, createdAt, sessions: [], gitBranches: [] };
    const contents = new Map<string, Buffer>();
    const branchIds = new Map<string, string>();
    const codexSessionIds = new Set<string>();
    for (const [index, id] of uniqueIds.entries()) {
      const session = await this.db.getSession(id);
      if (!session?.codexSessionId || !session.codexJsonlPath) throw new SessionTransferError(`Session '${id}' does not have a portable Codex transcript`, 409);
      if (codexSessionIds.has(session.codexSessionId)) throw new SessionTransferError("The selection contains more than one record for the same Codex session", 409);
      codexSessionIds.add(session.codexSessionId);
      const file = await readFile(session.codexJsonlPath).catch(() => null);
      if (!file) throw new SessionTransferError(`Transcript for session '${id}' is unavailable`, 409);
      const transcript = completeJsonlPrefix(file);
      const entry = `sessions/${String(index + 1).padStart(4, "0")}.jsonl`;
      contents.set(entry, transcript);
      let gitBranchId: string | null = null;
      if (session.gitWorkspace) {
        const key = `${session.gitWorkspace.entryPath}\u0000${session.gitWorkspace.targetBranch}`;
        gitBranchId = branchIds.get(key) ?? null;
        if (!gitBranchId) {
          gitBranchId = `branch-${String(manifest.gitBranches.length + 1).padStart(4, "0")}`;
          const bundleEntry = `git/${String(manifest.gitBranches.length + 1).padStart(4, "0")}.bundle`;
          try {
            const exported = await exportPortableGitBranch(
              session.gitWorkspace.entryPath,
              session.gitWorkspace.targetBranch,
              gitBranchId,
              bundleEntry
            );
            manifest.gitBranches.push(exported.branch);
            if (exported.bundle) contents.set(bundleEntry, exported.bundle);
          } catch (error) {
            throw new SessionTransferError(
              `Unable to export Git branch '${session.gitWorkspace.targetBranch}': ${error instanceof Error ? error.message : String(error)}`,
              409
            );
          }
          branchIds.set(key, gitBranchId);
        }
      }
      const documents = await this.manager.snapshotDocuments(id);
      const portableDocuments = documents.map((document, documentIndex) => {
        const documentEntry = `documents/${String(index + 1).padStart(4, "0")}/${String(documentIndex + 1).padStart(4, "0")}.md`;
        contents.set(documentEntry, document.contents);
        return {
          name: document.name,
          entry: documentEntry,
          bytes: document.contents.length,
          sha256: sha256(document.contents)
        };
      });
      manifest.sessions.push({ ...portableSession(session, entry, transcript, gitBranchId), documents: portableDocuments });
    }

    const archive = await buildTar(manifest, contents);
    const compressed = await gzipAsync(archive, { level: 6 });
    const envelope = await encodeEnvelope(compressed, this.encryptionKey);
    if (envelope.length > MAX_ARCHIVE_BYTES) throw new SessionTransferError("Export exceeds the 512 MiB archive limit", 413);
    return {
      contents: envelope,
      filename: sessionTransferFilename(manifest.sessions.map((session) => session.sessionName), Boolean(this.encryptionKey), createdAt)
    };
  }

  async inspect(file: Buffer): Promise<SessionTransferInspectResponse> {
    if (file.length > MAX_ARCHIVE_BYTES) throw new SessionTransferError("Session archive exceeds the 512 MiB upload limit", 413);
    const decoded = await decodeEnvelope(file, this.encryptionKey);
    const contents = await readTar(await gunzipArchive(decoded.payload));
    const manifest = parseManifest(contents.get("manifest.json"));
    validateTranscripts(manifest, contents);

    await mkdir(this.stagingDir, { recursive: true, mode: 0o700 });
    const token = nanoid(32);
    const path = join(this.stagingDir, `${token}.mpsession`);
    await writeFile(path, file, { mode: 0o600 });
    const expiresAtMs = Date.now() + TOKEN_TTL_MS;
    this.staged.set(token, { path, encrypted: decoded.encrypted, manifest, expiresAtMs });
    const expiry = setTimeout(() => void this.cancel(token), TOKEN_TTL_MS);
    expiry.unref();
    this.pruneExpired();
    return {
      token,
      encrypted: decoded.encrypted,
      expiresAt: new Date(expiresAtMs).toISOString(),
      formatVersion: manifest.formatVersion,
      sessions: manifest.sessions.map((session) => ({
        codexSessionId: session.codexSessionId,
        sessionName: session.sessionName,
        sourceCwd: session.sourceCwd,
        repoName: session.repoName,
        workspaceMode: session.workspaceMode,
        targetBranch: session.targetBranch,
        transcriptBytes: session.transcriptBytes,
        lastActivityAt: session.lastActivityAt,
        documentCount: session.documents?.length ?? 0
      })),
      mappings: uniqueMappings(manifest)
    };
  }

  async import(token: string, mappings: SessionTransferImportMapping[]): Promise<SessionTransferImportResponse> {
    const staged = this.requireStage(token);
    const mappingBySource = new Map(mappings.map((mapping) => [mapping.sourceCwd, mapping]));
    for (const session of staged.manifest.sessions) {
      if (!mappingBySource.has(session.sourceCwd)) throw new SessionTransferError(`Missing destination mapping for '${session.sourceCwd}'`);
      this.manager.assertPortableRuntimeAvailable(mappingBySource.get(session.sourceCwd)!);
      if (session.workspaceMode === "git") continue;
      try {
        await this.manager.validatePortableMapping(session, mappingBySource.get(session.sourceCwd)!);
      } catch (error) {
        throw new SessionTransferError(error instanceof Error ? error.message : String(error));
      }
    }

    const file = await readFile(staged.path);
    const decoded = await decodeEnvelope(file, this.encryptionKey);
    const contents = await readTar(await gunzipArchive(decoded.payload));
    const manifest = parseManifest(contents.get("manifest.json"));
    validateTranscripts(manifest, contents);

    let branches: SessionTransferImportBranchResult[];
    try {
      branches = await importPortableGitBranches(manifest.gitBranches, contents, mappings);
    } catch (error) {
      throw new SessionTransferError(error instanceof Error ? error.message : String(error), 409);
    }
    for (const session of manifest.sessions.filter((candidate) => candidate.workspaceMode === "git")) {
      try {
        await this.manager.validatePortableMapping(session, mappingBySource.get(session.sourceCwd)!);
      } catch (error) {
        throw new SessionTransferError(error instanceof Error ? error.message : String(error));
      }
    }

    const results = [];
    for (const session of manifest.sessions) {
      const mapping = mappingBySource.get(session.sourceCwd)!;
      const transcript = contents.get(session.transcriptEntry)!;
      try {
        const documents = sessionDocuments(session, contents);
        results.push(await this.manager.importPortableSession(session, transcript, mapping, documents));
      } catch (error) {
        results.push({
          codexSessionId: session.codexSessionId,
          sessionName: session.sessionName,
          status: "resume_failed" as const,
          sessionId: null,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    await this.cancel(token);
    return { results, branches };
  }

  async cancel(token: string): Promise<void> {
    const staged = this.staged.get(token);
    this.staged.delete(token);
    if (staged) await rm(staged.path, { force: true });
  }

  private requireStage(token: string): StagedTransfer {
    const staged = this.staged.get(token);
    if (!staged || staged.expiresAtMs <= Date.now()) {
      if (staged) void this.cancel(token);
      throw new SessionTransferError("Import preview expired; upload the file again", 410);
    }
    return staged;
  }

  private pruneExpired(): void {
    for (const [token, staged] of this.staged) if (staged.expiresAtMs <= Date.now()) void this.cancel(token);
  }
}

function portableSession(
  session: ManagedSession,
  transcriptEntry: string,
  transcript: Buffer,
  gitBranchId: string | null
): PortableSession {
  const name = session.name || session.repo.name || "imported";
  const cwd = session.gitWorkspace?.entryPath ?? session.cwd ?? session.repo.root;
  return {
    codexSessionId: session.codexSessionId!,
    sessionName: name,
    sourceCwd: cwd,
    repoName: session.repo.name,
    workspaceMode: session.gitWorkspace ? "git" : "directory",
    targetBranch: session.gitWorkspace?.targetBranch ?? null,
    inputMode: session.inputMode,
    models: session.models,
    fastMode: session.fastMode ?? null,
    pinned: session.pinned,
    forkedFrom: session.forkedFrom
      ? { ...session.forkedFrom, sessionId: null }
      : null,
    lastActivityAt: session.lastActivityAt,
    transcriptEntry,
    transcriptBytes: transcript.length,
    transcriptSha256: sha256(transcript),
    gitBranchId,
    provider: { kind: "codex", threadId: session.codexSessionId, rolloutPath: null },
    name,
    cwd
  };
}

async function buildTar(manifest: Manifest, contents: Map<string, Buffer>): Promise<Buffer> {
  const archive = pack();
  const chunks: Buffer[] = [];
  const complete = new Promise<Buffer>((resolve, reject) => {
    archive.on("data", (chunk: Buffer) => chunks.push(chunk));
    archive.on("end", () => resolve(Buffer.concat(chunks)));
    archive.on("error", reject);
  });
  archive.entry({ name: "manifest.json", mode: 0o600 }, JSON.stringify(manifest));
  for (const [name, entryContents] of contents) archive.entry({ name, mode: 0o600 }, entryContents);
  archive.finalize();
  return complete;
}

async function readTar(buffer: Buffer): Promise<Map<string, Buffer>> {
  const entries = new Map<string, Buffer>();
  const unpack = extract();
  const complete = new Promise<void>((resolve, reject) => {
    unpack.on("entry", (header, stream, next) => {
      if (header.type !== "file" || !safeEntryName(header.name) || entries.has(header.name)) {
        stream.resume();
        next();
        reject(new SessionTransferError("Session archive contains an invalid entry"));
        return;
      }
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        entries.set(header.name, Buffer.concat(chunks));
        next();
      });
      stream.on("error", reject);
    });
    unpack.on("finish", resolve);
    unpack.on("error", reject);
  });
  unpack.end(buffer);
  await complete;
  return entries;
}

function parseManifest(value: Buffer | undefined): Manifest {
  if (!value) throw new SessionTransferError("Session archive is missing manifest.json");
  let raw: unknown;
  try { raw = JSON.parse(value.toString("utf8")); } catch { throw new SessionTransferError("Session archive manifest is invalid JSON"); }
  if (!raw || typeof raw !== "object") throw new SessionTransferError("Session archive manifest is invalid");
  const manifest = raw as Manifest;
  if (manifest.formatVersion !== 6 || !Array.isArray(manifest.sessions)
    || manifest.sessions.length === 0 || manifest.sessions.length > MAX_SESSIONS) {
    throw new SessionTransferError("Unsupported or invalid session archive manifest");
  }
  const ids = new Set<string>();
  for (const [sessionIndex, session] of manifest.sessions.entries()) {
    if (!session || typeof session !== "object" || Array.isArray(session)
      || Object.keys(session).some((key) => !PORTABLE_SESSION_KEYS.has(key as keyof PortableSession))
      || typeof session.codexSessionId !== "string" || !/^[a-zA-Z0-9-]{8,80}$/.test(session.codexSessionId)
      || typeof session.sessionName !== "string" || session.sessionName.length > 200
      || typeof session.sourceCwd !== "string" || session.sourceCwd.length === 0 || session.sourceCwd.length > 4096
      || typeof session.repoName !== "string" || session.repoName.length > 512
      || session.transcriptEntry !== `sessions/${String(sessionIndex + 1).padStart(4, "0")}.jsonl`
      || !Number.isSafeInteger(session.transcriptBytes) || session.transcriptBytes <= 0 || session.transcriptBytes > 1024 * 1024 * 1024
      || typeof session.transcriptSha256 !== "string" || !/^[a-f0-9]{64}$/.test(session.transcriptSha256)
      || !validPortablePreferences(session)
      || !["directory", "git"].includes(session.workspaceMode) || ids.has(session.codexSessionId)) {
      throw new SessionTransferError("Session archive manifest contains invalid session metadata");
    }
    if ((session.workspaceMode === "git" && typeof session.gitBranchId !== "string")
        || (session.workspaceMode === "directory" && session.gitBranchId !== null)) {
      throw new SessionTransferError("Session archive manifest contains invalid Git branch metadata");
    }
    if (session.provider?.kind !== "codex"
        || session.provider.threadId !== session.codexSessionId
        || session.provider.rolloutPath !== null
        || typeof session.name !== "string" || session.name !== session.sessionName
        || typeof session.cwd !== "string" || session.cwd !== session.sourceCwd) {
      throw new SessionTransferError("Session archive manifest contains invalid provider metadata");
    }
    validateDocumentManifest(session, sessionIndex);
    ids.add(session.codexSessionId);
  }
  validateGitBranchManifest(manifest);
  return manifest;
}

function validateTranscripts(manifest: Manifest, contents: Map<string, Buffer>): void {
  const gitEntries = manifest.gitBranches.filter((branch) => branch.bundleEntry !== null).length;
  const documentEntries = manifest.sessions.reduce((total, session) => total + (session.documents?.length ?? 0), 0);
  if (contents.size !== manifest.sessions.length + gitEntries + documentEntries + 1) {
    throw new SessionTransferError("Session archive contains unexpected entries");
  }
  for (const session of manifest.sessions) {
    const transcript = contents.get(session.transcriptEntry);
    if (!transcript || transcript.length !== session.transcriptBytes || sha256(transcript) !== session.transcriptSha256) {
      throw new SessionTransferError(`Transcript validation failed for '${session.sessionName}'`);
    }
    const firstLine = transcript.subarray(0, Math.min(transcript.length, 256 * 1024)).toString("utf8").split("\n").find((line) => line.includes('"session_meta"'));
    if (!firstLine) throw new SessionTransferError(`Transcript for '${session.sessionName}' has no Codex session metadata`);
    try {
      const parsed = JSON.parse(firstLine) as { payload?: { id?: string; session_id?: string } };
      if ((parsed.payload?.id ?? parsed.payload?.session_id) !== session.codexSessionId) throw new Error();
    } catch { throw new SessionTransferError(`Transcript identity does not match '${session.sessionName}'`); }
  }
  for (const session of manifest.sessions) sessionDocuments(session, contents);
  for (const branch of manifest.gitBranches) {
    if (!branch.bundleEntry) continue;
    const bundle = contents.get(branch.bundleEntry);
    if (!bundle || bundle.length !== branch.bundleBytes || sha256(bundle) !== branch.bundleSha256) {
      throw new SessionTransferError(`Git bundle validation failed for '${branch.branchName}'`);
    }
  }
}

function validateDocumentManifest(session: PortableSession, sessionIndex: number): void {
  if (!Array.isArray(session.documents) || session.documents.length > MAX_SESSION_DOCUMENTS) {
    throw new SessionTransferError("Session archive manifest contains invalid documents");
  }
  const names = new Set<string>();
  const entries = new Set<string>();
  let totalBytes = 0;
  for (const [documentIndex, document] of session.documents.entries()) {
    const expectedEntry = `documents/${String(sessionIndex + 1).padStart(4, "0")}/${String(documentIndex + 1).padStart(4, "0")}.md`;
    const nameKey = typeof document?.name === "string" ? document.name.toLowerCase() : "";
    if (!document || typeof document !== "object"
      || typeof document.name !== "string" || !isSessionDocumentName(document.name) || names.has(nameKey)
      || document.entry !== expectedEntry || entries.has(document.entry)
      || !Number.isSafeInteger(document.bytes) || document.bytes < 0 || document.bytes > MAX_SESSION_DOCUMENT_BYTES
      || typeof document.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(document.sha256)) {
      throw new SessionTransferError("Session archive manifest contains invalid document metadata");
    }
    names.add(nameKey);
    entries.add(document.entry);
    totalBytes += document.bytes;
    if (totalBytes > MAX_SESSION_DOCUMENT_TOTAL_BYTES) {
      throw new SessionTransferError("Session archive documents exceed the 10 MiB total limit");
    }
  }
}

function sessionDocuments(session: PortableSession, contents: Map<string, Buffer>): SessionDocumentSnapshot[] {
  const snapshots = (session.documents ?? []).map((document) => {
    const content = contents.get(document.entry);
    if (!content || content.length !== document.bytes || sha256(content) !== document.sha256) {
      throw new SessionTransferError(`Document validation failed for '${session.sessionName}'`);
    }
    return { name: document.name, contents: content, updatedAt: new Date(0).toISOString() };
  });
  try {
    validateSessionDocumentSnapshots(snapshots);
  } catch {
    throw new SessionTransferError(`Document validation failed for '${session.sessionName}'`);
  }
  return snapshots;
}

function validateGitBranchManifest(manifest: Manifest): void {
  if (!Array.isArray(manifest.gitBranches) || manifest.gitBranches.length > MAX_SESSIONS) {
    throw new SessionTransferError("Session archive manifest contains invalid Git branches");
  }
  const ids = new Set<string>();
  for (const [index, branch] of manifest.gitBranches.entries()) {
    if (!branch || typeof branch !== "object") {
      throw new SessionTransferError("Session archive manifest contains invalid Git branch metadata");
    }
    const expectedEntry = `git/${String(index + 1).padStart(4, "0")}.bundle`;
    const shaPattern = branch.objectFormat === "sha256" ? /^[a-f0-9]{64}$/ : /^[a-f0-9]{40}$/;
    if (typeof branch.id !== "string" || !/^branch-\d{4}$/.test(branch.id) || ids.has(branch.id)
      || typeof branch.sourceCwd !== "string" || branch.sourceCwd.length === 0 || branch.sourceCwd.length > 4096
      || typeof branch.branchName !== "string" || branch.branchName.length === 0 || branch.branchName.length > 1024
      || !["sha1", "sha256"].includes(branch.objectFormat) || !shaPattern.test(branch.tipSha)
      || !["upstream_delta", "full", "none"].includes(branch.bundleMode)
      || (branch.upstreamRemote !== null && (typeof branch.upstreamRemote !== "string" || branch.upstreamRemote.length > 1024))
      || (branch.upstreamMergeRef !== null && (typeof branch.upstreamMergeRef !== "string" || branch.upstreamMergeRef.length > 1024))
      || (branch.upstreamBaseSha !== null && !shaPattern.test(branch.upstreamBaseSha))
      || ((branch.bundleMode === "upstream_delta" || branch.bundleMode === "none") !== Boolean(branch.upstreamBaseSha))
      || (branch.bundleEntry !== null && branch.bundleEntry !== expectedEntry)
      || (branch.bundleEntry !== null && branch.bundleMode === "none")
      || !Number.isSafeInteger(branch.bundleBytes) || branch.bundleBytes < 0 || branch.bundleBytes > MAX_ARCHIVE_BYTES
      || (branch.bundleEntry === null
        ? branch.bundleBytes !== 0 || branch.bundleSha256 !== null || branch.bundleMode !== "none"
        : branch.bundleBytes === 0 || !/^[a-f0-9]{64}$/.test(branch.bundleSha256 ?? ""))) {
      throw new SessionTransferError("Session archive manifest contains invalid Git branch metadata");
    }
    ids.add(branch.id);
  }
  const branchesById = new Map(manifest.gitBranches.map((branch) => [branch.id, branch]));
  const referencedBranchIds = new Set<string>();
  for (const session of manifest.sessions) {
    const branch = session.gitBranchId ? branchesById.get(session.gitBranchId) : null;
    if (session.workspaceMode === "git"
      && (!branch || branch.sourceCwd !== session.sourceCwd || branch.branchName !== session.targetBranch)) {
      throw new SessionTransferError("Session archive references an invalid Git branch");
    }
    if (session.gitBranchId) referencedBranchIds.add(session.gitBranchId);
  }
  if (referencedBranchIds.size !== manifest.gitBranches.length) {
    throw new SessionTransferError("Session archive contains an unreferenced Git branch");
  }
}

async function encodeEnvelope(payload: Buffer, key?: string): Promise<Buffer> {
  if (!key) return Buffer.concat([MAGIC, Buffer.from([0]), payload]);
  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const derived = await deriveKey(key, salt);
  const cipher = createCipheriv("aes-256-gcm", derived, nonce);
  cipher.setAAD(Buffer.concat([MAGIC, Buffer.from([FLAG_ENCRYPTED]), salt, nonce]));
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  return Buffer.concat([MAGIC, Buffer.from([FLAG_ENCRYPTED]), salt, nonce, encrypted, cipher.getAuthTag()]);
}

async function decodeEnvelope(file: Buffer, key?: string): Promise<{ encrypted: boolean; payload: Buffer }> {
  if (file.length < MAGIC.length + 1 || !file.subarray(0, MAGIC.length).equals(MAGIC)) throw new SessionTransferError("Not a supported .mpsession file");
  const flags = file[MAGIC.length]!;
  if (flags === 0) return { encrypted: false, payload: file.subarray(MAGIC.length + 1) };
  if (flags !== FLAG_ENCRYPTED) throw new SessionTransferError("Unsupported .mpsession encryption flags");
  if (!key) throw new SessionTransferError("This .mpsession file is encrypted; configure MUXPILOT_SESSION_FILE_KEY", 422);
  const minimum = MAGIC.length + 1 + SALT_BYTES + NONCE_BYTES + TAG_BYTES;
  if (file.length < minimum) throw new SessionTransferError("Encrypted .mpsession file is truncated");
  const saltStart = MAGIC.length + 1;
  const nonceStart = saltStart + SALT_BYTES;
  const bodyStart = nonceStart + NONCE_BYTES;
  const tagStart = file.length - TAG_BYTES;
  try {
    const derived = await deriveKey(key, file.subarray(saltStart, nonceStart));
    const decipher = createDecipheriv("aes-256-gcm", derived, file.subarray(nonceStart, bodyStart));
    decipher.setAAD(file.subarray(0, bodyStart));
    decipher.setAuthTag(file.subarray(tagStart));
    return { encrypted: true, payload: Buffer.concat([decipher.update(file.subarray(bodyStart, tagStart)), decipher.final()]) };
  } catch { throw new SessionTransferError("Unable to decrypt .mpsession file; the key is incorrect or the file was modified", 422); }
}

async function deriveKey(key: string, salt: Buffer): Promise<Buffer> {
  return scryptSync(key, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

async function gunzipArchive(payload: Buffer): Promise<Buffer> {
  try { return await gunzipAsync(payload, { maxOutputLength: 1024 * 1024 * 1024 }); } catch { throw new SessionTransferError("Session archive payload is corrupt or exceeds the expanded size limit"); }
}

function sha256(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function safeEntryName(name: string): boolean {
  return name === "manifest.json"
    || /^sessions\/\d{4}\.jsonl$/.test(name)
    || /^git\/\d{4}\.bundle$/.test(name)
    || /^documents\/\d{4}\/\d{4}\.md$/.test(name);
}

export function sessionTransferFilename(sessionNames: string[], encrypted: boolean, createdAt: string): string {
  if (encrypted) return `muxpilot-encrypted-${compactUtcTimestamp(createdAt)}.mpsession`;
  if (sessionNames.length !== 1) return `muxpilot-${sessionNames.length}-sessions.mpsession`;
  return `${safeFilenameStem(sessionNames[0] ?? "") || "muxpilot-session"}.mpsession`;
}

function compactUtcTimestamp(value: string): string {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) return "unknown-time";
  return timestamp.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function safeFilenameStem(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 80)
    .replace(/[._-]+$/g, "");
}

function completeJsonlPrefix(transcript: Buffer): Buffer {
  if (transcript.length === 0) throw new SessionTransferError("Codex transcript is empty", 409);
  if (transcript[transcript.length - 1] === 0x0a) return transcript;
  const newline = transcript.lastIndexOf(0x0a);
  if (newline < 0) throw new SessionTransferError("Codex transcript has no complete records", 409);
  return transcript.subarray(0, newline + 1);
}

function validPortablePreferences(session: PortableSession): boolean {
  if (session.inputMode !== "default" && session.inputMode !== "plan") return false;
  if (typeof session.pinned !== "boolean") return false;
  if (session.targetBranch !== null && typeof session.targetBranch !== "string") return false;
  if (session.lastActivityAt !== null && typeof session.lastActivityAt !== "string") return false;
  if (session.forkedFrom !== undefined && session.forkedFrom !== null
    && (typeof session.forkedFrom.codexSessionId !== "string"
      || !/^[a-zA-Z0-9-]{8,80}$/.test(session.forkedFrom.codexSessionId)
      || session.forkedFrom.sessionId !== null
      || typeof session.forkedFrom.sessionName !== "string"
      || session.forkedFrom.sessionName.length > 200)) return false;
  return validModelSettings(session.models?.default) && validModelSettings(session.models?.plan);
}

function validModelSettings(value: SessionModelSelections["default"] | undefined): boolean {
  return Boolean(value)
    && (value!.model === null || typeof value!.model === "string")
    && (value!.reasoningEffort === null || typeof value!.reasoningEffort === "string");
}

function uniqueMappings(manifest: Manifest) {
  const mappings = new Map<string, SessionTransferMappingRequirement>();
  for (const session of manifest.sessions) {
    const existing = mappings.get(session.sourceCwd);
    if (existing) {
      if (session.workspaceMode === "git" && existing.workspaceMode !== "git") {
        mappings.set(session.sourceCwd, {
          ...existing,
          workspaceMode: "git",
          targetBranch: session.targetBranch
        });
      }
      continue;
    }
    mappings.set(session.sourceCwd, {
      sourceCwd: session.sourceCwd,
      repoName: session.repoName,
      workspaceMode: session.workspaceMode,
      targetBranch: session.targetBranch,
      branches: manifest.gitBranches
        .filter((branch) => branch.sourceCwd === session.sourceCwd)
        .map(({ branchName, tipSha, objectFormat, bundleMode, upstreamRemote, upstreamMergeRef, upstreamBaseSha }) => ({
          branchName,
          tipSha,
          objectFormat,
          bundleMode,
          upstreamRemote,
          upstreamMergeRef,
          upstreamBaseSha
        }))
    });
  }
  return [...mappings.values()];
}
