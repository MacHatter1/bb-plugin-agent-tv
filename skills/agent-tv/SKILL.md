---
name: agent-tv
description: Read what every other running BB thread is doing right now with the Agent TV fleet feed (`bb agent-tv status`). Use when asked what the fleet/agents are working on, whether another thread is stuck, waiting on input, or which files sibling threads are touching.
---

# Agent TV: read the fleet

Agent TV folds BB's thread-event stream into one live frame per running thread:
the tool call in flight, the files touched in the last 60 seconds, whether the
model is mid-stream, and a 60-second activity trace. The sidebar footer shows it
as a wall of tiles; the command below returns the same data.

## Read the fleet

```
bb agent-tv status                # human-readable, one block per thread
bb agent-tv status --json         # the exact frame the wall renders
bb agent-tv status --limit 3      # the busiest threads only
bb agent-tv status --all-projects # every project on this bb, not just yours
bb agent-tv --help                # this usage, without reading the fleet
```

**Scope.** Run from inside a thread, this shows that thread's project only.
Sibling threads in the same project are the ones you can reason about; work in
someone else's project is not yours to read, and its command lines and file
paths are not yours to repeat. `--all-projects` widens it deliberately — say so
when you use it. Run outside a thread (a human in a terminal) there is no
project context and the whole machine is shown.

`--json` returns:

```
{ "t": <server ms>, "rows": [ {
    "id": "thr_…", "title": "Fix the flaky test",
    "status": "active" | "idle" | "error" | "pending" | "starting" | "stopping",
    "model": "gpt-5.6-luna" | null,
    "effort": "none" | "low" | "medium" | "high" | "max" | "xhigh" | "ultra" | "ultracode" | null,
    "projectId": "proj_…" | null,
    "providerId": "codex",
    "parentThreadId": "thr_parent" | null,
    "childCount": 2,
    "tool": "git commit -m 'ship it'" | null,   // the call in flight
    "verb": "Running command" | "Ran command",  // BB's own words for it
    "glyph": "Terminal",                        // BB's own icon for it
    "settled": false,                           // the call already returned
    "streaming": true,                          // model output in the last 3s
    "busy": true,                               // actually working — see below
    "files": ["/repo/src/app.tsx"],             // written in the last 60s
    "heat": [0, 0, 1, 2, 5, …],                 // 12 buckets x 5s, oldest first
    "waiting": "question" | "permission" | null, // blocked on a person
    "context": {                                // runway, or null
      "used": 101032, "window": 258400,
      "fraction": 0.39, "estimated": false
    },
    "quietMs": 1200                             // since its last event
} ] }
```

The wall resolves `providerId` through BB's provider catalog, so each tile can
show the provider's own artwork (with an accessible provider label). `model`
comes from the latest turn request (or a provider fallback), `effort` comes from
that turn's reasoning-level selection, and `projectId` maps to the project name
in the sidebar. `parentThreadId` and `childCount`
identify spawned/forked work. Threads BB marks hidden — the worker threads of
orchestrated work — never get a row of their own; they are counted in their
parent's `childCount` instead, which is the only place they appear. The wall can be
popped out into a draggable monitor from its header.

## How to use it

- Read `busy`, not `status`, to answer "is this thread working". BB leaves
  `status` at `active` for hours after an agent stops, so a wall sorted on it
  alone reported long-dead threads as on air. `busy` means a working status
  *and* evidence of it: output streaming, a tool call that has not returned
  (worth ten minutes of silence, because a test suite can be quiet), or an
  event within the last minute. `status` is still the lifecycle truth — report
  it as such, and use `quietMs` for how long the thread has been silent.
- `waiting` is the field to lead with: non-null means that thread is blocked on
  a person and will stay blocked until someone answers. Rows are sorted with
  those first, they keep their tile however long they have been quiet, and the
  value names the ask ("question", "permission"). Report these before anything
  else — nothing else on the wall is actionable.
- `context` is how much of its window a thread has burned, and it is the
  other half of `heat`: the sparkline says how hard a thread is working,
  `context.fraction` says how much room it has left to keep doing it. At or
  above 0.8 it is close enough to compaction to act on — wrap it up, fork it,
  or hand it over, because once it compacts the detail is gone. `estimated`
  means the provider is guessing; report it as approximate. It is **null for
  providers that do not report usage at all** (ACP-bridged ones do not), and
  null means unknown, never "plenty left".
- `heat` counts work per five-second bucket over the last minute, on an
  absolute scale: a bucket with twenty events reads taller than one with two,
  on every thread. Streaming counts once per bucket rather than once per token,
  so the line tracks work rather than how talkative the model is. A falling
  line plus a stale `quietMs` is a thread that stopped making progress, not one
  that finished.
- Rows do not expire: a thread keeps its row until a busier one crowds it out
  of `maxRows`, so `quietMs` — not the row's presence — is what tells you
  whether anything is happening. An empty feed means the pump has not seen any
  thread activity at all, and the feed is never a substitute for reading a
  thread with `bb thread show <id>`.
- A quiet row can be dismissed immediately with its check button. That is a
  viewing-only dismissal remembered across panel/plugin reloads: if the thread
  becomes busy again, it returns.
- Prefer this over polling other threads' timelines: it is a handful of bounded
  reads, and it is the same data the user is looking at.
- The pump asks for only the event kinds it folds, and seeds any thread it has
  not read from the tail of its log; unrelated timeline payloads are not read.
- A feed that falls far behind its thread, or that has gone silent while BB
  still calls the thread running, is re-read from the tail rather than replayed
  forward. So a row is either current or openly unsettled — but `quietMs` is
  still "since the last event we folded", so treat a large one on a `busy` row
  as "catching up", not as "stuck".
- Command lines are redacted before they reach you: inline `NAME=value`
  credentials, `Authorization:` headers, `-u user:pass`, `--password`/`--token`
  values, `user:pass@` URLs and recognisable key prefixes come through masked
  with `•••`. Do not try to reconstruct them, and do not go and read the
  original event to get around it.
- Event pages adapt down when BB rejects a response for size, and a single
  event too large to fetch at all is stepped over rather than retried for ever.
  A thread that has been deleted is dropped instead of re-read.
