import { describe, expect, it } from "vitest";
import { highestPrioritySession } from "./sessionStatus.js";

describe("highestPrioritySession", () => {
  it("prefers attention over active work and active work over ready states", () => {
    const waiting = { id: "parent", status: "waiting" as const };
    const working = { id: "worker", status: "working" as const };
    const approval = { id: "approval", status: "approval" as const };

    expect(highestPrioritySession([waiting, working])).toBe(working);
    expect(highestPrioritySession([waiting, working, approval])).toBe(approval);
  });

  it("treats unknown state as active rather than ready", () => {
    const waiting = { id: "parent", status: "waiting" as const };
    const unknown = { id: "child", status: "unknown" as const };

    expect(highestPrioritySession([waiting, unknown])).toBe(unknown);
  });
});
