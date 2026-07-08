import { describe, expect, it } from "vitest";
import { hasCompleteProposedPlan, hasIncompleteProposedPlan } from "./proposedPlan.js";

describe("hasCompleteProposedPlan", () => {
  it("detects complete proposed plan blocks", () => {
    expect(hasCompleteProposedPlan("<proposed_plan>\nDo it.\n</proposed_plan>")).toBe(true);
    expect(hasCompleteProposedPlan("Before\n<proposed_plan>\nDo it.\n</proposed_plan>\nAfter")).toBe(true);
  });

  it("rejects unclosed proposed plan blocks", () => {
    expect(hasCompleteProposedPlan("Before\n<proposed_plan>\nNo close")).toBe(false);
  });

  it("rejects normal assistant text", () => {
    expect(hasCompleteProposedPlan("Here is the plan without wrapper tags.")).toBe(false);
  });
});

describe("hasIncompleteProposedPlan", () => {
  it("detects unclosed proposed plan blocks", () => {
    expect(hasIncompleteProposedPlan("Before\n<proposed_plan>\nNo close")).toBe(true);
  });

  it("detects a later unclosed block after a complete block", () => {
    expect(hasIncompleteProposedPlan("<proposed_plan>\nFirst\n</proposed_plan>\n<proposed_plan>\nSecond")).toBe(true);
  });

  it("rejects complete proposed plan blocks and normal text", () => {
    expect(hasIncompleteProposedPlan("<proposed_plan>\nDo it.\n</proposed_plan>")).toBe(false);
    expect(hasIncompleteProposedPlan("Here is the plan without wrapper tags.")).toBe(false);
  });
});
