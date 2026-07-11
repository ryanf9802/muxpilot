import { describe, expect, it } from "vitest";
import { parseConfig, requiresOperatorToken } from "../src/config/config.js";

describe("config LAN access validation", () => {
  it("defaults to loopback trusted local access", () => {
    const config = parseConfig({});

    expect(config.lanEnabled).toBe(false);
    expect(config.host).toBe("127.0.0.1");
    expect(config.operatorToken).toMatch(/^[a-z]+-[a-z]+-\d{2}-[a-z]+-[a-z]+-\d{2}$/);
    expect(requiresOperatorToken(config)).toBe(false);
  });

  it("enables LAN binding when MUXPILOT_LAN_ENABLED is set", () => {
    const config = parseConfig({
      MUXPILOT_LAN_ENABLED: "1"
    });

    expect(config.lanEnabled).toBe(true);
    expect(config.host).toBe("0.0.0.0");
    expect(config.operatorToken).toMatch(/^[a-z]+-[a-z]+-\d{2}-[a-z]+-[a-z]+-\d{2}$/);
    expect(requiresOperatorToken(config)).toBe(true);
  });

  it("accepts HTTPS as the published web protocol", () => {
    const config = parseConfig({
      MUXPILOT_WEB_PROTOCOL: "https"
    });

    expect(config.webProtocol).toBe("https");
  });

  it("parses PWA trust settings", () => {
    const config = parseConfig({
      MUXPILOT_PWA_TRUST_PORT: "12881",
      MUXPILOT_PWA_TRUST_DIR: "./.certs/pwa/trust"
    });

    expect(config.pwaTrustPort).toBe(12881);
    expect(config.pwaTrustDir).toMatch(/\.certs\/pwa\/trust$/);
  });

  it("rejects invalid web protocol values", () => {
    expect(() =>
      parseConfig({
        MUXPILOT_WEB_PROTOCOL: "ftp"
      })
    ).toThrow();
  });

  it("generates a different operator token for each backend config parse", () => {
    const first = parseConfig({ MUXPILOT_LAN_ENABLED: "1" });
    const second = parseConfig({ MUXPILOT_LAN_ENABLED: "1" });

    expect(first.operatorToken).not.toBe(second.operatorToken);
  });

  it("rejects invalid LAN flag values", () => {
    expect(() =>
      parseConfig({
        MUXPILOT_LAN_ENABLED: "sometimes"
      })
    ).toThrow();
  });

  it("generates an ephemeral session secret when one is not configured", () => {
    const first = parseConfig({
      MUXPILOT_LAN_ENABLED: "1"
    });
    const second = parseConfig({
      MUXPILOT_LAN_ENABLED: "1"
    });

    expect(first.sessionSecret).toHaveLength(43);
    expect(second.sessionSecret).toHaveLength(43);
    expect(first.sessionSecret).not.toBe(second.sessionSecret);
  });

  it("preserves advanced explicit host overrides", () => {
    const config = parseConfig({
      MUXPILOT_HOST: "192.168.1.25",
      MUXPILOT_OPERATOR_TOKEN: "replace-with-long-token",
      MUXPILOT_SESSION_SECRET: "test-secret-at-least-16-chars",
      MUXPILOT_CORS_ORIGINS: "https://example.test,https://phone.example.test"
    });

    expect(config.lanEnabled).toBe(false);
    expect(config.host).toBe("192.168.1.25");
    expect(config.operatorToken).toBe("replace-with-long-token");
    expect(requiresOperatorToken(config)).toBe(true);
    expect(config.corsOrigins).toEqual(["https://example.test", "https://phone.example.test"]);
  });

  it("accepts an optional session transfer key and rejects short keys", () => {
    expect(parseConfig({}).sessionFileKey).toBeUndefined();
    expect(parseConfig({ MUXPILOT_SESSION_FILE_KEY: "correct horse battery staple" }).sessionFileKey).toBe("correct horse battery staple");
    expect(() => parseConfig({ MUXPILOT_SESSION_FILE_KEY: "too-short" })).toThrow();
  });
});
