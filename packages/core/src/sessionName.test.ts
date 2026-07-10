import { describe, expect, it } from "vitest";
import { isValidSessionName, normalizeSessionName, normalizeSessionNameInput } from "./sessionName.js";

describe("Git-style session names", () => {
  it("preserves Git-valid case, paths, punctuation, and Unicode", () => {
    expect(normalizeSessionName("Feature/API_v2.é")).toBe("Feature/API_v2.é");
    expect(isValidSessionName("Feature/API_v2.é")).toBe(true);
  });

  it("normalizes forbidden characters and sequences while typing", () => {
    expect(normalizeSessionNameInput("Fix this:now..please@{x")).toBe("Fix-this-now-please-x");
    expect(normalizeSessionNameInput("My ")).toBe("My-");
  });

  it("trims invalid leading and final separators and limits length", () => {
    expect(normalizeSessionName("../Feature/Test.")).toBe("Feature/Test");
    expect(normalizeSessionName("abcdefghijklmnopqrstuvwxyzabcdef-extra")).toHaveLength(32);
  });

  it("accepts valid 2-32 character Git-style names", () => {
    expect(isValidSessionName("ab")).toBe(true);
    expect(isValidSessionName("release/v2_candidate")).toBe(true);
    expect(isValidSessionName("work-")).toBe(true);
  });

  it("rejects invalid ref forms", () => {
    for (const value of ["", "a", "@", "-work", ".work", "work/", "work.", "work..next", "work@{next", "work.lock", "a//b", "a b"]) {
      expect(isValidSessionName(value), value).toBe(false);
    }
  });
});
