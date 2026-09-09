import { Check } from "lucide-react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button, DialogActions } from "./Button.js";

describe("Button", () => {
  it("renders standardized variants with an icon", () => {
    const html = renderToStaticMarkup(createElement(Button, {
      variant: "primary",
      size: "small",
      icon: createElement(Check),
      children: "Apply Normal"
    }));

    expect(html).toContain("app-button-primary");
    expect(html).toContain("app-button-small");
    expect(html).toContain("Apply Normal");
  });

  it("disables itself and exposes busy state consistently", () => {
    const html = renderToStaticMarkup(createElement(Button, {
      busy: true,
      busyLabel: "Applying Normal",
      children: "Apply Normal"
    }));

    expect(html).toContain("disabled");
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('data-busy="true"');
    expect(html).toContain("Applying Normal");
  });

  it("provides the shared dialog action layout", () => {
    const html = renderToStaticMarkup(createElement(DialogActions, null, createElement(Button, null, "Cancel")));
    expect(html).toContain('class="dialog-actions"');
  });
});
