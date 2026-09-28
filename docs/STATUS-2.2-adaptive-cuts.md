# Status — 2.2 adaptive cut detection

Written for the mentor, per §0's loop. First item in v4's "do next, in order." Small, as the
mentor note predicted, and it fixes the missed ENVATO outro cut it was built for.

## What changed

`src-tauri/src/analyze/shots.rs`: replaced the single fixed `hard` threshold with two
combined passes, both feeding the same `segment_cuts` merge/dedup logic as before:

- **Adaptive content-diff detector** (PySceneDetect's AdaptiveDetector idea): a frame's
  diff must be at least `adaptive_ratio` (3.0) times its own neighbourhood's (±2 frames)
  rolling average, not just above a fixed number — a local maximum still required, same as
  before. Robust to shots whose own motion baseline is naturally high (a busy handheld shot
  won't misfire) or low (a quiet shot's real cut doesn't need to clear the same absolute bar
  as a loud one).
- **Brightness pass** for fades and dips to black: watches per-frame mean luminance directly
  and flags every crossing of `black_luma` (0.06). Needed because a diff-based detector
  structurally can't see a slow linear fade — each step looks like every other step, never
  spiking above its own baseline.

Both passes reuse the same ffmpeg decode (`frame_samples` now returns diff *and* mean
luminance per frame in one pass, where the old `frame_diff_scores` returned only diff).
Dropped the dead `soft_sum` field (declared, never read — the `dead_code` warning that's
been in every build log this session).

## Checked

- `cargo test --lib` — 138 passed (5 new: the 4 original cut-detection cases still pass
  unchanged, plus a low-contrast-cut case, a busy-baseline-doesn't-misfire case, and a
  slow-fade-to-black case), 3 ignored, 0 failed.
- `npx vitest run` — untouched by this change, still 283 passed (unaffected: no TS side).
- **Live, against the real reference** (`recheck_envato_outro_cut`, `#[ignore]`d — depends
  on a file outside the repo, run with `-- --ignored --nocapture`): ran
  `detect_cuts` on `preview_540p_crf22_higher_quality.mp4` end to end. Result:
  `1250 Soft, 1750 Hard, 16000 Soft, 20625 Soft, 21625 Hard, 25500 Soft` — a cut lands at
  20625ms, 375ms (3 frames at 8fps) from the STATUS-inverse-render-pipeline.md dump's
  20250ms diff-peak; the brightness pass is what actually catches it (`span_ms: 0` is its
  signature — the adaptive pass alone still doesn't clear the ratio on this shot's own
  baseline). That confirms both the specific fix *and* the reason two passes were needed:
  diff alone wasn't enough here.
- Bonus, unplanned: the new cuts at 16000/20625/21625/25500ms are exactly the extra
  structure that STATUS-inverse-render-pipeline.md's "Update" section said was missing —
  shot 11 (previously one 11s blob: second card montage + transition + outro card +
  hold-to-black) now splits into its real beats. Didn't re-run the full rebuild pipeline to
  confirm the downstream effect — that's Phase 4 territory, not this stage's job — but the
  shot boundaries themselves are now right.

## Not done / out of scope for this stage

- Checked against PySceneDetect's own output, which the roadmap calls for "during
  development only" — not run; would need PySceneDetect installed. Didn't block on it since
  the real-video recheck above gives direct evidence the fix works, but flagging that the
  roadmap's own cross-check step was skipped.
- `min_content`/`adaptive_ratio`/`black_luma` are calibrated against one synthetic reference
  and one real video (both already in hand) — same caveat the original `hard`/`soft` had:
  revisit if it starts missing real cuts or flagging mid-shot motion on a wider set of
  reels.
