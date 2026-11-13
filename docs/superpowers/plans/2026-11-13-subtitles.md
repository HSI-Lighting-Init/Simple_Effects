# Subtitles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Users can import a subtitle file, or generate subtitles from a clip's speech. Either way the lines land as editable Text layers in a "Subtitles" group, and a Copy Look / Paste Look action restyles all of them at once.

**Architecture:** ffmpeg (already found and installed by the app) converts any subtitle file to SRT, and its built-in `whisper` filter transcribes speech to SRT. A small Rust reader turns SRT into cues, and cues become Text layers in one Group. Pure logic lives in a new `src-tauri/src/subtitles.rs` (a child module, so it can use `lib.rs`'s private helpers via `super::`). Paste Look lives next to the existing `apply_layer_style` in `lib.rs`. The UI follows the existing Copy/Paste effects pattern in `App.tsx`.

**Tech Stack:** Rust (Tauri 2 commands, ts-rs bindings), React 19 + TypeScript, ffmpeg 8.1 (Gyan full build, `--enable-whisper`), Windows `curl.exe`.

**Spec:** `docs/superpowers/specs/2026-11-13-subtitles-design.md`. Read it first. This plan argues from it.

## Global Constraints

- No new Rust crates and no new npm packages.
- **No commits.** The user commits only when they ask. Each task ends with a `git status --short` check instead.
- Leave the pre-existing uncommitted changes alone: `build.json`, `deploy.ps1`, `docs/superpowers/specs/2026-11-04-auto-update-design.md`, `src/buildInfo.ts`, `installers/`, `*-Scenes.csv`.
- One undo step per import, generation and paste: exactly one `state.snapshot(&project)` before any change.
- Never hold `state.project` (or `state.shaped`) locked while ffmpeg or curl runs.
- The whisper filter string never contains an absolute path. Run ffmpeg with `current_dir` = the models folder and pass only file names.
- The only network call is the model download from `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/<file>`. Audio never leaves the machine.
- Models, verbatim:
  - `fast` → `ggml-base.bin`, 147951465 bytes, sha256 `60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe`
  - `accurate` → `ggml-large-v3-turbo-q5_0.bin`, 574041195 bytes, sha256 `394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2`
- Models folder: `%LOCALAPPDATA%\Simple Effects\whisper-models\` (same base as the existing `merged\`).
- Whisper args: `queue=20`, `max_len` = 42 for landscape or square comps, 24 when `height > width`.
- Default subtitle look:
  - size `round(0.055 × min(width, height))`
  - centred at `x = width/2`, `y = 0.88 × height`
  - lines wrapped to ≤ `0.9 × width`
  - white fill with a black Outside stroke of width `max(1, 0.08 × size)`
- Paste Look copies everything except content, id, name, start/end, `parts` and transform position (`x`, `y`).
- macOS must still compile. Windows-only behaviour (winget) fails with a message, never a panic.
- Run Rust tests from `src-tauri/` with `cargo test`. This also regenerates `src/bindings/*.ts`. Type-check the frontend with `npx tsc --noEmit` from the repo root.

## Review Focus

1. **A clip with no speech, or an empty subtitle file.** Expect the message "No subtitles found…" or "No speech found in this clip.", and no empty group created. Owner: Task 2 (`place_cues` with zero cues), Task 5.
2. **Overlapping cues** (two speakers, ASS signs). Expect both lines visible: the later one stacks above the earlier one instead of drawing on top. Owner: Task 2.
3. **Huge files** (a 2-hour movie SRT). Expect cues past the 1-hour comp cap (`MAX_COMP_MS`) or past a hand-set comp length to be dropped and counted, not piled up at the end. Owner: Task 2.
4. **Cancelled or broken model download.** Expect a `.part` file never to count as ready, and the next attempt to start clean. Owner: Task 4.
5. **Generate while exporting.** The cancel flag is shared, so cancelling one would kill the other. Expect Generate to be disabled while exporting. Owner: Task 5.

---

### Task 1: SRT reader, markup stripping, line wrapping

**Files:**
- Create: `src-tauri/src/subtitles.rs`
- Modify: `src-tauri/src/lib.rs:7-13` (add `mod subtitles;`)
- Test: `src-tauri/src/subtitles.rs` (`#[cfg(test)] mod tests`)

**Interfaces:**
- Produces:
  - `pub struct Cue { pub start_ms: u32, pub end_ms: u32, pub text: String }` (`Debug, Clone, PartialEq`)
  - `pub fn parse_srt(s: &str) -> Vec<Cue>`
  - `pub fn strip_markup(s: &str) -> String`
  - `pub fn wrap_line(line: &str, max_w: f32, measure: &dyn Fn(&str) -> f32) -> Vec<String>`

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn parses_whisper_style_srt_numbered_from_zero() {
    let s = "0\n00:00:00,000 --> 00:00:05,120\nWelcome to Simple Effects.\n\n1\n00:00:05,120 --> 00:00:12,000\nFirst, import a subtitle file.\n";
    assert_eq!(parse_srt(s), vec![
        Cue { start_ms: 0, end_ms: 5120, text: "Welcome to Simple Effects.".into() },
        Cue { start_ms: 5120, end_ms: 12000, text: "First, import a subtitle file.".into() },
    ]);
}
#[test]
fn tolerates_bom_crlf_dot_millis_missing_index_and_multiline() {
    let s = "\u{feff}00:00:01.500 --> 00:00:03.000\r\nHello\r\nsecond line\r\n\r\n";
    assert_eq!(parse_srt(s), vec![Cue { start_ms: 1500, end_ms: 3000, text: "Hello\nsecond line".into() }]);
}
#[test]
fn strips_tags_and_override_codes() {
    // Exactly what ffmpeg produced from an ASS file on 2026-11-13.
    let s = "1\n00:00:01,500 --> 00:00:03,000\n<font size=\"20\">{\\an8}Hello <i>there</i>\nsecond line</font>\n";
    assert_eq!(parse_srt(s)[0].text, "Hello there\nsecond line");
}
#[test]
fn drops_empty_and_backwards_cues() {
    let s = "1\n00:00:01,000 --> 00:00:02,000\n<i></i>\n\n2\n00:00:05,000 --> 00:00:04,000\nback\n\n3\n00:00:06,000 --> 00:00:07,000\nok\n";
    assert_eq!(parse_srt(s).len(), 1);
}
#[test]
fn hours_parse() {
    assert_eq!(parse_srt("01:02:03,004 --> 01:02:04,000\nx\n")[0].start_ms, 3_723_004);
}
#[test]
fn wraps_at_word_boundaries_to_fit() {
    let m = |s: &str| s.chars().count() as f32 * 10.0; // 10 px per char
    assert_eq!(wrap_line("one two three four", 95.0, &m), vec!["one two", "three four"]);
    assert_eq!(wrap_line("short", 95.0, &m), vec!["short"]);
    assert_eq!(wrap_line("supercalifragilistic", 95.0, &m), vec!["supercalifragilistic"]); // one long word stays whole
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd src-tauri && cargo test subtitles::tests`
Expected: FAIL (compile error: `parse_srt` / `Cue` not found).

- [ ] **Step 3: Implement `Cue`, `parse_srt`, `strip_markup`, `wrap_line` in `subtitles.rs`**

- `parse_srt` strips a leading BOM and normalises `\r\n`, then splits on blank lines.
- In each block, find the first line containing `-->`. Parse `H:MM:SS[,.]mmm` on both sides, ignoring anything after the end time (VTT-style settings). Take the lines after it as text.
- Run `strip_markup` on each text line, trim it, drop empty lines, and join with `\n`.
- Keep a cue only if its text is non-empty and `end_ms > start_ms`.
- `strip_markup` removes `<…>` and `{…}` spans with a single char loop, no regex.
- `wrap_line` is a greedy word wrap on spaces using `measure`. A single word wider than `max_w` stays on its own line.

- [ ] **Step 4: Run them to verify they pass**

Run: `cd src-tauri && cargo test subtitles::tests`
Expected: PASS (6 tests).

- [ ] **Step 5: Check the working tree**

Run: `git status --short`
Expected: only `src-tauri/src/subtitles.rs` (new) and `src-tauri/src/lib.rs` changed, besides the pre-existing files listed in Global Constraints.

---

### Task 2: Cues → "Subtitles" group, and File → Import Subtitles…

**Files:**
- Modify: `src-tauri/src/lib.rs:350-398`. Extract `new_text_layer` from `add_text_layer`, then make `add_text_layer` use it.
- Modify: `src-tauri/src/subtitles.rs` (`place_cues`, `SubtitleResult`, `import_subtitles` command)
- Modify: `src-tauri/src/lib.rs` `generate_handler!` (~line 6738): add `subtitles::import_subtitles`
- Modify: `src/lib/api.ts` (wrapper), `src/App.tsx` (File menu item + handler, ~line 4308)
- Test: `src-tauri/src/subtitles.rs` tests

**Interfaces:**
- Consumes: `Cue`, `parse_srt`, `wrap_line` (Task 1). From `lib.rs`: `max_layer_id`, `text_layer_name`, `comp_is_fit`, `refit_comp`, `MAX_COMP_MS`, `MIN_SPAN_MS`, `reshape_recursive`, `find_ffmpeg`, `quiet_command`.
- Produces:
  - `fn new_text_layer(id: u32, content: String, size: f32, x: f32, y: f32, start_ms: u32, end_ms: u32) -> Layer` (lib.rs). Same defaults as `add_text_layer` today.
  - `pub fn place_cues(p: &mut Project, cues: Vec<Cue>, measure: &dyn Fn(&str, f32) -> f32) -> (u32, u32)`. Returns `(lines_placed, dropped)`. Pushes nothing when no cue survives. Does **not** snapshot; the caller does.
  - `#[derive(Serialize, TS)] #[serde(rename_all = "camelCase")] #[ts(export, export_to = "../../src/bindings/")] pub struct SubtitleResult { pub project: Project, pub lines: u32, pub dropped: u32 }`
  - `#[tauri::command(async)] pub fn import_subtitles(state: State<AppState>, path: String) -> Result<SubtitleResult, String>`
  - TS: `importSubtitles(path: string) => Promise<SubtitleResult>`

- [ ] **Step 1: Write the failing tests**

```rust
fn m(s: &str, size: f32) -> f32 { s.chars().count() as f32 * size * 0.5 }
fn cue(a: u32, b: u32, t: &str) -> Cue { Cue { start_ms: a, end_ms: b, text: t.into() } }
fn landscape() -> Project { let mut p = Project::empty(); p.width = 1920; p.height = 1080; p }

#[test]
fn cues_become_text_layers_in_one_subtitles_group() {
    let mut p = landscape();
    assert_eq!(place_cues(&mut p, vec![cue(0, 1000, "Hi"), cue(1000, 2500, "There")], &m), (2, 0));
    assert_eq!(p.layers.len(), 1);
    let g = &p.layers[0];
    assert_eq!((g.name.as_str(), g.start_ms, g.end_ms), ("Subtitles", 0, 2500));
    let LayerKind::Group { children } = &g.kind else { panic!("not a group") };
    assert_eq!(children.len(), 2);
    let LayerKind::Text { content, size, .. } = &children[1].kind else { panic!("not text") };
    assert_eq!((content.as_str(), *size), ("There", 59.0)); // round(0.055 * 1080)
    assert_eq!((children[1].start_ms, children[1].end_ms), (1000, 2500));
    assert_eq!(children[0].transform.y.default, 0.88 * 1080.0);
    let ids: std::collections::HashSet<u32> = children.iter().map(|c| c.id).chain([g.id]).collect();
    assert_eq!(ids.len(), 3); // all ids unique
}
#[test]
fn portrait_size_uses_the_shorter_side_and_long_lines_wrap() {
    let mut p = Project::empty(); // 1080x1920
    place_cues(&mut p, vec![cue(0, 1000, "a fairly long subtitle line that will not fit in one row")], &m);
    let LayerKind::Group { children } = &p.layers[0].kind else { panic!() };
    let LayerKind::Text { content, size, .. } = &children[0].kind else { panic!() };
    assert_eq!(*size, 59.0);
    assert!(content.contains('\n'));
    assert!(content.lines().all(|l| m(l, 59.0) <= 0.9 * 1080.0 || !l.contains(' ')));
}
#[test]
fn no_cues_adds_nothing() {
    let mut p = landscape();
    assert_eq!(place_cues(&mut p, vec![], &m), (0, 0));
    assert!(p.layers.is_empty());
}
#[test]
fn fit_comp_grows_to_the_last_cue() {
    let mut p = landscape(); // 4000 ms, fit
    place_cues(&mut p, vec![cue(0, 1000, "a"), cue(9000, 12000, "b")], &m);
    assert_eq!(p.duration_ms, 12000);
}
#[test]
fn hand_set_length_drops_late_cues_and_trims_overrunning_ones() {
    let mut p = landscape();
    p.duration_set_by_user = true; // 4000 ms
    assert_eq!(place_cues(&mut p, vec![cue(0, 1000, "a"), cue(3500, 5000, "b"), cue(4000, 4500, "c")], &m), (2, 1));
    assert_eq!(p.duration_ms, 4000);
    let LayerKind::Group { children } = &p.layers[0].kind else { panic!() };
    assert_eq!(children[1].end_ms, 4000);
}
#[test]
fn cues_past_the_comp_cap_are_dropped() {
    let mut p = landscape();
    assert_eq!(place_cues(&mut p, vec![cue(0, 1000, "a"), cue(MAX_COMP_MS, MAX_COMP_MS + 1000, "late")], &m), (1, 1));
}
#[test]
fn overlapping_cues_stack_upward() {
    let mut p = landscape();
    place_cues(&mut p, vec![cue(0, 3000, "speaker one"), cue(1000, 2000, "speaker two")], &m);
    let LayerKind::Group { children } = &p.layers[0].kind else { panic!() };
    assert!(children[1].transform.y.default < children[0].transform.y.default);
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd src-tauri && cargo test subtitles::tests`
Expected: FAIL (compile error: `place_cues` not found).

- [ ] **Step 3: Extract `new_text_layer` in `lib.rs`**

Move the `Layer { … LayerKind::Text { … } … }` literal out of `add_text_layer` into `new_text_layer`. `add_text_layer` keeps its snapshot, shaping and `state.shaped` insert. Run `cargo test` to confirm nothing changed.

- [ ] **Step 4: Implement `place_cues` in `subtitles.rs`**

- **Limit:** `limit = if p.duration_set_by_user { p.duration_ms } else { MAX_COMP_MS }`. Drop cues with `start_ms >= limit` (counted in `dropped`). Trim `end_ms` to `limit`, keeping at least `MIN_SPAN_MS`.
- **Size and wrap:** `size = (0.055 * min(w, h) as f32).round()`. Wrap each `\n` line of the text with `wrap_line(line, 0.9 * w, &|s| measure(s, size))`.
- **Stacking:** `y = 0.88 * h - stack * size * 1.25`, where `stack` is the summed line count of earlier placed cues whose `end_ms > this.start_ms`.
- **Layer and style:** build each line with `new_text_layer`, then set `style = Some(TextStyle { strokes: vec![TextStroke { color: black, opacity: 100.0, width: (0.08 * size).max(1.0), position: StrokePosition::Outside }], fill_over_stroke: true, ..` with every other field empty or zero `})`. Set colour to opaque white.
- **Ids:** `max_layer_id(&p.layers) + 1 ..` for children, then the group last.
- **Group:** name `"Subtitles"`, `Transform::at(0.0, 0.0)`, span = union of the children (the same shape `combine_layers` builds).
- **Finish:** `let was_fit = comp_is_fit(p);` before pushing, then `refit_comp(p, was_fit)`.

- [ ] **Step 5: Implement `import_subtitles`**

1. `find_ffmpeg()`, or `Err("Subtitles need ffmpeg. Open File → Export Video… to install it.")`.
2. Run `quiet_command(ff).args(["-hide_banner", "-loglevel", "error", "-i"]).arg(&path).args(["-f", "srt", "-"]).output()`.
3. On failure: `Err(format!("Couldn't read this subtitle file: {}", <last non-empty stderr lines>))`.
4. Read stdout with `String::from_utf8_lossy` (never panic on bad bytes) and `parse_srt`.
5. Lock the project, `state.snapshot`, `place_cues` with the measure `|s, size| text::shape(s, size, &Font("Vazirmatn".into()), 400, false).width`.
6. If `lines == 0`: `Err("No subtitles found in this file.")`. The snapshot is harmless: nothing changed.
7. Otherwise `reshape_recursive(&mut state.shaped.lock().unwrap(), p.layers.last().unwrap())` and return `SubtitleResult`.

Register it in `generate_handler!`.

- [ ] **Step 6: Wire the frontend**

- `api.ts`: `export const importSubtitles = (path: string) => invoke<SubtitleResult>("import_subtitles", { path });`
- `App.tsx`: add `{ label: "Import Subtitles…", onClick: onImportSubtitles }` under "Import Image…".
- `onImportSubtitles`:
  - `open({ multiple: false, filters: [{ name: "Subtitles", extensions: ["srt", "vtt", "ass", "ssa", "sub", "smi", "sami"] }, { name: "All files", extensions: ["*"] }] })`
  - Call `importSubtitles`, then `setProject(r.project)`, `await applyTime(timeRef.current)`, `recordAction("import_subtitles", { path })`.
  - If `r.dropped > 0`: `alert(\`Added ${r.lines} subtitle lines. ${r.dropped} didn't fit in the comp's length and were left out.\`)`.
  - On error: `alert(String(e))`.

- [ ] **Step 7: Run all tests and the type check**

Run: `cd src-tauri && cargo test` then `cd .. && npx tsc --noEmit`
Expected: all Rust tests PASS (including the existing `comp_length_tests`), `src/bindings/SubtitleResult.ts` exists, and tsc reports no errors.

- [ ] **Step 8: Check the working tree**

Run: `git status --short`
Expected: changes only in `subtitles.rs`, `lib.rs`, `api.ts`, `App.tsx`, and the new `src/bindings/SubtitleResult.ts`.

---

### Task 3: Copy Look / Paste Look

**Files:**
- Modify: `src-tauri/src/lib.rs:5982-6060`. Extend `for_each_track_mut` for Text: every animator `selector` and `props` Track, plus `style.tracking` and `style.baseline_shift`.
- Modify: `src-tauri/src/lib.rs` near `apply_layer_style` (~4957): `remap_key_time`, `apply_text_look`, `paste_text_look` command. Register it in `generate_handler!`.
- Modify: `src/lib/api.ts`, `src/App.tsx` (clipboard state, context menu for text and group layers, Edit menu)
- Test: new `#[cfg(test)] mod text_look_tests` in `lib.rs`

**Interfaces:**
- Consumes: `shift_layer_time`, `for_each_track_mut`, `reshape_recursive`.
- Produces:
  - `fn remap_key_time(t: u32, src: (u32, u32), dst: (u32, u32)) -> u32`
  - `fn apply_text_look(target: &mut Layer, look: &Layer)`. No-op unless both are Text.
  - `#[tauri::command] fn paste_text_look(state: State<AppState>, look: Layer, target_ids: Vec<u32>) -> Result<Project, String>`
  - TS: `pasteTextLook(look: Layer, targetIds: number[]) => Promise<Project>`

Key remap rule (the spec's anchor-to-nearer-end rule):

```rust
// src = (start, end) of the look's layer, dst = target's. Clamp into dst.
let mid = (src.0 + src.1) / 2;
let out = if t <= mid { dst.0 as i64 + (t as i64 - src.0 as i64) }
          else        { dst.1 as i64 - (src.1 as i64 - t as i64) };
out.clamp(dst.0 as i64, dst.1 as i64) as u32
```

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn keys_keep_their_distance_from_the_nearer_end() {
    assert_eq!(remap_key_time(500, (0, 3000), (10000, 15000)), 10500);
    assert_eq!(remap_key_time(2800, (0, 3000), (10000, 15000)), 14800);
    assert_eq!(remap_key_time(2800, (0, 3000), (10000, 10100)), 10000); // 10100-200 = 9900, clamped up to the start
}
#[test]
fn paste_copies_the_look_but_keeps_content_timing_position_and_parts() {
    // look: text "A" 0–3000, size 80, x=100 y=100, opacity key at 2800, a colour key at 500
    // target: text "B" 10000–15000, size 40, x=500 y=900
    // after apply_text_look:
    //   content "B", start/end 10000/15000, x/y 500/900 (unchanged)
    //   size 80, opacity key at 14800, colour key at 10500, parts unchanged
}
#[test]
fn paste_onto_a_group_restyles_every_text_child_and_skips_others() {
    // group [text, colorpatch, group [text]] → both texts get size 80; colorpatch untouched
}
#[test]
fn moving_a_text_layer_now_carries_its_animator_keys() {
    // text layer with one animator whose selector.offset has a key at 1000;
    // shift_layer_time(layer, 500) → key at 1500
}
```

Write the three commented tests as real tests with those exact values. Build the layers with `new_text_layer` (Task 2).

- [ ] **Step 2: Run them to verify they fail**

Run: `cd src-tauri && cargo test text_look_tests`
Expected: FAIL (compile error: `remap_key_time` not found).

- [ ] **Step 3: Extend `for_each_track_mut`**

In the `LayerKind::Text` arm, also visit:
- every `Track` in each `animators[i].selector` and `animators[i].props`, including both `position` tracks
- `style.tracking` and `style.baseline_shift` when `style` is `Some`

Keep the existing `decompose`/`parts` visits.

- [ ] **Step 4: Implement `remap_key_time`, `apply_text_look`, `paste_text_look`**

**`apply_text_look`:**
1. Clone `look`.
2. Remap every key time on the clone: `for_each_track_mut` for Tracks, plus `color_keys` by hand, since they aren't Tracks. Use `remap_key_time(t, (look.start_ms, look.end_ms), (target.start_ms, target.end_ms))`.
3. Copy into the target: the Text fields listed in the spec except `content` and `parts`, and the clone's `transform` except `x`/`y`. Also copy `transition_in`, `transition_out`, `effects`.

**`paste_text_look`:**
1. Lock the project and `state.snapshot` once.
2. For each id in `target_ids`, found in `project.layers` (the current scope): a Text layer gets `apply_text_look`. A Group gets `apply_text_look` on every Text descendant, recursively.
3. `reshape_recursive` each touched top-level layer, then return the project.
4. If nothing matched: `Err("Select a text layer or a group of text layers.")`.

- [ ] **Step 5: Wire the frontend**

- `api.ts`: `export const pasteTextLook = (look: Layer, targetIds: number[]) => invoke<Project>("paste_text_look", { look, targetIds });`
- `App.tsx`: `const [textLookClip, setTextLookClip] = useState<Layer | null>(null);`
- **Copy Look** stores `structuredClone(layer)` (a copy, not an id, so it survives entering and leaving groups).
- **Paste Look** targets: `selectedIds.includes(id) ? selectedIds : [id]`. Then `setProject`, `applyTime`, `recordAction("paste_text_look", { targetIds })`.
- **Right-click a text layer:** replace the "Effects — image and video layers only" fallback with "Copy Look" and, when the clip is set, "Paste Look", followed by the transitions entries that already exist.
- **Right-click a group:** add "Paste Look to all text in group" next to "Enter group" when the clip is set.
- **Edit menu:** "Copy Look" (enabled when the selected layer is text) and "Paste Look" (enabled when the clip is set and something is selected).

- [ ] **Step 6: Run all tests and the type check**

Run: `cd src-tauri && cargo test` then `cd .. && npx tsc --noEmit`
Expected: all PASS, no tsc errors.

- [ ] **Step 7: Check the working tree**

Run: `git status --short`
Expected: no files beyond those listed for Tasks 1–3.

---

### Task 4: Whisper plumbing: models, cancellable download, finding a capable ffmpeg

**Files:**
- Modify: `src-tauri/src/lib.rs:5733-5780`. Extract the spawn/poll/kill loop from `run_ffmpeg` into `run_cancellable`. `run_ffmpeg` becomes `cmd.arg(path); run_cancellable(cmd, Path::new(path), "ffmpeg")`, and its error text stays byte-identical.
- Modify: `src-tauri/src/lib.rs:6512`. Add `app_data_dir(sub)` and make `merge_output_path` use it.
- Modify: `src-tauri/src/subtitles.rs` (models, download, lookup, update)
- Modify: `generate_handler!`: `subtitles::whisper_model_ready`, `subtitles::download_whisper_model`, `subtitles::update_ffmpeg`
- Modify: `src/lib/api.ts`
- Test: `subtitles.rs` tests. The existing `cancel_export_tests` must still pass, since it now covers `run_cancellable`.

**Interfaces:**
- Consumes: `check_download(path, size, sha256)`, `curl_error`, `quiet_command`, `find_ffmpeg`, `find_exe`, `install_ffmpeg`, `EXPORT_CANCEL`/`begin_export`.
- Produces:
  - `fn run_cancellable(cmd: std::process::Command, partial: &std::path::Path, tool: &str) -> Result<(), String>` (lib.rs). On cancel: kill, remove `partial`, `Err(EXPORT_CANCELLED)`. On failure: `"{tool} failed: …"`.
  - `fn app_data_dir(sub: &str) -> Result<std::path::PathBuf, String>` (lib.rs). Creates the folder.
  - `pub struct WhisperModel { pub file: &'static str, pub size: u64, pub sha256: &'static str }` and `pub fn whisper_model(quality: &str) -> Result<WhisperModel, String>` (`"fast"` / `"accurate"`, anything else is Err).
  - `pub fn models_dir() -> Result<PathBuf, String>` = `app_data_dir("whisper-models")`
  - `pub fn model_ready_in(dir: &Path, m: &WhisperModel) -> bool`. The file exists and its length equals `m.size`.
  - `pub fn has_whisper_filter(filters_stdout: &str) -> bool`
  - `pub fn find_whisper_ffmpeg() -> Result<PathBuf, String>`
  - Commands: `whisper_model_ready(quality: String) -> Result<bool, String>`, `#[tauri::command(async)] download_whisper_model(quality: String) -> Result<(), String>`, `#[tauri::command(async)] update_ffmpeg() -> Result<String, String>`
  - TS: `whisperModelReady(quality)`, `downloadWhisperModel(quality)`, `updateFfmpeg()`

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn model_table_matches_the_spec() {
    let f = whisper_model("fast").unwrap();
    assert_eq!((f.file, f.size), ("ggml-base.bin", 147951465));
    assert_eq!(f.sha256, "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe");
    let a = whisper_model("accurate").unwrap();
    assert_eq!((a.file, a.size), ("ggml-large-v3-turbo-q5_0.bin", 574041195));
    assert_eq!(a.sha256, "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2");
    assert!(whisper_model("huge").is_err());
}
#[test]
fn only_a_complete_model_file_counts_as_ready() {
    let dir = std::env::temp_dir().join(format!("se-models-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let m = WhisperModel { file: "t.bin", size: 1000, sha256: "" };
    assert!(!model_ready_in(&dir, &m));                                  // missing
    std::fs::File::create(dir.join("t.bin.part")).unwrap().set_len(1000).unwrap();
    assert!(!model_ready_in(&dir, &m));                                  // only a .part
    std::fs::File::create(dir.join("t.bin")).unwrap().set_len(999).unwrap();
    assert!(!model_ready_in(&dir, &m));                                  // wrong size
    std::fs::File::create(dir.join("t.bin")).unwrap().set_len(1000).unwrap();
    assert!(model_ready_in(&dir, &m));
    let _ = std::fs::remove_dir_all(&dir);
}
#[test]
fn detects_the_whisper_filter_line() {
    assert!(has_whisper_filter(" .. afir              N->A       Apply Finite Impulse Response filter.\n .. whisper           A->A       Transcribe audio using whisper.cpp.\n"));
    assert!(!has_whisper_filter(" .. afir              N->A       Apply Finite Impulse Response filter.\n"));
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd src-tauri && cargo test subtitles::tests`
Expected: FAIL (compile error: `whisper_model` not found).

- [ ] **Step 3: Extract `run_cancellable` and `app_data_dir` in `lib.rs`**

Then run `cd src-tauri && cargo test cancel_export_tests fast_merge_tests`. Expected: PASS, unchanged.

- [ ] **Step 4: Implement the model table, `models_dir`, `model_ready_in`, `has_whisper_filter`**

`has_whisper_filter`: true when any line's second whitespace-separated token is exactly `whisper`.

- [ ] **Step 5: Implement `download_whisper_model`**

1. `begin_export()`. `part = dir.join(format!("{}.part", m.file))`.
2. `run_cancellable(quiet_command("curl.exe").args(["-fL", "--retry", "2", "--speed-limit", "1024", "--speed-time", "60", "-o"]).arg(&part).arg(url), &part, "curl")`.
3. `check_download(&part, m.size, m.sha256)`, then `std::fs::rename(&part, dir.join(m.file))`.
4. On any error, remove `part` and return the error.
5. Add `// ponytail: check_download reads the whole 574 MB file into memory; stream the hash if low-memory PCs complain`.

- [ ] **Step 6: Implement `find_whisper_ffmpeg` and `update_ffmpeg`**

**`find_whisper_ffmpeg`:**
1. Candidates: `find_ffmpeg()`, then `find_exe(&<LOCALAPPDATA>/Microsoft/WinGet/Packages, "ffmpeg.exe", 5)`.
2. Return the first whose `-hide_banner -filters` stdout passes `has_whisper_filter`.
3. Otherwise `Err(format!("Speech detection needs ffmpeg 8 or later with Whisper. Checked: {}", <paths joined with ", ">))`. With no candidates, say "ffmpeg isn't installed".

**`update_ffmpeg`:**
1. Run `winget upgrade --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements --disable-interactivity`.
2. If `find_whisper_ffmpeg()` still fails, call `install_ffmpeg()`.
3. Return `Ok(path)` once `find_whisper_ffmpeg()` succeeds, else its error.

Register all three commands. Add the TS wrappers.

- [ ] **Step 7: Run all tests and the type check**

Run: `cd src-tauri && cargo test` then `cd .. && npx tsc --noEmit`
Expected: all PASS, no tsc errors.

- [ ] **Step 8: Check the working tree**

Run: `git status --short`
Expected: no files beyond those listed for Tasks 1–4.

---

### Task 5: Generate Subtitles from Speech

**Files:**
- Modify: `src-tauri/src/subtitles.rs` (`SourceWindow`, `source_window`, `to_comp_cues`, `whisper_af`, `max_len_for`, `transcribe_layer`)
- Modify: `generate_handler!`: `subtitles::transcribe_layer`
- Create: `src/components/SubtitlesDialog.tsx`
- Modify: `src/lib/api.ts`, `src/App.tsx` (context menu on video and audio layers, dialog state)
- Test: `subtitles.rs` tests

**Interfaces:**
- Consumes: `place_cues`, `SubtitleResult` (Task 2). `models_dir`, `whisper_model`, `model_ready_in`, `find_whisper_ffmpeg`, `run_cancellable`, `begin_export` (Task 4). From the frontend: `cancelExport`, `downloadWhisperModel`, `whisperModelReady`, `updateFfmpeg` (Task 4).
- Produces:
  - `pub struct SourceWindow { pub in_ms: u32, pub src_len_ms: u32, pub start_ms: u32, pub speed: f32 }`
  - `pub fn source_window(layer: &Layer) -> Result<SourceWindow, String>`
  - `pub fn to_comp_cues(cues: Vec<Cue>, w: &SourceWindow) -> Vec<Cue>`
  - `pub fn whisper_af(model_file: &str, language: &str, max_len: u32, dest_file: &str) -> Result<String, String>`
  - `pub fn max_len_for(width: u32, height: u32) -> u32`
  - `#[tauri::command(async)] pub fn transcribe_layer(state: State<AppState>, layer_id: u32, quality: String, language: String) -> Result<SubtitleResult, String>`
  - TS: `transcribeLayer(layerId: number, quality: "fast" | "accurate", language: string) => Promise<SubtitleResult>`
  - `SubtitlesDialog` props: `{ layerId: number; layerName: string; onClose: () => void; onDone: (r: SubtitleResult) => void }`

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn maps_trimmed_sped_up_source_time_to_comp_time() {
    let w = SourceWindow { in_ms: 1000, src_len_ms: 4000, start_ms: 2000, speed: 2.0 };
    assert_eq!(to_comp_cues(vec![cue(3000, 4000, "x")], &w), vec![cue(3500, 4000, "x")]);
}
#[test]
fn source_window_reads_the_played_span_and_refuses_reversed_clips() {
    // Video layer start 2000, end 4000, inMs 1000, speed 2.0 → in 1000, src_len 4000, start 2000
    // same layer with reverse: true → Err containing "reversed"
    // a Text layer → Err
}
#[test]
fn filter_string_has_no_paths_and_rejects_injected_options() {
    let af = whisper_af("ggml-base.bin", "auto", 42, "transcript-1.srt").unwrap();
    assert_eq!(af, "whisper=model=ggml-base.bin:language=auto:queue=20:max_len=42:destination=transcript-1.srt:format=srt");
    assert!(!af.contains('\\'));
    assert!(whisper_af("ggml-base.bin", "en:destination=x", 42, "t.srt").is_err());
}
#[test]
fn line_length_follows_comp_shape() {
    assert_eq!(max_len_for(1920, 1080), 42);
    assert_eq!(max_len_for(1080, 1080), 42);
    assert_eq!(max_len_for(1080, 1920), 24);
}
```

Write the commented test as a real one with those values, using a `Layer` like `comp_length_tests::clip`. These tests sit in the same `subtitles::tests` module as Task 2's, so `cue()` is already there.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd src-tauri && cargo test subtitles::tests`
Expected: FAIL (compile error: `SourceWindow` not found).

- [ ] **Step 3: Implement the pure helpers**

- `source_window` accepts Video and Audio only. It uses `src_len_ms = ((end - start) as f32 * speed).round() as u32` and `Err` on `speed <= 0`.
- `to_comp_cues`: `start + cue_ms / speed` for both ends.
- `whisper_af` validates `language` as `"auto"` or 2–3 lowercase ASCII letters, else `Err("unsupported language")`.

- [ ] **Step 4: Implement `transcribe_layer`**

1. Lock the project. Clone the layer found by id in `project.layers`, plus width and height. Unlock.
2. `source_window`. `whisper_model(&quality)`. `models_dir()`. If `!model_ready_in`: `Err("The speech model isn't downloaded yet.")`.
3. `find_whisper_ffmpeg()`. `begin_export()`. `dest = format!("transcript-{ms}.srt")`.
4. Build the command: `quiet_command(ff).current_dir(&dir).args(["-hide_banner", "-loglevel", "error", "-y", "-ss", &secs(in_ms), "-t", &secs(src_len_ms), "-i"]).arg(src).args(["-vn", "-af", &af, "-f", "null", "-"])`. `secs` formats ms as `"{:.3}"` seconds.
5. Run it with `run_cancellable(cmd, &dir.join(&dest), "ffmpeg")`.
6. Read the SRT (`from_utf8_lossy`), delete it, then `parse_srt`, then `to_comp_cues`.
7. Lock the project, `snapshot`, `place_cues` (same measure as Task 2). If 0 lines: `Err("No speech found in this clip.")`. Otherwise `reshape_recursive` and return `SubtitleResult`.

Register it.

- [ ] **Step 5: Build `SubtitlesDialog.tsx`**

Copy the markup and class names from an existing dialog such as `VideoTemplateDialog`. The dialog has:
- **Language select:** Auto-detect (default), English, Spanish, French, German, Italian, Portuguese, Dutch, Arabic, Persian, Chinese, Japanese. Values `auto`, `en`, `es`, `fr`, `de`, `it`, `pt`, `nl`, `ar`, `fa`, `zh`, `ja`.
- **Quality radio:** "Fast (≈148 MB download once)" and "Accurate (≈574 MB download once)". Default Fast.
- **Generate:**
  1. If `!(await whisperModelReady(q))`: set status "Downloading speech model…" and `await downloadWhisperModel(q)`.
  2. Set status "Transcribing…" and `onDone(await transcribeLayer(layerId, q, lang))`.
- **Cancel** (shown while busy): calls `cancelExport()`.
- **Errors:** an error equal to `"export cancelled"` returns the dialog to idle silently. An error containing "needs ffmpeg 8" shows it with an **Update ffmpeg** button that calls `updateFfmpeg()`. Any other error is shown inline.

- [ ] **Step 6: Wire `App.tsx`**

- Add `const [subtitlesFor, setSubtitlesFor] = useState<{ id: number; name: string } | null>(null)`.
- In the layer context menu, when the kind is `video` or `audio`, add `{ label: "💬 Generate Subtitles from Speech…", onClick: …, disabled: exporting }`. Audio layers need it in their branch too. Today they hit the "Effects — image and video layers only" fallback.
- Render the dialog when `subtitlesFor` is set.
- `onDone`: `setProject(r.project)`, `applyTime`, `recordAction("transcribe_layer", { layerId })`, close, and alert about `dropped` as in Task 2.

- [ ] **Step 7: Run all tests and the type check**

Run: `cd src-tauri && cargo test` then `cd .. && npx tsc --noEmit`
Expected: all PASS, no tsc errors.

- [ ] **Step 8: Check the working tree**

Run: `git status --short`
Expected: no files beyond those listed for Tasks 1–5.

---

### Task 6: End-to-end check in the real app

**Files:** none changed, unless a bug is found. A bug goes back to the owning task's tests first.

Sample inputs: create them in the session scratchpad, not the repo.
- An SRT with 3 cues, one ending past 4 s.
- An ASS line `{\an8}Hello {\i1}there{\i0}\Nsecond line`.
- A VTT cue.
- A WAV of speech, made with Windows TTS (`System.Speech.Synthesis.SpeechSynthesizer.SetOutputToWaveFile`).

- [ ] **Step 1: Launch the app** with `npm run tauri dev`, or use the `run` skill.
- [ ] **Step 2: Import each sample file** with File → Import Subtitles…
  Expected:
  - a "Subtitles" group with one text layer per cue
  - white outlined text near the bottom
  - ASS markup gone
  - the comp grows to the last cue
  - Ctrl+Z removes the whole import in one step
- [ ] **Step 3: Copy and paste a look**
  1. Style a separate text layer: a letter animation in, a glow, a new font size.
  2. Copy Look, then right-click the Subtitles group → Paste Look to all text in group.
  Expected: every line restyled, each line keeps its own text and timing, the animation plays per line, and one Ctrl+Z undoes it.
- [ ] **Step 4: Generate from speech**
  1. Add the WAV as an audio layer and trim its head by 1 s.
  2. Right-click → Generate Subtitles from Speech… → Fast.
  Expected:
  - the model downloads once into `%LOCALAPPDATA%\Simple Effects\whisper-models\`
  - the lines match the speech and start where the trimmed clip starts
  - a second run skips the download
- [ ] **Step 5: Cancel in the middle**, once during the model download (try Accurate) and once during transcription.
  Expected: the dialog goes idle, no `.part` or `transcript-*.srt` is left behind, and the next attempt works.
- [ ] **Step 6: Generate during an export.** Start an export, then right-click the audio layer.
  Expected: "Generate Subtitles from Speech…" is disabled (Review Focus 5).
- [ ] **Step 7: Report**: what passed, and anything that didn't, with the exact error text. No commit.
