import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ContextMenu, ContextMenuCheckboxItem, ContextMenuItem, ContextMenuSeparator, clampContextMenuPosition, dropdownMenuPosition, submenuPosition } from "./ContextMenu.js";

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

  it("renders checkbox items and separators", () => {
    const html = renderToStaticMarkup(
      createElement(
        ContextMenu,
        { position: { x: 0, y: 0 }, label: "Notification settings" },
        createElement(ContextMenuCheckboxItem, { checked: true, onClick: () => undefined }, "Sound"),
        createElement(ContextMenuSeparator),
        createElement(ContextMenuItem, { onClick: () => undefined }, "Settings")
      )
    );

    expect(html).toContain('role="menuitemcheckbox"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('role="separator"');
    expect(html).toContain("Sound");
  });
});

describe("clampContextMenuPosition", () => {
  it("keeps menus inside the viewport edge", () => {
    vi.stubGlobal("window", { innerWidth: 320, innerHeight: 240 });

    expect(clampContextMenuPosition(400, 300, { width: 100, height: 80, edge: 8 })).toEqual({ x: 212, y: 152 });
    expect(clampContextMenuPosition(-40, -20, { width: 100, height: 80, edge: 8 })).toEqual({ x: 8, y: 8 });
  });

  it("positions dropdowns and flips submenus into the viewport", () => {
    vi.stubGlobal("window", { innerWidth: 320, innerHeight: 240 });

    expect(dropdownMenuPosition({ left: 20, right: 80, bottom: 30 }, { width: 100, height: 80, align: "start" })).toEqual({ x: 20, y: 36 });
    expect(submenuPosition({ x: 250, y: 120 }, { parentWidth: 80, width: 100, height: 80, itemOffsetY: 20 })).toEqual({ x: 146, y: 140 });
  });
});
