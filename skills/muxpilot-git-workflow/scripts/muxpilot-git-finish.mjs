#!/usr/bin/env node
import { acquireBranchLock, configuration, git, readStatus, targetCheckout, unlinkSharedDependencies, worktreeExists, writeStatus } from "./local-workflow.mjs";

const bypasses = process.argv.slice(2).filter((value) => value.startsWith("--bypass=")).map((value) => value.slice(9));
const allowedBypasses = new Set(["worktree-isolation", "same-agent-review", "focused-validation", "atomic-commits", "clean-target", "local-target-only", "automatic-cleanup", "no-pull-push"]);
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write("Usage: muxpilot-git-finish [--bypass=<guard>]\n");
  process.exit(0);
}
if (bypasses.some((value) => !allowedBypasses.has(value))) {
  process.stderr.write("Unknown guard bypass. Bypasses must name an exact muxpilot guard.\n");
  process.exit(2);
}

let release = null;
let config = null;
let status = null;
try {
  config = configuration();
  status = await readStatus(config);
  if (!["worktree", "blocked", "failed"].includes(status?.state) || !(await worktreeExists(status.worktreePath)) || !status.sessionBranch) {
    throw new Error("No active task worktree to integrate");
  }
  const worktree = status.worktreePath;
  const porcelain = await git(worktree, ["status", "--porcelain"]);
  if (hasMeaningfulChanges(porcelain, config.dependencies)) throw new Error("The task worktree is not clean; commit the completed changes before integration");
  const taskHead = await git(worktree, ["rev-parse", "HEAD"]);
  let targetSha = await git(config.repoRoot, ["rev-parse", `refs/heads/${config.targetBranch}^{commit}`]);
  if (taskHead === targetSha) {
    if (!bypasses.includes("automatic-cleanup")) {
      await unlinkSharedDependencies(config, worktree);
      await git(config.repoRoot, ["worktree", "remove", worktree]);
      await git(config.repoRoot, ["branch", "-d", status.sessionBranch]);
    }
    await writeStatus(config, {
      state: "idle",
      targetSha,
      sessionBranch: bypasses.includes("automatic-cleanup") ? status.sessionBranch : null,
      worktreePath: bypasses.includes("automatic-cleanup") ? worktree : null,
      lastError: null
    });
    process.stdout.write(`INTEGRATED target=refs/heads/${config.targetBranch} sha=${targetSha} worktree=${bypasses.includes("automatic-cleanup") ? "retained" : "removed"}\n`);
    process.exit(0);
  }
  const commits = Number(await git(worktree, ["rev-list", "--count", `${targetSha}..${taskHead}`]).catch(() => "0"));
  if (commits < 1) throw new Error("The task branch has no commits to integrate");

  const checkout = await targetCheckout(config);
  if (checkout && !bypasses.includes("clean-target")) {
    const dirty = await git(checkout, ["status", "--porcelain"]);
    if (hasMeaningfulChanges(dirty, config.dependencies)) {
      await writeStatus(config, { ...status, state: "blocked", targetSha, lastError: "The target branch is checked out with uncommitted changes" });
      throw new Error("DIRTY_TARGET: clean or move the target checkout before integration");
    }
  }

  if (!(await isAncestor(worktree, targetSha, taskHead))) {
    try {
      await git(worktree, ["rebase", targetSha]);
    } catch (error) {
      await writeStatus(config, { ...status, state: "blocked", targetSha, lastError: `Rebase conflict: ${error.message}` });
      throw new Error(`REBASE_CONFLICT: resolve the task worktree, rerun focused checks and self-review, then retry finish\n${error.message}`);
    }
    status = await writeStatus(config, { ...status, state: "worktree", targetSha, lastError: null });
    process.stdout.write("REBASED_REVIEW_REQUIRED: the target advanced; rerun focused checks and the self-review loop before retrying integration\n");
    process.exit(3);
  }

  release = await acquireBranchLock(config);
  const lockedTarget = await git(config.repoRoot, ["rev-parse", `refs/heads/${config.targetBranch}^{commit}`]);
  if (lockedTarget !== targetSha) {
    await release();
    release = null;
    try {
      await git(worktree, ["rebase", lockedTarget]);
      await writeStatus(config, { ...status, state: "worktree", targetSha: lockedTarget, lastError: null });
      process.stdout.write("REBASED_REVIEW_REQUIRED: another task integrated first; rerun focused checks and the self-review loop\n");
      process.exit(3);
    } catch (error) {
      await writeStatus(config, { ...status, state: "blocked", targetSha: lockedTarget, lastError: `Rebase conflict: ${error.message}` });
      throw error;
    }
  }

  await writeStatus(config, { ...status, state: "integrating", targetSha, lastError: null });
  const finalHead = await git(worktree, ["rev-parse", "HEAD"]);
  const currentCheckout = await targetCheckout(config);
  if (currentCheckout) {
    if (!bypasses.includes("clean-target") && hasMeaningfulChanges(await git(currentCheckout, ["status", "--porcelain"]), config.dependencies)) throw new Error("DIRTY_TARGET: target changed during integration");
    await git(currentCheckout, ["merge", "--ff-only", finalHead]);
  } else {
    await git(config.repoRoot, ["update-ref", `refs/heads/${config.targetBranch}`, finalHead, lockedTarget]);
  }
  await release();
  release = null;

  if (!bypasses.includes("automatic-cleanup")) {
    await unlinkSharedDependencies(config, worktree);
    await git(config.repoRoot, ["worktree", "remove", worktree]);
    await git(config.repoRoot, ["branch", "-d", status.sessionBranch]);
  }
  await writeStatus(config, {
    state: "idle",
    targetSha: finalHead,
    sessionBranch: bypasses.includes("automatic-cleanup") ? status.sessionBranch : null,
    worktreePath: bypasses.includes("automatic-cleanup") ? worktree : null,
    lastError: null
  });
  process.stdout.write(`INTEGRATED target=refs/heads/${config.targetBranch} sha=${finalHead} worktree=${bypasses.includes("automatic-cleanup") ? "retained" : "removed"}\n`);
} catch (error) {
  if (release) await release().catch(() => undefined);
  if (config) {
    const current = await readStatus(config).catch(() => null);
    if (current?.state === "integrating") {
      await writeStatus(config, { ...current, state: "failed", lastError: error.message }).catch(() => undefined);
    }
  }
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}

async function isAncestor(cwd, ancestor, descendant) {
  try {
    await git(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

function hasMeaningfulChanges(porcelain, dependencies) {
  const ignored = dependencies.map((dependency) => dependency.relativePath.replaceAll("\\", "/"));
  return porcelain.split(/\r?\n/).filter(Boolean).some((line) => {
    const path = line.slice(3).replace(/^"|"$/g, "").replaceAll("\\", "/");
    return !ignored.some((dependency) => path === dependency || path.startsWith(`${dependency}/`));
  });
}
