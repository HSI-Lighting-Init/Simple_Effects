# Timeline Append / Drop-to-Insert / Themed Title Bar — Implementation Plan

> **For the implementing agent:** work task by task, in order. Steps use checkbox
> (`- [ ]`) syntax — tick them as you go. Do not skip the "run it and see it fail"
> steps. If a step's expected output doesn't match, stop and report; don't improvise
> a different design.

**Goal:** Videos added to the timeline play one after another (each on its own row);
a video dragged from the Media bin onto the timeline snaps to the nearest clip edge
and pushes later layers right; the Windows title bar is painted in the app's colours.

**Architecture:** The "make room" shift (ripple) is a new flag on the existing Rust
command `place_layer`, so it shares the add's undo step. A small pure TS module
decides where a drop lands. The Media-bin drag uses pointer tracking (not HTML5
drag-and-drop — Tauri swallows that on Windows); the Timeline owns the drop. The
title bar is three `DwmSetWindowAttribute` calls in the Tauri `setup` hook.

**Tech Stack:** Tauri 2.11 (Rust), React + TypeScript, Vite, vitest, `windows` crate 0.61.

**Spec:** `docs/superpowers/specs/2026-11-17-timeline-append-insert-design.md` — read it first.

## Global Constraints

- **Do not commit, push, create or switch branches.** Leave every change uncommitted in the working tree; it will be reviewed as a diff.
- **Targeted edits only.** Never reformat whole files (no prettier / `cargo fmt` on `src/App.tsx` or `src-tauri/src/lib.rs` — they are 5k–8k lines). Match the surrounding style.
- Don't touch untracked files (`installers/`, `*.csv`) or anything not named in a task.
- No new npm packages. The only new Rust dependency is `windows = "0.61"` for Windows targets (Task 5) — it's already in `Cargo.lock`, so nothing new downloads.
- Do not change the AI-agent tool descriptions in `src/agent/tools.ts`.
- Run every command from the repo root (no `cd … &&` — Windows PowerShell 5.1 has no `&&`).
- Baseline (verified 2026-11-17): `npx tsc --noEmit` clean · `npx vitest run` 303 passed · `cargo test --manifest-path src-tauri/Cargo.toml --lib comp_length_tests` 6 passed. Everything must still be green at the end. If an unrelated test fails, report it — don't fix it.
- Keep comments short and about *why*, like the existing code.

## Review Focus

Things no unit test covers that are most likely to bite a user — each is a manual
check in the task that owns it:

1. Clicking the **✕ remove** button on a Media-bin item must remove it and **not** also add it to the timeline (the item now listens to mousedown). → Task 4
2. A click with a few pixels of mouse jitter must still count as a **click** (add), not a failed drag. Threshold: 4 px. → Task 4
3. Releasing a drag **outside the timeline** (over the preview, bin, or inspector) adds nothing and clears the insertion line. → Task 4
4. With the timeline **zoomed in and scrolled**, a drop lands exactly where the insertion line was drawn. → Task 4
5. A video **with sound**: its audio row starts with the video and is not shifted twice. → Task 3

---

### Task 1: Ripple flag on `place_layer` (Rust) + TS wrapper

**Files:**
- Modify: `src-tauri/src/lib.rs` — `place_layer` (~line 1487), `place_in_comp` (~line 1499), tests in `mod comp_length_tests` (~line 7858)
- Modify: `src/lib/api.ts:324-325` — `placeLayer`

**Interfaces:**
- Produces (Rust): `fn place_in_comp(project: &mut Project, layer_id: u32, start_ms: u32, above_id: Option<u32>, grow: bool, ripple: bool) -> Result<(), String>`; command `place_layer(..., grow: Option<bool>, ripple: Option<bool>)`.
- Produces (TS): `placeLayer(layerId: number, startMs: number, aboveId: number | null, grow = false, ripple = false): Promise<Project>`.

- [x] **Step 1: Add the failing tests** to `mod comp_length_tests` in `src-tauri/src/lib.rs`, and add `, false` as the new last argument to the two existing `place_in_comp(...)` calls in that module.

```rust
    /// `l` moved to start at `start`, keeping its span.
    fn starting_at(mut l: Layer, start: u32) -> Layer {
        l.end_ms += start;
        l.start_ms = start;
        l
    }

    #[test]
    fn ripple_insert_makes_room_and_carries_keyframes() {
        let mut p = Project::empty();
        add(&mut p, clip(1, 5_000)); // 0–5 s
        add(&mut p, starting_at(clip(2, 5_000), 5_000)); // 5–10 s
        let mut title = starting_at(clip(3, 2_000), 10_000); // 10–12 s
        title.transform.opacity.keys.push(Keyframe { time_ms: 11_000, value: 1.0, easing: Easing::Linear });
        add(&mut p, title);
        add(&mut p, clip(5, 20_000)); // music-like: 0–20 s, spans the insert point
        add(&mut p, clip(4, 3_000)); // the new clip, as add_video_layer leaves it (at 0)
        place_in_comp(&mut p, 4, 5_000, None, true, true).unwrap();
        let range = |id: u32| {
            let l = p.layers.iter().find(|l| l.id == id).unwrap();
            (l.start_ms, l.end_ms)
        };
        assert_eq!(range(1), (0, 5_000)); // before the insert point: untouched
        assert_eq!(range(4), (5_000, 8_000)); // the inserted clip
        assert_eq!(range(2), (8_000, 13_000)); // pushed right by 3 s
        assert_eq!(range(3), (13_000, 15_000));
        assert_eq!(range(5), (0, 20_000)); // started earlier: never moves or stretches
        let title = p.layers.iter().find(|l| l.id == 3).unwrap();
        assert_eq!(title.transform.opacity.keys[0].time_ms, 14_000); // keys travel with it
        assert!(p.duration_ms >= 20_000);
    }

    #[test]
    fn ripple_insert_grows_a_user_set_length_to_the_full_clip() {
        let mut p = Project::empty();
        apply_comp_duration(&mut p, 5_000);
        add(&mut p, clip(1, 5_000));
        add(&mut p, clip(2, 12_000)); // refit trims it to 0–5 s, like add_video_layer does
        place_in_comp(&mut p, 2, 5_000, None, true, true).unwrap();
        let l = p.layers.iter().find(|l| l.id == 2).unwrap();
        assert_eq!((l.start_ms, l.end_ms), (5_000, 17_000)); // full 12 s source, not the trimmed 5 s
        assert_eq!(p.duration_ms, 17_000);
    }
```

- [x] **Step 2: Run and see it fail to compile**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib comp_length_tests`
Expected: compile error — `place_in_comp` takes 5 arguments but 6 were supplied.

- [x] **Step 3: Implement the ripple** in `place_in_comp`. Add `ripple: bool` as the last parameter. When `ripple` is true, run this **before** the existing `if grow && ...` block (the existing grow / re-time / re-stack code stays as is and runs after):

```text
span = if the layer is LayerKind::Video with duration_ms > 0:
           duration_ms.clamp(MIN_SPAN_MS, MAX_COMP_MS)   // full source length — add_video_layer may have
                                                          // trimmed it to a user-set comp length
       else: (end_ms - start_ms).max(MIN_SPAN_MS)
for every OTHER layer in project.layers with l.start_ms >= start_ms:
    shift_layer_time(l, span as i64)                      // existing helper: range + keyframes + group children
set the placed layer's end_ms = its start_ms + span      // restores the span the re-time code reads
project.duration_ms = max(project.duration_ms, layers_end(project), start_ms + span).min(MAX_COMP_MS)
                                                          // grows even when duration_set_by_user
```

In the `place_layer` command add `ripple: Option<bool>` after `grow` and pass `ripple.unwrap_or(false)`. Extend the doc comment on `place_layer` with one line about `ripple`. In `src/lib/api.ts`, add `ripple = false` to `placeLayer` and include `ripple` in the invoke args object.

- [x] **Step 4: Run and see it pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib comp_length_tests`
Expected: `8 passed; 0 failed`.

---

### Task 2: Pure drop-target helpers (TS)

**Files:**
- Create: `src/lib/videoSequence.ts`
- Test: `test/video-sequence.test.ts`

**Interfaces:**
- Produces:
  - `videoEndMs(layers: Layer[]): number | null` — the max `endMs` over layers with `kind.kind === "video"`; `null` when there are none.
  - `mediaDropTarget(layers: Layer[], ms: number, isVideo: boolean): { ms: number; ripple: boolean }` — for a video with at least one video layer present: snap to the nearest `startMs`/`endMs` of any video layer (ties → the earlier edge), `ripple: true`. Otherwise `{ ms, ripple: false }` unchanged.
  - `Layer` is `import type { Layer } from "../bindings/Layer"`.

- [x] **Step 1: Write the failing test** `test/video-sequence.test.ts`

```ts
import { describe, it, expect } from "vitest";
import type { Layer } from "../src/bindings/Layer";
import { mediaDropTarget, videoEndMs } from "../src/lib/videoSequence";

const L = (kind: string, startMs: number, endMs: number) =>
  ({ id: 0, startMs, endMs, kind: { kind } }) as unknown as Layer;
const seq = [L("video", 0, 5000), L("video", 5000, 10000), L("text", 10000, 30000)];

describe("videoEndMs", () => {
  it("is the latest video end, ignoring other kinds", () => expect(videoEndMs(seq)).toBe(10000));
  it("is null when there is no video", () => expect(videoEndMs([L("text", 0, 3000)])).toBeNull());
});

describe("mediaDropTarget", () => {
  it("snaps a video to the nearest clip edge and ripples", () => {
    expect(mediaDropTarget(seq, 6000, true)).toEqual({ ms: 5000, ripple: true });
    expect(mediaDropTarget(seq, 9000, true)).toEqual({ ms: 10000, ripple: true });
  });
  it("snaps past the last video back to its end", () =>
    expect(mediaDropTarget(seq, 25000, true)).toEqual({ ms: 10000, ripple: true }));
  it("breaks a tie toward the earlier edge", () =>
    expect(mediaDropTarget(seq, 7500, true)).toEqual({ ms: 5000, ripple: true }));
  it("drops a video at the pointer when no video is on the timeline", () =>
    expect(mediaDropTarget([L("text", 0, 3000)], 1234, true)).toEqual({ ms: 1234, ripple: false }));
  it("never snaps or ripples images/audio", () =>
    expect(mediaDropTarget(seq, 6000, false)).toEqual({ ms: 6000, ripple: false }));
});
```

- [x] **Step 2: Run and see it fail**

Run: `npx vitest run test/video-sequence.test.ts`
Expected: FAIL — cannot resolve `../src/lib/videoSequence`.

- [x] **Step 3: Implement both functions** in `src/lib/videoSequence.ts` (one-line doc comment each, matching the Interfaces above).

- [x] **Step 4: Run and see it pass**

Run: `npx vitest run test/video-sequence.test.ts`
Expected: 7 passed.

---

### Task 3: Click-add appends videos (`App.tsx`)

**Files:**
- Modify: `src/App.tsx` — `onAddMediaToTimeline` (~line 1142), agent bridge `addMedia` (~line 1344), imports.

**Interfaces:**
- Consumes: `placeLayer(..., grow, ripple)` (Task 1), `videoEndMs` (Task 2).
- Produces: `onAddMediaToTimeline(path: string, atMs?: number, ripple = false): Promise<number | null>` — Task 4 passes it straight to the Timeline as `onDropMedia`.

- [x] **Step 1: Change `onAddMediaToTimeline`.**
  - New third parameter `ripple = false`.
  - **Before any `add*Layer` call** (the new layer would otherwise count itself), compute
    `seqEnd = kind === "video" && atMs == null ? videoEndMs(projectRef.current?.layers ?? []) : null`.
  - `at = seqEnd ?? atMs ?? Math.round(timeRef.current)`; ripple for the video's placement is `seqEnd != null || ripple`.
  - The video/image placement becomes `placeLayer(newId, at, above, true, <that ripple>)`.
  - The follow-up **audio** placement keeps `placeLayer(audId, at, newId, true)` — no ripple (room is already made).
  - Update the "Drop it at the playhead" comment: videos without an explicit time go after the last video.
- [x] **Step 2: Agent keeps the playhead.** In the agent bridge, change `addMedia` to call `onAddMediaToTimeline(m.path, Math.round(timeRef.current))`. Leave the merge-videos caller (`onAddMediaToTimeline(saved, inMs)`) unchanged.
- [x] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no output, exit 0.

- [ ] **Step 4: Manual check** (`npm run tauri dev`; import 3 short videos, one with sound; also a text layer):
  - Click the 3 videos in the bin → back-to-back on 3 rows, comp grows to their total. The video with sound has its audio row starting at the same time as its video. **(Review Focus 5)**
  - Add a text layer starting right where the last video ends, then click a 4th video → the text moves to after the new video.
  - Composition → set the comp length by hand to something short, click a video → full clip appended, comp grows to fit.
  - New project, add a text layer at 0:00, click a video → video goes at the playhead and the text does **not** move.

---

### Task 4: Drag from the Media bin, drop on the timeline

**Files:**
- Modify: `src/components/MediaPanel.tsx`
- Modify: `src/components/Timeline.tsx` — `Props` (~line 186), component body, tracks JSX next to `.tl-playhead` (~line 1334)
- Modify: `src/App.tsx` — new state + wiring on `<MediaPanel>` (~line 4778) and `<Timeline>` (~line 4973)
- Modify: `src/App.css` — new `.tl-insert-line` right after `.tl-playhead` (~line 2580)

**Interfaces:**
- Consumes: `mediaDropTarget` (Task 2), `onAddMediaToTimeline` (Task 3), `mediaKind` from `src/lib/media.ts`.
- Produces:
  - `MediaPanel` prop `onDragToTimeline: (path: string) => void` — "the pointer moved past the threshold; a drag of `path` has started".
  - `Timeline` props:
    ```ts
    /** A Media-bin item being dragged (absolute path), or null. While set, the timeline
     *  tracks the pointer, shows where it would land, and handles the release. */
    mediaDragPath: string | null;
    /** The drag finished (dropped on the tracks or released anywhere else). */
    onMediaDragEnd: () => void;
    /** Dropped on the tracks: add `path` at comp time `ms`; `ripple` pushes later layers right. */
    onDropMedia: (path: string, ms: number, ripple: boolean) => void;
    ```

- [x] **Step 1: MediaPanel — press tracking instead of HTML5 drag.** On `.media-item`, remove `draggable`, `onDragStart` and `onClick`; delete the `onDragStart` function and the `DragEvent` import. Add `onMouseDown={(e) => startPress(e, path)}` where `startPress`:
  - ignores non-left buttons, and returns immediately if `(e.target as HTMLElement).closest(".media-remove")` **(Review Focus 1)**;
  - adds window `mousemove`/`mouseup` listeners. Moving more than **4 px** from the press → remove both listeners, call `onDragToTimeline(path)`. `mouseup` before that → remove both, call `onAddToTimeline(path)` **(Review Focus 2)**.
  - Update the file's header comment and the item `title` to say: click adds to the timeline, drag places it.
- [x] **Step 2: App wiring.** `const [mediaDragPath, setMediaDragPath] = useState<string | null>(null);` and a stable `const endMediaDrag = useCallback(() => setMediaDragPath(null), []);`. Pass `onDragToTimeline={setMediaDragPath}` to `<MediaPanel>`. Pass `mediaDragPath={mediaDragPath}`, `onMediaDragEnd={endMediaDrag}`, `onDropMedia={onAddMediaToTimeline}` to `<Timeline>`.
- [x] **Step 3: Timeline — own the drop.** Destructure the 3 new props. Add `const [dropHint, setDropHint] = useState<number | null>(null);` (comp ms of the insertion line; null = pointer not over the tracks). Add one `useEffect` keyed on `[mediaDragPath, project, dur, onDropMedia, onMediaDragEnd]` that, when `mediaDragPath` is set:
  - `isVideo = mediaKind(mediaDragPath) === "video"`;
  - `targetAt(ev)`: if the pointer is outside `scrollRef.current`'s bounding rect (the *visible* tracks) → `null` **(Review Focus 3)**; else convert x with `tracksRef.current`'s rect exactly like `splitAt` does (`pct` clamped 0–1, `Math.round(pct * dur)`) **(Review Focus 4)**, then return `mediaDropTarget(project.layers, ms, isVideo)`;
  - window `mousemove` → `setDropHint(targetAt(ev)?.ms ?? null)`;
  - window `mouseup` → compute `t = targetAt(ev)`, remove both listeners, `setDropHint(null)`, `onMediaDragEnd()`, then `if (t) onDropMedia(mediaDragPath, t.ms, t.ripple)`;
  - set `document.body.style.cursor = "copy"` while active;
  - cleanup: remove both listeners, reset the cursor to `""`, `setDropHint(null)`.
  - Render, right after the `.tl-playhead` div: `{dropHint != null && <div className="tl-insert-line" style={{ left: \`${(dropHint / dur) * 100}%\` }} />}`.
- [x] **Step 4: CSS.** `.tl-insert-line`: `position: absolute; top: 0; bottom: 0; width: 3px; margin-left: -1.5px; background: var(--text); box-shadow: 0 0 6px var(--text); pointer-events: none; z-index: 6;`
- [x] **Step 5: Type-check and tests**

Run: `npx tsc --noEmit` → no output, exit 0. Run: `npx vitest run` → all pass (310).

- [ ] **Step 6: Manual check** (`npm run tauri dev`, 3 videos already back-to-back, a title over clip 3):
  - Drag a 4th video over the timeline → a white line snaps to clip edges; release between clips 1 and 2 → it's inserted there; clips 2, 3, their audio rows and the title all move right by its length.
  - Drag an image → line follows the pointer freely; release → image lands there, nothing moves.
  - Drag and release over the preview → nothing added, line gone, cursor back to normal. **(RF 3)**
  - Zoom the timeline in, scroll right, drop a video → lands at the line. **(RF 4)**
  - Click ✕ on a bin item → removed, nothing added. **(RF 1)** Click a thumbnail with a tiny wobble → added. **(RF 2)**
  - Ctrl+Z after an insert → the shifted layers return (two presses if the video has sound).

---

### Task 5: Title bar in the app's colours (Windows)

**Files:**
- Modify: `src-tauri/Cargo.toml` — new section at the end of the dependencies
- Modify: `src-tauri/src/lib.rs` — new fn near `run()` (~line 7170), call in `.setup(...)`

**Interfaces:** none consumed or produced.

- [x] **Step 1: Dependency.** Append to `src-tauri/Cargo.toml`:

```toml
[target.'cfg(windows)'.dependencies]
windows = { version = "0.61", features = ["Win32_Foundation", "Win32_Graphics_Dwm"] }
```

- [x] **Step 2: The function** (Tauri 2.11's `WebviewWindow::hwnd()` returns this crate's `HWND`, so the types line up):

```rust
/// Paint the native title bar in the app's own colours (--panel / --text / --line
/// in App.css). Windows 11 only; Windows 10 rejects these attributes and keeps its
/// standard bar, so errors are ignored.
#[cfg(windows)]
fn theme_title_bar(hwnd: windows::Win32::Foundation::HWND) {
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR,
    };
    // COLORREF is 0x00BBGGRR: #16161e, #e7e7ef, #2a2a38.
    for (attr, bgr) in [
        (DWMWA_CAPTION_COLOR, 0x001e1616u32),
        (DWMWA_TEXT_COLOR, 0x00efe7e7),
        (DWMWA_BORDER_COLOR, 0x00382a2a),
    ] {
        unsafe {
            let _ = DwmSetWindowAttribute(hwnd, attr, &bgr as *const u32 as *const _, 4);
        }
    }
}
```

- [x] **Step 3: Call it** at the start of the `.setup(|app| { ... })` closure in `run()` (`Manager` is already imported):

```rust
            #[cfg(windows)]
            {
                if let Some(w) = app.get_webview_window("main") {
                    if let Ok(hwnd) = w.hwnd() {
                        theme_title_bar(hwnd);
                    }
                }
            }
```

- [x] **Step 4: Build**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: finishes with no errors (warnings that already existed are fine).

- [ ] **Step 5: Manual check** — `npm run tauri dev`: the title bar is the same dark as the menu bar (`#16161e`) with light text; min/max/close, dragging the window, double-click maximize and Windows 11 snap layouts all still work.

---

### Task 6: Final verification and report

- [x] **Step 1:** Run all three; each must be green:
  - `npx tsc --noEmit` → exit 0
  - `npx vitest run` → 310 passed
  - `cargo test --manifest-path src-tauri/Cargo.toml --lib` → 0 failed
- [x] **Step 2:** `git status` — only these should be modified/added: `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` (feature changes only), `src-tauri/src/lib.rs`, `src/lib/api.ts`, `src/lib/videoSequence.ts`, `test/video-sequence.test.ts`, `src/App.tsx`, `src/App.css`, `src/components/MediaPanel.tsx`, `src/components/Timeline.tsx`, plus the report below. Revert anything else you touched.
- [x] **Step 3:** Write `docs/STATUS-timeline-append-insert.md`: per task, what changed (files + functions), the exact test output lines, which manual checks you ran and their result (or "not run" — don't guess), and any place you deviated from this plan and why.
