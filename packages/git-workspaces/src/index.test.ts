import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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

    expect(workspace.sessionBranch).toBe("muxpilot/session_123456/g1");
    expect(await git(root, ["status", "--porcelain"])).toContain("tracked.txt");
    expect(await git(workspace.worktreePath, ["status", "--porcelain"])).toBe("");
  });

  it("rebases a session and atomically fast-forwards its managed target", async () => {
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
      prepared.targetSha,
      prepared.sessionHeadSha
    );

    expect(await git(root, ["rev-parse", "target"])).not.toBe(result.targetSha);
    expect(await git(root, ["rev-parse", workspace.targetRef])).toBe(result.targetSha);
    const rotated = await coordinator.rotate(workspace, [], 2);
    expect(rotated.sessionBranch).toBe("muxpilot/session_abcdef/g2");
    expect(await git(workspace.worktreePath, ["rev-parse", "HEAD"])).toBe(result.targetSha);
    await expect(git(root, ["rev-parse", "muxpilot/session_abcdef/g1"])).rejects.toBeTruthy();
  });

  it.each([["clean", false], ["dirty", true]] as const)("integrates while the target is checked out in the %s entry checkout without mutating it", async (_label, dirty) => {
    const root = await repository();
    await git(root, ["branch", "-M", "main"]);
    if (dirty) await writeFile(join(root, "tracked.txt"), "developer changes\n");
    const originalHead = await git(root, ["rev-parse", "HEAD"]);
    const originalTarget = await git(root, ["rev-parse", "refs/heads/main"]);
    const originalStatus = await git(root, ["status", "--porcelain"]);
    const originalContent = await readFile(join(root, "tracked.txt"), "utf8");
    const coordinator = new GitWorkspaceCoordinator();
    const workspace = await coordinator.provision({
      workspaceId: "session_checked",
      entryPath: root,
      worktreeRoot: join(root, "..", "worktrees"),
      targetBranch: "main"
    });
    await writeFile(join(workspace.worktreePath, "feature.txt"), "feature\n");
    await git(workspace.worktreePath, ["add", "feature.txt"]);
    await git(workspace.worktreePath, ["commit", "-m", "feature"]);
    const prepared = await coordinator.prepareIntegration(workspace);

    const integrated = await coordinator.integrate(workspace, prepared.targetSha, prepared.sessionHeadSha);

    expect(await git(root, ["rev-parse", "HEAD"])).toBe(originalHead);
    expect(await git(root, ["rev-parse", "refs/heads/main"])).toBe(originalTarget);
    expect(await git(root, ["status", "--porcelain"])).toBe(originalStatus);
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe(originalContent);
    expect(await git(root, ["rev-parse", workspace.targetRef])).toBe(integrated.targetSha);
  });

  it("creates a managed target from the current remote branch without creating a local branch", async () => {
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
    await expect(git(root, ["rev-parse", "refs/heads/remote-target"])).rejects.toBeTruthy();
    expect(await git(root, ["rev-parse", workspace.targetRef])).toBe(advertised);
    expect(workspace.targetRemote).toBe("origin");
  });

  it("prefers the fresh remote target over a stale local branch", async () => {
    const root = await repository();
    const remote = await mkdtemp(join(tmpdir(), "muxpilot-git-fresh-target-"));
    await git(remote, ["init", "--bare", "-q"]);
    await git(root, ["remote", "add", "origin", remote]);
    const stale = await git(root, ["rev-parse", "HEAD"]);
    await git(root, ["branch", "main", stale]);
    await writeFile(join(root, "remote.txt"), "remote\n");
    await git(root, ["add", "remote.txt"]);
    await git(root, ["commit", "-qm", "remote target"]);
    await git(root, ["push", "-q", "origin", "HEAD:refs/heads/main"]);

    const coordinator = new GitWorkspaceCoordinator();
    const workspace = await coordinator.provision({
      workspaceId: "session_fresh",
      entryPath: root,
      worktreeRoot: join(root, "..", `${basename(root)}-worktrees`),
      targetBranch: "main",
      targetRemote: "origin"
    });
    const remoteHead = (await git(root, ["ls-remote", "--heads", "origin", "refs/heads/main"])).split(/\s+/)[0];

    expect(workspace.targetSha).toBe(remoteHead);
    expect(await git(root, ["rev-parse", "refs/heads/main"])).toBe(stale);
  });

  it("rejects a non-fast-forward push of the managed target", async () => {
    const root = await repository();
    const remote = await mkdtemp(join(tmpdir(), "muxpilot-git-push-target-"));
    await git(remote, ["init", "--bare", "-q"]);
    await git(root, ["remote", "add", "origin", remote]);
    await git(root, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
    const coordinator = new GitWorkspaceCoordinator();
    const workspace = await coordinator.provision({
      workspaceId: "session_push",
      entryPath: root,
      worktreeRoot: join(root, "..", `${basename(root)}-worktrees`),
      targetBranch: "main",
      targetRemote: "origin"
    });
    await writeFile(join(workspace.worktreePath, "feature.txt"), "feature\n");
    await git(workspace.worktreePath, ["add", "feature.txt"]);
    await git(workspace.worktreePath, ["commit", "-qm", "feature"]);
    const prepared = await coordinator.prepareIntegration(workspace);
    await coordinator.integrate(workspace, prepared.targetSha, prepared.sessionHeadSha);
    await writeFile(join(root, "remote-only.txt"), "remote\n");
    await git(root, ["add", "remote-only.txt"]);
    await git(root, ["commit", "-qm", "remote advanced"]);
    await git(root, ["push", "-q", "origin", "HEAD:refs/heads/main"]);

    await expect(coordinator.push(workspace)).rejects.toMatchObject({ code: "non_fast_forward" } satisfies Partial<GitWorkspaceError>);
  });

  it("pushes a managed target to a missing remote branch without creating a local branch", async () => {
    const root = await repository();
    const remote = await mkdtemp(join(tmpdir(), "muxpilot-git-push-new-target-"));
    await git(remote, ["init", "--bare", "-q"]);
    await git(root, ["remote", "add", "origin", remote]);
    const coordinator = new GitWorkspaceCoordinator();
    const workspace = await coordinator.provision({
      workspaceId: "session_publish",
      entryPath: root,
      worktreeRoot: join(root, "..", `${basename(root)}-worktrees`),
      targetBranch: "new-target",
      targetRemote: "origin",
      targetSource: { kind: "local_branch", branch: await git(root, ["branch", "--show-current"]) }
    });
    await writeFile(join(workspace.worktreePath, "feature.txt"), "feature\n");
    await git(workspace.worktreePath, ["add", "feature.txt"]);
    await git(workspace.worktreePath, ["commit", "-qm", "feature"]);
    const prepared = await coordinator.prepareIntegration(workspace);
    const integrated = await coordinator.integrate(workspace, prepared.targetSha, prepared.sessionHeadSha);

    await coordinator.push(workspace);
    const advertised = (await git(root, ["ls-remote", "--heads", "origin", "refs/heads/new-target"])).split(/\s+/)[0];
    expect(advertised).toBe(integrated.targetSha);
    await expect(git(root, ["rev-parse", "refs/heads/new-target"])).rejects.toBeTruthy();
  });

  it("rejects a stale concurrent candidate and lets it rebase onto the shared managed target", async () => {
    const root = await repository();
    await git(root, ["branch", "target"]);
    const coordinator = new GitWorkspaceCoordinator();
    const first = await coordinator.provision({
      workspaceId: "session_first",
      entryPath: root,
      worktreeRoot: join(root, "..", `${basename(root)}-worktrees`),
      targetBranch: "target"
    });
    const second = await coordinator.provision({
      workspaceId: "session_second",
      entryPath: root,
      worktreeRoot: join(root, "..", `${basename(root)}-worktrees`),
      targetBranch: "target"
    });
    await writeFile(join(first.worktreePath, "first.txt"), "first\n");
    await git(first.worktreePath, ["add", "first.txt"]);
    await git(first.worktreePath, ["commit", "-qm", "first"]);
    await writeFile(join(second.worktreePath, "second.txt"), "second\n");
    await git(second.worktreePath, ["add", "second.txt"]);
    await git(second.worktreePath, ["commit", "-qm", "second"]);
    const firstPrepared = await coordinator.prepareIntegration(first);
    const secondPrepared = await coordinator.prepareIntegration(second);
    await coordinator.integrate(first, firstPrepared.targetSha, firstPrepared.sessionHeadSha);

    await expect(coordinator.integrate(second, secondPrepared.targetSha, secondPrepared.sessionHeadSha))
      .rejects.toMatchObject({ code: "stale_candidate" } satisfies Partial<GitWorkspaceError>);
    const rebased = await coordinator.prepareIntegration(second);
    const integrated = await coordinator.integrate({ ...second, targetSha: rebased.targetSha }, rebased.targetSha, rebased.sessionHeadSha);
    expect(await git(root, ["rev-parse", second.targetRef])).toBe(integrated.targetSha);
  });

  it("reports a managed-only target as existing", async () => {
    const root = await repository();
    const coordinator = new GitWorkspaceCoordinator();
    await coordinator.provision({
      workspaceId: "session_new_target",
      entryPath: root,
      worktreeRoot: join(root, "..", `${basename(root)}-worktrees`),
      targetBranch: "new-target",
      targetSource: { kind: "local_branch", branch: await git(root, ["branch", "--show-current"]) }
    });

    expect(await coordinator.targetBranchExists(root, "new-target")).toBe(true);
    await expect(git(root, ["rev-parse", "refs/heads/new-target"])).rejects.toBeTruthy();
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

  it("checks the current remote and silently falls back to remote-tracking refs", async () => {
    const root = await repository();
    const remote = await mkdtemp(join(tmpdir(), "muxpilot-git-status-remote-"));
    await git(remote, ["init", "--bare", "-q"]);
    await git(root, ["remote", "add", "origin", remote]);
    await git(root, ["push", "-q", "origin", "HEAD:refs/heads/current-target"]);
    const coordinator = new GitWorkspaceCoordinator();
    expect(await coordinator.targetBranchExists(root, "current-target")).toBe(true);
    await git(root, ["update-ref", "refs/remotes/origin/cached-target", "HEAD"]);
    await git(root, ["remote", "set-url", "origin", join(remote, "missing")]);
    expect(await coordinator.targetBranchExists(root, "cached-target")).toBe(true);
    expect(await coordinator.targetBranchExists(root, "new-target")).toBe(false);
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
