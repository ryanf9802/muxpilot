import { describe, expect, it } from "vitest";
import {
  markdownDocumentHeadings,
  obsidianDocumentMarkdown,
  portableDocumentMarkdown,
  referencedDocumentNames,
  renderableDocumentMarkdown,
  resolveDocumentHeading
} from "./documentMarkdown.js";

describe("document Markdown", () => {
  it("extracts duplicate and nested headings and resolves text paths", () => {
    const headings = markdownDocumentHeadings("# Brief\n\n## Scope\n\n### Included use\n\n## Scope\n");

    expect(headings).toEqual([
      { id: "brief", label: "Brief", level: 1, path: "Brief" },
      { id: "scope", label: "Scope", level: 2, path: "Brief#Scope" },
      { id: "included-use", label: "Included use", level: 3, path: "Brief#Scope#Included use" },
      { id: "scope-1", label: "Scope", level: 2, path: "Brief#Scope" }
    ]);
    expect(resolveDocumentHeading(headings, "Brief#Scope#Included use")).toBe("included-use");
    expect(resolveDocumentHeading(headings, "included-use")).toBe("included-use");
  });

  it("prepares visible Obsidian syntax while hiding comments and preserving code and escapes", () => {
    const source = [
      "Visible %% hidden",
      "across lines %% text [[plan]] ==marked== \\[[literal]] \\==plain==",
      "`[[inline]] %% inline`",
      "```md",
      "[[block]] %% block",
      "```"
    ].join("\n");
    const rendered = renderableDocumentMarkdown(source);

    expect(rendered).not.toContain("hidden");
    expect(rendered).not.toContain("across lines");
    expect(rendered).toContain("Visible  text [[plan]] ==marked==");
    expect(rendered).toContain("`[[inline]] %% inline`");
    expect(rendered).toContain("[[block]] %% block");
  });

  it("exports portable Markdown without changing code or escaped syntax", () => {
    const source = [
      "> [!warning]- Read first",
      "> See [[plan#Next step|the plan]] and ==important text==.",
      "",
      "%% private",
      "comment %%Visible.",
      "",
      "\\[[literal]] and ![[embed]] and `[[inline]] ==inline==`",
      "```md",
      "> [!note] Code",
      "[[block]] ==block==",
      "```"
    ].join("\n");

    expect(portableDocumentMarkdown(source)).toBe([
      "> **Read first**",
      "> See [the plan](./plan.md#next-step) and **important text**.",
      "",
      "Visible.",
      "",
      "\\[[literal]] and ![[embed]] and `[[inline]] ==inline==`",
      "```md",
      "> [!note] Code",
      "[[block]] ==block==",
      "```",
      ""
    ].join("\n"));
  });

  it("exports resolvable Markdown links as Obsidian wikilinks", () => {
    const currentHeadings = markdownDocumentHeadings("# Brief\n\n## Included use\n");
    const planHeadings = markdownDocumentHeadings("# Plan\n\n## Next step\n");
    const source = [
      "[Included](#included-use)",
      "[Plan](./plan.md#next-step)",
      "[Site](https://example.com)",
      "[Missing](missing.md)",
      "![Image](plan.md) \\[Literal](plan.md)",
      "`[Plan](plan.md)`"
    ].join("\n");

    expect(obsidianDocumentMarkdown(source, {
      currentDocument: "brief.md",
      documentNames: ["brief.md", "plan.md"],
      headingsByDocument: new Map([
        ["brief.md", currentHeadings],
        ["plan.md", planHeadings]
      ])
    })).toBe([
      "[[#Included use|Included]]",
      "[[plan#Next step|Plan]]",
      "[Site](https://example.com)",
      "[Missing](missing.md)",
      "![Image](plan.md) \\[Literal](plan.md)",
      "`[Plan](plan.md)`"
    ].join("\n"));
  });

  it("finds only available Markdown-linked documents whose headings are needed for export", () => {
    expect(referencedDocumentNames(
      "[[plan]] [Notes](notes.md) ![Image](code.md) [[missing]] `[[code]]`\n```\n[[block]]\n```",
      ["INDEX.md", "plan.md", "notes.md", "code.md", "block.md"]
    )).toEqual(["notes.md"]);
  });
});
