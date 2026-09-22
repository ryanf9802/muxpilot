import { describe, expect, it } from "vitest";
import {
  approvalDecisionEventFromPayload,
  approvalDecisionEventSummary,
  normalizeApprovalDecisionEvent,
  serializeApprovalDecisionEvent,
  withApprovalDecisionEventPayload
} from "./approvalDecisionEvent.js";

const event = {
  version: 1 as const,
  approvalId: "approval-1",
  decision: "approved" as const,
  guards: ["fixed-target", "no-pull-push"] as const,
  action: "Fetch origin/stage and retarget the session.",
  consequences: "The session target changes; no branch is pushed."
};

describe("approval decision transcript events", () => {
  it("round trips a complete approved decision with continuation prose", () => {
    const text = serializeApprovalDecisionEvent({ ...event, guards: [...event.guards] });
    const normalized = normalizeApprovalDecisionEvent(text);

    expect(normalized).toEqual({ event: { ...event, guards: [...event.guards] }, rawText: text });
    expect(approvalDecisionEventSummary(normalized!.event)).toBe("Muxpilot gate approved");
    expect(approvalDecisionEventFromPayload(withApprovalDecisionEventPayload({}, normalized!))).toEqual(normalized!.event);
  });

  it("recognizes denied decisions only with the matching continuation prose", () => {
    const denied = serializeApprovalDecisionEvent({ ...event, guards: [...event.guards], decision: "denied" });
    expect(normalizeApprovalDecisionEvent(denied)?.event.decision).toBe("denied");
    expect(normalizeApprovalDecisionEvent(denied.replace("were denied", "were approved"))).toBeNull();
  });

  it("leaves malformed, incomplete, and quoted examples untouched", () => {
    const text = serializeApprovalDecisionEvent({ ...event, guards: [...event.guards] });
    expect(normalizeApprovalDecisionEvent(`Example:\n${text}`)).toBeNull();
    expect(normalizeApprovalDecisionEvent(text.replace('"version":1', '"version":2'))).toBeNull();
    expect(normalizeApprovalDecisionEvent(text.replace('"action":"Fetch origin/stage and retarget the session."', '"action":""'))).toBeNull();
    expect(normalizeApprovalDecisionEvent(text.replace("Continue from the approval boundary.", "Continue."))).toBeNull();
  });
});
