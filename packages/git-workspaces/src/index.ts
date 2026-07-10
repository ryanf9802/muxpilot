import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { isValidGitStyleName, type GitInspection, type GitRepositoryProbe, type GitRevisionSpec } from "@muxpilot/core";

const execFileAsync = promisify(execFile);

export interface GitCommandResult {
  stdout: string;
  stderr: string;
}

export interface GitCommandRunner {
  run(cwd: string, args: string[]): Promise<GitCommandResult>;
}

export interface ProvisionGitWorkspaceRequest {
  workspaceId: string;
  entryPath: string;
  worktreeRoot: string;
  targetBranch: string;
  targetRemote?: string;
  targetSource?: GitRevisionSpec;
  allowCachedRemote?: boolean;
}

export interface ProvisionedGitWorkspace {
  workspaceId: string;
  entryPath: string;
  repoRoot: string;
  commonGitDir: string;
  targetBranch: string;
  targetRemote: string | null;
  targetSource: GitRevisionSpec | null;
  sourceSha: string;
  targetSha: string;
  sessionBranch: string;
  sessionHeadSha: string;
  worktreePath: string;
  usedCachedRemote: boolean;
  sourceFetchedAt: string | null;
  sourceFreshness: GitInspection["freshness"];
  compatibilityWarnings: string[];
}

export interface GitWorkspaceCoordinates {
  workspaceId: string;
  repoRoot: string;
  commonGitDir: string;
  targetBranch: string;
  targetRemote: string | null;
  sourceSha: string;
  targetSha: string;
  sessionBranch: string;
  worktreePath: string;
}

export interface GitWorkspaceStatus {
  targetSha: string;
  sessionHeadSha: string;
  dirty: boolean;
  aheadBy: number;
  targetCheckedOutAt: string | null;
  rebaseInProgress: boolean;
}

export interface GitIntegrationResult {
  targetSha: string;
  cleanupPending: boolean;
}

export interface GitRotationResult {
  sessionBranch: string;
  targetSha: string;
  sessionHeadSha: string;
}

export interface ResolvedRevision {
  requested: GitRevisionSpec;
  resolvedRef: string;
  commitSha: string;
  fetchedAt: string | null;
  freshness: GitInspection["freshness"];
}

export class GitWorkspaceError extends Error {
  constructor(message: string, readonly code: string, readonly causeText: string | null = null) {
    super(message);
  }
}

export class NodeGitCommandRunner implements GitCommandRunner {
  async run(cwd: string, args: string[]): Promise<GitCommandResult> {
    try {
      const { stdout, stderr } = await execFileAsync("git", args, {
        cwd,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
      });
      return { stdout, stderr };
    } catch (error) {
      const value = error as Error & { stdout?: string; stderr?: string };
      throw new GitWorkspaceError(
        value.stderr?.trim() || value.message || "Git command failed",
        "git_command_failed",
        value.stderr?.trim() || null
      );
    }
  }
}

export class GitWorkspaceCoordinator {
  constructor(private readonly runner: GitCommandRunner = new NodeGitCommandRunner()) {}

  async probe(entryPath: string): Promise<GitRepositoryProbe> {
    const entry = await existingPath(entryPath);
    try {
      const bare = (await this.output(entry, ["rev-parse", "--is-bare-repository"])) === "true";
      if (bare) {
        const names = lines(await this.output(entry, ["remote"]));
        const refs = await this.repositoryRefs(entry, names);
        return {
          isGit: true,
          bare: true,
          incompatibleReason: "Bare repositories cannot host interactive muxpilot sessions",
          repoRoot: entry,
          repoName: basename(entry),
          currentBranch: null,
          dirty: false,
          remotes: names,
          defaultRemote: names.includes("origin") ? "origin" : names.length === 1 ? names[0]! : null,
          ...refs
        };
      }
      const repoRoot = await this.output(entry, ["rev-parse", "--show-toplevel"]);
      const [branch, status, remotes] = await Promise.all([
        this.output(repoRoot, ["branch", "--show-current"]),
        this.output(repoRoot, ["status", "--porcelain"]),
        this.output(repoRoot, ["remote"])
      ]);
      const names = lines(remotes);
      const refs = await this.repositoryRefs(repoRoot, names);
      return {
        isGit: true,
        bare: false,
        incompatibleReason: null,
        repoRoot,
        repoName: basename(repoRoot),
        currentBranch: branch || null,
        dirty: Boolean(status),
        remotes: names,
        defaultRemote: names.includes("origin") ? "origin" : names.length === 1 ? names[0]! : null,
        ...refs
      };
    } catch {
      return {
        isGit: false,
        bare: false,
        incompatibleReason: null,
        repoRoot: null,
        repoName: basename(entry),
        currentBranch: null,
        dirty: false,
        remotes: [],
        defaultRemote: null,
        localBranches: [],
        remoteBranches: [],
        tags: []
      };
    }
  }

  private async repositoryRefs(repoRoot: string, remotes: string[]): Promise<Pick<GitRepositoryProbe, "localBranches" | "remoteBranches" | "tags">> {
    const refs = lines(await this.output(repoRoot, [
      "for-each-ref",
      "--format=%(refname)",
      "refs/heads",
      "refs/remotes",
      "refs/tags"
    ]));
    const localBranches: string[] = [];
    const remoteBranches: Array<{ remote: string; branch: string }> = [];
    const tags: string[] = [];
    const longestRemotes = [...remotes].sort((left, right) => right.length - left.length);
    for (const ref of refs) {
      if (ref.startsWith("refs/heads/")) localBranches.push(ref.slice("refs/heads/".length));
      else if (ref.startsWith("refs/tags/")) tags.push(ref.slice("refs/tags/".length));
      else {
        const remote = longestRemotes.find((name) => ref.startsWith(`refs/remotes/${name}/`));
        if (!remote) continue;
        const branch = ref.slice(`refs/remotes/${remote}/`.length);
        if (branch && branch !== "HEAD") remoteBranches.push({ remote, branch });
      }
    }
    return { localBranches, remoteBranches, tags };
  }

  async provision(request: ProvisionGitWorkspaceRequest): Promise<ProvisionedGitWorkspace> {
    validateWorkspaceId(request.workspaceId);
    if (!isValidGitStyleName(request.targetBranch)) throw new GitWorkspaceError("Target branch must be a 2-32 character Git-style name", "invalid_target_branch");
    await this.validateBranch(request.entryPath, request.targetBranch);
    const probe = await this.probe(request.entryPath);
    if (!probe.isGit) throw new GitWorkspaceError("Directory is not in a Git repository", "not_git");
    if (probe.bare) throw new GitWorkspaceError(probe.incompatibleReason ?? "Bare repository is unsupported", "bare_repository");
    const repoRoot = probe.repoRoot!;
    const commonGitDir = await this.absoluteCommonGitDir(repoRoot);
    const targetRemote = request.targetRemote ?? probe.defaultRemote;
    if (request.targetRemote && !probe.remotes.includes(request.targetRemote)) {
      throw new GitWorkspaceError(`Remote '${request.targetRemote}' does not exist`, "missing_remote");
    }

    const targetRef = localBranchRef(request.targetBranch);
    let targetSha = await this.tryResolveCommit(repoRoot, targetRef);
    const targetExistedLocally = Boolean(targetSha);
    let source: ResolvedRevision | null = null;

    if (!targetSha && targetRemote) {
      try {
        source = await this.tryResolveRemoteBranch(repoRoot, targetRemote, request.targetBranch, request.allowCachedRemote === true);
        targetSha = source?.commitSha ?? null;
      } catch (error) {
        if (!request.targetSource || revisionNeedsRemote(request.targetSource)) throw error;
      }
    }

    if (!targetSha) {
      const sourceSpec = request.targetSource ?? (await this.defaultRemoteRevision(repoRoot, targetRemote));
      source = await this.resolveRevision(repoRoot, sourceSpec, request.allowCachedRemote === true);
      targetSha = source.commitSha;
    }

    const existingTarget = await this.tryResolveCommit(repoRoot, targetRef);
    if (!existingTarget) {
      try {
        await this.run(repoRoot, ["update-ref", targetRef, targetSha, zeroOid(targetSha.length)]);
      } catch {
        const raced = await this.tryResolveCommit(repoRoot, targetRef);
        if (!raced) throw new GitWorkspaceError(`Could not create target branch '${request.targetBranch}'`, "target_create_failed");
        targetSha = raced;
      }
    } else {
      targetSha = existingTarget;
    }

    const sessionBranch = `muxpilot/${request.workspaceId}/g1`;
    await this.validateBranch(repoRoot, sessionBranch);
    if (await this.tryResolveCommit(repoRoot, localBranchRef(sessionBranch))) {
      throw new GitWorkspaceError(`Session branch '${sessionBranch}' already exists`, "session_branch_exists");
    }
    const worktreePath = resolve(request.worktreeRoot, repoIdentity(commonGitDir), request.workspaceId);
    const compatibilityWarnings = await this.compatibilityWarnings(repoRoot, targetSha);
    await mkdir(dirname(worktreePath), { recursive: true });
    await this.run(repoRoot, ["worktree", "add", "-b", sessionBranch, worktreePath, targetSha]);
    await this.run(repoRoot, ["worktree", "lock", "--reason", `muxpilot:${request.workspaceId}`, worktreePath]);

    return {
      workspaceId: request.workspaceId,
      entryPath: await realpath(request.entryPath),
      repoRoot,
      commonGitDir,
      targetBranch: request.targetBranch,
      targetRemote: targetRemote ?? null,
      targetSource: targetExistedLocally ? null : request.targetSource ?? source?.requested ?? null,
      sourceSha: source?.commitSha ?? targetSha,
      targetSha,
      sessionBranch,
      sessionHeadSha: targetSha,
      worktreePath,
      usedCachedRemote: source?.freshness === "cached",
      sourceFetchedAt: source?.fetchedAt ?? null,
      sourceFreshness: source?.freshness ?? "local",
      compatibilityWarnings
    };
  }

  async targetBranchExists(entryPath: string, branch: string): Promise<boolean> {
    if (!isValidGitStyleName(branch)) throw new GitWorkspaceError("Invalid target branch name", "invalid_target_branch");
    const probe = await this.probe(entryPath);
    if (!probe.isGit || !probe.repoRoot) throw new GitWorkspaceError("Directory is not in a Git repository", "not_git");
    if (await this.tryResolveCommit(probe.repoRoot, localBranchRef(branch))) return true;
    const remote = probe.defaultRemote;
    if (!remote) return false;
    try {
      return Boolean(await this.output(probe.repoRoot, ["ls-remote", "--heads", remote, `refs/heads/${branch}`]));
    } catch {
      if (await this.tryResolveCommit(probe.repoRoot, remoteHeadCacheRef(remote, branch))) return true;
      return Boolean(await this.tryResolveCommit(probe.repoRoot, `refs/remotes/${remote}/${branch}`));
    }
  }

  async status(workspace: GitWorkspaceCoordinates): Promise<GitWorkspaceStatus> {
    const targetSha = await this.resolveCommit(workspace.repoRoot, localBranchRef(workspace.targetBranch));
    const sessionHeadSha = await this.resolveCommit(workspace.worktreePath, "HEAD");
    const [porcelain, ahead, worktrees, mergePath, applyPath] = await Promise.all([
      this.output(workspace.worktreePath, ["status", "--porcelain"]),
      this.output(workspace.repoRoot, ["rev-list", "--count", `${targetSha}..${sessionHeadSha}`]),
      this.output(workspace.repoRoot, ["worktree", "list", "--porcelain"]),
      this.output(workspace.worktreePath, ["rev-parse", "--git-path", "rebase-merge"]),
      this.output(workspace.worktreePath, ["rev-parse", "--git-path", "rebase-apply"])
    ]);
    return {
      targetSha,
      sessionHeadSha,
      dirty: Boolean(porcelain),
      aheadBy: Number(ahead) || 0,
      targetCheckedOutAt: checkedOutBranchPath(worktrees, localBranchRef(workspace.targetBranch)),
      rebaseInProgress:
        (await pathExists(resolve(workspace.worktreePath, mergePath))) ||
        (await pathExists(resolve(workspace.worktreePath, applyPath)))
    };
  }

  async resolveRevision(repoRoot: string, spec: GitRevisionSpec, allowCachedRemote = false): Promise<ResolvedRevision> {
    if (spec.kind === "local_branch") {
      await this.validateBranch(repoRoot, spec.branch);
      const ref = localBranchRef(spec.branch);
      return { requested: spec, resolvedRef: ref, commitSha: await this.resolveCommit(repoRoot, ref), fetchedAt: null, freshness: "local" };
    }
    if (spec.kind === "local_tag") {
      const ref = `refs/tags/${spec.tag}`;
      return { requested: spec, resolvedRef: ref, commitSha: await this.resolveCommit(repoRoot, ref), fetchedAt: null, freshness: "local" };
    }
    if (spec.kind === "remote_branch") {
      await this.validateBranch(repoRoot, spec.branch);
      const ref = remoteHeadCacheRef(spec.remote, spec.branch);
      return this.fetchRevision(repoRoot, spec, ref, [`+refs/heads/${spec.branch}:${ref}`], allowCachedRemote);
    }
    if (spec.kind === "remote_tag") {
      const ref = remoteTagCacheRef(spec.remote, spec.tag);
      return this.fetchRevision(repoRoot, spec, ref, [`+refs/tags/${spec.tag}:${ref}`], allowCachedRemote);
    }
    const oid = fullOid(spec.oid);
    const local = await this.tryResolveCommit(repoRoot, oid);
    if (local) return { requested: spec, resolvedRef: oid, commitSha: local, fetchedAt: null, freshness: "local" };
    if (!spec.remote) throw new GitWorkspaceError(`Commit '${oid}' is not available locally`, "missing_commit");
    const ref = `refs/muxpilot/remotes/${remoteKey(spec.remote)}/commits/${oid}`;
    return this.fetchRevision(repoRoot, spec, ref, [oid], allowCachedRemote);
  }

  async addInspection(
    workspace: GitWorkspaceCoordinates,
    inspectionId: string,
    spec: GitRevisionSpec,
    allowCachedRemote = false
  ): Promise<ResolvedRevision & { id: string }> {
    validateWorkspaceId(inspectionId);
    return { id: inspectionId, ...(await this.resolveRevision(workspace.repoRoot, spec, allowCachedRemote)) };
  }

  async materializeInspection(
    workspace: GitWorkspaceCoordinates,
    inspectionId: string,
    commitSha: string,
    inspectionRoot: string
  ): Promise<string> {
    validateWorkspaceId(inspectionId);
    const path = resolve(inspectionRoot, repoIdentity(workspace.commonGitDir), workspace.workspaceId, inspectionId);
    await mkdir(dirname(path), { recursive: true });
    await this.run(workspace.repoRoot, ["worktree", "add", "--detach", path, await this.resolveCommit(workspace.repoRoot, commitSha)]);
    await this.run(workspace.repoRoot, ["worktree", "lock", "--reason", `muxpilot-inspection:${workspace.workspaceId}:${inspectionId}`, path]);
    return path;
  }

  async prepareIntegration(workspace: GitWorkspaceCoordinates): Promise<GitWorkspaceStatus> {
    const current = await this.status(workspace);
    if (current.dirty) throw new GitWorkspaceError("Commit or discard all worktree changes before preparing integration", "dirty_worktree");
    if (current.aheadBy === 0) throw new GitWorkspaceError("Session has no commits to integrate", "no_commits");
    if (current.rebaseInProgress) throw new GitWorkspaceError("Resolve or abort the existing rebase first", "rebase_in_progress");
    if (current.targetSha !== workspace.targetSha) {
      try {
        await this.run(workspace.worktreePath, [
          "rebase",
          "--rebase-merges",
          "--onto",
          current.targetSha,
          workspace.targetSha,
          workspace.sessionBranch
        ]);
      } catch (error) {
        throw new GitWorkspaceError("Rebase stopped with conflicts in the session worktree", "integration_conflict", errorText(error));
      }
    }
    return this.status({ ...workspace, targetSha: current.targetSha });
  }

  async integrate(
    workspace: GitWorkspaceCoordinates,
    integrationRoot: string,
    expectedTargetSha: string,
    expectedHeadSha: string
  ): Promise<GitIntegrationResult> {
    const current = await this.status(workspace);
    if (current.dirty || current.rebaseInProgress) throw new GitWorkspaceError("Session worktree is not ready to integrate", "not_ready");
    if (current.targetSha !== expectedTargetSha || current.sessionHeadSha !== expectedHeadSha) {
      throw new GitWorkspaceError("Target or session head changed; prepare and review again", "stale_candidate");
    }
    if (current.targetCheckedOutAt) {
      throw new GitWorkspaceError(`Target branch is checked out at ${current.targetCheckedOutAt}`, "target_checked_out");
    }
    const path = resolve(integrationRoot, repoIdentity(workspace.commonGitDir), branchKey(workspace.targetBranch));
    await mkdir(dirname(path), { recursive: true });
    await this.run(workspace.repoRoot, ["worktree", "add", path, workspace.targetBranch]);
    let targetSha: string;
    try {
      const checked = await this.resolveCommit(path, "HEAD");
      if (checked !== expectedTargetSha) throw new GitWorkspaceError("Target changed while acquiring its integration worktree", "stale_candidate");
      await this.run(path, ["merge", "--ff-only", expectedHeadSha]);
      targetSha = await this.resolveCommit(path, "HEAD");
    } catch (error) {
      await this.run(workspace.repoRoot, ["worktree", "remove", path]).catch(() => undefined);
      throw error;
    }
    const cleanupPending = !(await this.run(workspace.repoRoot, ["worktree", "remove", path]).then(
      () => true,
      () => false
    ));
    return { targetSha, cleanupPending };
  }

  async push(workspace: GitWorkspaceCoordinates): Promise<{ targetSha: string; remoteSha: string }> {
    if (!workspace.targetRemote) throw new GitWorkspaceError("No target remote is configured", "missing_remote");
    const targetSha = await this.resolveCommit(workspace.repoRoot, localBranchRef(workspace.targetBranch));
    const remote = await this.tryResolveRemoteBranch(workspace.repoRoot, workspace.targetRemote, workspace.targetBranch, false);
    if (remote) {
      const fastForward = await this.isAncestor(workspace.repoRoot, remote.commitSha, targetSha);
      if (!fastForward) throw new GitWorkspaceError("Remote target is not an ancestor of the local target", "non_fast_forward");
    }
    await this.run(workspace.repoRoot, [
      "push",
      "--porcelain",
      workspace.targetRemote,
      `${localBranchRef(workspace.targetBranch)}:refs/heads/${workspace.targetBranch}`
    ]);
    return { targetSha, remoteSha: targetSha };
  }

  async remoteStatus(workspace: GitWorkspaceCoordinates): Promise<{ remoteSha: string | null; ahead: number; behind: number }> {
    if (!workspace.targetRemote) return { remoteSha: null, ahead: 0, behind: 0 };
    const remote = await this.tryResolveRemoteBranch(workspace.repoRoot, workspace.targetRemote, workspace.targetBranch, false);
    if (!remote) return { remoteSha: null, ahead: 0, behind: 0 };
    const targetSha = await this.resolveCommit(workspace.repoRoot, localBranchRef(workspace.targetBranch));
    const counts = await this.compareCounts(workspace.repoRoot, remote.commitSha, targetSha);
    return { remoteSha: remote.commitSha, ahead: counts.ahead, behind: counts.behind };
  }

  async rotate(
    workspace: GitWorkspaceCoordinates,
    inspections: Array<{ worktreePath: string | null }>,
    generation: number,
    recover = false
  ): Promise<GitRotationResult> {
    const targetSha = await this.resolveCommit(workspace.repoRoot, localBranchRef(workspace.targetBranch));
    const state = await this.status(workspace).catch((error) => {
      if (recover) return null;
      throw error;
    });
    if (state) {
      if (state.dirty || state.rebaseInProgress) throw new GitWorkspaceError("Completed worktree is not clean", "rotation_blocked");
      if (!(await this.isAncestor(workspace.repoRoot, state.sessionHeadSha, targetSha))) {
        throw new GitWorkspaceError("Completed session commits are not reachable from the target", "rotation_unintegrated");
      }
    }
    for (const inspection of inspections) {
      if (!inspection.worktreePath) continue;
      await this.run(workspace.repoRoot, ["worktree", "unlock", inspection.worktreePath]).catch(() => undefined);
      await this.run(workspace.repoRoot, ["worktree", "remove", inspection.worktreePath]);
    }
    await this.run(workspace.repoRoot, ["worktree", "unlock", workspace.worktreePath]).catch(() => undefined);
    const remove = this.run(workspace.repoRoot, ["worktree", "remove", workspace.worktreePath]);
    if (recover) await remove.catch(() => undefined);
    else await remove;
    await rm(workspace.worktreePath, { recursive: true, force: true }).catch(() => undefined);
    await this.run(workspace.repoRoot, ["update-ref", "-d", localBranchRef(workspace.sessionBranch)]);
    const sessionBranch = `muxpilot/${workspace.workspaceId}/g${generation}`;
    await this.run(workspace.repoRoot, ["branch", "-D", sessionBranch]).catch(() => undefined);
    await this.run(workspace.repoRoot, ["worktree", "add", "-b", sessionBranch, workspace.worktreePath, targetSha]);
    await this.run(workspace.repoRoot, ["worktree", "lock", "--reason", `muxpilot:${workspace.workspaceId}:g${generation}`, workspace.worktreePath]);
    return { sessionBranch, targetSha, sessionHeadSha: targetSha };
  }

  async recoverIntegrationWorktree(workspace: GitWorkspaceCoordinates, integrationRoot: string): Promise<boolean> {
    const worktrees = await this.output(workspace.repoRoot, ["worktree", "list", "--porcelain"]);
    const path = checkedOutBranchPath(worktrees, localBranchRef(workspace.targetBranch));
    if (!path || !isInside(resolve(integrationRoot), resolve(path))) return false;
    const dirty = await this.output(path, ["status", "--porcelain"]);
    if (dirty) throw new GitWorkspaceError(`Managed integration worktree is dirty at ${path}`, "dirty_integration_worktree");
    await this.run(workspace.repoRoot, ["worktree", "remove", path]);
    return true;
  }

  async compareCounts(repoRoot: string, leftSha: string, rightSha: string): Promise<{ ahead: number; behind: number }> {
    const value = await this.output(repoRoot, ["rev-list", "--left-right", "--count", `${leftSha}...${rightSha}`]);
    const [behind = 0, ahead = 0] = value.split(/\s+/).map(Number);
    return { ahead, behind };
  }

  private async defaultRemoteRevision(repoRoot: string, remote: string | null): Promise<GitRevisionSpec> {
    if (!remote) throw new GitWorkspaceError("A source revision is required because no default remote is available", "missing_source");
    const output = await this.output(repoRoot, ["ls-remote", "--symref", remote, "HEAD"]);
    const match = output.match(/^ref:\s+refs\/heads\/(.+)\s+HEAD$/m);
    if (!match?.[1]) throw new GitWorkspaceError(`Could not determine ${remote}'s default branch`, "missing_remote_head");
    return { kind: "remote_branch", remote, branch: match[1] };
  }

  private async tryResolveRemoteBranch(repoRoot: string, remote: string, branch: string, allowCached: boolean): Promise<ResolvedRevision | null> {
    const ref = remoteHeadCacheRef(remote, branch);
    try {
      const advertised = await this.output(repoRoot, ["ls-remote", "--heads", remote, `refs/heads/${branch}`]);
      if (!advertised) return null;
      return await this.fetchRevision(repoRoot, { kind: "remote_branch", remote, branch }, ref, [`+refs/heads/${branch}:${ref}`], allowCached);
    } catch (error) {
      if (allowCached) {
        const cached = await this.tryResolveCommit(repoRoot, ref);
        if (cached) return { requested: { kind: "remote_branch", remote, branch }, resolvedRef: ref, commitSha: cached, fetchedAt: await this.fetchMetadata(repoRoot, ref), freshness: "cached" };
      }
      throw error;
    }
  }

  private async fetchRevision(
    repoRoot: string,
    requested: GitRevisionSpec,
    ref: string,
    refspecs: string[],
    allowCached: boolean
  ): Promise<ResolvedRevision> {
    const remote = "remote" in requested ? requested.remote : undefined;
    if (!remote) throw new GitWorkspaceError("A remote is required to fetch this revision", "missing_remote");
    try {
      await this.run(repoRoot, ["fetch", "--no-tags", "--no-write-fetch-head", remote, ...refspecs]);
      let commitSha = await this.tryResolveCommit(repoRoot, ref);
      if (!commitSha && requested.kind === "commit") {
        commitSha = await this.resolveCommit(repoRoot, requested.oid);
        await this.run(repoRoot, ["update-ref", ref, commitSha]);
      }
      if (!commitSha) throw new GitWorkspaceError("Fetched revision did not resolve to a commit", "invalid_revision");
      const fetchedAt = new Date().toISOString();
      await this.writeFetchMetadata(repoRoot, ref, fetchedAt);
      return { requested, resolvedRef: ref, commitSha, fetchedAt, freshness: "fresh" };
    } catch (error) {
      if (allowCached) {
        const cached = await this.tryResolveCommit(repoRoot, ref);
        if (cached) return { requested, resolvedRef: ref, commitSha: cached, fetchedAt: await this.fetchMetadata(repoRoot, ref), freshness: "cached" };
      }
      throw error;
    }
  }

  private async absoluteCommonGitDir(repoRoot: string): Promise<string> {
    const value = await this.output(repoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    return resolve(repoRoot, value);
  }

  private async writeFetchMetadata(repoRoot: string, ref: string, fetchedAt: string): Promise<void> {
    const root = join(await this.absoluteCommonGitDir(repoRoot), "muxpilot-cache");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, `${createHash("sha256").update(ref).digest("hex")}.json`), JSON.stringify({ ref, fetchedAt }));
  }

  private async fetchMetadata(repoRoot: string, ref: string): Promise<string | null> {
    const path = join(await this.absoluteCommonGitDir(repoRoot), "muxpilot-cache", `${createHash("sha256").update(ref).digest("hex")}.json`);
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as { ref?: string; fetchedAt?: string };
      return value.ref === ref && typeof value.fetchedAt === "string" ? value.fetchedAt : null;
    } catch {
      return null;
    }
  }

  private async compatibilityWarnings(repoRoot: string, revision: string): Promise<string[]> {
    const warnings: string[] = [];
    if (await this.tryOutput(repoRoot, ["show", `${revision}:.gitmodules`])) {
      warnings.push("Repository uses submodules; initialize and test them independently in this session worktree.");
    }
    if ((await this.tryOutput(repoRoot, ["config", "--bool", "core.sparseCheckout"])) === "true") {
      warnings.push("Repository uses sparse checkout; verify the session worktree contains every path required by the task.");
    }
    if (await this.tryOutput(repoRoot, ["grep", "-I", "-l", "filter=lfs", revision, "--", "*.gitattributes", ".gitattributes"])) {
      warnings.push("Repository uses Git LFS; verify required objects were hydrated before testing or review.");
    }
    return warnings;
  }

  private async tryOutput(cwd: string, args: string[]): Promise<string> {
    try {
      return await this.output(cwd, args);
    } catch {
      return "";
    }
  }

  private async validateBranch(cwd: string, branch: string): Promise<void> {
    if (!branch.trim() || branch.startsWith("-")) throw new GitWorkspaceError("Invalid branch name", "invalid_branch");
    await this.run(cwd, ["check-ref-format", "--branch", branch]);
  }

  private async resolveCommit(cwd: string, revision: string): Promise<string> {
    const value = await this.tryResolveCommit(cwd, revision);
    if (!value) throw new GitWorkspaceError(`Revision '${revision}' does not resolve to a commit`, "missing_revision");
    return value;
  }

  private async tryResolveCommit(cwd: string, revision: string): Promise<string | null> {
    try {
      return await this.output(cwd, ["rev-parse", "--verify", `${revision}^{commit}`]);
    } catch {
      return null;
    }
  }

  private async isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
    try {
      await this.run(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]);
      return true;
    } catch {
      return false;
    }
  }

  private async output(cwd: string, args: string[]): Promise<string> {
    return (await this.run(cwd, args)).stdout.trim();
  }

  private run(cwd: string, args: string[]): Promise<GitCommandResult> {
    return this.runner.run(cwd, args);
  }
}

function localBranchRef(branch: string): string {
  return `refs/heads/${branch}`;
}

function remoteHeadCacheRef(remote: string, branch: string): string {
  return `refs/muxpilot/remotes/${remoteKey(remote)}/heads/${branch}`;
}

function remoteTagCacheRef(remote: string, tag: string): string {
  return `refs/muxpilot/remotes/${remoteKey(remote)}/tags/${branchKey(tag)}`;
}

function remoteKey(remote: string): string {
  return `${branchKey(remote)}-${createHash("sha256").update(remote).digest("hex").slice(0, 8)}`;
}

function repoIdentity(commonGitDir: string): string {
  return `${basename(dirname(commonGitDir))}-${createHash("sha256").update(commonGitDir).digest("hex").slice(0, 12)}`;
}

function branchKey(value: string): string {
  const readable = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "ref";
  return `${readable}-${createHash("sha256").update(value).digest("hex").slice(0, 8)}`;
}

function checkedOutBranchPath(porcelain: string, branchRef: string): string | null {
  let path: string | null = null;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    if (line === `branch ${branchRef}`) return path;
    if (!line && path) path = null;
  }
  return null;
}

function fullOid(value: string): string {
  const oid = value.trim().toLowerCase();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) throw new GitWorkspaceError("Commit must be a full SHA-1 or SHA-256 object id", "invalid_oid");
  return oid;
}

function zeroOid(length: number): string {
  return "0".repeat(length === 64 ? 64 : 40);
}

function validateWorkspaceId(value: string): void {
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(value)) throw new GitWorkspaceError("Invalid workspace identifier", "invalid_workspace_id");
}

function lines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

async function existingPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    throw new GitWorkspaceError("Directory does not exist or is not accessible", "missing_directory");
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await realpath(path);
    return true;
  } catch {
    return false;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function revisionNeedsRemote(revision: GitRevisionSpec): boolean {
  return revision.kind === "remote_branch" || revision.kind === "remote_tag" || (revision.kind === "commit" && Boolean(revision.remote));
}

function isInside(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}
