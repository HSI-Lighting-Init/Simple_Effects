# Mentor note — roadmap v4 (2026-09-28)

For the coding agent. Read alongside `docs/TEMPLATE_EXTRACTOR_ROADMAP.md` v4, whose changelog is at the top.

## What changed and why

The user wants Envato-style motion graphics reproduced to a measurable "identical" (roadmap §11), with no
manual marking. Your `STATUS-inverse-render-pipeline.md` named the two blockers:
1. low-contrast cuts are missed;
2. the pipeline has no concept of what is inside a shot.

v4 answers both:
- **Adaptive cut detection (2.2).** A frame's change is measured against its neighbours' rolling average,
  plus a brightness pass for fades and dips to black. PySceneDetect is the answer key during development
  only.
- **Automatic decomposition with SAM 3.1 (Phase 3, rewritten).** Claude writes a concept list, SAM 3.1
  segments and tracks every instance on the RTX 5070, and your aligner solves each element's transform inside
  its mask. Annotations become a review channel for flagged shots.
- **Phase E, the engine features these templates are made of.** Custom/overshoot easing, motion blur, mattes,
  shadows and borders, effects and blend modes on every layer, 3D tilt, kinetic type, camera moves. Each
  feature ships with render support, an estimator, and synthetic ground truth. Without all three it isn't
  done.

## Do next, in order

1. **Ask the user to commit** the current uncommitted work: `analyze/*`, the transition matcher, the rebuild,
   and the status notes.
2. **2.2 adaptive cuts.** It's small, and it fixes the missed ENVATO outro cut at ~20.25 s.
3. **Gate S (2–3 days).** Run SAM 3.1 on the Envato reel with a hand-written concept list, then report
   go/no-go against the gate's criteria: ≥ 80 % stable instances, about 2 minutes per 30 s reel, and it fits
   in 12 GB.
4. **E1 easing plus the 2.5 keyframe fitter.** The fitter isn't built yet. This step can run alongside Gate S.
5. **Phase 3** on a Go, then the **Gate C** report.

## Reconcile what's already built

- `regions.rs` / `layout.rs` become exemplar prompts for SAM (3.3), not the decomposition itself.
- `align.rs` solves transforms inside SAM masks (3.4).
- The rebuild and transition matcher stay. Extend the rebuild to one layer per element (4.3) once Phase 3
  lands.
- Last round the pipeline ran ahead of its gates, and the result was hard to judge. Keep to the order above,
  so each result is measured before the next layer is built on it.

## Test assets

The user supplies 3–5 Envato-style previews in `SE-test-assets\envato\`. Gate A still needs one real
photo-slideshow reel.

## Status notes

Write one per gate as before: Gate S, Gate C, and each E feature's "done when" numbers.
