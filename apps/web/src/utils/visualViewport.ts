export type VisibleViewportMetrics = {
  height: number;
  offsetTop: number;
};

const VIEWPORT_HEIGHT_PROPERTY = "--app-viewport-height";
const VIEWPORT_OFFSET_TOP_PROPERTY = "--app-viewport-offset-top";
const VIEWPORT_UNIT_PROPERTY = "--app-viewport-unit";

export function readVisibleViewportMetrics(windowObject: Pick<Window, "innerHeight" | "visualViewport">): VisibleViewportMetrics {
  const viewport = windowObject.visualViewport;
  const visualHeight = finitePositiveNumber(viewport?.height);
  const layoutHeight = finitePositiveNumber(windowObject.innerHeight);
  const height = visualHeight !== null && layoutHeight !== null
    ? Math.min(visualHeight, layoutHeight)
    : visualHeight ?? layoutHeight ?? 0;
  const offsetTop = viewport ? finiteNonNegativeNumber(viewport.offsetTop) ?? 0 : 0;
  return { height, offsetTop };
}

export function applyVisibleViewportVariables(
  style: Pick<CSSStyleDeclaration, "setProperty">,
  metrics: VisibleViewportMetrics
): void {
  style.setProperty(VIEWPORT_HEIGHT_PROPERTY, cssPixels(metrics.height));
  style.setProperty(VIEWPORT_OFFSET_TOP_PROPERTY, cssPixels(metrics.offsetTop));
  style.setProperty(VIEWPORT_UNIT_PROPERTY, cssPixels(metrics.height / 100));
}

export function installVisibleViewportVariables(
  windowObject: Window = window,
  documentObject: Document = document
): () => void {
  const style = documentObject.documentElement.style;
  const viewport = windowObject.visualViewport;
  let animationFrame: number | null = null;

  const update = () => {
    animationFrame = null;
    const metrics = readVisibleViewportMetrics(windowObject);
    if (metrics.height > 0) applyVisibleViewportVariables(style, metrics);
  };
  const scheduleUpdate = () => {
    if (animationFrame !== null) return;
    animationFrame = windowObject.requestAnimationFrame(update);
  };
  const handleVisibilityChange = () => {
    if (documentObject.visibilityState === "visible") scheduleUpdate();
  };

  update();
  viewport?.addEventListener("resize", scheduleUpdate);
  viewport?.addEventListener("scroll", scheduleUpdate);
  windowObject.addEventListener("resize", scheduleUpdate);
  windowObject.addEventListener("orientationchange", scheduleUpdate);
  windowObject.addEventListener("pageshow", scheduleUpdate);
  documentObject.addEventListener("visibilitychange", handleVisibilityChange);

  return () => {
    if (animationFrame !== null) windowObject.cancelAnimationFrame(animationFrame);
    viewport?.removeEventListener("resize", scheduleUpdate);
    viewport?.removeEventListener("scroll", scheduleUpdate);
    windowObject.removeEventListener("resize", scheduleUpdate);
    windowObject.removeEventListener("orientationchange", scheduleUpdate);
    windowObject.removeEventListener("pageshow", scheduleUpdate);
    documentObject.removeEventListener("visibilitychange", handleVisibilityChange);
    style.removeProperty(VIEWPORT_HEIGHT_PROPERTY);
    style.removeProperty(VIEWPORT_OFFSET_TOP_PROPERTY);
    style.removeProperty(VIEWPORT_UNIT_PROPERTY);
  };
}

function finitePositiveNumber(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function finiteNonNegativeNumber(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function cssPixels(value: number): string {
  return `${Math.round(value * 1_000) / 1_000}px`;
}
