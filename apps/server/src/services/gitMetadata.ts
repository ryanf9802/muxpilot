import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import type { RepoMetadata } from "@muxpilot/core";

const execFileAsync = promisify(execFile);

export async function loadRepoMetadata(cwd: string): Promise<RepoMetadata> {
  const fallback = {
    root: null,
    name: basename(cwd),
    branch: null,
    dirty: false,
    worktree: null
  };

  try {
    const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
    const branch = (await git(cwd, ["branch", "--show-current"])).trim() || null;
    const status = await git(cwd, ["status", "--porcelain"]);
    const worktree = (await git(cwd, ["rev-parse", "--git-dir"])).trim();
    return {
      root,
      name: basename(root),
      branch,
      dirty: status.trim().length > 0,
      worktree
    };
  } catch {
    return fallback;
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 1024 * 1024 });
  return stdout;
}
