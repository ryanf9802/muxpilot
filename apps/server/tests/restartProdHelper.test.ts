import { describe, expect, it } from "vitest";
import { hostScopedHeavyEnvironment } from "../../../.agents/skills/muxpilot-restart-prod/scripts/restart-environment.mjs";

describe("muxpilot production restart helper", () => {
  it("keeps heavyweight scheduler waiting attached to the host-scoped verifier", () => {
    expect(hostScopedHeavyEnvironment({
      MUXPILOT_HEAVY_QUEUE_ENABLED: "1",
      EXISTING: "value"
    })).toEqual({
      MUXPILOT_HEAVY_QUEUE_ENABLED: "0",
      EXISTING: "value"
    });
  });
});
