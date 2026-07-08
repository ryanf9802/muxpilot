import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CodexProcessInfo {
  pid: number;
  sessionId: string | null;
  startedAtMs: number | null;
}

interface ProcessCandidate {
  pid: number;
  argv: string[];
  startedAtMs: number | null;
}

export class CodexProcessResolver {
  private clockTicksPerSecond: Promise<number> | null = null;
  private bootTimeMs: Promise<number | null> | null = null;

  async resolveForPane(panePid: number): Promise<CodexProcessInfo | null> {
    if (!Number.isFinite(panePid) || panePid <= 0) return null;

    try {
      const pids = await this.descendantPids(panePid);
      const candidates = (await Promise.all(pids.map((pid) => this.processCandidate(pid)))).filter(
        (candidate): candidate is ProcessCandidate => Boolean(candidate)
      );
      const codex = candidates.filter((candidate) => isCodexArgv(candidate.argv));
      if (codex.length === 0) return null;

      const resumed = codex.find((candidate) => resumedSessionId(candidate.argv));
      const match = resumed ?? codex.sort((a, b) => (a.startedAtMs ?? 0) - (b.startedAtMs ?? 0))[0];
      if (!match) return null;

      return {
        pid: match.pid,
        sessionId: resumedSessionId(match.argv),
        startedAtMs: match.startedAtMs
      };
    } catch {
      return null;
    }
  }

  private async descendantPids(rootPid: number): Promise<number[]> {
    const seen = new Set<number>();
    const pending = [rootPid];
    while (pending.length > 0) {
      const pid = pending.shift();
      if (!pid || seen.has(pid)) continue;
      seen.add(pid);
      const children = await readChildren(pid).catch(() => []);
      pending.push(...children);
    }
    return Array.from(seen);
  }

  private async processCandidate(pid: number): Promise<ProcessCandidate | null> {
    const argv = await readArgv(pid).catch(() => []);
    if (argv.length === 0) return null;
    return {
      pid,
      argv,
      startedAtMs: await this.processStartedAtMs(pid)
    };
  }

  private async processStartedAtMs(pid: number): Promise<number | null> {
    const bootTimeMs = await this.getBootTimeMs();
    if (bootTimeMs === null) return null;
    const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
    const startTicks = processStartTicks(stat);
    if (startTicks === null) return null;
    const ticksPerSecond = await this.getClockTicksPerSecond();
    return bootTimeMs + (startTicks / ticksPerSecond) * 1000;
  }

  private async getClockTicksPerSecond(): Promise<number> {
    this.clockTicksPerSecond ??= execFileAsync("getconf", ["CLK_TCK"])
      .then(({ stdout }) => {
        const parsed = Number(stdout.trim());
        return Number.isFinite(parsed) && parsed > 0 ? parsed : 100;
      })
      .catch(() => 100);
    return this.clockTicksPerSecond;
  }

  private async getBootTimeMs(): Promise<number | null> {
    this.bootTimeMs ??= readFile("/proc/stat", "utf8")
      .then((text) => {
        const line = text.split("\n").find((item) => item.startsWith("btime "));
        const seconds = Number(line?.split(/\s+/)[1]);
        return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
      })
      .catch(() => null);
    return this.bootTimeMs;
  }
}

async function readChildren(pid: number): Promise<number[]> {
  const text = await readFile(`/proc/${pid}/task/${pid}/children`, "utf8");
  return text
    .trim()
    .split(/\s+/)
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);
}

async function readArgv(pid: number): Promise<string[]> {
  const buffer = await readFile(`/proc/${pid}/cmdline`);
  return buffer
    .toString("utf8")
    .split("\0")
    .map((part) => part.trim())
    .filter(Boolean);
}

function isCodexArgv(argv: string[]): boolean {
  return argv.some((part) => {
    const name = basename(part);
    return name === "codex" || part.includes("/@openai/codex/") || part.includes("/@openai/codex-");
  });
}

function resumedSessionId(argv: string[]): string | null {
  const resumeIndex = argv.findIndex((part) => part === "resume");
  if (resumeIndex < 0) return null;
  const candidate = argv[resumeIndex + 1];
  return candidate && /^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(candidate) ? candidate : null;
}

function processStartTicks(stat: string): number | null {
  const endOfCommand = stat.lastIndexOf(")");
  if (endOfCommand < 0) return null;
  const fields = stat
    .slice(endOfCommand + 2)
    .trim()
    .split(/\s+/);
  const ticks = Number(fields[19]);
  return Number.isFinite(ticks) && ticks >= 0 ? ticks : null;
}
