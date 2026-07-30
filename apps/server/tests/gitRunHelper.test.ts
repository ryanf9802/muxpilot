import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const helper = resolve(import.meta.dirname, "../../../skills/muxpilot-git-workflow/scripts/muxpilot-git-run.mjs");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("heavyweight validation helper", () => {
  it("serializes commands and reaps a stale lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-heavy-helper-"));
    roots.push(root);
    const leases = join(root, "leases");
    const output = join(root, "events.txt");
    await mkdir(join(leases, "slot-0"), { recursive: true });
    await writeFile(join(leases, "slot-0", "owner.json"), JSON.stringify({
      pid: 999_999_999,
      startedAt: Date.now()
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
    await expect(execFileAsync(process.execPath, [
      helper, "--heavy", "--", process.execPath, "-e", "process.exit(7)"
    ], {
      env: { ...process.env, MUXPILOT_HEAVY_VALIDATION_DIR: join(root, "leases") }
    })).rejects.toMatchObject({ code: 7 });
  });
});
