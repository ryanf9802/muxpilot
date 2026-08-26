import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionDocumentError, SessionDocumentService } from "../src/services/sessionDocuments.js";

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
});

async function fixture(): Promise<SessionDocumentService> {
  const root = await mkdtemp(join(tmpdir(), "muxpilot-documents-"));
  roots.push(root);
  return new SessionDocumentService(root);
}
