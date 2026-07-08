import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ContextMenu, ContextMenuItem, clampContextMenuPosition } from "./ContextMenu.js";

describe("ContextMenu", () => {
  it("renders a positioned menu with menu items", () => {
    const html = renderToStaticMarkup(
      createElement(
        ContextMenu,
        { position: { x: 12, y: 34 }, label: "Message actions", className: "message-action-menu", width: 180 },
        createElement(ContextMenuItem, { onClick: () => undefined }, "Copy")
      )
    );

    expect(html).toContain('class="context-menu message-action-menu"');
    expect(html).toContain('role="menu"');
    expect(html).toContain('aria-label="Message actions"');
    expect(html).toContain("left:12px;top:34px;width:180px");
    expect(html).toContain('role="menuitem"');
    expect(html).toContain("Copy");
  });
});

describe("clampContextMenuPosition", () => {
  it("keeps menus inside the viewport edge", () => {
    vi.stubGlobal("window", { innerWidth: 320, innerHeight: 240 });

    expect(clampContextMenuPosition(400, 300, { width: 100, height: 80, edge: 8 })).toEqual({ x: 212, y: 152 });
    expect(clampContextMenuPosition(-40, -20, { width: 100, height: 80, edge: 8 })).toEqual({ x: 8, y: 8 });
  });
});
