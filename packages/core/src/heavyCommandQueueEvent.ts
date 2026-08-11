export const HEAVY_COMMAND_QUEUE_EVENT_TAG = "muxpilot_heavy_command_queue";
export const HEAVY_COMMAND_QUEUE_PAYLOAD_KEY = "muxpilotHeavyCommandQueue";

export type HeavyCommandQueueEventKind = "queue_released" | "resume_requested";

export interface HeavyCommandQueueEvent {
  version: 1;
  kind: HeavyCommandQueueEventKind;
  runId: string;
  commandDisplay: string;
  skill: "$muxpilot-heavy-command-queue";
  slot?: number;
  resumeCommand?: string;
}

export interface NormalizedHeavyCommandQueueEvent {
  event: HeavyCommandQueueEvent;
  rawText: string;
  legacy: boolean;
}

const RUN_ID = /^[a-z0-9]+-[a-f0-9]{12}$/;
const EVENT_PATTERN = /^<muxpilot_heavy_command_queue>\s*([\s\S]*?)\s*<\/muxpilot_heavy_command_queue>$/i;
const LEGACY_RESUME_PATTERN = /^Muxpilot reserved heavyweight slot (\d+) for run ([a-z0-9]+-[a-f0-9]{12})\.\nUse \$muxpilot-heavy-command-queue and run this exact command now:\n([\s\S]+)\nDo not replace it with a fresh heavyweight command\.$/;

export function serializeHeavyCommandQueueEvent(event: HeavyCommandQueueEvent): string {
  return `<${HEAVY_COMMAND_QUEUE_EVENT_TAG}>\n${JSON.stringify(event)}\n</${HEAVY_COMMAND_QUEUE_EVENT_TAG}>`;
}

export function normalizeHeavyCommandQueueEvent(text: string): NormalizedHeavyCommandQueueEvent | null {
  const cleaned = cleanText(text);
  const match = cleaned.match(EVENT_PATTERN);
  if (match?.[1]) {
    try {
      const event = parseEvent(JSON.parse(match[1]) as unknown);
      return event ? { event, rawText: cleaned, legacy: false } : null;
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

export function heavyCommandQueueEventSummary(event: HeavyCommandQueueEvent): string {
  return event.kind === "queue_released"
    ? "Heavyweight command queued · session released while waiting"
    : "Heavyweight slot ready · session resumed automatically";
}

export function heavyCommandQueueEventDirection(event: HeavyCommandQueueEvent): string {
  return event.kind === "queue_released" ? "Agent → Muxpilot" : "Muxpilot → Agent";
}

export function heavyCommandQueueCommandSummary(event: HeavyCommandQueueEvent, maxLength = 96): string {
  const command = event.commandDisplay.replace(/\s+/g, " ").trim();
  return command.length <= maxLength ? command : `${command.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

export function heavyCommandQueueEventFromPayload(payload: Record<string, unknown>): NormalizedHeavyCommandQueueEvent | null {
  const value = payload[HEAVY_COMMAND_QUEUE_PAYLOAD_KEY];
  if (!isRecord(value)) return null;
  const event = parseEvent(value.event);
  const rawText = typeof value.rawText === "string" ? value.rawText : "";
  if (!event || !rawText) return null;
  return { event, rawText, legacy: value.legacy === true };
}

export function withHeavyCommandQueueEventPayload(
  payload: Record<string, unknown>,
  normalized: NormalizedHeavyCommandQueueEvent
): Record<string, unknown> {
  return {
    ...payload,
    [HEAVY_COMMAND_QUEUE_PAYLOAD_KEY]: {
      event: normalized.event,
      rawText: normalized.rawText,
      legacy: normalized.legacy
    }
  };
}

function parseEvent(value: unknown): HeavyCommandQueueEvent | null {
  if (!isRecord(value) || value.version !== 1 || !RUN_ID.test(String(value.runId))) return null;
  if (value.kind !== "queue_released" && value.kind !== "resume_requested") return null;
  if (typeof value.commandDisplay !== "string" || !value.commandDisplay.trim()) return null;
  if (value.skill !== "$muxpilot-heavy-command-queue") return null;
  const base: HeavyCommandQueueEvent = {
    version: 1,
    kind: value.kind,
    runId: String(value.runId),
    commandDisplay: value.commandDisplay,
    skill: "$muxpilot-heavy-command-queue"
  };
  if (value.kind === "queue_released") return base;
  if (!Number.isSafeInteger(value.slot) || Number(value.slot) < 0) return null;
  if (typeof value.resumeCommand !== "string" || !value.resumeCommand.trim()) return null;
  return { ...base, slot: Number(value.slot), resumeCommand: value.resumeCommand };
}

function cleanText(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\r/g, "").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
