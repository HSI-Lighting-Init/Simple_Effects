# Effects & Transitions Reference (kdenlive-informed)

This folder is a **clean-room reference catalog** to guide the next build's effects and
transitions work. It is **not** a copy of kdenlive's files.

## Provenance & licensing

- We looked at [kdenlive](https://github.com/kde/kdenlive) only to learn **what effects and
  transitions exist and what parameters/ranges they expose**. Those are facts and ideas
  (an effect called "Brightness" with a 0–4 level), which are not copyrightable.
- Kdenlive's effect/transition files are **GPL-3.0 MLT XML metadata** — schema + UI labels
  that drive compiled GPL engines (MLT / frei0r / FFmpeg-avfilter / Movit). They contain
  **no image-processing code** and would not run in our Tauri + Konva/canvas app.
- Therefore **no kdenlive code or files are vendored here.** Everything in
  `effects-catalog.json` / `transitions-catalog.json` is our own authored description, and
  every implementation we build from it is independent (written against our own
  `Effect` model + canvas/WebGL renderer).
- The `kdenliveTag` field in the catalogs is a **breadcrumb for research only** (which MLT
  service the idea came from), not something we depend on or ship.

> Note: the Simple Effects project currently has **no LICENSE file**. Before
> distributing, add one (e.g. MIT/Apache-2.0 if proprietary-friendly, or GPL-3.0 if you
> ever do want to use GPL components). This reference kit keeps us license-clean either way.

## Files

| File | What it is |
|---|---|
| `effects-catalog.json` | Curated per-layer effects: id, name, category, params (type/min/max/default), the kdenlive tag it was inspired by, our planned render technique, whether we already `have` it or it's a `gap`, and priority. |
| `transitions-catalog.json` | Curated cross-layer transitions with the same shape. We have **none** of these today. |
| `IMPLEMENTATION_PLAN.md` | The next-build blueprint: the per-layer in/out transition system design and the effect-expansion path, mapped to our exact files/touchpoints. |

## How our effects work today (so the catalog maps cleanly)

- `Effect` enum — `src-tauri/src/model.rs` (8 effects, params are keyframeable `Track`s).
- Resolved per frame in `src-tauri/src/eval.rs` (`resolve_effect`).
- Rendered in `src/lib/effects.ts` via canvas-2D `filter` strings + a gradient alpha mask
  for `Wipe`; applied in `src/components/Preview.tsx`.
- Adding an effect touches 7 spots (model → `default_of` → `ResolvedEffect` →
  `resolve_effect` → `effect_track_mut` → `for_each_track_mut` → `effects.ts` + inspector).

## renderTechnique values used in the catalogs

- `css-filter` — expressible with the canvas-2D `filter` property (cheap; same path as our
  existing color effects). e.g. sepia, gamma-ish.
- `pixel` — needs a `getImageData` / `putImageData` per-pixel pass (e.g. levels, chroma key
  on CPU). Heavier but no new dependency.
- `webgl-shader` — best done with a small WebGL fragment-shader pass (e.g. convolution
  sharpen, fast chroma key, curves). Our renderer is canvas-2D today, so this implies
  introducing one reusable GL effect pass — flagged where used.
- `mask` / `geometry` / `composite` — alpha-mask (like Wipe), transform-only, or
  multi-pass blend respectively.
