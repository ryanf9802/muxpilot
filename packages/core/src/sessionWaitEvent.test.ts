import { describe, expect, it } from "vitest";
import {
  normalizeSessionWaitEvent,
  serializeSessionWaitEvent,
  sessionWaitEventFromPayload,
  withSessionWaitEventPayload
} from "./sessionWaitEvent.js";

describe("session wait transcript events", () => {
  it("round trips a versioned event and preserves wrapper payload", () => {
    const event = { version: 1 as const, kind: "resume_requested" as const, sessions: [{ id: "child-1" }] };
    const normalized = normalizeSessionWaitEvent(serializeSessionWaitEvent(event));

    expect(normalized?.event).toEqual(event);
    expect(sessionWaitEventFromPayload(withSessionWaitEventPayload({ source: "codex" }, normalized!))).toEqual(event);
  });

  it("rejects embedded, malformed, and unknown-version markers", () => {
    expect(normalizeSessionWaitEvent(`prefix ${serializeSessionWaitEvent({ version: 1, kind: "timeout", sessions: [] })}`)).toBeNull();
    expect(normalizeSessionWaitEvent('<muxpilot_session_wait>{"version":2,"kind":"timeout","sessions":[]}</muxpilot_session_wait>')).toBeNull();
    expect(normalizeSessionWaitEvent('<muxpilot_session_wait>{"version":1,"kind":"other","sessions":[]}</muxpilot_session_wait>')).toBeNull();
  });
});
