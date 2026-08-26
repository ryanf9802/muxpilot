import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resourceGovernorSessionScopeLines, syncBundledSkillForMode } from "../../../scripts/lifecycle.mjs";

describe("production bundled skill startup", () => {
  it("does not synchronize the skill in development mode", async () => {
    const home = await mkdtemp(join(tmpdir(), "muxpilot-dev-codex-home-"));

    expect(await syncBundledSkillForMode("dev", home)).toBeNull();
    await expect(access(join(home, "skills", "muxpilot-git-workflow", "SKILL.md"))).rejects.toThrow();
    await expect(access(join(home, "skills", "muxpilot-heavy-command-queue", "SKILL.md"))).rejects.toThrow();
    await expect(access(join(home, "skills", "muxpilot-session-orchestration", "SKILL.md"))).rejects.toThrow();
    await expect(access(join(home, "skills", "muxpilot-documents", "SKILL.md"))).rejects.toThrow();
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
      await expect(access(join(home, "skills", "muxpilot-git-workflow", "scripts", "muxpilot-git-init.mjs"))).resolves.toBeUndefined();
      const installedQueueSkill = await readFile(join(home, "skills", "muxpilot-heavy-command-queue", "SKILL.md"), "utf8");
      expect(installedQueueSkill).toContain("QUEUED_NOT_RUN");
      expect(installedQueueSkill).toContain("run_completed");
      expect(installedQueueSkill).toContain("treat its delivery as proof that muxpilot ended the deferred phase");
      const installedOrchestrationSkill = await readFile(join(home, "skills", "muxpilot-session-orchestration", "SKILL.md"), "utf8");
      expect(installedOrchestrationSkill).toContain("event-driven wait");
      expect(installedOrchestrationSkill).toContain("Approval decisions remain with the operator");
      expect(installedOrchestrationSkill).toContain("Use built-in Codex subagents for routine bounded delegation");
      expect(installedOrchestrationSkill).toContain("Do not create a nested muxpilot session merely to run a review in parallel");
      expect(installedOrchestrationSkill).toContain("only when the operator explicitly requests a nested muxpilot session");
      expect(installedOrchestrationSkill).toContain("Every agent-created muxpilot child session has its own private `$MUXPILOT_DOCUMENTS_DIR`");
      expect(installedOrchestrationSkill).toContain("returns a structured handoff");
      expect(installedOrchestrationSkill).toContain("Built-in Codex subagents are not muxpilot child sessions");
      const installedDocumentsSkill = await readFile(join(home, "skills", "muxpilot-documents", "SKILL.md"), "utf8");
      expect(installedDocumentsSkill).toContain("MUXPILOT_DOCUMENTS_DIR");
      expect(installedDocumentsSkill).toContain("Read `INDEX.md` first");
      expect(installedDocumentsSkill).toContain("The session working directory is not the documents directory");
      expect(installedDocumentsSkill).toContain("Never attempt a cross-session document write");
      expect(installedDocumentsSkill).toContain("The muxpilot BTW flow is a controlled exception");

      await writeFile(join(home, "skills", "muxpilot-heavy-command-queue", "SKILL.md"), "outdated");
      expect(await syncBundledSkillForMode("prod", home)).toMatchObject({ status: "current", action: "updated" });
      await writeFile(join(home, "skills", "muxpilot-documents", "SKILL.md"), "outdated");
      expect(await syncBundledSkillForMode("prod", home)).toMatchObject({ status: "current", action: "updated" });
      const restoredDocumentsSkill = await readFile(join(home, "skills", "muxpilot-documents", "SKILL.md"), "utf8");
      expect(restoredDocumentsSkill).toContain("name: muxpilot-documents");
      expect(restoredDocumentsSkill).toContain("Built-in Codex subagents share the current session environment");
    } finally {
      log.mockRestore();
    }
  });
});

describe("resource governor lifecycle status", () => {
  it("reports effective scope availability and the linger remediation", () => {
    expect(resourceGovernorSessionScopeLines({
      enabled: true,
      managedSessions: 2,
      unmanagedSessions: 3
    })).toEqual(["session scopes: active, 2 managed, 3 legacy/unscoped"]);
    expect(resourceGovernorSessionScopeLines({
      enabled: false,
      unavailableReason: "user_systemd_unavailable"
    })).toEqual(["session scopes: unavailable; run sudo loginctl enable-linger \"$USER\", then restart muxpilot"]);
  });
});
