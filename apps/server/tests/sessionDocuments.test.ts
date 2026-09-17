import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isSessionDocumentCapacityError,
  MAX_SESSION_DOCUMENT_BYTES,
  SessionDocumentError,
  SessionDocumentService,
  validateSessionDocumentSnapshots
} from "../src/services/sessionDocuments.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SessionDocumentService", () => {
  it("lists INDEX first, reads Markdown, and copies an independent snapshot", async () => {
    const service = await fixture();
    const root = await service.ensureScope("documents-source");
    await writeFile(join(root, "documents", "notes.md"), "# Notes\n");
    await writeFile(join(root, "documents", "INDEX.md"), "# Index\n");

    expect((await service.list("documents-source")).documents.map((document) => document.name)).toEqual(["INDEX.md", "notes.md"]);
    expect((await service.read("documents-source", "notes.md")).document.content).toBe("# Notes\n");

    await service.copy("documents-source", "documents-copy");
    await writeFile(join(root, "documents", "notes.md"), "changed");
    expect((await service.read("documents-copy", "notes.md")).document.content).toBe("# Notes\n");
  });

  it("rejects unsafe names, symlinks, invalid UTF-8, and oversized files", async () => {
    const service = await fixture();
    const root = await service.ensureScope("documents-safety");
    await expect(service.read("documents-safety", "../escape.md")).rejects.toBeInstanceOf(SessionDocumentError);
    await symlink("/etc/hosts", join(root, "documents", "linked.md"));
    await expect(service.read("documents-safety", "linked.md")).rejects.toMatchObject({ statusCode: 409 });
    await rm(join(root, "documents", "linked.md"));
    await writeFile(join(root, "documents", "invalid.md"), Buffer.from([0xff]));
    await expect(service.list("documents-safety")).rejects.toMatchObject({ statusCode: 422 });
    await rm(join(root, "documents", "invalid.md"));
    await writeFile(join(root, "documents", "not-markdown.txt"), "nope");
    await expect(service.list("documents-safety")).rejects.toMatchObject({ statusCode: 400 });
    await rm(join(root, "documents", "not-markdown.txt"));
    await writeFile(join(root, "documents", "large.md"), Buffer.alloc(256 * 1024 + 1));
    await expect(service.list("documents-safety")).rejects.toMatchObject({ statusCode: 413 });
  });

  it("classifies file, count, and total capacity errors for read-only fallback", () => {
    const oversized = captureError(() => validateSessionDocumentSnapshots([
      { name: "large.md", contents: Buffer.alloc(MAX_SESSION_DOCUMENT_BYTES + 1), updatedAt: "2026-01-01T00:00:00.000Z" }
    ]));
    const tooMany = captureError(() => validateSessionDocumentSnapshots(Array.from({ length: 101 }, (_, index) => ({
      name: `note-${index}.md`,
      contents: Buffer.alloc(0),
      updatedAt: "2026-01-01T00:00:00.000Z"
    }))));
    const excessiveTotal = captureError(() => validateSessionDocumentSnapshots(Array.from({ length: 41 }, (_, index) => ({
      name: `chunk-${index}.md`,
      contents: Buffer.alloc(MAX_SESSION_DOCUMENT_BYTES),
      updatedAt: "2026-01-01T00:00:00.000Z"
    }))));

    expect(oversized.message).toContain("256 KiB");
    expect(tooMany.message).toContain("more than 100");
    expect(excessiveTotal.message).toContain("10 MiB total");
    expect([oversized, tooMany, excessiveTotal].every(isSessionDocumentCapacityError)).toBe(true);
    expect(isSessionDocumentCapacityError(new SessionDocumentError("Invalid document name", 400))).toBe(false);
  });

  it("ignores empty sandbox metadata directories but rejects content inside them", async () => {
    const service = await fixture();
    const root = await service.ensureScope("documents-sandbox-metadata");
    const documents = join(root, "documents");
    await writeFile(join(documents, "notes.md"), "# Notes\n");
    for (const name of [".agents", ".codex", ".git"]) await mkdir(join(documents, name));

    expect((await service.list("documents-sandbox-metadata")).documents.map((document) => document.name)).toEqual(["notes.md"]);

    await writeFile(join(documents, ".codex", "unexpected"), "content");
    await expect(service.list("documents-sandbox-metadata")).rejects.toMatchObject({ statusCode: 400 });
  });

  it("atomically persists separate approved plans and indexes them idempotently", async () => {
    const service = await fixture();
    const root = await service.ensureScope("documents-approved-plan");
    await writeFile(join(root, "documents", "notes.md"), "# Notes\n");

    expect(await service.persistApprovedPlan("documents-approved-plan", 7, "# Approved\n\n- Ship")).toEqual({
      created: ["plan-7.md", "INDEX.md"],
      updated: []
    });
    expect(await service.persistApprovedPlan("documents-approved-plan", 7, "# Approved\n\n- Ship")).toEqual({
      created: [],
      updated: []
    });
    expect(await service.persistApprovedPlan("documents-approved-plan", 12, "# Next plan")).toEqual({
      created: ["plan-12.md"],
      updated: ["INDEX.md"]
    });

    expect((await service.read("documents-approved-plan", "plan-7.md")).document.content).toBe("# Approved\n\n- Ship\n");
    expect((await service.read("documents-approved-plan", "notes.md")).document.content).toBe("# Notes\n");
    expect((await service.read("documents-approved-plan", "INDEX.md")).document.content).toBe(
      "# Session documents\n\n- [plan-7.md](plan-7.md) — Approved plan from message 7.\n\n- [plan-12.md](plan-12.md) — Approved plan from message 12.\n"
    );
  });

  it("does not overwrite a conflicting approved-plan document", async () => {
    const service = await fixture();
    const root = await service.ensureScope("documents-approved-plan-conflict");
    await writeFile(join(root, "documents", "plan-7.md"), "# Different\n");

    await expect(service.persistApprovedPlan("documents-approved-plan-conflict", 7, "# Approved"))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it("applies created and updated BTW documents without replacing concurrent untouched files", async () => {
    const service = await fixture();
    const root = await service.ensureScope("documents-btw");
    await writeFile(join(root, "documents", "plan.md"), "# Original\n");
    const staging = await service.prepareBtwStaging("documents-btw", "exchange-1");
    await writeFile(join(staging, "plan.md"), "# Updated\n");
    await writeFile(join(staging, "notes.md"), "# Notes\n");
    for (const name of [".agents", ".codex", ".git"]) await mkdir(join(staging, name));
    await writeFile(join(root, "documents", "main-agent.md"), "# Concurrent untouched file\n");

    expect(await service.inspectBtwStaging("documents-btw", "exchange-1")).toEqual({
      created: ["notes.md"],
      updated: ["plan.md"]
    });
    expect(await service.applyBtwStaging("documents-btw", "exchange-1")).toEqual({
      status: "applied",
      changes: { created: ["notes.md"], updated: ["plan.md"] }
    });
    expect((await service.read("documents-btw", "plan.md")).document.content).toBe("# Updated\n");
    expect((await service.read("documents-btw", "main-agent.md")).document.content).toBe("# Concurrent untouched file\n");
  });

  it("detects conflicts and rejects BTW deletes or renames", async () => {
    const service = await fixture();
    const root = await service.ensureScope("documents-conflict");
    await writeFile(join(root, "documents", "plan.md"), "# Original\n");
    const staging = await service.prepareBtwStaging("documents-conflict", "exchange-2");
    await writeFile(join(staging, "plan.md"), "# BTW update\n");
    await writeFile(join(root, "documents", "plan.md"), "# Main update\n");

    expect(await service.applyBtwStaging("documents-conflict", "exchange-2")).toEqual({
      status: "conflict",
      names: ["plan.md"]
    });
    await rm(join(staging, "plan.md"));
    await expect(service.inspectBtwStaging("documents-conflict", "exchange-2")).rejects.toMatchObject({ statusCode: 409 });
  });
});

async function fixture(): Promise<SessionDocumentService> {
  const root = await mkdtemp(join(tmpdir(), "muxpilot-documents-"));
  roots.push(root);
  return new SessionDocumentService(root);
}

function captureError(action: () => void): SessionDocumentError {
  try {
    action();
  } catch (error) {
    if (error instanceof SessionDocumentError) return error;
    throw error;
  }
  throw new Error("Expected a SessionDocumentError");
}
