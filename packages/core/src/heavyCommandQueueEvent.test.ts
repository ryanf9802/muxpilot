import { describe, expect, it } from "vitest";
import {
  heavyCommandQueueCommandSummary,
  normalizeHeavyCommandQueueEvent,
  serializeHeavyCommandQueueEvent
} from "./heavyCommandQueueEvent.js";

describe("heavy command queue transcript events", () => {
  it("round trips a resume request without changing its exact command", () => {
    const resumeCommand = `'node' '/skills/run.mjs' '--heavy' '--resume' 'mabc-012345abcdef' '--' 'node' '-e' 'console.log("quoted")'`;
    const raw = serializeHeavyCommandQueueEvent({
      version: 1,
      kind: "resume_requested",
      runId: "mabc-012345abcdef",
      commandDisplay: `node -e "console.log('quoted')"`,
      skill: "$muxpilot-heavy-command-queue",
      slot: 1,
      resumeCommand
    });

    expect(normalizeHeavyCommandQueueEvent(raw)).toMatchObject({
      legacy: false,
      event: { kind: "resume_requested", slot: 1, resumeCommand }
    });
  });

  it("recognizes the previous resume prompt but rejects malformed protocol lookalikes", () => {
    const legacy = [
      "Muxpilot reserved heavyweight slot 0 for run mabc-012345abcdef.",
      "Use $muxpilot-heavy-command-queue and run this exact command now:",
      "'node' '/skills/run.mjs' '--heavy' '--resume' 'mabc-012345abcdef' '--' 'make' 'lint'",
      "Do not replace it with a fresh heavyweight command."
    ].join("\n");
    expect(normalizeHeavyCommandQueueEvent(legacy)).toMatchObject({ legacy: true, event: { kind: "resume_requested", slot: 0 } });
    expect(normalizeHeavyCommandQueueEvent("Muxpilot reserved heavyweight slot someday")).toBeNull();
    expect(normalizeHeavyCommandQueueEvent("<muxpilot_heavy_command_queue>{\"version\":2}</muxpilot_heavy_command_queue>")).toBeNull();
  });

  it("shortens only the display summary", () => {
    const event = normalizeHeavyCommandQueueEvent(serializeHeavyCommandQueueEvent({
      version: 1,
      kind: "queue_released",
      runId: "mabc-012345abcdef",
      commandDisplay: "a very long heavyweight command",
      skill: "$muxpilot-heavy-command-queue"
    }))!.event;
    expect(heavyCommandQueueCommandSummary(event, 12)).toBe("a very long…");
    expect(event.commandDisplay).toBe("a very long heavyweight command");
  });

  it("round trips released and completed runs with compact terminal metadata", () => {
    expect(normalizeHeavyCommandQueueEvent(serializeHeavyCommandQueueEvent({
      version: 1,
      kind: "run_released",
      runId: "mabc-012345abcdef",
      commandDisplay: "pnpm test",
      skill: "$muxpilot-heavy-command-queue"
    }))).toMatchObject({ legacy: false, event: { kind: "run_released" } });

    expect(normalizeHeavyCommandQueueEvent(serializeHeavyCommandQueueEvent({
      version: 1,
      kind: "run_completed",
      runId: "mabc-012345abcdef",
      commandDisplay: "pnpm test",
      skill: "$muxpilot-heavy-command-queue",
      outcome: "failed",
      exitCode: 1,
      signal: null,
      durationMs: 12_345,
      logPath: "/session/heavy-commands/run.log",
      outputTail: "failed assertion",
      outputTruncated: true
    }))).toMatchObject({
      legacy: false,
      event: {
        kind: "run_completed",
        outcome: "failed",
        exitCode: 1,
        outputTail: "failed assertion",
        outputTruncated: true
      }
    });
  });

  it("continues to accept the original queue tag", () => {
    const raw = `<muxpilot_heavy_command_queue>\n${JSON.stringify({
      version: 1,
      kind: "queue_released",
      runId: "mabc-012345abcdef",
      commandDisplay: "make lint",
      skill: "$muxpilot-heavy-command-queue"
    })}\n</muxpilot_heavy_command_queue>`;
    expect(normalizeHeavyCommandQueueEvent(raw)).toMatchObject({ legacy: true, event: { kind: "queue_released" } });
  });
});
