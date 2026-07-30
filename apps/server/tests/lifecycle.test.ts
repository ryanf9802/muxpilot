import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { syncBundledSkillForMode } from "../../../scripts/lifecycle.mjs";

describe("production bundled skill startup", () => {
  it("does not synchronize the skill in development mode", async () => {
    const home = await mkdtemp(join(tmpdir(), "muxpilot-dev-codex-home-"));

    expect(await syncBundledSkillForMode("dev", home)).toBeNull();
    await expect(access(join(home, "skills", "muxpilot-git-workflow", "SKILL.md"))).rejects.toThrow();
  });

  it("installs and updates the skill during production startup", async () => {
    const home = await mkdtemp(join(tmpdir(), "muxpilot-prod-codex-home-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(await syncBundledSkillForMode("prod", home)).toMatchObject({ status: "current", action: "installed" });
      const skillPath = join(home, "skills", "muxpilot-git-workflow", "SKILL.md");
      await writeFile(skillPath, "outdated");

      expect(await syncBundledSkillForMode("prod", home)).toMatchObject({ status: "current", action: "updated" });
      const installedSkill = await readFile(skillPath, "utf8");
      expect(installedSkill).toContain("name: muxpilot-git-workflow");
      expect(installedSkill).toContain("create or select a local branch for implementation");
      expect(installedSkill).toContain("`feature` is the intended target and `origin/dev` is only its start point");
      expect(installedSkill).toContain("Before creating the requested branch or beginning implementation");
      expect(installedSkill).toContain("explicitly requests a PR-style review of a branch or ref");
      expect(installedSkill).toContain("muxpilot-git-run.mjs");
      expect(installedSkill).toContain("Treat a command as heavyweight when any of these conditions applies");
      expect(installedSkill).toContain("When uncertain, use the heavyweight wrapper");
      expect(installedSkill).toContain("does not authorize repository-wide validation");
      await expect(access(join(home, "skills", "muxpilot-git-workflow", "scripts", "muxpilot-git-run.mjs"))).resolves.toBeUndefined();
    } finally {
      log.mockRestore();
    }
  });
});
