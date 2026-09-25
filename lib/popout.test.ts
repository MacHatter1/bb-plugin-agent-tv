// The popout's drag handle is the header along its top edge. Every case here
// is really the same question: can you still grab it?
import { describe, expect, it } from "vitest";
import { clampWithin, POPOUT_GRIP, POPOUT_HEADER, type PanelBox } from "./popout";

/** The real geometry measured in the app: 1280x900 window, 360x274 panel
 *  anchored 16px from the right and bottom. */
const BOX: PanelBox = {
  viewport: { width: 1280, height: 900 },
  size: { width: 360, height: 274 },
  base: { left: 1280 - 16 - 360, top: 900 - 16 - 274 },
};

/** Where the panel's top-left lands for a given offset. */
function cornerOf(box: PanelBox, x: number, y: number) {
  const at = clampWithin(box, x, y);
  return { left: box.base.left + at.x, top: box.base.top + at.y, at };
}

describe("keeping the popout reachable", () => {
  it("never lets the header leave the top of the screen", () => {
    // Dragging hard upwards: the old clamp allowed y = -(height - 48), which
    // put the header 242px above the viewport with only the panel's bottom
    // edge showing — visible, but impossible to drag back.
    const { top } = cornerOf(BOX, 0, -5_000);
    expect(top).toBe(0);
  });

  it("never lets the panel fall off the bottom", () => {
    // The old clamp allowed y up to viewportHeight - 48 = 852, which put the
    // panel's top at 1462 on a 900px screen: gone entirely.
    const { top } = cornerOf(BOX, 0, 5_000);
    expect(top).toBeLessThanOrEqual(BOX.viewport.height - POPOUT_HEADER);
    expect(top + POPOUT_HEADER).toBeLessThanOrEqual(BOX.viewport.height);
  });

  it("keeps a grip on it sideways", () => {
    const left = cornerOf(BOX, -5_000, 0);
    expect(left.left + BOX.size.width).toBeGreaterThanOrEqual(POPOUT_GRIP);
    const right = cornerOf(BOX, 5_000, 0);
    expect(right.left).toBeLessThanOrEqual(BOX.viewport.width - POPOUT_GRIP);
  });

  it("leaves a reachable position alone", () => {
    expect(clampWithin(BOX, -100, -200)).toEqual({ x: -100, y: -200 });
    expect(clampWithin(BOX, 0, 0)).toEqual({ x: 0, y: 0 });
  });

  it("reclamps when more chats make the panel taller", () => {
    // The same saved offset can be safe for a short panel and put its header
    // above the viewport after the fleet grows. The next measurement clamps it
    // against the new height.
    expect(cornerOf(BOX, 0, -500).top).toBe(110);
    const taller: PanelBox = {
      ...BOX,
      size: { width: BOX.size.width, height: 600 },
      base: { ...BOX.base, top: 900 - 16 - 600 },
    };
    const { top, at } = cornerOf(taller, 0, -500);
    expect(top).toBe(0);
    expect(at.y).toBe(-taller.base.top);
  });

  it("still yields a grabbable header on a window smaller than the panel", () => {
    const cramped: PanelBox = {
      viewport: { width: 320, height: 200 },
      size: { width: 360, height: 274 },
      base: { left: 320 - 16 - 360, top: 200 - 16 - 274 },
    };
    for (const [x, y] of [
      [0, 0],
      [-5_000, -5_000],
      [5_000, 5_000],
    ]) {
      const { top } = cornerOf(cramped, x as number, y as number);
      // The inverted range must resolve to the bound that keeps the header
      // on screen, not to one that hides it above.
      expect(top).toBeGreaterThanOrEqual(0);
    }
  });

  it("passes through a panel that has not laid out yet", () => {
    const unmeasured: PanelBox = { ...BOX, size: { width: 0, height: 0 } };
    expect(clampWithin(unmeasured, 42, 42)).toEqual({ x: 42, y: 42 });
  });
});
