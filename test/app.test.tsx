// @vitest-environment jsdom
// The wall's frontend contract: what it asks the server for, what it draws from
// a frame, and what happens when a tile is clicked.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent } from "@testing-library/react";
import {
  loadPluginApp,
  renderSlot,
} from "@get-bb/plugin-sdk/testing/app";
import type {
  PluginSidebarProject,
  PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import type { FleetFrame } from "../lib/fleet";

function thread(over: Partial<PluginSidebarThread> = {}): PluginSidebarThread {
  return {
    id: "thr_a",
    projectId: "proj_1",
    title: "Fix the flaky test",
    titleFallback: null,
    displayTitle: "Fix the flaky test",
    parentThreadId: null,
    lifecycleOwnerThreadId: null,
    sourceThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "codex",
    status: "active",
    runtimeStatus: "active",
    queuedWork: "none",
    href: "/threads/thr_a",
    isHidden: false,
    hasPendingInteraction: false,
    activity: {
      workflows: 0,
      backgroundAgents: 0,
      backgroundCommands: 0,
      planMode: 0,
      goals: 0,
    },
    indicator: "runtime",
    indicatorLabel: "Thread is running",
    isUnread: false,
    isPinned: false,
    pinnedAt: null,
    pinSortKey: null,
    isArchived: false,
    archivedAt: null,
    environment: null,
    host: null,
    createdAt: 1,
    updatedAt: 2,
    lastReadAt: null,
    latestAttentionAt: 0,
    ...over,
  };
}

function project(
  over: Partial<PluginSidebarProject> = {},
): PluginSidebarProject {
  return {
    id: "proj_1",
    name: "Echo Depths",
    isPersonal: false,
    href: "/projects/proj_1",
    settingsHref: "/projects/proj_1/settings",
    ...over,
  };
}

const FRAME: FleetFrame = {
  t: Date.now(),
  rows: [
    {
      id: "thr_a",
      status: "active",
      title: "Fix the flaky test",
      model: "gpt-5.6-luna",
      effort: "max",
      projectId: "proj_1",
      providerId: "codex",
      parentThreadId: null,
      childCount: 0,
      tool: "git commit -m 'fix: the flaky one'",
      verb: "Running command",
      glyph: "Terminal",
      settled: false,
      streaming: true,
      busy: true,
      files: ["/repo/src/app.tsx", "/repo/src/main.ts", "/repo/other.ts"],
      heat: [0, 0, 1, 2, 5, 1, 0, 3, 4, 2, 1, 6],
      waiting: null,
      context: null,
      quietMs: 1_200,
    },
  ],
};

let app: Awaited<ReturnType<typeof loadPluginApp>>;
/** Every slot a test mounted, torn down in afterEach even when it failed. */
const mounted: Array<{ lifecycle: { unmount: () => void } }> = [];

beforeAll(async () => {
  app = await loadPluginApp(() => import("../app"));
});

beforeEach(() => {
  // The popout remembers its position across reloads, so tests must not
  // inherit each other's.
  window.localStorage.clear();
});

afterEach(() => {
  // Whether the popout is open is module state in app.tsx, and Escape is the
  // public way to close it — so it has to happen before anything unmounts.
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    // The live-only filter is module state too; release it the way a user
    // would, so a failing test cannot leave the next one filtered.
    for (const pressed of Array.from(
      document.querySelectorAll('[aria-pressed="true"]'),
    )) {
      (pressed as HTMLElement).click();
    }
  });
  for (const slot of mounted.splice(0)) {
    try {
      slot.lifecycle.unmount();
    } catch {
      // Already unmounted by the test itself; nothing to undo.
    }
  }
});

function wall(options: Parameters<typeof renderSlot>[2]) {
  const item = app.experimentalSidebarFooterItems.find(
    (candidate) => candidate.id === "wall" && candidate.kind === "disclosure",
  );
  if (item === undefined || item.kind !== "disclosure") {
    throw new Error("Agent TV registered no footer disclosure");
  }
  const slot = renderSlot(
    { component: item.component },
    { dismiss: () => {} },
    options,
  );
  mounted.push(slot);
  return slot;
}

function overlay(options: Parameters<typeof renderSlot>[2]) {
  const item = app.appOverlays.find((candidate) => candidate.id === "hover-peek");
  if (item === undefined) throw new Error("Agent TV registered no app overlay");
  const slot = renderSlot({ component: item.component }, {}, options);
  mounted.push(slot);
  return slot;
}

describe("the footer registration", () => {
  it("is a disclosure with a label and a host icon", () => {
    const [item] = app.experimentalSidebarFooterItems;
    expect(item?.kind).toBe("disclosure");
    expect(item?.label).toContain("Agent TV");
    expect(item?.icon).toBe("Play");
  });

  it("mounts the hover peek once per window, beside the wall", () => {
    expect(app.appOverlays.map((overlay) => overlay.id)).toContain("hover-peek");
  });
});

describe("the wall", () => {
  it("paints a tile for each thread on air", async () => {
    const slot = wall({
      rpc: { fleet_snapshot: () => FRAME },
      sidebarThreads: {
        status: "ready",
        threads: [thread()],
        projects: [project()],
      },
    });
    expect(await slot.findByText("Fix the flaky test")).toBeTruthy();
    expect(slot.getByText("gpt-5.6-luna")).toBeTruthy();
  expect(slot.getByText("max", { exact: true })).toBeTruthy();
    expect(
      slot.getByRole("button", { name: /Fix the flaky test/ }).getAttribute("title"),
    ).toContain("gpt-5.6-luna");
    expect(
      slot.getByRole("button", { name: /Fix the flaky test/ }).getAttribute("title"),
    ).toContain("effort max");
    expect(slot.getByText("Echo Depths")).toBeTruthy();
    expect(slot.getByText("git commit -m 'fix: the flaky one'")).toBeTruthy();
    expect(slot.getByText("ON AIR")).toBeTruthy();
    // The third file is counted, not stacked, so tiles keep one height.
    expect(slot.getByText("+1")).toBeTruthy();
    expect(slot.queryByText("/repo/other.ts")).toBeNull();
    expect(slot.getAllByTestId("agtv-dot")).toHaveLength(3);
    slot.lifecycle.unmount();
  });

  it("asks for the threads that look busy and ignores the quiet ones", async () => {
    const slot = wall({
      rpc: { fleet_snapshot: () => FRAME },
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "thr_a" }),
          thread({ id: "thr_done", indicator: "none", updatedAt: 1 }),
          thread({ id: "thr_arch", isArchived: true, indicator: "runtime" }),
          thread({
            id: "thr_bg",
            indicator: "none",
            activity: {
              workflows: 0,
              backgroundAgents: 2,
              backgroundCommands: 0,
              planMode: 0,
              goals: 0,
            },
          }),
        ],
        projects: [],
      },
    });
    await slot.findByText("Fix the flaky test");
    expect(slot.inspection.rpcCalls[0]?.input).toEqual({
      threadIds: ["thr_a", "thr_bg"],
    });
    slot.lifecycle.unmount();
  });

  it("keeps the current route thread in the seed set", async () => {
    const slot = wall({
      context: { projectId: "proj_1", threadId: "thr_a" },
      rpc: { fleet_snapshot: () => FRAME },
      sidebarThreads: {
        status: "ready",
        threads: [],
        projects: [project()],
      },
    });
    expect(await slot.findByText("Fix the flaky test")).toBeTruthy();
    expect(slot.getByText("Echo Depths")).toBeTruthy();
    expect(slot.inspection.rpcCalls[0]?.input).toEqual({
      threadIds: ["thr_a"],
    });
    slot.lifecycle.unmount();
  });

  it("follows the live feed without another request", async () => {
    const slot = wall({
      rpc: { fleet_snapshot: () => ({ t: Date.now(), rows: [] }) },
      sidebarThreads: { status: "ready", threads: [thread()], projects: [] },
    });
    expect(await slot.findByText(/No thread has reported any activity/)).toBeTruthy();
    await slot.behavior.emitRealtime("fleet", FRAME);
    expect((await slot.findAllByText("Fix the flaky test")).length).toBeGreaterThan(0);
    expect(slot.getByText("ON AIR")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("says QUIET when nothing is running", async () => {
    const slot = wall({
      rpc: {
        fleet_snapshot: () => ({
          t: Date.now(),
          rows: [{ ...FRAME.rows[0]!, status: "idle", streaming: false }],
        }),
      },
      sidebarThreads: { status: "ready", threads: [thread()], projects: [] },
    });
    expect(await slot.findByText("QUIET")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("dismisses quiet threads with a tick and restores them when they work again", async () => {
    const quiet = {
      ...FRAME.rows[0]!,
      status: "idle" as const,
      tool: null,
      verb: null,
      glyph: null,
      settled: false,
      streaming: false,
      busy: false,
    };
    const slot = wall({
      rpc: {
        fleet_snapshot: () => ({ t: Date.now(), rows: [quiet] }),
      },
      sidebarThreads: { status: "ready", threads: [thread()], projects: [] },
    });
    expect(await slot.findByText("Fix the flaky test")).toBeTruthy();
    fireEvent.click(
      slot.getByRole("button", {
        name: "Dismiss Fix the flaky test from Agent TV",
      }),
    );
    expect(slot.queryByText("Fix the flaky test")).toBeNull();
    expect(window.localStorage.getItem("bb-plugin-agent-tv:dismissed-quiet")).toBe(
      '["thr_a"]',
    );

    // A fresh, unchanged frame must not undo a viewing-only dismissal.
    await slot.behavior.emitRealtime("fleet", {
      t: Date.now(),
      rows: [quiet],
    });
    expect(slot.queryByText("Fix the flaky test")).toBeNull();

    await slot.behavior.emitRealtime("fleet", FRAME);
    expect(await slot.findByText("Fix the flaky test")).toBeTruthy();
    expect(
      slot.queryByRole("button", {
        name: "Dismiss Fix the flaky test from Agent TV",
      }),
    ).toBeNull();
    expect(window.localStorage.getItem("bb-plugin-agent-tv:dismissed-quiet")).toBe(
      "[]",
    );
    slot.lifecycle.unmount();
  });

  it("shows what a thread is waiting on, in its own words", async () => {
    const slot = wall({
      rpc: { fleet_snapshot: () => FRAME },
      sidebarThreads: {
        status: "ready",
        threads: [thread({ hasPendingInteraction: true })],
        projects: [],
      },
    });
    expect(await slot.findByText("waiting for you")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("opens the thread you point at, through the host", async () => {
    const slot = wall({
      rpc: { fleet_snapshot: () => FRAME },
      sidebarThreads: { status: "ready", threads: [thread()], projects: [] },
    });
    const tiles = await slot.findAllByText("Fix the flaky test");
    const button = tiles[0]?.closest("button");
    expect(button).not.toBeNull();
    fireEvent.click(button as Element);
    await vi.waitFor(() =>
      expect(slot.inspection.sidebarActionCalls).toEqual([
        { method: "open", threadId: "thr_a", options: { split: false } },
      ]),
    );
    // Shift-click opens beside the wall, so mission control stays on screen.
    fireEvent.click(button as Element, { shiftKey: true });
    await vi.waitFor(() =>
      expect(slot.inspection.sidebarActionCalls.at(-1)).toEqual({
        method: "open",
        threadId: "thr_a",
        options: { split: true },
      }),
    );
    slot.lifecycle.unmount();
  });

  it("opens a draggable popout from the wall", async () => {
    const wallSlot = wall({
      rpc: { fleet_snapshot: () => FRAME },
      sidebarThreads: { status: "ready", threads: [thread()], projects: [] },
    });
    const overlaySlot = overlay({
      rpc: {
        fleet_snapshot: () => FRAME,
      },
      sidebarThreads: { status: "ready", threads: [thread()], projects: [] },
    });
    fireEvent.click(await wallSlot.findByRole("button", { name: "Pop out Agent TV" }));
    const popout = await overlaySlot.findByTestId("agent-tv-popout");
    const header = popout.querySelector("header");
    expect(header).not.toBeNull();
    fireEvent.pointerDown(header as Element, {
      button: 0,
      clientX: 10,
      clientY: 10,
    });
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 42, clientY: 35 }));
    await vi.waitFor(() => expect(popout.getAttribute("style")).toContain("32px"));
    fireEvent.click(overlaySlot.getByRole("button", { name: "Close Agent TV popout" }));
    await vi.waitFor(() =>
      expect(overlaySlot.queryByTestId("agent-tv-popout")).toBeNull(),
    );
    wallSlot.lifecycle.unmount();
    overlaySlot.lifecycle.unmount();
  });

  it("paints tiles in the order the server laid them out, and no other way", async () => {
    // The wall owns its layout (see `WallOrder` in lib/fleet); the client must
    // not re-sort, or tiles would slide around under the pointer every second.
    const a = FRAME.rows[0]!;
    const b = { ...a, id: "thr_b", title: "Add dark mode" };
    const slot = wall({
      rpc: { fleet_snapshot: () => ({ t: Date.now(), rows: [a, b] }) },
      sidebarThreads: {
        status: "ready",
        threads: [thread(), thread({ id: "thr_b", title: "Add dark mode" })],
        projects: [],
      },
    });
    const orderOf = () =>
      Array.from(slot.container.querySelectorAll("ul li button")).map((tile) =>
        (tile.textContent ?? "").includes("Fix the flaky") ? "thr_a" : "thr_b",
      );
    await slot.findAllByText("Fix the flaky test");
    expect(orderOf()).toEqual(["thr_a", "thr_b"]);
    await slot.behavior.emitRealtime("fleet", { t: Date.now(), rows: [b, a] });
    expect(orderOf()).toEqual(["thr_b", "thr_a"]);
    slot.lifecycle.unmount();
  });

  it("drops a frame it cannot parse instead of blanking the wall", async () => {
    const slot = wall({
      rpc: { fleet_snapshot: () => FRAME },
      sidebarThreads: { status: "ready", threads: [thread()], projects: [] },
    });
    expect((await slot.findAllByText("Fix the flaky test")).length).toBeGreaterThan(0);
    await slot.behavior.emitRealtime("fleet", { rows: "not a frame" });
    await slot.behavior.emitRealtime("fleet", {
      ...FRAME,
      rows: [{ ...FRAME.rows[0]!, heat: [1] }], // wrong bucket count
    });
    expect(slot.getAllByText("Fix the flaky test").length).toBeGreaterThan(0);
    slot.lifecycle.unmount();
  });

  it("tells you when the server is unreachable", async () => {
    const slot = wall({
      rpc: {
        fleet_snapshot: () => {
          throw new Error("offline");
        },
      },
      sidebarThreads: { status: "ready", threads: [thread()], projects: [] },
    });
    expect(await slot.findByText(/cannot reach the server/)).toBeTruthy();
    slot.lifecycle.unmount();
  });
  it("keeps ageing a row while no new frame arrives", async () => {
    vi.useFakeTimers({ now: Date.now() });
    try {
      const slot = wall({
        rpc: { fleet_snapshot: () => FRAME },
        sidebarThreads: { status: "ready", threads: [thread()], projects: [] },
      });
      // Settle the mount and the snapshot it asks for.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      // The frame says this thread went quiet 1.2s ago.
      expect(slot.getByText("1s")).toBeTruthy();

      // The pump publishes only when a frame's content changes, so the wall
      // runs its own clock: five seconds on, this row is five seconds older
      // even though nothing arrived. The heartbeat is 10s, so no refresh has
      // happened here either.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(slot.getByText("6s")).toBeTruthy();
      expect(slot.queryByText("1s")).toBeNull();
      expect(slot.inspection.rpcCalls).toHaveLength(1);
      slot.lifecycle.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("leads with what a thread needs from you", async () => {
    const asking = {
      ...FRAME.rows[0]!,
      status: "idle" as const,
      waiting: "permission",
    };
    const slot = wall({
      rpc: { fleet_snapshot: () => ({ t: Date.now(), rows: [asking] }) },
      sidebarThreads: { status: "ready", threads: [thread()], projects: [] },
    });
    expect(await slot.findByText("needs you: permission")).toBeTruthy();
    // An idle thread that is blocked on a person is not "QUIET".
    expect(slot.getByText("NEEDS YOU")).toBeTruthy();
    // And the tool call it was on stops being the headline.
    expect(slot.queryByText("git commit -m 'fix: the flaky one'")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("moves the popout by keyboard and remembers where it sits", async () => {
    const context = {
      rpc: { fleet_snapshot: () => FRAME },
      sidebarThreads: {
        status: "ready" as const,
        threads: [thread()],
        projects: [],
      },
    };
    const wallSlot = wall(context);
    const overlaySlot = overlay(context);
    fireEvent.click(await wallSlot.findByRole("button", { name: "Pop out Agent TV" }));
    const popout = await overlaySlot.findByTestId("agent-tv-popout");
    const header = popout.querySelector("header") as HTMLElement;

    // Dragging was the only way to move it, which left keyboard users with a
    // panel they could not reposition.
    fireEvent.keyDown(header, { key: "ArrowRight", shiftKey: true });
    await vi.waitFor(() => expect(popout.getAttribute("style")).toContain("32px"));
    expect(
      window.localStorage.getItem("bb-plugin-agent-tv:popout-offset"),
    ).toContain("32");

    // Staying reachable when the window shrinks is geometry, and jsdom has no
    // layout — `offsetWidth` is 0, so the panel cannot be measured here. That
    // invariant is covered against real measurements in lib/popout.test.ts.

    fireEvent.click(overlaySlot.getByRole("button", { name: "Close Agent TV popout" }));
    wallSlot.lifecycle.unmount();
    overlaySlot.lifecycle.unmount();
  });

  it("says a failed thread failed, rather than that it is quiet", async () => {
    const failed = {
      ...FRAME.rows[0]!,
      status: "error" as const,
      tool: null,
      verb: null,
      glyph: null,
      streaming: false,
      busy: false,
    };
    const slot = wall({
      rpc: { fleet_snapshot: () => ({ t: Date.now(), rows: [failed] }) },
      sidebarThreads: { status: "ready", threads: [thread()], projects: [] },
    });
    // A failure clears the tool line, and nothing used to fill it — so the
    // tile read "quiet" for a thread that had crashed.
    expect(await slot.findByText("failed")).toBeTruthy();
    expect(slot.queryByText("quiet")).toBeNull();
    // And the state is not carried by colour alone any more.
    expect(slot.getByRole("img", { name: "Failed" })).toBeTruthy();
  });

  it("tells working, waiting and failed apart", async () => {
    const base = FRAME.rows[0]!;
    const rows = [
      { ...base, id: "thr_work", title: "Working one" },
      {
        ...base,
        id: "thr_ask",
        title: "Asking one",
        status: "idle" as const,
        busy: false,
        waiting: "permission",
      },
      {
        ...base,
        id: "thr_bad",
        title: "Failed one",
        status: "error" as const,
        tool: null,
        verb: null,
        glyph: null,
        streaming: false,
        busy: false,
      },
    ];
    const slot = wall({
      rpc: { fleet_snapshot: () => ({ t: Date.now(), rows }) },
      sidebarThreads: { status: "ready", threads: [], projects: [] },
    });
    await slot.findByText("Working one");
    // Three states that used to share one red dot.
    expect(slot.getByRole("img", { name: "Working" })).toBeTruthy();
    expect(
      slot.getByRole("img", { name: "Waiting for you: permission" }),
    ).toBeTruthy();
    expect(slot.getByRole("img", { name: "Failed" })).toBeTruthy();
    expect(slot.getByText("needs you: permission")).toBeTruthy();
    expect(slot.getByText("failed")).toBeTruthy();
  });

  it("lets the popout use the screen it was given", async () => {
    const rows = Array.from({ length: 8 }, (_, index) => ({
      ...FRAME.rows[0]!,
      id: `thr_${index}`,
      title: `Thread ${index}`,
    }));
    const context = {
      rpc: { fleet_snapshot: () => ({ t: Date.now(), rows }) },
      sidebarThreads: {
        status: "ready" as const,
        threads: [thread()],
        projects: [],
      },
    };
    const wallSlot = wall(context);
    const overlaySlot = overlay(context);
    await wallSlot.findByText("Thread 1");

    // The sidebar pins its height because the host animates the disclosure.
    expect(wallSlot.container.querySelector("ul")?.getAttribute("style")).toContain(
      "height",
    );

    // The detached monitor has no such constraint, and used to show the same
    // four tiles anyway.
    fireEvent.click(wallSlot.getByRole("button", { name: "Pop out Agent TV" }));
    const popoutList = (await overlaySlot.findByTestId(
      "agent-tv-popout",
    )).querySelector("ul");
    expect(popoutList?.className).toContain("agtv-popout-list");
    expect(popoutList?.getAttribute("style")).toBeNull();
  });

  it("filters the wall to live work from its own header", async () => {
    const base = FRAME.rows[0]!;
    const rows = [
      { ...base, id: "thr_live", title: "Live one" },
      {
        ...base,
        id: "thr_calm",
        title: "Calm one",
        status: "idle" as const,
        busy: false,
        streaming: false,
        waiting: null,
      },
    ];
    const slot = wall({
      rpc: { fleet_snapshot: () => ({ t: Date.now(), rows }) },
      sidebarThreads: { status: "ready", threads: [], projects: [] },
    });
    await slot.findByText("Live one");
    expect(slot.getByText("Calm one")).toBeTruthy();

    // `showQuiet` is a setting you change with the CLI. Wanting to see only
    // live work for a minute should be one click.
    fireEvent.click(slot.getByRole("button", { pressed: false }));
    await vi.waitFor(() => expect(slot.queryByText("Calm one")).toBeNull());
    expect(slot.getByText("Live one")).toBeTruthy();
    // The count still describes the whole fleet, not the filtered view.
    expect(slot.getByRole("button", { pressed: true }).textContent).toContain(
      "1/2",
    );

    fireEvent.click(slot.getByRole("button", { pressed: true }));
    await vi.waitFor(() => expect(slot.getByText("Calm one")).toBeTruthy());
  });

  it("keeps a finished thread's last action instead of saying quiet", async () => {
    const done = {
      ...FRAME.rows[0]!,
      status: "idle" as const,
      busy: false,
      streaming: false,
      settled: true,
      verb: "Ran command",
    };
    const slot = wall({
      rpc: { fleet_snapshot: () => ({ t: Date.now(), rows: [done] }) },
      sidebarThreads: { status: "ready", threads: [], projects: [] },
    });
    // Two of three tiles used to spend their most prominent line on "quiet".
    expect(await slot.findByText("git commit -m 'fix: the flaky one'")).toBeTruthy();
    expect(slot.queryByText("quiet")).toBeNull();
  });
});
