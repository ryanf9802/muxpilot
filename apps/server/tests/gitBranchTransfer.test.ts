import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  exportPortableGitBranch,
  importPortableGitBranches
} from "../src/services/gitBranchTransfer.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("portable Git branches", () => {
  it("exports an upstream delta and creates the branch with its upstream", async () => {
    const fixture = await repositoryFixture();
    await git(fixture.source, ["switch", "-c", "feature"]);
    await git(fixture.source, ["branch", "--set-upstream-to=origin/main"]);
    await git(fixture.source, ["commit", "--allow-empty", "-m", "local feature"]);

    const exported = await exportPortableGitBranch(
      fixture.source,
      "feature",
      "branch-0001",
      "git/0001.bundle"
    );
    expect(exported.branch).toMatchObject({
      branchName: "feature",
      bundleMode: "upstream_delta",
      upstreamRemote: "origin",
      upstreamMergeRef: "refs/heads/main"
    });

    const response = await importPortableGitBranches(
      [exported.branch],
      new Map([[exported.branch.bundleEntry!, exported.bundle!]]),
      [{ sourceCwd: fixture.source, destinationCwd: fixture.destination }]
    );
    expect(response).toEqual([expect.objectContaining({
      branchName: "feature",
      status: "created",
      upstreamStatus: "restored",
      warning: null
    })]);
    expect(await git(fixture.destination, ["rev-parse", "feature"])).toBe(exported.branch.tipSha);
    expect(await git(fixture.destination, ["config", "branch.feature.remote"])).toBe("origin");
    expect(await git(fixture.destination, ["config", "branch.feature.merge"])).toBe("refs/heads/main");
  });

  it("fast-forwards a clean checked-out branch and refuses divergent history", async () => {
    const fixture = await repositoryFixture();
    await git(fixture.source, ["commit", "--allow-empty", "-m", "local main"]);
    const exported = await exportPortableGitBranch(
      fixture.source,
      "main",
      "branch-0001",
      "git/0001.bundle"
    );
    const contents = new Map([[exported.branch.bundleEntry!, exported.bundle!]]);

    const response = await importPortableGitBranches(
      [exported.branch],
      contents,
      [{ sourceCwd: fixture.source, destinationCwd: fixture.destination }]
    );
    expect(response[0]).toMatchObject({ status: "fast_forwarded", upstreamStatus: "kept_existing" });
    expect(await git(fixture.destination, ["rev-parse", "HEAD"])).toBe(exported.branch.tipSha);
    await git(fixture.destination, ["commit", "--allow-empty", "-m", "destination newer"]);
    const keptNewer = await importPortableGitBranches(
      [exported.branch],
      contents,
      [{ sourceCwd: fixture.source, destinationCwd: fixture.destination }]
    );
    expect(keptNewer[0]).toMatchObject({ status: "kept_newer" });

    const divergent = join(fixture.root, "divergent");
    await git(fixture.root, ["clone", fixture.origin, divergent]);
    await configureIdentity(divergent);
    await git(divergent, ["commit", "--allow-empty", "-m", "destination only"]);
    await expect(importPortableGitBranches(
      [exported.branch],
      contents,
      [{ sourceCwd: fixture.source, destinationCwd: divergent }]
    )).rejects.toThrow("has diverged");
    expect(await git(divergent, ["log", "-1", "--format=%s"])).toBe("destination only");
  });

  it("refuses to move a dirty checked-out destination branch", async () => {
    const fixture = await repositoryFixture();
    await git(fixture.source, ["commit", "--allow-empty", "-m", "local main"]);
    const exported = await exportPortableGitBranch(
      fixture.source,
      "main",
      "branch-0001",
      "git/0001.bundle"
    );
    await writeFile(join(fixture.destination, "dirty.txt"), "do not overwrite\n");

    await expect(importPortableGitBranches(
      [exported.branch],
      new Map([[exported.branch.bundleEntry!, exported.bundle!]]),
      [{ sourceCwd: fixture.source, destinationCwd: fixture.destination }]
    )).rejects.toThrow("has uncommitted changes");
    expect(await git(fixture.destination, ["log", "-1", "--format=%s"])).toBe("base");
  });

  it("uses no bundle when the target tip is already at its upstream", async () => {
    const fixture = await repositoryFixture();
    const exported = await exportPortableGitBranch(
      fixture.source,
      "main",
      "branch-0001",
      "git/0001.bundle"
    );
    expect(exported.branch).toMatchObject({
      bundleMode: "none",
      bundleEntry: null,
      upstreamBaseSha: exported.branch.tipSha
    });
    expect(exported.bundle).toBeNull();

    const response = await importPortableGitBranches(
      [exported.branch],
      new Map(),
      [{ sourceCwd: fixture.source, destinationCwd: fixture.destination }]
    );
    expect(response[0]).toMatchObject({ status: "reused" });
  });

  it("imports without an upstream when the source remote name is unavailable", async () => {
    const fixture = await repositoryFixture();
    await git(fixture.source, ["switch", "-c", "feature"]);
    await git(fixture.source, ["branch", "--set-upstream-to=origin/main"]);
    await git(fixture.source, ["commit", "--allow-empty", "-m", "local feature"]);
    const exported = await exportPortableGitBranch(
      fixture.source,
      "feature",
      "branch-0001",
      "git/0001.bundle"
    );
    await git(fixture.destination, ["remote", "remove", "origin"]);

    const response = await importPortableGitBranches(
      [exported.branch],
      new Map([[exported.branch.bundleEntry!, exported.bundle!]]),
      [{ sourceCwd: fixture.source, destinationCwd: fixture.destination }]
    );
    expect(response[0]).toMatchObject({ status: "created", upstreamStatus: "unavailable" });
    expect(response[0]?.warning).toContain("imported without an upstream");
    await expect(git(fixture.destination, ["config", "branch.feature.remote"])).rejects.toThrow();
  });

  it("preserves a conflicting existing destination upstream", async () => {
    const fixture = await repositoryFixture();
    await git(fixture.source, ["switch", "-c", "feature"]);
    await git(fixture.source, ["branch", "--set-upstream-to=origin/main"]);
    await git(fixture.source, ["commit", "--allow-empty", "-m", "local feature"]);
    const exported = await exportPortableGitBranch(
      fixture.source,
      "feature",
      "branch-0001",
      "git/0001.bundle"
    );
    await git(fixture.destination, ["branch", "feature"]);
    await git(fixture.destination, ["config", "branch.feature.remote", "backup"]);
    await git(fixture.destination, ["config", "branch.feature.merge", "refs/heads/release"]);

    const response = await importPortableGitBranches(
      [exported.branch],
      new Map([[exported.branch.bundleEntry!, exported.bundle!]]),
      [{ sourceCwd: fixture.source, destinationCwd: fixture.destination }]
    );
    expect(response[0]).toMatchObject({
      status: "fast_forwarded",
      upstreamStatus: "kept_existing"
    });
    expect(response[0]?.warning).toContain("Kept existing upstream");
    expect(await git(fixture.destination, ["config", "branch.feature.remote"])).toBe("backup");
    expect(await git(fixture.destination, ["config", "branch.feature.merge"])).toBe("refs/heads/release");
  });
});

async function repositoryFixture(): Promise<{
  root: string;
  origin: string;
  source: string;
  destination: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "muxpilot-git-transfer-test-"));
  roots.push(root);
  const origin = join(root, "origin.git");
  const source = join(root, "source");
  const destination = join(root, "destination");
  await git(root, ["init", "--bare", origin]);
  await git(root, ["clone", origin, source]);
  await configureIdentity(source);
  await git(source, ["commit", "--allow-empty", "-m", "base"]);
  await git(source, ["branch", "-M", "main"]);
  await git(source, ["push", "-u", "origin", "main"]);
  await git(origin, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  await git(root, ["clone", origin, destination]);
  await configureIdentity(destination);
  return { root, origin, source, destination };
}

async function configureIdentity(repo: string): Promise<void> {
  await git(repo, ["config", "user.email", "muxpilot@example.com"]);
  await git(repo, ["config", "user.name", "Muxpilot"]);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
  });
  return stdout.trim();
}
