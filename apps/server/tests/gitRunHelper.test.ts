import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createConnection } from "node:net";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const helper = resolve(import.meta.dirname, "../../../skills/muxpilot-git-workflow/scripts/muxpilot-git-run.mjs");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("heavyweight validation helper", () => {
  it("allows two heavyweight commands by default", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-heavy-helper-"));
    roots.push(root);
    const output = join(root, "events.txt");
    const environment = {
      ...process.env,
      MUXPILOT_HEAVY_VALIDATION_DIR: join(root, "leases"),
      MUXPILOT_HEAVY_VALIDATION_POLL_MS: "10"
    };
    delete environment.MUXPILOT_HEAVY_VALIDATION_CONCURRENCY;
    const script = [
      "const fs=require('node:fs');",
      "const file=process.argv[1], id=process.argv[2], started=Date.now();",
      "fs.appendFileSync(file,id+'-start\\n');",
      "const timer=setInterval(()=>{",
      "const starts=fs.readFileSync(file,'utf8').split('\\n').filter(line=>line.endsWith('-start')).length;",
      "if(starts>=2||Date.now()-started>1000){clearInterval(timer);fs.appendFileSync(file,id+'-end\\n')}",
      "},10)"
    ].join("");
    const run = (id: string) => execFileAsync(process.execPath, [
      helper, "--heavy", "--", process.execPath, "-e", script, output, id
    ], { env: environment });

    await Promise.all([run("one"), run("two")]);

    const events = (await readFile(output, "utf8")).trim().split("\n");
    expect(events.slice(0, 2).every((event) => event.endsWith("-start"))).toBe(true);
  });

  it("serializes commands and reaps a stale socket-backed lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-heavy-helper-"));
    roots.push(root);
    const leases = join(root, "leases");
    const output = join(root, "events.txt");
    await mkdir(join(leases, "slot-0"), { recursive: true });
    await writeFile(join(leases, "slot-0", "owner.json"), JSON.stringify({
      version: 2,
      runId: "stale-run",
      controlSocket: join(leases, "runs", "stale-run", "control.sock"),
      heartbeatAt: Date.now()
    }));
    const environment = {
      ...process.env,
      MUXPILOT_HEAVY_VALIDATION_DIR: leases,
      MUXPILOT_HEAVY_VALIDATION_CONCURRENCY: "1",
      MUXPILOT_HEAVY_VALIDATION_POLL_MS: "10"
    };
    const script = [
      "const fs=require('node:fs');",
      "const file=process.argv[1], id=process.argv[2];",
      "fs.appendFileSync(file, id+'-start\\n');",
      "setTimeout(()=>{fs.appendFileSync(file,id+'-end\\n')},80)"
    ].join("");
    const run = (id: string) => execFileAsync(process.execPath, [
      helper, "--heavy", "--", process.execPath, "-e", script, output, id
    ], { env: environment });

    await Promise.all([run("one"), run("two")]);

    const events = (await readFile(output, "utf8")).trim().split("\n");
    expect(events).toHaveLength(4);
    expect(events[0]?.endsWith("-start")).toBe(true);
    expect(events[1]).toBe(events[0]?.replace("-start", "-end"));
    expect(events[2]?.endsWith("-start")).toBe(true);
    expect(events[3]).toBe(events[2]?.replace("-start", "-end"));
  });

  it("preserves the child exit status", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-heavy-helper-"));
    roots.push(root);
    const outcome = execFileAsync(process.execPath, [
      helper, "--heavy", "--", process.execPath, "-e", "process.exit(7)"
    ], {
      env: { ...process.env, MUXPILOT_HEAVY_VALIDATION_DIR: join(root, "leases") }
    });
    await expect(outcome).rejects.toMatchObject({ code: 7 });
    await outcome.catch((error: { stderr: string }) => {
      expect(error.stderr).not.toContain("RESOURCE_LIMIT_WARNING");
    });
  });

  it("force-removes labeled containers after a failed Docker command", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-heavy-helper-"));
    roots.push(root);
    const bin = join(root, "bin");
    const cleanup = join(root, "cleanup.txt");
    const removed = join(root, "removed");
    await mkdir(bin);
    const docker = join(bin, "docker");
    await writeFile(docker, `#!/bin/sh\nif [ "$1" = ps ]; then [ -f "${removed}" ] || echo fake-container; exit 0; fi\nif [ "$1" = rm ]; then echo "$@" > "${cleanup}"; touch "${removed}"; exit 0; fi\nexit 7\n`);
    await chmod(docker, 0o755);
    await expect(execFileAsync(process.execPath, [helper, "--heavy", "--", "docker", "run", "example"], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MUXPILOT_HEAVY_VALIDATION_DIR: join(root, "leases") }
    })).rejects.toMatchObject({ code: 7 });
    expect(await readFile(cleanup, "utf8")).toContain("rm --force fake-container");
  });

  it("retries cleanup for a late container and a transient remove failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-heavy-helper-"));
    roots.push(root);
    const bin = join(root, "bin");
    const calls = join(root, "calls");
    const removed = join(root, "removed");
    await mkdir(bin);
    await writeFile(calls, "");
    const docker = join(bin, "docker");
    await writeFile(docker, `#!/bin/sh\nif [ "$1" = ps ]; then count=$(wc -l < "${calls}" 2>/dev/null || echo 0); echo ps >> "${calls}"; if [ "$count" -ge 1 ] && [ ! -f "${removed}" ]; then echo late-container; fi; exit 0; fi\nif [ "$1" = rm ]; then echo rm >> "${calls}"; if ! grep -q rm-failed "${calls}"; then echo rm-failed >> "${calls}"; echo busy >&2; exit 1; fi; touch "${removed}"; exit 0; fi\nexit 9\n`);
    await chmod(docker, 0o755);
    const outcome = execFileAsync(process.execPath, [helper, "--heavy", "--", "docker", "run", "example"], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MUXPILOT_HEAVY_VALIDATION_DIR: join(root, "leases") }
    });
    await expect(outcome).rejects.toMatchObject({ code: 9 });
    await outcome.catch((error: { stderr: string }) => {
      expect(error.stderr).toContain("DOCKER_CLEANUP_RETRY");
      expect(error.stderr).toContain("DOCKER_CLEANUP_COMPLETE");
    });
    expect(await stat(removed)).toBeTruthy();
  });

  it("provides a writable workspace JSII cache and preserves a usable override", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-heavy-helper-"));
    roots.push(root);
    const leases = join(root, "leases");
    const output = join(root, "cache.txt");
    const script = "require('node:fs').writeFileSync(process.argv[1], process.env.JSII_RUNTIME_PACKAGE_CACHE_ROOT)";
    const fallbackEnvironment = {
      ...process.env,
      MUXPILOT_GIT_WORKSPACE_ID: "workspace-a",
      MUXPILOT_HEAVY_VALIDATION_DIR: leases
    };
    delete fallbackEnvironment.JSII_RUNTIME_PACKAGE_CACHE_ROOT;
    const fallback = await execFileAsync(process.execPath, [helper, "--heavy", "--", process.execPath, "-e", script, output], {
      env: fallbackEnvironment
    });
    const fallbackPath = await readFile(output, "utf8");
    expect(fallbackPath).toBe(join(leases, "caches", "jsii", "workspace-a"));
    expect((await stat(fallbackPath)).isDirectory()).toBe(true);
    expect(fallback.stderr).toContain("CACHE_FALLBACK");

    const configured = join(root, "configured-jsii");
    await mkdir(configured);
    const configuredResult = await execFileAsync(process.execPath, [helper, "--heavy", "--", process.execPath, "-e", script, output], {
      env: { ...fallbackEnvironment, JSII_RUNTIME_PACKAGE_CACHE_ROOT: configured }
    });
    expect(await readFile(output, "utf8")).toBe(configured);
    expect(configuredResult.stderr).not.toContain("CACHE_FALLBACK");
  });

  it("replaces an unusable JSII cache and explains exit 137", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-heavy-helper-"));
    roots.push(root);
    const bin = join(root, "bin");
    const unusableCache = join(root, "not-a-directory");
    await mkdir(bin);
    await writeFile(unusableCache, "file");
    const docker = join(bin, "docker");
    await writeFile(docker, "#!/bin/sh\nif [ \"$1\" = ps ]; then exit 0; fi\nexit 1\n");
    await chmod(docker, 0o755);
    const outcome = execFileAsync(process.execPath, [helper, "--heavy", "--", process.execPath, "-e", "process.exit(137)"], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        MUXPILOT_GIT_WORKSPACE_ID: "workspace-b",
        MUXPILOT_HEAVY_VALIDATION_DIR: join(root, "leases"),
        JSII_RUNTIME_PACKAGE_CACHE_ROOT: unusableCache
      }
    });
    await expect(outcome).rejects.toMatchObject({ code: 137 });
    await outcome.catch((error: { stderr: string }) => {
      expect(error.stderr).toContain("CACHE_FALLBACK");
      expect(error.stderr).toContain("reason=configured-path-unwritable");
      expect(error.stderr).toContain("RESOURCE_LIMIT_WARNING");
      expect(error.stderr).toContain("cause=probable-oom-or-external-sigkill");
    });
  });

  it("reports confirmed Docker OOM kills for labeled run containers", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-heavy-helper-"));
    roots.push(root);
    const bin = join(root, "bin");
    const removed = join(root, "removed");
    await mkdir(bin);
    const docker = join(bin, "docker");
    await writeFile(docker, `#!/bin/sh\nif [ "$1" = ps ]; then [ -f "${removed}" ] || echo oom-container; exit 0; fi\nif [ "$1" = inspect ]; then echo '{"OOMKilled":true}'; exit 0; fi\nif [ "$1" = rm ]; then touch "${removed}"; exit 0; fi\nexit 1\n`);
    await chmod(docker, 0o755);
    const outcome = execFileAsync(process.execPath, [helper, "--heavy", "--", process.execPath, "-e", "process.exit(137)"], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        MUXPILOT_HEAVY_VALIDATION_DIR: join(root, "leases")
      }
    });
    await expect(outcome).rejects.toMatchObject({ code: 137 });
    await outcome.catch((error: { stderr: string }) => {
      expect(error.stderr).toContain("RESOURCE_LIMIT_WARNING");
      expect(error.stderr).toContain("cause=docker-oom");
      expect(error.stderr).toContain("DOCKER_CLEANUP_COMPLETE");
    });
  });

  it("warns and exits 124 after the configured child-output inactivity timeout", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-heavy-helper-"));
    roots.push(root);
    const promise = execFileAsync(process.execPath, [
      helper,
      "--heavy",
      "--inactivity-warn", "30ms",
      "--inactivity-timeout", "80ms",
      "--runtime-timeout", "2s",
      "--termination-grace", "20ms",
      "--",
      process.execPath, "-e", "setTimeout(() => {}, 5000)"
    ], {
      env: {
        ...process.env,
        MUXPILOT_HEAVY_VALIDATION_DIR: join(root, "leases"),
        MUXPILOT_HEAVY_VALIDATION_CONSOLE_HEARTBEAT_MS: "20",
        MUXPILOT_HEAVY_VALIDATION_OWNER_HEARTBEAT_MS: "20"
      }
    });

    await expect(promise).rejects.toMatchObject({
      code: 124,
      stderr: expect.stringContaining("INACTIVITY_WARNING")
    });
    await promise.catch((error: { stderr: string }) => {
      expect(error.stderr).toContain("TERMINATING");
      expect(error.stderr).toContain("LEASE_RELEASED");
    });
  });

  it("treats silent process-group CPU work as progress", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-heavy-helper-"));
    roots.push(root);
    const result = await execFileAsync(process.execPath, [
      helper, "--heavy", "--inactivity-warn", "30ms", "--inactivity-timeout", "80ms", "--runtime-timeout", "2s", "--",
      process.execPath, "-e", "const end=Date.now()+250; while(Date.now()<end){}"
    ], { env: { ...process.env, MUXPILOT_HEAVY_VALIDATION_DIR: join(root, "leases") } });
    expect(result.stderr).not.toContain("INACTIVITY_WARNING");
  });

  it("accepts operator termination over its private control socket and exits 143", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-heavy-helper-"));
    roots.push(root);
    const leases = join(root, "leases");
    const run = execFileAsync(process.execPath, [
      helper, "--heavy", "--termination-grace", "20ms", "--", process.execPath, "-e", "setTimeout(() => {}, 5000)"
    ], { env: { ...process.env, MUXPILOT_HEAVY_VALIDATION_DIR: leases } });
    const outcome = run.then(() => null, (error) => error as { code: number; stderr: string });
    const runId = await waitForRun(leases);
    const response = await control(join(leases, "runs", runId, "control.sock"), { action: "terminate" });
    expect(response).toMatchObject({ ok: true, accepted: true, state: "terminating" });
    expect(await outcome).toMatchObject({ code: 143, stderr: expect.stringContaining("TERMINATING") });
  });

  it("tees lifecycle and child output into private retained session logs", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-heavy-helper-"));
    roots.push(root);
    const controlRoot = join(root, "session-control");
    await mkdir(controlRoot);
    await execFileAsync(process.execPath, [helper, "--heavy", "--", process.execPath, "-e", "console.log('child-visible-output')"], {
      env: {
        ...process.env,
        MUXPILOT_GIT_STATUS_FILE: join(controlRoot, "git-workflow-status.json"),
        MUXPILOT_GIT_WORKSPACE_ID: "workspace-a",
        MUXPILOT_HEAVY_VALIDATION_DIR: join(root, "leases")
      }
    });
    const logRoot = join(controlRoot, "heavy-commands");
    const logs = (await readdir(logRoot)).filter((entry) => entry.endsWith(".log"));
    expect(logs).toHaveLength(1);
    expect((await stat(logRoot)).mode & 0o777).toBe(0o700);
    expect((await stat(join(logRoot, logs[0]!))).mode & 0o777).toBe(0o600);
    const contents = await readFile(join(logRoot, logs[0]!), "utf8");
    expect(contents).toContain("WAITING_FOR_SLOT");
    expect(contents).toContain("COMMAND_STARTED");
    expect(contents).toContain("child-visible-output");
    expect(contents).toContain("LEASE_RELEASED");
  });
});

async function waitForRun(leases: string): Promise<string> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const entries = await readdir(join(leases, "runs")).catch(() => []);
    for (const entry of entries) {
      const owner = await readFile(join(leases, "runs", entry, "owner.json"), "utf8").then(JSON.parse).catch(() => null);
      if (owner?.state === "running") return entry;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error("heavyweight run did not become active");
}

function control(path: string, request: object): Promise<Record<string, unknown>> {
  return new Promise((resolveResponse, reject) => {
    const socket = createConnection(path);
    let input = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      input += chunk;
      if (input.includes("\n")) {
        socket.end();
        resolveResponse(JSON.parse(input.trim()));
      }
    });
    socket.once("error", reject);
  });
}
