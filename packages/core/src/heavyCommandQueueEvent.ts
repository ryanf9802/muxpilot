export const HEAVY_COMMAND_EVENT_TAG = "muxpilot_heavy_command";
export const HEAVY_COMMAND_QUEUE_EVENT_TAG = "muxpilot_heavy_command_queue";
export const HEAVY_COMMAND_EVENT_PAYLOAD_KEY = "muxpilotHeavyCommand";
export const HEAVY_COMMAND_QUEUE_PAYLOAD_KEY = "muxpilotHeavyCommandQueue";

export type HeavyCommandAutomationEventKind =
  | "queue_released"
  | "resume_requested"
  | "run_released"
  | "run_completed";
export type HeavyCommandOutcome = "passed" | "failed" | "terminated";

export interface HeavyCommandAutomationEvent {
  version: 1;
  kind: HeavyCommandAutomationEventKind;
  runId: string;
  commandDisplay: string;
  skill: "$muxpilot-heavy-command-queue";
  slot?: number;
  resumeCommand?: string;
  outcome?: HeavyCommandOutcome;
  exitCode?: number | null;
  signal?: string | null;
  durationMs?: number;
  logPath?: string;
  outputTail?: string;
  outputTruncated?: boolean;
}

export type HeavyCommandQueueEventKind = HeavyCommandAutomationEventKind;
export type HeavyCommandQueueEvent = HeavyCommandAutomationEvent;

export interface NormalizedHeavyCommandAutomationEvent {
  event: HeavyCommandAutomationEvent;
  rawText: string;
  legacy: boolean;
}
export type NormalizedHeavyCommandQueueEvent = NormalizedHeavyCommandAutomationEvent;

const RUN_ID = /^[a-z0-9]+-[a-f0-9]{12}$/;
const EVENT_PATTERN = /^<muxpilot_heavy_command>\s*([\s\S]*?)\s*<\/muxpilot_heavy_command>$/i;
const QUEUE_EVENT_PATTERN = /^<muxpilot_heavy_command_queue>\s*([\s\S]*?)\s*<\/muxpilot_heavy_command_queue>$/i;
const LEGACY_RESUME_PATTERN = /^Muxpilot reserved heavyweight slot (\d+) for run ([a-z0-9]+-[a-f0-9]{12})\.\nUse \$muxpilot-heavy-command-queue and run this exact command now:\n([\s\S]+)\nDo not replace it with a fresh heavyweight command\.$/;

export function serializeHeavyCommandAutomationEvent(event: HeavyCommandAutomationEvent): string {
  return `<${HEAVY_COMMAND_EVENT_TAG}>\n${JSON.stringify(event)}\n</${HEAVY_COMMAND_EVENT_TAG}>`;
}

export function serializeHeavyCommandQueueEvent(event: HeavyCommandAutomationEvent): string {
  return serializeHeavyCommandAutomationEvent(event);
}

export function normalizeHeavyCommandAutomationEvent(text: string): NormalizedHeavyCommandAutomationEvent | null {
  const cleaned = cleanText(text);
  const modern = cleaned.match(EVENT_PATTERN);
  const match = modern ?? cleaned.match(QUEUE_EVENT_PATTERN);
  if (match?.[1]) {
    try {
      const event = parseEvent(JSON.parse(match[1]) as unknown);
      return event ? { event, rawText: cleaned, legacy: !modern } : null;
    } catch {
      return null;
    }
  }

  const legacy = cleaned.match(LEGACY_RESUME_PATTERN);
  if (!legacy?.[1] || !legacy[2] || !legacy[3]) return null;
  const slot = Number(legacy[1]);
  if (!Number.isSafeInteger(slot) || slot < 0) return null;
  return {
    event: {
      version: 1,
      kind: "resume_requested",
      runId: legacy[2],
      commandDisplay: legacy[3],
      skill: "$muxpilot-heavy-command-queue",
      slot,
      resumeCommand: legacy[3]
    },
    rawText: cleaned,
    legacy: true
  };
}

export function normalizeHeavyCommandQueueEvent(text: string): NormalizedHeavyCommandAutomationEvent | null {
  return normalizeHeavyCommandAutomationEvent(text);
}

export function heavyCommandAutomationEventSummary(event: HeavyCommandAutomationEvent): string {
  if (event.kind === "queue_released") return "Heavyweight command queued · session released while waiting";
  if (event.kind === "resume_requested") return "Heavyweight slot ready · session resumed automatically";
  if (event.kind === "run_released") return "Heavyweight command running · session released until completion";
  const duration = event.durationMs === undefined ? "" : ` in ${formatDuration(event.durationMs)}`;
  if (event.outcome === "passed") return `Heavyweight command passed${duration}`;
  if (event.outcome === "terminated") return `Heavyweight command terminated${duration}`;
  return `Heavyweight command failed${duration}`;
}

export function heavyCommandQueueEventSummary(event: HeavyCommandAutomationEvent): string {
  return heavyCommandAutomationEventSummary(event);
}

export function heavyCommandAutomationEventDirection(event: HeavyCommandAutomationEvent): string {
  return event.kind === "queue_released" || event.kind === "run_released" ? "Agent → Muxpilot" : "Muxpilot → Agent";
}

export function heavyCommandQueueEventDirection(event: HeavyCommandAutomationEvent): string {
  return heavyCommandAutomationEventDirection(event);
}

export function heavyCommandQueueCommandSummary(event: HeavyCommandAutomationEvent, maxLength = 96): string {
  const command = event.commandDisplay.replace(/\s+/g, " ").trim();
  return command.length <= maxLength ? command : `${command.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

export function heavyCommandAutomationEventFromPayload(payload: Record<string, unknown>): NormalizedHeavyCommandAutomationEvent | null {
  const value = payload[HEAVY_COMMAND_EVENT_PAYLOAD_KEY] ?? payload[HEAVY_COMMAND_QUEUE_PAYLOAD_KEY];
  if (!isRecord(value)) return null;
  const event = parseEvent(value.event);
  const rawText = typeof value.rawText === "string" ? value.rawText : "";
  if (!event || !rawText) return null;
  return { event, rawText, legacy: value.legacy === true };
}

export function heavyCommandQueueEventFromPayload(payload: Record<string, unknown>): NormalizedHeavyCommandAutomationEvent | null {
  return heavyCommandAutomationEventFromPayload(payload);
}

export function withHeavyCommandAutomationEventPayload(
  payload: Record<string, unknown>,
  normalized: NormalizedHeavyCommandAutomationEvent
): Record<string, unknown> {
  const value = {
    event: normalized.event,
    rawText: normalized.rawText,
    legacy: normalized.legacy
  };
  return { ...payload, [HEAVY_COMMAND_QUEUE_PAYLOAD_KEY]: value };
}

export function withHeavyCommandQueueEventPayload(
  payload: Record<string, unknown>,
  normalized: NormalizedHeavyCommandAutomationEvent
): Record<string, unknown> {
  return withHeavyCommandAutomationEventPayload(payload, normalized);
}

function parseEvent(value: unknown): HeavyCommandAutomationEvent | null {
  if (!isRecord(value) || value.version !== 1 || !RUN_ID.test(String(value.runId))) return null;
  if (!["queue_released", "resume_requested", "run_released", "run_completed"].includes(String(value.kind))) return null;
  if (typeof value.commandDisplay !== "string" || !value.commandDisplay.trim()) return null;
  if (value.skill !== "$muxpilot-heavy-command-queue") return null;
  const base: HeavyCommandAutomationEvent = {
    version: 1,
    kind: value.kind as HeavyCommandAutomationEventKind,
    runId: String(value.runId),
    commandDisplay: value.commandDisplay,
    skill: "$muxpilot-heavy-command-queue"
  };
  if (value.kind === "queue_released" || value.kind === "run_released") return base;
  if (value.kind === "resume_requested") {
    if (!Number.isSafeInteger(value.slot) || Number(value.slot) < 0) return null;
    if (typeof value.resumeCommand !== "string" || !value.resumeCommand.trim()) return null;
    return { ...base, slot: Number(value.slot), resumeCommand: value.resumeCommand };
  }
  if (value.outcome !== "passed" && value.outcome !== "failed" && value.outcome !== "terminated") return null;
  if (value.exitCode !== null && !Number.isInteger(value.exitCode)) return null;
  if (value.signal !== null && typeof value.signal !== "string") return null;
  if (!Number.isSafeInteger(value.durationMs) || Number(value.durationMs) < 0) return null;
  if (typeof value.logPath !== "string" || !value.logPath) return null;
  if (value.outputTail !== undefined && typeof value.outputTail !== "string") return null;
  if (value.outputTruncated !== undefined && typeof value.outputTruncated !== "boolean") return null;
  return {
    ...base,
    outcome: value.outcome,
    exitCode: value.exitCode as number | null,
    signal: value.signal as string | null,
    durationMs: Number(value.durationMs),
    logPath: value.logPath,
    ...(value.outputTail === undefined ? {} : { outputTail: value.outputTail as string }),
    ...(value.outputTruncated === undefined ? {} : { outputTruncated: value.outputTruncated as boolean })
  };
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function cleanText(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\r/g, "").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
