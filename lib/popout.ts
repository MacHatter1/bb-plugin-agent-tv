// bb-plugin-agent-tv — keeping the detached monitor reachable.
//
// The popout is anchored bottom-right and moved with a transform, so an
// offset is only meaningful next to the panel's own geometry. Clamping
// against the viewport instead — which is what this used to do — let the
// panel travel until only its bottom edge showed, or off the screen entirely:
// its drag handle is the header along the *top*, so losing that loses the
// only way to bring it back.
//
// The rule here is the one that matters: the header band stays on screen.

/** How much of the panel's top edge must remain visible to be grabbable. */
export const POPOUT_HEADER = 32;
/** How much of its width must stay reachable when pushed sideways. */
export const POPOUT_GRIP = 72;

export type Offset = { x: number; y: number };

export type PanelBox = {
  /** Viewport size. */
  viewport: { width: number; height: number };
  /** Where the panel sits with a zero offset, in viewport coordinates. */
  base: { left: number; top: number };
  /** The panel's laid-out size, before any transform. */
  size: { width: number; height: number };
};

function bound(value: number, low: number, high: number): number {
  // A viewport smaller than the panel can invert the range; prefer the low
  // bound, which is the one that keeps the header reachable.
  if (low > high) return low;
  return Math.max(low, Math.min(high, value));
}

/**
 * The nearest offset to (x, y) that leaves the panel's header on screen.
 * Vertically the whole header band stays inside the viewport; horizontally a
 * grip's worth of it does.
 */
export function clampWithin(box: PanelBox, x: number, y: number): Offset {
  const { viewport, base, size } = box;
  if (size.width <= 0 || size.height <= 0) return { x, y };
  return {
    x: bound(
      x,
      POPOUT_GRIP - size.width - base.left,
      viewport.width - POPOUT_GRIP - base.left,
    ),
    y: bound(y, -base.top, viewport.height - POPOUT_HEADER - base.top),
  };
}

/** Measure a mounted panel. Returns null when it has no layout yet. */
export function measurePanel(element: HTMLElement): PanelBox | null {
  if (typeof window === "undefined") return null;
  const width = element.offsetWidth;
  const height = element.offsetHeight;
  if (width <= 0 || height <= 0) return null;
  // Read the anchor from the element rather than duplicating the stylesheet:
  // the popout sits at a different inset on a narrow window. `offsetWidth`
  // and the computed inset are both transform-independent, so this does not
  // drift as the panel is dragged.
  const style = window.getComputedStyle(element);
  const right = Number.parseFloat(style.right);
  const bottom = Number.parseFloat(style.bottom);
  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    size: { width, height },
    base: {
      left: window.innerWidth - (Number.isFinite(right) ? right : 0) - width,
      top: window.innerHeight - (Number.isFinite(bottom) ? bottom : 0) - height,
    },
  };
}
