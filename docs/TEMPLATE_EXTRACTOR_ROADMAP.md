# Roadmap — inverse rendering + semantic template synthesis

**Goal.** Drop an existing video into the app and recover the editable *design intent* behind it —
layers, motion, timing, effects, style and placeholders — expressed in this engine's own parameters, so the
same edit can be replayed on a new set of media. The user's keyframe boundaries (regions marked on key
frames, each with a role) are the supervision signal. Deterministic code does the low-level measurement; the
AI/MCP layer turns those measurements into a reusable template.

Based on `docs/MENTOR_HANDOFF.md`, the earlier mentor's 12-sprint plan, and the code (2026-09-26, branch
`feature/timeline-trim-comp-duration`). **v2.** v1 of this doc narrowed the goal to "extract the concept"
and deferred measured motion — wrong; this version puts inverse rendering at the core. §12 maps the earlier
plan's sprints onto this one.

---

## 1. The loop

```
drop video.mp4
 1 ingest       Rust/ffmpeg  cuts · still vs footage · full-frame motion · fades · look · vignette · grain
 2 supervise    Claude proposes element boundaries + roles on key frames; the user corrects and adds
                (keep_motion · replace_text · replace_logo · keep_style · ignore)
 3 track & fit  Rust         each element tracked through the user's boundaries → transform per frame
                             → keyframes + easing; background re-fitted with elements masked out
 4 synthesize   TS           transitions, fonts, text animation: render candidates with the app's own engines
 5 build        Rust         rebuild_from_analysis → a Simple Effects project: one layer per element,
                             placeholders, keyframes, effects, transitions; roles → slots
 6 verify       TS           reconstruction_error: our render vs the reference, per frame and per element
                             → Claude fixes the worst (adds a missed boundary, re-fits, takes the runner-up)
 7 save         .sefx + manifest (slots, text roles, patterns, look targets, fidelity, gaps)
APPLY  open_template → fill slots with new media (cover) → match_look → rewrite text → export → audit
```

## 2. Why the template is a Simple Effects project

Inverse rendering needs a forward model: find parameters θ with render(θ) ≈ the video. The only renderer
whose output matters is the app's own — `evaluate()` in eval.rs, Preview.tsx, the transition engines, the
effect pipeline — so θ must be the app's own parameters: a `Project` (model.rs) with layers, spans, keyframe
tracks (`Keyframe { time_ms, value, easing }`), effects, transitions, text styles and `LetterAnimation`s.
That gives three things a separate schema can't:
- every recovered value is checked by re-rendering it, with a numeric error (the earlier plan's "render
  early, render often");
- the easing fitter uses the formulas the renderer evaluates (`ease()` in eval.rs: linear, u², 1−(1−u)²,
  smoothstep, hold), and the transition fitter renders through the same compositing path the app uses;
- the template opens on the timeline, so a human can correct it directly.

A parallel Python scene graph would need a second renderer and a translation step, and would drift.

## 3. Supervision: the user's keyframe boundaries

An **annotation** marks one element on one frame:

```ts
interface Annotation {
  id: string;
  elementId: string;   // several boundaries on different frames = one element's key poses
  frameMs: number;
  shape: { kind: "box" | "polygon"; points: [number, number][] };   // reference-frame pixels
  role: "keep_motion" | "replace_text" | "replace_logo" | "keep_style" | "ignore";
  label?: string;      // "product photo", "headline", "brand bar"
  by: "user" | "ai";   // AI proposals stay dashed until the user accepts them
}
```

| Role (earlier plan's vocabulary) | Becomes in the template | Typical elements |
|---|---|---|
| `keep_motion` | media slot — recovered motion kept, content replaced | photos, video panes, product cut-outs |
| `replace_text` | text slot — style, position, animation kept; copy replaced | headlines, captions, prices, CTAs |
| `replace_logo` | logo slot, expects a transparent PNG | the brand kit fills it at apply |
| `keep_style` | graphic recreated with engine primitives (`Shape2D`, plates, overlays) | bars, blocks, frames; unrecreatable art → gap |
| `ignore` | masked out of fitting and error | watermarks, platform UI |
| (unmarked) | the shot's background — a media slot | fitted with every marked element masked out |

How the boundaries supervise:
- **Tracking anchors.** Each element is tracked from its annotated frames by a rigid template tracker
  (similarity; the polygon is the mask). With two or more boundaries the track must pass through each one,
  which resets drift; where tracking confidence drops (heavy appearance change), the motion falls back to
  interpolating between the user's poses. More boundaries → more exact.
- **Key-time priors.** Frames the user chose to annotate are preferred keyframe times in the fit.
- **Layers.** Boundaries separate elements from the background, so rigid elements need no unsupervised
  decomposition.
- **Placeholders.** An element's placeholder is the temporal median of its aligned region (drops grain and
  passing overlays); the background's is the median with elements inpainted.
- **Error masks.** `ignore` regions and not-yet-recreated elements are excluded from reconstruction error.

Claude proposes the first set (`video_frames` on key frames → `annotate` with `by: "ai"`); the user accepts,
edits or adds in the annotation view. Over MCP the user can also just say "the centre photo is the product,
keep the blue bar, ignore the watermark".

## 4. What gets recovered, and how

| Element | Recovered as | Method | Limit |
|---|---|---|---|
| Cuts, spans | layer spans | ffmpeg scene scores | ±1 frame |
| Still-shot / background motion | x, y, scale, rotation keys + easing | similarity alignment to the widest frame; piecewise fit with the engine's easings | other editors' curves → nearest of 5 easings until bezier easing exists (Phase 8) |
| Element motion (photos, panes, logos, text blocks) | same, per element layer | template tracking through the user's boundaries | rigid only; perspective quads, non-rigid shapes → Phase 8 |
| Element visibility | span + opacity keys | region change energy + blend factor | — |
| Footage motion | punch-ins (single-frame scale steps) | alignment | smooth zoom/pan inside footage is ambiguous (camera vs digital) → flagged |
| Transitions | engine, direction, duration | synthesis over the registry through the app's compositing path | exact for references made here; nearest engine otherwise; seeded engines match timing, not pixels |
| Fades, dips | opacity keys | least-squares blend factor per frame | — |
| Grade | a target look per slot (Lab statistics), matched per new clip at apply | stats + synthesis through the engine's own filters | a grade can't be separated from the source's colours without the source; tints outside CSS filters → gap (no colour-matrix/LUT effect yet) |
| Vignette, grain | `vignette`, `filmgrain` params | radial profile; residual between aligned frames; calibrated on synthetic renders | — |
| Text | copy, role, font, size, colour, plate, position keys, letter preset + timing | Claude reads; measured; fonts by synthesis | font exact only if installed |
| Overlays (sparkle, flare, light wash) | GPU effects | Claude names them; opacity from residual | approximate |
| Blur-fill background, grids, split screens, masks, 3D | — | — | Phase 8 (blur-fill first — it's everywhere in reels) |
| Music | beat grid only | — | never reused |

## 5. MCP and where code runs

**One MCP server: the existing bridge.** All tools go into `TOOLS` in `src/agent/tools.ts`, so Claude
Desktop/Code and the in-app agent share them and the manifest can't drift. Measurement and tracking live in
Rust (`src-tauri/src/analyze/`): they ship in the installer and need no Python. Synthesis lives in the
WebView, the only renderer. A Python MCP server (FastMCP) is justified for one job — SAM 2 masks for
non-rigid elements (Phase 8) — and as a fallback if the Rust tracker misses its targets.

Keep each tool call under ~60 s (MCP clients enforce their own timeouts): split work per shot, per element
and per boundary.

| Family | Tools | Runs in |
|---|---|---|
| Measure | `analyze_reference`, `get_analysis`, `video_frames` | Rust + ffmpeg |
| Supervise | `annotate`, `list_annotations`, `delete_annotation` | TS (JSON beside the analysis) |
| Track & fit | `track_element`, `fit_background` | Rust |
| Synthesize | `fit_transition`, `fit_text`, `match_font`, `match_look` | TS |
| Build | `rebuild_from_analysis` | Rust (same pattern as the `create_*` template commands) |
| Verify | `reconstruction_error`, `compare_to_reference`, `audit_export` | TS + ffmpeg |
| Edit | the existing 25, plus `set_keyframe {easing}`, `add_effect`, `style_text`, `set_text`, `replace_media {fit}`, `rename_layer`, `list_fonts`, `media_sheet` | TS |
| Templates | `save_template`, `list_templates`, `open_template` | TS |
| Dev only | `make_synthetic_reference` (behind a dev flag) | TS |

Analysis artifacts live in `appLocalDataDir/refs/<hash(path, size, mtime)>/`: `analysis.json`,
`annotations.json`, tracks, placeholders. JSON files, no database.

## 6. Ground truth: references whose answer is known

The app renders its own edits, so it can manufacture references with exact answers.
`make_synthetic_reference { photosDir, seed, shots, elements }` builds a random project through the engine
API — spans 0.6–4 s; 2–4 transform keys per shot with random easing, scale 1.0–1.3, pans ±5 %, occasional
rotation and punch-ins; 0–3 floating elements per shot (smaller photos/logos moving over the background);
half hard cuts, half random registry transitions; fades; a random grade; sometimes vignette/grain; 0–3 texts
with random installed fonts, presets and plates — exports it and writes `truth.json` (the project) beside the
MP4. It also writes **synthetic annotations** from the truth: element boxes at a few key times, jittered, some
deliberately missing — supervision the way a hurried user gives it. Use real photos (HSI's own); alignment
needs texture.

`score_recovery(truth, recovered)` — a pure TS function under vitest — matches layers by role, time and
overlap and reports per-parameter errors. Every phase's "done when" is stated against it, and it lets the
coding agent iterate on its own: from Claude Code over the MCP bridge, generate → analyze → annotate → build
→ score.

---

## Phase 0 — Groundwork

**0.1 Commit first.** About 24 changed or untracked files (MCP bridge, style packs, shader fix) aren't
committed. The standing rule is to commit only when the human says so; ask for it before Phase 1 so each
phase lands as its own reviewable diff.

**0.2 Fix handoff §11.1 (content swap in exports) — gates every measured result.** A renderer that sometimes
draws the wrong slide corrupts both the synthetic ground truth and the reconstruction objective, and remakes
are exactly its trigger (many large photos, many clips). Follow the handoff's instrumentation plan, and log
these **unconfirmed leads** at a known-bad timestamp:
- `scratch(name, w, h)` in `src/lib/transitions/xform.ts` is a module-global canvas pool keyed by **name
  only**; an engine that reads a scratch canvas it didn't fully repaint this frame shows whatever was last
  drawn under that name — an earlier slide. Audit callers for clear-before-draw.
- No decode barrier before capture: `renderFrames` (App.tsx ~1000) waits two rAFs; `useImage`
  (Preview.tsx:203) sets its image on `onload`, and multi-MB JPEGs may still be decoding. Try
  `await img.decode()` for every image visible at t before capturing.
- Stale context: the bridge keeps the ctx from its first `startMcpBridge` call (`listening` guard in
  bridge.ts) and the Scenario panel builds one per run; their `commit → resolveImages` closes over an old
  `images` map and re-reads every image on every commit, one at a time. Read `images` through a ref.
- WebGL context loss: `renderGpuFx` (gpuFx.ts) and `glBlend` (transitions/gl.ts) reuse module-global
  canvases/textures, export uploads full-resolution textures (`maxTex = Infinity`), and nothing in `src/`
  handles `webglcontextlost`. Log it during a failing export.

**0.3 Agent plumbing for current models.**
- `providers.ts` `MODELS`: default `claude-opus-5`, plus `claude-sonnet-5` and `claude-haiku-4-5`
  (replacing `claude-opus-4-1` / `claude-sonnet-4-5`). Keep Opus as the default for extraction (vision plus
  long tool loops).
- Opus 5 and Sonnet 5 think by default, so replies carry `thinking` blocks. `AnthropicProvider` rebuilds
  assistant turns from text + tool_use only, and dropping thinking blocks risks ordering/signature 400s.
  Store the raw response `content` and send it back unchanged.
- `max_tokens` 4096 → 16000; top-level `cache_control: { type: "ephemeral" }` (every earlier image is resent
  each turn); retry 429/529 with backoff (or move to `@anthropic-ai/sdk` in browser mode, which retries).
- `ToolResult`: allow `text` and `image` together (`toMcp` in bridge.ts, the Anthropic `tool_result` content
  array, DeepSeek's text note).
- `orchestrator.ts`: every new read-only tool into `READONLY`; `maxCalls` per mode (extraction ~150).
- `mcp_bridge.rs`: raise `recv_timeout(120 s)` — a real `export_video` takes longer.

*Done when:* an in-app run on `claude-opus-5` completes without 400s, with `cache_read_input_tokens > 0` from
turn 2; `npm test` + `cargo test` green.

## Phase 1 — Engine prerequisites, ground truth, apply skeleton (~4–5 days)

**1.1 Engine changes.**
- Keyframe easing can't be chosen today: `edit_keyframes` → `upsert_key` (lib.rs ~930) always writes
  `EaseInOut`, and no API or UI changes it. Add an optional `easing`; expose it on `set_keyframe`; make
  eval.rs `ease()` `pub(crate)` for the fitter.
- `replace_layer_media`: add `fit` (cover = `max` instead of `min` in the rescale — today only image→image
  with an existing crop stays cover-filled, and video always letterboxes into a mismatched slot). After a
  replace, check every keyframe of the slot for revealed edges and scale up by the minimum that hides them.
- Generalize `apply_color` into `add_effect { layerId, kind, params }` over every `Effect::default_of` kind,
  validated — otherwise GPU effects are reachable only through a style pack.

**1.2** `extract_frames` (Rust/ffmpeg, `-ss` before `-i`) and `audit_export`: a frame every 250 ms, a 16×16
dHash each, compared with every image layer's source; flag frames whose best match isn't visible at that
time. Needed now to vet synthetic references against §11.1 (`// ponytail: dHash oracle, calibrate the
threshold on a known-bad export`).

**1.3** `make_synthetic_reference` + `score_recovery` (§6).

**1.4 Template = project.**
- Split `applyTextRecipe` / `fitText` out of `applyStylePack` (stylePacks.ts ~468–552); no behaviour change,
  `test/style-packs.test.ts` unchanged; plates named after their title (`Style · block · 12`) so they can be
  found again.
- `style_text` (TextRecipe + optional `animOut`, `x`/`y`), `set_text` (keeps style, re-fits its plates),
  `rename_layer`, `list_fonts { query? }`, `media_sheet` (shared `tileFrames` lifted from
  `renderContactSheet`, App.tsx ~1045).
- `save_template` / `list_templates` / `open_template`: reuse the checkpoint path (`checkpointPath` /
  `saveCheckpoint` / `restoreProjectFrom`, App.tsx ~1077–1112) with a `templates/` folder; manifest (§9) via
  `saveTextFile`; listing via `@tauri-apps/plugin-fs` (already a dependency — check its scope).
  `restoreProjectFrom` doesn't bind the open document, so a later Save can't overwrite the template.
- Export guard: `export_video` refuses while a slot still shows its placeholder or any media lives under
  `refs/`; `validate_timeline` reports the same, plus texts still equal to the reference copy.
- Apply prompt, also served to external clients as an MCP prompt: add `prompts` to the manifest built in
  `mcpManifest.ts` and `ListPrompts` / `GetPrompt` handlers in `mcp/simple-effects-mcp.mjs` (no Rust change —
  the bridge serves whatever manifest string it's handed).

**Walking skeleton:** the first template is a synthetic reference's own truth project — no extraction needed.
Apply it to a different photo set.

*Done when:* 20 audit-clean synthetic references; a truth template applied to new photos keeps every key,
reveals no edges and passes `audit_export`; both suites green.

## Phase 2 — Measurement core, Rust (~6–8 days)

`src-tauri/src/analyze/` (new module; `lib.rs` is already 5.8k lines). Reuse `find_ffmpeg` /
`quiet_command` as `pub(crate)` and the same "needs ffmpeg" error as MP4 export.

- **2.1 Decode.** ffmpeg `-f rawvideo` pipes, streamed — never the whole video in memory. 96 px gray for scene
  scores, 256 px for motion, 720 px only for placeholders. Refuse inputs over 180 s.
- **2.2 Shots.** `segment_cuts` (pure): hard cut = local max ≥ `HARD`; soft = ≥ 3 frames ≥ `SOFT` summing ≥
  `SOFT_SUM`, ≤ 1.5 s; cuts < 200 ms apart merge. Constants are calibration knobs tuned on ground truth.
- **2.3 Still vs footage.** Align consecutive frames with a similarity transform: low residual → a still under
  a keyframed transform; high → footage.
- **2.4 Full-frame motion.** Reference = the widest frame (smallest scale, so every other frame is a zoom-in).
  Per frame, a similarity transform from it by pyramidal inverse-compositional Lucas–Kanade on grayscale,
  initialized from the previous frame, Huber-weighted; skip transition windows. That transform *is* the
  layer's transform track, up to anchor/centre bookkeeping. `// ponytail: hand-rolled LK (~250 lines);
  Python/OpenCV fallback if targets are missed`.
- **2.5 Keyframe fit** (shared by background and elements). Shared key times across channels (how editors
  key); DP over ≤ 4 segments from curvature-peak candidates plus annotated frames as preferred times; cost =
  SSE + λ·keys, λ tuned on ground truth. Per segment and channel, choose the easing from `ease()` by least
  squares (values are linear once easing and times are fixed). Single-frame scale steps → `Hold` keys
  (punch-ins). Extrapolate to the span edges.
- **2.6 Fades.** Per frame, least-squares blend of the aligned reference frame toward black/white → opacity
  curve → same fitter.
- **2.7 Look.** Per-shot Lab mean/std; vignette = radial luminance profile averaged over aligned still frames;
  grain = residual std between consecutive aligned frames above the codec floor; both mapped to engine
  params by calibration tables rendered synthetically.
- **2.8 Placeholders.** Still → temporal median of the aligned 720 px frames, vignette divided out. Footage →
  the reference's own segment re-encoded at 720 px, so reconstruction error stays meaningful.
- **2.9 Tools.** `analyze_reference { path }` → analysisId + summary + overview sheet (a tile per shot: kind,
  span, motion glyph); `get_analysis`; `video_frames`.
- **Tests.** cargo tests per estimator: known warp → recovered within tolerance; known easing → recovered;
  synthetic score arrays → cuts.

*Done when* (20 synthetic references, no annotations): cuts ±1 frame ≥ 98 %; still/footage ≥ 95 %;
background scale ≤ 1 %, position ≤ 2 px at 1080 p, rotation ≤ 0.3°, key times ±2 frames, easing correct
≥ 80 %; fades ±2 frames; a 30 s reel analyzed in < 30 s.

## Phase 3 — Supervision and element tracking (~6–8 days)

- **3.1 Store + tools.** `annotate`, `list_annotations`, `delete_annotation` → `annotations.json` (§3).
- **3.2 Annotation view.** The reference in a `<video>` with a canvas overlay: scrub, draw a box or polygon,
  pick a role, add a label; pick an existing element to add another key boundary; AI proposals dashed with
  accept/reject. Nothing more — timeline editing stays in the editor.
- **3.3 `track_element { analysisId, elementId }`** (Rust): template tracking of the element's region
  (polygon as mask) forwards and backwards from each boundary, constrained to hit every user boundary;
  appearance window from region change energy; per-frame similarity transform + confidence; falls back to
  interpolating the user's poses where confidence drops. Then the Phase 2 fitter → element keyframes.
- **3.4 `fit_background { analysisId, shot }`.** Re-run the full-frame alignment with every element and
  `ignore` region masked out; background placeholder = median with elements inpainted (blur-fill).
- **3.5 Element placeholders.** Temporal median of each aligned region; polygon-masked PNG for cut-outs.

*Done when* (synthetic, with synthetic annotations): with 2 boundaries per element — scale ≤ 1 %,
position ≤ 2 px, key times ±2 frames; with 1 boundary still usable (≤ 2 %, ±4 frames); background accuracy
unchanged by the elements.

## Phase 4 — Synthesis, build, verify (~5–7 days)

- **4.1 Refactor.** Pull the pixel path of `drawTransitionFrame` (Preview.tsx ~332) into a pure
  `composeTransitionFrame(below, layer, factor, engine, direction, params, w, h)` used by the preview *and*
  the fitter. The app draws a layer transition as one real clip and one empty clip composited over whatever
  is below, with edge crossfades, driven by smoothstep-eased time (`resolve_transition_windows`, eval.rs).
  A fitter that called the engines directly as A→B would fit something the app never draws.
- **4.2 `fit_transition { analysisId, boundary }`.** Fix the window from the change-energy curve (±1 frame);
  search the registry's engines × directions at 128 px (A = last clean outgoing frame, B = first clean
  incoming); score = mean SSIM; return the top 3 with margins + a sheet (observed | best). ≤ 10 s per
  boundary; Claude's top-k families prune when available; hard cut and crossfade are always candidates.
- **4.3 `rebuild_from_analysis { analysisId, transitions }`** (Rust, one undo step, like the `create_*`
  commands): comp size/fps/duration; per shot the background slot and one layer per element, in z-order
  (Claude's call; default background < media < graphics < text); placeholders (stills cover-cropped so later
  replaces cover-fill); fitted keys with easing; opacity keys; vignette/grain; transitions from the fits
  (low-margin ones flagged in the layer name); `ignore` regions dropped; names `Slot 03 · <label>`.
- **4.4 `reconstruction_error { times? }`.** Render at 256 px (`renderFrames`) vs reference frames; SSIM per
  frame, per shot and per element region; masks `ignore` regions and not-yet-recreated elements; returns a
  table + a worst-moments sheet. `compare_to_reference` gives visual pairs.

*Done when* (synthetic): transition top-1 ≥ 80 %, top-3 ≥ 95 %, direction ≥ 95 %, duration ±2 frames;
rebuilt shots SSIM ≥ 0.90 at 256 px.

## Phase 5 — Text and graphics (~4–5 days)

For each `replace_text` element — Claude proposes and reads them from single frames (not tiles, so its pixel
coordinates map back 1:1; Opus 5 reads up to 2576 px):
- **`fit_text { analysisId, elementId }`:** entrance start and settle (region change energy), position/scale
  track (from 3.3), fill colour (dominant cluster), plate (uniform rectangle behind the text: colour, padding,
  radius), stroke/shadow hints.
- **Letter preset:** Claude classifies from a dense entrance sheet (5 presets); timing from `fit_text`
  (typewriter stagger = reveal time ÷ letters).
- **`match_font { analysisId, elementId, text }`:** render the copy in candidate installed fonts at the
  measured height, rank by binarized-mask IoU; Claude's style read (serif/sans/script/condensed, weight)
  prunes the list.
- **Assemble:** `add_text` → `style_text` (position, font, colours, plate, preset + timing) → `rename_layer`.

`keep_style` graphics: rectangles and bars → `Shape2D` driven by the element's track; anything else → gap.

*Done when* (synthetic): preset ≥ 80 %; start/settle ±2 frames; position ±1 % of frame; the true font in
the top 3 ≥ 80 %.

## Phase 6 — Semantic synthesis and apply (~3–4 days)

- **6.1 `TEMPLATE_EXTRACT_PROMPT`** (in-app, and MCP prompt `extract_template`): analyze → propose
  annotations → wait for the user's review → track/fit → `fit_transition` per soft boundary → rebuild →
  texts/graphics → `reconstruction_error` → fix the worst (add a missed boundary, re-fit, take the runner-up
  transition; ≤ 2 rounds) → write the design intent: slot content descriptions, text roles and constraints,
  **patterns** (repeated structure as rules: "each photo pushes in 1.0→1.12 easeOut", "captions enter 200 ms
  after their photo", "cuts every 500 ms"), gaps → `save_template`.
- **6.2 `match_look { layerId }`:** optimize brightness/contrast/saturate/hue on a 128 px copy of the new clip
  through the engine's own `buildFilter` until its Lab stats approach the slot's target (coordinate search,
  ~50 evaluations); write the effects. Runs for every filled slot.
- **6.3 Apply prompt:** `open_template` → `media_sheet` → assign media to slots → `replace_media` (cover) →
  `match_look` → `set_text` (copy from the brief, within each role's constraints) → brand kit into
  `replace_logo` slots → music → `validate_timeline` → `contact_sheet` → `export_video` → `audit_export`.
  Different media count → extend or shorten using `patterns`; never leave a placeholder.

*Done when:* 3 real references × HSI media — per-element fidelity reported, remakes audit-clean, applied
looks within ΔE ≤ 5 of target, human verdict "same edit, our content".

## Phase 7 — Drop-a-video UX (~2–3 days)

Drop a video on the app (or Templates → "Template from video…"): the automatic pass (Phase 2, transitions,
rebuild) runs with no API key and opens a first template with per-shot fidelity badges. "Supervise" opens the
annotation view with Claude's proposals; "Finish with Claude" runs 6.1. Dropping a folder of media onto an
open template runs apply. The Scenario panel gets the same two actions. The Claude passes need Anthropic
(DeepSeek can't see frames).

## Phase 8 — Only when measured

| Upgrade | Trigger |
|---|---|
| Bezier keyframe easing (`Easing::Bezier{x1,y1,x2,y2}`; the transitions library already has the math) | fit residuals dominated by easing shape — likely for CapCut / After Effects references |
| Colour-matrix / LUT effect | look match misses targets on tinted references |
| Blur-fill background layout (blurred cover copy under a contained photo) | first layout to add — everywhere in reels |
| Perspective quads (e.g. via FrameGrid vertices or decals) | annotated elements tilted in 3D |
| SAM 2 masks (Python MCP server) | non-rigid elements that polygons + rigid tracking can't follow |
| PiP/grid/split layouts, footage digital motion, speed ramps, blur over time | gaps cite them |
| Beat sync, retime, aspect re-flow | users need different music, length or aspect |
| Python/OpenCV fallback tracker | the Rust tracker misses Phase 2–3 targets |
| App as MCP client | a needed analyzer exists only as an external MCP server |

---

## 9. Manifest (v2)

```ts
interface TemplateManifest {
  version: 2;
  name: string;
  concept: string;           // one paragraph: the design intent in words
  analysisId: string;
  source: { file: string; durationMs: number; width: number; height: number; fps: number };
  slots: {
    layerId: number; elementId: string;
    role: "background" | "keep_motion" | "replace_logo";
    kind: "still" | "footage"; label: string; content: string; placeholder: string;
    lookTarget: { mean: [number, number, number]; std: [number, number, number] };   // Lab
    fidelity: number;         // reconstruction SSIM of this element
  }[];
  texts: { layerId: number; elementId: string; role: string; referenceCopy: string; maxWords: number; notes?: string }[];
  graphics: { layerId: number; elementId: string; label: string }[];
  patterns: string[];         // repeated structure as rules, used when the media count differs
  gaps: string[];
  createdAt: string;
}
```

Timing and keyframes live only in the `.sefx`.

## 10. Risks and guardrails

- **§11.1** corrupts ground truth and the objective until fixed; audit every synthetic reference.
- **Downloaded reels are re-encoded** (often 720 p, heavy compression) → tolerances; analysis runs at 256 px.
- **Engine vocabulary** (easing shapes, tints, layouts, kinetic type) → nearest fit + gap; `gaps` is the
  engine backlog.
- **Compute:** a 30 s reel → analysis < 30 s, ≤ 10 s per transition boundary, < 10 s per element track; every
  call < 60 s.
- **Cost:** images resent every turn → prompt caching (0.3); sheets ≤ 2576 px.
- **Privacy:** frames go to the model provider (BYO key); the bridge stays localhost-only.
- **Copying:** templates carry parameters, not assets. The export guard blocks reference pixels, reference
  audio is never imported, and copy is always rewritten.

## 11. PR sequence and size

1. 0.3 plumbing · 2. Phase 1 · 3. Phase 2 · 4. Phase 3 · 5. Phase 4 · 6. Phase 5 · 7. Phase 6 · 8. Phase 7.
§11.1 blocks the ground-truth numbers from PR 3 on. Each PR: `npm test` + `cargo test` green; commit only
on the human's say-so.

About **7 weeks of coding-agent time**. Every piece is bounded and scored against exact ground truth.

## 12. The earlier 12-sprint plan, mapped

| Sprint | Here | Difference and why |
|---|---|---|
| 0 Schema + renderer | §2: the app's `Project` + renderer | the template must be the renderer's own parameters to be verifiable |
| 1 Ingest | Phase 2.1–2.2 | ffmpeg in Rust, streamed; scene scores instead of PySceneDetect |
| 2 Annotations | §3, Phase 3.1–3.2 | same roles; JSON beside the analysis instead of FastAPI/SQLite; Claude proposes, the user corrects; also MCP tools |
| 3 Decomposition | Phase 3.3–3.5 | supervised by the boundaries: rigid tracking + masked background + aligned-median placeholders; PROVIDE/Omnimatte not needed; SAM 2 kept for non-rigid elements (Phase 8) |
| 4 Motion + easing fit | Phase 2.4–2.5, 3.3 | Lucas–Kanade instead of RAFT/CoTracker; easing fitted against the engine's own 5 curves; bezier easing when residuals demand it |
| 5 Style | Phase 2.7, 6.2 | Lab look targets + vignette/grain; a LUT needs an engine effect (Phase 8) |
| 6 Scene graph + naming | Phases 5–6 | Claude reads frames directly; fonts by synthesis instead of a classifier |
| 7 Synthesizer | Phase 4.3 | `rebuild_from_analysis` in Rust, one undo step |
| 8 MCP server | §5 | the existing bridge; FastMCP only for the optional Python server |
| 9 AI reasoning | Phase 6.1 | validated by re-rendering + reconstruction error (the earlier SSIM/LPIPS idea) |
| 10 Feedback | annotations + editing the template on the timeline | no corrections table |
| 11 Export (Lottie/AEP/SVG) | cut | the deliverable is the video; the template is a `.sefx` |
| 12 Eval + hardening | §6 | synthetic references with exact truth + 3 real reels; Celery/Redis/auth not needed on the desktop |
