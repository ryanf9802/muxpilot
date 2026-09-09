import { access, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  formatStartupWaitProgress,
  isMissingSystemdUnitStopError,
  resourceGovernorSessionScopeLines,
  rotateRuntimeLog,
  runtimeLogPolicy,
  shadowDependencyIsolation,
  shadowIsolationEnvironment,
  shadowOwnedSystemdUnits,
  startupTimeoutMs,
  syncBundledSkillForMode
} from "../../../scripts/lifecycle.mjs";

describe("runtime log rotation", () => {
  it("keeps a bounded sequence of rotated files before a new process starts", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-log-rotation-"));
    const logPath = join(root, "server.log");
    await writeFile(`${logPath}.1`, "previous");
    await writeFile(logPath, "12345678");

    expect(runtimeLogPolicy({})).toEqual({ maxBytes: 64 * 1024 * 1024, retainedFiles: 3 });
    expect(rotateRuntimeLog(logPath, {
      MUXPILOT_RUNTIME_LOG_MAX_BYTES: "8",
      MUXPILOT_RUNTIME_LOG_RETAINED_FILES: "3"
    })).toBe(true);

    await expect(access(logPath)).rejects.toThrow();
    expect(await readFile(`${logPath}.1`, "utf8")).toBe("12345678");
    expect(await readFile(`${logPath}.2`, "utf8")).toBe("previous");
  });
});

describe("application startup wait", () => {
  it("allows production recovery five minutes while keeping local modes fast", () => {
    expect(startupTimeoutMs("prod", {})).toBe(300_000);
    expect(startupTimeoutMs("dev", {})).toBe(30_000);
    expect(startupTimeoutMs("shadow", {})).toBe(30_000);
  });

  it("accepts a bounded explicit startup timeout override", () => {
    expect(startupTimeoutMs("prod", { MUXPILOT_APP_START_TIMEOUT_MS: "420000" })).toBe(420_000);
    expect(() => startupTimeoutMs("prod", { MUXPILOT_APP_START_TIMEOUT_MS: "999" }))
      .toThrow("must be an integer of at least 1000 milliseconds");
  });

  it("reports elapsed time and endpoint readiness during a slow start", () => {
    expect(formatStartupWaitProgress("production", 72_000, [
      { name: "backend", active: false },
      { name: "frontend", active: true }
    ])).toBe("Still waiting for production startup after 1m 12s (backend pending, frontend ready).");
  });
});

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
      expect(installedSkill).toContain("### Skill-declared authorization");
      expect(installedSkill).toContain("Description-based or otherwise automatic skill selection is not a direct");
      expect(installedSkill).toContain("The skill does not need to name");
      expect(installedSkill).toContain("continue without pausing for redundant confirmation");
      expect(installedSkill).toContain("This also satisfies a");
      expect(installedSkill).toContain("security approval");
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
      expect(installedDocumentsSkill).toContain("Plan mode does not make the session's documents read-only");
      expect(installedDocumentsSkill).toContain("may autonomously create, edit, rename, and delete documents");
      expect(installedDocumentsSkill).toContain("only after the operator selects **Implement** or **Clear context and implement**");

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
    })).toEqual(["session scopes: active, 2 managed, 3 unmanaged"]);
    expect(resourceGovernorSessionScopeLines({
      enabled: false,
      unavailableReason: "user_systemd_unavailable"
    })).toEqual(["session scopes: unavailable; run sudo loginctl enable-linger \"$USER\", then restart muxpilot"]);
  });
});

describe("shadow lifecycle isolation", () => {
  it("recognizes an already-absent unit as an idempotent stop result", () => {
    expect(isMissingSystemdUnitStopError({
      stderr: "Failed to stop muxpilot-session-0123456789abcdef01234567.service: Unit muxpilot-session-0123456789abcdef01234567.service not loaded.\n"
    })).toBe(true);
    expect(isMissingSystemdUnitStopError(new Error("systemctl timed out"))).toBe(false);
  });

  it("requires both application dependency links to resolve to the checkout core", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-shadow-dependencies-"));
    const core = join(root, "packages", "core");
    await mkdir(core, { recursive: true });
    await mkdir(join(root, "apps", "server", "node_modules", "@muxpilot"), { recursive: true });
    await mkdir(join(root, "apps", "web", "node_modules", "@muxpilot"), { recursive: true });
    await symlink(core, join(root, "apps", "server", "node_modules", "@muxpilot", "core"));
    expect(shadowDependencyIsolation(root).isolated).toBe(false);
    await symlink(core, join(root, "apps", "web", "node_modules", "@muxpilot", "core"));
    expect(shadowDependencyIsolation(root)).toMatchObject({ expected: core, server: core, web: core, isolated: true });
  });

  it("forces private loopback runtime roots despite hostile inherited values", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-shadow-root-"));
    const environment = shadowIsolationEnvironment(root, {
      MUXPILOT_SHADOW_RESOURCE_GOVERNOR: "unexpected",
      MUXPILOT_PORT: "12777",
      MUXPILOT_DATA_DIR: "/shared/production"
    });

    expect(environment).toMatchObject({
      MUXPILOT_SHADOW: "1",
      MUXPILOT_LAN_ENABLED: "0",
      MUXPILOT_HOST: "127.0.0.1",
      MUXPILOT_PORT: "14177",
      MUXPILOT_WEB_PORT: "15177",
      MUXPILOT_RESOURCE_GOVERNOR: "off"
    });
    expect(environment.MUXPILOT_DATA_DIR).toBe(join(root, "data", "shadow"));
    expect(environment.MUXPILOT_DB_PATH).toBe(join(root, "data", "shadow", "muxpilot.db"));
    expect(environment.MUXPILOT_SKILL_HOME).toBe(root);
    expect(environment.MUXPILOT_GIT_WORKTREE_ROOT).toBe(join(root, "data", "shadow", "git-worktrees"));
    expect(environment.MUXPILOT_GIT_SESSION_ROOT).toBe(join(root, "data", "shadow", "sessions"));
    expect(environment.MUXPILOT_HEAVY_VALIDATION_DIR).toBe(join(root, "data", "shadow", "heavy"));
    expect(environment.VITE_MUXPILOT_SHADOW).toBe("1");
  });

  it("allows an explicit shadow-only resource-governor opt-in", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-shadow-governor-"));
    expect(shadowIsolationEnvironment(root, { MUXPILOT_SHADOW_RESOURCE_GOVERNOR: "auto" }))
      .toMatchObject({ MUXPILOT_RESOURCE_GOVERNOR: "auto" });
  });

  it("can isolate the shadow runtime from host-only executables", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-shadow-path-"));
    expect(shadowIsolationEnvironment(root, { MUXPILOT_SHADOW_RUNTIME_PATH: "/tmp/muxpilot-shadow-bin" }))
      .toMatchObject({ PATH: "/tmp/muxpilot-shadow-bin" });
    expect(shadowIsolationEnvironment(root, {})).not.toHaveProperty("PATH");
  });

  it("discovers only exact units proven by shadow-owned metadata", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "muxpilot-shadow-data-"));
    const markedId = "0123456789abcdef01234567";
    const unmarkedId = "89abcdef0123456789abcdef";
    const appRoot = join(dataDir, "runtime", "app-server-sessions");
    await mkdir(join(appRoot, markedId), { recursive: true });
    await mkdir(join(appRoot, unmarkedId), { recursive: true });
    await writeFile(join(appRoot, markedId, "environment"), 'CODEX_HOME="/tmp/codex"\nMUXPILOT_SHADOW="1"\n');
    await writeFile(join(appRoot, unmarkedId, "environment"), 'MUXPILOT_SHADOW="0"\n');

    const heavyRoot = join(dataDir, "heavy", "runs");
    await mkdir(join(heavyRoot, "valid-run"), { recursive: true });
    await mkdir(join(heavyRoot, "invalid-run"), { recursive: true });
    await writeFile(join(heavyRoot, "valid-run", "owner.json"), JSON.stringify({
      resourceUnit: "muxpilot-heavy-workspace-0123456789ab-abcdef.service"
    }));
    await writeFile(join(heavyRoot, "invalid-run", "owner.json"), JSON.stringify({
      resourceUnit: "muxpilot-session-production.service"
    }));

    const outside = await mkdtemp(join(tmpdir(), "muxpilot-shadow-outside-"));
    await writeFile(join(outside, "environment"), 'MUXPILOT_SHADOW="1"\n');
    await symlink(outside, join(appRoot, "fedcba9876543210fedcba98"));

    expect(shadowOwnedSystemdUnits(dataDir)).toEqual([
      "muxpilot-heavy-workspace-0123456789ab-abcdef.service",
      `muxpilot-session-${markedId}.service`
    ]);
  });
});
