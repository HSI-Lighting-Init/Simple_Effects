# Timeline: append videos, drop-to-insert, themed title bar — design

Date: 2026-11-17 · Size: small change (two independent parts)

## Part 1 — Videos play one after another

### Why
Adding several videos today puts every one at the playhead (usually 0:00), each on
its own row, so they all play at once and the top one hides the rest. The user
wants added videos to play in sequence, and to be able to drop a video from the
Media bin between two clips with the later clips making room.

### Goals
- **Click-add a video** (Media bin click) → it starts where the **latest-ending
  video layer** ends. This is the same as a drop at the end edge: layers starting
  at or after that point (e.g. an end title) move after the new clip. No video on
  the timeline yet → at the playhead, nothing moves (today's behaviour).
- **Drag a video from the Media bin onto the timeline** → an insertion line snaps
  to the **nearest video edge** (any video layer's start or end, which includes
  "after the last video"). Release → the new video starts at that edge and
  **every layer that starts at or after that edge** (videos, their audio rows,
  titles, images, effects, groups) shifts later by the new clip's length.
- Each video keeps **its own row** (the timeline stays one-row-per-layer).
- A video's audio row is placed at the same start as its video, as today.
- Adding/inserting a video **always grows the comp** to fit everything, even when
  the user set the comp length by hand (`duration_set_by_user`) — otherwise an
  appended clip would land past the end. Capped at `MAX_COMP_MS`.
- The shift is part of the add: undo takes the clip and the shift back together.

### Non-goals
- Images, audio, text: click-add still lands at the playhead. Dropped from the bin,
  they land exactly at the release time; nothing shifts.
- No clip splitting (dropping mid-clip goes to the nearer edge of that clip).
- Layers that start *before* the insert point never move or stretch, even if they
  span across it (e.g. background music from 0:00).
- Files dropped from Explorer keep today's behaviour (they go into the bin).
- The AI assistant's `add_media_layer` keeps placing at the playhead (its tool
  description promises that; it positions clips itself afterwards). The
  merge-videos flow keeps passing its explicit start time. Rule: an explicit
  `atMs` means exact placement, no append, no shift.

### Approaches considered
- **A — Snap to nearest clip edge (chosen).** Can never create overlapping videos;
  fits the existing timeline.
- **B — Split the clip under the cursor and insert in the gap.** More powerful,
  but it is a second feature (cutting) and easy to trigger by accident. Rejected.
- Dropping at the exact release time was ruled out: it recreates the overlap the
  feature is meant to remove.

### How (decided)
- **Ripple lives in Rust**, in `place_in_comp` (`src-tauri/src/lib.rs`), behind a
  new optional flag on `place_layer`. With the flag: shift every *other* layer in
  `project.layers` (current scope) whose `start_ms >= start_ms` by the new layer's
  span using the existing `shift_layer_time` (moves keyframes and group children
  too), then grow the comp to the max layer end, ignoring `duration_set_by_user`.
  `place_layer` takes no snapshot, so the ripple shares the add's undo step.
- **Append time** is computed in `onAddMediaToTimeline` (`src/App.tsx`) from
  `project.layers`: max `endMs` over `kind === "video"` layers. Used only when no
  `atMs` is passed and the file is a video. The audio row uses the same time and
  is placed **without** the ripple flag (space is already made).
- **The drag must not use HTML5 drag-and-drop** — Tauri's WebView2 drop handler
  swallows it on Windows (see the comment above `startRowDrag` in
  `src/components/Timeline.tsx`). Use the same pointer-tracking pattern as row
  reordering: mousedown on a bin item starts tracking, moving past a few pixels
  makes it a drag (a plain click still adds), release over the timeline's track
  area hit-tests and converts x → ms with the timeline's existing scale. Remove the
  dead `onDragStart`/`draggable` from `MediaPanel.tsx`.
- While dragging a video over the timeline, draw a vertical insertion line at the
  snapped edge. Over a non-video drag, the line follows the cursor time.

### Left to the builder
- Exact drag threshold, insertion-line styling, and how the drag state is passed
  between `MediaPanel`, `App` and `Timeline` (keep it to props; no new store).
- Snap with no videos present: release time as-is.

## Part 2 — Title bar in the app's colours

### Why
The native Windows title bar sits above the menu bar in stock Windows grey/black
and reads as generic.

### Chosen: recolour the native title bar (option B)
- On Windows only (`#[cfg(windows)]`), in the Tauri `.setup` hook, get the main
  window's HWND and call `DwmSetWindowAttribute`:
  - `DWMWA_CAPTION_COLOR` (35) = `--panel` `#16161e`
  - `DWMWA_TEXT_COLOR` (36) = `--text` `#e7e7ef`
  - `DWMWA_BORDER_COLOR` (34) = `--line` `#2a2a38`
  - COLORREF is `0x00BBGGRR`.
- Ignore the returned error: Windows 10 doesn't support these attributes and just
  keeps its standard bar. macOS untouched.
- Use a `windows`/`windows-sys` version already in `Cargo.lock` (0.61 / 0.59–0.60)
  as a `[target.'cfg(windows)'.dependencies]` entry — no new download.

### Rejected: merge the title bar into the menu bar (option A)
One row and a fully custom look, but we'd rebuild drag-to-move, double-click
maximize and the window buttons, lose Windows 11 snap layouts, and need separate
macOS work.

## Check to leave behind
One Rust unit test for the ripple: three layers at 0–5 s, 5–10 s, 10–12 s (the last
a title); place a new 3 s layer at 5 s with the flag → the later two start at
8 s and 13 s, the first is untouched, comp ≥ 15 s, and a keyframe on the moved
title moved by 3 s.
