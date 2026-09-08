import { describe, expect, it } from "vitest";
import { assertConfiguredTmuxAvailable, probeTmuxCompatibility } from "../src/services/tmuxCompatibility.js";

describe("tmux compatibility", () => {
  it("accepts an installed executable without contacting a tmux server", async () => {
    await expect(probeTmuxCompatibility(async () => ({ stdout: "tmux 3.4\n" }))).resolves.toMatchObject({
      status: "available",
      available: true,
      version: "tmux 3.4"
    });
  });

  it("reports a missing executable", async () => {
    await expect(probeTmuxCompatibility(async () => {
      throw Object.assign(new Error("spawn tmux ENOENT"), { code: "ENOENT" });
    })).resolves.toMatchObject({ status: "executable_missing", available: false, version: null });
  });

  it("fails closed for other probe failures", async () => {
    await expect(probeTmuxCompatibility(async () => {
      throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
    })).resolves.toMatchObject({ status: "probe_failed", available: false, version: null });
  });

  it("fails startup when tmux is the explicit default but unavailable", () => {
    const unavailable = {
      status: "executable_missing" as const,
      available: false,
      version: null,
      detail: "tmux is not installed. Install tmux and restart muxpilot to enable the legacy runtime.",
      checkedAt: "2026-09-08T00:00:00.000Z"
    };

    expect(() => assertConfiguredTmuxAvailable("codex_tmux", unavailable)).toThrow(
      "MUXPILOT_DEFAULT_SESSION_DRIVER=codex_tmux requires tmux"
    );
    expect(() => assertConfiguredTmuxAvailable("codex_app_server", unavailable)).not.toThrow();
  });
});
