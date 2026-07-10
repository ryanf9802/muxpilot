import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { AppDatabase } from "../src/db/database.js";
import { GitWorkspaceManager } from "../src/services/gitWorkspaceManager.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("lightweight Git workspace metadata", () => {
  it("lists only existing local branches and provisions no worktree", async () => {
    const root = await repository();
    await git(root, ["branch", "feature"]);
    const db = new AppDatabase(join(root, "muxpilot.db"));
    const manager = new GitWorkspaceManager(db, { worktreeRoot: join(root, "worktrees"), sessionRoot: join(root, "sessions") });

    const probe = await manager.probe(root);
    expect(probe.localBranches).toEqual(["feature", "main"]);
    const workspace = await manager.provision({ sessionName: "task", entryPath: root, targetBranch: "feature" });
    expect(workspace.summary).toMatchObject({ state: "idle", targetBranch: "feature", worktreePath: null });
    expect(await git(root, ["worktree", "list", "--porcelain"])).not.toContain(join(root, "worktrees"));
    db.close();
  });

  it("rejects remote-only or invented target branches", async () => {
    const root = await repository();
    const db = new AppDatabase(join(root, "muxpilot.db"));
    const manager = new GitWorkspaceManager(db, { worktreeRoot: join(root, "worktrees"), sessionRoot: join(root, "sessions") });
    await expect(manager.provision({ sessionName: "task", entryPath: root, targetBranch: "missing" }))
      .rejects.toThrow("Local target branch 'missing' does not exist");
    db.close();
  });
});

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "muxpilot-lightweight-git-"));
  roots.push(root);
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.name", "Muxpilot Test"]);
  await git(root, ["config", "user.email", "muxpilot@example.test"]);
  await writeFile(join(root, "tracked.txt"), "initial\n");
  await git(root, ["add", "tracked.txt"]);
  await git(root, ["commit", "-m", "initial"]);
  return root;
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout.trim();
}
