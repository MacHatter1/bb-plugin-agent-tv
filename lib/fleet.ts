// bb-plugin-agent-tv — the fleet model, shared by the pump (server.ts) and the
// wall (app.tsx).
//
// Everything here is pure: it takes thread-event rows and settings and returns
// JSON-safe values, so it is testable without a running BB, and the frontend
// can reuse the same schemas to parse what the server sends it.
import { z } from "zod";

/* ------------------------------------------------------------------ *
 * Tuning — every one of these is a ceiling, so a large fleet cannot
 * make this plugin expensive or blow up a realtime payload.
 * ------------------------------------------------------------------ */

/** Sparkline geometry: 12 buckets x 5s = the last minute of activity. */
export const HEAT_BUCKETS = 12;
export const HEAT_BUCKET_MS = 5_000;
export const HEAT_WINDOW_MS = HEAT_BUCKETS * HEAT_BUCKET_MS;
/** "Files touched in the last 60s." */
export const FILE_WINDOW_MS = 60_000;
/** A delta this recent means the model is still talking. */
export const STREAMING_MS = 3_000;
/**
 * Core leaves a thread's `status` at "active" long after its agent stopped —
 * for hours — so status alone cannot answer "is this working". A thread that
 * has emitted nothing for this long is not working, whatever it claims.
 */
export const BUSY_WINDOW_MS = 60_000;
/**
 * Except when a tool call has not returned: a test suite or a build can be
 * genuinely busy and completely silent, so work in flight buys this much.
 */
export const BUSY_INFLIGHT_MS = 10 * 60_000;
/**
 * At or above this share of the context window, a thread is close enough to
 * compaction that it is worth acting on — wrap it up, fork it, hand it over.
 */
export const CONTEXT_PRESSURE = 0.8;
/** Frame ceilings. */
export const MAX_ROWS = 24;
export const MAX_FILES = 6;
/** Initial page size for the server's incremental event reader. */
export const EVENT_PAGE_LIMIT = 60;
/** How many ids one snapshot call may ask the pump to hydrate. */
export const SEED_REQUEST_MAX = 12;
const HEAT_CAP = 60;
/**
 * The bucket value that fills a bar. Heat is drawn on an absolute log scale
 * against this, not normalised per row: a tile with one event per bucket has
 * to *look* quieter than one with twenty, and a tile must not resize itself
 * because a neighbour got busy.
 */
const HEAT_REFERENCE = 20;
/**
 * A bucket may count one streaming delta, however many arrive. Deltas track
 * token output, not work, and a fast model emits hundreds per second — left
 * unweighted they bury every tool call on the wall and, when marks were a
 * list, pushed the older buckets out of the window entirely.
 */
const DELTA_WEIGHT_PER_BUCKET = 1;
const LABEL_MAX = 140;
const MODEL_MAX = 120;
const EFFORT_MAX = 32;

/** The realtime channel: the server publishes frames here, app.tsx listens. */
export const FLEET_CHANNEL = "fleet";

/* ------------------------------------------------------------------ *
 * Wire shapes
 * ------------------------------------------------------------------ */

export const TOOL_STATUSES = [
  "active",
  "error",
  "idle",
  "pending",
  "starting",
  "stopping",
] as const;
export type ToolStatus = (typeof TOOL_STATUSES)[number];

/**
 * How much of its context window a thread has burned. Only some providers
 * report this — codex and claude-code do, ACP-bridged ones do not — so it is
 * nullable and the wall simply draws nothing when it is absent. `estimated`
 * is the provider's own admission that the number is a guess.
 */
export const contextUsageSchema = z.object({
  used: z.number().int().min(0),
  window: z.number().int().min(1),
  fraction: z.number().min(0).max(1),
  estimated: z.boolean(),
});
export type ContextUsage = z.infer<typeof contextUsageSchema>;

export const fleetRowSchema = z.object({
  id: z.string().max(64),
  status: z.enum(TOOL_STATUSES),
  title: z.string().max(160),
  /** The model selected for the thread's latest turn, when recorded. */
  model: z.string().max(MODEL_MAX).nullable(),
  /** The reasoning effort selected for the thread's latest turn, when known. */
  effort: z.string().max(EFFORT_MAX).nullable(),
  /** The project this thread belongs to, when it is not projectless. */
  projectId: z.string().max(64).nullable(),
  /** The agent provider running this thread, when core has told us. */
  providerId: z.string().max(64).nullable(),
  /** The thread this one was spawned or forked under, when it has one. */
  parentThreadId: z.string().max(64).nullable(),
  /** Threads under this one that are on the wall with it — subagents count
   * here even when they are hidden from the sidebar. */
  childCount: z.number().int().min(0).max(MAX_ROWS),
  /** What the agent is doing right now: "git commit -m …", "app.tsx", … */
  tool: z.string().max(LABEL_MAX).nullable(),
  /** bb's own verb for it — "Running command" while pending, "Ran command"
   * once the item completed. */
  verb: z.string().max(60).nullable(),
  /** bb's own timeline glyph (a host icon name: Terminal, EditFile, Brain…). */
  glyph: z.string().max(48).nullable(),
  /** The tool finished and nothing newer has started. */
  settled: z.boolean(),
  /** The model emitted output within STREAMING_MS: show the typing dots. */
  streaming: z.boolean(),
  /**
   * Whether this thread is actually working — a busy status *and* evidence of
   * it. Computed on the server so a viewer never has to re-derive it from a
   * `quietMs` that only moves when a frame arrives.
   */
  busy: z.boolean(),
  /** Files touched within FILE_WINDOW_MS, newest first. */
  files: z.array(z.string().max(240)).max(MAX_FILES),
  /** HEAT_BUCKETS event counts, oldest bucket first. */
  heat: z.array(z.number().int().min(0).max(HEAT_CAP)).length(HEAT_BUCKETS),
  /**
   * What this thread is blocked on if it is waiting for a person — "question",
   * "permission", … — and null when nothing is. Folded from the interaction
   * lifecycle rows in the event log, so `bb agent-tv status` can answer "who
   * needs me" without the sidebar.
   */
  waiting: z.string().max(40).nullable(),
  /**
   * Context runway. The sparkline says how hard a thread is working; this
   * says how much room it has left to keep doing it. Null when its provider
   * does not report one.
   */
  context: contextUsageSchema.nullable(),
  /** ms since the last event seen on this thread. */
  quietMs: z.number().int().min(0),
});
export type FleetRow = z.infer<typeof fleetRowSchema>;

export const fleetFrameSchema = z.object({
  /** Server clock when the frame was built, so tiles can age themselves. */
  t: z.number().int(),
  rows: z.array(fleetRowSchema).max(MAX_ROWS),
});
export type FleetFrame = z.infer<typeof fleetFrameSchema>;

export const EMPTY_FRAME: FleetFrame = { t: 0, rows: [] };

/**
 * A frame's identity for change detection: everything except the clock.
 * `t` and every row's `quietMs` advance on their own each tick, so comparing
 * whole frames can never report "unchanged". Comparing this does, which lets
 * the pump publish only what a viewer would actually notice — the wall ages
 * its own rows from the frame it already holds.
 */
export function frameKey(frame: FleetFrame): string {
  return JSON.stringify(frame.rows.map(({ quietMs, ...rest }) => rest));
}

/* ------------------------------------------------------------------ *
 * Tolerant thread-event parsing
 *
 * `threads.events.list` hands back rows whose `data` differs per provider
 * (pi, codex, claude-code, cursor) and per item type, and core keeps adding
 * item types. Nothing here trusts a shape: every field goes through a guard,
 * and an item we cannot describe simply does not change the wall.
 * ------------------------------------------------------------------ */

type UnknownRecord = Record<string, unknown>;

/** The subset of a stored thread-event row the wall reads. */
export type WireRow = {
  seq: unknown;
  createdAt: unknown;
  type: unknown;
  data: unknown;
};

function asRecord(value: unknown): UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

/** Collapse whitespace and trim; null for anything not a real string. */
export function textOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed === "" ? null : trimmed;
}

function numberOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}\u2026`;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ------------------------------------------------------------------ *
 * Secret redaction
 *
 * A tile's action line is whatever the provider called the item — most often
 * the command line itself. Command lines carry credentials: an inline
 * `PGPASSWORD=`, a bearer header, `-u user:pass`. That text is printed by
 * `bb agent-tv status` and broadcast on the realtime channel to every
 * connected client, so it is redacted once, here, at the only place the
 * action line is built.
 * ------------------------------------------------------------------ */

const REDACTED = "\u2022\u2022\u2022";

/**
 * Ordered so that a value matched by a recognisable prefix is masked even when
 * the flag around it is not one we know.
 */
const SECRET_PATTERNS: ReadonlyArray<{ find: RegExp; replace: string }> = [
  // Tokens recognisable on sight, with no surrounding syntax needed.
  {
    find: /\b(github_pat_|ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9_]{6,}/gu,
    replace: `$1${REDACTED}`,
  },
  { find: /\bsk-[A-Za-z0-9_-]{6,}/gu, replace: `sk-${REDACTED}` },
  { find: /\bxox[abeoprs]-[A-Za-z0-9-]{6,}/giu, replace: `xox-${REDACTED}` },
  { find: /\bAKIA[0-9A-Z]{8,}/gu, replace: `AKIA${REDACTED}` },
  // scheme://user:pass@host
  {
    find: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@/]+@/giu,
    replace: `$1:${REDACTED}@`,
  },
  // Authorization: Bearer … (and Basic/Token)
  {
    find: /\b(authorization\s*:\s*(?:bearer|basic|token)\s+)\S+/giu,
    replace: `$1${REDACTED}`,
  },
  // curl -u user:pass
  {
    find: /(^|\s)(-u|--user)(\s+)([^\s:]+):\S+/gu,
    replace: `$1$2$3$4:${REDACTED}`,
  },
  // --password/--token/--secret/--api-key <value>, and the =value form.
  {
    find:
      /(--(?:password|passwd|token|secret|api[-_]?key|access[-_]?key|auth[-_]?token)[=\s]+)(?!-)\S+/giu,
    replace: `$1${REDACTED}`,
  },
  // NAME=value where NAME reads like a credential.
  {
    find:
      /\b([A-Za-z_][A-Za-z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?|AUTH)[A-Za-z0-9_]*)=(?:"[^"]*"|'[^']*'|\S+)/giu,
    replace: `$1=${REDACTED}`,
  },
];

/**
 * Mask credential-shaped text. Deliberately conservative about what it keeps:
 * the flag, the variable name and the user survive, because "which command"
 * is the whole point of the line — only the value goes.
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const { find, replace } of SECRET_PATTERNS) out = out.replace(find, replace);
  return out;
}

/** Paths written by a `fileChange` item. */
function changedPaths(item: UnknownRecord): string[] {
  const changes = item.changes;
  if (!Array.isArray(changes)) return [];
  const paths: string[] = [];
  for (const change of changes) {
    const path = textOf(asRecord(change).path);
    if (path !== null) paths.push(clip(path, 240));
  }
  return paths;
}

/** The most path-like argument a tool call carries, if any. */
function argumentPath(item: UnknownRecord): string | null {
  const args = asRecord(item.arguments);
  const nested = asRecord(args.args);
  for (const candidate of [
    args.file_path,
    args.path,
    nested.file_path,
    nested.path,
  ]) {
    const value = textOf(candidate);
    if (value !== null && value.length <= 240) return value;
  }
  return null;
}

/**
 * Verb fallbacks for providers that send no presentation of their own, in
 * both tenses: a tile keeps its last action after the turn ends, and "still
 * Responding" two hours later is a lie.
 */
const VERB_DONE_FALLBACK: Record<string, string> = {
  agentMessage: "Responded",
  backgroundTask: "Ran background work",
  commandExecution: "Ran command",
  extension: "Ran extension work",
  fileChange: "Edited file",
  fileRead: "Read file",
  mcpToolCall: "Ran tool",
  plan: "Planned",
  planSteps: "Planned",
  reasoning: "Thought",
  search: "Searched",
  toolCall: "Ran tool",
  webFetch: "Fetched page",
  webSearch: "Searched the web",
};

const VERB_FALLBACK: Record<string, string> = {
  agentMessage: "Responding",
  backgroundTask: "Running background work",
  commandExecution: "Running command",
  extension: "Running extension work",
  fileChange: "Editing file",
  fileRead: "Reading file",
  mcpToolCall: "Running tool",
  plan: "Planning",
  planSteps: "Planning",
  reasoning: "Thinking",
  search: "Searching",
  toolCall: "Running tool",
  webFetch: "Fetching page",
  webSearch: "Searching the web",
};

/** A file's last path segment, for items whose provider sent no title. */
function pathLabel(path: string): string {
  const parts = path.split("/").filter((part) => part !== "");
  return parts.length === 0 ? path : (parts[parts.length - 1] as string);
}

/** Item types that are work, so the tile may show them. */
const DESCRIBABLE = new Set([...Object.keys(VERB_FALLBACK)]);

/** An ask this thread is blocked on, and when we learned of it. */
export type Wait = { label: string; at: number };

export type Tool = {
  itemId: string;
  text: string | null;
  /** Present tense, while the item is in flight. */
  verb: string;
  /** Past tense, used once the item — or its turn — has settled. */
  verbDone: string;
  glyph: string | null;
  settled: boolean;
  at: number;
};

/**
 * Read one timeline item as "what the agent is doing". Returns null for items
 * that are not work (a user message) or that belong to a nested call, so they
 * never overwrite the top-level line.
 */
export function describeItem(
  item: UnknownRecord,
  at: number,
  completed = false,
): { tool: Tool; files: string[] } | null {
  const kind = textOf(item.type) ?? "";
  if (!DESCRIBABLE.has(kind)) return null;
  // A tool inside a tool is its parent's business.
  if (textOf(item.parentToolCallId) !== null) return null;
  const presentation = asRecord(item.presentation);
  const labels = asRecord(presentation.label);
  const icon = asRecord(presentation.icon);
  const paths = changedPaths(item);
  const detail =
    textOf(presentation.title) ??
    textOf(item.command) ??
    textOf(item.query) ??
    textOf(item.tool) ??
    argumentPath(item) ??
    textOf(presentation.detail) ??
    textOf(item.description) ??
    // A fileChange carries no title of its own when the provider did not give
    // it one, but the path it wrote is exactly what the tile should say.
    (paths.length > 0 ? pathLabel(paths[0] as string) : null);
  return {
    tool: {
      itemId: textOf(item.id) ?? "",
      // One redaction point, so the CLI and the realtime broadcast get the
      // same masked text.
      text: detail === null ? null : clip(redactSecrets(detail), LABEL_MAX),
      verb:
        (completed
          ? textOf(labels.completed) ?? textOf(labels.pending)
          : textOf(labels.pending) ?? textOf(labels.completed)) ??
        VERB_FALLBACK[kind],
      verbDone:
        textOf(labels.completed) ??
        VERB_DONE_FALLBACK[kind] ??
        textOf(labels.pending) ??
        VERB_FALLBACK[kind],
      glyph: textOf(icon.glyph),
      settled: textOf(item.status) === "completed",
      at,
    },
    files: paths,
  };
}

/* ------------------------------------------------------------------ *
 * Per-thread feed state
 * ------------------------------------------------------------------ */

export type Feed = {
  id: string;
  status: ToolStatus;
  title: string;
  model: string | null;
  effort: string | null;
  projectId: string | null;
  /** Do not repeat an unresolved model lookup on every heartbeat. */
  modelRetryAt: number;
  providerId: string | null;
  parentThreadId: string | null;
  /** Newest event seq already folded in. */
  cursor: number;
  /** Newest seq core has told us about. */
  target: number;
  /** Per-feed page size; the server lowers this after a 413 response. */
  drainLimit: number;
  /** Do not hot-loop a feed after a transient read failure. */
  retryAt: number;
  /** Consecutive read failures, for the backoff and for giving up. */
  failures: number;
  /**
   * This feed cannot be read and we have stopped trying: its thread is gone,
   * or it failed too many times in a row. It keeps whatever it last knew.
   */
  dead: boolean;
  /** Earliest next tail re-read, so a stale feed cannot hot-loop either. */
  resyncAt: number;
  draining: boolean;
  hydrated: boolean;
  tool: Tool | null;
  files: Map<string, number>;
  /**
   * HEAT_BUCKETS rolling counters, oldest first, the last one being the bucket
   * `bucketAt` names. Counters rather than a list of timestamps: the window is
   * then exactly HEAT_WINDOW_MS however chatty the thread, and the memory is
   * flat instead of one number per event.
   */
  buckets: number[];
  /** Absolute bucket index (floor(ms / HEAT_BUCKET_MS)) of the newest bucket. */
  bucketAt: number;
  /** The bucket a streaming delta was last counted in; see DELTA_WEIGHT. */
  deltaBucket: number;
  /** Interaction ids this thread is blocked on. Empty when it is free. */
  waits: Map<string, Wait>;
  /** Latest context-window reading, when the provider reports one. */
  context: ContextUsage | null;
  /**
   * Core marks a thread hidden when it is not the user's to look at — the
   * worker threads of orchestrated work, mostly. They get no tile. They are
   * still counted on their parent's, which is where they belong.
   */
  hidden: boolean;
  deltaAt: number;
  lastAt: number;
};

const STREAM_EVENTS = new Set([
  "item/agentMessage/delta",
  "item/commandExecution/outputDelta",
  "item/delegation/progress",
  "item/fileChange/outputDelta",
  "item/mcpToolCall/progress",
  "item/plan/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "item/toolCall/progress",
]);

const END_EVENTS = new Set(["turn/completed", "system/thread/interrupted"]);

/**
 * Rows that say a thread is (or is no longer) blocked on a person. All three
 * carry the same `status` enum — pending | resolving | resolved | interrupted —
 * so one branch folds them all.
 */
const WAIT_EVENTS = new Set([
  "system/interaction/lifecycle",
  "system/permissionGrant/lifecycle",
  "system/userQuestion/lifecycle",
]);
/** Never track more than this many concurrent asks per thread. */
const MAX_WAITS = 8;
/**
 * Events that prove the agent is no longer blocked. An ask can only be
 * cleared by its own lifecycle row where the provider writes one — and many
 * do not write one at all, so a wait raised by the `interaction.pending` push
 * would otherwise never clear. A blocked agent emits nothing until it is
 * answered, so any work *newer* than the ask means the ask is done with.
 */
const PROGRESS_EVENTS = new Set([
  "turn/started",
  "turn/completed",
  "system/thread/interrupted",
  "item/started",
  "item/completed",
]);
const WAIT_LABELS: Record<string, string> = {
  permission_grant: "permission",
  user_question: "question",
};

/** A short word for what is being asked, for the tile and the CLI. */
export function waitLabel(data: unknown): string {
  const record = asRecord(data);
  const kind =
    textOf(asRecord(record.payload).kind) ??
    textOf(asRecord(record.subject).kind);
  if (kind === null) return "input";
  return clip(WAIT_LABELS[kind] ?? kind.replace(/_/gu, " "), 40);
}

/** Note an ask or its resolution. Exported so the free push event can too. */
export function applyWait(
  feed: Feed,
  id: string,
  label: string,
  pending: boolean,
  at: number,
): void {
  if (!pending) {
    feed.waits.delete(id);
    return;
  }
  if (feed.waits.size >= MAX_WAITS && !feed.waits.has(id)) return;
  feed.waits.set(id, { label, at });
}

/**
 * Drop every ask this thread has moved on from. Strictly newer, so the
 * trailing events of whatever *caused* the ask cannot clear it the moment it
 * is raised.
 */
function clearStaleWaits(feed: Feed, at: number): void {
  if (feed.waits.size === 0) return;
  for (const [id, wait] of feed.waits) {
    if (wait.at < at) feed.waits.delete(id);
  }
}

/** Event kinds the wall folds; everything else is irrelevant to its frame. */
export const FLEET_EVENT_TYPES = [
  "client/turn/requested",
  "client/turn/start",
  "provider/modelFallback",
  "turn/started",
  "turn/completed",
  "system/thread/interrupted",
  "system/error",
  "thread/contextWindowUsage/updated",
  "system/interaction/lifecycle",
  "system/permissionGrant/lifecycle",
  "system/userQuestion/lifecycle",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/commandExecution/outputDelta",
  "item/delegation/progress",
  "item/fileChange/outputDelta",
  "item/mcpToolCall/progress",
  "item/plan/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "item/toolCall/progress",
] as const;

export function emptyFeed(id: string, title = id): Feed {
  return {
    id,
    status: "idle",
    title,
    model: null,
    effort: null,
    projectId: null,
    modelRetryAt: 0,
    providerId: null,
    parentThreadId: null,
    cursor: 0,
    target: 0,
    drainLimit: EVENT_PAGE_LIMIT,
    retryAt: 0,
    failures: 0,
    dead: false,
    resyncAt: 0,
    draining: false,
    hydrated: false,
    tool: null,
    files: new Map(),
    buckets: new Array<number>(HEAT_BUCKETS).fill(0),
    bucketAt: 0,
    deltaBucket: -1,
    waits: new Map(),
    context: null,
    hidden: false,
    deltaAt: 0,
    lastAt: 0,
  };
}

/**
 * Record that a thread wrote these paths now. Re-inserting keeps Map order
 * equal to last-touch order, which is what lets `pruneFiles` drop the stalest
 * entries without a sort on every event.
 */
export function touchFiles(feed: Feed, paths: readonly string[], at: number): void {
  for (const path of paths) {
    feed.files.delete(path);
    feed.files.set(path, at);
  }
}

/**
 * Drop the least-recently-touched paths once a thread names too many, leaving
 * `keep` of them. The default is generous next to the MAX_FILES a frame can
 * carry, because `recentFiles` still has to filter what survives by age.
 */
export function pruneFiles(feed: Feed, keep = MAX_FILES * 2): void {
  const excess = feed.files.size - keep;
  if (excess <= 0) return;
  let dropped = 0;
  for (const path of feed.files.keys()) {
    if (dropped >= excess) break;
    feed.files.delete(path);
    dropped += 1;
  }
}

/**
 * Take what core's thread DTO knows about a thread — the free part of a
 * notification, no extra read — so a tile can name its agent and its parent
 * before we have read a single event.
 */
export function applyThreadDto(
  feed: Feed,
  thread: {
    status: string;
    title: string | null;
    titleFallback: string | null;
    projectId?: string;
    providerId?: string;
    parentThreadId?: string | null;
    updatedAt?: number;
    visibility?: string;
  },
): void {
  const title = thread.title ?? thread.titleFallback;
  if (title !== null && title !== undefined) feed.title = title;
  if (typeof thread.projectId === "string" && thread.projectId !== "") {
    feed.projectId = clip(thread.projectId, 64);
  }
  if (typeof thread.providerId === "string" && thread.providerId !== "") {
    feed.providerId = clip(thread.providerId, 64);
  }
  // Guarded like projectId and providerId: a lifecycle DTO that carries no
  // parent at all must not erase one we already know, or the parent tile
  // loses its subagent count the moment a child goes idle. An explicit null
  // is core telling us the thread has no parent, so that still clears it.
  if (typeof thread.parentThreadId === "string" && thread.parentThreadId !== "") {
    feed.parentThreadId = clip(thread.parentThreadId, 64);
  } else if (thread.parentThreadId === null) {
    feed.parentThreadId = null;
  }
  // Guarded like the rest: a DTO that omits it says nothing either way.
  if (thread.visibility === "hidden") feed.hidden = true;
  else if (thread.visibility === "visible") feed.hidden = false;
  const status = thread.status as ToolStatus;
  if (TOOL_STATUSES.includes(status)) feed.status = status;
  // A running thread is on air the moment core says so, whether or not we have
  // read any of its events yet.
  if (typeof thread.updatedAt === "number" && thread.updatedAt > feed.lastAt) {
    feed.lastAt = thread.updatedAt;
  }
}

/**
 * Pull the selected model from the durable request event. The thread DTO
 * intentionally carries the provider but not its per-turn model, so model
 * identity arrives through the event log instead. Keep the fallback event in
 * sync too: a provider can switch to a different model after a refusal.
 */
export function modelOf(row: WireRow): string | null {
  const type = textOf(row.type);
  const data = asRecord(row.data);
  if (type === "provider/modelFallback") {
    const fallback = textOf(data.fallbackModel);
    return fallback === null ? null : clip(fallback, MODEL_MAX);
  }
  if (type !== "client/turn/requested" && type !== "client/turn/start") {
    return null;
  }
  const execution = asRecord(data.execution);
  const request = asRecord(data.request);
  const params = asRecord(request.params);
  const model = textOf(execution.model) ?? textOf(params.model) ?? textOf(data.model);
  return model === null ? null : clip(model, MODEL_MAX);
}

/** Pull the selected reasoning effort from the same durable execution tuple. */
export function effortOf(row: WireRow): string | null {
  const type = textOf(row.type);
  if (type !== "client/turn/requested" && type !== "client/turn/start") {
    return null;
  }
  const data = asRecord(row.data);
  const execution = asRecord(data.execution);
  const request = asRecord(data.request);
  const params = asRecord(request.params);
  const effort =
    textOf(execution.reasoningLevel) ??
    textOf(params.reasoningLevel) ??
    textOf(data.reasoningLevel);
  return effort === null ? null : clip(effort, EFFORT_MAX);
}

/** Fold one event row into its feed. Mutates `feed`, never throws. */
export function applyRow(feed: Feed, row: WireRow, now: number): void {
  // Never later than the moment we folded it: a row whose clock runs ahead of
  // ours must not open a bucket in the future or freeze `quietMs` at zero.
  const at = Math.min(numberOf(row.createdAt) ?? now, now);
  const type = textOf(row.type) ?? "";
  // Bookkeeping, not work: fold it without touching the activity clock, the
  // heat line or any pending ask. A usage report must not make an idle thread
  // look busy, and it is not evidence that a question was answered.
  if (type === "thread/contextWindowUsage/updated") {
    applyContext(feed, asRecord(row.data));
    return;
  }
  if (at > feed.lastAt) feed.lastAt = at;
  const model = modelOf(row);
  if (model !== null) feed.model = model;
  const effort = effortOf(row);
  if (effort !== null) feed.effort = effort;
  if (STREAM_EVENTS.has(type)) {
    // One delta per bucket. The heat line is meant to read as "how much work",
    // and streaming is one activity however many tokens it emits.
    const bucket = Math.floor(at / HEAT_BUCKET_MS);
    if (bucket !== feed.deltaBucket) {
      feed.deltaBucket = bucket;
      bumpHeat(feed, at, DELTA_WEIGHT_PER_BUCKET);
    }
    feed.deltaAt = at;
    // Talking again is progress, so it answers "still blocked?" too.
    clearStaleWaits(feed, at);
    return;
  }
  bumpHeat(feed, at, 1);
  if (PROGRESS_EVENTS.has(type)) clearStaleWaits(feed, at);
  if (WAIT_EVENTS.has(type)) {
    const data = asRecord(row.data);
    const id =
      textOf(data.interactionId) ??
      textOf(asRecord(data.subject).itemId) ??
      type;
    applyWait(feed, id, waitLabel(data), textOf(data.status) === "pending", at);
    return;
  }
  if (type === "turn/started") {
    if (feed.status === "idle") feed.status = "active";
    return;
  }
  if (END_EVENTS.has(type)) {
    // Keep the last action, settled, rather than discarding it. Throwing it
    // away left a finished thread's most prominent line reading "quiet" — a
    // whole row saying nothing, which is most of the wall most of the time.
    if (feed.tool !== null) feed.tool = { ...feed.tool, settled: true };
    feed.deltaAt = 0;
    // Waits are cleared by the PROGRESS_EVENTS branch above, which is
    // timestamp-aware — a turn that ended *before* an ask was raised must not
    // clear it.
    return;
  }
  if (type === "system/error") {
    feed.status = "error";
    // Keep it too, so a failed tile can name what failed.
    if (feed.tool !== null) feed.tool = { ...feed.tool, settled: true };
    feed.deltaAt = 0;
    return;
  }
  if (type !== "item/started" && type !== "item/completed") return;
  const item = asRecord(asRecord(row.data).item);
  const completed = type === "item/completed";
  const described = describeItem(
    item,
    completed ? feed.tool?.at ?? at : at,
    completed,
  );
  if (described === null) return;
  touchFiles(feed, described.files, at);
  pruneFiles(feed);
  if (completed) {
    // Retitle the line in place — "Ran command: git commit" stays until the
    // next thing starts — and only when the item owns the line.
    if (feed.tool !== null && feed.tool.itemId === described.tool.itemId) {
      feed.tool = { ...described.tool, settled: true };
    }
    return;
  }
  feed.tool = described.tool;
}

/** Read a context-window report. Ignores anything that is not a real pair. */
export function applyContext(feed: Feed, data: UnknownRecord): void {
  const usage = asRecord(data.contextWindowUsage);
  const used = numberOf(usage.usedTokens);
  const window = numberOf(usage.modelContextWindow);
  if (used === null || window === null || window <= 0 || used < 0) return;
  feed.context = {
    used: Math.round(used),
    window: Math.round(window),
    fraction: Math.min(1, used / window),
    estimated: usage.estimated === true,
  };
}

/** The absolute bucket a timestamp belongs to. */
function bucketOf(at: number): number {
  return Math.floor(at / HEAT_BUCKET_MS);
}

/**
 * Shift `buckets` forward to `target`, dropping what has aged out. Shared by
 * the writer (which mutates) and the reader (which works on a copy), so a feed
 * that has gone quiet reports zeros rather than its last burst.
 */
function rolled(
  buckets: readonly number[],
  from: number,
  target: number,
): number[] {
  const steps = target - from;
  if (steps <= 0) return [...buckets];
  if (steps >= HEAT_BUCKETS) return new Array<number>(HEAT_BUCKETS).fill(0);
  return [...buckets.slice(steps), ...new Array<number>(steps).fill(0)];
}

/** Count one event against this feed's rolling window. */
export function bumpHeat(feed: Feed, at: number, weight: number): void {
  const bucket = bucketOf(at);
  if (feed.bucketAt === 0) feed.bucketAt = bucket;
  if (bucket > feed.bucketAt) {
    feed.buckets = rolled(feed.buckets, feed.bucketAt, bucket);
    feed.bucketAt = bucket;
  }
  const index = HEAT_BUCKETS - 1 - (feed.bucketAt - bucket);
  if (index < 0 || index >= HEAT_BUCKETS) return; // older than the window
  feed.buckets[index] = Math.min(
    HEAT_CAP,
    (feed.buckets[index] ?? 0) + weight,
  );
}

/** This feed's HEAT_BUCKETS counts as of `now`, oldest bucket first. */
export function heatFor(feed: Feed, now: number): number[] {
  return rolled(feed.buckets, feed.bucketAt, bucketOf(now));
}

/** Newest MAX_FILES paths inside the file window. */
export function recentFiles(
  files: ReadonlyMap<string, number>,
  now: number,
): string[] {
  const fresh: Array<{ path: string; at: number }> = [];
  for (const [path, at] of files) {
    if (now - at <= FILE_WINDOW_MS && now - at >= 0) fresh.push({ path, at });
  }
  fresh.sort((left, right) => right.at - left.at);
  return fresh.slice(0, MAX_FILES).map((entry) => entry.path);
}

/** One tile. Null when the thread has nothing worth showing. */
export function rowFor(feed: Feed, now: number): FleetRow | null {
  if (feed.lastAt === 0) return null;
  const quietMs = Math.max(0, now - feed.lastAt);
  const waiting = waitingFor(feed);
  // A tile does not expire. A thread keeps its row for as long as the pump
  // keeps its feed, however long it has been quiet; `maxRows` decides how many
  // fit and `byActivity` decides which, so the stalest rows fall off the end
  // rather than vanishing on a timer. `showQuiet` is the switch for viewers
  // who only want threads that are actually doing something.
  const tool = feed.tool;
  // A feed with unread events is looking at history. Its newest known item may
  // have "completed", but the thread has moved on since, so reporting that as
  // the settled state of a running thread is simply false.
  const behind = feedIsBehind(feed) && BUSY_STATUSES.has(feed.status);
  const settled = behind ? false : (tool?.settled ?? false);
  return {
    id: feed.id,
    status: feed.status,
    title: clip(feed.title === "" ? feed.id : feed.title, 160),
    model: feed.model,
    effort: feed.effort,
    projectId: feed.projectId,
    providerId: feed.providerId,
    parentThreadId: feed.parentThreadId,
    childCount: 0,
    tool: tool?.text ?? null,
    // A settled action reads in the past tense, however it was labelled when
    // it started — a tile outlives its turn now.
    verb: tool === null ? null : settled ? tool.verbDone : tool.verb,
    glyph: tool?.glyph ?? null,
    settled,
    streaming: feed.deltaAt > 0 && now - feed.deltaAt <= STREAMING_MS,
    busy: feedIsBusy(feed, now),
    files: recentFiles(feed.files, now),
    heat: heatFor(feed, now),
    waiting,
    context: feed.context,
    quietMs: Math.floor(quietMs),
  };
}

/**
 * The wall's frozen layout: a thread keeps the slot it was handed the first
 * time it appeared, so tiles never slide out from under the pointer.
 */
export type WallOrder = {
  slots: Map<string, number>;
  next: number;
};

export function createWallOrder(): WallOrder {
  return { slots: new Map(), next: 0 };
}

export type FrameOptions = {
  now: number;
  maxRows: number;
  /** Keep tiles for threads that already finished their turn. */
  showQuiet: boolean;
  /**
   * Pass the wall's order to keep tiles where the viewer found them. Omit it
   * (a CLI snapshot) to lay the frame out by activity instead.
   */
  order?: WallOrder;
};

/**
 * Waiting on a person first — that is the only row the viewer has to act on —
 * then on air, then by how recently each thread did anything.
 */
function byActivity(left: FleetRow, right: FleetRow): number {
  return (
    Number(right.waiting !== null) - Number(left.waiting !== null) ||
    Number(isBusy(right)) - Number(isBusy(left)) ||
    left.quietMs - right.quietMs
  );
}

export function buildFrame(
  feeds: Iterable<Feed>,
  options: FrameOptions,
): FleetFrame {
  // Materialise first: callers pass a one-shot iterator over their live feeds.
  const all = [...feeds];
  const rows: FleetRow[] = [];
  const live = new Set<string>();
  // Which feeds had anything worth showing. `rowFor` is the costly part of a
  // frame — it re-buckets a minute of marks and sorts the file map — so every
  // feed is built exactly once here and the children pass reads this instead.
  // Hidden feeds land here too: no tile of their own, but they still count on
  // their parent's.
  const withRow = new Set<string>();
  for (const feed of all) {
    live.add(feed.id);
    const row = rowFor(feed, options.now);
    if (row === null) continue;
    withRow.add(feed.id);
    if (feed.hidden) continue;
    if (!options.showQuiet && !isBusy(row) && row.waiting === null) continue;
    rows.push(row);
  }
  // How many of the threads on the wall are this one's children. Counted over
  // every live feed rather than the visible rows, so a hidden subagent still
  // shows up on its parent's tile.
  const children = new Map<string, number>();
  for (const feed of all) {
    if (feed.parentThreadId === null || feed.parentThreadId === feed.id) continue;
    if (!withRow.has(feed.id)) continue;
    children.set(
      feed.parentThreadId,
      Math.min(MAX_ROWS, (children.get(feed.parentThreadId) ?? 0) + 1),
    );
  }
  for (const row of rows) row.childCount = children.get(row.id) ?? 0;

  rows.sort(byActivity);
  const order = options.order;
  if (order !== undefined) {
    // A thread that has left the wall gives up its slot, so a much later return
    // queues up at the end rather than reserving a gap. Everyone still on it
    // keeps the place the viewer is already looking at, including rows past the
    // visible cap, so the tail does not churn either.
    for (const id of [...order.slots.keys()]) {
      if (!live.has(id)) order.slots.delete(id);
    }
    for (const row of rows) {
      if (!order.slots.has(row.id)) order.slots.set(row.id, order.next++);
    }
    rows.sort(
      (left, right) =>
        (order.slots.get(left.id) ?? 0) - (order.slots.get(right.id) ?? 0),
    );
  }
  const limit = Math.max(1, Math.min(MAX_ROWS, Math.round(options.maxRows)));
  return { t: options.now, rows: rows.slice(0, limit) };
}

/** The subset of a thread DTO the snapshot ranking reads. */
export type SnapshotCandidate = {
  id: string;
  status: string;
  updatedAt?: number;
};

/**
 * Which threads one `bb agent-tv status` should spend its reads on.
 *
 * `threads.list` comes back in no activity order at all — the first rows on a
 * busy machine are routinely idle threads from days ago — so slicing it
 * directly spent the scan budget on threads with nothing to report and left
 * the running ones unread. Running threads come first, then the most recently
 * active, preferring what the pump already knows over the thread row's
 * `updatedAt` (which does not advance while a thread runs).
 */
export function rankThreadsForSnapshot<T extends SnapshotCandidate>(
  threads: readonly T[],
  lastActivity: (id: string) => number,
): T[] {
  const liveness = (thread: T): number =>
    Math.max(lastActivity(thread.id), thread.updatedAt ?? 0);
  return [...threads].sort(
    (left, right) =>
      Number(BUSY_STATUSES.has(right.status as ToolStatus)) -
        Number(BUSY_STATUSES.has(left.status as ToolStatus)) ||
      liveness(right) - liveness(left),
  );
}

/* ------------------------------------------------------------------ *
 * Formatting (the wall and `bb agent-tv status` share these)
 * ------------------------------------------------------------------ */

/** What a feed is blocked on, oldest ask first, or null when nothing. */
export function waitingFor(feed: Feed): string | null {
  for (const wait of feed.waits.values()) return wait.label;
  return null;
}

/** The statuses under which a thread could be working at all. */
const BUSY_STATUSES = new Set<ToolStatus>([
  "active",
  "pending",
  "starting",
  "stopping",
]);

/**
 * The one definition of "working", from the primitive facts. A busy status is
 * necessary but never sufficient: core keeps reporting "active" for hours
 * after an agent stopped, which had every stale thread lit up as on air and
 * sorted above threads that had done something far more recently.
 */
function working(facts: {
  status: ToolStatus;
  streaming: boolean;
  /** A tool call that started and has not reported back. */
  inFlight: boolean;
  /** Core has announced events this feed has not folded yet. */
  behind: boolean;
  quietMs: number;
}): boolean {
  if (!BUSY_STATUSES.has(facts.status)) return false;
  // Unread events are evidence of work — the strongest there is, in fact:
  // core only announces a sequence that actually moved. Without this a thread
  // that outruns the reader renders as quiet and settled while it is
  // demonstrably mid-turn.
  if (facts.streaming || facts.behind) return true;
  return facts.quietMs <= (facts.inFlight ? BUSY_INFLIGHT_MS : BUSY_WINDOW_MS);
}

/**
 * Core has told us about events this feed has not folded. While that is true
 * the feed's own clock is understated, so nothing derived from `lastAt` may
 * be reported as settled or quiet.
 */
export function feedIsBehind(feed: Feed): boolean {
  return feed.cursor < feed.target;
}

/**
 * The feed believes it is caught up, but its thread is running and has said
 * nothing for longer than a working thread plausibly would. Following the log
 * forward cannot fix that — only re-reading the tail can.
 */
export function feedIsStale(feed: Feed, now: number): boolean {
  if (feed.dead || !BUSY_STATUSES.has(feed.status)) return false;
  if (feedIsBehind(feed) || feed.lastAt === 0) return false;
  return now - feed.lastAt > BUSY_WINDOW_MS;
}

/** Is this feed working, as of `now`? The frame and feed eviction both ask. */
export function feedIsBusy(feed: Feed, now: number): boolean {
  return working({
    status: feed.status,
    streaming: feed.deltaAt > 0 && now - feed.deltaAt <= STREAMING_MS,
    inFlight: feed.tool !== null && !feed.tool.settled,
    behind: feedIsBehind(feed),
    quietMs: Math.max(0, now - feed.lastAt),
  });
}

/** Is this thread working? Reads the verdict the frame already carries. */
export function isBusy(row: Pick<FleetRow, "busy">): boolean {
  return row.busy;
}

export function basename(path: string): string {
  const parts = path.split("/").filter((part) => part !== "");
  return parts.length === 0 ? path : (parts[parts.length - 1] as string);
}

/** A path short enough to live in a chip, with its parent dir as a hint. */
export function dirHint(path: string): string {
  const parts = path.split("/").filter((part) => part !== "");
  if (parts.length < 2) return "";
  return parts.slice(-2, -1).join("/");
}

/** "47%", or "~47%" where the provider admits the number is a guess. */
export function formatContext(context: ContextUsage | null): string | null {
  if (context === null) return null;
  return `${context.estimated ? "~" : ""}${Math.round(context.fraction * 100)}%`;
}

/** Close enough to its window that someone should do something about it. */
export function underPressure(row: Pick<FleetRow, "context">): boolean {
  return row.context !== null && row.context.fraction >= CONTEXT_PRESSURE;
}

export function formatAge(ms: number): string {
  if (ms < 1_000) return "now";
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 48 * 3_600_000) return `${Math.round(ms / 3_600_000)}h`;
  // Rows no longer age off the wall, so "72h" would be a common sight.
  return `${Math.round(ms / (24 * 3_600_000))}d`;
}

const BLOCKS = ["\u2581", "\u2582", "\u2583", "\u2584", "\u2585", "\u2586", "\u2587", "\u2588"];

/**
 * One bucket's height, 0..1, on an absolute log scale. Log because a bucket
 * holds anything from one tool call to HEAT_CAP events; absolute so that the
 * same bar height means the same rate on every tile and in every frame.
 */
export function heatLevel(value: number): number {
  if (value <= 0) return 0;
  const level = Math.log2(1 + value) / Math.log2(1 + HEAT_REFERENCE);
  return Math.max(0.18, Math.min(1, level));
}

export function sparkline(heat: readonly number[]): string {
  const top = BLOCKS.length - 1;
  return heat
    .map((value) =>
      value <= 0
        ? BLOCKS[0]
        : BLOCKS[Math.max(1, Math.round(heatLevel(value) * top))],
    )
    .join("");
}

/** 0..1 bar heights for the wall's sparkline, oldest bucket first. */
export function heatLevels(heat: readonly number[]): number[] {
  return heat.map(heatLevel);
}
