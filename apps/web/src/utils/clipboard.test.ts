// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { copyImage } from "./clipboard.js";

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

afterEach(() => {
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("copyImage", () => {
  it("writes fetched PNG bytes to the image clipboard", async () => {
    const write = vi.fn(async () => undefined);
    const items: Array<Record<string, Blob>> = [];
    class TestClipboardItem {
      constructor(data: Record<string, Blob>) { items.push(data); }
    }
    vi.stubGlobal("ClipboardItem", TestClipboardItem);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Blob(["png"], { type: "image/png" }), { status: 200 })));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write } });

    await copyImage("/api/sessions/session-1/images/image.png");

    expect(items).toHaveLength(1);
    expect(items[0]?.["image/png"]).toBeInstanceOf(Blob);
    expect(write).toHaveBeenCalledOnce();
  });

  it("converts other browser-supported image formats to PNG", async () => {
    const write = vi.fn(async () => undefined);
    const items: Array<Record<string, Blob>> = [];
    const close = vi.fn();
    const drawImage = vi.fn();
    class TestClipboardItem {
      constructor(data: Record<string, Blob>) { items.push(data); }
    }
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage }),
      toBlob: (callback: BlobCallback) => callback(new Blob(["png"], { type: "image/png" }))
    } as unknown as HTMLCanvasElement;
    const createElement = document.createElement.bind(document);
    vi.stubGlobal("ClipboardItem", TestClipboardItem);
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 2, height: 3, close })));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Blob(["jpeg"], { type: "image/jpeg" }), { status: 200 })));
    vi.spyOn(document, "createElement").mockImplementation((tagName, options) =>
      tagName === "canvas" ? canvas : createElement(tagName, options)
    );
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write } });

    await copyImage("/api/sessions/session-1/images/image.jpg");

    expect(canvas).toMatchObject({ width: 2, height: 3 });
    expect(drawImage).toHaveBeenCalledOnce();
    expect(items[0]?.["image/png"]?.type).toBe("image/png");
    expect(close).toHaveBeenCalledOnce();
  });

  it("reports unavailable image clipboard access", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {} });
    await expect(copyImage("/image.png")).rejects.toThrow("Image clipboard access is unavailable");
  });
});
