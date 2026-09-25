// bb-plugin-agent-tv — hover peek.
//
// The wall lives in the sidebar footer, so reaching it should cost nothing
// more than resting the pointer there. This module adds that: dwell on the
// footer button and the disclosure opens; move away and the peek closes again
// — unless the person using it has taken ownership (a click, or any pointer
// time inside the panel), after which only they decide when it closes.
//
// It is plain delegated DOM code, installed from a content script and disposed
// with its abort signal: no observers, no retained nodes, and it never touches
// anything outside this plugin's own footer row and disclosure panel.
//
// The host renders those two with stable identities:
//   trigger  id="plugin-sidebar-footer-trigger-<pluginId>-<itemId>-<generation>"
//            data-testid="plugin-sidebar-footer-item-<pluginId>-<itemId>"
//   panel    data-testid="plugin-sidebar-footer-disclosure-<pluginId>-<itemId>"
// Generation-suffixed ids are why the trigger is matched by prefix.

export type HoverPeekOptions = {
  /** CSS selector matching this plugin's footer row. */
  triggerSelector: string;
  /** CSS selector matching this plugin's disclosure panel. */
  panelSelector: string;
  open(): void;
  close(): void;
  /** Dwell required before a peek opens. Guards against stray passes. */
  dwellMs?: number;
  /** Grace period before a peek closes, so crossing a gap keeps it open. */
  leaveMs?: number;
  now?(): number;
};

/** Returns the disposer; calling it removes every listener and timer. */
export function installHoverPeek(options: HoverPeekOptions): () => void {
  const {
    triggerSelector,
    panelSelector,
    open,
    close,
    dwellMs = 260,
    leaveMs = 420,
  } = options;
  const doc = typeof document === "undefined" ? null : document;
  if (doc === null) return () => {};

  let peeked = false; // we opened the current panel; nobody else touched it
  let dwellTimer: ReturnType<typeof setTimeout> | null = null;
  let leaveTimer: ReturnType<typeof setTimeout> | null = null;

  const clearDwell = (): void => {
    if (dwellTimer !== null) {
      clearTimeout(dwellTimer);
      dwellTimer = null;
    }
  };
  const clearLeave = (): void => {
    if (leaveTimer !== null) {
      clearTimeout(leaveTimer);
      leaveTimer = null;
    }
  };

  const isPanelOpen = (): boolean => doc.querySelector(panelSelector) !== null;

  function owned(target: EventTarget | null): Element | null {
    if (!(target instanceof Element)) return null;
    const trigger = target.closest(triggerSelector);
    if (trigger !== null) return trigger;
    return target.closest(panelSelector);
  }

  function onPointerOver(event: PointerEvent): void {
    const hit = owned(event.target);
    if (hit === null) {
      // Moving around the rest of the app says nothing about the peek.
      return;
    }
    clearLeave();
    if (hit.matches(panelSelector)) {
      // They went in: whatever this is now, it is not a peek to reclaim.
      peeked = false;
      clearDwell();
      return;
    }
    if (peeked || isPanelOpen() || dwellTimer !== null) return;
    dwellTimer = setTimeout(() => {
      dwellTimer = null;
      if (isPanelOpen()) return;
      peeked = true;
      open();
    }, dwellMs);
  }

  function onPointerOut(event: PointerEvent): void {
    if (!peeked) return;
    if (owned(event.relatedTarget) !== null) return; // trigger -> panel, or inside either
    clearDwell();
    if (leaveTimer !== null) return;
    leaveTimer = setTimeout(() => {
      leaveTimer = null;
      if (!peeked) return;
      peeked = false;
      if (isPanelOpen()) close();
    }, leaveMs);
  }

  function onClick(event: MouseEvent): void {
    if (owned(event.target) === null) return;
    // Any click in the footer row or the panel is the user taking over. The
    // host decides what the trigger click itself does (open, or close).
    peeked = false;
    clearDwell();
    clearLeave();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape") peeked = false; // the host closes it
  }

  doc.addEventListener("pointerover", onPointerOver, true);
  doc.addEventListener("pointerout", onPointerOut, true);
  doc.addEventListener("click", onClick, true);
  doc.addEventListener("keydown", onKeyDown, true);

  return () => {
    clearDwell();
    clearLeave();
    doc.removeEventListener("pointerover", onPointerOver, true);
    doc.removeEventListener("pointerout", onPointerOut, true);
    doc.removeEventListener("click", onClick, true);
    doc.removeEventListener("keydown", onKeyDown, true);
    peeked = false;
  };
}
