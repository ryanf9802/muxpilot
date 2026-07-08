import { describe, expect, it } from "vitest";
import {
  codeMirrorComposerFieldAttributes,
  credentialSuppressedField,
  freeformComposerField,
  noAutofillTextField,
  searchField
} from "./formFields.js";

describe("form field browser hints", () => {
  it("suppresses autofill and keyboard rewriting for technical text fields", () => {
    expect(noAutofillTextField).toMatchObject({
      autoComplete: "off",
      autoCorrect: "off",
      autoCapitalize: "none",
      spellCheck: false
    });
  });

  it("allows spelling help but disables autocomplete for composer text", () => {
    expect(freeformComposerField).toMatchObject({
      autoComplete: "off",
      autoCorrect: "off",
      autoCapitalize: "sentences",
      spellCheck: true,
      inputMode: "text"
    });
    expect(codeMirrorComposerFieldAttributes).toMatchObject({
      autocomplete: "off",
      autocorrect: "off",
      autocapitalize: "sentences",
      spellcheck: "true",
      inputmode: "text"
    });
  });

  it("marks search and credential fields with explicit intent", () => {
    expect(searchField).toMatchObject({
      type: "search",
      autoComplete: "off",
      autoCorrect: "off",
      autoCapitalize: "none",
      spellCheck: false,
      inputMode: "search"
    });
    expect(credentialSuppressedField).toMatchObject({
      autoComplete: "off",
      autoCorrect: "off",
      autoCapitalize: "none",
      spellCheck: false
    });
  });
});
