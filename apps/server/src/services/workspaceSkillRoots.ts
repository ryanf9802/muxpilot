import { createHash } from "node:crypto";
import { mkdir, readlink, readdir, stat, symlink, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const MANAGED_LINK_PREFIX = "muxpilot-repo-skills-";
const SKILL_ROOT_RELATIVE_PATHS = [join(".agents", "skills"), join(".codex", "skills")] as const;

export function workspaceSkillRootCandidates(paths: string[], maxAncestorDepth = 4): string[] {
  const candidates: string[] = [];
  for (const path of uniqueResolvedPaths(paths)) {
    let current = path;
    for (let depth = 0; depth <= maxAncestorDepth; depth += 1) {
      for (const skillRoot of SKILL_ROOT_RELATIVE_PATHS) candidates.push(join(current, skillRoot));
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return uniqueResolvedPaths(candidates);
}

export async function exposeWorkspaceSkillsInControl(
  controlPath: string,
  entryPath: string,
  repoRoot: string
): Promise<void> {
  const sourceRoots = await existingRepositorySkillRoots(entryPath, repoRoot);
  const destinationRoot = join(controlPath, ".agents", "skills");
  if (sourceRoots.length === 0 && !(await isDirectory(destinationRoot))) return;

  await mkdir(destinationRoot, { recursive: true });
  // Link complete roots so sibling shared instructions, scripts, and assets
  // retain their repository-relative layout when Codex follows the link.
  const desiredLinks = new Map(sourceRoots.map((sourceRoot) => [
    `${MANAGED_LINK_PREFIX}${shortPathHash(sourceRoot)}`,
    sourceRoot
  ]));

  for (const entry of await readdir(destinationRoot, { withFileTypes: true })) {
    if (!entry.name.startsWith(MANAGED_LINK_PREFIX)) continue;
    const linkPath = join(destinationRoot, entry.name);
    if (!entry.isSymbolicLink()) {
      if (desiredLinks.has(entry.name)) {
        throw new Error(`Reserved workspace skill path is not a symbolic link: ${linkPath}`);
      }
      continue;
    }
    const desiredTarget = desiredLinks.get(entry.name);
    if (desiredTarget && resolve(destinationRoot, await readlink(linkPath)) === desiredTarget) {
      desiredLinks.delete(entry.name);
      continue;
    }
    await unlink(linkPath);
  }

  await Promise.all([...desiredLinks].map(([name, sourceRoot]) =>
    symlink(sourceRoot, join(destinationRoot, name), "dir")
  ));
}

async function existingRepositorySkillRoots(entryPath: string, repoRoot: string): Promise<string[]> {
  const entry = resolve(entryPath);
  const root = resolve(repoRoot);
  const entryRelativeToRoot = relative(root, entry);
  if (entryRelativeToRoot === ".." || entryRelativeToRoot.startsWith(`..${sep}`) || isAbsolute(entryRelativeToRoot)) {
    throw new Error(`Repository entry path is outside its Git root: ${entry}`);
  }

  const candidates: string[] = [];
  let current = entry;
  while (true) {
    for (const skillRoot of SKILL_ROOT_RELATIVE_PATHS) {
      const candidate = join(current, skillRoot);
      if (await isDirectory(candidate)) candidates.push(candidate);
    }
    if (current === root) break;
    current = dirname(current);
  }
  return uniqueResolvedPaths(candidates);
}

function uniqueResolvedPaths(paths: string[]): string[] {
  return [...new Set(paths.filter(Boolean).map((path) => resolve(path)))];
}

function shortPathHash(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 12);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
