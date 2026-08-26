import { describe, expect, it, vi } from "vitest";
import {
  applyVisibleViewportVariables,
  installVisibleViewportVariables,
  readVisibleViewportMetrics
} from "./visualViewport.js";

describe("visible viewport metrics", () => {
  it("uses the smaller valid viewport height and falls back when one is unavailable", () => {
    expect(readVisibleViewportMetrics({
      innerHeight: 780,
      visualViewport: { height: 412.25, offsetTop: 17.5 } as VisualViewport
    })).toEqual({ height: 412.25, offsetTop: 17.5 });
    expect(readVisibleViewportMetrics({
      innerHeight: 780,
      visualViewport: { height: 900, offsetTop: 0 } as VisualViewport
    })).toEqual({ height: 780, offsetTop: 0 });
    expect(readVisibleViewportMetrics({ innerHeight: 780, visualViewport: null })).toEqual({ height: 780, offsetTop: 0 });
    expect(readVisibleViewportMetrics({
      innerHeight: 780,
      visualViewport: { height: Number.NaN, offsetTop: -4 } as VisualViewport
    })).toEqual({ height: 780, offsetTop: 0 });
  });

  it("publishes height, offset, and a one-percent viewport unit", () => {
    const setProperty = vi.fn();
    applyVisibleViewportVariables({ setProperty }, { height: 412.25, offsetTop: 17.5 });
    expect(setProperty.mock.calls).toEqual([
      ["--app-viewport-height", "412.25px"],
      ["--app-viewport-offset-top", "17.5px"],
      ["--app-viewport-unit", "4.123px"]
    ]);
  });
});

describe("visual viewport variable lifecycle", () => {
  it("coalesces viewport changes and refreshes after the PWA returns to the foreground", () => {
    const environment = fakeViewportEnvironment();
    const cleanup = installVisibleViewportVariables(environment.window, environment.document);

    expect(environment.properties.get("--app-viewport-height")).toBe("640px");
    environment.viewport.height = 390;
    environment.viewport.offsetTop = 12;
    environment.viewport.dispatchEvent(new Event("resize"));
    environment.viewport.dispatchEvent(new Event("scroll"));
    environment.window.dispatchEvent(new Event("orientationchange"));
    expect(environment.pendingFrames()).toBe(1);

    environment.flushFrame();
    expect(environment.properties.get("--app-viewport-height")).toBe("390px");
    expect(environment.properties.get("--app-viewport-offset-top")).toBe("12px");

    environment.window.dispatchEvent(new Event("pageshow"));
    expect(environment.pendingFrames()).toBe(1);
    environment.flushFrame();

    environment.setVisibility("hidden");
    environment.document.dispatchEvent(new Event("visibilitychange"));
    expect(environment.pendingFrames()).toBe(0);
    environment.setVisibility("visible");
    environment.document.dispatchEvent(new Event("visibilitychange"));
    expect(environment.pendingFrames()).toBe(1);

    cleanup();
    expect(environment.pendingFrames()).toBe(0);
    expect(environment.properties.size).toBe(0);
    environment.viewport.dispatchEvent(new Event("resize"));
    expect(environment.pendingFrames()).toBe(0);
  });
});

function fakeViewportEnvironment() {
  const viewport = Object.assign(new EventTarget(), { height: 640, offsetTop: 0 });
  const windowTarget = new EventTarget();
  const documentTarget = new EventTarget();
  const properties = new Map<string, string>();
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  let visibilityState: DocumentVisibilityState = "visible";

  const fakeWindow = Object.assign(windowTarget, {
    innerHeight: 720,
    visualViewport: viewport,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id)
  }) as unknown as Window;
  Object.defineProperty(documentTarget, "visibilityState", { get: () => visibilityState });
  const fakeDocument = Object.assign(documentTarget, {
    documentElement: {
      style: {
        setProperty: (name: string, value: string) => properties.set(name, value),
        removeProperty: (name: string) => properties.delete(name)
      }
    }
  }) as unknown as Document;

  return {
    window: fakeWindow,
    document: fakeDocument,
    viewport,
    properties,
    setVisibility: (state: DocumentVisibilityState) => { visibilityState = state; },
    pendingFrames: () => frames.size,
    flushFrame: () => {
      const pending = [...frames.entries()];
      frames.clear();
      for (const [, callback] of pending) callback(0);
    }
  };
}
