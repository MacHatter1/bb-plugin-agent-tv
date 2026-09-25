// Behaviour tests for the fleet pump, run against the official fake plugin
// host. The contract worth pinning down is cost: Agent TV must read thread
// events only while somebody is actually watching the wall, must bound what a
// single read can return, and must never let a frame grow past its budget.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin, { rpcContract } from "./server";
import {
  FLEET_CHANNEL,
  FLEET_EVENT_TYPES,
  type FleetFrame,
} from "./lib/fleet";

// Rows are stamped relative to the real clock, so `quietMs`, the streaming
// window, and the heat buckets all land where a reader would expect.
const T0 = Date.now() - 2_000;

type Row = {
  id: string;
  scope: { kind: "turn"; turnId: string };
  threadId: string;
  seq: number;
  createdAt: number;
  type: string;
  data: unknown;
};

function command(seq: number, id: string, text: string, status = "pending"): Row {
  return {
    id: `evt_${seq}`,
    scope: { kind: "turn", turnId: `turn-${id}` },
    threadId: "",
    seq,
    createdAt: T0 + seq,
    type: status === "pending" ? "item/started" : "item/completed",
    data: {
      item: {
        type: "commandExecution",
        id,
        command: text,
        cwd: "/repo",
        status,
        approvalStatus: null,
        presentation: {
          label: { pending: "Running command", completed: "Ran command" },
          icon: { glyph: "Terminal" },
          title: text,
        },
      },
    },
  };
}

function modelRequest(seq: number, model: string, effort?: string): Row {
  return {
    id: `evt_model_${seq}`,
    scope: { kind: "turn", turnId: `turn-model-${seq}` },
    threadId: "",
    seq,
    createdAt: T0 + seq,
    type: "client/turn/requested",
    data: { execution: { model, ...(effort === undefined ? {} : { reasoningLevel: effort }) } },
  };
}

function fileChange(seq: number, id: string, paths: string[]): Row {
  return {
    id: `evt_${seq}`,
    scope: { kind: "turn", turnId: `turn-${id}` },
    threadId: "",
    seq,
    createdAt: T0 + seq,
    type: "item/started",
    data: {
      item: {
        type: "fileChange",
        id,
        status: "pending",
        changes: paths.map((path) => ({ path, kind: "update" })),
        presentation: {
          label: { pending: "Editing file", completed: "Edited file" },
          icon: { glyph: "EditFile" },
        },
      },
    },
  };
}

function delta(seq: number, itemId: string): Row {
  return {
    id: `evt_${seq}`,
    scope: { kind: "turn", turnId: `turn-${itemId}` },
    threadId: "",
    seq,
    createdAt: T0 + seq,
    type: "item/agentMessage/delta",
    data: { itemId, delta: "…" },
  };
}

/** An interaction lifecycle row: the thread is (or is no longer) blocked. */
function askRow(seq: number, status: string, id = "int_1"): Row {
  return {
    id: `evt_${seq}`,
    scope: { kind: "turn", turnId: "turn-ask" },
    threadId: "",
    seq,
    createdAt: T0 + seq,
    type: "system/userQuestion/lifecycle",
    data: {
      interactionId: id,
      payload: { kind: "user_question", questions: [] },
      providerId: "codex",
      providerRequestId: "req_1",
      resolution: null,
      status,
      statusReason: null,
      threadId: "thr_a",
    },
  };
}

/** A live view of the thread's event log, so a test can append to it. */
function makeLog(source: () => Row[]) {
  const log = () => source().map((row, index) => ({ ...row, seq: index + 1 }));
  return (args: {
    threadId: string;
    afterSeq?: string;
    order?: "asc" | "desc";
    limit?: string;
    types?: readonly string[];
  }) => {
    const after = Number(args.afterSeq ?? "0");
    const limit = Number(args.limit ?? "50");
    const matching = log()
      .filter((row) => row.seq > after)
      .filter((row) => args.types === undefined || args.types.includes(row.type));
    const ordered =
      args.order === "desc" ? [...matching].reverse() : matching;
    return ordered.slice(0, limit).map((row) => ({ ...row, threadId: args.threadId }));
  };
}

type ReadArgs = {
  threadId: string;
  afterSeq?: string;
  order?: "asc" | "desc";
  limit?: string;
  types?: readonly string[];
};

/** A log keyed by thread, for the tests that need more than one. */
function perThreadLog(
  logs: Record<string, Row[]>,
  onRead?: (args: ReadArgs) => void,
) {
  return async (args: ReadArgs) => {
    onRead?.(args);
    const after = Number(args.afterSeq ?? "0");
    const limit = Number(args.limit ?? "50");
    const matching = (logs[args.threadId] ?? [])
      .filter((entry) => entry.seq > after)
      .filter((entry) => args.types === undefined || args.types.includes(entry.type));
    const ordered = args.order === "desc" ? [...matching].reverse() : matching;
    return ordered.slice(0, limit).map((entry) => ({ ...entry, threadId: args.threadId }));
  };
}

/** A host over `logs` that remembers every read the pump issued. */
function recordingHost(logs: Record<string, Row[]>) {
  const reads: ReadArgs[] = [];
  return {
    reads,
    host: createFakePluginHost({
      pluginId: "agent-tv",
      sdk: {
        threads: {
          events: { list: perThreadLog(logs, (args) => reads.push(args)) as never },
          list: (async () => []) as never,
        },
      },
    }),
  };
}

/** A thread with a long history, so replaying it from seq 0 would show up. */
function longLog(length: number): Row[] {
  return Array.from({ length }, (_, index) =>
    command(index + 1, `i${index}`, `step ${index}`),
  );
}

function frameOf(value: unknown): FleetFrame {
  return value as FleetFrame;
}

/** The last frame the pump published on the wall's channel. */
function lastSignal(channel: string): { channel: string; payload: unknown } | undefined {
  return host.harness.inspection.realtimeSignals
    .filter((signal) => signal.channel === channel)
    .at(-1);
}

function lastFrame(): FleetFrame {
  return frameOf(lastSignal(FLEET_CHANNEL)?.payload);
}

let host: ReturnType<typeof createFakePluginHost>;
let log: Row[];

beforeEach(async () => {
  log = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function load(rows: Row[], settings?: Record<string, string | number | boolean>) {
  log = rows;
  host = createFakePluginHost({
    pluginId: "agent-tv",
    settings,
    sdk: {
      threads: {
        events: {
          list: makeLog(() => log) as never,
        },
        list: (async () =>
          rows.length === 0
            ? []
            : [
                {
                  ...makeThreadResponse({ id: "thr_a", status: "active", title: "Ship it" }),
                },
              ]) as never,
      },
    },
  });
  await plugin(host.bb);
  return host;
}

const readCalls = () => host.harness.inspection.sdk.callsTo("threads.events.list");

describe("the fleet pump", () => {
  it("registers one rpc, one service, and one command", async () => {
    await load([command(1, "i1", "npm test")]);
    const { registrations } = host.harness.inspection;
    expect(registrations.rpcMethods).toEqual(["fleet_snapshot"]);
    expect(registrations.services.map((service) => service.name)).toContain("fleet-frame");
    expect(registrations.cli?.name).toBe("agent-tv");
    expect(registrations.threadEventHandlers["experimental_thread.events"]).toBe(1);
  });

  it("reads nothing while nobody is watching", async () => {
    await load([command(1, "i1", "npm test")]);
    host.harness.behavior.emitThreadEvent("experimental_thread.events", {
      thread: makeThreadResponse({
        id: "thr_a",
        status: "active",
        updatedAt: Date.now(),
      }),
      sequence: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(readCalls()).toHaveLength(0);
    expect(lastSignal(FLEET_CHANNEL)).toBeUndefined();
  });

  it("hydrates the threads a viewer asks for and answers with their tile", async () => {
    await load([
      command(1, "i1", "git commit -m 'ship it'", "completed"),
      fileChange(2, "i2", ["/repo/src/app.tsx"]),
    ]);
    const frame = frameOf(
      await host.harness.behavior.callRpc("fleet_snapshot", { threadIds: ["thr_a"] }),
    );
    expect(readCalls().length).toBeGreaterThan(0);
    expect(frame.rows).toHaveLength(1);
    const [row] = frame.rows;
    expect(row?.id).toBe("thr_a");
    expect(row?.tool).toBe("app.tsx"); // a fileChange with no title falls back to the path
    expect(row?.glyph).toBe("EditFile");
    expect(row?.files).toEqual(["/repo/src/app.tsx"]);
    expect(row?.heat).toHaveLength(12);
  });

  it("hydrates the latest model even when it is outside the event tail", async () => {
    const rows = [modelRequest(1, "gpt-5.6-luna", "high")];
    for (let seq = 2; seq <= 40; seq += 1) {
      rows.push(command(seq, `i${seq}`, `step ${seq}`, "completed"));
    }
    await load(rows);
    const frame = frameOf(
      await host.harness.behavior.callRpc("fleet_snapshot", { threadIds: ["thr_a"] }),
    );
    expect(frame.rows[0]?.model).toBe("gpt-5.6-luna");
    expect(frame.rows[0]?.effort).toBe("high");
  });

  it("uses core's resolved execution model when the event payload is unavailable", async () => {
    host = createFakePluginHost({
      pluginId: "agent-tv",
      sdk: {
        threads: {
          defaultExecutionOptions: (async () => ({
            model: "gpt-5.6-luna",
            permissionMode: "auto",
            reasoningLevel: "max",
            serviceTier: "default",
            source: "client/turn/requested",
          })) as never,
          events: { list: (async () => [command(1, "i1", "npm test")]) as never },
        },
      },
    });
    await plugin(host.bb);
    const frame = frameOf(
      await host.harness.behavior.callRpc("fleet_snapshot", { threadIds: ["thr_a"] }),
    );
    expect(frame.rows[0]?.model).toBe("gpt-5.6-luna");
    expect(frame.rows[0]?.effort).toBe("max");
  });

  it("hydrates a DTO-only quiet row's model even when the seed page is empty", async () => {
    host = createFakePluginHost({
      pluginId: "agent-tv",
      sdk: {
        threads: {
          defaultExecutionOptions: (async () => ({
            model: "gpt-5.6-luna",
            permissionMode: "auto",
            reasoningLevel: "max",
            serviceTier: "default",
            source: "client/turn/requested",
          })) as never,
          events: { list: (async () => []) as never },
          list: (async () => [
            makeThreadResponse({ id: "thr_a", status: "active", updatedAt: Date.now() }),
          ]) as never,
        },
      },
    });
    await plugin(host.bb);
    const output = await host.harness.behavior.runCli(["status", "--json"]);
    const row = frameOf(JSON.parse(output.stdout)).rows[0];
    expect(row?.model).toBe("gpt-5.6-luna");
    expect(row?.effort).toBe("max");
  });

  it("retries an unresolved model lookup after its backoff", async () => {
    let modelReads = 0;
    host = createFakePluginHost({
      pluginId: "agent-tv",
      sdk: {
        threads: {
          events: {
            list: (async (args: { types?: readonly string[] }) => {
              if (args.types?.length === 3) {
                modelReads += 1;
                return modelReads > 1 ? [modelRequest(1, "gpt-5.6-luna")] : [];
              }
              return [];
            }) as never,
          },
        },
      },
    });
    await plugin(host.bb);
    host.harness.behavior.emitThreadEvent("experimental_thread.events", {
      thread: makeThreadResponse({
        id: "thr_a",
        status: "active",
        updatedAt: Date.now(),
      }),
      sequence: 1,
    });
    const first = frameOf(
      await host.harness.behavior.callRpc("fleet_snapshot", { threadIds: ["thr_a"] }),
    );
    expect(first.rows[0]?.model).toBeNull();
    const later = Date.now() + 10_000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    const second = frameOf(
      await host.harness.behavior.callRpc("fleet_snapshot", { threadIds: ["thr_a"] }),
    );
    expect(second.rows[0]?.model).toBe("gpt-5.6-luna");
    expect(modelReads).toBe(2);
  });

  it("follows a running thread and publishes one frame per change", async () => {
    await load([command(1, "i1", "npm install")]);
    host.harness.behavior.emitThreadEvent("experimental_thread.events", {
      thread: makeThreadResponse({ id: "thr_a", status: "active", title: "Build it" }),
      sequence: 1,
    });
    await host.harness.behavior.callRpc("fleet_snapshot", { threadIds: ["thr_a"] });
    const before = host.harness.inspection.realtimeSignals.length;
    expect(before).toBeGreaterThan(0);

    log.push(command(2, "i2", "npm test"));
    host.harness.behavior.emitThreadEvent("experimental_thread.events", {
      thread: makeThreadResponse({ id: "thr_a", status: "active", title: "Build it" }),
      sequence: 2,
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(lastSignal(FLEET_CHANNEL)).toBeDefined();
    const frame = frameOf(
      await host.harness.behavior.callRpc("fleet_snapshot", { threadIds: [] }),
    );
    expect(frame.rows[0]?.tool).toBe("npm test");
    expect(frame.rows[0]?.verb).toBe("Running command");
    expect(frame.rows[0]?.title).toBe("Build it");
  });

  it("shows the typing indicator while deltas arrive", async () => {
    await load([delta(1, "m1")]);
    const frame = frameOf(
      await host.harness.behavior.callRpc("fleet_snapshot", { threadIds: ["thr_a"] }),
    );
    expect(frame.rows[0]?.streaming).toBe(true);
    expect(frame.rows[0]?.tool).toBeNull();
  });

  it("marks a thread idle from the lifecycle event, free of any read", async () => {
    await load([command(1, "i1", "npm test")]);
    await host.harness.behavior.callRpc("fleet_snapshot", { threadIds: ["thr_a"] });
    const reads = readCalls().length;
    host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_a", status: "idle" }),
      lastAssistantText: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(readCalls().length).toBe(reads);
    const frame = lastFrame();
    expect(frame.rows[0]?.status).toBe("idle");
    // The last action stays, settled: a tile that has gone quiet should still
    // say what it was doing rather than just "quiet".
    expect(frame.rows[0]?.tool).toBe("npm test");
    expect(frame.rows[0]?.settled).toBe(true);
    expect(frame.rows[0]?.busy).toBe(false);
  });

  it("drops a thread that was archived or deleted", async () => {
    await load([command(1, "i1", "npm test")]);
    await host.harness.behavior.callRpc("fleet_snapshot", { threadIds: ["thr_a"] });
    host.harness.behavior.emitThreadEvent("thread.archived", {
      thread: makeThreadResponse({ id: "thr_a" }),
    });
    expect(lastFrame().rows).toHaveLength(0);
  });

  it("holds the layout still while the wall is open", async () => {
    const rows = [
      command(1, "a1", "npm test", "completed"),
      command(2, "b1", "git push", "completed"),
    ];
    rows[1]!.threadId = "thr_b";
    await load(rows);
    host.harness.behavior.emitThreadEvent("experimental_thread.events", {
      thread: makeThreadResponse({ id: "thr_a", status: "active", title: "A" }),
      sequence: 1,
    });
    host.harness.behavior.emitThreadEvent("experimental_thread.events", {
      thread: makeThreadResponse({ id: "thr_b", status: "active", title: "B" }),
      sequence: 2,
    });
    const first = frameOf(
      await host.harness.behavior.callRpc("fleet_snapshot", {
        threadIds: ["thr_a", "thr_b"],
      }),
    );
    const before = first.rows.map((row) => row.id);
    expect(before).toEqual(["thr_a", "thr_b"]);

    // A goes quiet and B starts streaming: the busiest-first order would put B
    // on top, and the wall must not move.
    host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_a", status: "idle", title: "A" }),
      lastAssistantText: null,
    });
    const after = lastFrame();
    expect(after.rows.map((row) => row.id)).toEqual(before);
    expect(after.rows[0]?.status).toBe("idle");
  });

  it("keeps a frame inside its budget", async () => {
    const rows: Row[] = [];
    for (let seq = 1; seq <= 40; seq += 1) rows.push(command(seq, `i${seq}`, `cmd ${seq}`));
    await load(rows, { maxRows: 2 });
    for (const id of ["thr_a", "thr_b", "thr_c"]) {
      host.harness.behavior.emitThreadEvent("experimental_thread.events", {
        thread: makeThreadResponse({ id, status: "active" }),
        sequence: 40,
      });
    }
    const frame = frameOf(
      await host.harness.behavior.callRpc("fleet_snapshot", {
        threadIds: ["thr_a", "thr_b", "thr_c"],
      }),
    );
    expect(frame.rows.length).toBeLessThanOrEqual(2);
    // Each read is bounded, whatever the thread's history looks like.
    for (const call of readCalls()) {
      expect(Number((call[0] as { limit?: string }).limit ?? 0)).toBeLessThanOrEqual(60);
    }
    const filteredReads = readCalls().filter((call) => {
      const args = call[0] as { types?: readonly string[] };
      return Array.isArray(args.types);
    });
    expect(filteredReads.length).toBeGreaterThan(0);
    expect(
      (filteredReads[0]?.[0] as { types?: readonly string[] }).types,
    ).toEqual(FLEET_EVENT_TYPES);
  });

  it("shrinks an oversized event page without skipping its cursor", async () => {
    const ascLimits: number[] = [];
    host = createFakePluginHost({
      pluginId: "agent-tv",
      sdk: {
        threads: {
          events: {
            list: (async (args: { order?: string; limit?: string; threadId: string }) => {
              if (args.order !== "asc") return [];
              const limit = Number(args.limit);
              ascLimits.push(limit);
              if (ascLimits.length < 3) {
                throw new Error("HTTP 413: Event response exceeds the 8 MiB limit");
              }
              return [{ ...command(1, "i1", "npm test"), threadId: args.threadId }];
            }) as never,
          },
        },
      },
    });
    await plugin(host.bb);
    host.harness.behavior.emitThreadEvent("experimental_thread.events", {
      thread: makeThreadResponse({ id: "thr_a", status: "active" }),
      sequence: 1,
    });
    await host.harness.behavior.callRpc("fleet_snapshot", { threadIds: ["thr_a"] });
    host.harness.behavior.emitThreadEvent("experimental_thread.events", {
      thread: makeThreadResponse({ id: "thr_a", status: "active" }),
      sequence: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const frame = frameOf(
      await host.harness.behavior.callRpc("fleet_snapshot", { threadIds: [] }),
    );
    expect(ascLimits.slice(0, 3)).toEqual([60, 30, 15]);
    expect(frame.rows[0]?.tool).toBe("npm test");
  });

  it("only seeds requested feeds and still caps idle feed memory", async () => {
    const ascThreads: string[] = [];
    const descThreads: string[] = [];
    host = createFakePluginHost({
      pluginId: "agent-tv",
      sdk: {
        threads: {
          events: {
            list: (async (args: { order?: string; threadId: string }) => {
              if (args.order === "asc") ascThreads.push(args.threadId);
              if (args.order === "desc") descThreads.push(args.threadId);
              return [];
            }) as never,
          },
          list: (async () => [
            makeThreadResponse({
              id: "thr_0",
              status: "active",
              updatedAt: Date.now() - 10_000,
            }),
          ]) as never,
        },
      },
    });
    await plugin(host.bb);
    for (let index = 0; index < 80; index += 1) {
      host.harness.behavior.emitThreadEvent("experimental_thread.events", {
        thread: makeThreadResponse({
          id: `thr_${index}`,
          status: "active",
          updatedAt: Date.now() + index,
        }),
        sequence: 1,
      });
    }
    await host.harness.behavior.callRpc("fleet_snapshot", { threadIds: ["thr_0"] });
    expect(ascThreads).toEqual(["thr_0"]);
    // The dedicated model lookup runs after an empty seed page so a DTO-only
    // quiet row can still recover its selected model.
    // The feed was evicted before the CLI pass, so its cold seed performs one
    expect(descThreads).toEqual(["thr_0", "thr_0"]);

    // Once the wall is seeded, adding enough newer quiet feeds evicts the
    // oldest one. The CLI must then hydrate only that thread, not drain every
    // cached feed back into the event API.
    host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({
        id: "thr_0",
        status: "idle",
        updatedAt: Date.now() - 1_000,
      }),
      lastAssistantText: null,
    });
    for (let index = 80; index < 160; index += 1) {
      host.harness.behavior.emitThreadEvent("thread.idle", {
        thread: makeThreadResponse({
          id: `thr_${index}`,
          status: "idle",
          updatedAt: Date.now() + index,
        }),
        lastAssistantText: null,
      });
    }
    await host.harness.behavior.runCli(["status"]);
    // The feed was evicted before the CLI pass, so its cold seed performs one
    // bounded tail read and one model-only read again.
    expect(descThreads).toEqual(["thr_0", "thr_0", "thr_0", "thr_0"]);
    expect(ascThreads).toEqual(["thr_0"]);
  });

  it("refuses input it did not ask for", async () => {
    await load([]);
    await expect(
      host.harness.behavior.callRpc("fleet_snapshot", { threadIds: "nope" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      host.harness.behavior.callRpc("fleet_snapshot", { nope: true }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      host.harness.behavior.callRpc("fleet_snapshot", {
        threadIds: Array.from({ length: 40 }, (_, index) => `thr_${index}`),
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    // An empty request is fine; threadIds defaults to [].
    expect(
      frameOf(await host.harness.behavior.callRpc("fleet_snapshot", {})).rows,
    ).toEqual([]);
  });

  it("survives a thread whose events cannot be read", async () => {
    host = createFakePluginHost({
      pluginId: "agent-tv",
      sdk: {
        threads: {
          events: {
            list: (async () => {
              throw new Error("nope");
            }) as never,
          },
        },
      },
    });
    await plugin(host.bb);
    host.harness.behavior.emitThreadEvent("experimental_thread.events", {
      thread: makeThreadResponse({ id: "thr_a", status: "active" }),
      sequence: 9,
    });
    const frame = frameOf(
      await host.harness.behavior.callRpc("fleet_snapshot", { threadIds: ["thr_a"] }),
    );
    expect(frame.rows).toEqual([]);
    // The notification path must not leave an unhandled rejection behind.
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it("answers the CLI with the same frame the wall shows", async () => {
    await load([
      command(1, "i1", "npm test"),
      fileChange(2, "i2", ["/repo/app.tsx"]),
    ]);
    const text = await host.harness.behavior.runCli(["status"]);
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain("AGENT TV");
    expect(text.stdout).toContain("Ship it");
    expect(text.stdout).toContain("app.tsx");
    const json = await host.harness.behavior.runCli(["status", "--json"]);
    expect(frameOf(JSON.parse(json.stdout)).rows[0]?.files).toEqual(["/repo/app.tsx"]);
    const limited = await host.harness.behavior.runCli(["status", "--limit", "abc"]);
    expect(limited.exitCode).toBe(1);
    expect(limited.stderr).toContain("--limit");
    const unknown = await host.harness.behavior.runCli(["teleport"]);
    expect(unknown.exitCode).toBe(1);
  });

  it("says so when nothing is on air", async () => {
    await load([]);
    const text = await host.harness.behavior.runCli(["status"]);
    expect(text.stdout).toContain("Nothing on air");
  });

  it("stops its service promptly on dispose", async () => {
    await load([command(1, "i1", "npm test")]);
    const service = host.harness.behavior.runService("fleet-frame");
    service.controller.abort();
    await expect(service.done).resolves.toBeUndefined();
    await host.harness.lifecycle.dispose();
  });

  it("exposes the contract's method names to the rpc type", async () => {
    expect(Object.keys(rpcContract)).toEqual(["fleet_snapshot"]);
  });

  it("seeds a thread that turns busy after the wall is already open", async () => {
    // The sidebar names a thread once it looks busy, which is generally a
    // later heartbeat than the one that opened the wall. Seeding used to be
    // first-viewer-only, so such a thread was left at cursor 0.
    const recorder = recordingHost({
      thr_a: [command(1, "a1", "npm test")],
      thr_b: longLog(400),
    });
    host = recorder.host;
    await plugin(host.bb);

    await host.harness.behavior.callRpc("fleet_snapshot", { threadIds: ["thr_a"] });
    recorder.reads.length = 0;

    await host.harness.behavior.callRpc("fleet_snapshot", {
      threadIds: ["thr_a", "thr_b"],
    });
    const forB = recorder.reads.filter((read) => read.threadId === "thr_b");
    expect(forB.length).toBeGreaterThan(0);
    expect(forB[0]?.order).toBe("desc"); // the tail, not the head
    expect(forB.some((read) => read.order === "asc" && read.afterSeq === "0")).toBe(
      false,
    );
    const frame = frameOf(
      await host.harness.behavior.callRpc("fleet_snapshot", { threadIds: ["thr_b"] }),
    );
    expect(frame.rows.find((row) => row.id === "thr_b")?.tool).toBe("step 399");
  });

  it("seeds a thread it first hears of from a notification", async () => {
    const recorder = recordingHost({
      thr_a: [command(1, "a1", "npm test")],
      thr_b: longLog(400),
    });
    host = recorder.host;
    await plugin(host.bb);
    // Hold a watch lease, but on a different thread.
    await host.harness.behavior.callRpc("fleet_snapshot", { threadIds: ["thr_a"] });
    recorder.reads.length = 0;

    host.harness.behavior.emitThreadEvent("experimental_thread.events", {
      thread: makeThreadResponse({
        id: "thr_b",
        status: "active",
        title: "Long one",
        updatedAt: Date.now(),
      }),
      sequence: 400,
    });
    await new Promise((resolve) => setTimeout(resolve, 60));

    const forB = recorder.reads.filter((read) => read.threadId === "thr_b");
    expect(forB[0]?.order).toBe("desc");
    // The contract that matters: a few reads, not a page-by-page walk through
    // 400 events from seq 0.
    expect(forB.some((read) => read.afterSeq === "0")).toBe(false);
    expect(forB.length).toBeLessThan(4);
    // The notification path seeds but leaves publishing to the next tick, so
    // read the pump directly rather than the channel.
    const frame = frameOf(
      await host.harness.behavior.callRpc("fleet_snapshot", { threadIds: [] }),
    );
    expect(frame.rows.find((row) => row.id === "thr_b")?.tool).toBe("step 399");
  });

  it("does not republish a frame that has not changed", async () => {
    await load([command(1, "i1", "npm test")]);
    await host.harness.behavior.callRpc("fleet_snapshot", { threadIds: ["thr_a"] });
    const announcement = {
      thread: makeThreadResponse({
        id: "thr_a",
        status: "idle",
        updatedAt: Date.now(),
      }),
      lastAssistantText: null,
    };
    host.harness.behavior.emitThreadEvent("thread.idle", announcement);
    const published = host.harness.inspection.realtimeSignals.length;

    // The same announcement folds to the same frame. Only the clock differs,
    // and the clock is not news — the wall ages its own rows.
    host.harness.behavior.emitThreadEvent("thread.idle", announcement);
    expect(host.harness.inspection.realtimeSignals.length).toBe(published);

    // Anything a viewer would actually notice still goes out.
    host.harness.behavior.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({
        id: "thr_a",
        status: "active",
        updatedAt: Date.now(),
      }),
    });
    expect(host.harness.inspection.realtimeSignals.length).toBeGreaterThan(published);
  });

  it("retries a seed whose first read failed", async () => {
    let failing = true;
    const reads: string[] = [];
    host = createFakePluginHost({
      pluginId: "agent-tv",
      sdk: {
        threads: {
          events: {
            list: (async () => {
              reads.push("read");
              if (failing) {
                failing = false;
                throw new Error("nope");
              }
              return [];
            }) as never,
          },
        },
      },
    });
    await plugin(host.bb);

    await host.harness.behavior.callRpc("fleet_snapshot", { threadIds: ["thr_a"] });
    expect(reads).toHaveLength(1);
    // Inside the backoff, nothing is retried.
    await host.harness.behavior.callRpc("fleet_snapshot", { threadIds: ["thr_a"] });
    expect(reads).toHaveLength(1);
    // Past it, the feed is seeded rather than written off for the rest of the
    // session, which is what the eager `hydrated` flag used to mean.
    const later = Date.now() + 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => later);
    await host.harness.behavior.callRpc("fleet_snapshot", { threadIds: ["thr_a"] });
    expect(reads.length).toBeGreaterThan(1);
  });

  it("fills --limit past the wall's own row setting", async () => {
    const logs: Record<string, Row[]> = {};
    for (let index = 0; index < 20; index += 1) {
      logs[`thr_${index}`] = [command(1, `i${index}`, `step ${index}`)];
    }
    host = createFakePluginHost({
      pluginId: "agent-tv",
      settings: { maxRows: 4 },
      sdk: {
        threads: {
          events: { list: perThreadLog(logs) as never },
          list: (async () =>
            Array.from({ length: 20 }, (_, index) =>
              makeThreadResponse({
                id: `thr_${index}`,
                status: "active",
                title: `T${index}`,
                updatedAt: Date.now() - index,
              }),
            )) as never,
        },
      },
    });
    await plugin(host.bb);
    const out = await host.harness.behavior.runCli([
      "status",
      "--json",
      "--limit",
      "20",
    ]);
    // The wall carries 4 rows; the CLI asked for 20. It used to be capped by
    // both that setting and an internal 16-thread scan.
    expect(frameOf(JSON.parse(out.stdout)).rows).toHaveLength(20);
  });

  it("prints its usage for `help` instead of the feed", async () => {
    await load([command(1, "i1", "npm test")]);
    const help = await host.harness.behavior.runCli(["help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("bb agent-tv status");
    expect(help.stdout).not.toContain("AGENT TV \u2014");
  });

  it("reports who needs you, and puts them first", async () => {
    await load([command(1, "i1", "npm test"), askRow(2, "pending")]);
    const frame = frameOf(
      await host.harness.behavior.callRpc("fleet_snapshot", { threadIds: ["thr_a"] }),
    );
    expect(frame.rows[0]?.waiting).toBe("question");

    const text = await host.harness.behavior.runCli(["status"]);
    expect(text.stdout).toContain("1 waiting on you");
    expect(text.stdout).toContain("NEEDS YOU: question");

    // And it lets go once the ask resolves.
    log.push(askRow(3, "resolved"));
    host.harness.behavior.emitThreadEvent("experimental_thread.events", {
      thread: makeThreadResponse({ id: "thr_a", status: "active" }),
      sequence: 3,
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const after = frameOf(
      await host.harness.behavior.callRpc("fleet_snapshot", { threadIds: [] }),
    );
    expect(after.rows[0]?.waiting).toBeNull();
  });

  it("raises an ask from the free event, with no read at all", async () => {
    await load([command(1, "i1", "npm test")]);
    await host.harness.behavior.callRpc("fleet_snapshot", { threadIds: ["thr_a"] });
    const reads = readCalls().length;

    host.harness.behavior.emitThreadEvent("interaction.pending", {
      thread: makeThreadResponse({
        id: "thr_a",
        status: "active",
        updatedAt: Date.now(),
      }),
      interaction: {
        id: "int_9",
        payload: { kind: "user_question" },
      },
    } as never);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Attention is the one thing worth knowing instantly, and it is free.
    expect(readCalls().length).toBe(reads);
    expect(lastFrame().rows[0]?.waiting).toBe("question");
  });

  it("asks the event API for the interaction rows it folds", async () => {
    await load([command(1, "i1", "npm test")]);
    await host.harness.behavior.callRpc("fleet_snapshot", { threadIds: ["thr_a"] });
    const types = readCalls()
      .map((call) => (call as unknown as ReadArgs[])[0]?.types ?? [])
      .flat();
    expect(types).toContain("system/userQuestion/lifecycle");
    expect(types).toContain("system/permissionGrant/lifecycle");
    expect(types).toContain("system/interaction/lifecycle");
  });

  it("names a verb-only action instead of calling it quiet", async () => {
    // A reasoning item has a verb and no text of its own, and it is very
    // often the last thing in a thread's tail.
    await load([
      {
        id: "evt_1",
        scope: { kind: "turn", turnId: "turn-1" },
        threadId: "",
        seq: 1,
        createdAt: T0 + 1,
        type: "item/started",
        data: { item: { type: "reasoning", id: "r1" } },
      },
    ]);
    const frame = frameOf(
      await host.harness.behavior.callRpc("fleet_snapshot", { threadIds: ["thr_a"] }),
    );
    expect(frame.rows[0]?.tool).toBeNull();
    expect(frame.rows[0]?.verb).toBe("Thinking");
    const text = await host.harness.behavior.runCli(["status"]);
    expect(text.stdout).toContain("Thinking");
    expect(text.stdout).not.toContain("quiet");
  });

  it("reports context runway, and names threads near their limit", async () => {
    const usage = (seq: number, used: number, window: number): Row => ({
      id: `evt_${seq}`,
      scope: { kind: "turn", turnId: "turn-ctx" },
      threadId: "",
      seq,
      createdAt: T0 + seq,
      type: "thread/contextWindowUsage/updated",
      data: {
        providerThreadId: "01a0c473",
        contextWindowUsage: { usedTokens: used, modelContextWindow: window, estimated: false },
      },
    });
    await load([command(1, "i1", "npm test"), usage(2, 101_032, 258_400)]);
    const frame = frameOf(
      await host.harness.behavior.callRpc("fleet_snapshot", { threadIds: ["thr_a"] }),
    );
    expect(frame.rows[0]?.context?.used).toBe(101_032);

    const text = await host.harness.behavior.runCli(["status"]);
    expect(text.stdout).toContain("ctx 39%");
    expect(text.stdout).not.toContain("near the context limit");

    // Past the pressure mark the header calls it out, so a fleet about to
    // compact is visible without reading every row.
    log.push(usage(3, 240_000, 258_400));
    host.harness.behavior.emitThreadEvent("experimental_thread.events", {
      thread: makeThreadResponse({ id: "thr_a", status: "active" }),
      sequence: 3,
    });
    const tight = await host.harness.behavior.runCli(["status"]);
    expect(tight.stdout).toContain("1 near the context limit");
    expect(tight.stdout).toContain("ctx 93% !");
  });

  it("asks the event API for the context rows it folds", async () => {
    await load([command(1, "i1", "npm test")]);
    await host.harness.behavior.callRpc("fleet_snapshot", { threadIds: ["thr_a"] });
    const types = readCalls()
      .map((call) => (call as unknown as ReadArgs[])[0]?.types ?? [])
      .flat();
    expect(types).toContain("thread/contextWindowUsage/updated");
  });

  it("neither shows nor reads a hidden thread", async () => {
    const recorder = recordingHost({
      thr_a: [command(1, "i1", "npm test")],
      thr_hidden: longLog(50),
    });
    host = recorder.host;
    await plugin(host.bb);
    await host.harness.behavior.callRpc("fleet_snapshot", { threadIds: ["thr_a"] });
    recorder.reads.length = 0;

    host.harness.behavior.emitThreadEvent("experimental_thread.events", {
      thread: makeThreadResponse({
        id: "thr_hidden",
        status: "active",
        title: "Recap worker",
        visibility: "hidden",
        updatedAt: Date.now(),
      }),
      sequence: 50,
    });
    await new Promise((resolve) => setTimeout(resolve, 60));

    const frame = frameOf(
      await host.harness.behavior.callRpc("fleet_snapshot", { threadIds: [] }),
    );
    expect(frame.rows.map((row) => row.id)).toEqual(["thr_a"]);
    // No tile means no reason to read its event log either.
    expect(recorder.reads.filter((read) => read.threadId === "thr_hidden")).toEqual(
      [],
    );
  });

  it("does not even list hidden threads for the CLI", async () => {
    await load([command(1, "i1", "npm test")]);
    await host.harness.behavior.runCli(["status"]);
    const calls = host.harness.inspection.sdk.callsTo("threads.list");
    expect(calls.length).toBeGreaterThan(0);
    const query = (calls.at(-1) as unknown as Array<Record<string, unknown>>)[0];
    expect(query?.includeHidden).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Keeping up with a running thread
 *
 * The pump follows the event log forward, a bounded page at a time. A thread
 * that appends faster than that — any thread streaming tokens — outruns the
 * reader, and a feed that is behind is showing history: a settled tool call
 * and a `quietMs` measured from an event minutes old. These pin the two ways
 * out of that: skipping to the tail, and re-reading the tail of a thread that
 * core says is running but that has gone silent on us.
 * ------------------------------------------------------------------ */
describe("catching up with a thread that outruns the reader", () => {
  it("jumps to the tail instead of walking a backlog it cannot retire", async () => {
    // Seeded while the thread was young, then it runs away: 1,000 unread
    // events, far more than DRAIN_ROUNDS x DRAIN_LIMIT (180), so following
    // forward can never reach the end while the thread keeps going.
    const rows: Row[] = longLog(20);
    const reads: ReadArgs[] = [];
    host = createFakePluginHost({
      pluginId: "agent-tv",
      sdk: {
        threads: {
          events: {
            list: perThreadLog({ thr_a: rows }, (args) => reads.push(args)) as never,
          },
          list: (async () => []) as never,
        },
      },
    });
    await plugin(host.bb);
    await host.harness.behavior.callRpc("fleet_snapshot", { threadIds: ["thr_a"] });

    rows.push(...longLog(1_000).slice(20));
    reads.length = 0;
    host.harness.behavior.emitThreadEvent("experimental_thread.events", {
      thread: makeThreadResponse({ id: "thr_a", status: "active" }),
      sequence: 1_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 80));

    const frame = frameOf(
      await host.harness.behavior.callRpc("fleet_snapshot", { threadIds: [] }),
    );
    const row = frame.rows.find((entry) => entry.id === "thr_a");
    // The newest item, not the 21st. This is the whole bug: it used to report
    // "step 19" for as long as the thread kept talking.
    expect(row?.tool).toBe("step 999");
    expect(row?.busy).toBe(true);
    // And it got there in a handful of reads, not sixteen pages of 60.
    expect(reads.length).toBeLessThan(5);
    expect(reads.some((read) => read.order === "desc")).toBe(true);
  });

  it("never calls a running thread settled or quiet while it is behind", async () => {
    // The newest thing we have read finished, and it was a while ago: on the
    // old rule this tile read "Ran command … 2m ago", quiet and settled, while
    // the thread was mid-turn the whole time.
    const reads: ReadArgs[] = [];
    host = createFakePluginHost({
      pluginId: "agent-tv",
      sdk: {
        threads: {
          events: {
            list: perThreadLog(
              {
                thr_a: [
                  command(1, "i1", "npm test"),
                  command(2, "i1", "npm test", "completed"),
                ],
              },
              (args) => reads.push(args),
            ) as never,
          },
          list: (async () => []) as never,
        },
      },
    });
    await plugin(host.bb);
    await host.harness.behavior.callRpc("fleet_snapshot", { threadIds: ["thr_a"] });
    const settledFirst = frameOf(
      await host.harness.behavior.callRpc("fleet_snapshot", { threadIds: [] }),
    ).rows.find((entry) => entry.id === "thr_a");
    expect(settledFirst?.settled).toBe(true);

    // Now core announces events we have not read, and time passes.
    vi.setSystemTime(Date.now() + 120_000);
    host.harness.behavior.emitThreadEvent("experimental_thread.events", {
      thread: makeThreadResponse({ id: "thr_a", status: "active" }),
      sequence: 5_000,
    });

    const row = frameOf(
      await host.harness.behavior.callRpc("fleet_snapshot", { threadIds: [] }),
    ).rows.find((entry) => entry.id === "thr_a");
    expect(row?.busy).toBe(true);
    expect(row?.settled).toBe(false);
    // It still names the last action it saw — that part was never the lie.
    expect(row?.tool).toBe("npm test");
    vi.useRealTimers();
  });

  it("re-reads the tail of a running thread that has gone silent on us", async () => {
    const rows: Row[] = [command(1, "i1", "npm test", "completed")];
    const reads: ReadArgs[] = [];
    host = createFakePluginHost({
      pluginId: "agent-tv",
      sdk: {
        threads: {
          events: {
            list: perThreadLog({ thr_a: rows }, (args) => reads.push(args)) as never,
          },
          list: (async () => [
            makeThreadResponse({ id: "thr_a", status: "active", title: "Ship it" }),
          ]) as never,
        },
      },
    });
    await plugin(host.bb);
    await host.harness.behavior.runCli(["status"]);

    // The thread keeps working, but no notification reaches us and its row's
    // `updatedAt` does not move either — which is exactly what a running
    // thread's DTO looks like.
    rows.push(command(2, "i2", "cargo build"));
    // Age the feed past the busy window so it reads as stale.
    vi.setSystemTime(Date.now() + 90_000);
    reads.length = 0;

    const out = await host.harness.behavior.runCli(["status", "--json"]);
    const row = frameOf(JSON.parse(out.stdout)).rows[0];
    expect(reads.some((read) => read.order === "desc")).toBe(true);
    expect(row?.tool).toBe("cargo build");
    expect(row?.busy).toBe(true);
    vi.useRealTimers();
  });

  it("picks the threads that are running, not the first ones listed", async () => {
    // A realistic `threads.list`: unordered, and the idle threads carry much
    // fresher `updatedAt` than the running ones, because a thread row's
    // `updatedAt` stops moving once its turn starts.
    const logs: Record<string, Row[]> = {};
    const listed: ReturnType<typeof makeThreadResponse>[] = [];
    for (let index = 0; index < 24; index += 1) {
      const id = `thr_idle_${index}`;
      logs[id] = [command(1, `idle${index}`, `idle step ${index}`, "completed")];
      listed.push(
        makeThreadResponse({
          id,
          status: "idle",
          title: `Idle ${index}`,
          updatedAt: Date.now(),
        }),
      );
    }
    for (let index = 0; index < 2; index += 1) {
      const id = `thr_live_${index}`;
      logs[id] = [
        command(1, `live${index}a`, `old step ${index}`, "completed"),
        command(2, `live${index}b`, `live step ${index}`),
      ];
      // Last at the end of the list, and "stale" by updatedAt.
      listed.push(
        makeThreadResponse({
          id,
          status: "active",
          title: `Live ${index}`,
          updatedAt: Date.now() - 600_000,
        }),
      );
    }
    host = createFakePluginHost({
      pluginId: "agent-tv",
      sdk: {
        threads: {
          events: { list: perThreadLog(logs) as never },
          list: (async () => listed) as never,
        },
      },
    });
    await plugin(host.bb);

    // --limit 3 scans only six threads. They have to be the right six.
    const out = await host.harness.behavior.runCli(["status", "--json", "--limit", "3"]);
    const ids = frameOf(JSON.parse(out.stdout)).rows.map((row) => row.id);
    expect(ids).toContain("thr_live_0");
    expect(ids).toContain("thr_live_1");
  });
});

/* ------------------------------------------------------------------ *
 * Feeds that cannot be read
 * ------------------------------------------------------------------ */
describe("a feed the pump cannot read", () => {
  it("drops a thread that is gone instead of retrying it forever", async () => {
    const reads: ReadArgs[] = [];
    host = createFakePluginHost({
      pluginId: "agent-tv",
      sdk: {
        threads: {
          events: {
            list: (async (args: ReadArgs) => {
              reads.push(args);
              throw new Error("HTTP 404: Thread not found");
            }) as never,
          },
          list: (async () => []) as never,
        },
      },
    });
    await plugin(host.bb);
    const start = Date.now();
    for (let attempt = 0; attempt < 6; attempt += 1) {
      // Step well past any backoff, so this measures "gave up", not "waited".
      vi.setSystemTime(start + attempt * 120_000);
      await host.harness.behavior.callRpc("fleet_snapshot", { threadIds: ["thr_gone"] });
    }
    // One look, then the feed is gone: a 404 is never going to become a 200.
    expect(reads.length).toBe(1);
    vi.useRealTimers();
  });

  it("stops retrying a feed that keeps failing", async () => {
    const reads: ReadArgs[] = [];
    host = createFakePluginHost({
      pluginId: "agent-tv",
      sdk: {
        threads: {
          events: {
            list: (async (args: ReadArgs) => {
              reads.push(args);
              throw new Error("HTTP 500: upstream exploded");
            }) as never,
          },
          list: (async () => []) as never,
        },
      },
    });
    await plugin(host.bb);
    const start = Date.now();
    for (let attempt = 0; attempt < 12; attempt += 1) {
      // Step past each backoff so the retries are not merely rate-limited.
      vi.setSystemTime(start + attempt * 120_000);
      await host.harness.behavior.callRpc("fleet_snapshot", { threadIds: ["thr_bad"] });
    }
    // Five attempts, then left alone — not one per look, for ever.
    expect(reads.length).toBeLessThanOrEqual(5);
    vi.useRealTimers();
  });

  it("steps over an event too large to read at one row a page", async () => {
    const reads: ReadArgs[] = [];
    host = createFakePluginHost({
      pluginId: "agent-tv",
      sdk: {
        threads: {
          events: {
            list: (async (args: ReadArgs) => {
              reads.push(args);
              if (args.order === "desc") return [];
              throw new Error(
                "HTTP 413: Event response exceeds the 8 MiB limit",
              );
            }) as never,
          },
          list: (async () => []) as never,
        },
      },
    });
    await plugin(host.bb);
    host.harness.behavior.emitThreadEvent("experimental_thread.events", {
      thread: makeThreadResponse({ id: "thr_fat", status: "active" }),
      sequence: 30,
    });
    await host.harness.behavior.callRpc("fleet_snapshot", { threadIds: ["thr_fat"] });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const forward = reads.filter((read) => read.order !== "desc");
    // It halves down to one row and then moves the cursor past the row it
    // cannot fetch, rather than asking for the same seq for ever.
    const cursors = forward.map((read) => Number(read.afterSeq ?? "0"));
    expect(Math.max(...cursors)).toBeGreaterThan(Math.min(...cursors));
  });
});

/* ------------------------------------------------------------------ *
 * Who the CLI is allowed to show
 * ------------------------------------------------------------------ */
describe("the CLI's project scope", () => {
  function twoProjects() {
    const logs: Record<string, Row[]> = {
      thr_mine: [command(1, "m1", "npm test")],
      thr_theirs: [command(1, "t1", "terraform apply")],
    };
    return createFakePluginHost({
      pluginId: "agent-tv",
      sdk: {
        threads: {
          events: { list: perThreadLog(logs) as never },
          list: (async (args?: { projectId?: string }) =>
            [
              makeThreadResponse({
                id: "thr_mine",
                status: "active",
                title: "Mine",
                projectId: "proj_mine",
              }),
              makeThreadResponse({
                id: "thr_theirs",
                status: "active",
                title: "Theirs",
                projectId: "proj_theirs",
              }),
            ].filter(
              (thread) =>
                args?.projectId === undefined ||
                thread.projectId === args.projectId,
            )) as never,
        },
      },
    });
  }

  it("shows only the calling thread's project", async () => {
    host = twoProjects();
    await plugin(host.bb);
    const out = await host.harness.behavior.runCli(["status", "--json"], {
      projectId: "proj_mine",
      threadId: "thr_mine",
    });
    const ids = frameOf(JSON.parse(out.stdout)).rows.map((row) => row.id);
    expect(ids).toEqual(["thr_mine"]);
  });

  it("widens to the whole machine only when asked", async () => {
    host = twoProjects();
    await plugin(host.bb);
    const out = await host.harness.behavior.runCli(
      ["status", "--json", "--all-projects"],
      { projectId: "proj_mine", threadId: "thr_mine" },
    );
    const ids = frameOf(JSON.parse(out.stdout)).rows.map((row) => row.id);
    expect(ids).toContain("thr_mine");
    expect(ids).toContain("thr_theirs");
  });

  it("shows everything to a terminal with no thread context", async () => {
    host = twoProjects();
    await plugin(host.bb);
    const out = await host.harness.behavior.runCli(["status", "--json"]);
    const ids = frameOf(JSON.parse(out.stdout)).rows.map((row) => row.id);
    expect(ids).toContain("thr_mine");
    expect(ids).toContain("thr_theirs");
  });

  it("answers --help without reading the fleet", async () => {
    host = twoProjects();
    await plugin(host.bb);
    const help = await host.harness.behavior.runCli(["--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("--all-projects");
    expect(host.harness.inspection.sdk.callsTo("threads.list").length).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Secrets never reach a tile
 * ------------------------------------------------------------------ */
describe("redaction on the wire", () => {
  it("masks a credential in a command line for both the CLI and the wall", async () => {
    await load([
      command(1, "i1", 'curl -H "Authorization: Bearer sk-live-abcd1234efgh" https://api.example.com'),
    ]);
    const out = await host.harness.behavior.runCli(["status", "--json"]);
    const tool = frameOf(JSON.parse(out.stdout)).rows[0]?.tool ?? "";
    expect(tool).not.toContain("sk-live-abcd1234efgh");
    expect(tool).toContain("Authorization: Bearer");
    // The command itself still identifies the work.
    expect(tool).toContain("curl");
  });
});
