// @vitest-environment jsdom
// The hover peek: dwell opens, leaving closes, a click hands control to the user.
import { afterEach, describe, expect, it, vi } from "vitest";
import { installHoverPeek } from "./peek";

const TRIGGER = '[data-testid="trigger"]';
const PANEL = '[data-testid="panel"]';

function setup() {
  document.body.innerHTML = `
    <div id="chrome">
      <button data-testid="trigger">wall</button>
      <div id="mount"></div>
    </div>`;
  const calls: string[] = [];
  const isOpen = () => document.querySelector(PANEL) !== null;
  const dispose = installHoverPeek({
    triggerSelector: TRIGGER,
    panelSelector: PANEL,
    open: () => {
      calls.push("open");
      document.getElementById("mount")!.innerHTML = `<span data-testid="panel"></span>`;
    },
    close: () => {
      calls.push("close");
      document.getElementById("mount")!.innerHTML = "";
    },
    dwellMs: 100,
    leaveMs: 100,
  });
  return { calls, dispose, isOpen, trigger: document.querySelector(TRIGGER)!, mount: document.getElementById("chrome")! };
}

function over(target: Element) {
  target.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
}
function leave(from: Element, to: Element | null) {
  from.dispatchEvent(
    new PointerEvent("pointerout", { bubbles: true, relatedTarget: to }),
  );
}

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("installHoverPeek", () => {
  it("opens after a dwell and closes when the pointer walks away", () => {
    vi.useFakeTimers();
    const { calls, dispose, trigger, mount } = setup();
    over(trigger);
    vi.advanceTimersByTime(60);
    expect(calls).toEqual([]); // a stray pass is not a request
    vi.advanceTimersByTime(60);
    expect(calls).toEqual(["open"]);
    leave(trigger, mount);
    vi.advanceTimersByTime(200);
    expect(calls).toEqual(["open", "close"]);
    dispose();
  });

  it("stays open while the pointer crosses from the row into the panel", () => {
    vi.useFakeTimers();
    const { calls, dispose, trigger, isOpen } = setup();
    over(trigger);
    vi.advanceTimersByTime(150);
    leave(trigger, document.querySelector(PANEL)!);
    over(document.querySelector(PANEL)!);
    vi.advanceTimersByTime(500);
    expect(calls).toEqual(["open"]);
    expect(isOpen()).toBe(true);
    dispose();
  });

  it("lets go of a panel the user touched", () => {
    vi.useFakeTimers();
    const { calls, dispose, trigger, mount } = setup();
    over(trigger);
    vi.advanceTimersByTime(150);
    // They click a tile: the peek is now theirs, so leaving must not close it.
    document.querySelector(PANEL)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    leave(trigger, mount);
    vi.advanceTimersByTime(500);
    expect(calls).toEqual(["open"]);
    dispose();
  });

  it("never opens what the host already opened", () => {
    vi.useFakeTimers();
    const { calls, dispose, trigger } = setup();
    document.getElementById("mount")!.innerHTML = `<span data-testid="panel"></span>`;
    over(trigger);
    vi.advanceTimersByTime(500);
    expect(calls).toEqual([]);
    dispose();
  });

  it("removes every listener it added", () => {
    const { dispose, trigger, isOpen } = setup();
    dispose();
    over(trigger);
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(isOpen()).toBe(false);
  });
});
