// bb-plugin-agent-tv — Agent TV backend: the fleet pump.
//
// Agent TV turns every running thread into a live tile. Everything a tile
// shows — the tool call in flight, the files touched in the last minute,
// whether the model is mid-stream, a 60-second activity sparkline — comes
// from one durable source: the thread event log.
//
// The pump is read-only and deliberately cheap:
//
//   1. `experimental_thread.events` says a thread's event sequence moved
//      (core coalesces that to at most once per second per thread) and hands
//      over the current thread DTO, so status and title cost no read at all.
//   2. Only then does the pump read that thread. A feed it has never read is
//      seeded from the tail of the log first (`order: desc`, one page), because
//      following an unseeded feed forward would walk the thread's whole history
//      a page at a time. After that it reads only the *new* rows, with
//      `threads.events.list` bounded by `afterSeq` + `types` + `limit`, and
//      folds them into a small feed.
//   3. Steps 1-2 run only while a viewer is watching — the sidebar disclosure
//      heartbeats `fleet_snapshot`. With nobody looking it stores the free
//      status announcements and issues zero reads.
//   4. Each second the feeds fold into one bounded frame, published on the
//      "fleet" realtime channel and returned by `fleet_snapshot`. A frame whose
//      content has not changed is not republished — the clock is not content,
//      so the wall ages its own rows between frames.
//
// The folding itself lives in lib/fleet.ts so it is testable without a server.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  applyRow,
  applyThreadDto,
  applyWait,
  basename,
  buildFrame,
  clip,
  emptyFeed,
  EVENT_PAGE_LIMIT,
  feedIsBusy,
  feedIsStale,
  FLEET_EVENT_TYPES,
  formatAge,
  formatContext,
  frameKey,
  effortOf,
  isBusy,
  messageOf,
  modelOf,
  createWallOrder,
  rankThreadsForSnapshot,
  sparkline,
  textOf,
  underPressure,
  waitLabel,
  FLEET_CHANNEL,
  MAX_ROWS,
  SEED_REQUEST_MAX,
  fleetFrameSchema,
  type Feed,
  type FleetFrame,
  type WallOrder,
  type ToolStatus,
  type WireRow,
} from "./lib/fleet";

/** Frame cadence while someone is watching. */
const TICK_MS = 1_000;
/** Nobody has watched this long => stop reading events. */
const WATCH_TTL_MS = 20_000;
/** Events per read, reads per notification, events per cold seed. */
const DRAIN_LIMIT = EVENT_PAGE_LIMIT;
const MIN_DRAIN_LIMIT = 1;
const DRAIN_ROUNDS = 3;
const SEED_LIMIT = 24;
const DRAIN_RETRY_MS = 5_000;
/**
 * The most events one drain pass can fold. A backlog bigger than this can
 * never be walked off — the thread produces new ones faster than the reader
 * retires old ones — so past this point the feed jumps to the tail instead.
 */
const CATCHUP_LIMIT = DRAIN_LIMIT * DRAIN_ROUNDS;
/** Longest wait between retries of a feed that keeps failing. */
const MAX_RETRY_MS = 60_000;
/** Consecutive failures after which a feed is left alone for good. */
const MAX_FEED_FAILURES = 5;
/** Do not re-read a stale feed's tail more often than this. */
const RESYNC_INTERVAL_MS = 5_000;
const MODEL_LOOKUP_LIMIT = 24;
const MODEL_LOOKUP_PAGES = 4;
const MODEL_EVENT_TYPES = [
  "client/turn/requested",
  "client/turn/start",
  "provider/modelFallback",
] as const;
/** How many feeds the pump keeps at all, however quiet. */
const MAX_FEEDS = 80;
/** Ceiling on the threads one `bb agent-tv status` may scan. */
const SNAPSHOT_SCAN_MAX = 32;

export const rpcContract = defineRpcContract({
  fleet_snapshot: {
    input: z
      .object({
        /** Threads the viewer wants hydrated, most useful first. */
        threadIds: z.array(z.string().max(64)).max(SEED_REQUEST_MAX).default([]),
      })
      .strict(),
    output: fleetFrameSchema,
  },
});

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    maxRows: {
      type: "number",
      label: "Threads on the wall",
      description:
        "How many threads the fleet feed carries (1-24). The wall shows four " +
        "and scrolls for the rest.",
      // Validated at the boundary rather than clamped after the fact, so an
      // out-of-range value is rejected where the user typed it.
      experimental_schema: z.number().int().min(1).max(MAX_ROWS),
      default: 8,
    },
    showQuiet: {
      type: "boolean",
      label: "Keep finished threads on the wall",
      description: "Leave a tile up for a few minutes after its agent goes quiet.",
      default: true,
    },
    peekOnHover: {
      type: "boolean",
      label: "Peek on hover",
      description: "Open the wall when the pointer rests on its footer button.",
      default: true,
    },
  });
  let config = await settings.get();
  settings.onChange((next) => {
    config = next;
  });

  const feeds = new Map<string, Feed>();
  /** The layout the viewer is looking at; see `buildFrame`'s `order`. */
  const wallOrder: WallOrder = createWallOrder();
  let watchUntil = 0;
  let lastFrameKey = "";
  let stopped = false;

  const watched = (): boolean => Date.now() < watchUntil;

  function maxRows(): number {
    const value = config.maxRows;
    if (typeof value !== "number" || !Number.isFinite(value)) return 8;
    return Math.max(1, Math.min(MAX_ROWS, Math.round(value)));
  }

  function feedFor(id: string, title?: string): Feed {
    let feed = feeds.get(id);
    if (feed === undefined) {
      feed = emptyFeed(id, title ?? id);
      feeds.set(id, feed);
    }
    return feed;
  }

  /**
   * Bound the pump's memory: evict the quietest feeds first, preferring to
   * keep busy ones. A fleet of more than MAX_FEEDS busy threads does lose the
   * least recently active of them.
   */
  function trimFeeds(): void {
    if (feeds.size <= MAX_FEEDS) return;
    const now = Date.now();
    const ordered = [...feeds.values()]
      .filter((feed) => !feed.draining)
      .sort(
        (left, right) =>
          // Tombstones for threads that are gone go first: they exist only to
          // stop `feedFor` resurrecting a feed we already know is unreadable.
          Number(left.dead) - Number(right.dead) === 0
            ? Number(feedIsBusy(left, now)) - Number(feedIsBusy(right, now)) ||
              left.lastAt - right.lastAt
            : Number(right.dead) - Number(left.dead),
      );
    for (const feed of ordered.slice(0, feeds.size - MAX_FEEDS)) {
      feeds.delete(feed.id);
    }
  }

  function isPayloadTooLarge(error: unknown): boolean {
    return /\b413\b|(?:payload|response).*(?:too large|exceeds)/iu.test(
      messageOf(error),
    );
  }

  /**
   * The thread is gone. Nothing will ever make this read succeed, so retrying
   * it every few seconds for the rest of the session only burns reads and
   * fills the log.
   */
  function isGone(error: unknown): boolean {
    return /\b404\b|thread[_ ]not[_ ]found|not found/iu.test(messageOf(error));
  }

  /** Note a failed read: back off, and give up once it is clearly hopeless. */
  function noteFailure(feed: Feed, what: string, error: unknown): void {
    if (isGone(error)) {
      // Kept in the map, not deleted: `feedFor` would hand the next caller a
      // brand-new feed and we would read the missing thread all over again.
      // Clearing `lastAt` is what actually removes its tile.
      feed.dead = true;
      feed.lastAt = 0;
      feed.target = feed.cursor;
      bb.log.debug(`fleet ${what} gave up on a thread that is gone: ${feed.id}`);
      return;
    }
    feed.failures += 1;
    if (feed.failures >= MAX_FEED_FAILURES) {
      feed.dead = true;
      bb.log.debug(
        `fleet ${what} failed ${feed.failures}x, leaving ${feed.id} alone: ${messageOf(error)}`,
      );
      return;
    }
    // Exponential, so a server having a bad minute is asked once a minute
    // rather than twelve times.
    feed.retryAt =
      Date.now() +
      Math.min(MAX_RETRY_MS, DRAIN_RETRY_MS * 2 ** (feed.failures - 1));
    bb.log.debug(`fleet ${what} failed: ${feed.id}: ${messageOf(error)}`);
  }

  /** A read worked: the feed is healthy again. */
  function noteSuccess(feed: Feed): void {
    feed.failures = 0;
    feed.retryAt = 0;
  }

  /**
   * Jump this feed to the tail of its log. Used for a cold start and for
   * catching up: a feed whose backlog is bigger than one drain pass can never
   * walk it off, because the thread appends faster than the reader retires.
   * Skipping loses the middle, which is exactly right for a "now" view.
   */
  async function readTail(feed: Feed): Promise<boolean> {
    if (stopped || feed.dead) return false;
    let rows: WireRow[];
    try {
      rows = (await bb.sdk.threads.events.list({
        threadId: feed.id,
        order: "desc",
        types: FLEET_EVENT_TYPES,
        limit: String(SEED_LIMIT),
      })) as unknown as WireRow[];
    } catch (error) {
      noteFailure(feed, "tail read", error);
      return false;
    }
    noteSuccess(feed);
    feed.resyncAt = Date.now() + RESYNC_INTERVAL_MS;
    if (!Array.isArray(rows) || rows.length === 0) return true;
    const stamp = Date.now();
    let newest = 0;
    for (const row of rows) {
      const seq = row.seq;
      if (typeof seq === "number" && seq > newest) newest = seq;
    }
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      applyRow(feed, rows[index] as WireRow, stamp);
    }
    feed.cursor = Math.max(feed.cursor, newest);
    feed.target = Math.max(feed.target, newest);
    return true;
  }

  /** Read this thread's new events. One read loop per thread at a time. */
  async function drain(feed: Feed): Promise<void> {
    if (feed.draining || stopped || feed.dead || feed.retryAt > Date.now()) {
      return;
    }
    feed.draining = true;
    try {
      // Too far behind to walk: take the tail and carry on from there. This is
      // the difference between a feed that recovers in one read and one that
      // shows minutes-old history for as long as its thread keeps talking.
      if (feed.target - feed.cursor > CATCHUP_LIMIT) {
        bb.log.debug(
          `fleet skipping ${feed.target - feed.cursor} unread events on ${feed.id}`,
        );
        // A page size dropped by an earlier oversized response gets a fresh
        // start here too; we are not reading that stretch of log again.
        feed.drainLimit = DRAIN_LIMIT;
        await readTail(feed);
        feed.cursor = Math.max(feed.cursor, feed.target);
        return;
      }
      let pageLimit = Math.max(
        MIN_DRAIN_LIMIT,
        Math.min(DRAIN_LIMIT, feed.drainLimit),
      );
      let round = 0;
      while (round < DRAIN_ROUNDS && feed.cursor < feed.target) {
        let rows: unknown;
        try {
          rows = await bb.sdk.threads.events.list({
            threadId: feed.id,
            afterSeq: String(feed.cursor),
            order: "asc",
            types: FLEET_EVENT_TYPES,
            limit: String(pageLimit),
          });
        } catch (error) {
          if (isPayloadTooLarge(error)) {
            if (pageLimit > MIN_DRAIN_LIMIT) {
              pageLimit = Math.max(MIN_DRAIN_LIMIT, Math.floor(pageLimit / 2));
              feed.drainLimit = pageLimit;
              bb.log.debug(
                `fleet drain response too large: ${feed.id}; retrying with ${pageLimit} rows`,
              );
              continue;
            }
            // One event that does not fit in a response of its own. Halving
            // cannot go below one, so the only way past it is past it: step
            // the cursor over that row rather than asking for it forever.
            feed.cursor += 1;
            round += 1;
            bb.log.debug(
              `fleet drain skipped an oversized event on ${feed.id} at seq ${feed.cursor}`,
            );
            continue;
          }
          noteFailure(feed, "drain", error);
          return;
        }
        round += 1;
        noteSuccess(feed);
        if (!Array.isArray(rows)) {
          noteFailure(feed, "drain", new Error("event list was not an array"));
          return;
        }
        if (rows.length === 0) {
          feed.cursor = feed.target;
          break;
        }
        const stamp = Date.now();
        let newest = feed.cursor;
        for (const row of rows) {
          const seq = row.seq;
          if (typeof seq === "number" && seq > newest) newest = seq;
        }
        for (const row of rows) applyRow(feed, row, stamp);
        if (newest <= feed.cursor) break;
        feed.cursor = newest;
        if (rows.length < pageLimit) break;
      }
    } finally {
      feed.draining = false;
    }
  }

  /** Cold-start one feed from the tail of its event log. */
  async function hydrate(feed: Feed): Promise<void> {
    if (feed.hydrated || stopped || feed.dead || feed.retryAt > Date.now()) {
      return;
    }
    feed.hydrated = true;
    // A one-off read failure used to leave a feed permanently unseeded, so a
    // failed tail read un-latches this and backs off instead.
    if (!(await readTail(feed))) {
      feed.hydrated = false;
      return;
    }
    await hydrateModel(feed);
  }

  /**
   * The feed thinks it is caught up but its thread is running and silent.
   * Following the log forward cannot fix that — the cursor is already at the
   * end of what we were told about — so re-read the tail. Rate-limited, and
   * only for threads core says are running, so a genuinely idle fleet costs
   * nothing.
   */
  async function resyncIfStale(feed: Feed): Promise<void> {
    const now = Date.now();
    if (
      stopped ||
      feed.dead ||
      !feed.hydrated ||
      feed.draining ||
      feed.retryAt > now ||
      feed.resyncAt > now ||
      !feedIsStale(feed, now)
    ) {
      return;
    }
    bb.log.debug(
      `fleet re-reading the tail of a stale running thread: ${feed.id}`,
    );
    await readTail(feed);
  }

  /**
   * Model selection lives on the request event, not the thread DTO. A
   * filtered lookup keeps the model visible even when a busy thread's latest
   * 24 events have already pushed that request out of the cold-start tail.
   */
  async function hydrateModel(feed: Feed): Promise<void> {
    const now = Date.now();
    if (
      (feed.model !== null && feed.effort !== null) ||
      stopped ||
      feed.modelRetryAt > now
    ) {
      return;
    }
    feed.modelRetryAt = now + DRAIN_RETRY_MS;
    try {
      // Core already resolves the execution tuple for the latest turn. This is
      // the reliable path for a quiet thread whose request event is far back
      // in history, and it avoids making the wall depend on a particular
      // provider's request-event payload shape.
      const execution = await bb.sdk.threads.defaultExecutionOptions({
        threadId: feed.id,
      });
      if (execution !== null) {
        if (typeof execution.reasoningLevel === "string") {
          feed.effort = clip(execution.reasoningLevel, 32);
        }
        if (feed.model === null && typeof execution.model === "string") {
          feed.model = clip(execution.model, 120);
        }
        if (feed.model !== null && feed.effort !== null) {
          feed.modelRetryAt = 0;
          return;
        }
      }
    } catch (error) {
      bb.log.debug(`fleet execution lookup failed: ${feed.id}: ${messageOf(error)}`);
    }
    try {
      let beforeSeq: string | undefined;
      for (let page = 0; page < MODEL_LOOKUP_PAGES; page += 1) {
        const rows = (await bb.sdk.threads.events.list({
          threadId: feed.id,
          order: "desc",
          limit: String(MODEL_LOOKUP_LIMIT),
          types: MODEL_EVENT_TYPES,
          ...(beforeSeq === undefined ? {} : { beforeSeq }),
        })) as unknown as WireRow[];
        if (!Array.isArray(rows) || rows.length === 0) return;
        let oldest = Number.POSITIVE_INFINITY;
        for (const row of rows) {
          const effort = effortOf(row);
          if (effort !== null) feed.effort = effort;
          const model = modelOf(row);
          if (feed.model === null && model !== null) {
            feed.model = model;
          }
          if (feed.model !== null && feed.effort !== null) {
            feed.modelRetryAt = 0;
            return;
          }
          if (typeof row.seq === "number" && row.seq < oldest) {
            oldest = row.seq;
          }
        }
        if (
          rows.length < MODEL_LOOKUP_LIMIT ||
          !Number.isFinite(oldest) ||
          oldest <= 1
        ) {
          return;
        }
        beforeSeq = String(oldest);
      }
    } catch (error) {
      bb.log.debug(`fleet model lookup failed: ${feed.id}: ${messageOf(error)}`);
    }
  }

  /**
   * The wall's frame. `order` pins the layout the viewer already read: tiles
   * keep their slot, so nothing slides around under the pointer or resets a
   * scroll position while the fleet is busy.
   */
  function frame(order?: WallOrder, rows = maxRows()): FleetFrame {
    return buildFrame(feeds.values(), {
      now: Date.now(),
      maxRows: rows,
      showQuiet: config.showQuiet,
      order,
    });
  }

  /**
   * Publish at most once per tick, and never an unchanged frame. The clock is
   * deliberately excluded from the comparison: `t` and `quietMs` move on their
   * own, so including them meant this never suppressed anything. The wall ages
   * its rows locally between frames.
   */
  function publish(force = false): void {
    if (stopped) return;
    const built = frame(wallOrder);
    const key = frameKey(built);
    if (!force && key === lastFrameKey) return;
    lastFrameKey = key;
    try {
      bb.realtime.publish(FLEET_CHANNEL, built);
    } catch (error) {
      bb.log.debug(`fleet publish failed: ${messageOf(error)}`);
    }
  }

  /**
   * Seed a feed from the tail of its log, then follow it forward. Ordering
   * matters: a feed nobody has read sits at cursor 0, so draining it first
   * would walk the thread's entire history a page at a time. `hydrate` is a
   * no-op once a feed is seeded, so this is cheap to call on any path.
   */
  async function seed(feed: Feed): Promise<void> {
    try {
      await hydrate(feed);
      // A quiet feed may have no model in its first lookup (for example while
      // core is still resolving a provider). Retry it on a later heartbeat,
      // with the lookup itself enforcing a short backoff.
      if (feed.hydrated) await hydrateModel(feed);
      await drain(feed);
      // Last: a feed can only be judged stale once it has folded whatever it
      // already knew about.
      await resyncIfStale(feed);
    } catch (error) {
      bb.log.debug(`fleet seed failed: ${feed.id}: ${messageOf(error)}`);
    }
  }

  /**
   * A viewer appeared, or renewed their lease. Seed the busy thread ids the
   * sidebar named — every time, not just for the first viewer: a thread that
   * becomes busy while the wall is already open is named by a later heartbeat,
   * and it has to be seeded from its tail like any other. Only the layout is
   * first-viewer business.
   */
  async function startWatching(requested: readonly string[]): Promise<void> {
    const wanted = requested.slice(0, SEED_REQUEST_MAX);
    const firstViewer = !watched();
    watchUntil = Date.now() + WATCH_TTL_MS;
    if (firstViewer) {
      // A fresh look gets a fresh layout: busiest first, then frozen.
      wallOrder.slots.clear();
      wallOrder.next = 0;
    }
    await Promise.all(wanted.map((id) => seed(feedFor(id))));
    publish(firstViewer);
  }

  bb.events.on("experimental_thread.events", ({ thread, sequence }) => {
    const feed = feedFor(thread.id);
    applyThreadDto(feed, thread);
    if (typeof sequence === "number" && sequence > feed.target) {
      feed.target = sequence;
    }
    trimFeeds();
    if (!watched()) return; // status is free; reads are not
    // A hidden thread gets no tile, so there is nothing to read it for. Its
    // parent still counts it, and that comes off the DTO for free.
    if (feed.hidden) return;
    void seed(feed);
  });

  function noteLifecycle(
    status: ToolStatus,
    thread: Parameters<typeof applyThreadDto>[1] & { id: string },
  ): void {
    const feed = feedFor(thread.id);
    applyThreadDto(feed, { ...thread, status });
    if (status !== "active") feed.deltaAt = 0;
    // Settle the last action rather than wiping it: a tile that has gone
    // quiet should still say what it was doing.
    if (status === "idle" || status === "error") {
      if (feed.tool !== null) feed.tool = { ...feed.tool, settled: true };
    }
    trimFeeds();
    if (watched()) publish();
  }

  /**
   * A thread started waiting on a person. Free, like the lifecycle events: no
   * read, and it is the one thing on the wall the viewer has to act on. The
   * matching resolution arrives as an interaction lifecycle row in the event
   * log (see WAIT_EVENTS in lib/fleet.ts), which is also what clears this.
   */
  bb.events.on("interaction.pending", ({ thread, interaction }) => {
    const feed = feedFor(thread.id);
    applyThreadDto(feed, thread);
    // Key on whatever id this payload carries, preferring the field the
    // event log uses so a provider that writes lifecycle rows can resolve it
    // precisely. Providers that write none are cleared by progress instead.
    const record = interaction as { interactionId?: unknown; id?: unknown };
    const id = textOf(record.interactionId) ?? textOf(record.id) ?? thread.id;
    const at = Date.now();
    applyWait(feed, id, waitLabel(interaction), true, at);
    // A thread we have never read still deserves a tile when it needs you.
    if (feed.lastAt === 0) feed.lastAt = at;
    trimFeeds();
    if (watched()) publish();
  });

  bb.events.on("thread.active", ({ thread }) => noteLifecycle("active", thread));
  bb.events.on("thread.idle", ({ thread }) => noteLifecycle("idle", thread));
  bb.events.on("thread.failed", ({ thread }) => noteLifecycle("error", thread));
  bb.events.on("thread.unarchived", ({ thread }) => {
    feedFor(thread.id).hydrated = false;
    trimFeeds();
  });
  for (const event of ["thread.archived", "thread.deleted"] as const) {
    bb.events.on(event, ({ thread }) => {
      feeds.delete(thread.id);
      if (watched()) publish(true);
    });
  }

  bb.rpc.register(rpcContract, {
    async fleet_snapshot({ threadIds }) {
      await startWatching(threadIds);
      return frame(wallOrder);
    },
  });

  bb.background.service("fleet-frame", {
    async start(signal) {
      while (!signal.aborted && !stopped) {
        await sleep(TICK_MS, signal);
        if (signal.aborted || stopped) break;
        if (!watched()) continue;
        const now = Date.now();
        for (const feed of feeds.values()) {
          if (feed.target > feed.cursor) void drain(feed);
          else if (feedIsStale(feed, now)) void resyncIfStale(feed);
        }
        trimFeeds();
        publish();
      }
    },
  });

  /**
   * One snapshot for `bb agent-tv status`: hydrate from the thread list so the
   * command is useful even when nobody has the sidebar open.
   */
  async function collect(
    limit: number,
    projectId: string | null,
  ): Promise<FleetFrame> {
    const want = Math.max(1, Math.min(MAX_ROWS, Math.round(limit)));
    // Scan wider than the caller asked for rows: a thread quiet for longer
    // than the wall's window folds to no row at all. One cap, so `--limit`
    // can always be satisfied.
    const scan = Math.min(SNAPSHOT_SCAN_MAX, want * 2);
    // Ask for the whole (unarchived, visible) list rather than `limit`: the
    // list is not ordered by activity, so a `limit` here would truncate it
    // before the ranking below can pick the threads worth reading.
    const threads = await bb.sdk.threads.list({
      archived: false,
      includeHidden: false,
      ...(projectId === null ? {} : { projectId }),
    });
    const ranked = rankThreadsForSnapshot(
      threads,
      (id) => feeds.get(id)?.lastAt ?? 0,
    ).slice(0, scan);
    await Promise.all(
      ranked.map(async (thread) => {
        const feed = feedFor(thread.id);
        applyThreadDto(feed, thread);
        await hydrate(feed);
        if (feed.hydrated) await hydrateModel(feed);
        // Catch up on whatever core has announced since this feed was last
        // read, then — because nothing drains without a viewer, so a feed can
        // be arbitrarily far behind by now — re-read the tail if following the
        // log forward left it looking at history.
        await drain(feed);
        await resyncIfStale(feed);
      }),
    );
    trimFeeds();
    // The CLI has no layout to preserve, so it sorts by activity each run, and
    // `--limit` governs it rather than the wall's own `maxRows` setting.
    const visible =
      projectId === null
        ? feeds.values()
        : [...feeds.values()].filter((feed) => feed.projectId === projectId);
    const built = buildFrame(visible, {
      now: Date.now(),
      maxRows: want,
      showQuiet: config.showQuiet,
    });
    return { t: built.t, rows: built.rows.slice(0, want) };
  }

  const usage = [
    "Usage:",
    "  bb agent-tv status [--json] [--limit <n>] [--all-projects]",
    "",
    "Print the live fleet feed: what each running thread's agent is doing right",
    "now, the files it touched in the last minute, and its 60s activity trace.",
    "",
    "Run inside a thread it shows that thread's project; --all-projects widens",
    "it to every project on this bb. Run outside a thread it shows everything.",
  ].join("\n");

  bb.cli.register({
    name: "agent-tv",
    summary: "Watch what every running thread's agent is doing right now",
    rendersHelp: true,
    commands: [
      {
        name: "status",
        summary: "Print the live fleet feed",
        usage: "bb agent-tv status [--json] [--limit <n>] [--all-projects]",
      },
    ],
    async run(argv, ctx) {
      const words: string[] = [];
      let json = false;
      let allProjects = false;
      let help = false;
      for (const arg of argv) {
        if (arg === "--json") json = true;
        else if (arg === "--all-projects") allProjects = true;
        else if (arg === "--help" || arg === "-h") help = true;
        else words.push(arg);
      }
      const command = words[0];
      if (help || command === "help") {
        return { exitCode: 0, stdout: `${usage}\n` };
      }
      if (command !== undefined && command !== "status") {
        return { exitCode: 1, stderr: `Unknown command "agent-tv ${command}".\n${usage}` };
      }
      let limit = 12;
      const limitIndex = words.indexOf("--limit");
      if (limitIndex !== -1) {
        const parsed = Number(words[limitIndex + 1]);
        if (!Number.isFinite(parsed) || parsed < 1) {
          return { exitCode: 1, stderr: `--limit wants a number.\n${usage}` };
        }
        limit = parsed;
      }
      // An agent asking "what is the fleet doing" means its own project's
      // fleet. Widening that to every thread on the machine hands it command
      // lines and file paths from work it has nothing to do with, so the
      // caller's project is the default and crossing it is explicit. A human
      // in a terminal has no thread context and still sees everything.
      const projectId =
        allProjects || typeof ctx.projectId !== "string" || ctx.projectId === ""
          ? null
          : ctx.projectId;
      let built: FleetFrame;
      try {
        built = await collect(limit, projectId);
      } catch (error) {
        return { exitCode: 1, stderr: `Cannot read the fleet: ${messageOf(error)}\n` };
      }
      if (json) return { exitCode: 0, stdout: `${JSON.stringify(built)}\n` };
      if (built.rows.length === 0) {
        return {
          exitCode: 0,
          stdout: "Nothing on air — no thread has reported any activity.\n",
        };
      }
      const onAir = built.rows.filter((row) => isBusy(row)).length;
      const needed = built.rows.filter((row) => row.waiting !== null).length;
      const tight = built.rows.filter((row) => underPressure(row)).length;
      const lines = [
        `AGENT TV — ${onAir} of ${built.rows.length} threads on air` +
          (needed === 0 ? "" : ` \u00b7 ${needed} waiting on you`) +
          (tight === 0 ? "" : ` \u00b7 ${tight} near the context limit`),
      ];
      for (const row of built.rows) {
        const glyph =
          row.waiting !== null ? "!" : isBusy(row) ? "\u25cf" : "\u25cc";
        lines.push(`  ${glyph} ${row.title} [${row.status}] ${row.id}`);
        const age = row.quietMs < 1_000 ? "now" : `${formatAge(row.quietMs)} ago`;
        const action =
          row.waiting !== null
            ? `NEEDS YOU: ${row.waiting}`
            : row.status === "error"
              ? row.tool === null
                ? "failed"
                : `failed: ${clip(row.tool, 90)}`
              : row.tool !== null
                ? `${row.verb ?? (row.settled ? "Finished" : "Working")}: ${clip(row.tool, 90)}`
                : row.streaming
                  ? "typing\u2026"
                  : // An item can carry a verb and no text of its own —
                    // reasoning is the common one. The wall has always shown
                    // "Thinking" here; the CLI used to print "quiet".
                    (row.verb ?? "quiet");
        const context = formatContext(row.context);
        lines.push(
          `    ${action}  ${age}  ${sparkline(row.heat)}` +
            (context === null
              ? ""
              : `  ctx ${context}${underPressure(row) ? " !" : ""}`),
        );
        if (row.files.length > 0) {
          lines.push(`    files: ${row.files.map(basename).join(", ")}`);
        }
      }
      return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
    },
  });

  bb.onDispose(() => {
    stopped = true;
    feeds.clear();
  });

  bb.log.info(`Agent TV on air — ${maxRows()} tiles on the wall`);
}

/** Abort-aware sleep — a service must resolve when its signal aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
