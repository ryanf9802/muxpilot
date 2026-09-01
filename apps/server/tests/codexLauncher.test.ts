import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { ChildSupervisorState } from "../../../scripts/codex-child-supervisor.mjs";

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
      import { appendFile } from "node:fs/promises";
      import { readFileSync, readdirSync } from "node:fs";
      import { Worker } from "node:worker_threads";
      process.title = "codex";
      const processAlive = (pid) => {
        try {
          const stat = readFileSync(\`/proc/\${pid}/stat\`, "utf8");
          return stat.slice(stat.lastIndexOf(")") + 2).split(/\\s+/)[0] !== "Z";
        } catch { return false; }
      };
      const childOwnerTid = (pid) => readdirSync(\`/proc/\${process.pid}/task\`).find((tid) => {
        try {
          return readFileSync(\`/proc/\${process.pid}/task/\${tid}/children\`, "utf8").trim().split(/\\s+/).includes(String(pid));
        } catch { return false; }
      }) ?? null;
      const worker = new Worker(\`
        const { spawn } = require("node:child_process");
        const { parentPort } = require("node:worker_threads");
        parentPort.on("message", ({ action, label, identity }) => {
          if (action === "launch") {
            const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", identity], { stdio: "ignore" });
            parentPort.postMessage({ label, pid: child.pid });
          }
        });
      \`, { eval: true });
      const launch = (label, identity = "mcp-server") => new Promise((resolve) => {
        const handle = (message) => {
          if (message.label !== label) return;
          worker.off("message", handle);
          const event = { ...message, ownerTid: childOwnerTid(message.pid), runtimePid: process.pid };
          appendFile(process.argv[2], JSON.stringify(event) + "\\n").then(() => resolve(event));
        };
        worker.on("message", handle);
        worker.postMessage({ action: "launch", label, identity });
      });
      const initial = await launch("initial");
      setTimeout(() => launch("replacement"), 700);
      const ordinaryPromise = new Promise((resolve) => setTimeout(() => resolve(launch("ordinary", "ordinary-task")), 750));
      setTimeout(async () => {
        const ordinary = await ordinaryPromise;
        const initialAlive = processAlive(initial.pid);
        const ordinaryAlive = processAlive(ordinary.pid);
        await appendFile(process.argv[2], JSON.stringify({ label: "observed", initialAlive, ordinaryAlive }) + "\\n");
        process.kill(ordinary.pid, "SIGTERM");
        await worker.terminate();
      }, 1200);
      setTimeout(() => process.exit(0), 1400);
    `);

    const child = spawn("bash", [launcher, "--", process.execPath, fixturePath, eventsPath], {
      env: {
        ...process.env,
        MUXPILOT_CODEX_CHILD_OBSERVATION_MS: "20",
        MUXPILOT_CODEX_CHILD_STABLE_MS: "80",
        MUXPILOT_CODEX_CHILD_LEARNING_MS: "500",
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
    expect(events[0].ownerTid).not.toBeNull();
    expect(events[0].ownerTid).not.toBe(String(events[0].runtimePid));
    expect(events[3]).toMatchObject({ initialAlive: false, ordinaryAlive: true });
    expect(() => process.kill(events[1].pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  });
});

describe("Codex child supervisor reconciliation", () => {
  const child = (pid: number, command = "mcp-server") => ({ pid, command, startTime: pid, name: "node", executable: "node" });
  const timing = (now: number) => ({ now, learningStartedAt: 0, stableChildMs: 0, startupLearningMs: 100 });

  it("converges after an incomplete replacement observation", async () => {
    const state = new ChildSupervisorState();
    const original = child(10);
    const replacement = child(20);

    expect(state.reconcile([original], timing(0))).toEqual([]);
    await state.pruneExited([replacement], async (pid: number) => pid === original.pid ? original : null);
    expect(state.seenAt.has(original.pid)).toBe(true);
    expect(state.reconcile([replacement], timing(200))).toEqual([]);
    expect(state.reconcile([original, replacement], timing(300))).toEqual([original]);
  });

  it("retires each older process across successive replacements", () => {
    const state = new ChildSupervisorState();
    const original = child(10);
    const firstReplacement = child(20);
    const secondReplacement = child(30);

    state.reconcile([original], timing(0));
    expect(state.reconcile([original, firstReplacement], timing(200))).toEqual([original]);
    state.forget(original.pid);
    expect(state.reconcile([firstReplacement, secondReplacement], timing(300))).toEqual([firstReplacement]);
  });

  it("does not manage commands first observed after startup", () => {
    const state = new ChildSupervisorState();
    const first = child(10, "ordinary-task");
    const second = child(20, "ordinary-task");

    expect(state.reconcile([first], timing(200))).toEqual([]);
    expect(state.reconcile([first, second], timing(300))).toEqual([]);
    expect(state.managedProcesses.size).toBe(0);
  });
});
