export const noAutofillTextField = {
  autoComplete: "off",
  autoCorrect: "off",
  autoCapitalize: "none",
  spellCheck: false
} as const;

export const freeformComposerField = {
  autoComplete: "off",
  autoCorrect: "off",
  autoCapitalize: "sentences",
  spellCheck: true,
  inputMode: "text"
} as const;

export const searchField = {
  type: "search",
  autoComplete: "off",
  autoCorrect: "off",
  autoCapitalize: "none",
  spellCheck: false,
  inputMode: "search"
} as const;

export const credentialSuppressedField = {
  autoComplete: "off",
  autoCorrect: "off",
  autoCapitalize: "none",
  spellCheck: false,
  "data-1p-ignore": "true",
  "data-bwignore": "true",
  "data-lpignore": "true",
  "data-form-type": "other"
} as const;

export const codeMirrorComposerFieldAttributes = {
  autocomplete: "off",
  autocorrect: "off",
  autocapitalize: "sentences",
  spellcheck: "true",
  inputmode: "text"
} as const;
