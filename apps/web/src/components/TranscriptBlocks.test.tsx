import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReasoningBlock, TaskListBlock, transcriptTaskList } from "./TranscriptBlocks.js";

describe("ReasoningBlock", () => {
  it("renders reasoning collapsed behind a Thinking summary with its line count", () => {
    const html = renderToStaticMarkup(createElement(ReasoningBlock, { text: "Check the parser.\nThen the tests." }));

    expect(html).toMatch(/^<details class="reasoning-block">/);
    expect(html).not.toContain("open");
    expect(html).toContain('<span class="reasoning-block-title">Thinking</span>');
    expect(html).toContain("2 lines");
    expect(html).toContain("Check the parser.\nThen the tests.");
  });

  it("notes redacted reasoning without an empty body", () => {
    const html = renderToStaticMarkup(createElement(ReasoningBlock, { text: "  " }));
    expect(html).toContain("No text recorded");
    expect(html).not.toContain("reasoning-block-body");
  });
});

describe("TaskListBlock", () => {
  it("renders a checklist with progress and accessible statuses", () => {
    const html = renderToStaticMarkup(createElement(TaskListBlock, {
      taskList: {
        items: [
          { text: "Read the contract", status: "completed" },
          { text: "Update the web client", status: "in_progress" },
          { text: "Run the tests", status: "pending" }
        ]
      }
    }));

    expect(html).toContain('role="group" aria-label="Task list"');
    expect(html).toContain("1/3 completed");
    expect(html).toContain('<li data-status="completed">');
    expect(html).toContain('<li data-status="in_progress">');
    expect(html).toContain("(in progress)");
    expect(html).toContain("Run the tests");
  });

  it("accepts only well-formed task list payloads", () => {
    expect(transcriptTaskList({ taskList: { items: [{ text: "a", status: "pending" }, { text: 1, status: "pending" }, { text: "b", status: "blocked" }] } }))
      .toEqual({ items: [{ text: "a", status: "pending" }] });
    expect(transcriptTaskList({ taskList: null })).toBeNull();
    expect(transcriptTaskList({})).toBeNull();
    expect(transcriptTaskList(null)).toBeNull();
  });
});
