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
    const modalBackdropRule = cssBlock(mobileStyles, ".dialog-backdrop");
    const textareaRule = cssBlock(mobileStyles, ".skill-textarea textarea,\n  .skill-textarea-mirror");
    expect(appRule).toContain("position: fixed;");
    expect(appRule).toContain("top: var(--app-viewport-offset-top, 0px);");
    expect(appRule).toContain("height: var(--app-viewport-height, 100dvh);");
    expect(modalBackdropRule).toContain("top: var(--app-viewport-offset-top, 0px);");
    expect(modalBackdropRule).toContain("height: var(--app-viewport-height, 100dvh);");
    expect(textareaRule).toContain("var(--app-viewport-unit, 1dvh)");
  });

  it("uses one inset and panel contract for centered and side modals", () => {
    const backdropRule = cssBlock(styles, ".dialog-backdrop");
    const panelRule = cssBlock(styles, ".modal-panel");
    const sideRule = cssBlock(styles, ".dialog-backdrop[data-placement=\"end\"]");
    const mobileStyles = cssBlock(styles, "@media (max-width: 819px)");
    const mobileBackdropRule = cssBlock(mobileStyles, ".dialog-backdrop");
    const mobileSideRule = cssBlock(mobileStyles, ".dialog-backdrop[data-placement=\"end\"]");
    const mobileFullHeightRule = cssBlock(mobileStyles, ".documents-modal,\n  .btw-drawer");
    expect(backdropRule).toContain("place-items: center;");
    expect(panelRule).toContain("width: min(100%, var(--modal-max-width, 560px));");
    expect(panelRule).toContain("max-height: 100%;");
    expect(panelRule).toContain("background: var(--color-surface);");
    expect(sideRule).toContain("place-items: stretch end;");
    expect(mobileBackdropRule).toContain("calc(10px + env(safe-area-inset-top))");
    expect(mobileSideRule).toContain("place-items: center;");
    expect(mobileFullHeightRule).toContain("width: 100%;");
    expect(mobileFullHeightRule).toContain("height: 100%;");
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
    const runtimeRule = cssBlock(styles, ".session-header-runtime");
    const runtimeModelRule = cssBlock(styles, ".session-header-runtime .tmux-command-metadata .tmux-command-model");
    const actionsRule = cssBlock(styles, ".session-actions");
    const groupRule = cssBlock(styles, ".session-action-group");
    const compactStyles = cssBlock(styles, "@media (max-width: 959px)");
    const compactButtonRule = cssBlock(compactStyles, ".session-actions button");
    const narrowStyles = cssBlock(styles, "@media (max-width: 819px)");
    const narrowModelRule = cssBlock(narrowStyles, ".session-header-runtime .tmux-command-metadata");
    const narrowMetaRule = cssBlock(narrowStyles, ".session-header-meta");
    const narrowMetadataRule = cssBlock(narrowStyles, ".session-header-runtime-detail,\n  .session-header-memory-usage");
    const compactStatusRule = cssBlock(narrowStyles, ".session-header-status-compact .session-header-runtime > .status");
    const compactStatusTextRule = cssBlock(narrowStyles, ".session-header-status-compact .session-header-runtime > .status .status-text");
    expect(headerRule).toContain("grid-template-columns: 40px minmax(0, 1fr) auto;");
    expect(runtimeRule).toContain("display: flex;");
    expect(runtimeRule).toContain("justify-content: flex-end;");
    expect(runtimeModelRule).toContain("max-width: none;");
    expect(narrowModelRule).toContain("display: none;");
    expect(narrowMetaRule).toContain("gap: 6px;");
    expect(narrowMetadataRule).toContain("display: none;");
    expect(compactStatusRule).toContain("width: 12px;");
    expect(compactStatusTextRule).toContain("display: none;");
    expect(actionsRule).toContain("flex-wrap: wrap;");
    expect(actionsRule).not.toContain("overflow-x: hidden;");
    expect(groupRule).toContain("flex-wrap: nowrap;");
    expect(compactButtonRule).toContain("width: 40px;");
    expect(compactButtonRule).toContain("min-height: 40px;");
  });

  it("places composer settings in an exact two-row block left of the input", () => {
    const settingsRule = cssBlock(styles, ".composer-settings");
    const composerRule = cssBlock(styles, ".composer");
    const modeRule = cssBlock(styles, ".composer-settings .mode-toggle");
    const fastRule = cssBlock(styles, ".composer-settings .fast-mode-toggle");
    const vimFastRule = cssBlock(styles, ".composer-vim-available .composer-settings .fast-mode-toggle");
    const vimRule = cssBlock(styles, ".composer-settings .vim-toggle");
    const sendRule = cssBlock(styles, ".composer > .send-button");
    const inputRule = cssBlock(styles, ".composer > .skill-textarea");
    const inputSurfaceRule = cssBlock(styles, ".composer > .skill-textarea textarea:not([data-composer-resizing]),\n.composer > .skill-textarea .skill-textarea-mirror");
    expect(settingsRule).toContain("display: grid;");
    expect(settingsRule).toContain("grid-template-columns: repeat(2, 32px);");
    expect(settingsRule).toContain("grid-template-rows: repeat(2, 34px);");
    expect(settingsRule).toContain("align-content: start;");
    expect(modeRule).toContain("grid-column: 1 / -1;");
    expect(modeRule).toContain("grid-row: 1;");
    expect(fastRule).toContain("grid-column: 1 / -1;");
    expect(fastRule).toContain("grid-row: 2;");
    expect(vimFastRule).toContain("grid-column: 1;");
    expect(vimRule).toContain("grid-column: 2;");
    expect(vimRule).toContain("grid-row: 2;");
    expect(composerRule).toContain("grid-template-columns: auto minmax(0, 1fr) 48px;");
    expect(composerRule).toContain("align-items: stretch;");
    expect(composerRule).toContain("--composer-control-rail-height: 74px;");
    expect(inputRule).toContain("min-height: var(--composer-control-rail-height);");
    expect(inputSurfaceRule).toContain("max(var(--composer-control-rail-height), var(--composer-content-height, 52px))");
    expect(sendRule).toContain("align-self: center;");
    expect(sendRule).toContain("height: 52px;");
  });

  it("overlays adaptive transcript navigation without reserving message-list geometry", () => {
    const railRule = cssBlock(styles, ".transcript-jump-rail");
    expect(railRule).toContain("position: absolute;");
    expect(railRule).toContain("pointer-events: none;");
    expect(styles).not.toContain(".message-list[data-jump-controls]");
  });

  it("preserves the app logo while compacting the narrow global bar", () => {
    const narrowTopbarStyles = cssBlock(styles, "@media (max-width: 420px)");
    const wordmarkRule = cssBlock(narrowTopbarStyles, ".brand strong");
    expect(wordmarkRule).toContain("display: none;");
    expect(narrowTopbarStyles).not.toContain(".brand-logo");
  });

  it("renders Markdown task checkboxes without a second list marker", () => {
    const taskListItemRule = cssBlock(styles, ".markdown .task-list-item");
    expect(taskListItemRule).toContain("list-style: none;");
  });

  it("trims Markdown block margins at user-message edges", () => {
    const firstBlockRule = cssBlock(styles, ".message-user > .markdown > :first-child");
    const lastBlockRule = cssBlock(styles, ".message-user > .markdown > :last-child");
    expect(firstBlockRule).toContain("margin-top: 0;");
    expect(lastBlockRule).toContain("margin-bottom: 0;");
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
