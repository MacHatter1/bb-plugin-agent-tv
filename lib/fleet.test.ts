// Unit tests for the fleet fold: thread-event rows in, wall tiles out.
// These run without a BB server — lib/fleet.ts is pure on purpose.
import { describe, expect, it } from "vitest";
import {
  applyRow,
  applyThreadDto,
  bumpHeat,
  buildFrame,
  clip,
  createWallOrder,
  describeItem,
  emptyFeed,
  formatAge,
  formatContext,
  frameKey,
  heatFor,
  heatLevel,
  heatLevels,
  isBusy,
  applyWait,
  feedIsBusy,
  feedIsBehind,
  feedIsStale,
  rankThreadsForSnapshot,
  redactSecrets,
  MAX_FILES,
  pruneFiles,
  recentFiles,
  rowFor,
  sparkline,
  touchFiles,
  underPressure,
  CONTEXT_PRESSURE,
  BUSY_WINDOW_MS,
  HEAT_BUCKETS,
  HEAT_WINDOW_MS,
  type WireRow,
} from "./fleet";

const T = 1_700_000_000_000;

function row(type: string, data: unknown, over: Partial<WireRow> = {}): WireRow {
  return { seq: 1, createdAt: T, type, data, ...over };
}

function started(
  item: Record<string, unknown>,
  seq = 1,
  createdAt = T,
): WireRow {
  return row("item/started", { item }, { seq, createdAt });
}

describe("describeItem", () => {
  it("reads a command's own presentation, not a guess", () => {
    const described = describeItem(
      {
        type: "commandExecution",
        id: "i1",
        command: "git commit -m 'ship it'",
        status: "pending",
        presentation: {
          label: { pending: "Running command", completed: "Ran command" },
          icon: { glyph: "Terminal" },
          title: "git commit -m 'ship it'",
        },
      },
      T,
    );
    expect(described?.tool).toEqual({
      itemId: "i1",
      text: "git commit -m 'ship it'",
      verb: "Running command",
      // Kept so the tile can switch tense when the turn ends, without having
      // to have seen the item's own completion.
      verbDone: "Ran command",
      glyph: "Terminal",
      settled: false,
      at: T,
    });
  });

  it("switches to the completed verb once the item finishes", () => {
    const item = {
      type: "commandExecution",
      id: "i1",
      command: "git push",
      status: "completed",
      presentation: {
        label: { pending: "Running command", completed: "Ran command" },
      },
    };
    expect(describeItem(item, T, true)?.tool.verb).toBe("Ran command");
    expect(describeItem(item, T, true)?.tool.settled).toBe(true);
  });

  it("keeps a nested call out of the parent's line", () => {
    expect(
      describeItem(
        { type: "toolCall", id: "i2", tool: "read", parentToolCallId: "i1" },
        T,
      ),
    ).toBeNull();
  });

  it("ignores a user message rather than blanking the tile", () => {
    expect(describeItem({ type: "userMessage", id: "i3" }, T)).toBeNull();
  });

  it("falls back to a tool's own name, then to a path argument", () => {
    expect(
      describeItem({ type: "toolCall", id: "a", tool: "ultragoal_state" }, T)
        ?.tool.text,
    ).toBe("ultragoal_state");
    expect(
      describeItem(
        { type: "toolCall", id: "b", arguments: { file_path: "src/app.tsx" } },
        T,
      )?.tool.text,
    ).toBe("src/app.tsx");
    expect(
      describeItem(
        { type: "toolCall", id: "c", arguments: { args: { path: "x.ts" } } },
        T,
      )?.tool.text,
    ).toBe("x.ts");
  });

  it("survives junk: no item type, wrong types, empty presentation", () => {
    expect(describeItem({}, T)).toBeNull();
    expect(describeItem({ type: 42 }, T)).toBeNull();
    expect(
      describeItem({ type: "toolCall", presentation: null, arguments: "no" }, T)
        ?.tool.text,
    ).toBeNull();
  });
});
describe("applyRow", () => {
  it("records the selected model and provider fallback", () => {
    const feed = emptyFeed("thr_a");
    applyRow(
      feed,
      row("client/turn/requested", {
        execution: { model: "gpt-5.6-luna", reasoningLevel: "max" },
      }),
      T,
    );
    expect(feed.model).toBe("gpt-5.6-luna");
    expect(feed.effort).toBe("max");
    applyRow(
      feed,
      row("provider/modelFallback", { fallbackModel: "gpt-5.5" }),
      T + 1,
    );
    expect(feed.model).toBe("gpt-5.5");
  });

  it("shows the newest tool and retitles it when it finishes", () => {
    const feed = emptyFeed("thr_a");
    applyRow(feed, started({ type: "commandExecution", id: "i1", command: "npm test" }), T);
    expect(feed.tool?.text).toBe("npm test");
    applyRow(
      feed,
      row("item/completed", {
        item: { type: "commandExecution", id: "i1", command: "npm test", status: "completed" },
      }),
      T + 1,
    );
    expect(feed.tool?.settled).toBe(true);
    expect(feed.tool?.verb).toBe("Running command"); // no presentation on the item
    applyRow(feed, started({ type: "fileChange", id: "i2", changes: [{ path: "/x/y.ts" }] }), T + 2);
    expect(feed.tool?.itemId).toBe("i2");
  });

  it("an unrelated completion does not clear the line", () => {
    const feed = emptyFeed("thr_a");
    applyRow(feed, started({ type: "commandExecution", id: "i1", command: "ls" }), T);
    applyRow(
      feed,
      row("item/completed", { item: { type: "reasoning", id: "other" } }),
      T + 1,
    );
    expect(feed.tool?.itemId).toBe("i1");
  });

  it("marks streaming from any delta and clears it at the end of the turn", () => {
    const feed = emptyFeed("thr_a");
    applyRow(feed, row("item/agentMessage/delta", { delta: "hi", itemId: "m1" }), T);
    expect(rowFor(feed, T)?.streaming).toBe(true);
    applyRow(feed, row("turn/completed", {}), T + 10);
    expect(rowFor(feed, T + 10)?.streaming).toBe(false);
  });

  it("collects written files with their timestamp", () => {
    const feed = emptyFeed("thr_a");
    applyRow(
      feed,
      started({
        type: "fileChange",
        id: "i1",
        changes: [
          { path: "/repo/src/a.ts", kind: "update" },
          { path: "/repo/src/b.ts", kind: "add" },
        ],
      }),
      T,
    );
    expect([...feed.files.keys()]).toEqual(["/repo/src/a.ts", "/repo/src/b.ts"]);
  });

  it("records an error and keeps the tile honest", () => {
    const feed = emptyFeed("thr_a");
    applyRow(feed, row("system/error", { message: "boom" }), T);
    const built = rowFor(feed, T);
    expect(built?.status).toBe("error");
    expect(built?.tool).toBeNull();
  });

  it("never throws on a malformed row", () => {
    const feed = emptyFeed("thr_a");
    for (const junk of [
      row("item/started", null),
      row("item/started", { item: [] }),
      { seq: 1, createdAt: T, type: null, data: null } as unknown as WireRow,
      { nope: true },
    ]) {
      expect(() => applyRow(feed, junk as WireRow, T)).not.toThrow();
    }
  });
});

describe("file memory", () => {
  it("bounds how many paths one long-lived thread can hold", () => {
    const feed = emptyFeed("thr_a");
    for (let index = 0; index < 200; index += 1) {
      applyRow(
        feed,
        started(
          {
            type: "fileChange",
            id: `i${index}`,
            changes: [{ path: `/f${index}.ts` }],
          },
          index + 1,
          T + index,
        ),
        T + index,
      );
    }
    expect(feed.files.size).toBeLessThanOrEqual(MAX_FILES * 2);
    expect(recentFiles(feed.files, T + 199)).toContain("/f199.ts");
  });

  it("moves a re-touched file back to the front", () => {
    const feed = emptyFeed("thr_a");
    applyRow(
      feed,
      started({
        type: "fileChange",
        id: "a",
        changes: [{ path: "/x.ts" }, { path: "/y.ts" }],
      }),
      T,
    );
    applyRow(
      feed,
      started({ type: "fileChange", id: "b", changes: [{ path: "/x.ts" }] }, 2, T + 5_000),
      T + 5_000,
    );
    expect(recentFiles(feed.files, T + 6_000)).toEqual(["/x.ts", "/y.ts"]);
  });
});

describe("rowFor", () => {
  it("keeps a thread however long it has been quiet", () => {
    const feed = emptyFeed("thr_a");
    applyRow(feed, started({ type: "commandExecution", id: "i1", command: "ls" }), T);
    expect(rowFor(feed, T + 60_000)).not.toBeNull();
    // Tiles used to expire after three minutes. They do not any more: the row
    // cap and the activity sort decide what is on the wall, not a timer.
    const day = T + 24 * 3_600_000;
    expect(rowFor(feed, day)).not.toBeNull();
    expect(rowFor(feed, day)?.quietMs).toBe(24 * 3_600_000);
    // Its heat has long since rolled to nothing, so it reads as idle.
    expect(rowFor(feed, day)?.heat.every((value) => value === 0)).toBe(true);
  });

  it("never shows a feed with no events at all", () => {
    expect(rowFor(emptyFeed("thr_a"), T)).toBeNull();
  });

  it("clips a title to the wire budget", () => {
    const feed = emptyFeed("thr_a", "x".repeat(400));
    applyRow(feed, started({ type: "toolCall", id: "1", tool: "read" }), T);
    expect(rowFor(feed, T)?.title.length).toBeLessThanOrEqual(160);
  });
});

describe("heat", () => {
  const BUCKET_MS = 5_000;

  /** A feed whose events sit at the given ages, oldest applied first. */
  function heated(now: number, ages: readonly number[]) {
    const feed = emptyFeed("thr_a");
    for (const age of [...ages].sort((left, right) => right - left)) {
      bumpHeat(feed, now - age, 1);
    }
    return feed;
  }

  it("counts a minute of events and forgets the rest", () => {
    const heat = heatFor(heated(T, [0, 1_000, 6_000, 50_000, 999_000]), T);
    expect(heat).toHaveLength(HEAT_BUCKETS);
    // Four are inside the window; the 16-minute-old one is not.
    expect(heat.reduce((total, value) => total + value, 0)).toBe(4);
  });

  it("spans the live bucket plus the eleven behind it", () => {
    // Buckets are aligned to absolute time, so the newest one is partial and
    // the window reaches (HEAT_BUCKETS - 1) whole buckets back.
    const inside = heatFor(heated(T, [(HEAT_BUCKETS - 1) * BUCKET_MS]), T);
    expect(inside[0]).toBe(1);
    const outside = heatFor(heated(T, [HEAT_BUCKETS * BUCKET_MS]), T);
    expect(outside.reduce((total, value) => total + value, 0)).toBe(0);
  });

  it("holds a full minute however many events arrive", () => {
    // The regression this replaces: heat was a list of at most 300 stamps, so
    // a thread streaming at 20/s covered ~15s and its older buckets read 0 —
    // the busiest thread on the wall drew the flattest line.
    const feed = emptyFeed("thr_a");
    for (let ms = HEAT_WINDOW_MS; ms >= 0; ms -= 50) bumpHeat(feed, T - ms, 1);
    expect(heatFor(feed, T).every((value) => value > 0)).toBe(true);
  });

  it("rolls back to nothing once a feed goes quiet", () => {
    const feed = heated(T, [0]);
    expect(heatFor(feed, T).some((value) => value > 0)).toBe(true);
    expect(
      heatFor(feed, T + HEAT_WINDOW_MS + BUCKET_MS).every((value) => value === 0),
    ).toBe(true);
  });

  it("caps a bucket so one burst cannot own the scale", () => {
    const feed = emptyFeed("thr_a");
    for (let index = 0; index < 5_000; index += 1) bumpHeat(feed, T, 1);
    expect(Math.max(...heatFor(feed, T))).toBeLessThanOrEqual(60);
  });

  it("counts a streaming storm once per bucket, not once per token", () => {
    const feed = emptyFeed("thr_a");
    for (let ms = BUCKET_MS; ms > 0; ms -= 50) {
      applyRow(
        feed,
        row("item/agentMessage/delta", { itemId: "m1" }, { createdAt: T - ms }),
        T,
      );
    }
    const total = heatFor(feed, T).reduce((sum, value) => sum + value, 0);
    // Streaming is one activity however many tokens it emits, so ~100 deltas
    // are worth a bucket or two — not 100.
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThanOrEqual(3);
  });

  it("ignores a timestamp from the future", () => {
    const feed = emptyFeed("thr_a");
    applyRow(
      feed,
      started({ type: "toolCall", id: "1", tool: "read" }, 1, T + 60_000),
      T,
    );
    const heat = heatFor(feed, T);
    expect(heat.reduce((sum, value) => sum + value, 0)).toBe(1);
    expect(heat[HEAT_BUCKETS - 1]).toBe(1); // folded into the live bucket
  });

  it("scales bars absolutely, so two tiles can be compared", () => {
    // Levels used to be normalised per row: one event per bucket and twenty
    // both drew a full bar, which made the wall unreadable side by side.
    expect(heatLevels([0, 0, 0]).every((level) => level === 0)).toBe(true);
    expect(heatLevel(1)).toBeLessThan(heatLevel(4));
    expect(heatLevel(4)).toBeLessThan(heatLevel(20));
    expect(heatLevel(20)).toBe(1);
    expect(heatLevel(60)).toBe(1); // clamped, never taller than full
    // A bucket's height does not depend on its neighbours.
    expect(heatLevels([1, 4])[0]).toBe(heatLevels([1, 60])[0]);
  });

  it("draws a block for every bucket", () => {
    expect(sparkline([0, 0, 3, 1])).toHaveLength(4);
    expect(sparkline([0, 0, 0, 0])).toBe("\u2581\u2581\u2581\u2581");
    expect(sparkline([1])).not.toBe(sparkline([20]));
  });
});

describe("recentFiles", () => {
  it("keeps only the last minute, newest first, capped", () => {
    const files = new Map<string, number>([
      ["/old.ts", T - 90_000],
      ["/a.ts", T - 5_000],
      ["/b.ts", T - 1_000],
    ]);
    expect(recentFiles(files, T)).toEqual(["/b.ts", "/a.ts"]);
    const many = new Map(
      Array.from({ length: 20 }, (_, index) => [`/f${index}.ts`, T - index]),
    );
    expect(recentFiles(many, T)).toHaveLength(6);
  });
});

describe("buildFrame", () => {
  function feedWith(id: string, active: boolean, at: number, command: string) {
    const feed = emptyFeed(id, id);
    feed.status = active ? "active" : "idle";
    applyRow(feed, started({ type: "commandExecution", id: `${id}-1`, command }, T), at);
    return feed;
  }

  it("puts threads that are on air first", () => {
    const frame = buildFrame(
      [feedWith("quiet", false, T, "ls"), feedWith("busy", true, T - 30_000, "npm test")],
      { now: T, maxRows: 6, showQuiet: true },
    );
    expect(frame.rows.map((row) => row.id)).toEqual(["busy", "quiet"]);
    expect(frame.rows.filter((row) => isBusy(row))).toHaveLength(1);
  });

  it("honours the tile budget", () => {
    const feeds = Array.from({ length: 30 }, (_, index) =>
      feedWith(`thr_${index}`, true, T, "ls"),
    );
    expect(buildFrame(feeds, { now: T, maxRows: 5, showQuiet: true }).rows).toHaveLength(5);
    expect(buildFrame(feeds, { now: T, maxRows: 0, showQuiet: true }).rows.length).toBeGreaterThan(0);
    expect(buildFrame(feeds, { now: T, maxRows: 9_999, showQuiet: true }).rows).toHaveLength(24);
  });

  it("can hide threads whose turn already finished", () => {
    const feeds = [feedWith("busy", true, T, "ls"), feedWith("quiet", false, T, "ls")];
    expect(
      buildFrame(feeds, { now: T, maxRows: 6, showQuiet: false }).rows.map((r) => r.id),
    ).toEqual(["busy"]);
  });

  it("is a plain JSON value", () => {
    const frame = buildFrame([feedWith("busy", true, T, "ls")], {
      now: T,
      maxRows: 6,
      showQuiet: true,
    });
    expect(JSON.parse(JSON.stringify(frame))).toEqual(frame);
  });
});

describe("the wall's frozen layout", () => {
  function feed(id: string, active: boolean, at: number, command = "ls") {
    const built = emptyFeed(id, id);
    built.status = active ? "active" : "idle";
    applyRow(built, started({ type: "commandExecution", id: `${id}-1`, command }), at);
    return built;
  }

  it("keeps every tile in the slot the viewer found it in", () => {
    const order = createWallOrder();
    const feeds = [feed("thr_a", false, T), feed("thr_b", true, T), feed("thr_c", true, T)];
    const options = { now: T, maxRows: 6, showQuiet: true, order };
    const first = buildFrame(feeds, options).rows.map((row) => row.id);
    expect(first).toEqual(["thr_b", "thr_c", "thr_a"]); // busiest first on open

    // thr_b finishes its turn and the others get busy: nothing may move.
    feeds[1]!.status = "idle";
    feeds[1]!.tool = null;
    feeds[0]!.status = "active";
    feeds[2]!.status = "active";
    const second = buildFrame(feeds, options).rows.map((row) => row.id);
    expect(second).toEqual(first);
  });

  it("queues a thread that joins while the wall is open at the end", () => {
    const order = createWallOrder();
    const feeds = [feed("thr_a", true, T)];
    buildFrame(feeds, { now: T, maxRows: 6, showQuiet: true, order });
    feeds.push(feed("thr_new", true, T + 1_000));
    const rows = buildFrame(feeds, {
      now: T + 1_000,
      maxRows: 6,
      showQuiet: true,
      order,
    }).rows;
    expect(rows.map((row) => row.id)).toEqual(["thr_a", "thr_new"]);
  });

  it("gives up a slot only once a thread has left the wall", () => {
    const order = createWallOrder();
    const feeds = [feed("thr_a", true, T), feed("thr_b", true, T)];
    const ids = (given: Parameters<typeof buildFrame>[0]) =>
      buildFrame(given, { now: T, maxRows: 6, showQuiet: true, order }).rows.map(
        (built) => built.id,
      );
    ids(feeds);
    // Still a live feed, just with nothing to show: it keeps its place. Tiles
    // no longer expire, so this is the only way to draw no row for one.
    expect(ids([feeds[1]!, { ...feeds[0]!, lastAt: 0 }])).toEqual(["thr_b"]);
    expect(ids(feeds)).toEqual(["thr_a", "thr_b"]);
    // Leaving the wall now means the pump dropped the feed — archived,
    // deleted, or evicted — and that does release the slot.
    ids([feeds[1]!]);
    expect(ids(feeds)).toEqual(["thr_b", "thr_a"]);
  });

  it("sorts by activity when there is no layout to preserve", () => {
    const feeds = [feed("thr_a", false, T), feed("thr_b", true, T - 5_000)];
    expect(
      buildFrame(feeds, { now: T, maxRows: 6, showQuiet: true }).rows.map((r) => r.id),
    ).toEqual(["thr_b", "thr_a"]);
  });
});

describe("who is working, and under whom", () => {
  it("takes the project, provider, and parent off core's thread DTO", () => {
    const feed = emptyFeed("thr_child");
    applyThreadDto(feed, {
      status: "active",
      title: "Worker",
      titleFallback: null,
      projectId: "proj_1",
      providerId: "claude-code",
      parentThreadId: "thr_a",
    });
    applyRow(
      feed,
      started({ type: "commandExecution", id: "i1", command: "npm test" }),
      T,
    );
    const row = rowFor(feed, T);
    expect(row?.projectId).toBe("proj_1");
    expect(row?.providerId).toBe("claude-code");
    expect(row?.parentThreadId).toBe("thr_a");
    expect(row?.status).toBe("active");
    expect(row?.title).toBe("Worker");
  });

  it("keeps an unknown status instead of inventing one", () => {
    const feed = emptyFeed("thr_a");
    feed.status = "idle";
    applyThreadDto(feed, {
      status: "teleporting",
      title: null,
      titleFallback: "fallback title",
    });
    expect(feed.status).toBe("idle");
    expect(feed.title).toBe("fallback title");
    expect(feed.parentThreadId).toBeNull();
  });

  it("counts a parent's threads that are on the wall with it", () => {
    function built(id: string, parent: string | null, at: number) {
      const feed = emptyFeed(id, id);
      feed.status = "active";
      feed.parentThreadId = parent;
      applyRow(
        feed,
        started({ type: "commandExecution", id: `${id}-1`, command: "ls" }),
        at,
      );
      return feed;
    }
    const feeds = [
      built("thr_a", null, T),
      built("thr_b", "thr_a", T),
      built("thr_c", "thr_a", T),
      built("thr_d", "thr_b", T),
    ];
    const frame = buildFrame(feeds, { now: T, maxRows: 6, showQuiet: true });
    const byId = new Map(frame.rows.map((row) => [row.id, row]));
    expect(byId.get("thr_a")?.childCount).toBe(2);
    expect(byId.get("thr_b")?.childCount).toBe(1);
    expect(byId.get("thr_d")?.childCount).toBe(0);
  });

  it("does not count a child that is not on the wall", () => {
    const parent = emptyFeed("thr_a", "thr_a");
    parent.status = "active";
    applyRow(
      parent,
      started({ type: "commandExecution", id: "a1", command: "ls" }),
      T,
    );
    const gone = emptyFeed("thr_b", "thr_b");
    gone.parentThreadId = "thr_a";
    // A child the pump knows of but has never seen an event from draws no row,
    // so there is nothing on the wall to count.
    expect(
      buildFrame([parent, gone], { now: T, maxRows: 6, showQuiet: true }).rows[0]
        ?.childCount,
    ).toBe(0);
  });

  it("does not adopt itself", () => {
    const feed = emptyFeed("thr_a", "thr_a");
    feed.parentThreadId = "thr_a";
    applyRow(
      feed,
      started({ type: "commandExecution", id: "a1", command: "ls" }),
      T,
    );
    expect(
      buildFrame([feed], { now: T, maxRows: 6, showQuiet: true }).rows[0]
        ?.childCount,
    ).toBe(0);
  });
});

describe("formatting", () => {
  it("keeps ages short enough for a tile", () => {
    expect(formatAge(120)).toBe("now");
    expect(formatAge(9_400)).toBe("9s");
    expect(formatAge(120_000)).toBe("2m");
    expect(formatAge(7_200_000)).toBe("2h");
  });

  it("clips with a single ellipsis and never grows the string", () => {
    expect(clip("abcdef", 4)).toBe("abc\u2026");
    expect(clip("abc", 4)).toBe("abc");
    expect(clip("a".repeat(300), 140).length).toBe(140);
  });

  it("prunes down to the paths it was told to keep", () => {
    const feed = emptyFeed("thr_a");
    for (let index = 0; index < 100; index += 1) {
      touchFiles(feed, [`/f${index}.ts`], T + index);
    }
    pruneFiles(feed, 6);
    // `keep` is a count of paths, not half of one: this used to retain 12.
    expect(feed.files.size).toBe(6);
    expect([...feed.files.keys()]).toContain("/f99.ts");
    expect([...feed.files.keys()]).not.toContain("/f0.ts");

    const wide = emptyFeed("thr_b");
    for (let index = 0; index < 100; index += 1) {
      touchFiles(wide, [`/g${index}.ts`], T + index);
    }
    pruneFiles(wide);
    expect(wide.files.size).toBe(MAX_FILES * 2);
  });

  it("keeps a parent a lifecycle event forgot to mention", () => {
    const feed = emptyFeed("thr_child");
    applyThreadDto(feed, {
      status: "active",
      title: "Worker",
      titleFallback: null,
      parentThreadId: "thr_a",
      providerId: "codex",
    });
    expect(feed.parentThreadId).toBe("thr_a");
    // A DTO that carries no parent at all says nothing about the parent; it
    // used to erase it, which cost the parent tile its subagent count.
    applyThreadDto(feed, { status: "idle", title: "Worker", titleFallback: null });
    expect(feed.parentThreadId).toBe("thr_a");
    expect(feed.providerId).toBe("codex");
    // An explicit null is core saying there is no parent, so that still clears.
    applyThreadDto(feed, {
      status: "idle",
      title: "Worker",
      titleFallback: null,
      parentThreadId: null,
    });
    expect(feed.parentThreadId).toBeNull();
  });

  it("gives two frames the same key when only the clock moved", () => {
    const feed = emptyFeed("thr_a", "Thread one");
    applyRow(
      feed,
      started({ type: "commandExecution", id: "i1", command: "npm test" }),
      T,
    );
    const options = { maxRows: 8, showQuiet: true };
    const first = buildFrame([feed], { ...options, now: T + 1_000 });
    const later = buildFrame([feed], { ...options, now: T + 2_000 });
    // Whole frames never compare equal — `t` and `quietMs` always move — which
    // is why the pump compares this instead.
    expect(JSON.stringify(first)).not.toBe(JSON.stringify(later));
    expect(frameKey(first)).toBe(frameKey(later));

    applyRow(
      feed,
      started({ type: "commandExecution", id: "i2", command: "npm run build" }),
      T + 2_500,
    );
    const changed = buildFrame([feed], { ...options, now: T + 3_000 });
    expect(frameKey(changed)).not.toBe(frameKey(later));
  });
});

describe("waiting on a person", () => {
  function ask(status: string, over: Record<string, unknown> = {}): WireRow {
    return row("system/userQuestion/lifecycle", {
      interactionId: "int_1",
      payload: { kind: "user_question" },
      status,
      ...over,
    });
  }

  it("folds an ask and its resolution", () => {
    const feed = emptyFeed("thr_a");
    applyRow(feed, ask("pending"), T);
    expect(rowFor(feed, T)?.waiting).toBe("question");
    applyRow(feed, ask("resolved"), T);
    expect(rowFor(feed, T)?.waiting).toBeNull();
  });

  it("names what is being asked for", () => {
    const feed = emptyFeed("thr_a");
    applyRow(
      feed,
      row("system/permissionGrant/lifecycle", {
        status: "pending",
        subject: { kind: "permission_grant", itemId: "i1" },
      }),
      T,
    );
    expect(rowFor(feed, T)?.waiting).toBe("permission");
  });

  it("holds every concurrent ask, not just the last one", () => {
    const feed = emptyFeed("thr_a");
    applyRow(feed, ask("pending", { interactionId: "a" }), T);
    applyRow(feed, ask("pending", { interactionId: "b" }), T);
    applyRow(feed, ask("resolved", { interactionId: "a" }), T);
    expect(rowFor(feed, T)?.waiting).toBe("question");
    applyRow(feed, ask("resolved", { interactionId: "b" }), T);
    expect(rowFor(feed, T)?.waiting).toBeNull();
  });

  it("still reads as waiting hours later", () => {
    const late = T + 10 * 3_600_000;
    const asking = emptyFeed("thr_a");
    applyRow(asking, ask("pending"), T);
    // Being ignored all day is the reason to keep showing it, and it sorts
    // above every busy thread no matter how stale the ask is.
    expect(rowFor(asking, late)?.waiting).toBe("question");
  });

  it("outranks the busiest thread and survives hiding quiet ones", () => {
    const asking = emptyFeed("thr_ask", "Asking");
    applyRow(asking, ask("pending"), T);
    const busy = emptyFeed("thr_busy", "Busy");
    busy.status = "active";
    applyRow(
      busy,
      started({ type: "commandExecution", id: "c1", command: "ls" }),
      T,
    );
    const frame = buildFrame([busy, asking], {
      now: T,
      maxRows: 8,
      showQuiet: false,
    });
    expect(frame.rows.map((fleetRow) => fleetRow.id)).toEqual([
      "thr_ask",
      "thr_busy",
    ]);
  });

  it("lets go when the turn ends", () => {
    const feed = emptyFeed("thr_a");
    applyRow(feed, ask("pending"), T);
    applyRow(feed, row("turn/completed", {}, { createdAt: T + 1_000 }), T + 1_000);
    expect(rowFor(feed, T + 1_000)?.waiting).toBeNull();
  });

  it("clears an ask no provider ever resolves in the log", () => {
    // Most providers write no interaction lifecycle rows at all: the ask
    // arrives only as the `interaction.pending` push, so nothing in the log
    // carries its id and it used to stick to the tile for good.
    const feed = emptyFeed("thr_a");
    feed.status = "active";
    feed.lastAt = T; // what the push handler does for an unread thread
    applyWait(feed, "int_9", "question", true, T);
    expect(rowFor(feed, T)?.waiting).toBe("question");

    // Answering it puts the agent back to work, and that is the signal.
    applyRow(
      feed,
      started({ type: "commandExecution", id: "c1", command: "ls" }, 1, T + 500),
      T + 500,
    );
    expect(rowFor(feed, T + 500)?.waiting).toBeNull();
  });

  it("does not let the events that caused an ask clear it", () => {
    const feed = emptyFeed("thr_a");
    feed.status = "active";
    // The tool call that needs permission starts first, then the ask lands.
    applyRow(
      feed,
      started({ type: "commandExecution", id: "c1", command: "rm -rf /" }, 1, T),
      T,
    );
    applyWait(feed, "int_9", "permission", true, T + 100);
    expect(rowFor(feed, T + 100)?.waiting).toBe("permission");
    // Trailing output from before the ask is not progress past it.
    applyRow(
      feed,
      row("item/agentMessage/delta", { itemId: "m1" }, { createdAt: T + 50 }),
      T + 50,
    );
    expect(rowFor(feed, T + 200)?.waiting).toBe("permission");
  });

  it("clears when the model starts talking again", () => {
    const feed = emptyFeed("thr_a");
    feed.status = "active";
    feed.lastAt = T;
    applyWait(feed, "int_9", "question", true, T);
    applyRow(
      feed,
      row("item/agentMessage/delta", { itemId: "m1" }, { createdAt: T + 2_000 }),
      T + 2_000,
    );
    expect(rowFor(feed, T + 2_000)?.waiting).toBeNull();
  });

  it("changes the frame key, so an ask is always published", () => {
    const feed = emptyFeed("thr_a", "Thread");
    applyRow(feed, started({ type: "toolCall", id: "1", tool: "read" }), T);
    const options = { now: T, maxRows: 8, showQuiet: true };
    const before = frameKey(buildFrame([feed], options));
    applyRow(feed, ask("pending"), T);
    expect(frameKey(buildFrame([feed], options))).not.toBe(before);
  });

  it("does not call a thread busy just because core still says active", () => {
    const feed = emptyFeed("thr_a");
    feed.status = "active";
    applyRow(
      feed,
      started({ type: "commandExecution", id: "c1", command: "ls" }),
      T,
    );
    applyRow(feed, row("turn/completed", {}), T);
    // Core leaves `status` at "active" for hours. Right after the turn it is
    // still fair to call this working...
    expect(rowFor(feed, T)?.busy).toBe(true);
    // ...but an hour of total silence is not work, whatever the status says.
    expect(rowFor(feed, T + 3_600_000)?.busy).toBe(false);
    expect(isBusy(rowFor(feed, T + 3_600_000)!)).toBe(false);
  });

  it("keeps a silent tool call in flight on air", () => {
    const feed = emptyFeed("thr_a");
    feed.status = "active";
    // A test suite can run for minutes without emitting a single event, so an
    // unreturned call buys far more silence than an idle thread gets.
    applyRow(
      feed,
      started({ type: "commandExecution", id: "c1", command: "npm test" }),
      T,
    );
    expect(rowFor(feed, T + 5 * 60_000)?.busy).toBe(true);
    expect(rowFor(feed, T + 30 * 60_000)?.busy).toBe(false);
  });

  it("is never busy on a status that cannot be working", () => {
    for (const status of ["idle", "error"] as const) {
      const feed = emptyFeed("thr_a");
      feed.status = status;
      applyRow(
        feed,
        started({ type: "commandExecution", id: "c1", command: "ls" }),
        T,
      );
      expect(rowFor(feed, T)?.busy).toBe(false);
    }
  });

  it("publishes the moment a thread stops working", () => {
    // `busy` rides on the frame precisely so this flip changes the frame key:
    // it is derived from `quietMs`, which the pump deliberately ignores when
    // deciding whether a frame is worth sending.
    const feed = emptyFeed("thr_a", "Thread");
    feed.status = "active";
    applyRow(
      feed,
      started({ type: "commandExecution", id: "c1", command: "ls" }),
      T,
    );
    applyRow(feed, row("turn/completed", {}), T);
    const options = { maxRows: 8, showQuiet: true };
    const onAir = frameKey(buildFrame([feed], { ...options, now: T }));
    const later = frameKey(
      buildFrame([feed], { ...options, now: T + 2 * BUSY_WINDOW_MS }),
    );
    expect(later).not.toBe(onAir);
  });

  it("agrees with the feed that produced it", () => {
    const feed = emptyFeed("thr_a");
    feed.status = "active";
    applyRow(
      feed,
      started({ type: "commandExecution", id: "c1", command: "ls" }),
      T,
    );
    for (const now of [T, T + 5 * 60_000, T + 3_600_000]) {
      expect(rowFor(feed, now)?.busy).toBe(feedIsBusy(feed, now));
    }
  });
});

describe("tense", () => {
  it("switches an unfinished action to the past when its turn ends", () => {
    const feed = emptyFeed("thr_a");
    feed.status = "active";
    applyRow(
      feed,
      started({
        type: "agentMessage",
        id: "m1",
        presentation: { label: { pending: "Responding", completed: "Responded" } },
      }),
      T,
    );
    expect(rowFor(feed, T)?.verb).toBe("Responding");
    // The turn ends without the item ever reporting completion, which is the
    // normal shape of a tail. "Responding" two hours later is a lie.
    applyRow(feed, row("turn/completed", {}, { createdAt: T + 1_000 }), T + 1_000);
    expect(rowFor(feed, T + 1_000)?.verb).toBe("Responded");
    expect(rowFor(feed, T + 1_000)?.settled).toBe(true);
  });

  it("has a past tense even when the provider labels nothing", () => {
    const feed = emptyFeed("thr_a");
    feed.status = "active";
    applyRow(feed, started({ type: "reasoning", id: "r1" }), T);
    expect(rowFor(feed, T)?.verb).toBe("Thinking");
    applyRow(feed, row("turn/completed", {}, { createdAt: T + 1_000 }), T + 1_000);
    expect(rowFor(feed, T + 1_000)?.verb).toBe("Thought");
  });
});

describe("context runway", () => {
  /** The payload shape a real codex thread emits. */
  function usage(used: number, window: number, estimated = false): WireRow {
    return row("thread/contextWindowUsage/updated", {
      providerThreadId: "01a0c473",
      contextWindowUsage: { usedTokens: used, modelContextWindow: window, estimated },
    });
  }

  it("folds a provider's context report", () => {
    const feed = emptyFeed("thr_a");
    applyRow(feed, started({ type: "toolCall", id: "1", tool: "read" }), T);
    applyRow(feed, usage(101_032, 258_400), T);
    const built = rowFor(feed, T);
    expect(built?.context).toEqual({
      used: 101_032,
      window: 258_400,
      fraction: 101_032 / 258_400,
      estimated: false,
    });
    expect(formatContext(built?.context ?? null)).toBe("39%");
    expect(underPressure(built!)).toBe(false);
  });

  it("marks an estimate as one", () => {
    const feed = emptyFeed("thr_a");
    applyRow(feed, started({ type: "toolCall", id: "1", tool: "read" }), T);
    applyRow(feed, usage(47, 100, true), T);
    // claude-code reports estimated numbers; presenting them as exact counts
    // would be a lie the provider itself does not tell.
    expect(rowFor(feed, T)?.context?.estimated).toBe(true);
    expect(formatContext(rowFor(feed, T)?.context ?? null)).toBe("~47%");
  });

  it("says nothing at all for a provider that reports nothing", () => {
    // acp-cursor and acp-grok emit none of these. An empty rail would read
    // as "plenty of room left", which is worse than drawing nothing.
    const feed = emptyFeed("thr_a");
    applyRow(feed, started({ type: "toolCall", id: "1", tool: "read" }), T);
    expect(rowFor(feed, T)?.context).toBeNull();
    expect(formatContext(null)).toBeNull();
    expect(underPressure({ context: null })).toBe(false);
  });

  it("flags a thread close to its window", () => {
    const feed = emptyFeed("thr_a");
    applyRow(feed, started({ type: "toolCall", id: "1", tool: "read" }), T);
    applyRow(feed, usage(Math.round(258_400 * CONTEXT_PRESSURE), 258_400), T);
    expect(underPressure(rowFor(feed, T)!)).toBe(true);
  });

  it("ignores a report it cannot trust", () => {
    const feed = emptyFeed("thr_a");
    applyRow(feed, started({ type: "toolCall", id: "1", tool: "read" }), T);
    for (const bad of [
      usage(10, 0),
      row("thread/contextWindowUsage/updated", {}),
      row("thread/contextWindowUsage/updated", { contextWindowUsage: "nope" }),
    ]) {
      applyRow(feed, bad, T);
      expect(rowFor(feed, T)?.context).toBeNull();
    }
    // A window smaller than the usage still yields a sane fraction.
    applyRow(feed, usage(500, 100), T);
    expect(rowFor(feed, T)?.context?.fraction).toBe(1);
  });

  it("does not let bookkeeping look like work", () => {
    const feed = emptyFeed("thr_a");
    feed.status = "active";
    applyRow(feed, started({ type: "toolCall", id: "1", tool: "read" }), T);
    applyRow(feed, row("turn/completed", {}, { createdAt: T + 1_000 }), T + 1_000);
    const quietFor = rowFor(feed, T + 5 * 60_000)?.quietMs;

    // A usage report arriving later must not reset the activity clock, add
    // heat, or count as progress past a pending ask.
    applyWait(feed, "int_1", "question", true, T + 2_000);
    applyRow(feed, usage(10, 100), T + 4 * 60_000);
    const after = rowFor(feed, T + 5 * 60_000);
    expect(after?.quietMs).toBe(quietFor);
    expect(after?.heat.every((value) => value === 0)).toBe(true);
    expect(after?.waiting).toBe("question");
    expect(after?.context?.fraction).toBe(0.1);
  });
});

describe("hidden threads", () => {
  function working(id: string, over: Record<string, unknown> = {}) {
    const feed = emptyFeed(id, id);
    feed.status = "active";
    applyThreadDto(feed, {
      status: "active",
      title: id,
      titleFallback: null,
      updatedAt: T,
      ...over,
    });
    applyRow(
      feed,
      started({ type: "commandExecution", id: `${id}-1`, command: "ls" }),
      T,
    );
    return feed;
  }

  const options = { now: T, maxRows: 8, showQuiet: true };

  it("keeps a hidden thread off the wall", () => {
    const shown = working("thr_a");
    const worker = working("thr_w", { visibility: "hidden" });
    expect(worker.hidden).toBe(true);
    const frame = buildFrame([shown, worker], options);
    expect(frame.rows.map((row) => row.id)).toEqual(["thr_a"]);
  });

  it("still counts it on the parent it belongs to", () => {
    // The whole reason core hides these is that they are the parent's
    // business, so the parent's tile is exactly where they should show up.
    const parent = working("thr_a");
    const worker = working("thr_w", {
      visibility: "hidden",
      parentThreadId: "thr_a",
    });
    const frame = buildFrame([parent, worker], options);
    expect(frame.rows).toHaveLength(1);
    expect(frame.rows[0]?.childCount).toBe(1);
  });

  it("hides it however busy or stuck it is", () => {
    const worker = working("thr_w", { visibility: "hidden" });
    applyWait(worker, "int_1", "question", true, T);
    // Waiting normally forces a row through every other filter.
    expect(rowFor(worker, T)?.waiting).toBe("question");
    expect(buildFrame([worker], options).rows).toEqual([]);
    expect(
      buildFrame([worker], { ...options, showQuiet: false }).rows,
    ).toEqual([]);
  });

  it("brings it back if core unhides it", () => {
    const worker = working("thr_w", { visibility: "hidden" });
    expect(buildFrame([worker], options).rows).toEqual([]);
    applyThreadDto(worker, {
      status: "active",
      title: "thr_w",
      titleFallback: null,
      visibility: "visible",
    });
    expect(buildFrame([worker], options).rows.map((r) => r.id)).toEqual(["thr_w"]);
  });

  it("treats a DTO that omits visibility as saying nothing", () => {
    const worker = working("thr_w", { visibility: "hidden" });
    applyThreadDto(worker, { status: "idle", title: "w", titleFallback: null });
    expect(worker.hidden).toBe(true);
  });
});

describe("redacting secrets from an action line", () => {
  it("masks the value and keeps the command", () => {
    const cases: Array<[string, string, string]> = [
      // input, must not contain, must still contain
      [
        'curl -H "Authorization: Bearer sk-live-abcd1234wxyz" https://api.example.com',
        "sk-live-abcd1234wxyz",
        "Authorization: Bearer",
      ],
      ["PGPASSWORD=hunter2trombone psql -h db", "hunter2trombone", "PGPASSWORD="],
      ["AWS_SECRET_ACCESS_KEY=abc123def456 aws s3 ls", "abc123def456", "aws s3 ls"],
      ["curl -u alice:s3cr3tpass https://example.com", "s3cr3tpass", "alice"],
      ["psql postgres://bob:letmein@db.internal/app", "letmein", "postgres://bob"],
      ["gh auth login --token ghp_AbCdEf123456XyZ", "ghp_AbCdEf123456XyZ", "gh auth login"],
      ["deploy --password correcthorsebattery", "correcthorsebattery", "deploy"],
      ["slack-post --url xoxb-1234-5678-abcdefgh", "xoxb-1234-5678-abcdefgh", "slack-post"],
      ["aws configure set key AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7EXAMPLE", "aws configure"],
      ["export GITHUB_TOKEN=github_pat_11AAAA_bbbbcccc", "github_pat_11AAAA_bbbbcccc", "GITHUB_TOKEN="],
    ];
    for (const [input, secret, kept] of cases) {
      const out = redactSecrets(input);
      expect(out, `leaked in: ${input}`).not.toContain(secret);
      expect(out, `lost context in: ${input}`).toContain(kept);
    }
  });

  it("leaves an ordinary command alone", () => {
    for (const line of [
      "git commit -m 'add token parsing to the auth module'",
      "npm test -- --runInBand",
      "sed -n '1,40p' lib/fleet.ts",
      "pip install scikit-learn",
    ]) {
      expect(redactSecrets(line)).toBe(line);
    }
  });

  it("redacts through describeItem, where the tile's text is built", () => {
    const described = describeItem(
      {
        type: "commandExecution",
        id: "i1",
        status: "pending",
        command: "psql postgres://bob:letmein@db.internal/app",
      },
      1_000,
    );
    expect(described?.tool.text).not.toContain("letmein");
  });
});

describe("a feed that has fallen behind its thread", () => {
  it("is behind when core has announced more than it has folded", () => {
    const feed = emptyFeed("thr_a");
    feed.cursor = 10;
    feed.target = 10;
    expect(feedIsBehind(feed)).toBe(false);
    feed.target = 11;
    expect(feedIsBehind(feed)).toBe(true);
  });

  it("counts unread events as evidence of work", () => {
    const now = Date.now();
    const feed = emptyFeed("thr_a");
    feed.status = "active";
    // Silent for an hour by its own clock: on the old rule, not busy.
    feed.lastAt = now - 3_600_000;
    expect(feedIsBusy(feed, now)).toBe(false);
    feed.target = feed.cursor + 1;
    expect(feedIsBusy(feed, now)).toBe(true);
  });

  it("never reports a running-but-behind thread as settled", () => {
    const now = Date.now();
    const feed = emptyFeed("thr_a");
    feed.status = "active";
    feed.lastAt = now - 3_600_000;
    feed.tool = {
      itemId: "i1",
      text: "npm test",
      verb: "Running command",
      verbDone: "Ran command",
      glyph: "Terminal",
      settled: true,
      at: now - 3_600_000,
    };
    expect(rowFor(feed, now)?.settled).toBe(true);
    feed.target = feed.cursor + 1;
    const row = rowFor(feed, now);
    expect(row?.settled).toBe(false);
    expect(row?.verb).toBe("Running command");
  });

  it("calls a silent running thread stale, and an idle one not", () => {
    const now = Date.now();
    const feed = emptyFeed("thr_a");
    feed.status = "active";
    feed.lastAt = now - BUSY_WINDOW_MS - 1_000;
    expect(feedIsStale(feed, now)).toBe(true);
    // Behind is a different problem, with a different fix.
    feed.target = feed.cursor + 1;
    expect(feedIsStale(feed, now)).toBe(false);
    feed.target = feed.cursor;
    feed.status = "idle";
    expect(feedIsStale(feed, now)).toBe(false);
    feed.status = "active";
    feed.dead = true;
    expect(feedIsStale(feed, now)).toBe(false);
  });
});

describe("choosing which threads a snapshot reads", () => {
  it("puts running threads first, however the list arrived", () => {
    const now = Date.now();
    const threads = [
      { id: "idle_new", status: "idle", updatedAt: now },
      { id: "live_old", status: "active", updatedAt: now - 600_000 },
      { id: "idle_old", status: "idle", updatedAt: now - 900_000 },
      { id: "live_new", status: "active", updatedAt: now - 60_000 },
    ];
    const ranked = rankThreadsForSnapshot(threads, () => 0);
    expect(ranked.map((thread) => thread.id)).toEqual([
      "live_new",
      "live_old",
      "idle_new",
      "idle_old",
    ]);
  });

  it("prefers what the pump has actually seen over the thread row's clock", () => {
    const now = Date.now();
    const threads = [
      { id: "a", status: "active", updatedAt: now - 900_000 },
      { id: "b", status: "active", updatedAt: now - 800_000 },
    ];
    // `a` has been folding events all along; its row's `updatedAt` has not
    // moved since the turn started, which is normal for a running thread.
    const ranked = rankThreadsForSnapshot(threads, (id) => (id === "a" ? now : 0));
    expect(ranked[0]?.id).toBe("a");
  });
});
