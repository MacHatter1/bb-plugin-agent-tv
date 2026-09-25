// bb-plugin-agent-tv — Agent TV frontend: the wall.
//
// One surface: a disclosure in the app sidebar's footer. Click (or hover) the
// Play button and every running thread appears as a tile — the tool call it is
// on, the files it touched in the last minute, a typing indicator while the
// model streams, and its 60-second activity trace.
//
// Data comes from two places and is merged here:
//   * the sidebar's own thread view (titles, status, "needs you") — free, and
//     exactly as fresh as bb's own sidebar;
//   * this plugin's "fleet" realtime channel — the live tool-call feed the
//     server folds out of thread events while somebody is watching.
//
// The realtime payload is parsed at the boundary: it crosses the wire as
// unknown JSON, and nothing on screen trusts its shape.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import {
  definePluginApp,
  experimental_ProviderIcon,
  experimental_useProviders,
  experimental_useSidebarThreadActions,
  experimental_useSidebarThreads,
  useRealtime,
  useRealtimeConnectionState,
  useBbContext,
  useRpc,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import type {
  ExperimentalSidebarFooterDisclosureController,
  ExperimentalSidebarFooterDisclosureProps,
  ExperimentalProviderIconProps,
  PluginSidebarProject,
  PluginSidebarThread,
  PluginProvidersState,
} from "@get-bb/plugin-sdk/app";

/** bb's provider artwork, resolved the way the host resolves it. */
const ProviderIcon = experimental_ProviderIcon;
type ProviderRecord = ExperimentalProviderIconProps["provider"];
type ProviderEntry = PluginProvidersState["providers"][number];
import {
  EMPTY_FRAME,
  FLEET_CHANNEL,
  fleetFrameSchema,
  formatAge,
  formatContext,
  heatLevels,
  underPressure,
  isBusy,
  MAX_FILES,
  basename,
  dirHint,
  type FleetFrame,
  type FleetRow,
} from "./lib/fleet";
import type { rpcContract } from "./server";
import { installHoverPeek } from "./lib/peek";
import { clampWithin, measurePanel, type Offset } from "./lib/popout";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import "./app.css";

/** Plugin id, used to point the hover peek at our own footer row. */
const PLUGIN_ID = "agent-tv";
const FOOTER_ID = "wall";
const TRIGGER_SELECTOR = `[data-testid^="plugin-sidebar-footer-item-${PLUGIN_ID}-${FOOTER_ID}"], [id^="plugin-sidebar-footer-trigger-${PLUGIN_ID}-${FOOTER_ID}-"]`;
const PANEL_SELECTOR = `[data-testid^="plugin-sidebar-footer-disclosure-${PLUGIN_ID}-${FOOTER_ID}"]`;

/** Where the popout was last parked. Per window, so it survives a reload. */
const POPOUT_OFFSET_KEY = "bb-plugin-agent-tv:popout-offset";
/** Quiet rows dismissed with the check mark survive a plugin/app reload. */
const DISMISSED_QUIET_KEY = "bb-plugin-agent-tv:dismissed-quiet";

/**
 * Clamp against the panel's own geometry, so its header — the only thing you
 * can drag it by — stays on screen. Falls through untouched before the panel
 * has laid out; the effect on open re-clamps once it has.
 */
function clampToPanel(element: HTMLElement | null, x: number, y: number): Offset {
  if (element === null) return { x, y };
  const box = measurePanel(element);
  return box === null ? { x, y } : clampWithin(box, x, y);
}

function readOffset(): Offset {
  try {
    const raw = window.localStorage.getItem(POPOUT_OFFSET_KEY);
    if (raw === null) return { x: 0, y: 0 };
    const stored = JSON.parse(raw) as { x?: unknown; y?: unknown };
    if (
      typeof stored.x !== "number" ||
      typeof stored.y !== "number" ||
      !Number.isFinite(stored.x) ||
      !Number.isFinite(stored.y)
    ) {
      return { x: 0, y: 0 };
    }
    // Nothing is mounted yet to measure against; the effect on open clamps
    // this properly once the panel has a size.
    return { x: stored.x, y: stored.y };
  } catch {
    return { x: 0, y: 0 };
  }
}

function writeOffset(offset: Offset): void {
  try {
    window.localStorage.setItem(POPOUT_OFFSET_KEY, JSON.stringify(offset));
  } catch {
    // Storage blocked: the monitor just forgets where it was next time.
  }
}

function readDismissedQuiet(): Set<string> {
  try {
    const raw = window.localStorage.getItem(DISMISSED_QUIET_KEY);
    if (raw === null) return new Set();
    const stored: unknown = JSON.parse(raw);
    if (!Array.isArray(stored)) return new Set();
    return new Set(
      stored.filter(
        (id): id is string =>
          typeof id === "string" && id.length > 0 && id.length <= 64,
      ),
    );
  } catch {
    return new Set();
  }
}

function writeDismissedQuiet(ids: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(DISMISSED_QUIET_KEY, JSON.stringify([...ids]));
  } catch {
    // Storage blocked: keep the viewing-only dismissal in memory.
  }
}

/** The footer disclosure and the app-wide popout share this tiny store. */
let popoutOpen = false;
const popoutListeners = new Set<() => void>();
let dismissedQuietIds =
  typeof window === "undefined" ? new Set<string>() : readDismissedQuiet();
const dismissedQuietListeners = new Set<() => void>();
const EMPTY_DISMISSED_QUIET_IDS: ReadonlySet<string> = new Set();

function setPopoutOpen(next: boolean): void {
  if (next === popoutOpen) return;
  popoutOpen = next;
  for (const listener of popoutListeners) listener();
}

function subscribePopout(listener: () => void): () => void {
  popoutListeners.add(listener);
  return () => popoutListeners.delete(listener);
}

function usePopoutOpen(): boolean {
  return useSyncExternalStore(
    subscribePopout,
    () => popoutOpen,
    () => false,
  );
}

let workingOnly = false;
const workingOnlyListeners = new Set<() => void>();

function setWorkingOnly(next: boolean): void {
  if (next === workingOnly) return;
  workingOnly = next;
  for (const listener of workingOnlyListeners) listener();
}

function subscribeWorkingOnly(listener: () => void): () => void {
  workingOnlyListeners.add(listener);
  return () => workingOnlyListeners.delete(listener);
}

/**
 * A view filter, not the `showQuiet` setting: the setting decides what the
 * pump carries, this decides what you are looking at right now. The app
 * cannot write settings, and wanting to see only live work for a minute is
 * not a reason to reconfigure the plugin.
 */
function useWorkingOnly(): boolean {
  return useSyncExternalStore(
    subscribeWorkingOnly,
    () => workingOnly,
    () => false,
  );
}

function notifyDismissedQuiet(): void {
  for (const listener of dismissedQuietListeners) listener();
}

function dismissQuiet(id: string): void {
  if (dismissedQuietIds.has(id)) return;
  dismissedQuietIds = new Set(dismissedQuietIds).add(id);
  writeDismissedQuiet(dismissedQuietIds);
  notifyDismissedQuiet();
}

function restoreQuiet(id: string): void {
  if (!dismissedQuietIds.has(id)) return;
  const next = new Set(dismissedQuietIds);
  next.delete(id);
  dismissedQuietIds = next;
  writeDismissedQuiet(dismissedQuietIds);
  notifyDismissedQuiet();
}

function subscribeDismissedQuiet(listener: () => void): () => void {
  dismissedQuietListeners.add(listener);
  return () => dismissedQuietListeners.delete(listener);
}

function useDismissedQuietIds(): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribeDismissedQuiet,
    () => dismissedQuietIds,
    () => EMPTY_DISMISSED_QUIET_IDS,
  );
}

/*
 * The wall is a fixed-size monitor on purpose. bb measures the disclosure and
 * animates its height, so a panel that grows and shrinks as tiles change would
 * clamp the scroll offset you carefully set. Instead: every tile is exactly
 * TILE_HEIGHT tall (the file line is reserved, not conditional), the list is
 * exactly VISIBLE_TILES of them, and the list owns its own scrolling. The
 * panel's height therefore never moves while you are in it, and `maxRows`
 * becomes "how many threads the feed carries", not "how tall this gets".
 */
const TILE_HEIGHT = 58;
const VISIBLE_TILES = 4;

/** How often the open wall renews its lease on the server's pump. */
const HEARTBEAT_MS = 10_000;
/** Sidebar threads one snapshot call asks the server to hydrate. */
const HYDRATE_MAX = 12;

function peekEnabled(values: Record<string, string | number | boolean> | undefined): boolean {
  return values?.peekOnHover !== false;
}

/**
 * Which agent is running each thread, and how the threads are related. Both
 * come from data the app already has: bb's provider roster (no fetch — the
 * hook reads the host's own cache) and the sidebar's parent links. The frame's
 * own `childCount` is the tie-breaker for subagents that are hidden from the
 * sidebar, which is how UltraGoal workers usually run.
 */
function useFleetFamily(
  threads: readonly PluginSidebarThread[],
  projects: readonly PluginSidebarProject[],
) {
  const { providers } = experimental_useProviders();
  return useMemo(() => {
    const byId = new Map<string, ProviderEntry>();
    for (const provider of providers) byId.set(provider.id, provider);
    const projectsById = new Map<string, PluginSidebarProject>();
    for (const project of projects) projectsById.set(project.id, project);
    const visibleChildren = new Map<string, PluginSidebarThread[]>();
    const titles = new Map<string, string>();
    for (const thread of threads) {
      titles.set(thread.id, thread.title ?? thread.titleFallback ?? thread.id);
      if (thread.parentThreadId === null || thread.isArchived) continue;
      const siblings = visibleChildren.get(thread.parentThreadId);
      if (siblings === undefined) {
        visibleChildren.set(thread.parentThreadId, [thread]);
      } else {
        siblings.push(thread);
      }
    }
    return {
      name: (providerId: string | null): string | null =>
        providerId === null
          ? null
          : (byId.get(providerId)?.displayName ?? providerId),
      provider: (providerId: string | null): ProviderRecord | null =>
        providerId === null ? null : (byId.get(providerId) ?? { id: providerId }),
      childrenOf: (threadId: string): PluginSidebarThread[] =>
        visibleChildren.get(threadId) ?? [],
      titleOf: (threadId: string): string => titles.get(threadId) ?? threadId,
      projectNameOf: (projectId: string | null): string | null => {
        if (projectId === null) return null;
        const project = projectsById.get(projectId);
        return project === undefined || project.isPersonal ? null : project.name;
      },
    };
  }, [projects, providers, threads]);
}

/* ------------------------------------------------------------------ *
 * The live feed
 * ------------------------------------------------------------------ */

/** Sidebar signals that a thread has work the wall should keep watching. */
function looksBusy(thread: PluginSidebarThread): boolean {
  if (thread.isArchived) return false;
  if (thread.hasPendingInteraction) return true;
  const { workflows, backgroundAgents, backgroundCommands, planMode, goals } =
    thread.activity;
  if (workflows + backgroundAgents + backgroundCommands + planMode + goals > 0) {
    return true;
  }
  return (
    thread.indicator === "runtime" ||
    thread.indicator === "working-draft" ||
    thread.indicator === "background-agent" ||
    thread.indicator === "background-command" ||
    thread.indicator === "workflow" ||
    thread.indicator === "plan-mode" ||
    thread.indicator === "goal"
  );
}

/** Threads worth reading events for, most recently touched first. */
function hydrateIds(threads: readonly PluginSidebarThread[]): string[] {
  return threads
    .filter(looksBusy)
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, HYDRATE_MAX)
    .map((thread) => thread.id);
}

function useFleetFeed(
  threads: readonly PluginSidebarThread[],
  currentThreadId: string | null,
): { frame: FleetFrame; stale: boolean; receivedAt: number } {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const [frame, setFrame] = useState<FleetFrame>(EMPTY_FRAME);
  // When this frame arrived, on *this* clock. The pump publishes only when a
  // frame's content changes, so rows have to be aged locally between frames —
  // and measuring the gap locally keeps us out of any server clock skew.
  const [receivedAt, setReceivedAt] = useState(0);
  const [stale, setStale] = useState(false);
  const wanted = useMemo(() => {
    const ids = hydrateIds(threads);
    // The footer is global, but the current route can be a thread that has not
    // reached the sidebar cache yet. Keep the chat the user is looking at in
    // the server's seed set, even when it is otherwise quiet.
    if (
      typeof currentThreadId === "string" &&
      currentThreadId.length > 0 &&
      !ids.includes(currentThreadId)
    ) {
      if (ids.length >= HYDRATE_MAX) ids[HYDRATE_MAX - 1] = currentThreadId;
      else ids.push(currentThreadId);
    }
    return ids;
  }, [currentThreadId, threads]);
  const wantedRef = useRef(wanted);
  wantedRef.current = wanted;
  const lastRouteThreadId = useRef<string | null>(currentThreadId);
  const routeSeen = useRef(false);
  const connectedOnce = useRef(false);

  const accept = useCallback((next: FleetFrame) => {
    setFrame(next);
    setReceivedAt(Date.now());
    setStale(false);
  }, []);

  const refresh = useCallback(() => {
    void rpc
      .call("fleet_snapshot", { threadIds: wantedRef.current })
      .then(accept)
      .catch(() => setStale(true));
  }, [accept, rpc]);

  // The disclosure is global, so it can stay mounted while the user moves to
  // another chat. Do not wait for the 10s lease heartbeat before asking for
  // that newly selected route thread.
  useEffect(() => {
    if (!routeSeen.current) {
      routeSeen.current = true;
      lastRouteThreadId.current = currentThreadId;
      return;
    }
    if (lastRouteThreadId.current === currentThreadId) return;
    lastRouteThreadId.current = currentThreadId;
    refresh();
  }, [currentThreadId, refresh]);

  // The server publishes a frame every second while the wall is open; a
  // snapshot on mount primes it, and the heartbeat renews the lease that lets
  // the pump read at all.
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  useRealtime(
    FLEET_CHANNEL,
    useCallback(
      (payload: unknown) => {
        const parsed = fleetFrameSchema.safeParse(payload);
        if (!parsed.success) return; // a foreign or malformed frame is not news
        accept(parsed.data);
      },
      [accept],
    ),
  );

  // Signals are ephemeral and never replayed, so reconcile durable state when
  // the socket comes back.
  useEffect(() => {
    if (connection !== "connected") {
      connectedOnce.current = false;
      return;
    }
    if (connectedOnce.current) refresh();
    else connectedOnce.current = true;
  }, [connection, refresh]);

  return { frame, stale, receivedAt };
}

/**
 * The wall's own clock, so "12s ago" keeps counting between frames. Idle while
 * there is nothing on screen to age.
 */
function useTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/* ------------------------------------------------------------------ *
 * Tiles
 * ------------------------------------------------------------------ */

function Sparkline({ heat, busy }: { heat: readonly number[]; busy: boolean }) {
  const levels = heatLevels(heat);
  return (
    <span
      aria-hidden
      className={cn(
        "flex h-3 shrink-0 items-end gap-px",
        busy ? "text-destructive/70" : "text-muted-foreground/40",
      )}
    >
      {levels.map((level, index) => (
        <span
          key={index}
          className="w-[2px] rounded-[1px] bg-current transition-[height] duration-500"
          style={{ height: `${Math.max(8, Math.round(level * 100))}%` }}
        />
      ))}
    </span>
  );
}

function TypingDots() {
  return (
    <span
      aria-label="The model is writing"
      className="agtv-dots inline-flex items-end gap-[2px] text-muted-foreground"
    >
      <span data-testid="agtv-dot" className="agtv-dot" />
      <span data-testid="agtv-dot" className="agtv-dot" />
      <span data-testid="agtv-dot" className="agtv-dot" />
    </span>
  );
}

/**
 * One glance, one state. Working, waiting on a person and failed used to be
 * the same red dot — three of the four things worth knowing, told apart only
 * by an animation. Shape carries the difference now, so it survives a
 * greyscale screenshot and any palette: a live circle with a halo, a ringed
 * circle for an ask, a diamond for a failure. Colour stays on host tokens.
 */
function stateOf(row: FleetRow): {
  label: string;
  dot: string;
  halo: boolean;
  ring: boolean;
} {
  if (row.status === "error") {
    return {
      label: "Failed",
      dot: "size-2 rotate-45 rounded-sm bg-destructive",
      halo: false,
      ring: false,
    };
  }
  if (row.waiting !== null) {
    return {
      label: `Waiting for you: ${row.waiting}`,
      dot: "size-2 rounded-full bg-destructive",
      halo: false,
      ring: true,
    };
  }
  if (isBusy(row)) {
    return {
      label: "Working",
      dot: "size-2 rounded-full bg-destructive",
      halo: true,
      ring: false,
    };
  }
  if (row.status === "idle") {
    return {
      label: "Idle",
      dot: "size-2 rounded-full bg-muted-foreground/40",
      halo: false,
      ring: false,
    };
  }
  // Starting, stopping, provisioning: real states, but not work yet.
  return {
    label: row.status,
    dot: "size-2 rounded-full border border-muted-foreground/60",
    halo: false,
    ring: false,
  };
}

function StatusDot({ row }: { row: FleetRow }) {
  const state = stateOf(row);
  return (
    <span
      role="img"
      aria-label={state.label}
      title={state.label}
      className="relative flex size-2 shrink-0 items-center justify-center"
    >
      <span className={state.dot} />
      {state.ring ? (
        <span className="absolute size-2 rounded-full ring-2 ring-destructive/30" />
      ) : null}
      {state.halo ? (
        <span className="agtv-ping absolute size-2 rounded-full bg-destructive" />
      ) : null}
    </span>
  );
}

/**
 * Context runway: how much of its window this thread has burned. It lives in
 * the meter column under the sparkline — spanning the tile it read as an
 * underline between rows rather than a gauge. Absent entirely when the
 * provider reports nothing, because an empty rail would say "plenty left",
 * which is a worse lie than saying nothing at all.
 */
function RunwayBar({ row }: { row: FleetRow }) {
  if (row.context === null) return null;
  const pct = Math.round(row.context.fraction * 100);
  const tight = underPressure(row);
  return (
    <span
      aria-hidden
      className="h-[2px] w-full overflow-hidden rounded-full bg-muted-foreground/15"
    >
      <span
        className={cn(
          "block h-full rounded-full transition-[width] duration-500",
          tight ? "bg-destructive/80" : "bg-muted-foreground/45",
        )}
        style={{ width: `${Math.max(2, pct)}%` }}
      />
    </span>
  );
}

function FileChip({ path }: { path: string }) {
  const dir = dirHint(path);
  return (
    <span
      title={path}
      className="inline-flex min-w-0 max-w-full shrink items-center gap-1 whitespace-nowrap rounded-sm bg-muted/60 px-1 font-mono text-[10px] leading-[14px] text-muted-foreground"
    >
      {/* Bounded and nowrap: a long parent directory used to wrap inside the
          chip and push the metadata line to two rows. */}
      {dir === "" ? null : (
        <span className="min-w-0 shrink truncate opacity-60">{dir}/</span>
      )}
      <span className="shrink-0 truncate text-foreground/80">
        {basename(path)}
      </span>
    </span>
  );
}

function FamilyBadge({
  icon,
  count,
  label,
}: {
  icon: string;
  count: number;
  label: string;
}) {
  return (
    <span
      title={label}
      className="flex shrink-0 items-center gap-px font-mono text-[10px] leading-[14px] text-muted-foreground/80"
    >
      <Icon name={icon} className="size-3" />
      {count > 1 ? count : null}
    </span>
  );
}

function Tile({
  row,
  thread,
  provider,
  providerName,
  projectName,
  childThreads,
  parentTitle,
  age,
  onOpen,
  onDismiss,
}: {
  row: FleetRow;
  thread: PluginSidebarThread | undefined;
  provider: ProviderRecord | null;
  providerName: string | null;
  projectName: string | null;
  childThreads: readonly PluginSidebarThread[];
  parentTitle: string | null;
  /** ms since this thread's last event, aged locally past the frame. */
  age: number;
  onOpen: (split: boolean) => void;
  onDismiss?: () => void;
}) {
  const busy = isBusy(row);
  const title = thread?.title ?? thread?.titleFallback ?? row.title;
  // Two sources agree here: the sidebar's own flag, and what the pump folded
  // out of the interaction rows — which is also what the CLI sees.
  const waiting = row.waiting !== null || thread?.hasPendingInteraction === true;
  const failed = row.status === "error";
  const tool = row.tool ?? "";
  const subtitle = waiting
    ? row.waiting === null
      ? "waiting for you"
      : `needs you: ${row.waiting}`
    : failed
      ? // It used to read "quiet": a failure wiped the tool line and nothing
        // filled it. Name what failed when we still know.
        tool === "" ? "failed" : `failed: ${tool}`
      : tool === ""
        ? (row.verb ?? (busy ? "working" : "quiet"))
        : tool;
  const shown = row.files.slice(0, 2);
  const hidden = row.files.length - shown.length;
  // Threads the sidebar knows about, plus any the wall can see working that it
  // cannot — hidden subagents are normal for orchestrated work.
  const childCount = Math.max(childThreads.length, row.childCount);
  const summary = [
    parentTitle === null ? null : `under ${parentTitle}`,
    childCount === 0 ? null : `${childCount} ${childCount === 1 ? "subagent" : "subagents"}`,
  ]
    .filter((part): part is string => part !== null)
    .join(" \u00b7 ");
  const context = formatContext(row.context);
  const details = [
    row.model === null ? null : row.model,
    row.effort === null ? null : `effort ${row.effort}`,
    row.context === null
      ? null
      : `context ${context} (${row.context.used.toLocaleString()} of ${row.context.window.toLocaleString()} tokens${row.context.estimated ? ", estimated" : ""})`,
    projectName === null ? null : projectName,
    parentTitle === null ? null : `under ${parentTitle}`,
    childCount === 0 ? null : `${childCount} ${childCount === 1 ? "subagent" : "subagents"}`,
  ]
    .filter((part): part is string => part !== null)
    .join(" \u00b7 ");
  return (
    <li style={{ height: TILE_HEIGHT }}>
      <div className="flex h-full min-w-0 items-stretch gap-0.5">
        <button
          type="button"
          onClick={(event) => onOpen(event.shiftKey || event.metaKey)}
          onAuxClick={(event) => {
            if (event.button === 1) onOpen(true);
          }}
          title={`${details === "" ? title : `${title}\n${details}`}\nShift-click to open beside the wall`}
          className={cn(
            "flex h-full min-w-0 flex-1 items-center gap-2 overflow-hidden rounded-md border border-transparent px-2 text-left transition-colors",
            "hover:border-sidebar-border hover:bg-sidebar-accent/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring",
            busy && "bg-sidebar-accent/30",
            // A thread blocked on a person is the only row you must act on, so
            // it is marked on the tile and not just in an 8px dot.
            waiting && "bg-destructive/5 ring-1 ring-inset ring-destructive/40",
          )}
        >
          {/* Gutter: one mark, and it is the state. The provider glyph used
              to sit under it and out-weigh it — the least changing thing on a
              tile drawing more eye than the most important one. */}
          <StatusDot row={row} />

          {/* The thread: three lines sharing one left edge. */}
          <span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                {title}
              </span>
              {projectName === null ? null : (
                <span
                  title={projectName}
                  className="max-w-[92px] shrink-0 truncate text-[10px] leading-[14px] text-muted-foreground/75"
                >
                  {projectName}
                </span>
              )}
              {parentTitle === null ? null : (
                <FamilyBadge
                  icon="CornerDownRight"
                  count={1}
                  label={`under ${parentTitle}`}
                />
              )}
              {childCount === 0 ? null : (
                <FamilyBadge
                  icon="Layers"
                  count={childCount}
                  label={`${childCount} ${childCount === 1 ? "subagent" : "subagents"} on the wall`}
                />
              )}
            </span>

            <span className="flex min-w-0 items-center gap-1.5">
              {row.streaming ? <TypingDots /> : null}
              {row.tool !== null && row.glyph !== null ? (
                <Icon
                  name={row.glyph}
                  fallback="Circle"
                  className="size-3 shrink-0 text-muted-foreground"
                />
              ) : null}
              <span
                className={cn(
                  "min-w-0 flex-1 truncate font-mono text-[11px] leading-[14px]",
                  waiting || failed
                    ? "text-destructive"
                    : busy
                      ? "text-foreground/75"
                      : "text-muted-foreground",
                )}
              >
                {subtitle}
              </span>
            </span>

            {/* Always here, so a tile never changes height: the model, effort
                and provider identify the run; recent files fill the room left. */}
            <span className="flex min-w-0 items-center gap-1 overflow-hidden">
              {/* Sans, and separated: in the same monospace as the directory
                  hints, "Starboard app/ cache.ts" read as one path. */}
              {provider === null ? null : (
                <ProviderIcon
                  providerKind="agent"
                  provider={provider}
                  fallback="Bot"
                  aria-label={providerName ?? "agent"}
                  className="size-3 shrink-0 opacity-70"
                />
              )}
              {row.model === null ? null : (
                <span
                  title={row.model}
                  className="max-w-[105px] shrink-0 truncate font-mono text-[10px] leading-[14px] text-muted-foreground/75"
                >
                  {row.model}
                </span>
              )}
              {row.model !== null && row.effort !== null ? (
                <span aria-hidden className="shrink-0 text-muted-foreground/40">
                  &middot;
                </span>
              ) : null}
              {row.effort === null ? null : (
                <span
                  title={`Model effort: ${row.effort}`}
                  className="max-w-[82px] shrink-0 truncate font-mono text-[10px] leading-[14px] text-muted-foreground/75"
                >
      {row.effort}
                </span>
              )}
              {(row.model !== null || row.effort !== null) && shown.length > 0 ? (
                <span aria-hidden className="shrink-0 text-muted-foreground/40">
                  &middot;
                </span>
              ) : null}
              {shown.map((path) => (
                <FileChip key={path} path={path} />
              ))}
              {hidden > 0 ? (
                <span className="shrink-0 font-mono text-[10px] leading-[14px] text-muted-foreground/70">
                  +{hidden}
                </span>
              ) : null}
              {shown.length === 0 ? (
                <span className="min-w-0 flex-1 truncate font-mono text-[10px] leading-[14px] text-muted-foreground/60">
                  {summary}
                </span>
              ) : null}
            </span>
          </span>

          {/* History: the last minute, and how long since anything at all. */}
          <span className="flex w-10 shrink-0 flex-col items-end justify-center gap-0.5">
            <Sparkline heat={row.heat} busy={busy} />
            <span className="flex items-baseline gap-1 font-mono text-[10px] leading-[14px]">
              {context === null ? null : (
                <span
                  className={cn(
                    underPressure(row)
                      ? "text-destructive"
                      : "text-muted-foreground/45",
                  )}
                >
                  {context}
                </span>
              )}
              <span className="text-muted-foreground/70">{formatAge(age)}</span>
            </span>
            <RunwayBar row={row} />
          </span>
        </button>
        {onDismiss === undefined ? null : (
          <button
            type="button"
            onClick={onDismiss}
            aria-label={`Dismiss ${title} from Agent TV`}
            title="Dismiss quiet thread"
            className="flex w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring"
          >
            <Icon name="Check" fallback="CircleCheck" className="size-3.5" />
          </button>
        )}
      </div>
    </li>
  );
}

/* ------------------------------------------------------------------ *
 * The wall
 * ------------------------------------------------------------------ */

type FleetPanelProps = {
  onClose(): void;
  onPopout?: () => void;
  floating?: boolean;
  onDragStart?: (event: ReactPointerEvent<HTMLElement>) => void;
  /** Arrow-key movement, so the popout is not pointer-only. */
  onNudge?: (event: ReactKeyboardEvent<HTMLElement>) => void;
};

function FleetPanel({
  onClose,
  onPopout,
  floating = false,
  onDragStart,
  onNudge,
}: FleetPanelProps) {
  const { threads, projects } = experimental_useSidebarThreads();
  const { threadId: currentThreadId } = useBbContext();
  const actions = experimental_useSidebarThreadActions();
  const { frame, stale, receivedAt } = useFleetFeed(threads, currentThreadId);
  const family = useFleetFamily(threads, projects);
  const dismissedQuietIds = useDismissedQuietIds();

  useEffect(() => {
    for (const row of frame.rows) {
      if (isBusy(row)) restoreQuiet(row.id);
    }
  }, [frame.rows]);

  const byId = useMemo(() => {
    const map = new Map<string, PluginSidebarThread>();
    for (const thread of threads) map.set(thread.id, thread);
    return map;
  }, [threads]);

  const onlyWorking = useWorkingOnly();
  const known = frame.rows.filter(
    (row) =>
      isBusy(row) || row.waiting !== null || !dismissedQuietIds.has(row.id),
  );
  // Counts describe the whole fleet; the filter only changes what is drawn.
  const onAir = known.filter((row) => isBusy(row)).length;
  const needed = known.filter((row) => row.waiting !== null).length;
  const rows = onlyWorking
    ? known.filter((row) => isBusy(row) || row.waiting !== null)
    : known;
  const filesLast = rows.reduce((total, row) => total + row.files.length, 0);
  // Age rows against our own clock: a frame only arrives when something in it
  // changed, so quietMs would otherwise freeze on a settled wall.
  const now = useTick(rows.length > 0);
  const sinceFrame = Math.max(0, now - receivedAt);

  // Whether the list continues below the fold. Four tiles of a fleet of
  // twenty behind an auto-hiding scrollbar looked like the whole fleet.
  const list = useRef<HTMLUListElement | null>(null);
  const [more, setMore] = useState(false);
  const measure = useCallback(() => {
    const element = list.current;
    if (element === null) return;
    setMore(element.scrollHeight - element.scrollTop - element.clientHeight > 4);
  }, []);
  useEffect(measure, [measure, rows.length]);

  return (
    <div className={cn("flex flex-col gap-1 p-1.5", floating && "min-h-0")}>
      <header
        onPointerDown={(event) => {
          if (
            event.target instanceof Element &&
            event.target.closest("button") !== null
          ) {
            return;
          }
          onDragStart?.(event);
        }}
        onKeyDown={onNudge}
        tabIndex={floating ? 0 : undefined}
        role={floating ? "group" : undefined}
        aria-label={
          floating ? "Agent TV popout — move it with the arrow keys" : undefined
        }
        className={cn(
          "flex items-center gap-2 px-1.5 pb-1 pt-0.5",
          floating && "cursor-move select-none",
          floating &&
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring",
        )}
      >
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-foreground">
          Agent TV
        </span>
        <span
          className={cn(
            "shrink-0 rounded-sm px-1.5 py-px font-mono text-[9px] font-semibold tracking-[0.1em]",
            needed > 0 || onAir > 0
              ? "agtv-live bg-destructive/15 text-destructive"
              : "bg-muted text-muted-foreground",
          )}
        >
          {needed > 0 ? "NEEDS YOU" : onAir > 0 ? "ON AIR" : "QUIET"}
        </span>
        {/* The drag handle: whatever is left over between the lamp and the
            counts. Buttons swallow the gesture, so the header needs a
            stretch that is not one. */}
        <span aria-hidden className="min-w-4 flex-1 self-stretch" />
        {/* The count is the filter. `showQuiet` is a setting you change with
            the CLI; wanting to see only live work for a minute should be one
            click, and this needs no extra room in a 303px header. */}
        <button
          type="button"
          onClick={() => setWorkingOnly(!onlyWorking)}
          aria-pressed={onlyWorking}
          title={
            onlyWorking
              ? "Showing only threads working or waiting on you \u2014 click to show every thread"
              : `${onAir} of ${known.length} working${needed > 0 ? `, ${needed} waiting on you` : ""} \u00b7 ${filesLast} files touched in the last minute \u2014 click to show only live threads`
          }
          className={cn(
            // Deliberately not flex-1: dragging is ignored on buttons, and a
            // full-width one left the popout with almost no drag handle.
            "min-w-0 shrink-0 truncate rounded text-right font-mono text-[9px] transition-colors",
            "hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring",
            onlyWorking ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {/* Roughly 24 characters fit beside the title and the buttons, so
              the file rate yields to the count that needs acting on. */}
          {known.length === 0
            ? ""
            : onlyWorking
              ? `live only \u00b7 ${onAir}/${known.length}`
              : needed > 0
                ? `${needed} waiting \u00b7 ${onAir}/${known.length}`
                : `${onAir}/${known.length} \u00b7 ${filesLast} files/min`}
        </button>
        {onPopout === undefined ? null : (
          <button
            type="button"
            onClick={onPopout}
            aria-label="Pop out Agent TV"
            title="Pop out Agent TV"
            className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring"
          >
            <Icon name="ExternalLink" fallback="Play" className="size-3" />
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label={floating ? "Close Agent TV popout" : "Close Agent TV"}
          title={floating ? "Close Agent TV popout" : "Close Agent TV"}
          className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring"
        >
          <Icon name="X" className="size-3" />
        </button>
      </header>

      {rows.length === 0 ? (
        <p className="px-2 pb-2 pt-1 text-[11px] leading-5 text-muted-foreground">
          {stale
            ? "Agent TV cannot reach the server right now."
            : onlyWorking && known.length > 0
              ? `Nothing is working right now \u2014 ${known.length} quiet ${known.length === 1 ? "thread" : "threads"} hidden.`
              : "No thread has reported any activity yet. Start one, and its tile appears here."}
        </p>
      ) : (
        <ul
          ref={list}
          onScroll={measure}
          className={cn(
            "agtv-scroll -mx-1 overflow-y-auto overscroll-contain px-1",
            // Nothing animates the popout's height, so it may use the screen
            // it was given rather than showing the sidebar's four tiles.
            floating && "agtv-popout-list min-h-0 flex-1",
            more && "agtv-fade-bottom",
          )}
          style={floating ? undefined : { height: TILE_HEIGHT * VISIBLE_TILES }}
        >
          {rows.map((row) => {
            const thread = byId.get(row.id);
            const providerId = thread?.providerId ?? row.providerId ?? null;
            const projectId = thread?.projectId ?? row.projectId ?? null;
            const parentId = thread?.parentThreadId ?? row.parentThreadId ?? null;
            return (
              <Tile
                key={row.id}
                row={row}
                thread={thread}
                provider={family.provider(providerId)}
                providerName={family.name(providerId)}
                projectName={family.projectNameOf(projectId)}
                childThreads={family.childrenOf(row.id)}
                parentTitle={parentId === null ? null : family.titleOf(parentId)}
                age={row.quietMs + sinceFrame}
                onOpen={(split) => actions.open(row.id, { split })}
                onDismiss={isBusy(row) ? undefined : () => dismissQuiet(row.id)}
              />
            );
          })}
        </ul>
      )}
    </div>
  );
}

function FleetWall({ dismiss }: ExperimentalSidebarFooterDisclosureProps) {
  return (
    <FleetPanel
      onClose={dismiss}
      onPopout={() => {
        setPopoutOpen(true);
        dismiss();
      }}
    />
  );
}

type DragState = {
  startX: number;
  startY: number;
  originX: number;
  originY: number;
};

/** App-wide draggable monitor, opened from the footer wall's pop-out button. */
function PopoutWall() {
  const open = usePopoutOpen();
  const [offset, setOffset] = useState<Offset>(readOffset);
  const panel = useRef<HTMLDivElement | null>(null);
  const drag = useRef<DragState | null>(null);
  // The pointer handlers are registered once, so they read the live offset
  // from here rather than closing over a stale render's copy.
  const offsetRef = useRef(offset);
  offsetRef.current = offset;

  const onDragStart = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      drag.current = {
        startX: event.clientX,
        startY: event.clientY,
        originX: offset.x,
        originY: offset.y,
      };
      event.preventDefault();
    },
    [offset.x, offset.y],
  );

  useEffect(() => {
    const move = (event: PointerEvent): void => {
      const active = drag.current;
      if (active === null) return;
      // Keep a visible grip on the panel even if the pointer travels beyond
      // the viewport while dragging.
      setOffset(
        clampToPanel(
          panel.current,
          active.originX + event.clientX - active.startX,
          active.originY + event.clientY - active.startY,
        ),
      );
    };
    const end = (): void => {
      if (drag.current === null) return;
      drag.current = null;
      // Remember the position once, on release, rather than per pointer move.
      writeOffset(offsetRef.current);
    };
    // A window that shrinks must not strand the panel off-screen: the drag
    // clamp only ran while dragging, so re-apply it whenever the viewport
    // changes size.
    const resize = (): void =>
      setOffset((current) => clampToPanel(panel.current, current.x, current.y));
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("resize", resize);
    };
  }, []);

  const onNudge = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    const step = event.shiftKey ? 32 : 8;
    const delta =
      event.key === "ArrowLeft"
        ? { x: -step, y: 0 }
        : event.key === "ArrowRight"
          ? { x: step, y: 0 }
          : event.key === "ArrowUp"
            ? { x: 0, y: -step }
            : event.key === "ArrowDown"
              ? { x: 0, y: step }
              : null;
    if (delta === null) return;
    event.preventDefault();
    const next = clampToPanel(
      panel.current,
      offsetRef.current.x + delta.x,
      offsetRef.current.y + delta.y,
    );
    setOffset(next);
    writeOffset(next);
  }, []);

  // A restored offset was measured against whatever window it was saved in,
  // and the panel's height changes as chats enter or leave the fleet. Re-clamp
  // once it is up and whenever that geometry changes, so the header never
  // leaves the selectable/dragging area.
  useEffect(() => {
    if (!open) return;
    const reclamp = (): void => {
      setOffset((current) => {
        const next = clampToPanel(panel.current, current.x, current.y);
        if (next.x === current.x && next.y === current.y) return current;
        writeOffset(next);
        return next;
      });
    };
    reclamp();
    const element = panel.current;
    if (element === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(reclamp);
    observer.observe(element);
    return () => observer.disconnect();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setPopoutOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  if (!open) return null;
  return (
    <div
      ref={panel}
      data-testid="agent-tv-popout"
      role="dialog"
      aria-label="Agent TV popout"
      className="agtv-popout overflow-hidden rounded-lg border border-sidebar-border bg-sidebar text-sidebar-foreground shadow-2xl"
      style={{ transform: `translate3d(${offset.x}px, ${offset.y}px, 0)` }}
    >
      <FleetPanel
        floating
        onClose={() => setPopoutOpen(false)}
        onDragStart={onDragStart}
        onNudge={onNudge}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Registration
 * ------------------------------------------------------------------ */

/**
 * Hover peek: resting the pointer on the footer row opens the wall, and
 * moving away closes it again — until the user clicks, which makes it stay.
 * Mounted app-wide once per window, so the footer button works from any page.
 */
function HoverPeek({
  controller,
}: {
  controller: ExperimentalSidebarFooterDisclosureController;
}) {
  const settings = useSettings();
  const enabled = peekEnabled(settings.values);
  useEffect(() => {
    if (!enabled) return;
    return installHoverPeek({
      triggerSelector: TRIGGER_SELECTOR,
      panelSelector: PANEL_SELECTOR,
      open: () => controller.open(),
      close: () => controller.close(),
    });
  }, [controller, enabled]);
  return null;
}

export default definePluginApp((app) => {
  const controller = app.experimental_sidebarFooter.register({
    kind: "disclosure",
    id: FOOTER_ID,
    label: "Agent TV — watch the fleet work",
    icon: "Play",
    component: FleetWall,
  });
  app.slots.experimental_appOverlay({
    id: "hover-peek",
    component: () => (
      <>
        <HoverPeek controller={controller} />
        <PopoutWall />
      </>
    ),
  });
});
