# Status — E1 (custom/overshoot easing) + the 2.5 keyframe fitter

Written for the mentor, per §0's loop. Both done and live-verified against the real
reference video, not just synthetic data.

## E1 — custom-curve and overshoot easing

**Render**, all three layers:
- `model.rs`: `Easing::Bezier { x1, y1, x2, y2 }`, a new variant alongside the existing
  five. Old projects keep loading unchanged (purely additive — no new field on an existing
  struct, so no serde default needed).
- `eval.rs`: `ease()` gets a `Bezier` arm calling a new `cubic_bezier()` — Newton-then-
  clamp solve for the curve parameter, same algorithm as `cubicBezier` in
  `src/lib/transitions/spring.ts` (ported, not reinvented, per the roadmap's "reuse the
  transitions library's bezier math" — the transitions engine already had exactly this).
  `sample_track`'s output is never re-clamped, so overshoot (`y1`/`y2` outside 0..1)
  genuinely swings the sampled value past the target keyframe, not just past 1.0 in the
  abstract.
- `track.ts` (the frontend keyframe mirror): same bezier branch, reusing the *same*
  `cubicBezier` function directly (one implementation, not two to keep in sync — the Rust
  side is a from-scratch port since Rust can't import TS, but the TS side imports the real
  thing).

**UI**: honest gap. There is currently no human-facing keyframe-easing control in the app
at all — no diamond right-click, no easing dropdown — easing has only ever been settable
via the `set_keyframe` MCP tool. Extended that tool's schema (`bezierX1/Y1/X2/Y2` params,
`easing: "bezier"`), which is what the actual pipeline (Claude via tools) needs. Building an
actual in-app easing-curve picker widget is separate, real UI work I didn't take on — flagging
it rather than silently either building a big unplanned feature or skipping the gap
unmentioned.

**Ground truth**: `synthetic.ts`'s `animateShot` now has a 20% chance per keyframed segment
of using a random bezier instead of a named easing, some of which overshoot (`y1`/`y2` drawn
from 1.1-1.8 about half the time) — so `make_synthetic_reference` output now exercises the
2.5 fitter's bezier-recovery path, not just the four named shapes.

**Checked**: 4 new `eval.rs` tests (endpoints match 0/1, overshoot genuinely exceeds the
keyframed value — not just the abstract curve — degenerate case matches a straight line) +
3 new `track.ts` tests (`test/track.test.ts`, same cases mirrored on the TS side). 154/154
Rust, 286/286 JS.

## 2.5 — the keyframe fitter

Didn't exist before this stage (confirmed by search — no DP, no curvature, no keyframe-fit
code anywhere). New module: `src-tauri/src/analyze/fit.rs`.

**The algorithm** (roadmap's own words, one mechanism per idea):
- **Shared key times across channels.** One DP run picks ≤4 segments' worth of times,
  jointly minimizing SSE summed across every channel passed in (scale/rotationDeg/tx/ty for
  background motion) — an editor keys a whole transform at once, not one parameter at a
  time. Candidate times come from curvature peaks (local maxima of the normalized second
  derivative, summed across channels) plus any caller-supplied preferred/annotated times,
  which get a 10x cheaper segment cost so they're favoured without being mandatory.
- **Hold falls out for free.** No special "is this a punch-in" detection — `Hold` is just
  another shape in the same least-SSE competition as the four named easings, so a segment
  that's flat until its very last sample naturally scores best under `Hold`. (Needed one
  real fix here: curvature ties at a single-frame step land on BOTH adjacent samples
  symmetrically; broke the tie toward the later one — the jump's landing point — so the
  segment reads as "flat, then landed" instead of "flat, then one weird half-step".)
- **Bezier gets its 4 control values fit**, not just picked from a preset list: coordinate
  descent, one parameter at a time, with the search window halving every round (a fixed-grid
  search would cap precision at the grid step forever — this doesn't). Only kept over the
  best named easing if it wins by ≥20% SSE (parsimony — a 4-parameter curve can always fit
  at least as well as a 0-parameter one; without a margin, nothing would ever read as a
  plain `EaseInOut` again).
- **Cost is normalized per channel** by that channel's own value range² before `lambda`
  competes against it — scale (~1.0-1.3), rotation (degrees), and translation (pixels) are
  wildly different scales, and an un-normalized cost would let `lambda` mean something
  different for each one.

**Checked**: 7 unit tests in `fit.rs` (straight ramp needs 2 keys, a real bend gets a 3rd,
single-frame jump recovers as Hold, an overshoot curve recovers as Bezier with exactly 2
keys once given enough search precision, channels share key times, preferred times are
offered as candidates and get keyed when the data actually supports it) + 1 in `mod.rs`
(the live-verification fix below). 151 → 154 passing as E1/2.5 tests landed alongside each
other.

**Wired up, not just unit-tested**: added `fit_background` — a `Tauri` command + MCP tool,
mirroring `align_reference` exactly (same DEV ONLY gate). Takes `align_reference`'s own
output plus a span, returns one `Keyframe[]` per channel.

**Live, via the MCP bridge, against the real reference video** (not synthetic): ran
`align_reference` on `preview_540p_crf22_higher_quality.mp4`'s first ~1.7s, then
`fit_background` on the result. First pass surfaced a real bug: the aligner loses
convergence partway through that window (`solved: false` from t=500ms on, carrying the last
value forward per its own documented behaviour) — the fitter was treating that carried-
forward flatline as real data, reading a late jump as an early gradual ramp. Fixed:
`fit_background` now filters to `solved` samples before fitting (falls back to the raw list
only if that would leave nothing). Reran — the fitted curve, rendered through the actual
`sample_track`/`ease()` evaluator (not a hand check), now correctly holds ~1.0 early, jumps
around the real solved data, and extrapolates the true last known value out to the span
edge, instead of ramping smoothly toward it. This is exactly the kind of bug the "render
early, render often" philosophy (roadmap §2) is supposed to catch, and it did.

## Update — wired into `rebuild_from_analysis`'s Ken Burns path

`rebuildFromAnalysis.ts`'s `animateMotion` used to key exactly 2 keyframes (start/end scale,
linear) from a shot's raw first/last motion samples — a placeholder cruder than the fitter
that now exists. Rewrote it to call `fitBackground` and apply every returned keyframe (any
count, whatever easing — including bezier) instead of hardcoding 2. Scale only, still — the
fitter also recovers rotation/pan, but those are in `align_shot`'s relative analysis-pixel
space and need the anchor/centre composition into this engine's absolute comp-space
transform, which isn't built (see "Not done" below); applying them today would be a guess,
not a measurement, so left out rather than guessed.

`ShotAnalysis.motion`'s element type gained an optional `solved` field (default `true` when
absent, so hand-built/synthetic motion arrays — tests, scratchpad JSON — don't need updating)
so real `analyze_reference` output's carried-forward placeholders get excluded before fitting
(the Rust side does the actual filtering — see the live-verification bug above).

**Checked**: `test/rebuild-from-analysis.test.ts` — the existing 2-key ratio test still
passes against a fake `fitBackground` that mirrors the real fitter's behavior on a trivial
2-sample input; added a new test confirming N keyframes (not just 2) get applied with their
own per-key easing, including a bezier one, round-tripping correctly. 12/12 in that file,
287/287 JS overall. Not yet re-verified with a full live `rebuild_from_analysis` run against
the real reference video (fit_background alone was; the wiring around it is unit-tested with
a mock, not yet confirmed end-to-end against real footage) — a reasonable next check, not
done this pass.

## Not done

- Rotation/pan from the fitter aren't applied yet — blocked on the anchor/centre composition
  above, not on anything built this stage.
- `placeRegion` (the grid/multi-motion per-region Ken Burns) still uses the old crude first/
  last-sample approach — only `animateMotion` (the plain single-shot path) was upgraded.
- `score_recovery` doesn't score easing recovery yet — nothing to score against until
  something calls the fitter for real. Now has a real caller; add when it's worth measuring.
- The anchor/centre composition from `align_shot`'s relative analysis-pixel space into this
  engine's absolute comp-space transform — same gap `STATUS-gateA-aligner.md` already
  flagged as "not done," unaffected by this stage.
