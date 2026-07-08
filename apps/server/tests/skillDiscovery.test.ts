import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverCodexSkills, parseSkillFrontmatter } from "../src/services/skillDiscovery.js";

describe("discoverCodexSkills", () => {
  it("discovers local, system, and plugin skills with Codex-visible names", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "muxpilot-skills-"));
    await writeSkill(codexHome, "skills/teamweave-browser/SKILL.md", "teamweave-browser", "Operate TeamWeave UI");
    await writeSkill(codexHome, "skills/.system/openai-docs/SKILL.md", "openai-docs", "Use OpenAI docs");
    await writePlugin(codexHome, "github", "0.1.7-test", "yeet", "Publish local changes");

    const skills = await discoverCodexSkills(codexHome);

    expect(skills).toEqual([
      expect.objectContaining({ name: "github:yeet", description: "Publish local changes", source: "plugin", pluginName: "github" }),
      expect.objectContaining({ name: "openai-docs", description: "Use OpenAI docs", source: "system" }),
      expect.objectContaining({ name: "teamweave-browser", description: "Operate TeamWeave UI", source: "user" })
    ]);
  });

  it("falls back to folder names when frontmatter names are missing", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "muxpilot-skills-"));
    const path = join(codexHome, "skills", "fallback-skill", "SKILL.md");
    await mkdir(join(codexHome, "skills", "fallback-skill"), { recursive: true });
    await writeFile(path, "# Fallback Skill\n");

    await expect(discoverCodexSkills(codexHome)).resolves.toEqual([
      expect.objectContaining({ name: "fallback-skill", description: "", source: "user" })
    ]);
  });

  it("discovers workspace skills from repo-local .codex skills", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "muxpilot-skills-"));
    const workspace = await mkdtemp(join(tmpdir(), "muxpilot-workspace-"));
    await writeSkill(workspace, ".codex/skills/repo-helper/SKILL.md", "repo-helper", "Help with this repository");

    await expect(discoverCodexSkills(codexHome, [workspace])).resolves.toEqual([
      expect.objectContaining({ name: "repo-helper", description: "Help with this repository", source: "workspace" })
    ]);
  });

  it("discovers workspace skills when only a nested cwd is available", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "muxpilot-skills-"));
    const workspace = await mkdtemp(join(tmpdir(), "muxpilot-workspace-"));
    const nestedCwd = join(workspace, "teamweave", "api");
    await mkdir(nestedCwd, { recursive: true });
    await writeSkill(workspace, ".codex/skills/tw-worktree-agent/SKILL.md", "tw-worktree-agent", "Manage TeamWeave worktrees");

    await expect(discoverCodexSkills(codexHome, [nestedCwd])).resolves.toEqual([
      expect.objectContaining({ name: "tw-worktree-agent", description: "Manage TeamWeave worktrees", source: "workspace" })
    ]);
  });
});

describe("parseSkillFrontmatter", () => {
  it("parses quoted scalar metadata", () => {
    expect(
      parseSkillFrontmatter(['---', 'name: "yeet"', 'description: "Publish local changes"', '---', "# GitHub"].join("\n"))
    ).toEqual({ name: "yeet", description: "Publish local changes" });
  });

  it("parses indented multiline descriptions", () => {
    expect(
      parseSkillFrontmatter(
        ["---", "name: teamweave-browser", "description: Operate TeamWeave UI with Playwright, especially projects/resources and", "  View & Filters workflows.", "---"].join(
          "\n"
        )
      )
    ).toEqual({
      name: "teamweave-browser",
      description: "Operate TeamWeave UI with Playwright, especially projects/resources and View & Filters workflows."
    });
  });
});

async function writeSkill(codexHome: string, relativePath: string, name: string, description: string): Promise<void> {
  const path = join(codexHome, relativePath);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, ["---", `name: ${name}`, `description: ${description}`, "---", "", `# ${name}`].join("\n"));
}

async function writePlugin(codexHome: string, pluginName: string, version: string, skillName: string, description: string): Promise<void> {
  const pluginRoot = join(codexHome, "plugins", "cache", "openai-curated-remote", pluginName, version);
  await mkdir(join(pluginRoot, ".codex-plugin"), { recursive: true });
  await writeFile(join(pluginRoot, ".codex-plugin", "plugin.json"), JSON.stringify({ name: pluginName, skills: "./skills/" }));
  await writeSkill(pluginRoot, `skills/${skillName}/SKILL.md`, skillName, description);
}
