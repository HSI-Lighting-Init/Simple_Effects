# Status — Timeline append / drop-to-insert / themed title bar

Date: 2026-11-17 · Plan: `docs/superpowers/plans/2026-11-17-timeline-append-insert.md`
Spec: `docs/superpowers/specs/2026-11-17-timeline-append-insert-design.md`

All changes are uncommitted in the working tree.

## Task 1 — Ripple flag on `place_layer` (Rust) + TS wrapper

- `src-tauri/src/lib.rs`
  - `place_in_comp` takes a sixth `ripple: bool` argument. When true it computes the
    new layer's span (full `duration_ms` for a video, else its play range; floored at
    `MIN_SPAN_MS`), shifts every other current-scope layer starting at or after
    `start_ms` with the existing `shift_layer_time` (range + keyframes + group
    children), restores the placed layer's span via `end_ms = start_ms + span`, and
    grows `project.duration_ms` to the max layer end / `start_ms + span` (capped at
    `MAX_COMP_MS`) even when `duration_set_by_user`.
  - `place_layer` gained `ripple: Option<bool>` and passes `ripple.unwrap_or(false)`;
    its doc comment mentions the ripple.
  - `mod comp_length_tests`: added `starting_at`, `ripple_insert_makes_room_and_carries_keyframes`,
    `ripple_insert_grows_a_user_set_length_to_the_full_clip`; the two existing
    `place_in_comp` calls now pass `false`.
- `src/lib/api.ts`: `placeLayer(..., grow = false, ripple = false)` and sends `ripple`.

Test output:

- Red (Step 2): `error[E0061]: this function takes 5 arguments but 6 arguments were supplied`
  (4 occurrences), as the plan expected.
- Green (Step 4): `test result: ok. 8 passed; 0 failed; 0 ignored; 0 measured; 231 filtered out; finished in 0.00s`

## Task 2 — Pure drop-target helpers

- New `src/lib/videoSequence.ts` with `videoEndMs(layers)` and
  `mediaDropTarget(layers, ms, isVideo)` (nearest video start/end edge, ties to the
  earlier edge, ripple only for a video when at least one video exists).
- New `test/video-sequence.test.ts`.

Test output:

- Red (Step 2): `Error: Cannot find module '../src/lib/videoSequence' imported from .../test/video-sequence.test.ts` — matches.
- Green (Step 4): `Test Files  1 passed (1)` / `Tests  7 passed (7)`.

## Task 3 — Click-add appends videos

- `src/App.tsx`
  - `onAddMediaToTimeline(path, atMs?, ripple = false)`: computes
    `seqEnd = kind === "video" && atMs == null ? videoEndMs(projectRef.current?.layers ?? []) : null`
    before any add, places at `seqEnd ?? atMs ?? playhead` with
    `ripple = seqEnd != null || ripple`, and keeps the video's audio row at the same
    start **without** ripple.
  - Agent bridge `addMedia` now passes `Math.round(timeRef.current)`; the merge-videos
    caller is unchanged.
  - Imported `videoEndMs`.

Checks:

- `npx tsc --noEmit` (via `npx.cmd`): no output, exit 0.
- Manual check (Step 4): **not run** — no ability to see/operate the running app window.

## Task 4 — Drag from the Media bin, drop on the timeline

- `src/components/MediaPanel.tsx`: removed `draggable`/`onDragStart`/`onClick` and the
  `DragEvent` import; added `onDragToTimeline` prop and `startPress` mousedown
  tracking (left button only, ignores `.media-remove`, 4 px threshold, release before
  the threshold still adds). Header comment and item `title` updated.
- `src/App.tsx`: `mediaDragPath` state + `endMediaDrag`; wired `onDragToTimeline`,
  `mediaDragPath`, `onMediaDragEnd`, `onDropMedia`.
- `src/components/Timeline.tsx`: three new props, `dropHint` state, and a `useEffect`
  that hit-tests the visible tracks (`scrollRef`), converts x with `tracksRef`
  (same math as `splitAt`), calls `mediaDropTarget`, shows/hides the insertion line,
  sets/clears the `copy` cursor, and adds on release over the tracks only.
- `src/App.css`: `.tl-insert-line` after `.tl-playhead`.

Checks:

- `npx tsc --noEmit` (via `npx.cmd`): no output, exit 0.
- `npx vitest run` (via `npx.cmd`): `Test Files  13 passed (13)` / `Tests  310 passed (310)`.
- Manual check (Step 6): **not run** — no ability to see/operate the running app window.

## Task 5 — Title bar in the app's colours (Windows)

- `src-tauri/Cargo.toml`: added
  `[target.'cfg(windows)'.dependencies] windows = { version = "0.61", features = ["Win32_Foundation", "Win32_Graphics_Dwm"] }`.
  `Cargo.lock` only gained `"windows"` in the package's dependency list (0.61.3 was
  already locked; no new download).
- `src-tauri/src/lib.rs`: `theme_title_bar(hwnd)` (cfg(windows)) sets
  `DWMWA_CAPTION_COLOR` / `DWMWA_TEXT_COLOR` / `DWMWA_BORDER_COLOR` and ignores errors;
  called at the start of the `run()` `.setup` closure via
  `app.get_webview_window("main")`.

Checks:

- `cargo check --manifest-path src-tauri/Cargo.toml`: `Finished \`dev\` profile [unoptimized + debuginfo] target(s) in 6.13s`
  (only the pre-existing ts-rs "failed to parse serde attribute" warnings).
- Manual check (Step 5): **not run** — no ability to see the running app window.

## Task 6 — Final verification

- `npx tsc --noEmit` (via `npx.cmd`): no output, exit 0.
- `npx vitest run` (via `npx.cmd`): `Tests  310 passed (310)`.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`: `test result: ok. 232 passed; 0 failed; 7 ignored; 0 measured; 0 filtered out; finished in 5.27s`.

`git status` contains only the expected entries:

```
 M src-tauri/Cargo.lock
 M src-tauri/Cargo.toml
 M src-tauri/src/lib.rs
 M src/App.css
 M src/App.tsx
 M src/components/MediaPanel.tsx
 M src/components/Timeline.tsx
 M src/lib/api.ts
?? src/lib/videoSequence.ts
?? test/video-sequence.test.ts
?? docs/STATUS-timeline-append-insert.md
```

Pre-existing untracked items (`installers/`, the two `*-Scenes.csv` files, and the
plan/spec docs themselves) were left untouched.

## Deviations / notes

- `npx` could not be invoked directly: PowerShell blocked `npx.ps1`
  (`running scripts is disabled on this system`). The same commands were run via
  `npx.cmd` with identical arguments.
- In `place_in_comp`, the placed layer's span is restored as
  `end_ms = <its current start_ms> + span` (the plan's "its `start_ms`"). Using the
  target `start_ms` here made the existing `grow` block read the already-moved end as
  the span and inflate it; with the layer's own start the two ripple tests pass.
- Manual checks for Tasks 3, 4 and 5 are reported as **not run**, and their plan
  checkboxes are left unticked.

## Reviewer verification (2026-11-17)

Manual checks run in the live debug app (working tree via Vite), driven with real
mouse/keyboard events over the WebView2 debug port; state read from `get_project`.

- Task 3: first video at playhead (0:00 title untouched); next videos appended
  back-to-back; audio rows aligned with their videos; 2 px jitter still a click;
  with a user-set length, an end title moved after the new clip and the comp grew
  118.3 s → 130.4 s. **Pass.**
- Task 4: video dropped near 15 133 ms snapped to 15 133 (line shown mid-drag,
  `copy` cursor); later layers + audio + titles shifted by exactly 45 067 ms,
  earlier ones untouched; image drop landed at the pointer, nothing moved; release
  over the preview added nothing and cleared line/cursor; zoomed ~4× + scrolled
  drop landed on the edge; ✕ removed without adding; Ctrl+Z ×2 restored every
  shifted layer and the comp length. **Pass.**
- **Bug found + fixed:** dragging from the bin selected text across the bin (31
  chars mid-drag). Added `e.preventDefault()` in `MediaPanel.startPress` (same as
  the timeline's own drags); re-tested: 0 chars, click still adds.
- Task 5: title-bar pixel = menu-bar pixel = `#16161e`. **Pass.** Window buttons /
  snap layouts not re-checked (native, unchanged by a colour attribute).
- After the fix: `tsc` exit 0, vitest 310/310.
