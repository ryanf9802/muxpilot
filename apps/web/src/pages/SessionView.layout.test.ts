import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8");

describe("mobile session viewport layout", () => {
  it("keeps BTW drawer styling free of decorative effects", () => {
    const btwStart = styles.indexOf(".btw-drawer-backdrop {");
    const btwEnd = styles.indexOf(".git-workspace-panel {", btwStart);
    expect(btwStart).toBeGreaterThanOrEqual(0);
    expect(btwEnd).toBeGreaterThan(btwStart);
    const btwStyles = styles.slice(btwStart, btwEnd);
    expect(btwStyles).not.toContain("gradient(");
    expect(btwStyles).not.toContain("backdrop-filter:");
    expect(btwStyles).not.toContain("animation:");
  });

  it("sizes the narrow app shell from measured visual viewport variables", () => {
    const mobileStyles = cssBlock(styles, "@media (max-width: 819px)");
    const appRule = cssBlock(mobileStyles, ".app");
    const btwBackdropRule = cssBlock(mobileStyles, ".btw-drawer-backdrop");
    const textareaRule = cssBlock(mobileStyles, ".skill-textarea textarea,\n  .skill-textarea-mirror");
    expect(appRule).toContain("position: fixed;");
    expect(appRule).toContain("top: var(--app-viewport-offset-top, 0px);");
    expect(appRule).toContain("height: var(--app-viewport-height, 100dvh);");
    expect(btwBackdropRule).toContain("top: var(--app-viewport-offset-top, 0px);");
    expect(btwBackdropRule).toContain("height: var(--app-viewport-height, 100dvh);");
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
    expect(stackRule).not.toContain("overflow: hidden;");
    expect(composerRule).toContain("flex: 0 0 auto;");
    expect(queuedRule).toContain("flex: 1 1 auto;");
    expect(queuedRule).toContain("min-height: 0;");
    expect(queuedRule).toContain("overflow-y: auto;");
  });

  it("assigns direct controls to deliberate responsive groups", () => {
    const headerRule = cssBlock(styles, ".session-header");
    const actionsRule = cssBlock(styles, ".session-actions");
    const groupRule = cssBlock(styles, ".session-action-group");
    const compactStyles = cssBlock(styles, "@media (max-width: 959px)");
    const compactButtonRule = cssBlock(compactStyles, ".session-actions button");
    expect(headerRule).toContain("grid-template-columns: 40px minmax(0, 1fr) auto;");
    expect(actionsRule).toContain("flex-wrap: wrap;");
    expect(actionsRule).not.toContain("overflow-x: hidden;");
    expect(groupRule).toContain("flex-wrap: nowrap;");
    expect(compactButtonRule).toContain("width: 40px;");
    expect(compactButtonRule).toContain("min-height: 40px;");
  });

  it("keeps composer settings and adaptive transcript navigation out of the input width", () => {
    const settingsRule = cssBlock(styles, ".composer-settings");
    const composerRule = cssBlock(styles, ".composer");
    const railRule = cssBlock(styles, ".transcript-jump-rail");
    const protectedListRule = cssBlock(styles, ".message-list[data-jump-controls]");
    expect(settingsRule).toContain("flex: 0 0 auto;");
    expect(composerRule).toContain("grid-template-columns: minmax(0, 1fr) 48px;");
    expect(railRule).toContain("position: absolute;");
    expect(railRule).toContain("pointer-events: none;");
    expect(protectedListRule).toContain("padding-right: 60px;");
    expect(protectedListRule).toContain("padding-bottom: 60px;");
  });

  it("preserves the app logo while compacting the narrow global bar", () => {
    const narrowTopbarStyles = cssBlock(styles, "@media (max-width: 420px)");
    const wordmarkRule = cssBlock(narrowTopbarStyles, ".brand strong");
    expect(wordmarkRule).toContain("display: none;");
    expect(narrowTopbarStyles).not.toContain(".brand-logo");
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
