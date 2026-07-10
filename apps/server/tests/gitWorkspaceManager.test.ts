import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { codexReviewArgs, gitReviewDiffArgs, parseStructuredReview, REVIEW_TIMEOUT_MS } from "../src/services/gitWorkspaceManager.js";
import { muxpilotGitWorkflowSkillStatus, syncMuxpilotGitWorkflowSkill } from "../src/services/bundledSkills.js";
import { AppDatabase } from "../src/db/database.js";
import { GitWorkspaceManager } from "../src/services/gitWorkspaceManager.js";
import { GitWorkspaceCoordinator } from "@muxpilot/git-workspaces";

const execFileAsync = promisify(execFile);

describe("codexReviewArgs", () => {
  it("hard caps each independent review at five minutes", () => {
    expect(REVIEW_TIMEOUT_MS).toBe(5 * 60_000);
  });

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

describe("muxpilot-git-finish", () => {
  it("halts on incomplete review and requires explicit approval before the override", async () => {
    const result = await runFinishHelper(
      { error: "Independent Codex review failed", code: "review_failed", detail: "timed out awaiting response headers" },
      409
    );

    expect(result.code).toBe(4);
    expect(result.stdout).toContain("REVIEW_INCOMPLETE");
    expect(result.stdout).toContain("timed out awaiting response headers");
    expect(result.stdout).toContain("Ask whether integration should proceed without successful review");
    expect(result.stdout).toContain("--integrate-without-review");
    expect(result.requestBody).toEqual({ allowUnreviewed: false });
  });

  it("sends and reports the explicit unreviewed integration override", async () => {
    const result = await runFinishHelper(
      { status: "integrated", targetSha: "a".repeat(40), generation: 2, reviewed: false },
      200,
      ["--integrate-without-review"]
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("review=bypassed");
    expect(result.requestBody).toEqual({ allowUnreviewed: true });
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
    expect(skill).toContain("Inspect every relevant checkout before describing its working-copy state");
    expect(skill).toContain("use the normal approval or escalation path instead of refusing it as out of scope");
    expect(skill).toContain("REVIEW_INCOMPLETE");
    expect(skill).toContain("--integrate-without-review");

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
  it("creates worktrees lazily and checkpoints dirty work when a session disappears", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-lazy-worktree-"));
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.name", "Muxpilot Test"]);
    await git(root, ["config", "user.email", "muxpilot@example.invalid"]);
    await writeFile(join(root, "base.txt"), "base\n");
    await git(root, ["add", "base.txt"]);
    await git(root, ["commit", "-qm", "base"]);
    await git(root, ["branch", "target"]);
    const db = new AppDatabase(join(root, "state.sqlite"));
    const manager = new GitWorkspaceManager(db, new GitWorkspaceCoordinator(), {
      worktreeRoot: join(root, "worktrees"),
      sessionRoot: join(root, "sessions"),
      inspectionRoot: join(root, "inspections"),
      integrationRoot: join(root, "integrations")
    });
    const workspace = await manager.provision({ sessionName: "lazy-change", entryPath: root, targetBranch: "target" });
    await manager.bind(workspace.id, "session-1");

    expect(workspace.summary).toMatchObject({ state: "idle", generation: 0, sessionBranch: null, worktreePath: null });
    expect(await git(root, ["worktree", "list", "--porcelain"])).not.toContain(workspace.implementationRoot!);
    const inspected = await manager.addInspectionWithToken(workspace.id, workspace.helperToken, { kind: "local_branch", branch: "target" });
    expect(inspected.inspections.at(-1)).toMatchObject({ worktreePath: null });
    expect(await git(root, ["worktree", "list", "--porcelain"])).not.toContain(workspace.implementationRoot!);

    const active = await manager.beginWithToken(workspace.id, workspace.helperToken);
    expect(active.worktreePath).toContain("lazy-change-");
    expect(active.sessionBranch).toMatch(/^muxpilot\/lazy-change-[0-9a-f]{8}\/g1$/);
    expect((await manager.beginWithToken(workspace.id, workspace.helperToken)).worktreePath).toBe(active.worktreePath);
    await writeFile(join(active.worktreePath!, "base.txt"), "unfinished\n");
    await writeFile(join(active.worktreePath!, "new.txt"), "new\n");

    const suspended = await manager.suspendBySession("session-1");
    expect(suspended).toMatchObject({ state: "suspended", worktreePath: null, dirty: true });
    expect(await git(root, ["worktree", "list", "--porcelain"])).not.toContain(active.worktreePath!);

    const restored = await manager.beginWithToken(workspace.id, workspace.helperToken);
    expect(await readFile(join(restored.worktreePath!, "base.txt"), "utf8")).toBe("unfinished\n");
    expect(await readFile(join(restored.worktreePath!, "new.txt"), "utf8")).toBe("new\n");
    expect(restored).toMatchObject({ state: "active", generation: 1, dirty: true });
    await db.close();
  });

  it("returns findings, then integrates and removes the worktree after a clean review", async () => {
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
      sessionRoot: join(root, "sessions"),
      inspectionRoot: join(root, "inspections"),
      integrationRoot: join(root, "integrations"),
      reviewRunner: async () => pass
        ? { verdict: "pass", summary: "No fixes necessary", findings: [] }
        : { verdict: "changes_requested", summary: "Fix the edge case", findings: [{ title: "Edge case", body: "Add the missing guard", path: "feature.txt", line: 1 }] }
    });
    const workspace = await manager.provision({ sessionName: "finalize", entryPath: root, targetBranch: "target" });
    const active = await manager.beginWithToken(workspace.id, workspace.helperToken);
    const worktreePath = active.worktreePath!;
    await writeFile(join(worktreePath, "feature.txt"), "first\n");
    await git(worktreePath, ["add", "feature.txt"]);
    await git(worktreePath, ["commit", "-qm", "feature"]);

    const requested = await manager.finalizeWithToken(workspace.id, workspace.helperToken);
    expect(requested).toMatchObject({ status: "changes_requested", findings: [{ title: "Edge case" }] });
    expect(await git(root, ["rev-parse", "target"])).not.toBe(await git(worktreePath, ["rev-parse", "HEAD"]));

    await writeFile(join(worktreePath, "feature.txt"), "fixed\n");
    await git(worktreePath, ["add", "feature.txt"]);
    await git(worktreePath, ["commit", "-qm", "fix review"]);
    const completedHead = await git(worktreePath, ["rev-parse", "HEAD"]);
    pass = true;
    const integrated = await manager.finalizeWithToken(workspace.id, workspace.helperToken);

    expect(integrated).toMatchObject({ status: "integrated", generation: 1, reviewed: true, workspace: { state: "idle", worktreePath: null, sessionBranch: null } });
    expect(await git(root, ["rev-parse", "target"])).not.toBe(completedHead);
    expect(await git(root, ["rev-parse", workspace.targetRef!])).toBe(completedHead);
    expect(await git(root, ["worktree", "list", "--porcelain"])).not.toContain(worktreePath);
    await expect(git(root, ["rev-parse", `${active.sessionBranch}^{commit}`])).rejects.toBeTruthy();
    await db.close();
  });

  it("integrates without review only after an exact-candidate review failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-review-bypass-"));
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.name", "Muxpilot Test"]);
    await git(root, ["config", "user.email", "muxpilot@example.invalid"]);
    await writeFile(join(root, "base.txt"), "base\n");
    await git(root, ["add", "base.txt"]);
    await git(root, ["commit", "-qm", "base"]);
    await git(root, ["branch", "target"]);
    const db = new AppDatabase(join(root, "state.sqlite"));
    const manager = new GitWorkspaceManager(db, new GitWorkspaceCoordinator(), {
      worktreeRoot: join(root, "worktrees"),
      sessionRoot: join(root, "sessions"),
      inspectionRoot: join(root, "inspections"),
      integrationRoot: join(root, "integrations"),
      reviewRunner: async () => {
        throw new Error("timed out awaiting response headers");
      }
    });
    const workspace = await manager.provision({ sessionName: "bypass", entryPath: root, targetBranch: "target" });
    const active = await manager.beginWithToken(workspace.id, workspace.helperToken);
    const worktreePath = active.worktreePath!;
    await writeFile(join(worktreePath, "feature.txt"), "feature\n");
    await git(worktreePath, ["add", "feature.txt"]);
    await git(worktreePath, ["commit", "-qm", "feature"]);
    const completedHead = await git(worktreePath, ["rev-parse", "HEAD"]);

    await expect(manager.finalizeWithToken(workspace.id, workspace.helperToken, { allowUnreviewed: true }))
      .rejects.toMatchObject({ code: "review_bypass_unavailable" });
    await expect(manager.finalizeWithToken(workspace.id, workspace.helperToken))
      .rejects.toMatchObject({ code: "review_failed", causeText: "timed out awaiting response headers" });
    expect(await git(root, ["rev-parse", workspace.targetRef!])).not.toBe(completedHead);

    const integrated = await manager.finalizeWithToken(workspace.id, workspace.helperToken, { allowUnreviewed: true });
    expect(integrated).toMatchObject({
      status: "integrated",
      reviewed: false,
      generation: 1,
      workspace: {
        lastCompletion: {
          reviewDisposition: "bypassed",
          reviewSummary: expect.stringContaining("timed out awaiting response headers")
        }
      }
    });
    expect(await git(root, ["rev-parse", workspace.targetRef!])).toBe(completedHead);
    await db.close();
  });

  it("rejects bypasses after findings or after the reviewed candidate changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-review-bypass-guard-"));
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.name", "Muxpilot Test"]);
    await git(root, ["config", "user.email", "muxpilot@example.invalid"]);
    await writeFile(join(root, "base.txt"), "base\n");
    await git(root, ["add", "base.txt"]);
    await git(root, ["commit", "-qm", "base"]);
    await git(root, ["branch", "target"]);
    const db = new AppDatabase(join(root, "state.sqlite"));
    let failReview = false;
    const manager = new GitWorkspaceManager(db, new GitWorkspaceCoordinator(), {
      worktreeRoot: join(root, "worktrees"),
      sessionRoot: join(root, "sessions"),
      inspectionRoot: join(root, "inspections"),
      integrationRoot: join(root, "integrations"),
      reviewRunner: async () => {
        if (failReview) throw new Error("review transport unavailable");
        return { verdict: "changes_requested", summary: "Fix it", findings: [{ title: "Bug", body: "Fix it", path: "feature.txt", line: 1 }] };
      }
    });
    const workspace = await manager.provision({ sessionName: "guard", entryPath: root, targetBranch: "target" });
    const active = await manager.beginWithToken(workspace.id, workspace.helperToken);
    const worktreePath = active.worktreePath!;
    await writeFile(join(worktreePath, "feature.txt"), "feature\n");
    await git(worktreePath, ["add", "feature.txt"]);
    await git(worktreePath, ["commit", "-qm", "feature"]);

    await expect(manager.finalizeWithToken(workspace.id, workspace.helperToken)).resolves.toMatchObject({ status: "changes_requested" });
    await expect(manager.finalizeWithToken(workspace.id, workspace.helperToken, { allowUnreviewed: true }))
      .rejects.toMatchObject({ code: "review_bypass_unavailable" });

    failReview = true;
    await expect(manager.finalizeWithToken(workspace.id, workspace.helperToken)).rejects.toMatchObject({ code: "review_failed" });
    await writeFile(join(worktreePath, "later.txt"), "later\n");
    await git(worktreePath, ["add", "later.txt"]);
    await git(worktreePath, ["commit", "-qm", "change candidate"]);
    await expect(manager.finalizeWithToken(workspace.id, workspace.helperToken, { allowUnreviewed: true }))
      .rejects.toMatchObject({ code: "review_bypass_unavailable" });
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
      sessionRoot: join(root, "sessions"),
      inspectionRoot: join(root, "inspections"),
      integrationRoot: join(root, "integrations")
    });
    const workspace = await manager.provision({ sessionName: "legacy", entryPath: root, targetBranch: "target" });
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

async function runFinishHelper(
  responseBody: object,
  statusCode: number,
  args: string[] = []
): Promise<{ code: number; stdout: string; stderr: string; requestBody: unknown }> {
  let requestBody: unknown;
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requestBody = JSON.parse(body);
      response.writeHead(statusCode, { "content-type": "application/json" });
      response.end(JSON.stringify(responseBody));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  const script = fileURLToPath(new URL("../../../skills/muxpilot-git-workflow/scripts/muxpilot-git-finish.mjs", import.meta.url));
  try {
    const { stdout, stderr } = await execFileAsync("node", [script, ...args], {
      env: {
        ...process.env,
        MUXPILOT_GIT_HELPER_URL: `http://127.0.0.1:${port}`,
        MUXPILOT_GIT_WORKSPACE_ID: "workspace-test",
        MUXPILOT_GIT_HELPER_TOKEN: "token-test"
      }
    });
    return { code: 0, stdout, stderr, requestBody };
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", requestBody };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
