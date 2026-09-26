# Mentor hand-off — Simple Effects

Written for: an AI mentor agent that will advise on feature development for this app,
with read access to this repo and its git history. This is not user-facing documentation —
it's an orientation dump so you don't have to rediscover the architecture from scratch.
Everything below was verified against the actual files as of **2026-09-26**, branch
`feature/timeline-trim-comp-duration`. Where I describe something as broken or unfinished,
I mean it literally — check the "Known issues" section before advising on anything that
touches rendering/export.

## 1. What this is

**Simple Effects** is a desktop video editor: Tauri 2 (Rust backend) + React 19 + Vite +
TypeScript + Konva (2D canvas) + raw WebGL2 (GPU shader effects), built for a lighting
company (HSI Lighting) to make short social videos (Instagram/TikTok-style) from photos,
video clips and audio. It's a from-scratch engine — no ffmpeg-based NLE framework, no
licensed effects library. Rendering, transitions, effects, keyframing, text shaping and
export are all hand-built.

There's also an **AI agent layer** bolted on: a tool-calling loop (Claude or DeepSeek) that
can drive the editor via a fixed set of MCP-shaped tools, either in-app (a "Scenario" panel
that turns a text prompt + selected media into a finished edit) or over a **localhost MCP
bridge** that exposes the same tools to Claude Desktop / VS Code / any external MCP client.

## 2. Get oriented fast

```
npm install               # first time
npm run dev                # vite dev server (frontend only, hot reload)
npm run tauri dev          # full app, dev build (slower to start, real Tauri)
npm run build               # tsc + vite build (frontend only)
npm test                    # vitest run — frontend tests (test/*.test.ts)
cd src-tauri && cargo test  # Rust tests + regenerates src/bindings/*.ts via ts-rs
npm run deploy               # release build -> silent NSIS install -> Desktop installer copy
```

`npm run deploy` runs `deploy.ps1`: bumps `build.json`'s build number, stamps
`src/buildInfo.ts`, kills any running `simple-effects.exe`, runs `npm run tauri build`,
silently installs the NSIS output, and refreshes `Simple Effects Setup.exe` on the Desktop.
The build number shows in the app's menu bar — useful for confirming a rebuild actually
took effect on the running instance.

**Rust ↔ TypeScript types are generated, not hand-written.** Every `#[derive(TS)]` struct
in `src-tauri/src/*.rs` gets a matching file in `src/bindings/*.ts` when you run
`cargo test` (ts-rs runs as part of the test harness, not a separate codegen step). If you
change a Rust model type and don't see it reflected in TypeScript, you forgot to run
`cargo test`. `#[serde(default)]`/back-compat helpers on model fields exist specifically so
old `.sefx` project files keep loading after a schema change.

## 3. Repo map

```
src-tauri/src/
  model.rs        (1582 lines) — the data model: Project, Layer, LayerKind, Transform,
                    Track (keyframes), Effect, Transition, TextStyle, Shape2D/3D, Decal…
  eval.rs         (1629 lines) — the evaluator: Project + t_ms -> Vec<ResolvedLayer>.
                    Pure, deterministic, no I/O. This is what both the live preview and
                    the export path call every frame.
  lib.rs          (5789 lines) — every #[tauri::command] (the whole backend API surface),
                    AppState, undo/redo snapshots, project save/load, media probing,
                    style/template backend logic (create_before_after, carousels, …).
                    This file is huge; grep for the command name, don't try to read it
                    linearly.
  mcp_bridge.rs   (82 lines)   — tiny_http listener on 127.0.0.1:8787 for the MCP bridge
                    (see §10).
  surface.rs, text.rs — 3D surface math (for decals/Shape3D) and text shaping.

src/
  App.tsx         (4651 lines) — top-level React state owner: the live `Project`, undo/redo,
                    checkpoints/autosave, export orchestration, menu wiring, the
                    `buildAgentCtx()` that both the in-app agent and the MCP bridge share.
  components/
    Preview.tsx   (3312 lines) — the Konva stage: turns ResolvedLayer[] into React-Konva
                    nodes every frame, plus the offscreen-canvas effect/transition
                    compositing (see §5–6). The single most important file for anything
                    rendering-related.
    Timeline.tsx, Inspector.tsx — the two other big editing surfaces (clip arrangement;
                    per-layer parameter editing incl. keyframe ◆ diamonds).
    ScenarioPanel.tsx — the in-app "AI Scenario" UI (prompt + media -> agent run).
    StylePacksDialog.tsx, TemplateDialog.tsx, MixedTemplateDialog.tsx,
    BeforeAfterDialog.tsx, VideoTemplateDialog.tsx — UI for the one-shot "template"
                    generators (see §9).
  lib/
    api.ts        (878 lines)  — every Tauri `invoke()` call, typed. This is the thin
                    client-side wrapper around lib.rs's commands; if you need to know a
                    command's exact JS signature, look here before grepping Rust.
    stylePacks.ts (576 lines)  — the 12 style packs + the one generic `applyStylePack()`
                    (see §8).
    effects.ts, gpuFx.ts, shinyClouds.ts — the effect-rendering pipeline (see §6).
    transitions/  — a large, independent transition-rendering library (25 files, dozens of
                    engines: wipes, 3D rotations, particle dissolves, glitch, camera moves…).
                    Has its own docs at docs/transitions/README.md. This is the "engine"
                    referenced by a layer's `transitionIn`/`transitionOut.engine` field.
    track.ts      — keyframe sampling helpers (`sampleTrack`, `constTrack`, …) shared by
                    frontend code that needs to read a Track without going through Rust.
    deterministicExport.ts — the frame-accurate WebCodecs capture path used by real export.
  agent/          — the AI tool-calling stack (see §10).
  shaders/        — 3 files: fullscreen.vert (shared), gpuOverlay.frag (10 procedural GPU
                    effects), shinyClouds.frag (1 legacy standalone effect, same family).
  bindings/       — generated, do not hand-edit (see §2).

docs/
  effects-reference/  — a **planning** doc from an earlier phase (kdenlive-informed catalog
                    of effects/transitions to build). Read `README.md` for provenance/
                    licensing notes (clean-room, no GPL code vendored). NOTE: it is
                    **stale** — `IMPLEMENTATION_PLAN.md` says "we have no transitions
                    today," which was true when written but the transitions engine now
                    has dozens of them (`src/lib/transitions/`). Treat the catalogs
                    (`effects-catalog.json`, `transitions-catalog.json`) as an idea
                    backlog, not a status report — cross-check against the actual
                    registries (`src/lib/transitions/registry.ts`,
                    `Effect::default_of` in model.rs) before telling anyone something
                    is "missing."
  transitions/README.md — accurate, current docs for `src/lib/transitions/`.
  INSTALL-macOS.md — end-user install guide.
  MENTOR_HANDOFF.md — this file.

test/               — vitest suite (agent-tools, agent-loop, style-packs, transitions).
                    Rust tests live inline in src-tauri/src/*.rs (`cargo test`).
mcp/                — the stdio MCP proxy for Claude Desktop/VS Code (see §10).
```

## 4. The data model

Everything lives in one `Project` (model.rs): `width`, `height`, `fps`, `durationMs`,
`media: Vec<String>` (imported asset paths), `layers: Vec<Layer>`.

A `Layer` has `id`, `name`, `startMs`/`endMs` (its span on the timeline — this is a flat
z-ordered stack, **not** multi-track; stacking order = array order, last = topmost),
`transform: Transform`, `effects: Vec<Effect>`, `transitionIn`/`transitionOut:
Option<Transition>`, `hidden`, `attach: Option<Decal>` (see §9's carousel/decal note), and
a `kind: LayerKind` enum: `Image`, `Video`, `Audio`, `Text`, `Shape2D`, `Shape3D`,
`Adjustment`, `Group`, `FrameGrid`.

**`Track<T>`** is the keyframe primitive: `{ keys: Vec<Keyframe<T>>, default: T }`, where
`Keyframe { time_ms, value, easing }`. Almost every animatable numeric field (transform
x/y/scale/rotation/opacity, effect params, shape style fields, text tracking/baseline…) is
a `Track<f32>` (or `Track<Rgba>` for colour). **Keyframe times are comp-absolute
milliseconds, not layer-relative.** This matters: moving a layer (`set_layer_range` /
`setLayerRange`) with the **same span** (pure move) shifts every keyframe on every track by
the same delta automatically (`for_each_track_mut` in lib.rs) — including inside `effects`,
`Shape3D` rotation, attached decals. A **trim** (span change) leaves keyframes where they
are. If you're scripting a layer move via the agent tools, `set_layer_time` with an
unchanged `endMs - startMs` is the safe "shift" operation; changing the span is a real trim.

`sampleTrack()` (Rust: inline in eval.rs; TS: `src/lib/track.ts`) interpolates a track at a
given `t_ms` with the keyframe's easing.

## 5. The render pipeline

This is the same pipeline for **live preview**, **`render_preview`/`contact_sheet`
(agent tools)**, and **real export** — they all call the same evaluator and draw through
the same React tree, just with different capture wrappers. There is **no headless
renderer**; the WebView canvas is the only renderer, always.

1. **`evaluate(&project, t_ms, …) -> Vec<ResolvedLayer>`** (eval.rs). Pure function: for
   every layer, samples its tracks at `t_ms`, resolves per-letter text animation
   (`eval_letters`), resolves transition factor (`resolve_transition_windows` — see §7),
   and sets `visible = !hidden && t_ms >= start_ms && t_ms <= end_ms && opacity > 0`.
   Layers **outside** their own window still get a `ResolvedLayer` entry but with
   `visible: false` — filtering happens on the frontend.
2. Frontend calls this via the `evaluate_at` Tauri command (`evaluateAt` in api.ts), which
   also assembles `letter_counts`/`text_dims`/`letter_lines` for text layers from
   `state.shaped` (populated by `text::shape`).
3. **`Preview.tsx`**'s top-level render does
   `project.layers.map(layer => renderLayer(layer, resolved[layer.id], true))` inside a
   single React-Konva `<Stage>`. `renderLayer` returns `null` when `!r.visible`; otherwise
   it picks a component by `layer.kind` (`ImageNode`/`EffectImageNode`/
   `TransitionImageNode` for images, `VideoNode`, `TextGlyphs`, `ShapeNode` for Shape3D,
   `Shape2DNode`, `DecalNode` when `r.surface` is set, `AdjustmentNode` for whole-comp
   effects, `GroupNode` recursing).
4. **Export** (`onExport` in App.tsx) either uses a deterministic WebCodecs frame-by-frame
   capture (`deterministicExport.ts` + `renderDeterministic`) or falls back to realtime
   `MediaRecorder` capture of the canvas if WebCodecs is unavailable. `renderPreviewAt`/
   `renderContactSheet` (used by the `render_preview`/`contact_sheet` agent tools) use a
   simpler loop, `renderFrames()` in App.tsx: `setTime` → `applyTime` (awaits
   `evaluate_at`, updates React state) → two `requestAnimationFrame` waits → `stage.draw()`
   → `stage.toCanvas()`.
5. `exporting` is a boolean prop threaded through Preview.tsx that hides editor-only
   chrome (selection handles, pasteboard dimming, comp-frame outline) and sets `maxTex =
   Infinity` (no preview-quality downscaling) during any of the above capture paths.

**Read `useCroppedImage`/`useImage` near the top of Preview.tsx (~line 200) if you're
investigating anything image-loading-related** — see §12, this is the prime suspect for
the open bug.

## 6. Effects

Two families, both attached to a layer's `effects: Vec<Effect>` list, or to a special
`Adjustment`-kind layer (whole-comp, composites over every layer beneath it in the stack):

- **CSS-filter effects** (`grayscale`, `brightness`, `contrast`, `saturate`, `blur`, `hue`,
  `invert`) and **wipe** (a directional alpha mask). Rendered via `buildFilter()` +
  `applyEffects()` in `src/lib/effects.ts`: draw the source into an offscreen 2D canvas
  through a CSS `filter` string, then mask for `wipe`. Cheap, CPU/2D-canvas only.
- **GPU shader effects** — one shared fragment shader, `src/shaders/gpuOverlay.frag`,
  selected by an integer `u_effect` index (0 shinyclouds-family... actually 0 is "Moving
  Shiny Clouds" inline in this same file; 1 caustics, 2 lensflare, 3 sparkle, 4 heat haze,
  5 film grain, 6 vignette, 7 shimmer, 8 aurora, 9 fog, 10 flap/3D-page-turn — indices also
  enumerated in `Effect::default_of` in model.rs). Rendered via `renderGpuFx()` in
  `src/lib/gpuFx.ts`, which owns **one lazily-created, module-global, reused WebGL2
  canvas+program** (mirrors the older single-purpose `shinyClouds.ts`/`shinyClouds.frag`,
  which predates gpuOverlay and still backs the "shinyclouds" effect kind specifically).

  Two render modes, both going through the same shader:
  - **Per-image** (`u_adjustment=0`): reads the layer's own texture, composites the effect
    over it, must preserve the source's own alpha (a transparent PNG layer — a logo, an
    overlay graphic — must stay transparent where it started transparent).
  - **Adjustment-layer / whole-comp** (`u_adjustment=1`): no input texture is meaningful:
    the effect emits a straight-alpha pattern that `AdjustmentNode` (Preview.tsx)
    composites over everything drawn below it via a canvas blend mode. Effects that
    fundamentally need real underlying pixels (heat haze, vignette, and — as of the
    2026-09-25 fix below — film grain) **must** early-return `vec4(0.0)` in this mode;
    they cannot function as a whole-comp overlay.
  - `gpuFxIsOverlay(effect)` in gpuFx.ts is the frontend-side gate for "is this effect
    kind even allowed on an Adjustment layer" — must stay in sync with the shader's own
    early-returns, or you get exactly the class of bug described in §11.2.

  **Fixed 2026-09-25**: two related shader bugs, both about alpha being hardcoded to
  `1.0` in the per-image and direct-effect output paths (`gpuOverlay.frag`,
  `shinyClouds.frag`) instead of reading the source texture's real alpha. Effects: (a)
  film grain applied via an Adjustment layer was reading a stale/foreign texture and
  stamping it out fully opaque (visible as image "ghosting"/doubling in style-pack test
  renders); (b) any GPU effect used as a per-clip **hero accent** on a transparent PNG
  layer (e.g. a logo) flattened its transparent background to opaque black. Root-caused
  and fixed by sampling `srcAlpha` once at the top of `main()` and using it instead of
  `1.0` in both output paths. Confirmed via direct pixel inspection, not just visual
  spot-check. **This fix is applied in the working tree but not yet git-committed** (see
  §12).

## 7. Transitions

Two layers of "transition," easy to conflate:

1. **Per-layer in/out** (`Layer.transitionIn`/`transitionOut: Option<Transition>` —
   `{ kind, durMs, direction, engine: Option<String>, params }`). This is what a normal
   edit actually uses: a layer optionally transitions in over its first `durMs` and/or out
   over its last `durMs`, blending with whatever's drawn below it in the stack (no
   separate "clip pair" concept — see `docs/transitions/README.md`'s rationale, still
   accurate). `resolve_transition_windows` in eval.rs computes the active factor (0 =
   fully transitioned out, 1 = fully present); when both an in and out window overlap it
   picks whichever is more-transitioned.
2. **The engine registry** (`src/lib/transitions/registry.ts` + 25 implementation files) —
   dozens of concrete visual engines (`fade`, `crossDissolve`, `push`, `slide`, `cover`,
   every wipe shape, zoom/pan/camera moves, 3D rotations, fold/page-turn, glitch/pixel/VHS
   family, particle dissolves...). A `Transition.engine` field names one of these by id.
   `drawTransitionFrame()` in Preview.tsx (~line 332) is where a layer's own resolved
   transition factor gets turned into pixels: it builds `A`/`B` clips (one real, one
   `empty`), calls `createTransition(engine, A, B, {...})`, and — for engines that don't
   land exactly on the resting frame (`meta.settles` false in `getTransitionMeta`) — does
   an edge crossfade so the hand-off from "mid-transition" to "at rest" doesn't visibly
   double the incoming content. **Important**: this function only ever reads **its own
   layer's** texture; it never looks at other layers, so a wrong-content bug can't
   originate here (already ruled out empirically, see §11.1).

## 8. Style packs

`src/lib/stylePacks.ts`: 12 named "looks" (Instagram Block, News Studio, Traveller's
Choice, Luxury Gold, Tech Neon, Minimal Clean, Retro Film, Real Estate, Food & Restaurant,
Sports Energy, Kids & Fun, Wedding & Romance), each pure data — palette, grade (CSS-filter
effects), optional hero-clip accent (a GPU effect), optional whole-video overlay, Ken Burns
motion params, a transition-engine family + duration, and a text recipe (font, color,
stroke/shadow/glow, anim-in preset, an optional color block or lower-third bar).

**One generic applier**, `applyStylePack(pack, io)`, drives it all through the existing
engine APIs — no per-pack code, no new engine logic:
1. Deletes any layers from a previous style application (tagged `"Style · "`-prefixed).
2. For every image/video clip (sorted by start): clears effects, adds the grade (+ accent
   on the first/last clip = "hero" shots), applies Ken Burns from the clip's natural
   contain-fit scale (skips clips already scaled down as a picture-in-picture), sets a
   transition-in cycling through the pack's engine family.
3. For every text layer: font/size/color/stroke/animation, plus the block/bar plates if
   the recipe has one (as separate `Shape2D` layers placed directly under the title,
   tagged `"Style · block"`/`"Style · accent"`).
4. If the pack has a whole-video overlay, **only the kinds that can actually composite on
   an Adjustment layer** go there (`gpuFxIsOverlay` — see §6); per-pixel-only kinds
   (filmgrain/vignette/heathaze) are instead added to every clip directly, exactly like
   the grade. This split was added 2026-09-25 as part of the alpha-bug fix — before that,
   several packs' vignette was **silently a no-op** (correctly guarded in the shader, but
   still being routed to the Adjustment layer where it had nothing to read) and no one had
   noticed. Cross-check `pack.overlay` against `DIRECT_FX` in stylePacks.ts before assuming
   an overlay effect is actually visible.

Style packs are exercised by both the Style Packs dialog (UI) and the agent's
`list_styles`/`apply_style` tools. `test/style-packs.test.ts` mocks the engine and checks
catalog validity, matching, and applier behaviour (including the direct-vs-adjustment
split) — read it for the expected contract before changing anything here.

## 9. Templates

A separate family of one-shot "build me a whole layer group" backend commands (lib.rs),
each with a thin api.ts wrapper: `createCylinderCarousel`, `createBoxCarousel`,
`createPhotoGrid`, `createGridCall`, `createSlideshowTemplate`, `createBeforeAfter`,
`createCarouselVideo`, `createMixedVideo`. UI: `TemplateDialog.tsx`,
`MixedTemplateDialog.tsx`, `BeforeAfterDialog.tsx`, `VideoTemplateDialog.tsx`.

Mechanically important: every one of these **appends** new layers to the *existing*
project (`base_id = max_layer_id(&project.layers); let mut next = base_id + 1; …`) rather
than replacing it, but **always anchors its own internal choreography at `start_ms = 0`**
regardless of where you actually want it in a longer timeline. To place a template block
elsewhere, capture its returned layer ids (diff before/after, same pattern as
`import_media`) and `set_layer_time` each one by the same delta — a pure span-preserving
move, which (per §4) correctly carries every internal keyframe (a carousel's rotation, a
before/after's wipe sweep) along with it. Verified working end-to-end.

`create_before_after`: two full-frame images (cover-cropped to the comp aspect), the
`after` on top with a `Wipe` effect whose `position` track sweeps 0→1, plus a thin
divider-bar `Shape2D` riding the seam only during the sweep.

`create_carousel_video`: a `Shape3D` cylinder (`rotation_y` keyframed to snap-rotate
between faces) with each image `attach`ed to it as a `Decal` (`{shapeId, face, u, v, scale,
rotation}`), plus a per-image bottom-right caption `Text` layer (defaults to the literal
string `"text here"` if you don't supply one — always pass real captions).

**As of 2026-09-25, these two tools were exposed to the AI agent for the first time**
(`create_before_after`, `create_carousel_video` in `src/agent/tools.ts`) — previously they
only existed as engine commands + UI dialogs, unreachable by the agent/MCP bridge. See
§11.1: this is also where the open rendering bug was first *discovered* (though it turned
out to be reproducible with plain slides too, not specific to these templates).

## 10. The AI agent stack

Two front doors, one shared tool registry and one shared execution context:

- **In-app**: `ScenarioPanel.tsx` — pick media + a provider/model + write a prompt →
  `src/agent/orchestrator.ts`'s `runAgent()` loop.
- **External**: the **MCP bridge** — `src-tauri/src/mcp_bridge.rs` runs a `tiny_http`
  listener on `127.0.0.1:8787` (localhost-only, opt-in via the `--mcp-bridge` CLI flag or a
  Templates-menu toggle persisted in `localStorage['sefx.mcpBridge']`). `GET /mcp/tools`
  serves the manifest (`src/agent/mcpManifest.ts`, built from the same `TOOLS` array);
  `POST /mcp/call` emits a Tauri event `mcp://call` that the frontend's one-time listener
  (`src/agent/bridge.ts`, `startMcpBridge()`) picks up, runs the matching tool handler
  against the **live app's actual project state**, and replies via the `mcp_bridge_reply`
  command. `mcp/simple-effects-mcp.mjs` is a stdio→HTTP proxy so Claude Desktop/VS Code can
  attach to the same bridge over MCP's stdio transport.

- **Tool registry**: `src/agent/tools.ts`, `TOOLS: ToolDef[]` — 25 tools as of this
  writing (`get_timeline, list_media, list_effects, list_transitions, set_composition,
  add_media_layer, add_text, set_layer_time, split_layer, delete_layer, set_transition,
  set_keyframe, set_speed, apply_color, set_audio, validate_timeline, render_preview,
  contact_sheet, export_video, create_before_after, create_carousel_video, list_styles,
  apply_style, import_media, history`). Each is `{ name, description, inputSchema
  (JSON-Schema), handler(args, ctx) }`. Handlers are thin, validated adapters over
  `src/lib/api.ts` — no engine logic lives in tools.ts itself.
  - `set_keyframe` and `export_video` were added 2026-09-25 — the former wraps
    `editKeyframes` (previously only used internally, e.g. by style packs' Ken Burns) so
    the agent can script custom multi-point animation (a punch-in-then-back-out zoom, not
    just apply_style's straight-line drift); the latter wraps the **existing** export
    pipeline (deterministic capture + ffmpeg) with a headless variant that takes an
    explicit output path and skips the save dialog. Before this, the bridge could only
    ever produce preview PNGs, never a real video file.
  - `get_timeline`'s per-layer summary now also reports `transitionInDurMs`/
    `transitionInDirection` (added alongside `set_keyframe`) so a script can read back
    what `apply_style` chose and preserve it (e.g. direction alternation) when overriding
    just the duration.
- **`AgentCtx`** (interface in tools.ts): `project()`, `commit(p)`, `media`, `addMedia`,
  `renderPreview`, `contactSheet`, `exportVideo`, `importMedia`, `checkpoint`, `restore`,
  `undo`, `redo`, `log`. Built by `buildAgentCtx()` in App.tsx — one implementation shared
  by both the in-app agent (fixed asset list) and the bridge (live media bin); `commit()`
  synchronously updates `projectRef.current` so tool handlers always read fresh state
  without waiting on a React re-render.
- **Providers**: `src/agent/providers.ts` — Anthropic and DeepSeek adapters behind one
  interface; `orchestrator.ts`'s loop is provider-agnostic (`AgentTurn` history is a
  neutral shape). Keys are BYO, stored in `localStorage` only, never embedded/shipped.
- **Safety rails already in place**: `apply_style` and the orchestrator's dry-run both
  checkpoint first (`before-style`/`before-agent`); `history` tool exposes
  checkpoint/restore/undo/redo to the agent itself; a 30s autosave writes to
  `appLocalDataDir/autosave.sefx` with restore-on-launch; the engine has 200-step undo
  independent of all of that.
- **Known gap, not yet built**: the in-app Scenario workflow has no reliable way to pick an
  **export output path** autonomously (it doesn't know the user's Desktop path the way
  `onAgentSaveToDesktop` does for `.sefx` saves) — `export_video` is currently only wired
  for externally-driven runs (a human/MCP client supplying an explicit path), not the
  autonomous in-app agent loop. `systemPrompt.ts` deliberately does **not** mention
  `export_video` yet for this reason.

## 11. Known issues — read this before advising on rendering/export work

### 11.1 Closed (2026-09-26): was never a renderer bug — duplicate source images + two checker blind spots

**Status: closed.** What looked like an intermittent content-swap in exported video was a
year-long false trail built on comparing rendered frames to *remembered* slide content
instead of the actual source file the active layer points at. There is no export-pipeline
defect; no fix was needed.

**What it actually was**, per the mentor's cross-check (SSIM against the real source
files) and independently reproduced here:
- `G:/CONTENT/CCT/images` holds every picture **twice** — a numbered PNG (`1st.png` …
  `6th.png`, `add1.png`, `add2.png`) plus a UUID-named JPG twin, all 8 confirmed by SSIM
  ≥ 0.84 (most ≥ 0.98): `1st`↔`8a4b77b3`, `2nd`↔`47acfd78`, `3rd`↔`84bfaeb5`,
  `4th`↔`ab32dce5`, `5th`↔`aec36e5c`, `6th`↔`b1945cb1`, `add1`↔`1b45bae5`,
  `add2`↔`c4a69991`. Several CCT builds use both twins of the same picture in different
  slots, so the "swap" was two spots correctly showing the *same* photo.
- The frame checker (`audit_export`, §0.2's Phase-0.2 work) has two other blind spots that
  produced the remaining suspects: a pure-black fade-in-from-black opening frame (any
  photo will score "far" from black), and mid-wipe-transition frames where two slides are
  genuinely, simultaneously visible side-by-side (comparing a split frame to either single
  source alone always scores badly).
- Re-checked `CCT Instagram Block.mp4`/`.sefx` (the un-versioned, presumably-delivered
  build) and `CCT Instagram Block v2.mp4`/`.sefx` the same way `audit_export` flags
  suspects, then classified every suspect against the *expected layer's source file and
  its twin*: every suspect in both exports falls into one of the three categories above.
  None is a genuine swap. See `docs/STATUS-phase0.2-checker.md` for the full frame-by-
  frame evidence and `src-tauri/src/analyze/mod.rs`'s `recheck_historical_exports` test.

**Practical implication for any feature work**: delivered CCT videos are almost certainly
fine — the "defect" was two duplicate source files, not a rendering error. Before
reusing `G:/CONTENT/CCT/images`, drop one copy of each of the 8 pairs above; Phase 1 adds
a duplicate-guard on media import (fingerprint-based) so this can't happen silently again.
The five defensive fixes made while chasing this (decode-before-capture, `imagesRef`,
`scratch()` self-clearing, WebGL context-loss handling) are being kept as general
hardening — each is correct on its own — just not attributed to "the §11.1 fix", since
there was no bug for them to fix.

### 11.2 Fixed this session (2026-09-25), see §6 for detail
GPU shader alpha hardcoded to `1.0` in two output paths (`gpuOverlay.frag`,
`shinyClouds.frag`), causing (a) film-grain-on-Adjustment-layer content corruption and
(b) transparent-PNG-layers-with-a-GPU-accent going opaque-black. Both root-caused and
fixed; `stylePacks.ts` also reworked to stop routing per-pixel-only effect kinds
(filmgrain/vignette/heathaze) to Adjustment layers, where they were silently inert.
Covered by `test/style-packs.test.ts`'s split-routing test.

## 12. Where things stand in git

Branch `feature/timeline-trim-comp-duration`. **Nothing from this session (or the
several before it, going back to before the MCP bridge existed) has been committed** —
`git status` shows ~19 modified files plus 5 new untracked files (`mcp_bridge.rs`,
`bridge.ts`, `StylePacksDialog.tsx`, `stylePacks.ts`, `style-packs.test.ts`). The most
recent actual commit (`baeccb9`, "Add scenario→video AI agent (Claude+DeepSeek); audio
fade; text auto-name") predates all of: the MCP bridge, style packs, the `set_keyframe`/
`export_video`/`create_before_after`/`create_carousel_video` agent tools, and the alpha
shader fix. **Commit only when the human operator explicitly says "commit"; push only
when explicitly asked** — this is a standing instruction from the human, not a suggestion.
`test/`, `src/agent/`, `src/lib/stylePacks.ts` and the shader files are all safe/expected
to already have working tests (253 frontend + 95 Rust as of the last full run) — run both
suites before proposing anything as "done."

## 13. Conventions worth knowing

- Frontend tests: `test/*.test.ts` (vitest). Style packs and agent tools use a hand-rolled
  in-memory fake of `src/lib/api.ts` (`vi.hoisted` + `vi.mock`) rather than a real Tauri
  backend — fast, but means Rust-side regressions won't show up there; always also run
  `cargo test`.
- CRLF vs LF churn: this repo has mixed line endings from Windows editing; when diffing,
  use `git diff --ignore-cr-at-eol --numstat` to separate real changes from line-ending
  noise before deciding what to stage.
- The app has no LICENSE file yet (noted in `docs/effects-reference/README.md`) — worth
  flagging if any feature work starts pulling in third-party assets/code.
- Never embed or ship API keys; all provider keys are BYO via `localStorage`. The MCP
  bridge is localhost-only and opt-in by design — don't suggest exposing it more broadly
  without that being an explicit, deliberate decision.
