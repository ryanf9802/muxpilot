import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { CodexSkill } from "@muxpilot/core";

interface PluginManifest {
  name?: unknown;
  skills?: unknown;
}

interface ParsedSkillFrontmatter {
  name: string | null;
  description: string;
}

const SKILL_FILENAME = "SKILL.md";

export async function discoverCodexSkills(codexHome: string, workspaceRoots: string[] = []): Promise<CodexSkill[]> {
  const home = resolve(codexHome);
  const [workspaceSkills, localSkills, pluginSkills] = await Promise.all([
    discoverWorkspaceSkills(workspaceRoots),
    discoverLocalSkills(join(home, "skills")),
    discoverPluginSkills(join(home, "plugins", "cache"))
  ]);
  return dedupeAndSortSkills([...workspaceSkills, ...localSkills, ...pluginSkills]);
}

async function discoverLocalSkills(skillsRoot: string): Promise<CodexSkill[]> {
  const skillFiles = await findSkillFiles(skillsRoot, 4);
  const skills: (CodexSkill | null)[] = await Promise.all(
    skillFiles.map(async (path) => {
      const parsed = await parseSkillFile(path);
      const name = parsed.name ?? basename(dirname(path));
      if (!name) return null;
      return {
        name,
        description: parsed.description,
        source: path.includes(`${skillsRoot}/.system/`) ? "system" : "user"
      } satisfies CodexSkill;
    })
  );
  return skills.filter((skill): skill is CodexSkill => Boolean(skill));
}

async function discoverWorkspaceSkills(workspaceRoots: string[]): Promise<CodexSkill[]> {
  const roots = workspaceSkillRootCandidates(workspaceRoots);
  const groups = await Promise.all(roots.map((root) => discoverSkillsInRoot(join(root, ".codex", "skills"), "workspace")));
  return groups.flat();
}

async function discoverSkillsInRoot(skillsRoot: string, source: CodexSkill["source"]): Promise<CodexSkill[]> {
  const skillFiles = await findSkillFiles(skillsRoot, 4);
  const skills: (CodexSkill | null)[] = await Promise.all(
    skillFiles.map(async (path) => {
      const parsed = await parseSkillFile(path);
      const name = parsed.name ?? basename(dirname(path));
      if (!name) return null;
      return {
        name,
        description: parsed.description,
        source
      } satisfies CodexSkill;
    })
  );
  return skills.filter((skill): skill is CodexSkill => Boolean(skill));
}

async function discoverPluginSkills(pluginCacheRoot: string): Promise<CodexSkill[]> {
  const manifests = await findFiles(pluginCacheRoot, ".codex-plugin/plugin.json", 7);
  const groups = await Promise.all(manifests.map(discoverPluginManifestSkills));
  return groups.flat();
}

async function discoverPluginManifestSkills(manifestPath: string): Promise<CodexSkill[]> {
  const manifest = await readPluginManifest(manifestPath);
  const pluginName = typeof manifest.name === "string" ? manifest.name.trim() : "";
  if (!pluginName) return [];

  const pluginRoot = dirname(dirname(manifestPath));
  const skillsValue = typeof manifest.skills === "string" ? manifest.skills : "./skills/";
  const skillsRoot = resolve(pluginRoot, skillsValue);
  const skillFiles = await findSkillFiles(skillsRoot, 3);
  const skills: (CodexSkill | null)[] = await Promise.all(
    skillFiles.map(async (path) => {
      const parsed = await parseSkillFile(path);
      const localName = parsed.name ?? basename(dirname(path));
      if (!localName) return null;
      return {
        name: `${pluginName}:${localName}`,
        description: parsed.description,
        source: "plugin",
        pluginName
      } satisfies CodexSkill;
    })
  );
  return skills.filter((skill): skill is CodexSkill => Boolean(skill));
}

async function readPluginManifest(path: string): Promise<PluginManifest> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as PluginManifest;
  } catch {
    return {};
  }
}

async function parseSkillFile(path: string): Promise<ParsedSkillFrontmatter> {
  try {
    return parseSkillFrontmatter(await readFile(path, "utf8"));
  } catch {
    return { name: null, description: "" };
  }
}

export function parseSkillFrontmatter(content: string): ParsedSkillFrontmatter {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match?.[1]) return { name: null, description: "" };
  return {
    name: frontmatterScalar(match[1], "name"),
    description: frontmatterScalar(match[1], "description") ?? ""
  };
}

function frontmatterScalar(frontmatter: string, key: string): string | null {
  const lines = frontmatter.split(/\r?\n/);
  const keyPattern = new RegExp(`^${key}:\\s*(.*)$`, "i");
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]?.match(keyPattern);
    if (!match) continue;
    const parts = [match[1]?.trim() ?? ""];
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next] ?? "";
      if (/^[A-Za-z0-9_-]+:\s*/.test(line)) break;
      if (!/^\s+\S/.test(line)) break;
      parts.push(line.trim());
    }
    return unquote(parts.join(" ").trim());
  }
  return null;
}

function unquote(value: string): string {
  const quoted = value.match(/^["']([\s\S]*)["']$/);
  return (quoted?.[1] ?? value).trim();
}

async function findSkillFiles(root: string, maxDepth: number): Promise<string[]> {
  return findFiles(root, SKILL_FILENAME, maxDepth);
}

async function findFiles(root: string, targetSuffix: string, maxDepth: number): Promise<string[]> {
  if (!existsSync(root)) return [];
  const results: string[] = [];
  await walk(root, 0);
  return results;

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(path, depth + 1);
          return;
        }
        if (entry.isFile() && path.endsWith(targetSuffix)) results.push(path);
      })
    );
  }
}

function dedupeAndSortSkills(skills: CodexSkill[]): CodexSkill[] {
  const byName = new Map<string, CodexSkill>();
  for (const skill of skills) {
    if (!skill.name || byName.has(skill.name)) continue;
    byName.set(skill.name, skill);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function uniqueResolvedPaths(paths: string[]): string[] {
  return [...new Set(paths.filter(Boolean).map((path) => resolve(path)))];
}

function workspaceSkillRootCandidates(paths: string[]): string[] {
  const candidates: string[] = [];
  for (const path of uniqueResolvedPaths(paths)) {
    let current = path;
    for (let depth = 0; depth < 5; depth += 1) {
      candidates.push(current);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return uniqueResolvedPaths(candidates);
}
