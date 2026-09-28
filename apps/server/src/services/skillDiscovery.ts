import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { AgentSkill } from "@muxpilot/core";
import { workspaceSkillRootCandidates } from "./workspaceSkillRoots.js";

interface PluginManifest {
  name?: unknown;
  skills?: unknown;
}

interface ParsedSkillFrontmatter {
  name: string | null;
  description: string;
}

const SKILL_FILENAME = "SKILL.md";

/** Where one provider looks for skills. Earlier sources win when names collide. */
export interface SkillDiscoverySources {
  /** User skill directories (`SKILL.md` trees); a `.system/` subtree is reported as system skills. */
  homeSkillRoots: string[];
  /** Directories searched for plugin manifests. */
  pluginSearchRoots: string[];
  /** Manifest path relative to a plugin root, e.g. `.codex-plugin/plugin.json`. */
  pluginManifestPath: string;
  /** Repository-relative skill directories searched from each workspace root upwards. */
  workspaceSkillDirs: readonly string[];
}

export const CODEX_WORKSPACE_SKILL_DIRS = [join(".agents", "skills"), join(".codex", "skills")] as const;

export function codexSkillSources(codexHome: string): SkillDiscoverySources {
  const home = resolve(codexHome);
  return {
    homeSkillRoots: [join(home, "skills")],
    pluginSearchRoots: [join(home, "plugins", "cache")],
    pluginManifestPath: join(".codex-plugin", "plugin.json"),
    workspaceSkillDirs: CODEX_WORKSPACE_SKILL_DIRS
  };
}

export async function discoverCodexSkills(codexHome: string, workspaceRoots: string[] = []): Promise<AgentSkill[]> {
  return discoverSkills(codexSkillSources(codexHome), workspaceRoots);
}

export async function discoverSkills(sources: SkillDiscoverySources, workspaceRoots: string[] = []): Promise<AgentSkill[]> {
  const [workspaceSkills, localSkills, pluginSkills] = await Promise.all([
    discoverWorkspaceSkills(workspaceRoots, sources.workspaceSkillDirs),
    Promise.all(sources.homeSkillRoots.map(discoverLocalSkills)).then((groups) => groups.flat()),
    Promise.all(sources.pluginSearchRoots.map((root) => discoverPluginSkills(root, sources.pluginManifestPath)))
      .then((groups) => groups.flat())
  ]);
  return dedupeAndSortSkills([...workspaceSkills, ...localSkills, ...pluginSkills]);
}

async function discoverLocalSkills(skillsRoot: string): Promise<AgentSkill[]> {
  const skillFiles = await findSkillFiles(skillsRoot, 4);
  const skills: (AgentSkill | null)[] = await Promise.all(
    skillFiles.map(async (path) => {
      const parsed = await parseSkillFile(path);
      const name = parsed.name ?? basename(dirname(path));
      if (!name) return null;
      return {
        name,
        description: parsed.description,
        source: path.includes(`${skillsRoot}/.system/`) ? "system" : "user"
      } satisfies AgentSkill;
    })
  );
  return skills.filter((skill): skill is AgentSkill => Boolean(skill));
}

async function discoverWorkspaceSkills(workspaceRoots: string[], skillDirs: readonly string[]): Promise<AgentSkill[]> {
  const roots = workspaceSkillRootCandidates(workspaceRoots, skillDirs);
  const groups = await Promise.all(roots.map((root) => discoverSkillsInRoot(root, "workspace")));
  return groups.flat();
}

async function discoverSkillsInRoot(skillsRoot: string, source: AgentSkill["source"]): Promise<AgentSkill[]> {
  const skillFiles = await findSkillFiles(skillsRoot, 4);
  const skills: (AgentSkill | null)[] = await Promise.all(
    skillFiles.map(async (path) => {
      const parsed = await parseSkillFile(path);
      const name = parsed.name ?? basename(dirname(path));
      if (!name) return null;
      return {
        name,
        description: parsed.description,
        source
      } satisfies AgentSkill;
    })
  );
  return skills.filter((skill): skill is AgentSkill => Boolean(skill));
}

async function discoverPluginSkills(pluginCacheRoot: string, manifestPath: string): Promise<AgentSkill[]> {
  const manifests = await findFiles(pluginCacheRoot, manifestPath, 7);
  const groups = await Promise.all(manifests.map(discoverPluginManifestSkills));
  return groups.flat();
}

async function discoverPluginManifestSkills(manifestPath: string): Promise<AgentSkill[]> {
  const manifest = await readPluginManifest(manifestPath);
  const pluginName = typeof manifest.name === "string" ? manifest.name.trim() : "";
  if (!pluginName) return [];

  const pluginRoot = dirname(dirname(manifestPath));
  const skillsValue = typeof manifest.skills === "string" ? manifest.skills : "./skills/";
  const skillsRoot = resolve(pluginRoot, skillsValue);
  const skillFiles = await findSkillFiles(skillsRoot, 3);
  const skills: (AgentSkill | null)[] = await Promise.all(
    skillFiles.map(async (path) => {
      const parsed = await parseSkillFile(path);
      const localName = parsed.name ?? basename(dirname(path));
      if (!localName) return null;
      return {
        name: `${pluginName}:${localName}`,
        description: parsed.description,
        source: "plugin",
        pluginName
      } satisfies AgentSkill;
    })
  );
  return skills.filter((skill): skill is AgentSkill => Boolean(skill));
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

function dedupeAndSortSkills(skills: AgentSkill[]): AgentSkill[] {
  const byName = new Map<string, AgentSkill>();
  for (const skill of skills) {
    if (!skill.name || byName.has(skill.name)) continue;
    byName.set(skill.name, skill);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
