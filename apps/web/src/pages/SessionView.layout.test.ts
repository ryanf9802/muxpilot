import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8");

describe("mobile session viewport layout", () => {
  it("sizes the narrow app shell from measured visual viewport variables", () => {
    const mobileStyles = cssBlock(styles, "@media (max-width: 819px)");
    const appRule = cssBlock(mobileStyles, ".app");
    const textareaRule = cssBlock(mobileStyles, ".skill-textarea textarea,\n  .skill-textarea-mirror");
    expect(appRule).toContain("position: fixed;");
    expect(appRule).toContain("top: var(--app-viewport-offset-top, 0px);");
    expect(appRule).toContain("height: var(--app-viewport-height, 100dvh);");
    expect(textareaRule).toContain("var(--app-viewport-unit, 1dvh)");
  });

  it("keeps the composer at the bottom while queued content shrinks first", () => {
    const sessionRule = cssBlock(styles, ".session-view");
    const stackRule = cssBlock(styles, ".composer-stack");
    const composerRule = cssBlock(styles, ".composer");
    const queuedRule = cssBlock(styles, ".queued-inputs");
    expect(sessionRule).toContain("grid-template-rows: auto auto minmax(0, 1fr) minmax(0, max-content);");
    expect(stackRule).toContain("display: flex;");
    expect(stackRule).toContain("flex-direction: column;");
    expect(stackRule).toContain("justify-content: flex-end;");
    expect(stackRule).toContain("min-height: 0;");
    expect(composerRule).toContain("flex: 0 0 auto;");
    expect(queuedRule).toContain("flex: 1 1 auto;");
    expect(queuedRule).toContain("min-height: 0;");
    expect(queuedRule).toContain("overflow-y: auto;");
  });
});

function cssBlock(source: string, selector: string): string {
  let selectorIndex = -1;
  let openingBrace = -1;
  while (true) {
    selectorIndex = source.indexOf(selector, selectorIndex + 1);
    if (selectorIndex < 0) throw new Error(`Missing CSS selector: ${selector}`);
    const lineStart = source.lastIndexOf("\n", selectorIndex) + 1;
    openingBrace = source.indexOf("{", selectorIndex + selector.length);
    const startsRule = source.slice(lineStart, selectorIndex).trim() === "";
    const endsSelector = openingBrace >= 0 && source.slice(selectorIndex + selector.length, openingBrace).trim() === "";
    if (startsRule && endsSelector) break;
  }
  let depth = 1;
  for (let index = openingBrace + 1; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(openingBrace + 1, index);
  }
  throw new Error(`Missing closing brace for: ${selector}`);
}
