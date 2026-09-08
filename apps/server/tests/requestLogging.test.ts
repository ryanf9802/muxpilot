import { describe, expect, it } from "vitest";
import { requestLogLevel, slowRequestThresholdMs } from "../src/services/requestLogging.js";

describe("request logging policy", () => {
  it("defaults to 250ms and accepts a non-negative override", () => {
    expect(slowRequestThresholdMs({})).toBe(250);
    expect(slowRequestThresholdMs({ MUXPILOT_SLOW_REQUEST_MS: "750" })).toBe(750);
    expect(slowRequestThresholdMs({ MUXPILOT_SLOW_REQUEST_MS: "invalid" })).toBe(250);
  });

  it("logs only errors and slow responses at the appropriate level", () => {
    expect(requestLogLevel(200, 249, 250)).toBeNull();
    expect(requestLogLevel(200, 250, 250)).toBe("warn");
    expect(requestLogLevel(404, 10, 250)).toBe("warn");
    expect(requestLogLevel(500, 10, 250)).toBe("error");
  });
});
