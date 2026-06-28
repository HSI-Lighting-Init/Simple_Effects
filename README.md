# Simple Effects

A small flat-animation tool (a "mini After Effects") built on Tauri + React +
Konva, with a pure-Rust CPU compositor for export. Separate app from the HSI DMX
Lighting Designer — they share UX patterns (timeline, keyframes) but no runtime.

## Stack

| Concern | Choice |
|---|---|
| Desktop shell | Tauri 2 (Rust) |
| Frontend | React 19 + Vite 7 + TypeScript |
| Canvas preview | Konva + react-konva |
| Text shaping | rustybuzz (HarfBuzz) + ttf-parser, embedded Vazirmatn font |
| Export compositor (planned) | tiny-skia (CPU 2D) |
| Image decode | image |
| Project file (planned) | serde + ron |
| Shared types | ts-rs (Rust → TypeScript) |

## Architecture decision: one evaluator, in Rust

The animation math (keyframe sampling + easing + per-letter presets) lives
**only** in Rust ([src-tauri/src/eval.rs](src-tauri/src/eval.rs)). The preview
does not re-implement it in TypeScript — the frontend calls `evaluate_at(tMs)`
over IPC and Konva just applies the resolved transforms.

Why: the export pipeline (tiny-skia) and the preview (Konva) must agree
frame-for-frame. Keeping two copies of the interpolation math is the classic way
they drift. One authoritative evaluator removes that risk.

## Text & Arabic/Persian

Text is rendered as **shaped vector glyph outlines**, not browser text:
[src-tauri/src/text.rs](src-tauri/src/text.rs) shapes a run with rustybuzz
(RTL, contextual joining, ligatures, ZWNJ) and pulls each glyph's outline with
ttf-parser, using the embedded Vazirmatn font ([src-tauri/fonts/](src-tauri/fonts/),
SIL OFL). This keeps Arabic/Persian intact even while animating letters one by
one, and makes the preview match the future export. Per-letter animation is
preset-based (`LetterPreset`: fade / scale-pop / rise / scatter / typewriter),
evaluated in Rust with stagger.

## Data model

[src-tauri/src/model.rs](src-tauri/src/model.rs) is the single source of truth:
`Project → Layer → { LayerKind, Transform }`, with `Transform` holding per-property
keyframe `Track`s. `LayerKind` is `Image | Text | ColorPatch`; `Text` carries an
optional `LetterAnimation` preset. Types are exported to
[src/bindings/](src/bindings/) by ts-rs whenever the Rust tests run.

## Run

```
cd C:\Users\light\Simple_Effects
npm install            # first time only
npm run tauri dev      # desktop app
npm run build          # type-check + production frontend bundle
cd src-tauri && cargo test   # evaluator/shaping tests + regenerate bindings
```

First run shows a demo comp (backdrop, an accent square doing a Ken-Burns scale,
and the Persian title rising in letter by letter). "＋ Image" adds an image
(auto fit-scaled to the comp); "＋ Text" adds an editable text layer.

## Status (per the build plan)

- [x] **Phase 0** — window + Konva stage rendering layers from the Rust evaluator
- [x] **Phase 1** — Project/Layer/keyframe model with ts-rs type export
- [x] **Phase 2** — timeline UI (one track per layer, blocks, keyframes, playhead)
- [x] **Phase 3** — direct-manipulation keyframing (Transformer + auto-keyframe)
- [~] **Phase 4** — inspector: text content/size + per-letter presets (manual
      per-letter keyframing still to do)
- [ ] **Phase 5** — tiny-skia export loop → PNG frames → ffmpeg → MP4
- [ ] **Phase 6** — transitions, multi-image layout, color/blend effects
- [ ] **Phase 7** — packaging, undo/redo, parallel (rayon) export
- [ ] App icon — pending the source image file
