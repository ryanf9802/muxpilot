import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexReviewArgs } from "../src/services/gitWorkspaceManager.js";
import { installMuxpilotGitWorkflowSkill, muxpilotGitWorkflowSkillStatus } from "../src/services/bundledSkills.js";

describe("codexReviewArgs", () => {
  it("runs a separate ephemeral read-only review against the exact target SHA", () => {
    expect(codexReviewArgs("/tmp/session-worktree", "a".repeat(40), "Review committed changes.")).toEqual([
      "-C",
      "/tmp/session-worktree",
      "-s",
      "read-only",
      "-a",
      "never",
      "exec",
      "--ephemeral",
      "review",
      "--base",
      "a".repeat(40),
      "Review committed changes."
    ]);
  });
});

describe("installMuxpilotGitWorkflowSkill", () => {
  it("detects, installs, and updates the bundled skill in CODEX_HOME", async () => {
    const home = await mkdtemp(join(tmpdir(), "muxpilot-codex-home-"));
    expect(await muxpilotGitWorkflowSkillStatus(home)).toMatchObject({ status: "missing" });

    const installed = await installMuxpilotGitWorkflowSkill(home);
    expect(installed.status).toBe("current");
    expect(await readFile(join(installed.path, "SKILL.md"), "utf8")).toContain("name: muxpilot-git-workflow");

    await writeFile(join(installed.path, "SKILL.md"), "modified");
    expect(await muxpilotGitWorkflowSkillStatus(home)).toMatchObject({ status: "outdated" });
    expect((await installMuxpilotGitWorkflowSkill(home)).status).toBe("current");
  });

  it("ignores extra user files when checking bundled skill freshness", async () => {
    const home = await mkdtemp(join(tmpdir(), "muxpilot-codex-home-"));
    const installed = await installMuxpilotGitWorkflowSkill(home);
    await mkdir(join(installed.path, "notes"), { recursive: true });
    await writeFile(join(installed.path, "notes", "local.txt"), "keep me");

    expect(await muxpilotGitWorkflowSkillStatus(home)).toMatchObject({ status: "current" });
  });
});
