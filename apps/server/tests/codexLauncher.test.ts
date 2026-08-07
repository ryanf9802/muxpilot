import { execFile, spawn } from "node:child_process";
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
});
