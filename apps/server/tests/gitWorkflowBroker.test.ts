import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppDatabase } from "../src/db/database.js";
import { GitWorkflowBroker } from "../src/services/gitWorkflowBroker.js";
import { GitWorkspaceManager } from "../src/services/gitWorkspaceManager.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const scripts = resolve(import.meta.dirname, "../../../skills/muxpilot-git-workflow/scripts");

afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("GitWorkflowBroker", () => {
  it("authenticates and performs the final fast-forward plus cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-git-broker-"));
    roots.push(root);
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.name", "Muxpilot Test"]);
    await git(root, ["config", "user.email", "muxpilot@example.test"]);
    await writeFile(join(root, "base.txt"), "base\n");
    await writeFile(join(root, ".gitignore"), "muxpilot.db*\nruntime/\nsessions/\nworktrees/\n");
    await git(root, ["add", "base.txt", ".gitignore"]);
    await git(root, ["commit", "-m", "base"]);
    const db = new AppDatabase(join(root, "muxpilot.db"));
    const socket = join(root, "runtime", "broker.sock");
    const broker = new GitWorkflowBroker(db, socket, { info: vi.fn(), warn: vi.fn() });
    await broker.start();
    const manager = new GitWorkspaceManager(db, {
      worktreeRoot: join(root, "worktrees"), sessionRoot: join(root, "sessions"),
      publishCapability: (workspace) => broker.publishCapability(workspace)
    });
    const workspace = await manager.provision({ sessionName: "broker", entryPath: root, targetBranch: "main" });
    const environment = {
      ...process.env,
      MUXPILOT_GIT_WORKSPACE_ID: workspace.id,
      MUXPILOT_GIT_REPO_ROOT: root,
      MUXPILOT_GIT_TARGET_BRANCH: "main",
      MUXPILOT_GIT_WORKTREE_ROOT: workspace.implementationRoot!,
      MUXPILOT_GIT_STATUS_FILE: join(workspace.controlPath!, "git-workflow-status.json"),
      MUXPILOT_GIT_DEPENDENCIES: "[]"
    };
    const begin = await node("muxpilot-git-begin.mjs", environment);
    const worktree = begin.match(/WORKTREE_READY (\S+)/)![1]!;
    await writeFile(join(worktree, "broker.txt"), "integrated\n");
    await git(worktree, ["add", "broker.txt"]);
    await git(worktree, ["commit", "-m", "broker task"]);
    const capabilityPath = join(workspace.controlPath!, "git-workflow-broker.json");
    const capability = JSON.parse(await readFile(capabilityPath, "utf8"));
    await writeFile(capabilityPath, JSON.stringify({ ...capability, token: "invalid" }));
    await expect(node("muxpilot-git-finish.mjs", environment)).rejects.toThrow("unauthorized broker request");
    await broker.publishCapability(workspace);
    expect(await node("muxpilot-git-finish.mjs", environment)).toContain("broker=authenticated");
    expect(await readFile(join(root, "broker.txt"), "utf8")).toBe("integrated\n");
    await broker.close();
    await db.close();
  });
});

async function node(script: string, env: NodeJS.ProcessEnv): Promise<string> {
  return (await execFileAsync(process.execPath, [join(scripts, script)], { env })).stdout.trim();
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout.trim();
}
