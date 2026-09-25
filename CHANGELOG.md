# Changelog

All notable changes to Agent TV are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## Unreleased

## 0.1.0 - 2026-09-25

### Added

- **The wall:** a row in the sidebar footer that opens a live tile for every
  running thread. Hover to peek, click to keep it open, and click a tile to open
  its thread.
- **Tiles:** the tool call in flight in BB's own words and icon, files touched
  in the last minute, a typing indicator, and a 60-second activity sparkline on
  an absolute scale.
- **Context runway:** a rail showing how much of its context window each thread
  has spent. It is flagged at 80% or more and hidden for providers that do not
  report usage.
- **Needs you:** threads blocked on a question or an approval are marked and
  sorted first, on the wall and in the CLI.
- Provider marks, parent/child family badges, model, reasoning effort and
  project on every tile.
- A pop-out monitor that can be moved by dragging or with the keyboard, and
  remembers its position.
- A check button to dismiss quiet tiles, remembered across reloads. A dismissed
  tile returns if its thread starts working again.
- A layout that holds still while the wall is open.
- `bb agent-tv status` with `--json`, `--limit` and `--all-projects`. Inside a
  thread it is scoped to the caller's project.
- Credential redaction for action lines, applied the same way on the wall, in
  the CLI and on the realtime channel.
- A lease-gated pump that reads the event log only while a wall is open, asks
  only for the event kinds it folds, and bounds every read and frame.
