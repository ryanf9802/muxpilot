import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  approvalPermissionUpdates,
  decidePermission,
  isWithinWritableRoots
} from "../src/providers/claude/host/permissionPolicy.js";

const context = { cwd: "/repo", writableRoots: ["/shared/docs"] };
const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Claude permission policy", () => {
  it("routes interaction tools to questions and plans", () => {
    expect(decidePermission("AskUserQuestion", {}, {}, context)).toEqual({ kind: "question" });
    expect(decidePermission("ExitPlanMode", { plan: "do it" }, {}, context)).toEqual({ kind: "plan" });
  });

  it("denies product features that conflict with muxpilot sessions", () => {
    for (const tool of ["CronCreate", "EnterWorktree", "EnterPlanMode", "RemoteTrigger"]) {
      expect(decidePermission(tool, {}, {}, context)).toEqual({ kind: "deny", message: `${tool} is not available in muxpilot sessions.` });
    }
  });

  it("allows read tools and muxpilot MCP tools without approval", () => {
    for (const tool of ["Read", "Grep", "Glob", "TodoWrite", "Task", "mcp__muxpilot_sessions__send_message"]) {
      expect(decidePermission(tool, {}, {}, context)).toEqual({ kind: "allow" });
    }
  });

  it("allows file writes inside writable roots and asks outside them", () => {
    expect(decidePermission("Edit", { file_path: "/repo/src/a.ts" }, {}, context)).toEqual({ kind: "allow" });
    expect(decidePermission("Write", { file_path: "src/relative.ts" }, {}, context)).toEqual({ kind: "allow" });
    expect(decidePermission("NotebookEdit", { notebook_path: "/shared/docs/a.ipynb" }, {}, context)).toEqual({ kind: "allow" });
    expect(decidePermission("Write", { file_path: "/etc/passwd" }, {}, context)).toEqual({
      kind: "ask",
      category: "patch",
      title: "Edit /etc/passwd",
      command: null,
      reason: "The file is outside this session's writable roots.",
      prefixRule: null
    });
    expect(decidePermission("Write", { file_path: "/repo/../escape.txt" }, {}, context)).toMatchObject({ kind: "ask" });
    expect(decidePermission("MultiEdit", {}, { decisionReason: "tool said so" }, context)).toMatchObject({
      kind: "ask",
      category: "patch",
      title: "Apply proposed file changes?",
      reason: "tool said so"
    });
  });

  it("asks for Bash commands with the CLI's suggested prefix", () => {
    const decision = decidePermission("Bash", { command: "git push origin main" }, {
      decisionReason: "network access",
      suggestions: [
        { type: "addDirectories", directories: ["/tmp"] },
        { type: "addRules", rules: [{ toolName: "Read", ruleContent: "x:*" }, { toolName: "Bash", ruleContent: "git push:*" }] }
      ]
    }, context);
    expect(decision).toEqual({
      kind: "ask",
      category: "command",
      title: "Run git push origin main",
      command: "git push origin main",
      reason: "network access",
      prefixRule: ["git", "push"]
    });
    expect(decidePermission("Bash", { command: "rm -rf x", dangerouslyDisableSandbox: true }, { decisionReason: "ignored" }, context))
      .toMatchObject({ reason: "The command asked to run outside the sandbox.", prefixRule: null });
    expect(decidePermission("Bash", {}, { blockedPath: "/etc" }, context)).toMatchObject({ title: "Run this command?", command: null, reason: "/etc" });
  });

  it("categorizes other tools as MCP tool or permission requests", () => {
    expect(decidePermission("mcp__github__create_issue", {}, { title: "Create an issue?" }, context)).toMatchObject({
      kind: "ask",
      category: "tool",
      title: "Create an issue?"
    });
    expect(decidePermission("SomethingNew", {}, { description: "why" }, context)).toMatchObject({
      kind: "ask",
      category: "permissions",
      title: "Use SomethingNew?",
      reason: "why"
    });
  });

  it("maps approval scopes to SDK permission updates", () => {
    expect(approvalPermissionUpdates("Bash", { command: "ls" }, { behavior: "allow", scope: "once" })).toEqual([]);
    expect(approvalPermissionUpdates("Bash", { command: "git push" }, { behavior: "allow", scope: "prefix" }, ["git", "push"])).toEqual([
      { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "git push:*" }], behavior: "allow", destination: "session" }
    ]);
    expect(approvalPermissionUpdates("Bash", { command: "git push" }, { behavior: "allow", scope: "prefix" }, null)).toEqual([]);
    expect(approvalPermissionUpdates("Bash", { command: "make test" }, { behavior: "allow", scope: "session" })).toEqual([
      { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "make test" }], behavior: "allow", destination: "session" }
    ]);
    expect(approvalPermissionUpdates("Bash", {}, { behavior: "allow", scope: "session" })).toEqual([]);
    expect(approvalPermissionUpdates("Write", { file_path: "/outside/dir/file.txt" }, { behavior: "allow", scope: "session" })).toEqual([
      { type: "addDirectories", directories: ["/outside/dir"], destination: "session" }
    ]);
    expect(approvalPermissionUpdates("WebHook", {}, { behavior: "allow", scope: "session" })).toEqual([
      { type: "addRules", rules: [{ toolName: "WebHook" }], behavior: "allow", destination: "session" }
    ]);
  });
});

describe("isWithinWritableRoots", () => {
  it("accepts the root itself, nested missing paths, and rejects siblings with a shared prefix", () => {
    expect(isWithinWritableRoots("/repo", context)).toBe(true);
    expect(isWithinWritableRoots("/repo/new/dir/file.ts", context)).toBe(true);
    expect(isWithinWritableRoots("/repo-other/file.ts", context)).toBe(false);
    expect(isWithinWritableRoots("/shared/docs/x.md", context)).toBe(true);
    expect(isWithinWritableRoots("/shared/other.md", context)).toBe(false);
  });

  it("resolves symlinks on the nearest existing ancestor so links cannot escape the roots", () => {
    const base = mkdtempSync(join(tmpdir(), "muxpilot-claude-policy-"));
    temporary.push(base);
    const cwd = join(base, "repo");
    const outside = join(base, "outside");
    mkdirSync(cwd);
    mkdirSync(outside);
    symlinkSync(outside, join(cwd, "escape"));
    symlinkSync(join(cwd, "inner-target"), join(base, "alias"));
    mkdirSync(join(cwd, "inner-target"));

    const scoped = { cwd, writableRoots: [] };
    expect(isWithinWritableRoots(join(cwd, "escape", "file.txt"), scoped)).toBe(false);
    expect(isWithinWritableRoots(join(cwd, "escape", "missing", "deeper.txt"), scoped)).toBe(false);
    expect(isWithinWritableRoots("escape/file.txt", scoped)).toBe(false);
    expect(isWithinWritableRoots(join(cwd, "real.txt"), scoped)).toBe(true);
    // A link from outside that points back inside the root is a permitted write target.
    expect(isWithinWritableRoots(join(base, "alias", "file.txt"), scoped)).toBe(true);
    // A writable root that is itself a symlink is compared by its resolved location.
    expect(isWithinWritableRoots(join(outside, "file.txt"), { cwd, writableRoots: [join(cwd, "escape")] })).toBe(true);
    expect(decidePermission("Write", { file_path: join(cwd, "escape", "file.txt") }, {}, scoped)).toMatchObject({ kind: "ask" });
  });
});
