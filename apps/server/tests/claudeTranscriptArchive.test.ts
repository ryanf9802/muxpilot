import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeTranscriptArchive } from "../src/providers/claude/transcriptArchive.js";

const THREAD = "11111111-1111-4111-8111-111111111111";
const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "muxpilot-claude-archive-"));
  roots.push(root);
  const project = join(root, "claude", "projects", "-repo");
  mkdirSync(join(project, THREAD, "subagents"), { recursive: true });
  const nativePath = join(project, `${THREAD}.jsonl`);
  writeFileSync(nativePath, "{\"uuid\":\"a\"}\n");
  writeFileSync(join(project, THREAD, "subagents", "agent-1.jsonl"), "{\"uuid\":\"s\"}\n");
  return { archive: new ClaudeTranscriptArchive(join(root, "archive")), nativePath, project, archiveRoot: join(root, "archive") };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ClaudeTranscriptArchive", () => {
  it("restores a swept transcript and its subagent files to the native path", async () => {
    const { archive, nativePath, project } = fixture();
    await archive.mirror(THREAD, nativePath);
    rmSync(nativePath);
    rmSync(join(project, THREAD), { recursive: true });

    await expect(archive.ensureRestored(THREAD)).resolves.toBe(true);
    expect(readFileSync(nativePath, "utf8")).toBe("{\"uuid\":\"a\"}\n");
    expect(readFileSync(join(project, THREAD, "subagents", "agent-1.jsonl"), "utf8")).toBe("{\"uuid\":\"s\"}\n");
  });

  it("never shrinks either copy", async () => {
    const { archive, nativePath, archiveRoot } = fixture();
    writeFileSync(nativePath, "{\"uuid\":\"a\"}\n{\"uuid\":\"b\"}\n");
    await archive.mirror(THREAD, nativePath);
    // A truncated native copy is not mirrored over the longer archive, and restore extends it back.
    writeFileSync(nativePath, "{\"uuid\":\"a\"}\n");
    await archive.mirror(THREAD, nativePath);
    expect(readFileSync(join(archiveRoot, THREAD, "transcript.jsonl"), "utf8")).toContain("\"b\"");
    await archive.ensureRestored(THREAD, nativePath);
    expect(readFileSync(nativePath, "utf8")).toContain("\"b\"");
    // A longer native copy (new turns) is never replaced by the archive.
    writeFileSync(nativePath, "{\"uuid\":\"a\"}\n{\"uuid\":\"b\"}\n{\"uuid\":\"c\"}\n");
    await archive.ensureRestored(THREAD, nativePath);
    expect(readFileSync(nativePath, "utf8")).toContain("\"c\"");
  });

  it("reports unknown sessions as unavailable and removes archives", async () => {
    const { archive, nativePath, archiveRoot } = fixture();
    await expect(archive.ensureRestored("22222222-2222-4222-8222-222222222222")).resolves.toBe(false);
    await archive.mirror(THREAD, nativePath);
    expect(await archive.readTranscript(THREAD)).not.toBeNull();
    await archive.remove(THREAD);
    expect(existsSync(join(archiveRoot, THREAD))).toBe(false);
    await expect(archive.mirror("../escape", nativePath)).resolves.toBeUndefined();
    expect(existsSync(join(archiveRoot, "..", "escape"))).toBe(false);
  });
});
