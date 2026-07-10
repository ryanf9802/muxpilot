import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { codexReviewArgs, gitReviewDiffArgs, parseStructuredReview } from "../src/services/gitWorkspaceManager.js";
import { muxpilotGitWorkflowSkillStatus, syncMuxpilotGitWorkflowSkill } from "../src/services/bundledSkills.js";
import { AppDatabase } from "../src/db/database.js";
import { GitWorkspaceManager } from "../src/services/gitWorkspaceManager.js";
import { GitWorkspaceCoordinator } from "@muxpilot/git-workspaces";

const execFileAsync = promisify(execFile);

describe("codexReviewArgs", () => {
  it("materializes the exact target-to-HEAD patch directly to disk without buffering its size", () => {
    expect(gitReviewDiffArgs("a".repeat(40), "/tmp/changes.patch")).toEqual([
      "diff",
      "--binary",
      "--output=/tmp/changes.patch",
      "a".repeat(40),
      "HEAD",
      "--"
    ]);
  });

  it("runs a separate ephemeral read-only review with the materialized patch prompt", () => {
    expect(codexReviewArgs("/tmp/session-worktree", "Review the exact patch at /tmp/changes.patch.", "/tmp/schema.json", "/tmp/result.json")).toEqual([
      "-C",
      "/tmp/session-worktree",
      "-s",
      "read-only",
      "-a",
      "never",
      "exec",
      "--ephemeral",
      "--output-schema",
      "/tmp/schema.json",
      "--output-last-message",
      "/tmp/result.json",
      "Review the exact patch at /tmp/changes.patch."
    ]);
  });

  it("accepts zero-finding passes and actionable review findings", () => {
    expect(parseStructuredReview(JSON.stringify({ verdict: "pass", summary: "Clean", findings: [] }))).toEqual({
      verdict: "pass", summary: "Clean", findings: []
    });
    expect(parseStructuredReview(JSON.stringify({
      verdict: "changes_requested",
      summary: "Fix this",
      findings: [{ title: "Bug", body: "Incorrect edge case", path: "src/a.ts", line: 12 }]
    }))).toMatchObject({ verdict: "changes_requested", findings: [{ path: "src/a.ts", line: 12 }] });
  });
});

describe("syncMuxpilotGitWorkflowSkill", () => {
  it("detects, installs, and updates the bundled skill in CODEX_HOME", async () => {
    const home = await mkdtemp(join(tmpdir(), "muxpilot-codex-home-"));
    expect(await muxpilotGitWorkflowSkillStatus(home)).toMatchObject({ status: "missing" });

    const installed = await syncMuxpilotGitWorkflowSkill(home);
    expect(installed.status).toBe("current");
    expect(installed.action).toBe("installed");
    const skill = await readFile(join(installed.path, "SKILL.md"), "utf8");
    expect(skill).toContain("name: muxpilot-git-workflow");
    expect(skill).toContain("coordination tool, not a boundary");
    expect(skill).toContain("Never use the session worktree's state to claim that another checkout is clean or dirty");
    expect(skill).toContain("use the normal approval or escalation path instead of refusing it as out of scope");

    await writeFile(join(installed.path, "SKILL.md"), "modified");
    expect(await muxpilotGitWorkflowSkillStatus(home)).toMatchObject({ status: "outdated" });
    expect(await syncMuxpilotGitWorkflowSkill(home)).toMatchObject({ status: "current", action: "updated" });
    expect(await syncMuxpilotGitWorkflowSkill(home)).toMatchObject({ status: "current", action: "unchanged" });
  });

  it("preserves extra user files while updating the bundled skill", async () => {
    const home = await mkdtemp(join(tmpdir(), "muxpilot-codex-home-"));
    const installed = await syncMuxpilotGitWorkflowSkill(home);
    const extraFile = join(installed.path, "notes", "local.txt");
    await mkdir(join(installed.path, "notes"), { recursive: true });
    await writeFile(extraFile, "keep me");
    await writeFile(join(installed.path, "SKILL.md"), "outdated");

    expect(await syncMuxpilotGitWorkflowSkill(home)).toMatchObject({ status: "current", action: "updated" });
    expect(await readFile(extraFile, "utf8")).toBe("keep me");
  });
});

describe("agent finalization", () => {
  it("returns findings, then integrates and rotates after a clean review", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-finalize-"));
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.name", "Muxpilot Test"]);
    await git(root, ["config", "user.email", "muxpilot@example.invalid"]);
    await writeFile(join(root, "base.txt"), "base\n");
    await git(root, ["add", "base.txt"]);
    await git(root, ["commit", "-qm", "base"]);
    await git(root, ["branch", "target"]);
    const db = new AppDatabase(join(root, "state.sqlite"));
    let pass = false;
    const manager = new GitWorkspaceManager(db, new GitWorkspaceCoordinator(), {
      worktreeRoot: join(root, "worktrees"),
      inspectionRoot: join(root, "inspections"),
      integrationRoot: join(root, "integrations"),
      reviewRunner: async () => pass
        ? { verdict: "pass", summary: "No fixes necessary", findings: [] }
        : { verdict: "changes_requested", summary: "Fix the edge case", findings: [{ title: "Edge case", body: "Add the missing guard", path: "feature.txt", line: 1 }] }
    });
    const workspace = await manager.provision({ entryPath: root, targetBranch: "target" });
    await writeFile(join(workspace.summary.worktreePath, "feature.txt"), "first\n");
    await git(workspace.summary.worktreePath, ["add", "feature.txt"]);
    await git(workspace.summary.worktreePath, ["commit", "-qm", "feature"]);

    const requested = await manager.finalizeWithToken(workspace.id, workspace.helperToken);
    expect(requested).toMatchObject({ status: "changes_requested", findings: [{ title: "Edge case" }] });
    expect(await git(root, ["rev-parse", "target"])).not.toBe(await git(workspace.summary.worktreePath, ["rev-parse", "HEAD"]));

    await writeFile(join(workspace.summary.worktreePath, "feature.txt"), "fixed\n");
    await git(workspace.summary.worktreePath, ["add", "feature.txt"]);
    await git(workspace.summary.worktreePath, ["commit", "-qm", "fix review"]);
    const completedHead = await git(workspace.summary.worktreePath, ["rev-parse", "HEAD"]);
    pass = true;
    const integrated = await manager.finalizeWithToken(workspace.id, workspace.helperToken);

    expect(integrated).toMatchObject({ status: "integrated", generation: 2 });
    expect(await git(root, ["rev-parse", "target"])).not.toBe(completedHead);
    expect(await git(root, ["rev-parse", workspace.targetRef!])).toBe(completedHead);
    expect(await git(workspace.summary.worktreePath, ["branch", "--show-current"])).toContain("/g2");
    expect(await git(workspace.summary.worktreePath, ["status", "--porcelain"])).toBe("");
    await expect(git(root, ["rev-parse", `${workspace.summary.sessionBranch}^{commit}`])).rejects.toBeTruthy();
    await db.close();
  });

  it("recovers a legacy workspace into a managed target ref without moving its local target", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-legacy-target-"));
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.name", "Muxpilot Test"]);
    await git(root, ["config", "user.email", "muxpilot@example.invalid"]);
    await writeFile(join(root, "base.txt"), "base\n");
    await git(root, ["add", "base.txt"]);
    await git(root, ["commit", "-qm", "base"]);
    await git(root, ["branch", "target"]);
    const localTarget = await git(root, ["rev-parse", "refs/heads/target"]);
    const db = new AppDatabase(join(root, "state.sqlite"));
    const coordinator = new GitWorkspaceCoordinator();
    const manager = new GitWorkspaceManager(db, coordinator, {
      worktreeRoot: join(root, "worktrees"),
      inspectionRoot: join(root, "inspections"),
      integrationRoot: join(root, "integrations")
    });
    const workspace = await manager.provision({ entryPath: root, targetBranch: "target" });
    await git(root, ["update-ref", "-d", workspace.targetRef!]);
    const legacy = { ...workspace };
    delete legacy.targetRef;
    await db.upsertGitWorkspace(legacy, legacy.updatedAt);

    await manager.recover();
    const recovered = await manager.get(workspace.id);
    expect(recovered?.targetRef).toBe(workspace.targetRef);
    expect(await git(root, ["rev-parse", workspace.targetRef!])).toBe(localTarget);
    expect(await git(root, ["rev-parse", "refs/heads/target"])).toBe(localTarget);
    await db.close();
  });
});

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}
