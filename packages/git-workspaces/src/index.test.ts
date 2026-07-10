import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { GitWorkspaceCoordinator, GitWorkspaceError } from "./index.js";

const execFileAsync = promisify(execFile);

describe("GitWorkspaceCoordinator", () => {
  it("reports local branches, remote branches, and tags for autocomplete", async () => {
    const root = await repository();
    await git(root, ["branch", "feature/local"]);
    await git(root, ["remote", "add", "origin", root]);
    await git(root, ["update-ref", "refs/remotes/origin/stage", "HEAD"]);
    await git(root, ["tag", "v1.0.0"]);

    const probe = await new GitWorkspaceCoordinator().probe(root);

    expect(probe.localBranches).toContain("feature/local");
    expect(probe.remoteBranches).toContainEqual({ remote: "origin", branch: "stage" });
    expect(probe.tags).toContain("v1.0.0");
  });

  it("provisions a private branch without changing a dirty entry checkout", async () => {
    const root = await repository();
    await git(root, ["branch", "target"]);
    await writeFile(join(root, "tracked.txt"), "dirty\n");
    const coordinator = new GitWorkspaceCoordinator();
    const workspace = await coordinator.provision({
      workspaceId: "session_123456",
      entryPath: root,
      worktreeRoot: join(root, "..", "worktrees"),
      targetBranch: "target"
    });

    expect(workspace.sessionBranch).toBe("muxpilot/session_123456");
    expect(await git(root, ["status", "--porcelain"])).toContain("tracked.txt");
    expect(await git(workspace.worktreePath, ["status", "--porcelain"])).toBe("");
  });

  it("rebases a session and fast-forwards through a temporary target worktree", async () => {
    const root = await repository();
    await git(root, ["branch", "target"]);
    const coordinator = new GitWorkspaceCoordinator();
    const workspace = await coordinator.provision({
      workspaceId: "session_abcdef",
      entryPath: root,
      worktreeRoot: join(root, "..", "worktrees"),
      targetBranch: "target"
    });
    await writeFile(join(workspace.worktreePath, "feature.txt"), "feature\n");
    await git(workspace.worktreePath, ["add", "feature.txt"]);
    await git(workspace.worktreePath, ["commit", "-m", "feature"]);
    const prepared = await coordinator.prepareIntegration(workspace);
    const result = await coordinator.integrate(
      workspace,
      join(root, "..", "integrations"),
      prepared.targetSha,
      prepared.sessionHeadSha
    );

    expect(await git(root, ["rev-parse", "target"])).toBe(result.targetSha);
    expect(result.cleanupPending).toBe(false);
  });

  it("defers when the target is checked out in another worktree", async () => {
    const root = await repository();
    await git(root, ["branch", "target"]);
    const targetPath = join(root, "..", `${basename(root)}-target-checkout`);
    await git(root, ["worktree", "add", targetPath, "target"]);
    const coordinator = new GitWorkspaceCoordinator();
    const workspace = await coordinator.provision({
      workspaceId: "session_checked",
      entryPath: root,
      worktreeRoot: join(root, "..", "worktrees"),
      targetBranch: "target"
    });
    await writeFile(join(workspace.worktreePath, "feature.txt"), "feature\n");
    await git(workspace.worktreePath, ["add", "feature.txt"]);
    await git(workspace.worktreePath, ["commit", "-m", "feature"]);
    const prepared = await coordinator.prepareIntegration(workspace);

    await expect(
      coordinator.integrate(workspace, join(root, "..", "integrations"), prepared.targetSha, prepared.sessionHeadSha)
    ).rejects.toMatchObject({ code: "target_checked_out" } satisfies Partial<GitWorkspaceError>);
  });

  it("creates a missing local target from the current remote branch", async () => {
    const root = await repository();
    const remote = await mkdtemp(join(tmpdir(), "muxpilot-git-remote-"));
    await git(remote, ["init", "--bare", "-q"]);
    await git(root, ["remote", "add", "origin", remote]);
    await git(root, ["branch", "remote-target"]);
    await git(root, ["push", "-q", "origin", "remote-target"]);
    await git(root, ["branch", "-D", "remote-target"]);

    const coordinator = new GitWorkspaceCoordinator();
    const workspace = await coordinator.provision({
      workspaceId: "session_remote",
      entryPath: root,
      worktreeRoot: join(root, "..", `${basename(root)}-worktrees`),
      targetBranch: "remote-target",
      targetRemote: "origin"
    });

    const advertised = (await git(root, ["ls-remote", "--heads", "origin", "refs/heads/remote-target"])).split(/\s+/)[0];
    expect(await git(root, ["rev-parse", "remote-target"])).toBe(advertised);
    expect(workspace.targetRemote).toBe("origin");
  });

  it("requires an explicit cached override and reports when the ref was fetched", async () => {
    const root = await repository();
    const remote = await mkdtemp(join(tmpdir(), "muxpilot-git-cache-remote-"));
    await git(remote, ["init", "--bare", "-q"]);
    await git(root, ["remote", "add", "origin", remote]);
    await git(root, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
    const coordinator = new GitWorkspaceCoordinator();
    const revision = { kind: "remote_branch" as const, remote: "origin", branch: "main" };
    const fresh = await coordinator.resolveRevision(root, revision);
    await git(root, ["remote", "set-url", "origin", join(remote, "missing")]);

    await expect(coordinator.resolveRevision(root, revision)).rejects.toBeInstanceOf(GitWorkspaceError);
    const cached = await coordinator.resolveRevision(root, revision, true);
    expect(cached).toMatchObject({ commitSha: fresh.commitSha, freshness: "cached", fetchedAt: fresh.fetchedAt });
  });
});

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "muxpilot-git-workspaces-"));
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.name", "Muxpilot Test"]);
  await git(root, ["config", "user.email", "muxpilot@example.invalid"]);
  await writeFile(join(root, "tracked.txt"), "base\n");
  await git(root, ["add", "tracked.txt"]);
  await git(root, ["commit", "-qm", "base"]);
  return root;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}
