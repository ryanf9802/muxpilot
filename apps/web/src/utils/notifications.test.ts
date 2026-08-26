import { describe, expect, it } from "vitest";
import { notificationToastMessage } from "./notifications.js";

describe("notificationToastMessage", () => {
  it("shows only the new status in a concise message", () => {
    expect(
      notificationToastMessage({
        deviceId: "device-test",
        sessionId: "session-1",
        sessionName: "muxpilot",
        rules: ["status_change"],
        previousStatus: "working",
        status: "plan_ready",
        severity: "red",
        title: "Status changed",
        body: "muxpilot: plan ready",
        url: "/sessions/session-1"
      })
    ).toBe("muxpilot: plan ready");
  });

  it("identifies the child that caused a rolled-up tree notification", () => {
    expect(
      notificationToastMessage({
        deviceId: "device-test",
        sessionId: "parent",
        sessionName: "parent",
        sourceSessionId: "child",
        sourceSessionName: "child",
        rules: ["approval_gate"],
        previousStatus: "working",
        status: "approval",
        severity: "red",
        title: "Approval gate",
        body: "parent · child: approval",
        url: "/sessions/child"
      })
    ).toBe("parent · child: approval");
  });
});
