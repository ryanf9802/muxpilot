import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  appServerServiceUnit,
  runtimePaths,
  SystemdAppServerSupervisor
} from "../src/services/sessionDrivers/systemdAppServerSupervisor.js";
import type { RuntimeProxyConnection, RuntimeStartSpec } from "../src/services/sessionDrivers/types.js";

const capabilityId = "0123456789abcdef01234567";

describe("SystemdAppServerSupervisor", () => {
  it("creates a private bounded-restart service and reconnects through the proxy", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-app-server-supervisor-"));
    const paths = runtimePaths(root, capabilityId);
    let active = false;
    let socketReady = false;
    const calls: Array<{ command: string; args: string[] }> = [];
    const proxy: RuntimeProxyConnection = { input: new PassThrough(), output: new PassThrough(), close: vi.fn(async () => undefined) };
    const supervisor = new SystemdAppServerSupervisor(root, {
      run: vi.fn(async (command, args) => {
        calls.push({ command, args });
        if (command === "systemd-run") { active = true; socketReady = true; }
        if (command === "systemctl" && args.includes("show")) {
          return { stdout: `ActiveState=${active ? "active" : "inactive"}\nSubState=${active ? "running" : "dead"}\nMainPID=${active ? "4242" : "0"}\nControlGroup=/user.slice/test\n` };
        }
        return { stdout: "" };
      }),
      socketReady: vi.fn(async () => socketReady),
      openProxy: vi.fn(() => proxy),
      delay: vi.fn(async () => undefined),
      now: vi.fn(() => 0)
    }, { executablePath: "/node/bin:/usr/bin" });

    const runtime = await supervisor.start(spec(root));

    expect(runtime).toEqual({
      kind: "systemd_service",
      unit: appServerServiceUnit(capabilityId),
      socketPath: paths.socketPath,
      state: "connected",
      codexVersion: "0.152.0"
    });
    expect(calls.find((call) => call.command === "systemd-run")?.args).toEqual(expect.arrayContaining([
      `--unit=${paths.unit}`,
      "--property=Restart=on-failure",
      "--property=StartLimitBurst=3",
      `--property=EnvironmentFile=${paths.environmentPath}`,
      "codex",
      "-c",
      "check_for_update_on_startup=false",
      "-c",
      "sandbox_workspace_write.network_access=true",
      "-c",
      "mcp_servers.muxpilot_sessions.command=\"/usr/bin/node\"",
      "-c",
      "mcp_servers.muxpilot_sessions.args=[\"/opt/muxpilot-session-mcp.mjs\",\"/run/capability.json\"]",
      "-c",
      "mcp_servers.muxpilot_sessions.default_tools_approval_mode=\"approve\"",
      "app-server",
      `unix://${paths.socketPath}`
    ]));
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(paths.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(paths.environmentPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(paths.environmentPath, "utf8")).toBe(`CODEX_HOME="${root}/codex"\nMUXPILOT_DOCUMENTS_DIR="/documents"\nPATH="/node/bin:/usr/bin"\n`);
    await expect(supervisor.reconnect(runtime)).resolves.toBe(proxy);
    await expect(supervisor.inspect(runtime)).resolves.toMatchObject({
      mainPid: 4242,
      socketPresent: true,
      attachmentCommand: `codex --remote 'unix://${paths.socketPath}'`
    });
  });

  it("stops the durable service without deleting thread identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-app-server-stop-"));
    const run = vi.fn(async () => ({ stdout: "" }));
    const supervisor = new SystemdAppServerSupervisor(root, { run });
    const runtime = { kind: "systemd_service" as const, unit: appServerServiceUnit(capabilityId), socketPath: runtimePaths(root, capabilityId).socketPath, state: "connected" as const, codexVersion: "0.152.0" };

    await expect(supervisor.stop(runtime)).resolves.toEqual({ ...runtime, state: "stopped" });
    expect(run).toHaveBeenCalledWith("systemctl", ["--user", "stop", runtime.unit]);
  });

  it("treats an already-absent owned service as stopped but preserves unrelated failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-app-server-absent-stop-"));
    const runtime = { kind: "systemd_service" as const, unit: appServerServiceUnit(capabilityId), socketPath: runtimePaths(root, capabilityId).socketPath, state: "hibernated" as const, codexVersion: "0.152.0" };
    const absent = Object.assign(new Error(`Command failed: systemctl --user stop ${runtime.unit}`), {
      stderr: `Failed to stop ${runtime.unit}: Unit ${runtime.unit} not loaded.\n`
    });
    const unrelated = Object.assign(new Error("systemd user manager unavailable"), { stderr: "Failed to connect to bus\n" });
    const run = vi.fn()
      .mockRejectedValueOnce(absent)
      .mockRejectedValueOnce(unrelated);
    const supervisor = new SystemdAppServerSupervisor(root, { run });

    await expect(supervisor.stop(runtime)).resolves.toEqual({ ...runtime, state: "stopped" });
    await expect(supervisor.stop(runtime)).rejects.toThrow("systemd user manager unavailable");
  });

  it("fails closed for invalid capability ids and unavailable services", async () => {
    expect(() => appServerServiceUnit("../escape")).toThrow(/24 lowercase hexadecimal/);
    const root = await mkdtemp(join(tmpdir(), "muxpilot-app-server-missing-"));
    const supervisor = new SystemdAppServerSupervisor(root, {
      run: vi.fn(async () => ({ stdout: "ActiveState=inactive\nSubState=dead\nMainPID=0\n" })),
      socketReady: vi.fn(async () => false)
    });
    const runtime = { kind: "systemd_service" as const, unit: appServerServiceUnit(capabilityId), socketPath: runtimePaths(root, capabilityId).socketPath, state: "stopped" as const, codexVersion: null };
    await expect(supervisor.reconnect(runtime)).rejects.toThrow("App-server runtime is not connectable");
    await expect(supervisor.stop({ ...runtime, unit: "ssh.service" })).rejects.toThrow("Refusing non-muxpilot app-server unit");
    await expect(supervisor.stop({ ...runtime, socketPath: "/tmp/other.sock" })).rejects.toThrow("outside its owned runtime path");
  });

  it("rejects invalid or duplicate MCP configuration before starting a service", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-app-server-invalid-mcp-"));
    const run = vi.fn(async () => ({ stdout: "" }));
    const supervisor = new SystemdAppServerSupervisor(root, { run });
    const invalid = spec(root);
    invalid.mcpServers = [{ name: "muxpilot.sessions", command: "/usr/bin/node", args: [] }];
    await expect(supervisor.start(invalid)).rejects.toThrow("Invalid app-server MCP server name");
    expect(run).not.toHaveBeenCalled();

    const duplicate = spec(root);
    duplicate.mcpServers.push({ ...duplicate.mcpServers[0]! });
    await expect(supervisor.start(duplicate)).rejects.toThrow("Duplicate app-server MCP server name");
    expect(run).not.toHaveBeenCalled();
  });
});

function spec(root: string): RuntimeStartSpec {
  return {
    sessionId: "session-1",
    capabilityId,
    cwd: "/repo",
    codexHome: `${root}/codex`,
    codexVersion: "0.152.0",
    environment: { MUXPILOT_DOCUMENTS_DIR: "/documents", PATH: "/untrusted/session/path" },
    mcpServers: [{
      name: "muxpilot_sessions",
      command: "/usr/bin/node",
      args: ["/opt/muxpilot-session-mcp.mjs", "/run/capability.json"],
      defaultToolsApprovalMode: "approve"
    }]
  };
}
