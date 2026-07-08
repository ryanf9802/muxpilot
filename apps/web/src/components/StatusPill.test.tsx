import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StatusPill } from "./StatusPill.js";

describe("StatusPill", () => {
  it("labels question and plan ready statuses distinctly", () => {
    expect(renderToStaticMarkup(createElement(StatusPill, { status: "planning" }))).toContain(">planning<");
    expect(renderToStaticMarkup(createElement(StatusPill, { status: "question" }))).toContain(">question<");
    expect(renderToStaticMarkup(createElement(StatusPill, { status: "plan_ready" }))).toContain(">plan ready<");
  });

  it("keeps status text accessible when CSS renders it as a mobile dot", () => {
    const html = renderToStaticMarkup(createElement(StatusPill, { status: "plan_ready" }));

    expect(html).toContain('aria-label="plan ready"');
    expect(html).toContain('title="plan ready"');
    expect(html).toContain('class="status-text"');
  });

  it("uses the shared red yellow green severity classes", () => {
    expect(renderToStaticMarkup(createElement(StatusPill, { status: "approval" }))).toContain('class="status status-red"');
    expect(renderToStaticMarkup(createElement(StatusPill, { status: "working" }))).toContain('class="status status-yellow"');
    expect(renderToStaticMarkup(createElement(StatusPill, { status: "waiting" }))).toContain('class="status status-green"');
  });
});
