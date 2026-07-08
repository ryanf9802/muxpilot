import { describe, expect, it } from "vitest";
import { matchingNotificationRules } from "../src/services/notifications.js";

describe("matchingNotificationRules", () => {
  it("fires done task only for yellow to waiting transitions", () => {
    const settings = { globalRules: [], sessionRules: { a: ["done_task" as const] } };

    expect(matchingNotificationRules(settings, "a", "working", "waiting")).toEqual(["done_task"]);
    expect(matchingNotificationRules(settings, "a", "waiting", "waiting")).toEqual([]);
    expect(matchingNotificationRules(settings, "a", "approval", "waiting")).toEqual([]);
  });

  it("fires approval gate for red target statuses", () => {
    const settings = { globalRules: ["approval_gate" as const], sessionRules: {} };

    expect(matchingNotificationRules(settings, "a", "working", "approval")).toEqual(["approval_gate"]);
    expect(matchingNotificationRules(settings, "a", "working", "question")).toEqual(["approval_gate"]);
    expect(matchingNotificationRules(settings, "a", "working", "waiting")).toEqual([]);
  });

  it("fires status change on any actual transition", () => {
    const settings = { globalRules: ["status_change" as const], sessionRules: {} };

    expect(matchingNotificationRules(settings, "a", "working", "planning")).toEqual(["status_change"]);
    expect(matchingNotificationRules(settings, "a", "working", "working")).toEqual([]);
  });

  it("combines overlapping global and session rules once", () => {
    const settings = {
      globalRules: ["status_change" as const, "done_task" as const],
      sessionRules: { a: ["done_task" as const, "approval_gate" as const] }
    };

    expect(matchingNotificationRules(settings, "a", "working", "waiting")).toEqual(["done_task", "status_change"]);
  });
});
