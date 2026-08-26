import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const launcher = resolve(import.meta.dirname, "../../../scripts/codex-launcher.sh");

describe("Codex launcher", () => {
  it("passes through a successful Codex exit", async () => {
    await expect(execFileAsync("bash", [launcher, "--", "bash", "-c", "exit 0"]))
      .resolves.toMatchObject({ stderr: "" });
  });

  it("keeps Codex attached to the pane's standard streams", async () => {
    const child = spawn("bash", [launcher, "--", "bash", "-c", "read -r value; printf '%s' \"$value\""], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    child.stdin.end("hello\n");
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; });

    await new Promise<void>((resolvePromise, reject) => {
      child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`launcher exited ${code}`)));
      child.once("error", reject);
    });
    expect(output).toBe("hello");
  });

  it("retries early failures and keeps the final diagnostic pane alive", async () => {
    const child = spawn("bash", [launcher, "--", "bash", "-c", "exit 1"], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; });
    child.stderr.on("data", (chunk: string) => { output += chunk; });

    try {
      await expect.poll(() => output, { timeout: 8000 }).toContain("MUXPILOT_CODEX_STARTUP_FAILED code=1 attempts=3");
      expect(output.match(/MUXPILOT_CODEX_STARTUP_RETRY/g)).toHaveLength(2);
      expect(child.exitCode).toBeNull();
    } finally {
      child.kill("SIGTERM");
    }
  });

  it("retires stable startup children when Codex replaces them", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "muxpilot-codex-launcher-"));
    const eventsPath = resolve(directory, "events.jsonl");
    const fixturePath = resolve(directory, "fake-codex.mjs");
    await writeFile(fixturePath, `
      import { spawn } from "node:child_process";
      import { appendFile } from "node:fs/promises";
      process.title = "codex";
      const launch = async (label, identity = "mcp-server") => {
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", identity], { stdio: "ignore" });
        await appendFile(process.argv[2], JSON.stringify({ label, pid: child.pid }) + "\\n");
        return child;
      };
      const initial = await launch("initial");
      setTimeout(() => launch("replacement"), 350);
      const ordinaryPromise = new Promise((resolve) => setTimeout(() => resolve(launch("ordinary", "ordinary-task")), 400));
      setTimeout(async () => {
        let initialAlive = true;
        try { process.kill(initial.pid, 0); } catch { initialAlive = false; }
        const ordinary = await ordinaryPromise;
        let ordinaryAlive = true;
        try { process.kill(ordinary.pid, 0); } catch { ordinaryAlive = false; }
        await appendFile(process.argv[2], JSON.stringify({ label: "observed", initialAlive, ordinaryAlive }) + "\\n");
        ordinary.kill("SIGTERM");
      }, 700);
      setTimeout(() => process.exit(0), 900);
    `);

    const child = spawn("bash", [launcher, "--", process.execPath, fixturePath, eventsPath], {
      env: {
        ...process.env,
        MUXPILOT_CODEX_CHILD_OBSERVATION_MS: "20",
        MUXPILOT_CODEX_CHILD_STABLE_MS: "80",
        MUXPILOT_CODEX_CHILD_LEARNING_MS: "250",
        MUXPILOT_CODEX_CHILD_TERMINATION_GRACE_MS: "100"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    await new Promise<void>((resolvePromise, reject) => {
      child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`launcher exited ${code}`)));
      child.once("error", reject);
    });
    const events = (await readFile(eventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    await rm(directory, { recursive: true, force: true });
    expect(events.map(({ label }) => label)).toEqual(["initial", "replacement", "ordinary", "observed"]);
    expect(events[3]).toMatchObject({ initialAlive: false, ordinaryAlive: true });
    expect(() => process.kill(events[1].pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  });
});
