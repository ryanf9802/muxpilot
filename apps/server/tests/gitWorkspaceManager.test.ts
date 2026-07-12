import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

  it("reuses writable dependencies and skips non-writable dependencies", async () => {
    const root = await repository();
    await mkdir(join(root, ".venv"));
    await mkdir(join(root, "locked", ".venv"), { recursive: true });
    await writeFile(join(root, "pyproject.toml"), "[project]\nname = 'root'\nversion = '1.0.0'\n");
    await writeFile(join(root, "locked", "pyproject.toml"), "[project]\nname = 'locked'\nversion = '1.0.0'\n");
    await git(root, ["add", "pyproject.toml", "locked/pyproject.toml"]);
    await git(root, ["commit", "-m", "add Python projects"]);
    await chmod(join(root, "locked", ".venv"), 0o555);
    const db = new AppDatabase(join(root, "muxpilot.db"));
    const manager = new GitWorkspaceManager(db, { worktreeRoot: join(root, "worktrees"), sessionRoot: join(root, "sessions") });

    const workspace = await manager.provision({ sessionName: "task", entryPath: root, targetBranch: "main" });

    expect(workspace.summary.dependencyLinks).toEqual([
      { kind: "python", relativePath: ".venv", sourcePath: join(root, ".venv"), linked: true }
    ]);
    db.close();
  });

  it("converts legacy errors to observed local worktree state", async () => {
    const root = await repository();
    const db = new AppDatabase(join(root, "muxpilot.db"));
    const manager = new GitWorkspaceManager(db, { worktreeRoot: join(root, "worktrees"), sessionRoot: join(root, "sessions") });
    const workspace = await manager.provision({ sessionName: "task", entryPath: root, targetBranch: "main" });
    const worktree = join(root, "legacy-worktree");
    await git(root, ["worktree", "add", "-b", "legacy-task", worktree, "main"]);
    const legacy = {
      ...workspace,
      summary: {
        ...workspace.summary,
        workflowVersion: undefined,
        state: "error",
        sessionBranch: "legacy-task",
        worktreePath: worktree,
        lastError: "Obsolete finalization error"
      }
    } as typeof workspace;

    const refreshed = await manager.refresh(legacy);
    expect(refreshed.summary).toMatchObject({ workflowVersion: 1, state: "worktree", sessionBranch: "legacy-task", lastError: null });
    db.close();
  });

  it("treats malformed status as neutral and reports a deleted current target", async () => {
    const root = await repository();
    await git(root, ["branch", "feature"]);
    const db = new AppDatabase(join(root, "muxpilot.db"));
    const manager = new GitWorkspaceManager(db, { worktreeRoot: join(root, "worktrees"), sessionRoot: join(root, "sessions") });
    const workspace = await manager.provision({ sessionName: "task", entryPath: root, targetBranch: "feature" });
    await mkdir(workspace.controlPath!, { recursive: true });
    await writeFile(join(workspace.controlPath!, "git-workflow-status.json"), "not json");
    expect((await manager.refresh(workspace)).summary).toMatchObject({ state: "idle", lastError: null });

    await git(root, ["branch", "-D", "feature"]);
    expect((await manager.refresh(workspace)).summary).toMatchObject({ state: "failed", lastError: "Local target branch 'feature' no longer exists" });
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
