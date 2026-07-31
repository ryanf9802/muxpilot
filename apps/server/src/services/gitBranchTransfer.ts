import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  SessionTransferImportBranchResult,
  SessionTransferImportMapping,
  SessionTransferPreviewBranch
} from "@muxpilot/core";
import { nanoid } from "nanoid";

const execFileAsync = promisify(execFile);
const MAX_GIT_BUNDLE_BYTES = 512 * 1024 * 1024;

export interface PortableGitBranch extends SessionTransferPreviewBranch {
  id: string;
  sourceCwd: string;
  bundleEntry: string | null;
  bundleBytes: number;
  bundleSha256: string | null;
}

export interface ExportedGitBranch {
  branch: PortableGitBranch;
  bundle: Buffer | null;
}

interface PreparedBranch {
  branch: PortableGitBranch;
  destinationCwd: string;
  repoRoot: string;
  branchRef: string;
  temporaryRef: string;
  existingSha: string | null;
  checkoutPath: string | null;
  status: SessionTransferImportBranchResult["status"];
  upstreamStatus: SessionTransferImportBranchResult["upstreamStatus"];
  warning: string | null;
}

export async function exportPortableGitBranch(
  sourceCwd: string,
  branchName: string,
  id: string,
  bundleEntry: string
): Promise<ExportedGitBranch> {
  const repoRoot = await git(sourceCwd, ["rev-parse", "--show-toplevel"]);
  await git(repoRoot, ["check-ref-format", "--branch", branchName]);
  const branchRef = `refs/heads/${branchName}`;
  const objectFormat = await git(repoRoot, ["rev-parse", "--show-object-format"]);
  if (objectFormat !== "sha1" && objectFormat !== "sha256") throw new Error(`Unsupported Git object format '${objectFormat}'`);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const tipSha = await git(repoRoot, ["rev-parse", `${branchRef}^{commit}`]);
    const upstreamRemote = await gitOptional(repoRoot, ["config", "--get", `branch.${branchName}.remote`]);
    const upstreamMergeRef = await gitOptional(repoRoot, ["config", "--get", `branch.${branchName}.merge`]);
    const upstreamRef = await gitOptional(repoRoot, ["for-each-ref", "--format=%(upstream)", branchRef]);
    const upstreamSha = upstreamRef ? await gitOptional(repoRoot, ["rev-parse", `${upstreamRef}^{commit}`]) : null;
    const exclusiveCount = upstreamSha
      ? Number(await git(repoRoot, ["rev-list", "--count", tipSha, `^${upstreamSha}`]))
      : 1;
    const bundleMode: PortableGitBranch["bundleMode"] = exclusiveCount === 0
      ? "none"
      : upstreamSha ? "upstream_delta" : "full";

    let bundle: Buffer | null = null;
    if (bundleMode !== "none") {
      const temporary = await mkdtemp(join(tmpdir(), "muxpilot-git-export-"));
      const path = join(temporary, "branch.bundle");
      try {
        const revisions = bundleMode === "upstream_delta" ? [branchRef, `^${upstreamSha}`] : [branchRef];
        await git(repoRoot, ["bundle", "create", path, ...revisions]);
        if ((await git(repoRoot, ["bundle", "list-heads", path, branchRef])).split(/\s+/, 1)[0] !== tipSha) {
          continue;
        }
        if ((await stat(path)).size > MAX_GIT_BUNDLE_BYTES) {
          throw new Error(`Git branch '${branchName}' exceeds the 512 MiB transfer limit`);
        }
        bundle = await readFile(path);
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }

    if (await git(repoRoot, ["rev-parse", `${branchRef}^{commit}`]) !== tipSha) continue;
    return {
      branch: {
        id,
        sourceCwd,
        branchName,
        tipSha,
        objectFormat,
        bundleMode,
        upstreamRemote,
        upstreamMergeRef,
        upstreamBaseSha: upstreamSha,
        bundleEntry: bundle ? bundleEntry : null,
        bundleBytes: bundle?.length ?? 0,
        bundleSha256: bundle ? sha256(bundle) : null
      },
      bundle
    };
  }
  throw new Error(`Target branch '${branchName}' changed while it was being exported; try again`);
}

export async function importPortableGitBranches(
  branches: PortableGitBranch[],
  contents: Map<string, Buffer>,
  mappings: SessionTransferImportMapping[]
): Promise<SessionTransferImportBranchResult[]> {
  const mappingBySource = new Map(mappings.map((mapping) => [mapping.sourceCwd, mapping]));
  const prepared: PreparedBranch[] = [];
  const temporaryDirs: string[] = [];
  try {
    for (const branch of branches) {
      const mapping = mappingBySource.get(branch.sourceCwd);
      if (!mapping) throw new Error(`Missing destination mapping for '${branch.sourceCwd}'`);
      prepared.push(await prepareBranch(branch, contents, mapping.destinationCwd, temporaryDirs));
    }
    const unique = new Map<string, PreparedBranch>();
    for (const item of prepared) {
      const key = `${item.repoRoot}\u0000${item.branchRef}`;
      const previous = unique.get(key);
      if (previous) {
        if (previous.branch.tipSha !== item.branch.tipSha
          || previous.branch.upstreamRemote !== item.branch.upstreamRemote
          || previous.branch.upstreamMergeRef !== item.branch.upstreamMergeRef) {
          throw new Error(`Destination mappings contain conflicting transfers for '${item.branch.branchName}'`);
        }
        continue;
      }
      unique.set(key, item);
    }
    for (const item of unique.values()) await applyBranch(item);
    return prepared.map((item) => ({
      sourceCwd: item.branch.sourceCwd,
      destinationCwd: item.destinationCwd,
      branchName: item.branch.branchName,
      status: item.status,
      upstreamStatus: item.upstreamStatus,
      warning: item.warning
    }));
  } finally {
    await Promise.all(prepared.map((item) =>
      gitOptional(item.repoRoot, ["-c", "core.hooksPath=/dev/null", "update-ref", "-d", item.temporaryRef])));
    await Promise.all(temporaryDirs.map((path) => rm(path, { recursive: true, force: true })));
  }
}

async function prepareBranch(
  branch: PortableGitBranch,
  contents: Map<string, Buffer>,
  destinationCwd: string,
  temporaryDirs: string[]
): Promise<PreparedBranch> {
  const destination = await realpath(destinationCwd);
  if (await git(destination, ["rev-parse", "--is-bare-repository"]) === "true") {
    throw new Error(`Destination for '${branch.branchName}' is a bare Git repository`);
  }
  const repoRoot = await git(destination, ["rev-parse", "--show-toplevel"]);
  try {
    await git(repoRoot, ["check-ref-format", "--branch", branch.branchName]);
    if (branch.upstreamMergeRef) await git(repoRoot, ["check-ref-format", branch.upstreamMergeRef]);
  } catch {
    throw new Error(`Transferred Git ref metadata is invalid for '${branch.branchName}'`);
  }
  const objectFormat = await git(repoRoot, ["rev-parse", "--show-object-format"]);
  if (objectFormat !== branch.objectFormat) {
    throw new Error(`Git object format for '${branch.branchName}' is ${objectFormat}, expected ${branch.objectFormat}`);
  }

  const temporaryRef = `refs/muxpilot/import/${nanoid(20)}`;
  if (branch.bundleEntry) {
    const bundle = contents.get(branch.bundleEntry);
    if (!bundle || bundle.length !== branch.bundleBytes || sha256(bundle) !== branch.bundleSha256) {
      throw new Error(`Git bundle validation failed for '${branch.branchName}'`);
    }
    const temporary = await mkdtemp(join(tmpdir(), "muxpilot-git-import-"));
    temporaryDirs.push(temporary);
    const bundlePath = join(temporary, "branch.bundle");
    await writeFile(bundlePath, bundle, { mode: 0o600 });
    try {
      await git(repoRoot, ["bundle", "verify", bundlePath]);
      await git(repoRoot, [
        "-c", "core.hooksPath=/dev/null", "fetch", "--no-tags", "--no-write-fetch-head", bundlePath,
        `refs/heads/${branch.branchName}:${temporaryRef}`
      ]);
    } catch (error) {
      throw new Error(`Git bundle prerequisites are unavailable for '${branch.branchName}': ${errorMessage(error)}`);
    }
  } else {
    try {
      await git(repoRoot, ["cat-file", "-e", `${branch.tipSha}^{commit}`]);
    } catch {
      throw new Error(`Destination is missing commit ${branch.tipSha} required for '${branch.branchName}'`);
    }
    await git(repoRoot, ["-c", "core.hooksPath=/dev/null", "update-ref", temporaryRef, branch.tipSha]);
  }

  if (await git(repoRoot, ["rev-parse", `${temporaryRef}^{commit}`]) !== branch.tipSha) {
    throw new Error(`Git bundle tip does not match '${branch.branchName}'`);
  }
  const branchRef = `refs/heads/${branch.branchName}`;
  const existingSha = await gitOptional(repoRoot, ["rev-parse", "--verify", `${branchRef}^{commit}`]);
  let status: PreparedBranch["status"];
  if (!existingSha) status = "created";
  else if (existingSha === branch.tipSha) status = "reused";
  else if (await isAncestor(repoRoot, existingSha, branch.tipSha)) status = "fast_forwarded";
  else if (await isAncestor(repoRoot, branch.tipSha, existingSha)) status = "kept_newer";
  else throw new Error(`Local branch '${branch.branchName}' has diverged from the transferred branch`);

  const checkoutPath = status === "fast_forwarded" ? await checkedOutPath(repoRoot, branchRef) : null;
  if (checkoutPath && await git(checkoutPath, ["status", "--porcelain"])) {
    throw new Error(`Checked-out branch '${branch.branchName}' has uncommitted changes`);
  }

  const existingRemote = existingSha
    ? await gitOptional(repoRoot, ["config", "--get", `branch.${branch.branchName}.remote`])
    : null;
  const existingMerge = existingSha
    ? await gitOptional(repoRoot, ["config", "--get", `branch.${branch.branchName}.merge`])
    : null;
  const remotes = new Set(lines(await git(repoRoot, ["remote"])));
  let upstreamStatus: PreparedBranch["upstreamStatus"] = "none";
  let warning: string | null = null;
  if (existingRemote || existingMerge) {
    upstreamStatus = "kept_existing";
    if (branch.upstreamRemote && (existingRemote !== branch.upstreamRemote || existingMerge !== branch.upstreamMergeRef)) {
      warning = `Kept existing upstream ${existingRemote ?? "?"}:${existingMerge ?? "?"} instead of ${branch.upstreamRemote}:${branch.upstreamMergeRef}`;
    }
  } else if (branch.upstreamRemote && branch.upstreamMergeRef) {
    if (remotes.has(branch.upstreamRemote)) upstreamStatus = "restored";
    else {
      upstreamStatus = "unavailable";
      warning = `Remote '${branch.upstreamRemote}' is unavailable; imported without an upstream`;
    }
  }

  return {
    branch,
    destinationCwd: destination,
    repoRoot,
    branchRef,
    temporaryRef,
    existingSha,
    checkoutPath,
    status,
    upstreamStatus,
    warning
  };
}

async function applyBranch(item: PreparedBranch): Promise<void> {
  if (item.status === "created") {
    await git(item.repoRoot, [
      "-c", "core.hooksPath=/dev/null", "update-ref", item.branchRef, item.branch.tipSha,
      "0".repeat(item.branch.objectFormat === "sha1" ? 40 : 64)
    ]);
  } else if (item.status === "fast_forwarded") {
    if (item.checkoutPath) {
      await git(item.checkoutPath, [
        "-c", "core.hooksPath=/dev/null", "merge", "--ff-only", "--no-edit", item.temporaryRef
      ]);
    } else {
      await git(item.repoRoot, [
        "-c", "core.hooksPath=/dev/null", "update-ref", item.branchRef, item.branch.tipSha, item.existingSha!
      ]);
    }
  }
  if (item.upstreamStatus === "restored") {
    await git(item.repoRoot, ["config", `branch.${item.branch.branchName}.remote`, item.branch.upstreamRemote!]);
    await git(item.repoRoot, ["config", `branch.${item.branch.branchName}.merge`, item.branch.upstreamMergeRef!]);
  }
}

async function checkedOutPath(repoRoot: string, branchRef: string): Promise<string | null> {
  const output = await git(repoRoot, ["worktree", "list", "--porcelain"]);
  let path: string | null = null;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line === `branch ${branchRef}`) return path;
    else if (!line) path = null;
  }
  return null;
}

async function isAncestor(repoRoot: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await git(repoRoot, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch (error) {
    if (isExitCode(error, 1)) return false;
    throw error;
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 4 * 1024 * 1024
  });
  return stdout.trim();
}

async function gitOptional(cwd: string, args: string[]): Promise<string | null> {
  try {
    return (await git(cwd, args)) || null;
  } catch {
    return null;
  }
}

function lines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isExitCode(error: unknown, code: number): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string") {
    return error.stderr.trim() || String(error);
  }
  return error instanceof Error ? error.message : String(error);
}
