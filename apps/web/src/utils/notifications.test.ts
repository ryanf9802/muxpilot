import { describe, expect, it } from "vitest";
import { notificationToastMessage } from "./notifications.js";

describe("notificationToastMessage", () => {
  it("shows only the new status in a concise message", () => {
    expect(
      notificationToastMessage({
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
});
