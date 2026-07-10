import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { GitWorkspaceCoordinator, GitWorkspaceError, type GitWorkspaceCoordinates, type ProvisionedGitWorkspace } from "./index.js";

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

  it("registers target metadata without creating a branch or worktree", async () => {
    const root = await repository();
    await git(root, ["branch", "target"]);
    await writeFile(join(root, "tracked.txt"), "dirty\n");
    const coordinator = new GitWorkspaceCoordinator();

    const workspace = await provision(coordinator, root, "session_123456", "target");

    expect(await git(root, ["status", "--porcelain"])).toContain("tracked.txt");
    expect(await git(root, ["worktree", "list", "--porcelain"])).not.toContain(workspace.implementationRoot);
    await expect(git(root, ["rev-parse", "muxpilot/change-task-session/g1"])).rejects.toBeTruthy();
  });

  it("materializes, integrates, and removes a short-lived implementation worktree", async () => {
    const root = await repository();
    await git(root, ["branch", "target"]);
    const coordinator = new GitWorkspaceCoordinator();
    const registered = await provision(coordinator, root, "session_abcdef", "target");
    const materialized = await coordinator.materialize(coordinates(registered), registered.implementationRoot, "change-task", 1);
    const workspace = coordinates(registered, materialized.sessionBranch, materialized.worktreePath);
    await writeFile(join(materialized.worktreePath, "feature.txt"), "feature\n");
    await git(materialized.worktreePath, ["add", "feature.txt"]);
    await git(materialized.worktreePath, ["commit", "-m", "feature"]);

    const prepared = await coordinator.prepareIntegration(workspace);
    const result = await coordinator.integrate(workspace, prepared.targetSha, prepared.sessionHeadSha);
    await coordinator.cleanupIntegrated(workspace, []);

    expect(await git(root, ["rev-parse", registered.targetRef])).toBe(result.targetSha);
    expect(await git(root, ["worktree", "list", "--porcelain"])).not.toContain(materialized.worktreePath);
    await expect(git(root, ["rev-parse", materialized.sessionBranch])).rejects.toBeTruthy();
  });

  it.each([["clean", false], ["dirty", true]] as const)("integrates while the target is checked out in the %s entry checkout without mutating it", async (_label, dirty) => {
    const root = await repository();
    await git(root, ["branch", "-M", "main"]);
    if (dirty) await writeFile(join(root, "tracked.txt"), "developer changes\n");
    const originalHead = await git(root, ["rev-parse", "HEAD"]);
    const originalStatus = await git(root, ["status", "--porcelain"]);
    const originalContent = await readFile(join(root, "tracked.txt"), "utf8");
    const coordinator = new GitWorkspaceCoordinator();
    const registered = await provision(coordinator, root, "session_checked", "main");
    const materialized = await coordinator.materialize(coordinates(registered), registered.implementationRoot, "checked", 1);
    const workspace = coordinates(registered, materialized.sessionBranch, materialized.worktreePath);
    await writeFile(join(materialized.worktreePath, "feature.txt"), "feature\n");
    await git(materialized.worktreePath, ["add", "feature.txt"]);
    await git(materialized.worktreePath, ["commit", "-m", "feature"]);

    const prepared = await coordinator.prepareIntegration(workspace);
    await coordinator.integrate(workspace, prepared.targetSha, prepared.sessionHeadSha);

    expect(await git(root, ["rev-parse", "HEAD"])).toBe(originalHead);
    expect(await git(root, ["status", "--porcelain"])).toBe(originalStatus);
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe(originalContent);
  });

  it("suspends dirty work into a recovery ref and restores it", async () => {
    const root = await repository();
    await git(root, ["branch", "target"]);
    const coordinator = new GitWorkspaceCoordinator();
    const registered = await provision(coordinator, root, "session_recover", "target");
    const materialized = await coordinator.materialize(coordinates(registered), registered.implementationRoot, "recover", 1);
    const workspace = coordinates(registered, materialized.sessionBranch, materialized.worktreePath);
    await writeFile(join(materialized.worktreePath, "tracked.txt"), "changed\n");
    await writeFile(join(materialized.worktreePath, "new.txt"), "new\n");

    const suspended = await coordinator.suspend(workspace, "refs/muxpilot/recovery/session_recover/g1");
    await coordinator.removeSuspendedWorktree(workspace);
    const restored = await coordinator.materialize(
      { ...workspace, worktreePath: null },
      registered.implementationRoot,
      "recover",
      1,
      suspended.recoveryRef
    );

    expect(await readFile(join(restored.worktreePath, "tracked.txt"), "utf8")).toBe("changed\n");
    expect(await readFile(join(restored.worktreePath, "new.txt"), "utf8")).toBe("new\n");
    await expect(git(root, ["rev-parse", "refs/muxpilot/recovery/session_recover/g1"])).rejects.toBeTruthy();
  });

  it("creates a managed target from a remote branch without creating a local branch", async () => {
    const root = await repository();
    const remote = await mkdtemp(join(tmpdir(), "muxpilot-git-remote-"));
    await git(remote, ["init", "--bare", "-q"]);
    await git(root, ["remote", "add", "origin", remote]);
    await git(root, ["branch", "remote-target"]);
    await git(root, ["push", "-q", "origin", "remote-target"]);
    await git(root, ["branch", "-D", "remote-target"]);

    const coordinator = new GitWorkspaceCoordinator();
    const workspace = await provision(coordinator, root, "session_remote", "remote-target", { targetRemote: "origin" });
    const advertised = (await git(root, ["ls-remote", "--heads", "origin", "refs/heads/remote-target"])).split(/\s+/)[0];

    await expect(git(root, ["rev-parse", "refs/heads/remote-target"])).rejects.toBeTruthy();
    expect(await git(root, ["rev-parse", workspace.targetRef])).toBe(advertised);
  });

  it("rejects a stale candidate and lets it rebase onto the shared target", async () => {
    const root = await repository();
    await git(root, ["branch", "target"]);
    const coordinator = new GitWorkspaceCoordinator();
    const firstRegistered = await provision(coordinator, root, "session_first", "target");
    const secondRegistered = await provision(coordinator, root, "session_second", "target");
    const firstTree = await coordinator.materialize(coordinates(firstRegistered), firstRegistered.implementationRoot, "first", 1);
    const secondTree = await coordinator.materialize(coordinates(secondRegistered), secondRegistered.implementationRoot, "second", 1);
    const first = coordinates(firstRegistered, firstTree.sessionBranch, firstTree.worktreePath);
    const second = coordinates(secondRegistered, secondTree.sessionBranch, secondTree.worktreePath);
    await writeFile(join(firstTree.worktreePath, "first.txt"), "first\n");
    await git(firstTree.worktreePath, ["add", "first.txt"]);
    await git(firstTree.worktreePath, ["commit", "-qm", "first"]);
    await writeFile(join(secondTree.worktreePath, "second.txt"), "second\n");
    await git(secondTree.worktreePath, ["add", "second.txt"]);
    await git(secondTree.worktreePath, ["commit", "-qm", "second"]);
    const firstPrepared = await coordinator.prepareIntegration(first);
    const secondPrepared = await coordinator.prepareIntegration(second);
    await coordinator.integrate(first, firstPrepared.targetSha, firstPrepared.sessionHeadSha);

    await expect(coordinator.integrate(second, secondPrepared.targetSha, secondPrepared.sessionHeadSha))
      .rejects.toMatchObject({ code: "stale_candidate" } satisfies Partial<GitWorkspaceError>);
    const rebased = await coordinator.prepareIntegration(second);
    const integrated = await coordinator.integrate({ ...second, targetSha: rebased.targetSha }, rebased.targetSha, rebased.sessionHeadSha);
    expect(await git(root, ["rev-parse", second.targetRef])).toBe(integrated.targetSha);
  });

  it("reconciles divergent managed and local target commits and synchronizes a clean checkout", async () => {
    const root = await repository();
    await git(root, ["branch", "-M", "main"]);
    const coordinator = new GitWorkspaceCoordinator();
    const registered = await provision(coordinator, root, "session_reconcile", "main");
    const materialized = await coordinator.materialize(coordinates(registered), registered.implementationRoot, "managed", 1);
    const managed = coordinates(registered, materialized.sessionBranch, materialized.worktreePath);
    await writeFile(join(materialized.worktreePath, "managed.txt"), "managed\n");
    await git(materialized.worktreePath, ["add", "managed.txt"]);
    await git(materialized.worktreePath, ["commit", "-qm", "managed change"]);
    const prepared = await coordinator.prepareIntegration(managed);
    await coordinator.integrate(managed, prepared.targetSha, prepared.sessionHeadSha);

    await writeFile(join(root, "local.txt"), "local\n");
    await git(root, ["add", "local.txt"]);
    await git(root, ["commit", "-qm", "local change"]);
    const localHead = await git(root, ["rev-parse", "HEAD"]);
    const managedHead = await git(root, ["rev-parse", registered.targetRef]);
    const integrationRoot = join(root, "..", `${basename(root)}-integrations`);

    const reconciled = await coordinator.reconcileTarget(coordinates(registered), integrationRoot, true);
    expect(reconciled.managedSha).not.toBe(localHead);
    expect(await git(root, ["merge-base", "--is-ancestor", localHead, reconciled.managedSha]).then(() => true)).toBe(true);
    expect(await git(root, ["merge-base", "--is-ancestor", managedHead, reconciled.managedSha]).then(() => true)).toBe(true);
    expect(await coordinator.syncLocalTarget({ ...coordinates(registered), targetSha: reconciled.managedSha })).toBe("updated");
    expect(await git(root, ["rev-parse", "main"])).toBe(reconciled.managedSha);
    expect(await readFile(join(root, "managed.txt"), "utf8")).toBe("managed\n");
    expect(await readFile(join(root, "local.txt"), "utf8")).toBe("local\n");
  });

  it("preserves a target reconciliation worktree for agent conflict resolution", async () => {
    const root = await repository();
    await git(root, ["branch", "-M", "main"]);
    const coordinator = new GitWorkspaceCoordinator();
    const registered = await provision(coordinator, root, "session_conflict", "main");
    const materialized = await coordinator.materialize(coordinates(registered), registered.implementationRoot, "managed-conflict", 1);
    const managed = coordinates(registered, materialized.sessionBranch, materialized.worktreePath);
    await writeFile(join(materialized.worktreePath, "tracked.txt"), "managed\n");
    await git(materialized.worktreePath, ["add", "tracked.txt"]);
    await git(materialized.worktreePath, ["commit", "-qm", "managed change"]);
    const prepared = await coordinator.prepareIntegration(managed);
    await coordinator.integrate(managed, prepared.targetSha, prepared.sessionHeadSha);
    const managedHead = await git(root, ["rev-parse", registered.targetRef]);

    await writeFile(join(root, "tracked.txt"), "local\n");
    await git(root, ["add", "tracked.txt"]);
    await git(root, ["commit", "-qm", "local change"]);
    const localHead = await git(root, ["rev-parse", "main"]);
    const integrationRoot = join(root, "..", `${basename(root)}-conflict-integrations`);
    let conflictPath = "";
    try {
      await coordinator.reconcileTarget(coordinates(registered), integrationRoot, true);
      throw new Error("Expected reconciliation conflict");
    } catch (error) {
      expect(error).toMatchObject({ code: "target_reconciliation_conflict" });
      conflictPath = (error as GitWorkspaceError).causeText!.split("\n")[0]!;
    }
    expect(await readFile(join(conflictPath, "tracked.txt"), "utf8")).toContain("<<<<<<<");
    await writeFile(join(conflictPath, "tracked.txt"), "managed and local\n");
    await git(conflictPath, ["add", "tracked.txt"]);
    await git(conflictPath, ["commit", "-qm", "resolve target reconciliation"]);

    const reconciled = await coordinator.reconcileTarget(coordinates(registered), integrationRoot, true);
    expect(await git(root, ["merge-base", "--is-ancestor", managedHead, reconciled.managedSha]).then(() => true)).toBe(true);
    expect(await git(root, ["merge-base", "--is-ancestor", localHead, reconciled.managedSha]).then(() => true)).toBe(true);
    await expect(lstat(conflictPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reuses and detaches manifest-aware dependency installations", async () => {
    const root = await repository();
    await writeFile(join(root, "package.json"), "{}\n");
    await git(root, ["add", "package.json"]);
    await git(root, ["commit", "-qm", "add package"]);
    await git(root, ["branch", "target"]);
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "node_modules", "marker"), "shared\n");
    const coordinator = new GitWorkspaceCoordinator();
    const registered = await provision(coordinator, root, "session_dependencies", "target");
    const materialized = await coordinator.materialize(coordinates(registered), registered.implementationRoot, "dependencies", 1);

    const links = await coordinator.linkDependencies(root, materialized.worktreePath);
    expect(links).toMatchObject([{ kind: "node", relativePath: "node_modules", linked: true }]);
    expect((await lstat(join(materialized.worktreePath, "node_modules"))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(materialized.worktreePath, "node_modules"))).toBe(join(root, "node_modules"));
    expect(await coordinator.detachDependencyLinks(materialized.worktreePath, ["node_modules"])).toEqual(["node_modules"]);
    await expect(lstat(join(materialized.worktreePath, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(root, "node_modules", "marker"), "utf8")).toBe("shared\n");
  });

  it("requires an explicit cached override and reports fetch freshness", async () => {
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
    expect(await coordinator.resolveRevision(root, revision, true)).toMatchObject({ commitSha: fresh.commitSha, freshness: "cached" });
  });
});

async function provision(
  coordinator: GitWorkspaceCoordinator,
  root: string,
  workspaceId: string,
  targetBranch: string,
  extras: { targetRemote?: string } = {}
): Promise<ProvisionedGitWorkspace> {
  return coordinator.provision({
    workspaceId,
    sessionName: "change-task",
    entryPath: root,
    worktreeRoot: join(root, "..", `${basename(root)}-worktrees`),
    sessionRoot: join(root, "..", `${basename(root)}-sessions`),
    targetBranch,
    ...extras
  });
}

function coordinates(
  workspace: ProvisionedGitWorkspace,
  sessionBranch: string | null = null,
  worktreePath: string | null = null
): GitWorkspaceCoordinates {
  return {
    workspaceId: workspace.workspaceId,
    repoRoot: workspace.repoRoot,
    commonGitDir: workspace.commonGitDir,
    targetBranch: workspace.targetBranch,
    targetRemote: workspace.targetRemote,
    targetRef: workspace.targetRef,
    sourceSha: workspace.sourceSha,
    targetSha: workspace.targetSha,
    sessionBranch,
    worktreePath
  };
}

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
