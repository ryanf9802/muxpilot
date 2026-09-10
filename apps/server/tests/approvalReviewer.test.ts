import { describe, expect, it } from "vitest";
import { parseApprovalReview } from "../src/services/approvalReviewer.js";

describe("approval reviewer responses", () => {
  it("accepts a structured decision and bounds its explanation", () => {
    expect(parseApprovalReview('{"decision":"approve","explanation":"Required by the task"}')).toEqual({
      decision: "approve",
      explanation: "Required by the task"
    });
  });

  it("rejects malformed and unsupported decisions", () => {
    expect(() => parseApprovalReview("approve")).toThrow("no JSON");
    expect(() => parseApprovalReview('{"decision":"allow","explanation":"ok"}')).toThrow("invalid decision");
    expect(() => parseApprovalReview('{"decision":"escalate","explanation":""}')).toThrow("no explanation");
  });
});
