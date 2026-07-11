import { execFile } from "node:child_process";
import { lstat, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const scripts = resolve(import.meta.dirname, "../../../skills/muxpilot-git-workflow/scripts");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("standalone local Git workflow helpers", () => {
  it("creates a linked isolated worktree, integrates locally, and cleans it up", async () => {
    const root = await repository();
    const dependencies = join(root, "node_modules");
    await mkdir(dependencies);
    const inheritedExcludeFile = join(root, "session", "inherited-excludes");
    await mkdir(join(root, "session"));
    await writeFile(inheritedExcludeFile, "scratch.txt\n");
    await git(root, ["config", "core.excludesFile", inheritedExcludeFile]);
    const environment = helperEnvironment(root, [{ kind: "node", relativePath: "node_modules", sourcePath: dependencies, linked: true }]);

    const begin = await node("muxpilot-git-begin.mjs", environment);
    const worktree = begin.match(/WORKTREE_READY (\S+)/)?.[1];
    expect(worktree).toBeTruthy();
    expect((await lstat(join(worktree!, "node_modules"))).isSymbolicLink()).toBe(true);
    await writeFile(join(worktree!, "scratch.txt"), "ignored\n");
    expect(await git(worktree!, ["status", "--porcelain"])).toBe("");
    expect(await git(root, ["config", "--get", "core.excludesFile"])).toBe(inheritedExcludeFile);
    await writeFile(join(worktree!, "tracked.txt"), "completed\n");
    await git(worktree!, ["add", "tracked.txt"]);
    await git(worktree!, ["commit", "-m", "complete task"]);

    const finish = await node("muxpilot-git-finish.mjs", environment);
    expect(finish).toContain("INTEGRATED target=refs/heads/main");
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("completed\n");
    await expect(stat(worktree!)).rejects.toThrow();
    expect(JSON.parse(await readFile(environment.MUXPILOT_GIT_STATUS_FILE, "utf8"))).toMatchObject({ state: "idle", worktreePath: null });
  });

  it("blocks integration when the checked-out target is dirty", async () => {
    const root = await repository();
    const environment = helperEnvironment(root, []);
    const begin = await node("muxpilot-git-begin.mjs", environment);
    const worktree = begin.match(/WORKTREE_READY (\S+)/)![1]!;
    await writeFile(join(worktree, "tracked.txt"), "task\n");
    await git(worktree, ["add", "tracked.txt"]);
    await git(worktree, ["commit", "-m", "task"]);
    await writeFile(join(root, "local.txt"), "dirty\n");

    await expect(node("muxpilot-git-finish.mjs", environment)).rejects.toThrow("DIRTY_TARGET");
    expect(JSON.parse(await readFile(environment.MUXPILOT_GIT_STATUS_FILE, "utf8"))).toMatchObject({ state: "blocked" });
    expect(await git(root, ["rev-parse", "main"])).not.toBe(await git(worktree, ["rev-parse", "HEAD"]));
  });

  it("cleans up after integration while an unrelated branch is checked out", async () => {
    const root = await repository();
    await git(root, ["switch", "-c", "unrelated"]);
    const environment = helperEnvironment(root, []);
    const begin = await node("muxpilot-git-begin.mjs", environment);
    const worktree = begin.match(/WORKTREE_READY (\S+)/)![1]!;
    const sessionBranch = begin.match(/branch=(\S+)/)![1]!;
    await writeFile(join(worktree, "task.txt"), "integrated\n");
    await git(worktree, ["add", "task.txt"]);
    await git(worktree, ["commit", "-m", "task on main"]);
    const taskHead = await git(worktree, ["rev-parse", "HEAD"]);

    const finish = await node("muxpilot-git-finish.mjs", environment);

    expect(finish).toContain("INTEGRATED target=refs/heads/main");
    expect(await git(root, ["branch", "--show-current"])).toBe("unrelated");
    expect(await git(root, ["rev-parse", "main"])).toBe(taskHead);
    expect(await git(root, ["show", "main:task.txt"])).toBe("integrated");
    await expect(git(root, ["show-ref", "--verify", `refs/heads/${sessionBranch}`])).rejects.toThrow();
    await expect(stat(worktree)).rejects.toThrow();
    expect(JSON.parse(await readFile(environment.MUXPILOT_GIT_STATUS_FILE, "utf8"))).toMatchObject({
      state: "idle",
      sessionBranch: null,
      worktreePath: null
    });
  });

  it("rebases and requires renewed review when another task lands first", async () => {
    const root = await repository();
    const first = helperEnvironment(root, []);
    const second = { ...helperEnvironment(root, []), MUXPILOT_GIT_WORKSPACE_ID: "second-session", MUXPILOT_GIT_WORKTREE_ROOT: join(root, "second-worktrees"), MUXPILOT_GIT_STATUS_FILE: join(root, "second-session", "git-workflow-status.json") };
    const firstWorktree = (await node("muxpilot-git-begin.mjs", first)).match(/WORKTREE_READY (\S+)/)![1]!;
    const secondWorktree = (await node("muxpilot-git-begin.mjs", second)).match(/WORKTREE_READY (\S+)/)![1]!;
    await writeFile(join(firstWorktree, "first.txt"), "first\n");
    await git(firstWorktree, ["add", "first.txt"]);
    await git(firstWorktree, ["commit", "-m", "first task"]);
    await writeFile(join(secondWorktree, "second.txt"), "second\n");
    await git(secondWorktree, ["add", "second.txt"]);
    await git(secondWorktree, ["commit", "-m", "second task"]);

    await node("muxpilot-git-finish.mjs", first);
    await expect(node("muxpilot-git-finish.mjs", second)).rejects.toThrow("REBASED_REVIEW_REQUIRED");
    await node("muxpilot-git-finish.mjs", second);
    expect(await readFile(join(root, "first.txt"), "utf8")).toBe("first\n");
    expect(await readFile(join(root, "second.txt"), "utf8")).toBe("second\n");
  });
});

function helperEnvironment(root: string, dependencies: unknown[]): NodeJS.ProcessEnv & Record<string, string> {
  return {
    ...process.env,
    MUXPILOT_GIT_WORKSPACE_ID: "test-session",
    MUXPILOT_GIT_REPO_ROOT: root,
    MUXPILOT_GIT_TARGET_BRANCH: "main",
    MUXPILOT_GIT_WORKTREE_ROOT: join(root, "task-worktrees"),
    MUXPILOT_GIT_STATUS_FILE: join(root, "session", "git-workflow-status.json"),
    MUXPILOT_GIT_DEPENDENCIES: JSON.stringify(dependencies)
  } as NodeJS.ProcessEnv & Record<string, string>;
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "muxpilot-helper-"));
  roots.push(root);
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.name", "Muxpilot Test"]);
  await git(root, ["config", "user.email", "muxpilot@example.test"]);
  await writeFile(join(root, "tracked.txt"), "initial\n");
  await writeFile(join(root, ".gitignore"), "*session/\n*worktrees/\n");
  await git(root, ["add", "tracked.txt", ".gitignore"]);
  await git(root, ["commit", "-m", "initial"]);
  return root;
}

async function node(script: string, env: NodeJS.ProcessEnv): Promise<string> {
  try {
    return (await execFileAsync(process.execPath, [join(scripts, script)], { env })).stdout.trim();
  } catch (error) {
    const value = error as Error & { stderr?: string };
    const stdout = (error as Error & { stdout?: string }).stdout?.trim();
    throw new Error(value.stderr?.trim() || stdout || value.message);
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout.trim();
}
