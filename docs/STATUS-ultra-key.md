# Status — Ultra Key

Date: 2026-11-18. Prompt: `docs/PROMPT-ultra-key-kilo.md`. Build contract:
`docs/MENTOR-NOTE-ultra-key.md` (§13 WP1/WP2). Reference: `docs/ultra-key-reference.mjs`.

All changes are uncommitted in the working tree.

## Step 1 — WP1 GPU pass chain + WP2 loud GPU failure

### Files changed

- `src/lib/gpuFx.ts` — now owns the single shared WebGL2 context for every GPU
  effect: a fragment-source-keyed program cache, a size-keyed RGBA8
  texture/framebuffer pool (bilinear filtering, so existing shaders keep their
  look), the fullscreen quad, `runPasses(input, w, h, passes)` (one upload →
  ping-pong passes → one draw to the canvas), typed
  `GpuResult`/`GpuFailureError`, the module-level last-failure record
  (`gpuFailurePeek`/`takeGpuFailure`), cumulative counters, `gpuHealthCheck`
  (compiles every registered shader and renders one 4×4 probe frame through
  each), and a dev-only `loseGpuContextForTest` + `window.__sefxGpu` bridge.
- `src/lib/shinyClouds.ts` — removed its private WebGL context; the shine is now
  a `GpuPass` (`shinePass`) on the shared chain, and `renderShine` returns the
  typed result.
- `src/lib/effects.ts` — added `gpuRuns` (runs of consecutive GPU effects) and
  `applyGpuRun` (one chain per run, so a run costs one upload/one readback);
  `applyEffects` takes an optional failure callback, times the GPU part into
  `lastApplyEffectsStats()` (no per-frame log), and keeps it available for a
  later aggregated timer. On failure the unprocessed layer pixels stay in `off`;
  a dead GL canvas is never drawn.
- `src/shaders/gpuOverlay.frag` — back to HEAD's `texture()` sampling (see
  Step 1 fixes); the only diff from HEAD is the adjustment-mode `srcAlpha` line.
- `src/shaders/shinyClouds.frag` — unchanged from HEAD after the fixes.
- `src/components/Preview.tsx` — draws a small red "GPU effect failed" chip on
  the layer when its GPU run fails (image, video, transition and adjustment
  paths). `badgesSuppressed` is set from the `exporting` prop so an export frame
  can never capture the chip.
- `src/App.tsx` — `projectUsesGpu` (recurses groups; checks frame-grid cell and
  linked stacks); a GPU health gate before an export that contains GPU effects;
  a `takeGpuFailure()` check after every deterministic frame and throughout the
  realtime capture, thrown as `GpuFailureError`; GPU failures skip both the
  realtime fallback prompt and the H.264→VP9 encoder retry.
- `test/gpu-chain.test.ts` — new; 13 tests with a scripted fake WebGL2 context.

### Tests added

`test/gpu-chain.test.ts`:

- no WebGL2 → `runPasses`/`renderGpuFx` return `{ ok: false }` and record a
  failure; `takeGpuFailure` clears it once;
- a shader compile failure is a typed failure naming the pass;
- after `WEBGL_lose_context`, the chain fails instead of returning a canvas;
- `GpuFailureError`/`isGpuFailure` are detectable by the export catch;
- a 3-pass chain reports 1 upload, 1 readback, 3 passes;
- a second identical frame reuses the texture/FBO pool and program cache
  (0 new allocations, 0 new links);
- a 3-pass chain leaves each pooled texture exactly once, so the next chain can
  never sample its own render target (the duplicate-release regression);
- `gpuHealthCheck` links every registered program and renders a probe frame
  through each; it fails loudly with no context;
- `gpuRuns` groups consecutive GPU effects and splits at a non-GPU effect;
- a `[gpu, gpu, blur, gpu]` stack in `applyEffects` costs 2 uploads / 2
  readbacks / 3 passes;
- a failing GPU run keeps the layer drawable (returns `off`) and reports through
  the callback.

### Checks

Red (test written first, before the APIs existed):

```
 Test Files  1 failed (1)
      Tests  12 failed (12)
TypeError: resetGpuFx is not a function
```

Green (all after the implementation, final run):

- `npm test`:
  `Test Files  16 passed (16)` · `Tests  336 passed (336)` (baseline before this
  step: 15 files / 323 tests; 336 includes the pool regression added in the
  fixes round).
- `npx tsc --noEmit`: no output, exit 0.
- `cargo test` (inside `src-tauri/`, also regenerates the bindings; no binding
  diff):
  `test result: ok. 269 passed; 0 failed; 7 ignored; 0 measured; 0 filtered out; finished in 5.03s`
  plus the two 0-test targets. Only the pre-existing ts-rs "failed to parse serde
  attribute" warnings.
- `node docs/ultra-key-reference.mjs`:
  `key colour -> [ 174, 174, 174, 0 ]  skin -> [ 225, 170, 140, 255 ]  grey -> [ 128, 128, 128, 255 ]  50% edge -> [ 202, 181, 134, 207 ]`
  / `self-check done`, exit 0.

### Live app checks (§5)

Method: `npm run dev` (Vite, port 1420) + `src-tauri/target/debug/simple-effects.exe
--mcp-bridge` with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`,
driven over CDP. The project was built over the MCP tools: 480×360 @ 30 fps,
8 s, one image layer (`testsrc2`) with two consecutive `caustics` GPU overlays.

WP1 — chain correctness (in-page, 64×32 RGBA canvas, all channel samples):

| Check | Result |
|---|---|
| 1-pass copy vs the source bytes | max Δ 0, mean 0 (6144 samples) |
| 2-pass copy→invert vs 1-pass invert | max Δ 0, mean 0 |
| 3-pass copy→copy→invert vs 1-pass invert | max Δ 0, mean 0 |
| `applyEffects([gpu, gpu])` | 1 upload · 1 readback · 2 passes; 4.1 ms (64×32, program already linked) |
| `applyEffects([gpu, blur, gpu])` | 2 uploads · 2 readbacks · 2 passes; 2.9 ms |

WP1 — preview vs export, same two-caustics layer at t = 1.0 s, full 480×360:
the editor's per-layer renderer (`applyEffects` on the source image) and the
export-mode `render_preview` frame differ by **max Δ 0 / mean 0 over 518 400 RGB
samples** (1 upload, 1 readback, 2 passes, 1.3 ms). The live counters for that
render report one upload/readback and two passes; the timing remains available
through `lastApplyEffectsStats()`.

A VP9 YUV 4:2:0 encode of the same frame differs from the preview PNG by mean
2.5028/255, p99 22/255, max 75/255 — that is the codec/chroma-subsampling floor,
not the pass chain (the pre-encode export frame above is exact).

WP2 — forced context loss mid-export: after the export reached
`rendering-frames` (219 ms), `WEBGL_lose_context` was forced on the live
context. The MCP `export_video` call returned in 276 ms with:

```
{"content":[{"type":"text","text":"export failed: Export stopped: GPU effect failed — GPU context lost"}],"isError":true}
```

No output file was created. Afterwards the app was idle again
(`.app` class `app`, button `⤓ Export`), `get_timeline` still answered, and the
cumulative counters at the abort were 637 chains / 637 uploads / 637 readbacks /
1268 passes (they include the preview draws since the page loaded).

WP2 — preview badge: forcing the loss and immediately redrawing the stage in
the same task drew the layer's unprocessed pixels plus the red
"GPU effect failed" chip at its top-left (captured from the live stage canvas).

### Step 1 fixes (review round)

Requested fixes:

- Restored bilinear sampling for the shipped effects. `acquireTex` now sets
  `TEXTURE_MIN_FILTER`/`TEXTURE_MAG_FILTER` to `LINEAR`. `texelFetch` ignores the
  filter, so a future keyer pass is still exact.
- Reverted `gpuOverlay.frag` and `shinyClouds.frag` to HEAD's sampling. The
  `gpuOverlay.frag` diff is now exactly one line:
  `float srcAlpha = (u_adjustment == 1) ? 1.0 : texture(u_inputImage, uv).a;`
  (adjustment mode no longer reads the 1×1 placeholder); `shinyClouds.frag` has
  no diff from HEAD.
- `gpuFx.ts`'s header comment now describes the shipped chain: one upload, one
  readback, bilinear pooled targets, blending off, with `texelFetch` left
  available for exact passes.
- Removed the per-call `console.debug` from `applyEffects`. The counters and
  `lastApplyEffectsStats()` remain; WP9 owns the aggregated timer.

One real bug surfaced while re-running the live checks and was fixed here:

- The chain released its input texture **on every pass** (`inputLastUse <= i`
  instead of `=== i`), so a 3-pass chain pushed the same texture into the pool
  three times. A later chain could then get that texture as both its source and
  its render target, producing a genuine WebGL feedback error
  (`GPU error 0x502 … src 7, dst 7`). Fix: release the input only at its last
  use, and make `releaseTex` idempotent with a `released` flag reset on acquire.
  Added a regression test (3-pass chain → pool has exactly 2 unique textures →
  next chain succeeds). This bug was latent in the original Step 1 submission;
  the fake-GL tests could not see the feedback itself, only the counters.

Checks after the fixes:

- `git diff src/shaders/`: 1 file changed, 1 insertion, 1 deletion (the
  `srcAlpha` line above); `shinyClouds.frag` has no diff.
- `npm test`: `16 passed`, `336 passed` (was 335; +1 pool regression).
- `npx tsc --noEmit`: no output, exit 0.
- `cargo test` inside `src-tauri/`: `269 passed; 0 failed; 7 ignored` (plus the
  two 0-test targets); no binding diff.
- `node docs/ultra-key-reference.mjs`: `50% edge -> [ 202, 181, 134, 207 ]` /
  `self-check done`, exit 0.
- Live 1/2/3-pass checks with the restored bilinear shaders (measured through the
  app's own bridge, 64×32): copy vs source **max Δ 0**, 2-pass copy→invert vs
  1-pass invert **max Δ 0**, 3-pass copy→copy→invert **max Δ 0**.
  `applyEffects([gpu, gpu])` = 1 upload / 1 readback / 2 passes (4.1 ms);
  `[gpu, blur, gpu]` = 2/2/2 (2.9 ms).
- Live preview vs export (480×360, two caustics, t = 1 s): editor renderer vs
  export-mode frame **max Δ 0 / mean 0 over 518 400 RGB samples**, 1 upload /
  1 readback / 2 passes, 1.3 ms. The VP9-encoded frame still differs by mean
  2.50/255 — expected codec error, not compared as the export bar.
- Live context loss mid-export still aborts: `export failed: Export stopped:
  GPU effect failed — GPU context lost` (reached rendering at 219 ms, call
  returned at 276 ms), no output file, app back to idle.
- Badge lifecycle: after forcing the loss and drawing, the chip appeared (image
  captured); after the lost-context event reset the cache, the next draw
  rendered the caustics again (1 chain / 1 upload / 1 readback / 2 passes) and
  the chip was gone. The failure record stays sticky until an export consumes it
  after its health check; the chip itself is drawn only on a failing draw.

### Where the note's references are now

| Note reference | Actual location now |
|---|---|
| `gpuFx.ts:51-56` (silent skip on unavailable WebGL / lost context) | `gpuFx.ts:172` init failure paths, `gpuFx.ts:192` `webglcontextlost` handler, `gpuFx.ts:356` `runPasses` typed result |
| `effects.ts:149-151` (draws a dead GL canvas) | `effects.ts:163` `applyGpuRun` — failure leaves `off` untouched and reports |
| `effects.ts:175-184` (`applyEffects` by category) | `effects.ts:187` `applyEffects`; GPU runs at `effects.ts:211` (still last, as before — WP3 changes the order) |
| `gpuFx.ts` single-pass context | program cache/pool at `gpuFx.ts:275`+, chain at `gpuFx.ts:356` |
| `gpuFx.ts:51-56` context loss | listener `gpuFx.ts:192`; post-draw `isContextLost` check `gpuFx.ts:363` |
| Preview per-layer effect draws | `Preview.tsx:375` (image), `Preview.tsx:417` (transition), `Preview.tsx:1344` (video), `Preview.tsx:2600` (adjustment overlay) |
| Badge | `Preview.tsx:61/64`, used at `Preview.tsx:378/485/1347/2600` |
| Export pipeline | `App.tsx:3085` `onExport`; health gate `App.tsx:3152`; per-frame abort `App.tsx:3465`; realtime abort `App.tsx:3332` |

`test/setup.ts` still has no WebGL; the new tests install their own scripted
fake context.

### Differences from the note / decisions

- The note asks for WP1 in `gpuFx.ts` without adding a context. Routing Shiny
  Clouds through the same chain was necessary to share an upload/readback
  between *consecutive* GPU effects of either kind; that removes its private
  context rather than adding one.
- `gpuHealthCheck` runs only when the project contains a GPU effect
  (`projectUsesGpu`). A project with no GPU effects must still export on a
  machine without WebGL2.
- The health check and per-frame guard are wired for the realtime capture path
  too, and a GPU failure never offers the "use realtime capture" fallback (that
  path would render the effect missing).
- Shader sampling: the first draft switched every source read to
  `texelFetch`/NEAREST; that was reverted in the fixes round (see Step 1
  fixes). Pooled targets use LINEAR so Heat Haze and Flap keep their bilinear
  displaced reads, and a future keyer can still use `texelFetch`, which ignores
  the filter.
- Consecutive GPU effects now execute in stack order within the GPU phase.
  Before, all shines ran before all overlays. This is not the full WP3 change
  (CSS filters still run before GPU effects); it only makes the shared-chain
  order the stack order.
- Dev-only `window.__sefxGpu` and `window.__sefxFx` bridges were added: after
  Vite HMR, `await import('/src/lib/gpuFx.ts')` can resolve to a second module
  instance, so the CDP check must reach the live one. They are compiled out of
  production (`import.meta.env.DEV`).

### Resolved questions (review round)

- Export bar: compare the frame handed to the encoder (pre-encode), as done
  here. The codec error is expected; no lossless path is required. The note's
  acceptance test now says this.
- Badge: fixed text, no dismiss. Confirmed it disappears once the effect renders
  again (see the fixes subsection).
- Preview context loss: silent recovery is intended; only an export aborts.
- The per-frame `console.debug` timer was removed; `lastApplyEffectsStats()`
  remains for WP9's aggregated timer.

## Step 2 - WP4 phase 1 (Ultra Key key pass + Inspector) + WP11 items 2-3

Prompt step 2: "WP4 phase 1 (Key pass, Composite output, presets, Inspector). Start
WP11 (items 2 and 3)." All changes remain uncommitted.

### Files changed

- `src-tauri/src/model.rs` - `Effect::UltraKey` with 16 `Track`s (13 keying
  sliders + Saturation/Hue/Luminance), `keyColor` (default black), `output`
  (default Composite) and `setting` (default 0); `default_of("ultrakey")` uses the
  Default preset values; exported `ULTRA_KEY_TRACK_NAMES` / `ULTRA_KEY_DEFAULTS`.
- `src-tauri/src/eval.rs` - `ResolvedEffect::UltraKey` and its `resolve_effect`
  arm (samples all 16 tracks at the playhead).
- `src-tauri/src/lib.rs` - 16 `effect_track_mut` arms, 16 in
  `walk_effect_tracks`, `set_ultrakey_static` / `set_cell_ultrakey_static`,
  `apply_ultrakey_preset` / `apply_cell_ultrakey_preset`, the
  `mark_ultrakey_custom` edit rule, and 5 Rust unit tests.
- `src/bindings/Effect.ts`, `src/bindings/ResolvedEffect.ts` - regenerated
  (`keyColor`, `midPoint`, `output`, `setting`).
- `src/shaders/ultraKey.frag` - the Premiere Ultra Key composite pass: sRGB EOTF,
  linear keying space, chromaticity angle/distance alpha with tolerance, chroma +
  luma un-mix, physical spill un-mix, colour correction, sRGB OETF with the
  reference's trunc rounding. Black key (`kZ < 1e-6`) skips the key maths and
  applies CC only.
- `src/lib/ultraKey.ts` - preset tables, the `colorMatrix` port, uniform
  precompute (`ku/kv/kZ/invK`, gains, 2x thresholds, packed column-major CC), the
  `GpuPass` builder, and the dev-only 32x32 check-frame renderer.
- `src/lib/effects.ts` - Ultra Key joins the GPU run grouping and pass builder,
  so it shares the one-upload/one-readback chain with the other GPU effects.
- `src/lib/api.ts`, `src/components/Inspector.tsx`, `src/components/EffectEditor.tsx` -
  the 16 param names, the Ultra Key row (Setting / Key Colour / Output + the four
  collapsible Premiere groups) and preset switching (the Custom snapshot moved
  into the model in the review round).
- `src/App.tsx`, `src/components/Timeline.tsx` - layer and cell handlers, preset
  handlers, timeline keyframe markers for all 16 tracks.
- `src/agent/tools.ts` - `list_effects` gains `ultrakey` (16 keyable params) and
  `add_effect` accepts `keyColor`, `output`, `setting`; the header no longer lists
  chroma as missing.
- `EFFECTS_LIBRARY.md` Part 2 row; `docs/effects-reference/effects-catalog.json`
  `chroma_key` status `gap` -> `done`.
- `docs/ultra-key-shader-check.mjs` - the WP11 live shader check (new).
- `test/ultra-key.test.ts` - 13 vitest tests (new).

### Tests added

`test/ultra-key.test.ts` (vitest, imports the oracle directly):

- preset tables equal `PRESETS.default/relaxed/aggressive` verbatim;
- Setting -> values, Custom -> none;
- the Custom-flip rule: only the 13 preset sliders, only when moved off the
  registered default;
- `ultraKeyTrackValues` 13 values in preset order;
- `ultraKeyColorMatrix` equals the oracle for four parameter sets;
- uniform precompute equals the reference's gain/key-space formulas
  (green key), identity CC at defaults, the 1e30 gain clamp, and 2x thresholds;
- CC is packed **column-major** with offsets `CC[12..14]` (the oracle's
  indexing) - this is the fix for the live CC failure described below.

Rust (`cargo test`, +5): default preset/black key; preset writes unkeyed tracks as
constants and sets Setting; preset on a keyed track inserts a key at the playhead;
editing a preset slider flips Custom (and CC sliders do not); the preset writer
rejects wrong value counts and non-Ultra-Key effects.

### Checks

Red (test written first):

```
 Test Files  1 failed (1)
      Tests  no tests
Error: Cannot find module '../src/lib/ultraKey' imported from
G:/Workspace/Simple_Effects/Simple_Effects/test/ultra-key.test.ts
```

Green (final):

- `npm test`: `Test Files 17 passed (17)` / `Tests 349 passed (349)` (Step 1
  ended at 336; +13).
- `npx tsc --noEmit`: no output, exit 0.
- `cargo test` inside `src-tauri/`: `274 passed; 0 failed; 7 ignored` (baseline
  269 + 5).
- `node docs/ultra-key-reference.mjs`: `50% edge -> [ 202, 181, 134, 207 ]` /
  `self-check done`, exit 0.
- `node docs/ultra-key-shader-check.mjs` against the live app: **both cases
  0.000 mean / 0 p99 / 0 max on R, G, B and alpha** - the real shader and the
  oracle are byte-identical on the fixture (limits 2 mean, 8 alpha p99).

### WP11 item 3 - live shader check

`docs/ultra-key-shader-check.mjs` connects to the WebView2 debug port, calls
`window.__sefxUltraKey.check(...)`, receives the fixed 32x32 sRGB frame and the
shader's `readPixels` bytes, computes the oracle with
`docs/ultra-key-reference.mjs`, flips the bottom-up readback, and compares all
four channels. Two cases:

| Case | r mean/p99 | g mean/p99 | b mean/p99 | a mean/p99 |
|---|---|---|---|---|
| Default preset, key #28c83c | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Same + Saturation 150, Hue 30, Luminance 120 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |

`readPixels` is used instead of a 2D canvas because a 2D canvas premultiplies
and destroys RGB where alpha is 0; the fixture includes a fully keyed green
region, a straight-alpha skin block (alpha 128), a 50% green/skin edge, neutral
grey, white and black.

The second case paid off: the first CC packing used row-major indices and the
live check failed with mean 68/32/79 and a blue-cast grey. The oracle's CC is
**column-major** (`outR = r*CC0 + g*CC4 + b*CC8 + CC12`) - with the packing
fixed, both cases are exact. The vitest now locks the column-major packing.

One intentional shader epsilon: in float32, a pixel equal to the key still has
~1e-8 of luma error, which the 1/screen un-mix amplifies to white. The shader
snaps `abs(dz) < 1e-6` linear luma to 0 so the keyed pixel's RGB (174 grey at
alpha 0) matches the oracle; 1e-6 linear luma is invisible.

### WP4 phase 1 - live app checks

Project: 480x360 @ 30 fps, 2 s, a synthetic green-screen PNG (#28c83c field,
skin rectangle, grey patch), one image layer, one `ultrakey` effect with
`keyColor: "#28c83c"` added over MCP `add_effect` (which also exercised the new
agent path).

- `render_preview` before the effect shows the green field; after the effect the
  field is removed and the skin/grey subject remains. An exported 2 s WebM
  (VP9, quality 1) contains the keyed frame (extracted at 0.5 s and inspected).
- Inspector (live DOM): the effect row shows `Setting` (Default/Relaxed/
  Aggressive/Custom), `Key Colour` `#28c83c`, `Output` (Composite), and the four
  collapsible groups `Matte Generation`, `Matte Cleanup`, `Spill Suppression`,
  `Color Correction` with the 16 sliders in Premiere's order.
- Preset flow (live DOM): Setting -> Relaxed writes 50 to Transparency (45 in
  Default); editing Transparency to 60 flips Setting to Custom (3); Setting ->
  Default returns 45; Setting -> Custom restores 60.
- Agent: `list_effects` returns the `ultrakey` kind with all 16 params/ranges;
  `add_effect` with `keyColor`/`setting` succeeds.
- The export completed normally. The pre-export GPU health check did **not**
  run for that project: `projectUsesGpu` counted only `gpuoverlay` and
  `shinyclouds`, and this project's only effect is `ultrakey`. Fixed in the
  review round below; a project like that now runs the gate.

### Step 2 fixes (review round)

Review found the shader correct; the fixes below change the GPU gate, the
Custom snapshot, the live shader check, and the add-effect menus. The shader
maths is unchanged apart from the alpha rounding in fix 3.

#### Files changed

- `src/lib/effects.ts` — exports `isGpuEffect(kind)` (the one GPU-kind
  predicate); `gpuRuns` uses it. `projectUsesGpu` moved here from `App.tsx` so
  vitest can import it; it recurses groups and checks frame-grid cells and
  linked groups.
- `src/App.tsx` — imports `projectUsesGpu` from `src/lib/effects`; the local
  `gpuoverlay`/`shinyclouds`-only copy is deleted.
- `test/gpu-health.test.ts` — new; 4 tests.
- `src-tauri/src/model.rs` — `Effect::UltraKey.custom: Vec<f32>` with
  `#[serde(default)]`; `default_of("ultrakey")` starts it empty.
- `src-tauri/src/eval.rs` — the `resolve_effect` arm ignores `custom` (`..`).
- `src-tauri/src/lib.rs` — `ultrakey_track_values_at` samples the 13 sliders;
  `set_ultrakey_track_values` writes them (shared by both preset commands);
  `write_ultrakey_values` now snapshots the current sliders into `custom` when
  leaving Custom and restores that snapshot (or leaves the sliders alone when
  it is empty) when choosing Custom. Both `apply_ultrakey_preset` and
  `apply_cell_ultrakey_preset` run through it, so the snapshot is per effect
  instance. One Step 2 test
  (`preset_on_a_keyed_track_writes_a_key_at_the_playhead`) was updated from
  setting 3 to setting 2: setting 3 now restores Custom, so writing a passed
  table there is no longer its meaning. +3 tests.
- `src/bindings/Effect.ts` — regenerated; the Ultra Key variant now carries
  `custom: Array<number>`.
- `src/components/Inspector.tsx` — deleted the `ultraKeyCustom` ref and its
  uses; `pickSetting` sends the preset table for Default/Relaxed/Aggressive
  and no table for Custom (the backend restores the persisted snapshot).
  `EffectsSection` takes `excludeKinds`; adjustment layers pass
  `["ultrakey"]`. `LinkedEffectsSection` uses `LINKED_EFFECT_TYPES` (Ultra Key
  removed). Frame-grid cells and image/video layers keep it.
- `src/shaders/ultraKey.frag` — output alpha now rounds the sampled source
  alpha to its byte (`floor(src.a * 255.0 + 0.5)`) before
  `floor(alpha * A)`, matching the oracle's `trunc(a * A)`.
- `src/lib/ultraKey.ts` — `ultraKeyCheckInput` gains the 64×64 `stress`
  variant (seeded pseudo-random RGB, near-key green band, alpha ramp 0..255);
  `renderUltraKeyCheckFrame` accepts `variant`.
- `docs/ultra-key-shader-check.mjs` — third case; its RGB is compared
  premultiplied by the oracle's alpha, alpha directly; reports mean/p99/max
  per channel and keeps the 2 mean / 8 alpha-p99 bar.

#### Tests added

Vitest, `test/gpu-health.test.ts`:

- a project whose only effect is `ultrakey` returns true;
- the same when the layer is inside a group;
- the same when the effect is in a frame-grid cell;
- a project with only `blur` / no effects returns false.

Rust (`cargo test`, +3):

- Custom → Default → Custom restores `[60, 10, 50, 50, 10, 0, 0, 0, 50, 25,
  50, 50, 50]` (and Default wrote 45 first);
- choosing Custom with no snapshot leaves the sliders unchanged;
- `custom` survives a serialize/deserialize round trip, and a JSON without
  the field loads with an empty `custom`.

#### Checks

Red:

```
$ npx vitest run test/gpu-health.test.ts
Test Files  1 failed (1)
     Tests  4 failed (4)
TypeError: projectUsesGpu is not a function
```

```
$ cargo test        # first run of the new preset semantics
ultrakey_tests::preset_on_a_keyed_track_writes_a_key_at_the_playhead FAILED
assertion `left == right` failed: left: 1, right: 2
```

That failure was the old test calling the preset writer with setting 3 and a
table of values; it now exercises the same keyed-track write through a preset
setting instead.

Green (final):

- `npm test`: `Test Files  18 passed (18)` / `Tests  353 passed (353)` (Step 2
  ended at 349; +4).
- `npx tsc --noEmit`: no output, exit 0.
- `cargo test` inside `src-tauri/`: `277 passed; 0 failed; 7 ignored; 0
  measured; 0 filtered out` (Step 2 ended at 274; +3), plus the two 0-test
  targets. Bindings regenerated with `custom: Array<number>`; only the
  pre-existing ts-rs serde-attribute warnings.
- `node docs/ultra-key-reference.mjs`: `50% edge -> [ 202, 181, 134, 207 ]` /
  `self-check done`, exit 0.
- `node docs/ultra-key-shader-check.mjs` against the live app (CDP, after
  `import('/src/lib/ultraKey.ts')`; the app was fully reloaded between runs):

| Case | RGB comparison | r mean/p99/max | g mean/p99/max | b mean/p99/max | a mean/p99/max |
|---|---|---|---|---|---|
| Default preset | straight | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| + Saturation 150, Hue 30, Luminance 120 | straight | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| Stress 64×64, Default, key #28c83c | premultiplied by oracle alpha | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0.173 / 1 / 1 |

The stress case is the real result: RGB is exact after premultiplication;
alpha has a 1/255 tail on a few of the 4096 pixels. Running the same case with
the old `alpha * src.a * 255.0` line measured the same 0.173 / 1 / 1 — so this
fixture's residual is float32-vs-double rounding, not the source-alpha byte.
The byte rounding was still applied as specified; it removes the other
one-below case without changing this measurement.

#### Where the new code is

| Item | Location now |
|---|---|
| GPU kind predicate / project gate | `src/lib/effects.ts:145` `isGpuEffect`, `effects.ts:153` `gpuRuns`, `effects.ts:175` `projectUsesGpu` |
| Custom snapshot helpers | `lib.rs:4888` `ultrakey_track_values_at`, `lib.rs:4928` `set_ultrakey_track_values`, `lib.rs:4983` `write_ultrakey_values` |
| Preset commands | `lib.rs:5256` `apply_ultrakey_preset`, `lib.rs:5445` `apply_cell_ultrakey_preset` |
| Shader alpha rounding | `src/shaders/ultraKey.frag:104` |
| Stress fixture / renderer | `src/lib/ultraKey.ts:301` / `:364` |
| Add-menu filters | `Inspector.tsx` `excludeKinds` (adjustment), `LINKED_EFFECT_TYPES` (linked groups) |

#### Open-question decisions (recorded, no work this session)

- Alpha Channel and Color Channel outputs land in Step 3, each with a
  shader-check case for that output mode.
- The disabled single-option Output select stays, and the Matte Cleanup
  sliders stay editable with their hint, until Step 3.
- The Custom snapshot is now persisted per effect instance in the project
  (fix 2), not per row/session.
- Ultra Key is removed from the adjustment-layer and linked-group add menus
  (it remains on image/video layers and frame-grid cells).

### Where the note's references are now

| Note reference | Actual location now |
|---|---|
| 13a model | `model.rs:1288` `Effect::UltraKey`, `model.rs:1323/1338` shared track names/defaults, `model.rs:1400` `default_of` |
| 13a resolved | `eval.rs:536` `ResolvedEffect::UltraKey`, `eval.rs:630` resolve arm |
| 13a wiring | `lib.rs:4829` `effect_track_mut`, `lib.rs:6958` `walk_effect_tracks`, `lib.rs:5220/5414` static setters, `lib.rs:5256/5445` preset commands, `lib.rs:4876` Custom flip |
| 13a bindings | `src/bindings/Effect.ts`, `src/bindings/ResolvedEffect.ts` |
| 13a Inspector | `Inspector.tsx:1533` add-list entry, `Inspector.tsx:2157` Ultra Key row, `Inspector.tsx:3663/3687` image/video + adjustment sections |
| 13a App / timeline | `App.tsx:2398/2408/2507/2524` handlers, `Timeline.tsx:102` markers |
| 13a agent | `tools.ts:161` params, `tools.ts:453` keyColor/output/setting schema, `tools.ts:487` preset call, `tools.ts:499` static call |
| 13a docs | `EFFECTS_LIBRARY.md` Part 2, `docs/effects-reference/effects-catalog.json:149` |
| WP11 item 2 | `src/lib/ultraKey.ts:33` presets, `:108` CC port, `:184/233` uniforms/pass; `test/ultra-key.test.ts` |
| WP11 item 3 | `src/shaders/ultraKey.frag`, `src/lib/ultraKey.ts:301` check input / `:364` renderer, `docs/ultra-key-shader-check.mjs` |

### Differences from the note / phase limits

- Phase 1 ships the **Composite** output only. The model stores `output`, but
  the Inspector offers only Composite (the select is disabled) and the agent
  rejects 1/2; Alpha and Color Channel outputs land in Step 3.
- The Matte Cleanup sliders (Choke/Soften/Contrast/Mid Point) are present,
  keyframeable and stored, but do not affect the matte until Step 3 (the group
  carries a hint saying so).
- The "last Custom values" snapshot was a per-row ref in phase 1, so it was lost
  when the row unmounted. The review round moved it into the effect instance
  (`Effect::UltraKey.custom`, a serde-defaulted field in the project), as the
  note asks; Premiere keeps this globally.
- Ultra Key is wired for layer and frame-grid-cell effect stacks. It is a
  per-clip keyer: adjustment layers and linked groups do not get its static
  setters/presets (linked numeric keys would work through `effect_track_mut`, but
  key colour/Setting would not), so the review round removed it from those add
  menus.
- The live shader check uses the dev-only `window.__sefxUltraKey` bridge because
  a plain `import('/src/lib/ultraKey.ts')` from the page can resolve to a second
  Vite module instance; it is compiled out of production.
- The shader's `abs(dz) < 1e-6` snap (see above) is the only deviation from a
  literal float32 port; it exists to satisfy the oracle's four-channel comparison
  at alpha 0.

### Open questions

- All Step 2 open questions were decided in the review round; see
  "Open-question decisions" under Step 2 fixes above.
- Step 3 owns the Alpha/Color output shader maths and their shader-check cases
  (implemented below). The reference's Alpha output sets `CC[12..14] = 1`; the
  column-major packing maps those offsets correctly.

## Step 3 — WP4 phase 2 (matte cleanup, Alpha/Color outputs, second pass input)

Step 3 was the WP4 phase 2 work from the mentor note plus the review additions:
the Choke/Soften/Contrast matte cleanup, the Alpha Channel and Color Channel
outputs, a second pass input for the final pass, and five new live shader-check
cases on the 64×64 stress frame.

### Files changed

- `src/lib/gpuFx.ts` — `GpuPass.source2`; a second earlier pass is bound to
  texture unit 1 as `u_inputImage2`, kept alive by the last-use pass, and
  validated like `source`.
- `src/shaders/ultraKeyChokeX.frag` — Choke horizontal pass: horizontal min for
  radius r (R) and r+1 (G).
- `src/shaders/ultraKeyChokeY.frag` — Choke vertical pass: vertical min for both
  radii, then the reference's integer `fracFilter` lerp.
- `src/shaders/ultraKeySoftenX.frag` — Soften horizontal pass: the two
  horizontal box sums as 16-bit low/high byte pairs across RGBA8.
- `src/shaders/ultraKeySoftenY.frag` — Soften vertical pass: reconstructs the
  sums, applies `(sum * floor(65536/n) + n/2) >> 16` for both radii, then the
  integer fractional lerp.
- `src/shaders/ultraKeyFinal.frag` — two-input final pass: key RGB plus the
  cleanup matte (when present), Contrast, and the Composite/Alpha/Color switch.
- `src/shaders/ultraKey.frag` — now only the key pass (removed the unused
  `u_output` uniform); the key maths is untouched.
- `src/lib/ultraKey.ts` — registers all six programs; `ultraKeyPasses(e, offset,
  radiusScale)` builds key → choke x/y → soften x/y → final with absolute source
  indices; Color Channel forces Transparency 0 in the uniform precompute; the
  dev check frame accepts preset/choke/soften/contrast/midPoint/output/
  downsample and returns the output mode and downsample.
- `src/lib/effects.ts` — `gpuPassesFor(e, offset, radiusScale)` flattens each
  effect's passes; `applyEffects(..., radiusScale)` and `applyGpuRun` carry the
  radius scale into Ultra Key.
- `src/components/Preview.tsx` — Flat images pass `base.width / logical width`
  as the radius scale (capped preview vs export); 3D decals use capped width /
  original image width; video, grid cells and export stay 1.
- `src/components/Inspector.tsx` — Output select is enabled with Composite,
  Alpha Channel and Color Channel; the Matte Cleanup hint now describes the
  implemented controls.
- `src/agent/tools.ts` — Ultra Key `output` accepts 0, 1 and 2; the old
  "arrives later" rejection is gone and the value is passed to
  `set_ultrakey_static`.
- `src-tauri/src/model.rs`, `eval.rs`, `lib.rs` — doc comments now list
  0 Composite · 1 Alpha Channel · 2 Color Channel; no logic changed.
- `docs/ultra-key-shader-check.mjs` — five new stress cases; the oracle's
  output mode and downsample come from the same frame that the shader rendered.
- `test/ultra-key.test.ts`, `test/gpu-chain.test.ts` — pass-chain, radius,
  offset and second-input tests.

### Tests added

Vitest (`test/ultra-key.test.ts`):

- no cleanup → key + final, final reads pass 0 and has `u_cleanup = 0`;
- Choke 30 / Soften 40 → six passes, final reads pass 0 and the last matte
  (pass 4), with the expected r/w uniforms;
- the same case at radiusScale 0.5 → radii 1.4 / 0.8, i.e. `u_r` 1 / 0 and
  weights 153 / 204;
- an offset of 3 makes the final pass read passes 3 and 5;
- Color Channel forces `gT` to the 1e30 clamp, while Alpha Channel keeps the
  normal transparency gain.

Vitest (`test/gpu-chain.test.ts`):

- a final pass can sample an earlier pass as `u_inputImage2`;
- a `source2` that is not an earlier pass is rejected.

Live shader check: 5 new cases (8 total), all on the 64×64 stress frame except
the two original 32×32 fixture cases.

### Checks

Red: none for the new shader behaviour — this was the first implementation of
Choke/Soften/Contrast and the Alpha/Color outputs, so there was no previous
shader to fail. The one red during the step was a typecheck while wiring the
check-frame overrides:

```
src/lib/ultraKey.ts(482,26): error TS2322: Type 'number' is not assignable to
  type '0 | 25 | 40 | 45 | 10 | 50 | 15 | 55 | 90'.
```

Green (final):

- `npm test`: `Test Files  18 passed (18)` / `Tests  360 passed (360)` (Step 2
  fixes ended at 353; +7).
- `npx tsc --noEmit`: no output, exit 0.
- `cargo test` inside `src-tauri/`: `277 passed; 0 failed; 7 ignored; 0
  measured; 0 filtered out`, plus the two 0-test targets; only the pre-existing
  ts-rs serde-attribute warnings. Bindings regenerated; `Effect.ts` still
  carries the Step 2 `ultrakey` variant with `custom` (Step 3's Rust edits were
  doc comments only).
- `node docs/ultra-key-reference.mjs`: `50% edge -> [ 202, 181, 134, 207 ]` /
  `self-check done`, exit 0.
- Live GPU health check: `{ ok: true, programs: 8 }` — all six Ultra Key
  programs compile and run the 4×4 probe.

Live shader check (`node docs/ultra-key-shader-check.mjs` against the running
Tauri dev app after `import('/src/lib/ultraKey.ts')`):

| Case | RGB comparison | r mean/p99/max | g mean/p99/max | b mean/p99/max | a mean/p99/max |
|---|---|---|---|---|---|
| Default, 32×32 | straight | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| CC Saturation 150 / Hue 30 / Luminance 120, 32×32 | straight | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| Stress default | premultiplied | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0.173 / 1 / 1 |
| Stress Default + Choke 30 / Soften 40 / Contrast 30 | premultiplied | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| Stress Aggressive preset | premultiplied | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0.005 / 0 / 2 |
| Stress Alpha Channel output | direct | 0.173 / 1 / 1 | 0.173 / 1 / 1 | 0.173 / 1 / 1 | 0 / 0 / 0 |
| Stress Color Channel output | direct | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0.337 / 1 / 1 |
| Stress case 1 at downsample 0.5 | premultiplied | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |

All cases pass the note's bar (mean ≤ 2 on every channel, alpha p99 ≤ 8). The
0.173/0.005/0.337 alpha means are the same float32-vs-double 1/255 tail seen in
Step 2; the cleanup and downsample cases are exact.

### Live app checks (§5)

- Inspector DOM: the Output select is enabled and lists Composite, Alpha
  Channel and Color Channel; Setting still lists Default/Relaxed/Aggressive/
  Custom.
- Alpha Channel preview (480×360 render, key #28c63b): background pixels
  `[0,0,0]`, skin and grey patches `[255,255,255]` — the matte is opaque and
  correct.
- Color Channel preview: background `[172,172,172]` (despilled key), skin
  `[223,168,139]`, grey `[128,128,128]` — despill/CC still apply.
- Composite with Choke 30 / Soften 40 / Contrast 30: skin and grey unchanged;
  the background shows the stage (the Alpha render proves its matte is 0).
- Agent `add_effect` with `output: 1` succeeded and `output: 2` via the static
  setter produced the Color preview above; the tool schema advertises
  `[0,1,2]`.

### Where the note's references are now

| Note reference | Actual location now |
|---|---|
| §13a key pass | `src/shaders/ultraKey.frag` |
| §13a Cleanup canvas / pass pool | `src/lib/gpuFx.ts` `runPasses` (no cleanup canvas needed) |
| §13a Choke x/y | `src/shaders/ultraKeyChokeX.frag`, `ultraKeyChokeY.frag`; builder `ultraKey.ts:261` |
| §13a Soften x/y | `src/shaders/ultraKeySoftenX.frag`, `ultraKeySoftenY.frag` |
| §13a Final pass / second input | `src/shaders/ultraKeyFinal.frag`; `GpuPass.source2` at `gpuFx.ts:64`, bind at `:476` |
| §4b fractional radius | `ultraKey.ts:248` `radiusParts`; Choke/Soften Y shaders |
| §8 radius scaling | `effects.ts:232` `applyEffects(radiusScale)`; `Preview.tsx:385/2047` |
| §10 Alpha/Color outputs | `src/shaders/ultraKeyFinal.frag`; `Inspector.tsx:2200`; `agent/tools.ts:454` |
| §10 Contrast | `src/shaders/ultraKeyFinal.frag` `contrastMatte` |
| WP11 item 3 cases | `docs/ultra-key-shader-check.mjs:81-94`; `ultraKey.ts:464` check renderer |

### Differences from the note, and why

- The note's Soften x/y plan implies a precision-carrying intermediate. The
  shared chain's targets are RGBA8, so Soften X stores the two 16-bit
  horizontal sums as low/high byte pairs across R/G and B/A; Soften Y rebuilds
  them and applies the exact integer box formula. No new texture format was
  needed, and the stress cases are exact.
- The final pass reads the last cleanup pass, which is Soften Y when Soften > 0
  and Choke Y when only Choke > 0; when both radii are zero it reads only the
  key pass. That is the note's two-texture final plus the no-cleanup case.
- Color Channel follows the reference literally: Transparency is forced to 0,
  but the output alpha is still the cleaned `matte = trunc(a * sourceAlpha)`. On
  an opaque video it is 255; on the stress frame's alpha ramp it varies, and the
  check compares it to the oracle (RGB is compared directly, as requested). If
  "opaque" is meant to force alpha 255 even for non-opaque sources, that would
  diverge from the reference.
- Radius scaling in the app is `texture width / source-native width`: flat
  images use `base.width / logical width`, 3D decals use capped width / original
  image width, and video/export/grid cells are 1. The note gives the formula but
  not the call-site decisions.

### Anything broken / worth pointing out

- The stress frame's Color alpha is not constant 255 because its source alpha is
  a ramp. The RGB is exact and the alpha matches the oracle; the "opaque" claim
  is true for the usual opaque source, not for this synthetic alpha ramp.
- The 1/255 alpha tail in the default/Aggressive/Color cases is float32-vs-
  double rounding, not the cleanup maths; it is well inside the note's bar.
- The `u_inputImage2` sampler is intentionally unbound when `u_cleanup = 0`;
  the final shader never samples it in that branch. If a future change samples
  it unconditionally, the chain must bind something to unit 1.

### Open questions

- Should Color Channel force output alpha to 1 for non-opaque sources, or keep
  the reference's cleaned source-alpha matte? The current implementation is
  reference-faithful and the check passes.
- Should the radius scale for 3D decals use the original image width even when
  the decal is cropped (currently the pre-cropped canvas is treated as native,
  factor 1)?
- Step 4 (WP5, the eyedropper) is implemented below; the remaining WP11 items
  still wait for later steps.

## Step 4 — WP5 (Key Color eyedropper)

The pipette next to Key Colour enters a Program-monitor pick mode. The pointer
is mapped back through the layer's Motion transform into the ORIGINAL source
pixel, and the PRE-EFFECT source is sampled at native resolution. Ctrl/Cmd
averages a 5×5 patch in linear light. A pick sets the static Key Colour only
(keyframes are WP6).

### Files changed

- `src/lib/keyPick.ts` (new) — pure `pointerToSourcePixel` (inverse Konva
  transform, crop origin, native source bounds) and `averageRgbaLinear` (exact
  sRGB EOTF/OETF; returns 255 alpha). No DOM in this file.
- `src/components/Preview.tsx` — first cut: `keyPickTransformFor` built the
  mapping input, `sampleLayerSource` drew the full cached image/video frame into
  a scratch canvas, and a transparent top-most Konva hit rect sampled the click.
  The review round replaced the transform and sampling paths (see the fixes
  subsection below).
- `src/components/Inspector.tsx` — a ⌖ pipette beside the Key Colour swatch,
  with an active state and a "click the Program monitor; Esc cancels" hint. The
  pipette is disabled (with a wrapper title) for grid cells, groups, 3D decals
  and the Effect Editor overlay.
- `src/App.tsx` — `keyColorPick` state/ref, `startKeyColorPick`,
  `onKeyColorPicked` (sets the static colour using the effect's current
  output/setting), Esc cancels a pick before deselecting, selection/export
  clear the mode, and `canPickKeyColor` (top-level flat image/video only).
- `src/App.css` — Key Colour swatch/pipette row, pick-wrapper, and the
  crosshair cursor over the Program monitor.
- `test/key-pick.test.ts` (new) — 8 unit tests.
- No Rust changes; the pick calls the existing `set_ultrakey_static`.

### Tests added

Vitest, `test/key-pick.test.ts`:

- moved + scaled + rotated layer with an off-centre anchor: the hand-computed
  comp point `(127.25, 251)` maps back to source pixel `(150, 20)`;
- cropped image: layer-local `(50.5, 25.5)` maps through crop origin
  `(300, 200)` to source `(350, 225)`;
- preview-capped texture: a 4000×3000 layer (texture possibly capped to
  1000×750) maps `(2000.5, 1500.5)` to the ORIGINAL pixel `(2000, 1500)`;
- points outside the layer and zero scale return null;
- linear-light average: 13 black + 12 white → 184 (the sRGB mean would be
  122), 24 blue + 1 black → `[0, 0, 250]`, and uniform 12/200/60 and 128
  round-trip exactly.

The review round replaced the first five mapping tests with the Konva-local
API (no crop, crop, capped draw, draw ≠ native, bounds) plus a group-finder
test; the three average tests are unchanged. See the fixes subsection.

### Checks

Red:

```
$ npx vitest run test/key-pick.test.ts
FAIL  test/key-pick.test.ts [ test/key-pick.test.ts ]
Error: Cannot find module '../src/lib/keyPick' imported from
  G:/Workspace/Simple_Effects/Simple_Effects/test/key-pick.test.ts
Test Files  1 failed (1)
     Tests  no tests
```

Green (final):

- `npx vitest run test/key-pick.test.ts`: `Test Files 1 passed (1)` /
  `Tests 8 passed (8)`.
- `npm test`: `Test Files 19 passed (19)` / `Tests 368 passed (368)` (Step 3
  ended at 360; +8).
- `npx tsc --noEmit`: no output, exit 0.
- `cargo test` inside `src-tauri/`: `277 passed; 0 failed; 7 ignored`, plus the
  two 0-test targets; only the pre-existing ts-rs serde-attribute warnings.
- `node docs/ultra-key-reference.mjs`: `key colour -> [ 174, 174, 174, 0 ]`
  `skin -> [ 225, 170, 140, 255 ]` … `self-check done`, exit 0.

### Live CDP check (§5)

Setup: a 320×240, 2 s green-screen video (flat #28c83c background; skin
rectangle), comp 480×360, layer transform `x=250, y=170, scaleX=scaleY=1.15,
rotation=17°, anchor=(0.5,0.5)`. The layer was selected, Ultra Key opened, the
pipette clicked, and the pick click dispatched with `Input.dispatchMouseEvent`
on the Program monitor. The reference RGB was read independently by drawing the
pooled video element into a canvas and reading the same source pixel.

- First pick, source pixel `(150, 120)` (skin): source read
  `[224, 170, 140]`; picked Key Colour `[224, 170, 140]`. Equal.
- The key was then set to the decoded green `[40, 200, 60]` and the composite
  re-rendered: the mapped comp point of the next pick is `[0, 0, 0, 0]`,
  confirming the layer is keyed there.
- Second pick, source pixel `(40, 40)` while already keyed: source read
  `[40, 200, 60]`; picked Key Colour `[40, 200, 60]`. Equal — the pick came
  from the pre-effect source, not the transparent composite.
- Esc while picking: `.preview-wrap.picking` went 1 → 0 and the layer stayed
  selected (`uk-step4.mp4`); the pick did not fall through to deselection.

The first pick's comp point was `(239.38, 167.36)` at stage scale 1.220246
(origin `473, 24`), dispatched at client `(951.10, 306.22)`; the second was
dispatched at client `(836.31, 153.73)`.

### Where the note's references are now

| Note reference | Actual location now |
|---|---|
| §13a WP5 pointer → layer local | `Preview.tsx:3456` `onPickClick` uses `node.getAbsoluteTransform()`; `keyPick.ts:41` `localToSourcePixel` |
| §13a WP5 source pixel → original image | `keyPick.ts` maps the crop-or-native rect onto the node draw size; `Preview.tsx:352` `layerSource`, `:383` `sampleLayerSource` |
| §13a WP5 video source (`loadVideo`, media.ts:230) | `Preview.tsx` `layerSource` (`loadVideo`) and `sampleLayerSource` |
| §13a WP5 image source (`imgCache`) | `Preview.tsx` module-level `imgCache`; not exported (sampling stays in Preview) |
| §13a WP5 pipette / crosshair / Esc | `Inspector.tsx:2206`; `App.tsx` pick callbacks; `App.css:1723` |
| §13a WP5 Ctrl/Cmd 5×5 linear average | `keyPick.ts:82` `averageRgbaLinear`; Ctrl/Cmd read in `Preview.tsx:3456` |
| §13a WP5 keyframes are WP6 | The pick calls `set_ultrakey_static` only; no key colour keyframes |

### Differences from the note, and why

- The note suggested exporting `imgCache` from Preview. The sampling lives in
  Preview instead, so `imgCache` stays module-private and there is no
  Preview → lib → Preview cycle; the pure, tested parts are in
  `src/lib/keyPick.ts`.
- The note suggests Konva `getRelativePointerPosition()`. The click handler
  reads the stage pointer and inverts the resolved Motion transform in the pure
  `pointerToSourcePixel` instead; that is the same mapping, but it is unit
  tested for the moved/rotated/scaled/anchor, crop and capped-preview cases the
  user asked for.
- The first cut restricted picking to top-level flat image/video layers. Grid
  cells and 3D decals use quad/surface mappings (the note's "not in v1"); group
  children were excluded because their resolved x/y are group-local. Round 1
  added Konva's absolute transform and briefly a deep static setter; round 2
  reverted the deep setter. Group children are supported by entering the group
  (the child is then top-level in that scope); cells and 3D decals stay
  excluded.
- Video uses the live element's `videoWidth/Height`, not the model's stored
  width/height. VideoNode draws at the element's size; using the element keeps
  the pointer mapping exact if the metadata ever differs.
- The 5×5 average clamps the patch origin so the window stays 5×5 inside the
  source at the edges. The note does not specify edge handling; this avoids
  transparent-black padding skewing the average.
- A pick clears the mode after a valid sample; a click that misses the layer
  (or an unloaded video) keeps pick mode active for another try.

### Anything broken / worth pointing out

- During playback the pick samples the video element when the click handler
  runs; a frame can advance between the click and the canvas draw. Paused
  picking (the live check) is exact.
- The first cut allocated a full-native-size scratch canvas per pick; the review
  round fixed this: only the 1×1/5×5 patch is drawn into a fixed 5×5 canvas.
- Keyframeable Key Colour is still WP6; a pick over an existing keyed/
  keyframed colour writes the static `key_color` only.
- The disabled pipette's tooltip is on a wrapper span: disabled buttons do not
  receive hover events in every WebView, so the title lives on the span.

### Open questions

All three Step 4 questions were decided in the review round:

- Picking stays off for grid cells and 3D decals.
- A pick during playback may land on the next frame; accepted.
- Clamping the 5×5 window inside the image edges is fine.

Groups are now supported by the Konva-transform fix; see the review round below.

### Step 4 fixes (review round)

> **Round-2 note:** the deep layer search, its Rust test, `findLayerDeep`, and
> the `__sefxKeyPick` bridge described in this round-1 subsection were reverted
> in round 2. Groups are supported by entering them (`enter_group` swaps the
> editing scope), so the editing commands work on the children as top-level
> layers. See "Step 4 fixes, round 2" below.

#### Files changed

- `src/lib/keyPick.ts` — deleted `pointerToSourcePixel` and its hand-written
  rotation/anchor maths. `localToSourcePixel(localX, localY, source)` now maps
  the Konva node's drawn content (0..node.width/height) onto the source rect
  (crop when cropped, otherwise the full native frame), adds the crop origin,
  and clamps. Added `findLayerDeep` for group children. `averageRgbaLinear` is
  unchanged.
- `src/components/Preview.tsx` — the image/video visual nodes carry
  `id="layer-<id>"` (ImageNode, EffectImageNode, TransitionImageNode, all three
  VideoNode roots). `onPickClick` finds the node with `stage.findOne`, gets
  node-local coordinates with
  `node.getAbsoluteTransform().copy().invert().point(stagePointer)` (parent
  groups, anchor, rotation, scale, monitor fit/zoom/pan all included), and calls
  the pure mapper. The stage→comp and rotation/anchor code is gone. The pick
  target is found with `findLayerDeep`, so group children work.
  `sampleLayerSource` now draws ONLY the 1×1 or clamped 5×5 source rectangle
  into a fixed 5×5 canvas with `imageSmoothingEnabled = false`
  (`drawImage(source, x0, y0, pw, ph, 0, 0, pw, ph)`), never the full frame.
- `src/App.tsx` — `onKeyColorPicked` finds the effect with `findLayerDeep` in
  the project (not the per-scope resolved record) and uses its static
  output/setting. `canPickKeyColor` allows group children now; it checks
  `selectedLayer.attach` for 3D decals instead of `groupPath`/top-level. Added
  the dev-only `window.__sefxKeyPick` bridge (`start`, `cancel`,
  `clientFromLocal`) used to drive the root-scope group live check.
- `src-tauri/src/lib.rs` — `layer_mut_deep` recurses into groups;
  `set_ultrakey_static` uses it, so a pick on a nested child updates that
  child's static Key Colour. +1 Rust test (`nested_layers_are_found_for_static_
  key_updates`).
- `test/key-pick.test.ts` — rewritten for the Konva-local API: no crop, crop,
  preview-capped draw size, node size ≠ native size, bounds/degenerate sizes,
  the group finder, and the three linear-light average tests.

#### Tests added / changed

- `localToSourcePixel`: no crop; crop origin `(300,200)`; a 4000×3000 source
  drawn at 1000×750 (local `(500,375)` → original `(2000,1500)`); node
  400×300 vs native 800×600 (local `(200,150)` → `(400,300)`); outside/zero
  sizes return null.
- `findLayerDeep` finds a child nested in a group and the group itself.
- The 5×5 linear average tests are unchanged.

#### Checks

Red: no unit-test red for the new mapper (the tests were written with it). The
review round's red was the first live group pick, before the Rust deep setter:

```
group pick callback received = [224, 170, 140]   (temporarily exposed as lastPick)
child keyColor before = [40, 200, 60], after = [40, 200, 60]   // unchanged
```

`set_ultrakey_static` only searched the top-level layers, so the pick sampled
the right colour but the nested child never received it. After `layer_mut_deep`
the same pick updates the child (green below).

Green (final):

- `npm test`: `Test Files 19 passed (19)` / `Tests 369 passed (369)` (Step 4
  ended at 368; the rewritten file is 9 tests, +1 overall).
- `npx tsc --noEmit`: no output, exit 0.
- `cargo test` inside `src-tauri/`: `278 passed; 0 failed; 7 ignored` (Step 4
  ended at 277; +1 nested-layer test), plus the two 0-test targets.
- `node docs/ultra-key-reference.mjs`: `key colour -> [ 174, 174, 174, 0 ]`
  `skin -> [ 225, 170, 140, 255 ]` … `self-check done`.

Live CDP check (same 320×240 static green-screen video; comp 480×360; the
video transform is `x=250, y=170, scale=1.15, rotation=17°`):

- First pick, via the pipette, source pixel `(150,120)` (skin): source read
  `[224, 170, 140]`; picked Key Colour `[224, 170, 140]`. Click point
  `(951.1058, 306.2245)` via Konva `clientFromLocal(1,150.5,120.5)`.
- Second pick, after setting the key to the decoded green and reloading (the
  layer is already keyed), source pixel `(40,40)`: source read
  `[40, 200, 60]`; picked Key Colour `[40, 200, 60]` (unchanged, correctly).
  Click point `(836.3098, 153.7335)`.
- Group pick: the video (id 1) and a second video (id 2) were combined into
  group id 3; the group transform is `x=40, y=20, rotation=25°`. The group
  child id 1 (already keyed green) was picked at source `(150,120)`: source
  read `[224, 170, 140]`; the child's Key Colour went from `[40, 200, 60]` to
  `[224, 170, 140]`. Click point `(886.2412, 434.9485)`, dispatched with
  `Input.dispatchMouseEvent` on the Program monitor. The Konva node's absolute
  transform includes the group's move/rotation; the pick returned the skin, not
  the ungrouped location or the keyed composite.
- Final sanity after removing the temporary dev diagnostics: the same group
  child picked source `(40,40)` and changed from `[224, 170, 140]` to
  `[40, 200, 60]`.

The group pick was started with `window.__sefxKeyPick.start(1, 0)` because the
root timeline cannot select a group child (double-clicking a group enters its
scope, where the parent transform is no longer drawn). The mapping and click
path are the real UI path; the bridge only starts pick mode for the child.

#### Where the note's references are now

| Note reference | Actual location now |
|---|---|
| §13a WP5 pointer → node local | `Preview.tsx:3456` `onPickClick` (`getAbsoluteTransform().invert()`); node ids at `Preview.tsx:444/613/1075/1397/1439/1471` |
| §13a WP5 local → source pixel | `keyPick.ts:41` `localToSourcePixel` (crop or full-native source rect, draw size) |
| §13a WP5 source sampling | `Preview.tsx:352` `layerSource`, `:383` `sampleLayerSource` (patch-only 5×5 canvas) |
| §13a WP5 group children | round 1: `findLayerDeep` + `layer_mut_deep`; **reverted in round 2** — the real path is `enter_group` scope + current-scope commands |
| §13a WP5 live-check hook | round 1: `App.tsx:626/631` `__sefxKeyPick`; **removed in round 2** — the group check uses the real enter/select/pick path |

#### Differences from the note, and why

- The note suggests `getRelativePointerPosition()`. The click handler uses the
  stage pointer plus the node's absolute-transform inverse, which is the same
  mapping and includes every parent group and the monitor's fit/zoom/pan. The
  pure `localToSourcePixel` is unit tested for the cases the user asked for.
- The note says "add the crop offset, then scale by (native source size / the
  size the node draws at)". The implementation maps the source rectangle (the
  crop when cropped, otherwise the full native frame) onto the node's drawn
  size, then adds the crop origin. That is the same result when the node draws
  the crop at its crop size, and is correct when the drawn size differs; the
  tests cover both.
- For a preview-capped image the Konva node still draws at its logical size
  (native/crop); the cap is only on the texture. The mapping therefore already
  addresses the original pixel. The pure test also passes a capped draw size
  (1000×750 for a 4000×3000 source) to prove the native/draw scale is applied
  when the sizes differ.
- Group support also needed the Rust static setter to search nested layers;
  without that the pick sampled correctly but the child's key colour did not
  change (the red above).

#### Anything broken / worth pointing out

- The root timeline cannot select a group child, so the pipette cannot be
  started for a child at root through the current UI. It works when the child
  is selected inside the group scope (the group parent transform is not drawn
  there). The live group check uses the dev bridge to start the pick at root;
  the mapping itself is the production path.
- The 1×1 live picks are exact. The 5×5 path is covered by the unit tests and
  draws only the clamped patch; a live Ctrl-click was not repeated.
- The `__sefxKeyPick` bridge is dev-only (`import.meta.env.DEV`) and is the
  only test-only addition.

#### Open questions

- Round-1 question resolved in round 2: no, do not select group children at
  root. Enter the group; its children are the current scope.
- Grid cells and 3D decals remain excluded by decision; their quad/surface
  mappings are not implemented.

### Step 4 fixes, round 2

Round 2 reverts the round-1 deep layer search and the dev-only root-scope
bridge. The real group path is the existing scope swap: `enter_group` swaps the
editing scope, the child becomes a top-level layer, and every editing command
(including `set_ultrakey_static`) works on it in that scope.

#### Files changed

- `src-tauri/src/lib.rs` — removed `layer_mut_deep` and its
  `nested_layers_are_found_for_static_key_updates` test;
  `set_ultrakey_static` again uses
  `project.layers.iter_mut().find(|l| l.id == layer_id)`, the same current-scope
  lookup as the other Ultra Key commands.
- `src/App.tsx` — `onKeyColorPicked` looks up the effect with
  `projectRef.current.layers.find(...)` (current scope), not a deep search.
  Removed the `findLayerDeep` import and the dev-only
  `window.__sefxKeyPick` bridge. Fixed the stale `canPickKeyColor` comment: it
  now says picking works on a flat image/video layer in the current scope,
  groups are covered by entering them, and cells/3D decals stay excluded.
- `src/components/Preview.tsx` — `pickLayer` uses
  `project.layers.find(...)` in the current scope; removed the
  `findLayerDeep` import. The accepted round-1 pieces (Konva absolute
  transform, `layer-<id>` ids, patch-only sampling) are unchanged.
- `src/lib/keyPick.ts` — removed `findLayerDeep` and the now-unused `Layer`
  type import; `localToSourcePixel` and `averageRgbaLinear` are unchanged.
- `test/key-pick.test.ts` — removed the group-finder test and its import;
  the five local→source tests and three average tests remain (8 total).

#### Checks

Red: none. This round removes the round-1 deep-search code and its test rather
than adding behaviour; the real-path live check below was green.

Green (final):

- `npm test`: `Test Files 19 passed (19)` / `Tests 368 passed (368)` (round 1
  ended at 369; the removed group-finder test is −1).
- `npx tsc --noEmit`: no output, exit 0.
- `cargo test` inside `src-tauri/`: `277 passed; 0 failed; 7 ignored` (round 1
  ended at 278; the removed nested-layer test is −1), plus the two 0-test
  targets.
- `node docs/ultra-key-reference.mjs`: `key colour -> [ 174, 174, 174, 0 ]`
  `skin -> [ 225, 170, 140, 255 ]` … `self-check done`, exit 0.

#### Live check, real group path

Setup: a 320×240 green-screen video child (id 1) with an Ultra Key static
colour `#28c63b` = `[40, 198, 59]`, its own transform `x=250, y=170,
scale=1.15, rotation=17°`; a second video (id 2); both combined into group id 3
with the group at `x=40, y=20, rotation=25°`.

- Entered the group by double-clicking its timeline block (the UI's
  `onEnterGroup`): the breadcrumb became `⌂ Root › Group`, the scope showed
  layers `[1:video, 2:video]`, and the group's parent transform was no longer
  drawn (existing group-edit behaviour).
- Selected the keyed child (id 1) in the timeline, opened Effects → Ultra Key,
  clicked the pipette, and dispatched the pick with
  `Input.dispatchMouseEvent` on the Program monitor at source `(150,120)`:
  source read `[224, 170, 140]`; Key Colour went from `[40, 198, 59]` to
  `[224, 170, 140]`. Click point `(951.1003, 306.2207)`.
- Ctrl-click 5×5 at source `(100,120)`, a green/skin boundary (patch origin
  `(98,118)`): the center pixel is `[190, 189, 132]`; the computed 5×5 linear
  average is `[173, 182, 115]`; the picked Key Colour is exactly
  `[173, 182, 115]`. Click point `(884.0020, 285.7066)` with the Ctrl modifier.
- Exited the group via the `⌂ Root` breadcrumb (`onExitGroup(0)`): crumbs went
  to 0, the root scope again holds `[3:group]`, and child id 1's Key Colour
  survived the re-nesting as `[173, 182, 115]`.

#### Where the references are now

| Item | Location now |
|---|---|
| Group editing scope | `src-tauri/src/lib.rs:1773` `enter_group` (swaps `project.layers` to the children); `exit_group` re-nests on exit |
| Static setter | `src-tauri/src/lib.rs:5220` `set_ultrakey_static` — current-scope `layers.iter_mut().find` |
| Pick callback effect lookup | `App.tsx:2430` `onKeyColorPicked` — `projectRef.current.layers.find` |
| Pick target | `Preview.tsx:3449` `pickLayer` — current-scope `project.layers.find` |
| Konva mapping / sampling | `Preview.tsx:3453` `onPickClick`; `Preview.tsx:352/383` `layerSource`/`sampleLayerSource`; `keyPick.ts:41` `localToSourcePixel` |

#### Differences from the note / resolver

- The round-1 deep search and dev bridge are gone. A nested child is never the
  `selectedLayer` at root because the only way to edit it is `enter_group`;
  using a current-scope lookup keeps Ultra Key consistent with
  `apply_ultrakey_preset`, `add_effect` and the other commands.
- The group's parent transform is intentionally not drawn while editing the
  group (the scope shows the children); the pick maps the child's own transform
  plus the monitor fit/zoom/pan. This is the real path the UI offers.
- The accepted round-1 pieces are unchanged: Konva's absolute transform, the
  pure `localToSourcePixel`, the `layer-<id>` node ids, and patch-only 5×5
  sampling.

#### Anything broken / open questions

- Nothing known. The round-1 question about selecting a group child at root is
  resolved: don't; enter the group.
- Grid cells and 3D decals remain excluded by decision.

## Step 5 — WP7 Crop + WP3 stack order

WP7 adds a keyframeable Crop / garbage matte. WP3 changes `applyEffects` from the
old category order (CSS filters → wipes → torn edges → GPU) to the stack order,
top to bottom, merging runs of CSS filters and runs of GPU effects. Generated
stacks (style packs, both `gradeShot`s, card stacks) are proven to be in the old
category order, so their rendering is unchanged.

### Files changed

- `src/lib/effects.ts` — `applyEffects` now walks the stack: a run of consecutive
  CSS filters is one `drawImage` with the merged filter string, a wipe/torn
  edge/crop is applied where it sits, and a run of consecutive GPU effects is one
  WP1 chain. A CSS run after a non-filter step re-filters through one lazily
  created, size-keyed scratch canvas. Added `applyCrop` (one separable
  `destination-in` rect mask, two gradient fills) and `filterPart` (shared by
  `buildFilter`, which `AdjustmentNode` still uses).
- `src-tauri/src/model.rs` — `Effect::Crop { left, top, right, bottom, feather }`
  (all Tracks) and `default_of("crop")` = 0 on every side, identity.
- `src-tauri/src/eval.rs` — `ResolvedEffect::Crop` and its `resolve_effect` arm.
- `src-tauri/src/lib.rs` — five `effect_track_mut` arms (`left`, `top`, `right`,
  `bottom`, `feather`) and the `walk_effect_tracks` arm; a `crop_tests` module.
- `src/bindings/Effect.ts`, `src/bindings/ResolvedEffect.ts` — regenerated by
  `cargo test`; both carry the `crop` variant.
- `src/lib/api.ts` — `EffectParam` gains `left`, `top`, `right`, `bottom`,
  `feather`.
- `src/components/Inspector.tsx` — `EFFECT_TYPES` gains Crop (so the layer, cell,
  linked-group and Effect Editor add menus all offer it) and the Crop row with
  the five keyframeable sliders and a hint.
- `src/components/EffectEditor.tsx` — `EffectParam` list kept in sync.
- `src/components/Timeline.tsx` — `pushEffectTracks` marks all five Crop tracks.
- `src/agent/tools.ts` — `EFFECT_PARAMS.crop` with the ranges; `add_effect`
  accepts `crop` and its params; the description names the garbage matte.
- `src/lib/stylePacks.ts` — exported `stylePackClipFx` / `stylePackOverlayFx`;
  `applyStylePack` uses them (same order, no behaviour change).
- `src/lib/rebuildFromAnalysis.ts` — exported `GRADE_SHOT_FX`,
  `GRADE_SHOT_OPTIONAL_FX`, `CARD_STACK_FX`; `gradeShot` and `buildCardStack`
  use them (same order, no behaviour change).
- `src/lib/synthetic.ts` — exported `SYNTHETIC_GRADE_FX` /
  `SYNTHETIC_GRADE_OPTIONAL_FX`; `gradeShot` uses them (same order).
- `EFFECTS_LIBRARY.md` — Crop row. `docs/effects-reference/effects-catalog.json`
  — `crop` status `gap` → `done`, percent/px ranges, `renderTechnique`
  `canvas-mask`.
- `test/stack-order.test.ts` — new; 48 tests.

### Tests added

`test/stack-order.test.ts`:

- for all 12 style packs: the regular-clip stack, the hero-clip stack and the
  adjustment-layer overlay stack are in the old category order (CSS rank 0, wipe
  1, torn edge 2, GPU 3), with the failing kind named if not;
- both `gradeShot`s (measured and synthetic): brightness → contrast → saturate →
  optional vignette/film grain, in that order;
- card stacks: torn edge only;
- `[wipe, blur]` runs the blur after the wipe, and `[blur, wipe]` the reverse
  (the note's WP3 done-when);
- `[Ultra Key, saturate]`: the GPU chain is invoked before the CSS colour filter
  draw, and `[saturate, Ultra Key]` the reverse; the Ultra Key run is one chain
  call (not one per pass);
- Crop: identity when nothing is cropped; a hard crop keeps the inside opaque
  (the fixed hard-stop path); a feathered crop produces the expected ramp stops;
  the feather scales with `radiusScale` (20 source px on a half-size texture is
  10 texture px / 0.10 of the width); `[crop, saturate]` masks before the filter.

Rust (`cargo test`, +3): default crop is the identity; all five tracks can be
keyed and `walk_effect_tracks` visits five; the effect survives a
serialize/deserialize round trip.

### Checks

Red (test written first, before any of the APIs existed):

```
$ npx vitest run test/stack-order.test.ts
 Test Files  1 failed (1)
      Tests  47 failed (47)
TypeError: applyCrop is not a function
...
AssertionError: expected -1 to be greater than or equal to 0   // wipe/crop order
```

The generated-stack cases failed the same way: the exported order helpers did
not exist, so `stylePackClipFx(...)` / `GRADE_SHOT_FX` were undefined.

Green (final):

- `npm test`: `Test Files  20 passed (20)` / `Tests  416 passed (416)` (Step 4
  ended at 368; +48).
- `npx tsc --noEmit`: no output, exit 0.
- `cargo test` inside `src-tauri/`: `280 passed; 0 failed; 7 ignored; 0 measured;
  0 filtered out` (Step 4 ended at 277; +3), plus the two 0-test targets; only
  the pre-existing ts-rs serde-attribute warnings. Bindings regenerated with the
  `crop` variant in `Effect.ts` and `ResolvedEffect.ts`.
- `node docs/ultra-key-reference.mjs`:
  `key colour -> [ 174, 174, 174, 0 ]  skin -> [ 225, 170, 140, 255 ]  grey -> [ 128, 128, 128, 255 ]  50% edge -> [ 202, 181, 134, 207 ]`
  / `self-check done`, exit 0.

### Live checks (§5)

Setup: debug exe + `npm run dev`, CDP on 9222 and the MCP bridge on 8787. Project
`crop-video.sefx`: 320×240 @ 30 fps, 2 s, one 320×240 `testsrc2` video, one Crop.
The crop is keyframed: Left 2 → 22 % over 0 → 2000 ms, Feather 0 → 40 → 0 px
(keys at 0 / 1000 / 2000). At t = 1000 ms the resolver returns left 12, top 5,
right 10, bottom 10, feather 40.

WP7 done-when — keyframed crop, preview vs export (t = 1000 ms):

| Comparison | Result |
|---|---|
| Editor per-layer renderer (`applyEffects` on the source video frame, radiusScale 1) vs the export-mode `render_preview` frame at pixel ratio 1 (what the export loop grabs — the same stage canvas) | RGB **max Δ 0 / mean 0** over 76 800 pixels; alpha **max Δ 0 / mean 0** |
| Left feather alpha at y = 120, x = 34…84 | `0, 7, 39, 71, 103, 134, 166, 198, 230, 255` — the 40 px source-pixel ramp |
| Right feather alpha at y = 120, x = 269…289 | `118, 86, 54, 22, 0` |
| Alpha population | 21 080 opaque · 29 836 partial · 25 884 clear (76 800 total) |

The stage frame was composited over black on both sides for the RGB compare
(nothing is below the clip); the raw alpha was compared separately too.

WP7 extra — Edge Feather is in source pixels and scales with `radiusScale`
(measured in the page, real canvases): a 2000×1500 image, crop left/right 10 %,
feather 50 px, rendered at full resolution (radiusScale 1) and at the 1024 px
preview cap (radiusScale 1024/2000 = 0.512), then the capped render upscaled to
2000×1500:

| Check | Result |
|---|---|
| Feather ramp width | 50 source px in both |
| Alpha at x = 200 / 210 / 220 / 230 / 240 / 250 (y = 750) | full `3, 54, 105, 156, 207, 255` vs capped `3, 54, 105, 155, 206, 254` |
| Alpha difference over 3 000 000 pixels | max 2 / 255, mean 0.017, **0 pixels over 2** |

Hard-crop regression (found while testing the gradient stop construction): a
crop with feather 0 used to produce an all-transparent mask (a real bug in the
first cut, fixed before the checks below). 1000×1000 image, 10 % on all sides,
feather 0: 640 000 opaque / 360 000 transparent / **0 partial** pixels; alpha at
x = 99 → 0 and x = 100 → 255; y = 99 → 0 and y = 100 → 255. The new hard-stop
unit test locks it.

WP3 live sanity (the tests cannot see the browser's filter chain): the same
`[wipe, blur]` pair in both orders through the live `applyEffects` on a
2000×1500 image (wipe 50 %, softness 0.005, blur 20 px):

| x at y = 750 | 960 | 970 | 980 | 990 | 1000 | 1010 | 1020 | 1030 | 1040 | 1050 |
|---|---|---|---|---|---|---|---|---|---|---|
| `[wipe, blur]` alpha | 249 | 236 | 211 | 173 | 125 | 77 | 40 | 17 | 6 | 1 |
| `[blur, wipe]` alpha | 255 | 255 | 255 | 255 | 115 | 0 | 0 | 0 | 0 | 0 |

The mask-first stack blurs the masked edge; the filter-first stack keeps the
hard wipe edge. RGB difference: max 255 / mean 5.12 / 448 319 of 9 000 000
channel samples above 1/255. So the stack position genuinely decides the order
now.

Inspector (live DOM): after selecting the video layer, the Effects section lists
`Crop` (twice after an agent-added default Crop). The expanded row shows
`Left (%)`, `Top (%)`, `Right (%)`, `Bottom (%)`, `Edge feather (px)` and the
hint; at t = 0 the keyed Left reads 2, at t = 1000 it reads 12, matching the
resolved value used by the render.

Agent: `list_effects` advertises `crop` with `left/top/right/bottom` 0–100 and
`feather` 0–200; `add_effect {kind:"crop"}` succeeds and appends it.

### Where the note's references are now

| Note reference | Actual location now |
|---|---|
| §13 WP7 model | `model.rs:1250` `Effect::Crop`, `model.rs:1404` `default_of("crop")` |
| §13 WP7 resolved | `eval.rs:501` `ResolvedEffect::Crop`, `eval.rs:607` resolve arm |
| §13a wiring: `effect_track_mut` | `lib.rs:4840-4844` (five arms) |
| §13a wiring: keyframe walker | `lib.rs:6978` `walk_effect_tracks` |
| §13a wiring: static setter | none — Crop has no static fields; all five params are Tracks, keyed by `key_effect` / `key_cell_effect` |
| §13a wiring: bindings | `src/bindings/Effect.ts`, `src/bindings/ResolvedEffect.ts` (regenerated) |
| §13a wiring: `EffectParam` ×3 | `api.ts:644`, `Inspector.tsx:1544`, `EffectEditor.tsx:11` |
| §13a wiring: Inspector | `Inspector.tsx:1512` `EFFECT_TYPES`, `Inspector.tsx:2067` Crop row |
| §13a wiring: App / Timeline | effect add + key paths are the existing `onAddEffect` / `onKeyEffect` (`App.tsx:2310/2331`); `Timeline.tsx:111` markers |
| §13a wiring: agent | `tools.ts:147` `EFFECT_PARAMS.crop`, `add_effect` description |
| §13a wiring: docs | `EFFECTS_LIBRARY.md` Part 2, `docs/effects-reference/effects-catalog.json:167` |
| WP7 render pass | `src/lib/effects.ts:473` `applyCrop`, called inline at `effects.ts:318` |
| WP3 stack walk | `src/lib/effects.ts:268` `applyEffects`, `:247` `scratchFor` |
| WP3 generated stacks | `src/lib/stylePacks.ts` `stylePackClipFx`/`stylePackOverlayFx`; `rebuildFromAnalysis.ts` `GRADE_SHOT_FX`/`GRADE_SHOT_OPTIONAL_FX`/`CARD_STACK_FX`; `synthetic.ts` `SYNTHETIC_GRADE_FX` |
| WP3 proof | `test/stack-order.test.ts` |

### Differences from the note, and why

- **Feather applies only to cropped edges.** `feather` softens a side only when
  Left/Top/Right/Bottom for that side is > 0. The note gives the parameter but not
  this rule; feathering an uncropped frame edge would darken a border the user
  never cropped.
- **Two gradient fills, not one `fillRect`.** The mask is one `destination-in`
  step but is built from one full-canvas gradient per axis (horizontal, vertical)
  whose alphas multiply. That is a separable feathered rect; a hard edge (feather
  0) uses two stops at the same offset for a step. This avoids a scratch mask
  canvas and keeps the mask a single composite operation, like Wipe/TornEdge.
- **No static setter.** Every Crop parameter is an animatable Track, so the
  §13a "static setter + `invoke_handler`" row has no Crop input; the existing
  `key_effect` / `key_cell_effect` path keys all five. (The other wiring rows are
  all touched.)
- **Crop on an adjustment layer is not applied.** WP3 says `AdjustmentNode` keeps
  its own path; it only knows CSS filters and GPU overlays. Wipe and TornEdge
  already behave this way there. Crop on image, video, frame-grid cell and decal
  layers goes through `applyEffects` and works.
- **Generated-stack order helpers.** To assert the *actual* order the appliers
  write (not a re-typed copy), `stylePacks.ts` / `rebuildFromAnalysis.ts` /
  `synthetic.ts` export the kind-order expressions and the appliers use them.
  Their order and behaviour are unchanged; `test/style-packs.test.ts` and
  `test/rebuild-from-analysis.test.ts` still pass.
- **WP3 stack order changes hand-built stacks.** The note says so; the one-line
  release note below is the user's build-message text. No legacy flag or
  migration was added (decided).
- **The note's one stated exception is not reproducible from today's
  generators.** The note says a style pack applied to a rebuilt card stack would
  now grade the torn paper. In this code `applyStylePack` calls `clearFx` on
  every image/video clip first, which removes a card layer's torn edge before the
  grade is added, and `buildCardStack` adds its torn edge to fresh layers that
  never carry a grade. So no generator emits `[grade, …, tornedge]` — the three
  generated stacks tested here all pass. If a hand-built stack is later given a
  torn edge above a grade, that is exactly the intended stack-order change and is
  covered by the release note.

### Release note (one line, not committed)

Effects now run in stack order, top to bottom, matching Premiere — a hand-built stack with a wipe, torn edge or GPU effect above a grade or blur will look different.

### Open questions

- Should the adjustment-layer add menu hide Crop (and Wipe/TornEdge), since
  `AdjustmentNode` ignores masks? This is pre-existing for Wipe/TornEdge; left
  unchanged in this step.
- Crop on a 3D decal uses the decal's `radiusScale` (capped texture width ÷
  original image width) but was not live-checked; the image and video paths were.
- WP8 (next step) still owns export-from-original for keyed clips; this step's
  crop comparison uses the export-mode stage frame, not a real proxy-based
  export.

## Step 6 — WP8 export fidelity + WP9 performance

Carry-over from the Step 5 review: Crop is now filtered out of the
adjustment-layer add-effect menu, the same way Ultra Key is. Wipe and Torn Edge
are unchanged (pre-existing).

WP8 makes a video clip that carries Ultra Key seek its ORIGINAL during export
instead of the short-GOP H.264 seek proxy. WP9 adds per-layer `applyEffects`
timing next to the live FPS and in the export timing log, then measures the
preview and export targets. Both targets were met, so none of the note's three
optimisations were applied.

### Files changed

- `src/components/Inspector.tsx` — the adjustment layer's `EffectsSection` now
  passes `excludeKinds={["ultrakey", "crop"]}` (line 3768).
- `src/lib/exportSource.ts` (new) — `keyedVideoSources(layers)` returns the video
  source paths whose layer (or a layer inside a group) carries `ultrakey`.
- `src/App.tsx` — WP8: `clipSrcs` filters out `keyedSrcs` before building the
  seek proxies (3306-3324). WP9: `resetEffectTiming()` at play start (896) and
  export render start (3338); `[preview timing]` once/s next to the FPS meter
  (925); the `[export timing]` object gains `effectS`, `effectCalls` and
  `effectByStack` (3722-3743).
- `src/lib/effects.ts` — `applyEffects` times every call and records the layer's
  effect-kind stack. New `resetEffectTiming`, `effectTiming` (totals since reset,
  grouped by stack) and `effectTimingWindow` (last second, for the FPS log);
  exposed on the dev `window.__sefxFx` bridge. No rendering change.
- `test/export-source.test.ts` (new) — five tests for the keyed-source rule.

No Rust changes; `cargo test` regenerated the bindings unchanged.

### Tests added

`test/export-source.test.ts`:

- a top-level video with `ultrakey` is included;
- a video with only a colour filter is excluded;
- a keyed video inside a group is found;
- a shared source path used by both a keyed and an unkeyed layer stays original;
- a frame-grid cell's `ultrakey` is not treated as a video source.

The WP8 and WP9 "done when" conditions are measured in the app, not unit tests.

### Checks

Red: none. The two done-when conditions are measurements, not unit tests, and
the new keyed-source vitest passed on its first run.

Green (final):

- `npm test`: `Test Files  21 passed (21)` / `Tests  421 passed (421)` (Step 5
  ended at 416; +5).
- `npx tsc --noEmit`: no output, exit 0.
- `cargo test` inside `src-tauri/`: `280 passed; 0 failed; 7 ignored; 0 measured;
  0 filtered out` plus the two 0-test targets; only the pre-existing ts-rs
  serde-attribute warnings. Bindings regenerated, no diff.
- `node docs/ultra-key-reference.mjs`:
  `key colour -> [ 174, 174, 174, 0 ]  skin -> [ 225, 170, 140, 255 ]  grey -> [ 128, 128, 128, 255 ]  50% edge -> [ 202, 181, 134, 207 ]`
  / `self-check done`, exit 0.

### Live setup

No clip path was supplied for this session, so the note's fallback was used: `green.mp4`,
1080×1920, 30 fps, 4 s, a moving soft-edged skin-coloured shape over `#28c83c`,
H.264 `yuv420p`, CRF 18, GOP 30, no audio. A second clip, `bg.mp4`, is a
1080×1920 H.264 `yuv420p` CRF 18 `testsrc2` background.

The browser decodes that green as **(29, 176, 56)**, not the nominal
`#28c83c` (the H.264 colour matrix is interpreted differently by Chromium vs
ffmpeg's PNG output). The key colour used in the project is the
browser-decoded `(29,176,56)` — the value the editor and the keyer actually see.
(With the nominal `(40,198,59)` the matte stayed semi-transparent: alpha 44 on
the flat green at 1080.)

Measurement path:

- **Preview frame**: `render_preview(t=1000 ms, resolution 1080)` — the editor's
  renderer at pixel ratio 1, 1080×1920, with no export proxies installed.
- **Frame handed to the encoder**: a `VideoFrame` proxy installed in the page
  captured the exact canvas passed to `new VideoFrame(canvas, {timestamp})` at
  `tUs = 999,990` (frame 30 at 30 fps = 1000 ms) during a real fast-mode H.264
  export. The captured canvas is **1836×3264** (the export stage is DPR-scaled,
  devicePixelRatio 1.7), and the encoder config is 1080×1920; the metrics below
  compare once-downscaled 1080×1920 pixels so both sides are the same size.
- Comparison: all 2,073,600 pixels; RGB is premultiplied (`rgb × alpha/255`)
  before differencing. "Edge band" = pixels with strict partial alpha in either
  frame.

### WP8 — preview vs encoder (proxy → original)

| Metric | BEFORE (proxy) | AFTER (original) |
|---|---|---|
| alpha mean | 0.0582 | **0.0142** |
| alpha p99 | 2 | **1** |
| alpha max | 10 | **3** |
| premultiplied RGB mean | 0.0473 | **0.0133** |
| premultiplied RGB p99 | 1.7216 | **0.7216** |
| premultiplied RGB max | 7.6157 | **2.9569** |
| edge-band premultiplied RGB mean | 0.9644 | **0.2872** |
| edge-band premultiplied RGB p99 | 4.0471 | **1.5373** |
| edge-band premultiplied RGB max | 7.6157 | **2.9569** |

Alpha populations were essentially unchanged (preview 1,517,962 zero / 471,294
full / 84,344 partial; encoder 1,517,420 / 469,928 / 86,252 before, and
1,517,465 / 470,205 / 85,930 after), so the change is edge fidelity, not matte
coverage.

The AFTER residual is not source mismatch: the encoder canvas is 1836×3264 and
the comparison downscales it to 1080×1920, while the preview is rendered at
1080×1920 directly. The proxy adds about **4× the alpha mean** and **3.4× the
edge-band RGB mean** on top of that resampling floor.

Seek/export cost for the keyed clip, both cold (proxy cache cleared before the
run), 120 frames at 1080×1920, fast mode:

| | BEFORE (proxy) | AFTER (original) |
|---|---|---|
| `totalS` | 2.9 | 3.0 |
| `proxyS` | 0.5 | 0 |
| `videoSeekS` | 0.9 | 1.2 |
| `evaluateS` | 1.1 | 1.2 |
| `fpsAchieved` | 51.3 | 42.8 |
| MCP wall time | 2.98 s | 3.01 s |

The original costs 0.3 s more per-frame seeking but saves the 0.5 s one-time
proxy encode, so cold it is +0.1 s (3.4%); with a warm proxy cache the proxy
would be ~0.3 s faster per export. That is **not clearly worse**, so the note's
intra-only near-lossless proxy fallback was not implemented. The fidelity gain
above is the reason WP8 exists.

### WP9 — targets and measurements

Instrumentation (no optimisation applied):

- `applyEffects` cost per layer per call, totalled by that layer's effect stack,
  reset at play/export start.
- Live log: `[preview timing]` once a second with `fps` and the last second's
  effect totals (`{ ultrakey: ms }` for the keyed layer).
- Export log: the existing `[export timing]` object now carries `effectS`,
  `effectCalls` and `effectByStack` (seconds per stack).

**Preview fps** — 1080×1920 @ 30 fps comp with `bg.mp4` plus `green.mp4` with
Ultra Key, normal preview quality, no selection/overlays, playing from the
normal transport. Sixteen 0.5 s samples after a 1.5 s warm-up:

`47, 60, 48, 60, 61, 60, 61, 60, 60, 60, 60, 60, 60, 60, 58, 54` fps —
median **60**, sustained **60** after the first warm-up samples, minimum **47**
(the first sample). The target is a steady 30 fps, so the target is **met**.

The Ultra Key layer cost **81.2–105.5 ms per 1 s window at 60 calls/s**, i.e.
**1.35–1.76 ms per applyEffects call**. The background layer has no effects and
does not enter the timing.

**Export time, keyed vs unkeyed** — same 1080×1920 @ 30 fps, 4 s, 120 frames,
fast mode, normal export state (paused, no overlays), background + green clip;
the keyed project has Ultra Key on the green clip, the unkeyed project is the
same two layers with the effect removed. Cold runs clear the seek-proxy cache;
warm runs reuse it.

| Run | totalS | fpsAchieved | proxyS | videoSeekS | effectS | effectCalls |
|---|---|---|---|---|---|---|
| keyed, cold | 3.4 | 45.3 | 0.6 | 1.3 | 0.5 | 388 |
| unkeyed, cold | 2.8 | 61.1 | 0.7 | 0.9 | 0 | 0 |
| keyed, warm | 2.9 | 45.5 | 0 | 1.4 | 0.5 | 385 |
| unkeyed, warm | 2.3 | 57.6 | 0 | 1.0 | 0 | 0 |

Ratio, keyed ÷ unkeyed: **1.21×** cold and **1.26×** warm by `totalS`
(45.5 vs 57.6 fps = 1.27× by achieved fps). The target is ≤ 1.5×, so the
target is **met** and no optimisation was applied.

Observation for later: the keyed layer's `applyEffects` runs **~3.2 times per
exported frame** (385–388 calls for 120 frames), i.e. the export still draws the
stage more than once per frame. Since the target is met this was left alone, but
this is the note's optimisation #3 (drop the duplicate stage draw) and is the
obvious next performance win if a future project misses the target.

### Where the note's references are now

| Note reference | Actual location now |
|---|---|
| WP8 seek proxy | `src-tauri/src/lib.rs:6674` `make_seek_proxy`; installed at `App.tsx:3306-3324` |
| WP8 keyed-clip rule | `src/lib/exportSource.ts:13` `keyedVideoSources`; used at `App.tsx:3306` |
| WP8 encoder frame | `src/lib/deterministicExport.ts:306` `new VideoFrame(canvas, …)`; canvas from `App.tsx:3238` |
| WP9 `applyEffects` timing | `src/lib/effects.ts:268` `applyEffects`, `:284` timer, `:365` record; `:399-430` totals/window |
| WP9 preview FPS | `src/App.tsx:886-932` play/tick; `[preview timing]` at `:925` |
| WP9 export timing log | `src/App.tsx:3726` `perf`, `:3743` `console.info("[export timing]", perf)` |
| Carry-over | `src/components/Inspector.tsx:3768` |

### Differences from the note, and why

- **WP8 proof method.** Per the user, the Premiere goldens were not used this
  step. The proof is the preview frame vs the exact `VideoFrame` canvas handed to
  the encoder at the same comp time, before (proxy) and after (original).
- **Comparison size.** The encoder canvas is DPR-scaled (1836×3264 for a
  1080×1920 comp at devicePixelRatio 1.7); it is downscaled once to 1080×1920 so
  it can be compared with the 1080×1920 preview frame. The BEFORE/AFTER
  comparison is apples-to-apples; the AFTER residual is that resampling, not a
  different source.
- **Key colour.** Sampled from the browser-decoded clip (29,176,56), not the
  nominal `#28c83c`; this is the colour the editor and keyer see. Keying with the
  nominal value left the background at alpha 44.
- **No near-lossless fallback proxy.** The original was +0.1 s cold and the
  fidelity improved by ~4×; not "clearly worse".
- **No WP9 optimisation.** Both targets were met (60 fps preview; 1.21–1.26×
  keyed export), so the note's three ordered optimisations were deliberately not
  applied.
- **Per-layer cost key.** `applyEffects` does not know the layer id, so the
  export log groups cost by the layer's effect stack (`ultrakey`, etc.). That is
  the layer-level number the note asks for; a layer with no effects never enters
  `applyEffects`.
- **Carry-over scope.** Crop is hidden from the adjustment add menu only.
  Existing adjustment layers with a Crop still show the row (like an existing
  Ultra Key) and are still ignored by `AdjustmentNode`.

### Open questions

- The export stage canvas is DPR-scaled: a 1080×1920 comp exports through a
  1836×3264 canvas that the encoder downscales. This explains the AFTER residual
  and is a pre-existing fidelity/performance cost, not part of WP8/WP9. Forcing
  the export stage to pixel ratio 1 is a plausible future fix; the note does not
  ask for it.
- The keyed-source rule works per source path: if an unkeyed layer shares a path
  with a keyed one, the unkeyed layer also seeks the original (slower, correct).
- The duplicate stage draw (≈3.2 `applyEffects` calls per exported frame) is the
  note's optimisation #3. It was not applied because the target was met; it is
  the first thing to try if a heavier keyed project misses 1.5×.
- A near-lossless intra-only proxy for keyed clips was not needed on this PC. If
  keyed exports on slower media become "clearly worse", add it then (the note's
  fallback), not now.

## Step 7 — WP6 Animated Key Colour

Ultra Key's Key Colour is now a keyframe list on the effect (`keyColorKeys`), sampled
in Rust at the same `t_ms` as the 16 numeric Tracks. It moves with the clip and with
`move`/`delete`/`clear` keyframe commands, shows on the Timeline, is edited by a
`ColorKeyField`, and the eyedropper writes a key at the playhead when the list is
active (static write when it is empty).

### Files changed

- `src-tauri/src/model.rs` — `Effect::UltraKey` gains
  `key_color_keys: Vec<ColorKey>` with `#[serde(default, rename = "keyColorKeys")]`;
  `default_of("ultrakey")` starts it empty. Old projects load unchanged.
- `src-tauri/src/eval.rs` — `ResolvedEffect::UltraKey` carries the raw
  `keyColorKeys` next to the sampled `keyColor`; `resolve_effect` now calls
  `sample_color(key_color_keys, *key_color, t_ms)`. `ResolvedEffect` no longer
  derives `Copy` (it holds a `Vec` now).
- `src-tauri/src/lib.rs` — `for_each_color_keys_mut` walks layer effects,
  frame-grid `cells[].effects` and `linked[].effects` via the new
  `walk_effect_color_keys`; the per-cell Timeline commands now use
  `for_each_cell_color_keys_mut` / `move_cell_keys` / `delete_cell_keys` so a
  dragged/deleted cell diamond includes the Key Colour key; added
  `set_ultrakey_color_key` / `clear_ultrakey_color_keys` and cell variants,
  registered them, and added seven tests (below).
- `src/bindings/Effect.ts`, `src/bindings/ResolvedEffect.ts` — regenerated by
  `cargo test`; both carry `keyColorKeys` (`Effect.ts:44`, `ResolvedEffect.ts:14`).
- `src/lib/api.ts` — `setUltraKeyColorKey`, `clearUltraKeyColorKeys`,
  `setCellUltraKeyColorKey`, `clearCellUltraKeyColorKeys`.
- `src/App.tsx` — layer and cell handlers for the new commands; the eyedropper
  decides between `set_ultrakey_color_key` (list non-empty) and the existing
  `set_ultrakey_static` (list empty) at `App.tsx:2480`.
- `src/components/Timeline.tsx` — the Ultra Key branch of `pushEffectTracks` adds
  `out.addColorKeys(e.keyColorKeys, "effect")` (`Timeline.tsx:109`).
- `src/components/Inspector.tsx` — the Ultra Key row uses `ColorKeyField` for Key
  Colour (`Inspector.tsx:2239`) and keeps the ⌖ pipette beside it; `timeMs` and
  the colour-key callbacks are threaded through `EffectsSection`, `EffectRow`,
  `FrameGridSection` and `LinkedEffectsSection` (cells use the cell commands).
- `src/components/EffectEditor.tsx` — receives `timeMs` and the colour-key
  callbacks, so its reused `EffectsSection` works the same way.
- `src/App.css` — `.insp-color-row > .an-num` lets the ColorKeyField fill the row
  with the pipette at its right.
- `src/components/Preview.tsx` — WP5 carry-over fix: `layerSource` looked up the
  image decode cache by the layer's stored path, but `ImageNode`/`EffectImageNode`
  cache by `images[k.src]` (the resolved data URL), so picking on an image
  returned null. It now takes the `images` map and looks up the data URL
  (`Preview.tsx:347/3465`). Required for the Step 7 image eyedropper check;
  verified live below.
- `test/stack-order.test.ts` — the Ultra Key `ResolvedEffect` fixture gains
  `keyColorKeys: []` (type completeness).

### Tests added

Rust (`cargo test`, +7):

- `old_projects_load_without_key_colour_keys` (`lib.rs:9172`) — a keyed effect
  serializes `keyColorKeys` and round-trips; removing the field from the JSON
  loads with an empty list and the static colour intact (the Steps 2–6 project
  case).
- `moving_a_clip_shifts_the_key_colour_keys_with_the_numeric_keys` (`lib.rs:9194`)
  — transparency and colour keys at 1000 ms both move to 1500 ms on
  `shift_layer_time(+500)`, with the range at 500–3500.
- `deleting_the_keyframe_at_a_time_removes_the_key_colour_key` (`lib.rs:9204`) —
  `delete_layer_keys_at(2000)` removes both the numeric and colour key.
- `clearing_the_keyframes_freezes_the_key_colour_at_the_playhead`
  (`lib.rs:9213`) — A@0/B@2000, clear at 1000 → static `(50,159,50)` and an empty
  list.
- `key_colour_keys_in_cell_and_linked_stacks_move_with_the_clip` (`lib.rs:9225`)
  — proves `for_each_color_keys_mut` reaches `cells[].effects` and
  `linked[].effects`, not only `layer.effects`.
- `cell_keyframe_drag_and_delete_include_the_key_colour_key` (`lib.rs:9254`) —
  `move_cell_keys(1000→1200)` moves the cell's numeric and colour keys together;
  `delete_cell_keys(2000)` removes both.
- `ultra_key_key_colour_is_sampled_at_the_playhead` (`eval.rs:1703`) — resolved
  colours A at 0, `(50,159,50)` at 500 and B at 1000; an empty list resolves to
  the static `(1,2,3)`.

### Checks

Red (tests written first, model field not yet added):

```
$ cargo test ultrakey
error[E0026]: variant `model::Effect::UltraKey` does not have a field named `key_color_keys`
  --> src\lib.rs:9023:46
error[E0026]: variant `model::Effect::UltraKey` does not have a field named `key_color_keys`
  --> src\lib.rs:9032:46
...
error: could not compile `simple-effects` (lib test) due to 12 previous errors
```

(12 errors from the new test sites and their helpers; the final suite has seven
new tests.) The first green run also exposed `E0204: Copy cannot be
implemented` after the `Vec` field was added; `Copy` was dropped from
`ResolvedEffect` (it is cloned).

Green (final):

- `npm test`: `Test Files 21 passed (21)` / `Tests 421 passed (421)` (Step 6
  ended at 421; the new code is covered by the Rust tests and the live checks,
  no vitest file was added).
- `npx.cmd tsc --noEmit`: no output, exit 0.
- `cargo test` inside `src-tauri/`: `287 passed; 0 failed; 7 ignored; 0 measured;
  0 filtered out` (Step 6 ended at 280; +7), plus the two 0-test targets. Only the
  pre-existing ts-rs serde-attribute warnings. Bindings regenerated with
  `keyColorKeys` in `Effect.ts` and `ResolvedEffect.ts`.
- `node docs/ultra-key-reference.mjs`:
  `key colour -> [ 174, 174, 174, 0 ]  skin -> [ 225, 170, 140, 255 ]  grey -> [ 128, 128, 128, 255 ]  50% edge -> [ 202, 181, 134, 207 ]`
  / `self-check done`, exit 0.

### Live checks (§5)

Setup: debug exe (rebuilt) + `npm run dev`, CDP on 9222 and the MCP bridge on 8787.
Comp 480×360 @ 30 fps, 4000 ms, one image layer (480×360 PNG), one Ultra Key,
Output Composite, Setting Default. The PNG has two uniform green patches, written
by ffmpeg as **A = (40,198,59)** (left) and **B = (43,121,72)** (right); those
decoded bytes are the values used as the keys. The layer was moved to 500–3500 ms
with the project's normal `set_layer_time` (a pure move, so keys shift).

Keyframe and value checks (backend `get_project` / `evaluate_at`, and the app's
own per-layer `applyEffects` on the source PNG for alpha):

| Time | Key Colour keys | Resolved key colour | Patch A RGBA | Patch B RGBA |
|---|---|---|---|---|
| 500 (start) | 500 = A, 2500 = B | `(40,198,59)` | `0,0,0,0` | `61,70,76,185` |
| 1500 (middle) | same | `(42,160,66)` | `255,255,231,21` | `62,70,73,132` |
| 2500 (end) | same | `(43,121,72)` | `153,234,85,120` | `0,0,0,0` |

The middle is the blend: sRGB midpoint of A and B is `(41.5, 159.5, 65.5)`,
rounded by `blend_rgba` to `(42,160,66)`. Patch A is transparent at the start and
patch B at the end (alpha 0). The non-matching patch is only partly keyed (185 /
120) because the two greens are close in chromaticity at the default preset; the
done-when only asks for the matching patch.

Before the move the same project had keys at 0 and 2000 and measured exactly the
same: resolved 0 = `(40,198,59)`, 1000 = `(42,160,66)`, 2000 = `(43,121,72)`;
patch A alpha 0 at 0, patch B alpha 0 at 2000.

Timeline (`keyframeTimes` DOM in the live app):

| State | Layer range | Key times | `.tl-kf` left positions |
|---|---|---|---|
| Before move | 0–3000 | 0, 2000 | `0%`, `66.6667%` |
| After move | 500–3500 | 500, 2500 | `0%`, `66.6667%` |

The two diamonds stayed in the same position inside the block (same 0% /
66.6667%), and both times shifted by exactly +500 ms with the clip. Their
background is `rgb(125, 140, 255)`, the Timeline's `"effect"` family colour.

Inspector (live DOM): the Ultra Key row shows `Key Colour` with the `◆`
stopwatch reading "Keyframed (2) — click to freeze at this colour", the swatch
`#28c63b` at the playhead, and the ⌖ button `aria-label="Pick Key Colour"`
enabled.

Eyedropper, keyed list (playhead 1500 ms, stage point `(1098.2895, 321.6539)`
mapped by the layer's absolute transform to local `(359.70,179.35)`, source
`(360,180)` = patch B):

- Before: keys `500 A, 2500 B`; resolved at 1500 `(42,160,66)`; swatch `#2aa042`.
- After the pick: keys `500 A, 1500 B, 2500 B`; resolved at 1500 `(43,121,72)`;
  pick mode cleared (`picking` 1 → 0); swatch `#2b7948`.
- One undo removed the 1500 key (back to `500 A, 2500 B`); one redo restored it.
  The pick is one undo step.
- The two-key animation was then restored for the checks above.

Eyedropper, empty list: after `clear_ultrakey_color_keys`, a pick on the same
source pixel left `keyColorKeys` at 0 keys, changed the static `keyColor` to
`(43,121,72)`, and the resolved key colour and swatch became `#2b7948`; pick mode
cleared. This is the old static write.

### Where the note's references are now

| Note reference | Actual location now |
|---|---|
| WP6 model `key_color` + `key_color_keys` | `model.rs:1324` (`#[serde(default, rename = "keyColorKeys")]`), `model.rs:1445` in `default_of` |
| WP6 `sample_color` in `resolve_effect` | `eval.rs:569` resolved field, `eval.rs:690` `sample_color(...)`, `eval.rs:691` passes the list to the Inspector |
| WP6 `for_each_color_keys_mut` three stacks | `lib.rs:6975`; effect walker `lib.rs:7013`; shift/delete/clear at `lib.rs:6966/7693/7714`; per-cell keyframe drag/delete at `lib.rs:5815/5832/5862` |
| WP6 set/clear commands | `lib.rs:5261` `set_ultrakey_color_key`, `lib.rs:5290` `clear_ultrakey_color_keys`; cell variants `lib.rs:5506/5531`; registered at `lib.rs:7975/7976/8005/8006` |
| WP6 `ColorKeyField` | `Inspector.tsx:2216` handler, `Inspector.tsx:2239` field, pipette button at `Inspector.tsx:2255` |
| WP6 `out.addColorKeys` | `Timeline.tsx:109` |
| WP5 pick path | `App.tsx:2466` `onKeyColorPicked`, `App.tsx:2480` keyed/static branch; `Preview.tsx:3465` pick mapping |
| WP5 image source cache fix | `Preview.tsx:347` `layerSource(layer, imageUrls)` |
| bindings | `src/bindings/Effect.ts:44`, `src/bindings/ResolvedEffect.ts:14` |

### Differences from the note, and why

- **The key list rides on `ResolvedEffect`.** The Inspector is handed
  `ResolvedEffect[]` (sampled values), not the model's `Effect[]`, so the raw
  `keyColorKeys` is included next to the sampled `keyColor`. That required
  dropping `Copy` from `ResolvedEffect`; every use clones. `Effect` still has the
  list in the saved project.
- **No `seed_start` on `set_ultrakey_color_key`.** The note says "a set/clear
  command shaped like `set_text_color`", but the WP6 done-when and the
  `ColorKeyField`/pick both write exactly one key at the playhead. Seeding a key
  at the clip start would turn every pick on an active list into two keys, so the
  command only upserts at `t_ms` (and, like `set_text_color`, keeps the static
  colour in sync with the first key).
- **Cell variants.** Ultra Key exists on frame-grid cells, and the Ultra Key row
  is shared; without `set_cell_ultrakey_color_key` /
  `clear_cell_ultrakey_color_keys` a cell's ColorKeyField would change nothing.
  Linked groups still do not offer Ultra Key, so no linked command was added;
  `for_each_color_keys_mut` still walks any legacy linked Ultra Key keys.
- **WP5 image cache fix.** `layerSource` used `imgCache.get(k.src)`, while the
  image nodes cache by `images[k.src]` (the data URL from `load_image_data_url`).
  Image picks therefore returned null; passing the `images` map fixes it. This is
  a Step 4 carry-over needed for the Step 7 image eyedropper check, verified live.

### Anything broken / worth pointing out

- Setting Output or Setting while the Key Colour list is active still goes
  through `set_ultrakey_static`, which rewrites the static `key_color` with the
  value sampled at the playhead. The list takes precedence in the resolver, so
  this does not change the render; it only changes the fallback used after the
  last key is removed without the clear command.
- The Timeline marks all Ultra Key colour keys with the `"effect"` family colour
  (as the step asks), so they are not visually distinguished from the 16 numeric
  tracks.

### Open questions

- Should `set_ultrakey_static` stop writing `key_color` when `keyColorKeys` is
  non-empty (leave the static fallback alone)? Resolved in Step 8: it now leaves
  the fallback alone.
- Should Timeline colour keys use a distinct family colour from numeric effect
  keys? The step explicitly specifies `"effect"`.

## Step 8 — WP10 tooltip, Step 7 carry-over, and §13 acceptance test

The Step 7 carry-over and WP10 tooltip are done. The §13 acceptance test was run
against the supplied `G:\Workspace\Simple_Effects\ultra-key-goldens` folder:
1280×720 at 30 fps, frame 60 = 2000 ms, key colour **0,255,1** typed in (never
re-picked), background below and green above. The two source-control frames match
our decode within 2/255 in both preview and export. Case (a) preview passes;
case (a) export misses the 2/255 mean bar by 0.11/0.08 in R/B after the one
VideoFrame-canvas downscale. Cases (b) and (c) fail because the **oracle's
Contrast formula is wrong**: a fully keyed flat green (matte 0) becomes matte 127
with Contrast 10/30. The app's shader currently carries the same formula, so the
app and oracle agree with each other and disagree with the goldens. Per the step's
instruction, the oracle was **not edited**, no shader constants were tuned, and
the acceptance run stopped here. Details and the results tables are below.

### Files changed

- `src-tauri/src/lib.rs` — new `write_ultrakey_static` helper
  (`lib.rs:5225`). `set_ultrakey_static` (`lib.rs:5247`) and the cell variant
  `set_cell_ultrakey_static` (`lib.rs:5491`) now leave `key_color` alone while
  `key_color_keys` is non-empty, keeping the static fallback equal to the first
  key as with text colour; Output and Setting still change. +1 Rust test.
- `src/components/Inspector.tsx` — the Ultra Key Inspector hint now carries the
  note's WP10 tooltip: soft edges blend in sRGB, so to match Premiere, raise
  **Soften** slightly or turn off **Composite in Linear Color** in the Premiere
  sequence (`Inspector.tsx:2303`).
- `src/App.tsx` — `applyTime` now returns its resolved map, and `renderFrames`
  calls `seekVideosForFrame` for every visible video at each preview time before
  painting (`App.tsx:710` / `App.tsx:1292`). Without this, `render_preview` could
  capture the pooled video's previous frame (the green source control initially
  measured 17.3/26.6/14.9 mean against the control PNG). This is a real preview
  bug, not a shader change; after the fix case (a) preview matches the oracle on
  the same source pixels.
- `src/shaders/ultraKeyFinal.frag` — **not edited in this step**. Its
  `contrastMatte` at line 24 uses `max(0, shifted) + M`, the same wrong formula
  as the oracle (see the acceptance finding).

### Tests added

Rust (`cargo test`, +1): `static_setter_keeps_the_key_colour_while_the_list_is_active`
(`lib.rs:9204`):

- a keyed effect whose fallback is A: `write_ultrakey_static(B, output 2,
  setting 1)` leaves the fallback at A and writes Output/Setting;
- the same call on an unkeyed effect writes the static colour (so a project
  without Key Colour keys keeps the old static edit);
- the cell command uses the same helper, so it has the same rule.

### Checks

Red (test written first, two fixture errors before the final assertion):

```
test ultrakey_tests::static_setter_keeps_the_key_colour_while_the_list_is_active ... FAILED
thread ... panicked at src\lib.rs:9211:9:
assertion `left == right` failed: the fallback stays the first key
```

The fixture's static `key_color` was still the model default black; the real key
command syncs it to the first key, so the test now sets A before calling the
setter. The next run failed on the unkeyed branch:

```
test ultrakey_tests::static_setter_keeps_the_key_colour_while_the_list_is_active ... FAILED
thread ... panicked at src\lib.rs:9225:9:
assertion `left == right` failed
  left: (60, 120, 40)
 right: (43, 121, 72)
```

`green_b()` in this module is `(60,120,40)`; `(43,121,72)` was the live Step 7
patch B. The expected value was corrected to the helper's colour; the guard code
itself was unchanged between these runs.

Green (final):

- `npm test`: `Test Files 21 passed (21)` / `Tests 421 passed (421)`.
- `npx.cmd tsc --noEmit`: no output, exit 0.
- `cargo test` inside `src-tauri/`: `288 passed; 0 failed; 7 ignored; 0 measured;
  0 filtered out` (Step 7 ended at 287; +1), plus the two 0-test targets. Only the
  pre-existing ts-rs serde-attribute warnings; no binding diff (the model did not
  change).
- `node docs/ultra-key-reference.mjs`:
  `key colour -> [ 174, 174, 174, 0 ]  skin -> [ 225, 170, 140, 255 ]  grey -> [ 128, 128, 128, 255 ]  50% edge -> [ 202, 181, 134, 207 ]`
  / `self-check done`, exit 0.

### §13 acceptance test — setup, controls and results

`note.txt` was read first. It specifies 1280×720, 30 fps, frame 60 = **2000 ms**,
key colour **(0,255,1)**, V1 `background.mp4` at 0 (10 s), V2 `green.mp4` at 0
(9.832 s), and the five case settings. The project was built at 1280×720/30 fps
with both layers starting at 0, background below green. The key colour was typed
via `add_effect keyColor:"#00ff01"`; the eyedropper was not used.

**Source controls** (our own decode vs the two control PNGs), mean |Δ| R/G/B in
0–255 units:

| Control | Source | Mean R/G/B | Pixels | Result |
|---|---|---|---|---|
| background | preview | 0.445 / 0.136 / 0.538 | 921,600 | pass ≤2 |
| background | export | 1.419 / 1.187 / 1.488 | 921,600 | pass ≤2 |
| green | preview (after fix) | 1.381 / 1.458 / 1.297 | 921,600 | pass ≤2 |
| green | export | 1.403 / 1.462 / 1.334 | 921,600 | pass ≤2 |

The first green **preview** control was 17.33 / 26.59 / 14.85, not a decode
problem: `render_preview` captured the pooled video before its seek. The
`renderFrames` seek fix above makes the preview wait for the seek; the after-fix
row is the decode check.

**Measurement path.** Preview: `render_preview(t=2000 ms, resolution 720)` at
1280×720 on the editor stage (export mode, pixel ratio 1). Export: the exact canvas
passed to `new VideoFrame(canvas, {timestamp})` during a real WebM export; a proxy
captured frame 60 at timestamp **1,999,980 µs**. The canvas is **2176×1224**
(devicePixelRatio 1.7); it was downscaled **once** to 1280×720 with the
browser-default `drawImage` (the Step 6-style single downscale). For case (a) the
high-quality smoothing variant is shown too. Metrics: mean |Δ| per channel over
all 921,600 pixels against the linear-off golden; alpha p99 for (e) is the matte
(R) p99 against `e-alpha`. Pass = each mean ≤2/255, and for (e) alpha p99 ≤8/255.

**Per-case results** (one row per case and source):

| Case | Source | Mean R | Mean G | Mean B | α p99 | Pass |
|---|---|---|---|---|---|---|
| a-default | preview | 1.5955 | 1.2400 | 1.5847 | — | **pass** |
| a-default | export | 2.1069 | 1.7826 | 2.0799 | — | **fail** R/B (high-quality: 2.2227 / 1.9163 / 2.1883) |
| b-aggressive | preview | 66.1447 | 66.7336 | 67.2717 | — | fail (oracle contrast bug) |
| b-aggressive | export | 64.0543 | 64.6306 | 65.2680 | — | fail (oracle contrast bug) |
| c-cleanup | preview | 66.2467 | 66.8259 | 67.3696 | — | fail (oracle contrast bug) |
| c-cleanup | export | 64.1111 | 64.6676 | 65.3167 | — | fail (oracle contrast bug) |
| d-color | preview | 9.0723 | 9.0287 | 8.4181 | — | **invalid** (stale pooled video after prior exports; control 11.77 >2) |
| d-color | export | 2.2892 | 1.9949 | 2.0556 | — | **fail** R/B |
| e-alpha | preview | — | — | — | — | not run (stopped at the oracle miss) |
| e-alpha | export | — | — | — | — | not run (stopped at the oracle miss) |

The app keyer on the control source (1280×720, no video/decode) gives (e)
0.0934/0.0934/0.0934 and matte p99 1, and (d) 0.118/0.140/0.150; those pass. The
(d) preview row above is not a keyer result: it was rendered after four exports,
and the preview's pooled video was stale (the source controls prove the decode).

**Background-only control** (pixels where our matte α = 0), mean |Δ| R/G/B:

| Case | Source | Mean R/G/B | Pixels | Note |
|---|---|---|---|---|
| a-default | preview | 0.5132 / 0.1788 / 0.6212 | 594,053 | ≤2 |
| a-default | export | 1.3120 / 1.0287 / 1.3987 | 592,625 | ≤2 |
| b-aggressive | preview/export | — | 0 | no α=0 pixels: contrast bug |
| c-cleanup | preview/export | — | 0 | no α=0 pixels: contrast bug |
| d-color | preview | 11.7696 / 11.8731 / 11.2020 | 594,083 | **invalid**, stale video (source controls pass) |
| d-color | export | 1.3151 / 1.0318 / 1.4015 | 592,625 | ≤2 |
| e-alpha | preview/export | — | — | not run |

The export control for (a) is under 2, so the (a) export miss is not background
decode/keyer; it is the 2176→1280 single downscale (preview control 0.51 vs export
control 1.31). The oracle on the same **app-decoded source** at 1280×720 gives
1.5945 / 1.2400 / 1.5842, which passes.

**Linear-on edge band** (our matte strictly 0 < α < 255), mean R/G/B and p99
R/G/B:

| Case | Source | Mean R/G/B | p99 R/G/B | Pixels |
|---|---|---|---|---|
| a-default | preview | 4.7438 / 4.2410 / 4.4173 | 53 / 51 / 51 | 87,777 |
| a-default | export | 4.9883 / 4.4374 / 4.5909 | 57 / 55 / 54 | 89,605 |
| b-aggressive | preview | 99.6782 / 100.7456 / 101.4869 | 188 / 194 / 188 | 601,039 |
| b-aggressive | export | 96.2813 / 97.3234 / 98.2167 | 114 / 114 / 115 | 602,462 |
| c-cleanup | preview | 99.0935 / 100.1189 / 100.8916 | 188 / 194 / 188 | 606,166 |
| c-cleanup | export | 95.6416 / 96.6251 / 97.5615 | 114 / 114 / 115 | 607,637 |
| d-color | preview | 5.8307 / 5.3581 / 4.9041 | 68 / 66 / 64 | 87,651 (stale frame) |
| d-color | export | 5.8081 / 5.3354 / 4.8630 | 66 / 65 / 62 | 89,605 |
| e-alpha | preview/export | — | — | not run |

For (b)/(c) the contrast bug makes the flat green matte 127, so the "edge band"
is ~600k pixels (65% of the frame) and these edge numbers are not a useful WP10
comparison.

**Oracle finding — the run stops here.** `docs/ultra-key-reference.mjs` line 131
is:

```js
a = Math.min(255, Math.max(0, Math.trunc((a - M) * (p.contrast * 1024 + 1024)) >> 10) + Math.trunc(M));
```

`Math.max(0, shifted)` clamps only the shifted term, before adding `M`. The note
§8 formula is `clamp(((α − 255M)·(1024 + 1024C) >> 10) + 255M, 0, 255)`, i.e. the
whole sum is clamped. On a 16×16 flat-green crop of
`control-green-source.png` (the same source pixels), keyed with `(0,255,1)`:

| Oracle run | Matte at centre | Golden |
|---|---|---|
| Contrast 0 | 0 | 0 |
| Contrast 0.10 (b) | **127** | 0 |
| Contrast 0.30 (c) | **127** | 0 |

The app's `src/shaders/ultraKeyFinal.frag` `contrastMatte` has the same
`max(0, shifted) + M` pattern, so the app and oracle reproduce the same wrong
matte; the goldens have 0. The oracle also matches the (a) linear-off golden
0.024/0.012/0.013 on the control source, so it is specifically the
Contrast > 0 path that is wrong. Per the step: the oracle was **not edited**, no
shader constants were tuned, and the acceptance run stopped. The next session
must fix the oracle first (clamp the whole sum), then align the shader, then
rerun (b)/(c) and the remaining rows.

### Where the note's references are now

| Item | Actual location now |
|---|---|
| Static setter guard | `lib.rs:5225` `write_ultrakey_static`; layer command `lib.rs:5247`; cell command `lib.rs:5491` |
| Carry-over test | `lib.rs:9204` |
| WP10 tooltip | `Inspector.tsx:2303` (Ultra Key Inspector hint) |
| Preview video seek | `App.tsx:710` `applyTime` returns the map; `App.tsx:1336` `seekVideosForFrame(targets)` in `renderFrames`; helper `media.ts:296` |
| Contrast formula (app) | `src/shaders/ultraKeyFinal.frag:24` `max(0, shifted) + M` |
| Contrast formula (oracle) | `docs/ultra-key-reference.mjs:131` same clamp error |
| Acceptance test | run; stopped at the oracle's Contrast > 0 bug |

### Differences from the note, and why

- **Both static setters are guarded.** The carry-over names `set_ultrakey_static`;
  the cell variant shares the Ultra Key row and uses the same helper, so leaving
  it unguarded would recreate the fallback overwrite for grid cells.
- **`render_preview` now waits for video seeks.** The note says to render "that
  frame from preview"; the editor's `renderFrames` captured the pooled video
  before its decoder seek (green control 17.33/26.59/14.85). `applyTime` returns
  the resolved map and `renderFrames` calls `seekVideosForFrame` before painting.
  This is a preview correctness fix, not a keyer change; after it, the (a) preview
  matches the oracle on the same source.
- **1280×720, not 1920×1080.** Per the note and the user: the source is 720p, so
  the project and the export downscale target are 1280×720. The export canvas is
  2176×1224 (DPR 1.7) and is downscaled once with the browser-default
  `drawImage`; the high-quality variant is reported for (a).
- **Stopped at the oracle's Contrast bug.** The oracle's line 131 and the app's
  `ultraKeyFinal.frag:24` both clamp the shifted term before adding `M`. The
  note's formula clamps the whole sum. Per the step, the oracle was not edited
  and no shader constants were tuned; the run stopped and this is the report.
  The (a) export miss is separate: the oracle on the same source passes, and the
  export's extra 0.5 mean is the 2176→1280 single downscale.

### Open questions

- Fix `docs/ultra-key-reference.mjs`'s Contrast clamp first (clamp the whole
  sum), then make `ultraKeyFinal.frag` match it, then rerun (b)/(c). Do not tune
  constants before that.
- The (a) and (d) export rows miss the 2/255 mean bar by 0.08–0.29 in R/B after
  the 2176×1224→1280×720 downscale, while their previews (and the oracle on the
  same source) pass. Is the intended export measurement the browser-default
  single `drawImage` (reported here), or should the export stage render at 1× DPR
  for this test? The note says only "downscaled once"; it does not specify the
  filter.
- The (d) preview was rendered after four exports and its pooled video was stale
  (background-only control 11.77 >2). Rerun previews before any export (or fix
  the pool/proxy interaction) when re-running the acceptance.
- The goldens' `e-alpha` exact 0/255 counts (593,219 / 322,263 / 6,118) differ
  from the app/oracle counts (≈593k / 240k / 89k), but the app's e-alpha RGB mean
  against that golden is 0.093 and its edge p99 is 1. The count difference is
  ~1-level quantization (≈83k pixels at 254 instead of 255), not a different
  matte. The (e) alpha-p99 row still needs to be run after the contrast fix.

## Step 8 (continued) — fixed oracle, export at output size, video pool, rerun

The tables in the first Step 8 section are superseded by this one.

### Files changed

- `src/shaders/ultraKeyFinal.frag` — `contrastMatte` now clamps the whole sum, as
  the fixed oracle does: `outv = shifted + int(trunc(M)); clamp(outv, 0, 255)`
  (`ultraKeyFinal.frag:24`).
- `src/lib/ultraKey.ts` — check variant `"contrast"`: a 2×1 frame with one fully
  keyed pixel `(40,200,60,255)` and one opaque skin pixel (`ultraKey.ts:394/408/474`).
- `docs/ultra-key-shader-check.mjs` — new case "contrast 30: one fully keyed pixel
  and one opaque pixel" (`:74`).
- `src/App.tsx` — (1) an effect sets every Konva layer canvas to pixel ratio 1
  while `exporting` and back to the display DPR when it clears, so the canvas
  handed to `new VideoFrame` is exactly the output size (`App.tsx:544`); (2) one
  `videoSeekTargets(p, map, tMs)` helper (`App.tsx:355`) replaces the two ~20-line
  copies in `renderFrames` and the export loop.
- `src/lib/media.ts` — (1) `setSeekProxies` drops every pooled element whose source
  is one of the proxies it just revoked (`media.ts:201`); (2) `seekVideosForFrame`
  also waits out an in-flight seek (`v.seeking`) instead of trusting `currentTime`
  (`media.ts:330`).

### Checks

- `node docs/ultra-key-reference.mjs`: self-check done (now includes Contrast).
- `node docs/ultra-key-shader-check.mjs`: all 9 cases PASS, exit 0, including the
  new contrast case (mean 0/0/0/0, alpha p99 0). It was not run red: the failing
  behaviour (matte 0 → 127) was shown by the previous acceptance run and the oracle.
- `npm test` 421 passed; `npx.cmd tsc --noEmit` clean; `cargo test` 288 passed.

### 2. Export at the output size

First attempt was wrong and is worth knowing: Konva's `Stage` has no `pixelRatio()`
(it threw), and the ratio lives on each layer's canvas, which is also what
`Preview.tsx:518` reads. Fixed by setting the layer canvases.

| | before (Step 6 status) | after |
|---|---|---|
| canvas handed to `new VideoFrame`, 1080×1920 keyed project | 1836×3264 | **1080×1920** |
| same, 1280×720 acceptance project | 2176×1224 | **1280×720** |
| export time, Step 6 keyed project (4 s, 120 frames) | 3.0 s (MCP 3.01 s) | **1.98 s and 1.76 s** |
| editor canvas after a successful export | – | 2604 px / 1532 css = 1.6996 (dpr 1.7) |
| editor canvas after a **failed** export (bad path, ffmpeg error) | – | 1.6996 |

`Preview.tsx:518` is the only reader. At export `k = node scale × 1`, so transition
engines run at the output size rather than 1.7× supersampled; nothing renders below
the output. Not tested live: a user-cancelled export (same `finally` as the failed
one).

### 3. Stale video

Two causes, both reproduced as a wrong first preview, both fixed in `media.ts`:

- A pooled element could keep a revoked proxy blob URL after `setSeekProxies(null)`.
  After an export, then deleting the green layer and previewing the background at
  1 s, 2 s, 3 s: mean R/G/B vs ffmpeg's decode `1.80/1.69/1.80`, `1.87/1.77/1.89`,
  `1.74/1.59/1.73` (decode difference only; a stale frame would be tens).
- After `open_project_file`, with the playhead elsewhere, the first `render_preview`
  was one seek behind: `VideoNode` had already set `currentTime`, so
  `seekVideosForFrame` saw "at target" while `seeking` was true. First preview
  error vs `a-default-linear-off` was **16.48**, then 1.5955 on every later call;
  after the fix the first call is 1.5955.

### 4. Helper

`videoSeekTargets` is called by both `renderFrames` and the export loop; the
acceptance run below exercises both.

### Acceptance rerun (note.txt: 1280×720, 30 fps, frame 60 = 2000 ms, key 0,255,1 typed)

All previews were rendered first, then all exports. Export = the exact
`new VideoFrame` canvas at 1,999,980 µs, **1280×720, no downscale**. Mean |Δ| per
channel vs the linear-off golden over 921,600 px; pass ≤ 2 each, and for (e)
alpha p99 ≤ 8.

Source controls (our decode vs the control PNGs):

| Source | Preview R/G/B | Export R/G/B |
|---|---|---|
| background | 0.445 / 0.136 / 0.538 | 0.845 / 0.509 / 0.950 |
| green | 1.379 / 1.452 / 1.294 | 1.442 / 1.485 / 1.377 |

| Case | Source | Mean R | Mean G | Mean B | α p99 | Pass |
|---|---|---|---|---|---|---|
| a-default | preview | 1.5955 | 1.2400 | 1.5847 | – | pass |
| a-default | export | 1.8734 | 1.5041 | 1.8687 | – | pass |
| b-aggressive | preview | 1.5291 | 1.1809 | 1.5272 | – | pass |
| b-aggressive | export | 1.8083 | 1.4461 | 1.8127 | – | pass |
| c-cleanup | preview | 1.5016 | 1.1467 | 1.5018 | – | pass |
| c-cleanup | export | 1.7829 | 1.4138 | 1.7892 | – | pass |
| d-color | preview | 1.7846 | 1.4623 | 1.5694 | – | pass |
| d-color | export | **2.0625** | 1.7264 | 1.8534 | – | **FAIL (R by 0.06)** |
| e-alpha | preview | 0.6574 | 0.6574 | 0.6574 | 1 | pass |
| e-alpha | export | 0.6574 | 0.6574 | 0.6574 | 1 | pass |

Background-only control (our matte α = 0), mean R/G/B, all under 2:

| Case | Preview | Export | px |
|---|---|---|---|
| a | 0.513 / 0.179 / 0.621 | 0.944 / 0.588 / 1.061 | 594,053 |
| b | 0.511 / 0.176 / 0.619 | 0.942 / 0.586 / 1.060 | 596,039 |
| c | 0.502 / 0.162 / 0.610 | 0.933 / 0.572 / 1.051 | 599,698 |
| d | 0.521 / 0.187 / 0.627 | 0.952 / 0.597 / 1.067 | 594,053 |
| e | 0.195 (grey) | 0.195 (grey) | 594,053 |

WP10 — vs the linear-on golden, on the golden's own edge band (pixels where
`e-alpha-linear-off` is strictly between 0 and 255; 6,118 px). Mean R/G/B and p99
R/G/B. (b) and (c) use the Default matte's band, so they are indicative only.

| Case | Source | Mean R/G/B | p99 R/G/B |
|---|---|---|---|
| a | preview | 31.47 / 28.91 / 28.42 | 112 / 105 / 100 |
| a | export | 31.48 / 28.91 / 28.43 | 111 / 105 / 100 |
| b (indicative) | preview | 18.78 / 16.91 / 16.93 | 82 / 76 / 82 |
| b (indicative) | export | 18.94 / 17.03 / 17.12 | 81 / 76 / 82 |
| c (indicative) | preview | 2.68 / 1.87 / 2.38 | 39 / 27 / 28 |
| c (indicative) | export | 3.08 / 2.23 / 2.81 | 39 / 28 / 29 |
| d | preview | 36.36 / 35.10 / 34.43 | 119 / 125 / 109 |
| d | export | 36.36 / 35.10 / 34.43 | 118 / 125 / 110 |
| e | preview/export | 72.01 / 72.01 / 72.01 | 244 / 244 / 244 |

**These band numbers are dominated by source decode, not the keyer or the blend.**
The e row is the matte itself (linear-on = linear-off for e, pixel md5 equal), so
a 72/255 band error there cannot be blending. Cross-checks on the same 6,118 px:
the fixed oracle on **Premiere's decode** (control PNG) has mean alpha error 0.56
(0 px over 8); the oracle on **our decoded video frame** has 72.01, identical to
the app's 72.01. Overall alpha error is 0.661 (oracle on our decode) vs 0.657
(app). So on hair/chroma-bleed edge pixels the browser's H.264 decode of the green
clip differs from Premiere's by far more than the 2/255 mean suggests, and that
passes the mean/alpha-p99 bar only because the band is 0.66% of the frame (p99
looks past it). Treat the a/d band rows as "what decode costs at the edge", not as
a WP10 blend measurement.

### The one failure: (d) export, R 2.0625

Export runs ~0.3 above preview in every case, and it is the background, not the
keyer: the background-only control is 0.94 export vs 0.51 preview, and the
background source control is 0.845 vs 0.445. The export swaps unkeyed clips to a
seek proxy (a second 4:2:0 encode, per the comment in `App.tsx`), the keyed green
clip uses the original. That accounts for ~0.27 of the (d) export R, which
otherwise equals the preview's 1.78. No tolerance was loosened and no shader
constant touched. Options for the next session, not done here: export unkeyed
video from the original when the clip is short-GOP-safe, or decide the proxy
penalty is acceptable and say so in the bar.

### Open questions

- (d) export R 2.0625 vs the 2/255 bar: fix the proxy path or accept it?
- The 72/255 edge-band error on (e) (and the 28–36 on (a)/(d)) is browser decode
  of the green clip at hair/chroma edges, identical for the oracle fed our decode.
  The 2/255 mean and 8/255 alpha-p99 bars cannot see a 0.66% band. Should the bar
  gain an edge-band limit, and should the green clip be decoded another way
  (WebCodecs/ffmpeg 4:2:0 upsampling) for keyed clips?
- A user-cancelled export was not exercised live (failed export was).

## Step 8 (round 3) — the frame mapping, and the acceptance rerun

Supersedes the (d)-export failure and the edge-band reading above: that band was
not decode, it was the app showing the previous video frame.

### Cause

`green.mp4`'s video stream starts at 0.0333 s (B-frame composition delay; audio at
0). The app mapped clip time straight to media time, so at 2000 ms the browser
showed frame 59; Premiere puts the first video frame at clip time 0 and shows frame
60. Many real clips have this offset, so it affected every video in the app.

### Files changed

- `src-tauri/src/mp4_tracks.rs` — `video_start_offset` (`:284`): when the first
  video frame is stamped, read from the MP4/MOV boxes without decoding: edit-list
  leading empty edits, else the first `ctts` offset, else (fragmented files) the
  first `tfdt` + `trun` composition offset. +6 Rust tests.
- `src-tauri/src/lib.rs` — command `media_video_offset` (`:987`), registered.
  `src/lib/api.ts:330` — `mediaVideoOffset`.
- `src/lib/media.ts` — the one place clip time becomes media time:
  `toMediaTime(clipSec, offsetSec, durationSec)` (`:227`) and `SEEK_BIAS_SEC`
  (`:219`). The pool entry carries `offsetSec`, read once per file actually loaded
  (`:202`), so a seek proxy gets its own. Callers: the pool's initial park
  (`:304`), `seekVideosForFrame` (`:372`, which `videoSeekTargets` feeds) and
  `VideoNode`'s sync effect (`Preview.tsx:1352`). `videoStartSec`, `videoSeekTargets`
  and the Preview warm-up keep passing CLIP time; none adds an offset itself. The
  picker and the poster read whatever frame the element already shows.
- `test/video-offset.test.ts` (+7), `test/media-url.test.ts` (mock gains `invoke`).

### Two findings that changed the design

1. **The offset is the video's own start time, not "minus the earliest stream".**
   First version subtracted the earliest stream (a video-only proxy then got 0). It
   did nothing for the unkeyed clips: the green export (via the proxy) stayed at 1.44.
   Measured: the original needs +1/30 s and so do the proxies (`start_time`
   0.033008), because the browser does not rebase a video-only file either.
   `green.mp4` 0.0333, `background.mp4` 0 (edit list absorbs its `ctts`), both
   proxies of each file match ffprobe's stream `start_time`.
2. **A seek to exactly a frame's timestamp reads one frame early.** After adding
   the offset the preview did not change at all: the seek to 2.033333 s settled at
   2.033332 s and the browser showed the frame stamped 2.000 s (frame with
   pts <= currentTime). `SEEK_BIAS_SEC` = 1 ms lands inside the frame (above the
   rounding, below a frame at any rate up to 240 fps). The offset-0 background shows
   the same frame as before.

### Checks

- `cargo test` 294 passed (288 + 6); the new tests failed first (`cannot find
  function video_start_offset`, then the video-only expectation).
- `npm test` 428 passed (421 + 7), red first (`toMediaTime is not a function`, then
  the bias cases); `npx.cmd tsc --noEmit` clean.
- `node docs/ultra-key-reference.mjs` self-check done; `node
  docs/ultra-key-shader-check.mjs` 9/9 PASS.
- Live: the app shows frame 60 at 2000 ms. Green control vs Premiere's frame 60:
  preview **1.38 → 0.22** (R), export through the proxy **1.44 → 0.45**.

### Audio

Preview audio is **not** the video element's: `VideoNode`'s element is always
muted and `AudioLayers.tsx` plays its own `new Audio()` per audio layer from the
same file, mapped straight from clip time (audio starts at 0, so no offset). Export
audio is muxed by ffmpeg from the original. Left as is. Visible consequence: a
clip whose video starts after its audio now shows its picture one frame later than
before against the same sound, which is what Premiere does.

### Acceptance rerun (note.txt: 1280×720, 30 fps, frame 60 = 2000 ms, key 0,255,1 typed)

Previews first, then exports; export = the exact `new VideoFrame` canvas at
1,999,980 µs, 1280×720, no downscale. Pass: mean ≤ 2 per channel vs linear-off; (e)
alpha p99 ≤ 8. **All 10 rows pass.**

Source controls (our decode vs the control PNGs), mean R/G/B:

| Source | Preview | Export |
|---|---|---|
| background | 0.445 / 0.136 / 0.538 | 0.845 / 0.509 / 0.950 |
| green | 0.219 / 0.082 / 0.205 | 0.446 / 0.270 / 0.447 |

| Case | Source | Mean R | Mean G | Mean B | α p99 | Pass |
|---|---|---|---|---|---|---|
| a-default | preview | 0.5048 | 0.2245 | 0.5449 | – | pass |
| a-default | export | 0.7832 | 0.4889 | 0.8294 | – | pass |
| b-aggressive | preview | 0.4159 | 0.1454 | 0.4856 | – | pass |
| b-aggressive | export | 0.6955 | 0.4112 | 0.7715 | – | pass |
| c-cleanup | preview | 0.4103 | 0.1409 | 0.4796 | – | pass |
| c-cleanup | export | 0.6917 | 0.4083 | 0.7671 | – | pass |
| d-color | preview | 0.5937 | 0.3605 | 0.6662 | – | pass |
| d-color | export | 0.8721 | 0.6249 | 0.9507 | – | pass |
| e-alpha | preview | 0.2031 | 0.2031 | 0.2031 | 1 | pass |
| e-alpha | export | 0.2031 | 0.2031 | 0.2031 | 1 | pass |

Before this round: a 1.60/1.24/1.58 (preview), (d) export R 2.0625 (the one miss).

Background-only control (our matte α = 0), mean R/G/B:

| Case | Preview | Export | px |
|---|---|---|---|
| a | 0.478 / 0.144 / 0.587 | 0.909 / 0.554 / 1.028 | 593,324 |
| b | 0.477 / 0.143 / 0.587 | 0.909 / 0.554 / 1.028 | 595,490 |
| c | 0.478 / 0.143 / 0.587 | 0.910 / 0.554 / 1.029 | 599,089 |
| d | 0.478 / 0.144 / 0.587 | 0.910 / 0.555 / 1.028 | 593,324 |
| e | 0.007 (grey) | 0.007 (grey) | 593,324 |

WP10 — vs the linear-on golden, on the golden's own edge band (`e-alpha-linear-off`
strictly between 0 and 255; 6,118 px). (b)/(c) use the Default matte's band:
indicative only.

| Case | Source | Mean R/G/B | p99 R/G/B |
|---|---|---|---|
| a | preview | 23.77 / 23.28 / 20.80 | 77 / 73 / 69 |
| a | export | 23.84 / 23.30 / 20.86 | 77 / 73 / 69 |
| b (indicative) | preview | 12.54 / 12.62 / 12.51 | 66 / 61 / 54 |
| b (indicative) | export | 12.75 / 12.80 / 12.77 | 66 / 61 / 53 |
| c (indicative) | preview | 1.17 / 0.79 / 1.16 | 18 / 14 / 19 |
| c (indicative) | export | 1.60 / 1.20 / 1.64 | 19 / 14 / 20 |
| d | preview | 27.49 / 28.70 / 24.57 | 87 / 90 / 81 |
| d | export | 27.53 / 28.71 / 24.61 | 87 / 90 / 81 |
| e | preview/export | 15.81 / 15.81 / 15.81 | 52 / 52 / 52 |

The (e) band mean fell from 72 to 15.8 (target ≈ 25 or less); (a) from 31 to 23.8.
What remains on the band is the browser's chroma upsampling, which the mentor
measured as 6.5–21 for ffmpeg's methods.

### Item 3 — seek-proxy quality: not done

(d) export now passes (R 0.872), so the proxy encoder settings (`make_seek_proxy`,
NVENC cq 20 / x264 CRF 18–20) were left alone and no size/build-time measurement
was made.

### Release note (one line, not committed)

Clips whose video starts after their audio now show the same frame as Premiere
(one frame later than before).

### Limits

- Offset is read for MP4/MOV only (incl. fragmented). Other containers return
  unknown → 0, i.e. the old behaviour. Edit lists are read for leading empty edits
  only; a file with several real edits is not modelled.
- Checked on two clips and their four proxies (`green.mp4`: 0.0333 s;
  `background.mp4`: 0), plus the unit shapes. Not run: a clip with a nonzero
  in-point or speed through the new mapping on screen, and a file with an empty
  edit.
- The acceptance scripts live in the temp folder, not the repo.

## Step 8 (final) — live check of the frame mapping, release notes, last checks

### 1. Frame mapping on screen: clip × setup × 3 times

Each row opens a one-layer 30 fps project, renders the preview at the three
playhead times (`render_preview`, 1280×720 or 720×1280) and runs one real export;
the export frame is the exact canvas handed to `new VideoFrame`. "Expected frame" is
the video frame whose presentation time (ffprobe `pts_time` minus the stream's
`start_time`) is the last one ≤ the clip time. Reference = ffmpeg
`select=eq(n\,N)` for N-1, N, N+1. Cells are mean |Δ| R/G/B in 0–255.
"Nearest wrong" is the better of N-1 / N+1 (preview R/G/B).

| Clip | Setup | Time → clip time | Frame N | Preview mean | Export mean | Nearest wrong frame |
|---|---|---|---|---|---|---|
| green | in-point 1.5 s | 1 s → 2.5 s | 75 | 1.17 / 1.20 / 1.97 | 1.20 / 1.21 / 1.98 | 1.89 / 2.14 / 2.59 |
| green | in-point 1.5 s | 2 s → 3.5 s | 105 | 1.22 / 1.26 / 2.00 | 1.24 / 1.27 / 2.01 | 2.20 / 2.52 / 2.86 |
| green | in-point 1.5 s | 3 s → 4.5 s | 135 | 1.17 / 1.20 / 2.00 | 1.19 / 1.21 / 2.00 | 3.54 / 4.06 / 3.74 |
| green | speed 2× | 1 s → 2 s | 60 | 1.14 / 1.17 / 1.93 | 1.16 / 1.18 / 1.94 | 1.73 / 2.00 / 2.41 |
| green | speed 2× | 2 s → 4 s | 120 | 1.22 / 1.29 / 2.04 | 1.23 / 1.30 / 2.05 | 4.62 / 4.83 / 4.90 |
| green | speed 2× | 3 s → 6 s | 180 | 1.10 / 1.11 / 1.89 | 1.12 / 1.12 / 1.90 | 3.26 / 3.64 / 3.76 |
| green | reversed (6 s window) | 1 s → 5 s | 150 | 1.12 / 1.14 / 1.94 | 1.14 / 1.14 / 1.95 | 5.06 / 6.19 / 4.85 |
| green | reversed | 2 s → 4 s | 120 | 1.22 / 1.29 / 2.04 | 1.23 / 1.30 / 2.05 | 4.62 / 4.83 / 4.90 |
| green | reversed | 3 s → 3 s | 90 | 1.22 / 1.27 / 2.00 | 1.21 / 1.28 / 1.98 | 1.94 / 2.23 / 2.67 |
| background | in-point 1.5 s | 1 s → 2.5 s | 75 | 0.91 / 0.65 / 0.99 | 1.07 / 0.74 / 1.18 | 7.69 / 7.68 / 9.02 |
| background | in-point 1.5 s | 2 s → 3.5 s | 105 | 0.89 / 0.65 / 1.00 | 1.04 / 0.74 / 1.18 | 8.70 / 8.24 / 8.31 |
| background | in-point 1.5 s | 3 s → 4.5 s | 135 | 0.94 / 0.72 / 1.17 | 1.12 / 0.82 / 1.38 | 10.23 / 10.16 / 10.65 |
| background | speed 2× | 1 s → 2 s | 60 | 0.98 / 0.71 / 1.10 | 1.19 / 0.84 / 1.34 | 9.32 / 9.77 / 9.94 |
| background | speed 2× | 2 s → 4 s | 120 | 0.89 / 0.66 / 1.04 | 1.04 / 0.74 / 1.23 | 7.93 / 8.12 / 9.02 |
| background | speed 2× | 3 s → 6 s | 180 | 0.94 / 0.66 / 1.03 | 1.09 / 0.75 / 1.23 | 9.11 / 9.20 / 9.05 |
| background | reversed | 1 s → 5 s | 150 | 0.88 / 0.62 / 1.01 | 1.05 / 0.72 / 1.21 | 7.40 / 7.62 / 8.23 |
| background | reversed | 2 s → 4 s | 120 | 0.89 / 0.66 / 1.04 | 1.04 / 0.74 / 1.23 | 7.93 / 8.12 / 9.02 |
| background | reversed | 3 s → 3 s | 90 | 0.95 / 0.64 / 0.91 | 1.11 / 0.73 / 1.10 | 7.33 / 6.92 / 7.47 |
| IMG_8272.MOV | plain | 1 s → 1 s | 24 | 3.13 / 3.24 / 2.64 | 2.98 / 3.28 / 2.47 | 7.33 / 7.28 / 7.20 |
| IMG_8272.MOV | plain | 4 s → 4 s | 96 | 3.22 / 3.63 / 3.34 | 3.54 / 3.87 / 3.68 | 21.75 / 21.77 / 22.62 |
| IMG_8272.MOV | plain | 9 s → 9 s | 216 | 3.16 / 4.01 / 3.62 | 3.30 / 3.99 / 3.75 | 25.97 / 25.47 / 25.07 |

(The speed-2× and reversed rows at 2 s are the same clip time, hence identical.)

**The frame is right in all 21 rows, in preview and in export, and preview and
export agree to ≈ 0.02 (iPhone ≈ 0.2).** In every row the expected frame is the
closest of the three, and the offset-0 background is unchanged by the mapping.

**The literal "mean ≤ 1/255" bar is met only by most background cells; it is NOT met
for green (≈ 1.1 / 1.2 / 2.0) or the iPhone clip (≈ 3–4).** I did not loosen it, and
I want the reason on the record rather than hidden:

- Plain `select=eq(n\,N)` to rgb24 is ≈ 4/255 darker than what the browser (and
  Premiere) show; on the first green row it gives 3.79 / 4.90 / 4.83 for the *right*
  frame. ffmpeg's BT.709→RGB leaves the video's own transfer curve in the pixels,
  while the browser and Premiere map it to sRGB.
- I calibrated the reference against Premiere's own `control-green-source.png`
  (frame 60 of green.mp4): plain 3.74 / 4.83 / 4.79 → mapped through the BT.709
  inverse-OETF then the sRGB OETF in 16-bit **1.15 / 1.18 / 1.94**. Every ffmpeg
  scaler/chroma-position variant I tried (bilinear/bicubic/lanczos/spline/area, four
  chroma positions, `accurate_rnd`, `full_chroma_int`, zscale with sRGB transfer, a
  plain 2.2 or 2.4 gamma) was worse. The reference used in the table is that mapped
  conversion. So **ffmpeg's best frame 60 is 1.15 / 1.18 / 1.94 from Premiere's** —
  the app's green numbers (1.10–1.22 / 1.11–1.29 / 1.89–2.05) sit on that same
  floor. This is conversion/chroma-upsampling difference, not frame choice.
- The background clip's floor is lower (≈ 0.9 / 0.65 / 1.0) and the iPhone clip's is
  higher (≈ 3), plausibly its saturated, high-detail content; I did not separate that
  further.
- The weakest discrimination is where little moves between frames: green speed 2× at
  1 s (right frame 1.14 / 1.17 / 1.93 vs previous frame 1.73 / 2.00 / 2.41) and
  reversed at 3 s (1.22 / 1.27 / 2.00 vs 1.94 / 2.23 / 2.67). Still the minimum, but
  by under 1/255 in R; the frame call on those two rests on the margin, not on a
  large gap.

**Offset read for the iPhone clip.** `mp4_tracks::video_start_offset` reads
**0 s** for `IMG_8272.MOV` and for both of its seek proxies. The file's video track
has `elst [(648270, media_time 60, rate 1)]` (media time 60 at timescale 600 = 0.1 s)
and `ctts` first offset 60, so the edit list absorbs the composition delay exactly
and the first frame is shown at clip time 0 — the edit-list path returns 0, as the
unit test `an_edit_list_that_skips_the_composition_offset_starts_at_zero` models.
ffprobe agrees (`start_time 0`). The on-screen result confirms it: frame N is the
closest, with the neighbours 2–7× further away (the clip is a 24 fps VFR iPhone
recording; N came from `pts_time`, not from `time × 30`).

Not covered by this table: `green.mp4` at an in-point combined with reverse, speed
other than 2×, a file with a leading empty edit, and any non-MP4/MOV container.

### 2. Release-note lines for this build

1. Effects now run in stack order, top to bottom, matching Premiere — a hand-built
   stack with a wipe, torn edge or GPU effect above a grade or blur will look
   different.
2. Clips whose video starts after their audio now show the same frame as Premiere
   (one frame later than before).
3. New effects: Ultra Key (Premiere-style chroma key with animated Key Colour and an
   eyedropper) and Crop.

### 3. Checks (final)

- `npm test`: Test Files 22 passed (22), Tests 428 passed (428)
- `npx.cmd tsc --noEmit`: no output, exit 0
- `cargo test` in `src-tauri/`: 294 passed; 0 failed; 7 ignored
- `node docs/ultra-key-reference.mjs`: `key colour -> [ 174, 174, 174, 0 ]  skin -> [ 225, 170, 140, 255 ]  grey -> [ 128, 128, 128, 255 ]  50% edge -> [ 202, 181, 134, 207 ]` / `self-check done`
- `node docs/ultra-key-shader-check.mjs`: 9 PASS, 0 FAIL

No code changed in this session; the scripts and the one-layer projects used for
the table are in `%TEMP%\kilo\step9`.

