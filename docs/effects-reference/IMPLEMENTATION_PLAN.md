# Next-build blueprint: transitions (first) + new effects

This is the execution guide for turning the catalogs into features. **Transitions are
prioritized** because we have none. Everything below is implemented in **our** code
(no GPL/MLT). It composes with the deterministic frame-by-frame export already in place
(`src/lib/deterministicExport.ts`) — transitions/effects are evaluated per frame, so the
exported file stays frame-accurate.

---

## Part 1 — Transition system (per-layer in/out)

### Why per-layer in/out (not A→B track transitions)
Our model is a **z-ordered stack of layers** with `start_ms`/`end_ms`, no tracks. The
natural fit is: each layer optionally has a **transition in** (plays over its first
`dur_ms`) and a **transition out** (plays over its last `dur_ms`), blending the layer with
**whatever is drawn below it**. Because layers composite back-to-front, a top layer that
dissolves/wipes in over an overlap with the layer beneath *is* a cross-transition — no new
"clip pair" concept required. This reuses the existing Wipe alpha-mask renderer and the
keyframe/opacity machinery.

### Data model — `src-tauri/src/model.rs`
```rust
#[derive(...)]  // serde camelCase, ts(export) like the other enums
pub enum TransitionKind { Dissolve, Wipe, Slide, Luma }

#[derive(...)]
pub struct Transition {
    pub kind: TransitionKind,
    pub dur_ms: u32,
    // small kind-specific params (flat, optional defaults):
    pub angle: f32,       // wipe
    pub softness: f32,    // wipe / luma
    pub direction: u8,    // slide (0=left,1=right,2=up,3=down) / luma map index
}
```
Add to `Layer`:
```rust
#[serde(default)] pub transition_in: Option<Transition>,
#[serde(default)] pub transition_out: Option<Transition>,
```
`#[serde(default)]` keeps old `.sefx` files loadable.

### Evaluation — `src-tauri/src/eval.rs`
- Add a `ResolvedTransition { kind, factor, angle, softness, direction }` and a
  `transition: Option<ResolvedTransition>` field on `ResolvedLayer`.
- Compute `factor` at time `t`:
  - in: `t` within `[start, start+in.dur]` → `factor = (t-start)/dur` (eased, reuse
    `ease(EaseInOut, u)`), else 1.
  - out: `t` within `[end-out.dur, end]` → `factor = (end-t)/dur`.
  - combined `factor = min(inFactor, outFactor)` (0 = fully transitioned-out/hidden,
    1 = fully present).
- This is pure math next to `sample_track`; no new dependencies.

### Commands — `src-tauri/src/lib.rs`
- `set_layer_transition(layer_id, slot: "in"|"out", kind: String, dur_ms, angle, softness, direction)`
  and `clear_layer_transition(layer_id, slot)`. Snapshot for undo (same pattern as
  `set_wipe_static` etc.). Register in `invoke_handler!`.
- Regenerate ts-rs bindings with `cd src-tauri && cargo test` (writes `src/bindings/`).

### Render — `src/lib/effects.ts` + `src/components/Preview.tsx`
Apply the transition on top of the resolved transform, by kind, using `factor`:
- **Dissolve** → multiply layer opacity by `factor`.
- **Wipe** → reuse `applyWipe` with `position = factor` (and the transition's angle/softness).
- **Slide** → offset the node x/y by `(1-factor) * offscreenDistance` in `direction`.
- **Luma** → gradient-threshold alpha mask: build a synthetic luma map (linear/radial/
  clock/barn from `direction`), keep pixels whose map value `< factor` (soft edge via
  `softness`). Same `destination-in` mask trick as Wipe.
- Cover `EffectImageNode`/`ImageNode` first; then `TextGlyphs`, `ColorPatch`,
  `DecalNode`. (Dissolve/Slide are trivial for all; Wipe/Luma masks apply where we draw
  to an offscreen — image/text already do.)

### Timeline / Inspector UI
- `src/components/Inspector.tsx`: a "Transitions" section with In/Out pickers
  (kind dropdown + duration + kind params), wired to `set_layer_transition`.
- `src/components/Timeline.tsx`: draw a small triangle/ramp at the block's start/end to
  show the in/out region (optional: drag its width to set `dur_ms`).
- `src/App.tsx`: `onSetLayerTransition` handler (mirror `onSetWipeStatic`); pass to
  Inspector/Timeline; `setProject` + `applyTime` + `recordAction`.

### Verify
Add two overlapping image layers; give the top one a Dissolve-in and a Wipe-out; scrub to
see the blend with the layer beneath; then export with the **render probe** on and confirm
the transition frames are present/accurate in the output.

---

## Part 2 — Effects expansion (after transitions)

Per new effect from `effects-catalog.json`, follow the established **7-touchpoint path**:
1. `model.rs` — add the `Effect` variant (params as `Track`s where keyframeable).
2. `model.rs` `Effect::default_of` — default params.
3. `eval.rs` — add `ResolvedEffect` variant + arm in `resolve_effect`.
4. `lib.rs` `effect_track_mut` — expose keyframeable params for `key_effect`.
5. `lib.rs` `for_each_track_mut` — include params in delete/clear.
6. `src/lib/effects.ts` — render it.
7. `src/App.tsx` `effectKinds` + inspector label.

### Render technique by effect (from the catalog)
- `css-filter` (sepia, threshold) → extend `buildFilter()` in `effects.ts`. Cheapest.
- `pixel` (gamma, levels, pixelate) → a `getImageData`/`putImageData` pass in
  `applyEffects`. No new dependency; fine at preview/export sizes.
- `webgl-shader` (sharpen, chroma key, color balance, white balance) → introduce **one
  reusable WebGL effect pass**: an offscreen `WebGLRenderingContext`, a fullscreen quad,
  and a fragment shader per effect. This is the one real piece of new infrastructure;
  build it once for `sharpen`, then `chroma_key`/`color_balance` reuse it.
- `mask` (vignette) → radial gradient `destination-in`/`multiply`, like Wipe.
- `composite` (glow) → blur copy + `screen` blend over the original.
- `geometry` (mirror, crop) → adjust the node's transform / source rect; no pixel work.

### Suggested order
1. Cheap wins first: `sepia`, `gamma`, `vignette` (no GL).
2. Introduce the WebGL pass with `sharpen`; then `chroma_key` (high value for compositing),
   `color_balance`, `white_balance`.
3. `levels`, `pixelate`, `glow`, `mirror`, `crop` as time allows.

---

## Guardrails
- Keep it clean-room: implement from the param specs here, never from kdenlive source.
- Every keyframeable param goes through `Track` so it animates and works in the
  deterministic export automatically.
- Re-run `cargo test` after any `model.rs`/`eval.rs` change to regenerate `src/bindings/`.
