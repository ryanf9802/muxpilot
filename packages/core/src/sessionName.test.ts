import { describe, expect, it } from "vitest";
import { isValidSessionName, normalizeSessionName, normalizeSessionNameInput } from "./sessionName.js";

describe("normalizeSessionName", () => {
  it("lowercases names and converts spaces to hyphens", () => {
    expect(normalizeSessionName("My Session")).toBe("my-session");
  });

  it("collapses punctuation and separator runs", () => {
    expect(normalizeSessionName("  Fix!!!   The---Thing  ")).toBe("fix-the-thing");
  });

  it("removes leading and trailing separators", () => {
    expect(normalizeSessionName("---ready---")).toBe("ready");
  });

  it("normalizes diacritics before enforcing ascii slugs", () => {
    expect(normalizeSessionName("Café Work")).toBe("cafe-work");
  });

  it("truncates to the max length and removes a trailing separator after truncation", () => {
    expect(normalizeSessionName("abcdefghijklmnopqrstuvwxyzabcde-a")).toBe("abcdefghijklmnopqrstuvwxyzabcde");
  });

  it("preserves a trailing separator in input drafts", () => {
    expect(normalizeSessionNameInput("My ")).toBe("my-");
  });
});

describe("isValidSessionName", () => {
  it("accepts 2-32 character lowercase slug names", () => {
    expect(isValidSessionName("ab")).toBe(true);
    expect(isValidSessionName("work-session-2")).toBe(true);
    expect(isValidSessionName("abcdefghijklmnopqrstuvwxyzabcdef")).toBe(true);
  });

  it("rejects empty, one-character, overlong, or non-slug names", () => {
    expect(isValidSessionName("")).toBe(false);
    expect(isValidSessionName("a")).toBe(false);
    expect(isValidSessionName("abcdefghijklmnopqrstuvwxyzabcdefg")).toBe(false);
    expect(isValidSessionName("Work Session")).toBe(false);
    expect(isValidSessionName("work-")).toBe(false);
  });
});
