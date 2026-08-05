import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppUpdateNotice } from "./AppUpdatePrompt.js";

describe("AppUpdateNotice", () => {
  it("renders a persistent accessible reload action", () => {
    const html = renderToStaticMarkup(createElement(AppUpdateNotice, {
      activating: false,
      onReload: () => undefined
    }));

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("A muxpilot update is available.");
    expect(html).toContain(">Reload</button>");
  });

  it("disables the action while the waiting worker activates", () => {
    const html = renderToStaticMarkup(createElement(AppUpdateNotice, {
      activating: true,
      onReload: () => undefined
    }));

    expect(html).toContain("disabled");
    expect(html).toContain("Updating…");
  });
});
