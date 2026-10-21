# Status — Phase 2's "done when" numbers, measured for real

Written for the mentor, per §0's loop. This is the first time the full 2.4 (aligner) → 2.5
(fitter) pipeline has actually been scored against Phase 2's own numeric targets, rather than
the fitter's own unit tests (clean, hand-built fixtures) or a handful of live spot-checks.
Verdict: **fails all four value/easing targets, by a wide and consistent margin, with a
diagnosed and well-evidenced root cause** — not a vague "needs tuning."

## What was measured

Generated the 19 remaining synthetic references (seeds 2-20; seed 1 already existed) via
`make_synthetic_reference` against the same CCT photo stand-in Phase 1.2 used (no dedicated
`photos\` folder exists yet — flagging again, as the roadmap's own test-asset table already
does). All 20 exported and passed `audit_export` cleanly (suspect rates in the previously-
documented normal range for multi-transition content).

For every image/video shot across all 20 references (120 shots, 480 channel-measurements —
scaleX/rotation/x/y): ran the real `align_reference` → `fit_background` pipeline (the actual
Rust code, over the MCP bridge, not a simulation), composed the fitted relative keyframes
into absolute comp-space units via the anchor/centre formula (§ STATUS-E1-2.5-fitter.md),
using the shot's own TRUE starting transform as the anchor (known ground truth, per
`align_shot`'s own doc — not guessed), and matched each of the truth project's own keyframes
to the nearest fitted one (within 200ms) via a new `scoreKeyframeFit` in `scoreRecovery.ts`.

## The numbers

| Phase 2 target | Measured | Verdict |
|---|---|---|
| Scale ≤ 1% | **7.27%** mean (203 matched keys) | FAILS, ~7x over |
| Position ≤ 2px @1080p | **92.4px** mean at the shot's LAST key (166 matched; the first key is trivially 0px — it's the known anchor, not a measurement) | FAILS, ~46x over |
| Rotation ≤ 0.3° | **2.03°** mean (203 matched keys) | FAILS, ~7x over |
| Key times ±2 frames | Interior (punch-in) keys: **0 of 76 found at all** (100% miss). Boundary keys: 0ms error, but that's structural (the fitter always forces a key exactly at the span edges) — not a real precision measurement | FAILS on the part that's actually being tested |
| Easing correct ≥ 80% | **0.8%** (4 of 480 rated keys) | FAILS badly |

151 Rust (unchanged — no Rust code touched this pass) + 293 JS tests (13 new: `scoreKeyframeFit`
unit tests) still green — this is a real-data finding, not a regression the existing suites
would have caught, since they're built and tested against clean synthetic curves, not real
aligner noise.

## Root cause, diagnosed with a concrete example, not guessed

Pulled one shot's raw fitted output directly (`synthetic-1.mp4`, shot 1, scaleX): truth is a
plain 2-key curve (`0ms: 1.937 easeInOut` → `2732ms: 2.158 easeOut`). The fitter returned
**5 keys** (`0, 200, 800, 1600, 2732ms`), three of them elaborate, distinct bezier curves —
none of which correspond to anything in truth. The underlying real motion genuinely is a
simple 2-key curve; the fitter is inventing structure that isn't there.

This is exactly the failure mode `fit.rs`'s own tests never exercise: `lambda` (the "is
another segment worth it" penalty) and the curvature-peak candidate detector were calibrated
against clean, hand-built unit-test curves with zero measurement noise. Real `align_reference`
output has its OWN inherent per-frame noise (compression, LK convergence limits) even when the
true underlying motion is perfectly smooth — and that noise has just enough structure to read
as "real curvature" to the candidate detector, and just enough SSE improvement to clear the
current lambda's bar for "worth an extra segment." The fitter was never wrong about picking
the best easing for a SEGMENT once segment boundaries are fixed — it's wrong about how many
segments a real, noisy signal actually needs.

This single root cause plausibly explains all four failing numbers at once: over-segmentation
directly produces the easing failures (each spurious segment gets scored against a truth
easing it was never trying to match), and the extra keys' own values (drawn from noisy
intermediate data rather than the true 2-key line) plausibly inflate the scale/position/
rotation error too — not confirmed in isolation, but consistent with what's observed.

**Separately, a real, distinct finding**: even where the fitter correctly avoids over-
segmenting (matching a shot's LAST key with no interior points), position error there
averages 92px — meaningful raw alignment drift over the course of a shot, unrelated to the
over-segmentation issue. The aligner's own accuracy over a full shot (not just Gate A's
tested short windows) hasn't been measured end-to-end before this.

## Update — the over-segmentation bug: found, fixed, verified; not the dominant issue

Per the mentor's steer, decomposed the error before retuning anything blind: scored the RAW
`align_reference` output per frame against truth directly, bypassing the fitter entirely,
across 5 references (~30 shots, 689 raw samples).

**Real, separate root cause found and fixed**: `channel_range()` (normalizes each channel's
curvature/SSE contribution by its own value range, so `lambda` means the same thing whether a
channel is pixels, degrees, or a ~1.0 scale ratio) had a floor of `1e-6` — but its own doc
comment already said "floored at 1", a mismatch. `1e-6` isn't a real floor in practice: a
rotation channel that's genuinely just measurement noise around a true constant 0° still has
*some* real range (a few thousandths of a degree) — comfortably clear of `1e-6`, so dividing
that tiny genuine noise by its own tiny range produced a normalized curvature that dwarfed
`scale`'s real, larger-range signal once summed into the SHARED candidate pool (`fit_channels`
fits all 4 channels jointly by design — "shared key times across channels"). That's exactly
why the earlier single-channel unit test (scale alone) didn't reproduce the bug, but the real
`fit_background` call (always 4 channels together) did. Fixed by actually flooring at `1.0`
per the function's own original intent. Two new regression tests pin it: fitting `scale` alone
against the real trace (passed even before the fix — confirms the bug needs the joint-channel
context) and fitting all 4 real channels together (failed before, passes after). 153 Rust
tests green (151 + 2 new), no regressions. Verified live, not just in the unit test: the exact
shot that showed 5 spurious keys now shows the correct 2, `easeInOut`, matching truth.

**Re-scored all 20 references with the fix deployed — the aggregate barely moved.** The one
shot the fix directly touched is now perfect (0 error, correct easing), but across all 480
channel-measurements the overall numbers are statistically unchanged (scale 7.27%, position
92.4px, rotation 2.03°, easing 0.8%→1.5%). The over-segmentation bug was real and is now
fixed, but it was never the DOMINANT contributor — something else, present in nearly every
shot, swamps its effect on the aggregate.

**That something else, per the raw-samples decomposition**: the aligner's own convergence, not
the fitter. Of 689 raw samples, **374 (54%) never solved at all** (carried-forward
placeholders — `fit_background` already excludes these before fitting, so they don't corrupt
the fitter's INPUT, but they mean the fitter often has far less real data to work with than
it looks like from `align_reference`'s own response length). Solve rate is a clean function of
distance from the reference frame — 84% in the first 500ms, dropping to 20-40% by 6-8 seconds
in, to near 0% past 12 seconds — the signature of "initialized from the previous frame"
cascading: once one frame fails to converge, later frames inherit a bad starting estimate and
increasingly fail too. And even where a sample DID report `solved: true`, position error still
grows substantially with distance (0.1px near the reference frame, 166px by ~8 seconds in) —
real accumulated drift, not just a binary solve/fail question. Gate A's own earlier "promising"
verdict was measured on a short window (0-2732ms of one shot) where solve rate is still
60-84% — accurate for that window, but it didn't surface how much this degrades over a full
shot's duration.

**Per the mentor's own instruction — stopping here rather than a deep rewrite.** The raw
aligner is far enough off target that recalibrating the fitter further, or chasing smaller
fixes, wouldn't move Phase 2's numbers much. Redesigning the aligner's robustness for long
sequences (e.g., periodic re-anchoring instead of pure previous-frame initialization, or
detecting and re-seeding after a failed run rather than propagating a stale estimate) is a
real, separate, larger piece of work — flagging it as the actual next decision point, not
starting it unasked.

## Update — a units bug invalidated the numbers above; re-measured, and a sharper root cause found

The mentor caught a real convention bug: `align_reference` (the raw Tauri command) returns
ABSOLUTE video time in `t_ms`, not shot-relative. Two of my own orchestration scripts
(`decompose_error.mjs`, `score_fitter.mjs`) were built assuming shot-relative and, in
`decompose_error.mjs`'s case, were double-subtracting — treating raw absolute time as
"distance from the reference frame," which garbled every shot except each reference's first
(the only one starting at absolute t=0, where absolute happens to equal relative). Verified
live before fixing anything: a direct `align_reference` call on shot 4 of `synthetic-1.mp4`
(true start 5734ms) returned `tMs=5734` for its first sample, not 0.

Fixed at the API level, not just in the scripts, per the mentor's steer: `align_reference`'s
Tauri command (`lib.rs`) now converts to shot-relative before returning, matching
`analyze_reference`'s own existing convention (`ShotAnalysis.motion`) so every external
caller is on one consistent convention. Confirmed live that the production path
(`analyze_reference` → `rebuildFromAnalysis.ts`) was never affected — it already converts
internally and never calls the raw command. Added a regression test
(`mixed_tests::align_reference_returns_shot_relative_time`, `#[ignore]`d, needs a real file)
pinning exactly this. 154 Rust tests green (153 + 1 new), rebuilt and redeployed (build 55)
before re-measuring anything.

**Re-scored all 20 references end to end with the corrected pipeline** — the first
measurement that's actually been fully verified rather than assembled from
partially-buggy orchestration scripts. The numbers below **supersede** the "barely moved"
section above; that run predates the units-bug fix and its own truth-comparison numbers
can't be trusted as an apples-to-apples baseline.

| Phase 2 target | Measured (480 channel-scores, 20 refs × 6 shots) | Verdict |
|---|---|---|
| Scale ≤ 1% | **47.3%** mean (209 matched keys) | FAILS |
| Position ≤ 2px @1080p | **245.4px** mean at the shot's LAST key (166 matched) | FAILS |
| Rotation ≤ 0.3° | **12.08°** mean (209 matched keys) | FAILS |
| Key times ±2 frames | True-interior (punch-in) keys: **408 of 424 (96%)** within 2 frames (67ms), mean error 5.3ms — this part of the fitter is working well | Effectively PASSES, on the keys that are found |
| Easing correct ≥ 80% | **4.6%** (23 of 504 rated keys) | FAILS |
| (new) Truth keys found at all | **80.7%** (836 of 1036) — 19.3% never matched within 200ms of anything the fitter produced | — |

The fitter's own logic (candidate key-time selection, given real data to work with) is
sound: interior key times land within 2 frames 96% of the time. Every other number is worse,
not better, than the pre-units-fix "barely moved" figures — a real result, not noise: those
earlier figures were themselves computed before the pipeline was fully correct end to end,
so they were never a trustworthy baseline in the first place.

**Sharper root cause, found by pulling raw traces for two of the worst outliers (not
guessed):**

- `synthetic-7.mp4` shot 1 (640ms span): raw `tx`/`ty`/`scale` track cleanly for the first
  ~400ms (scale 1.0→0.99, ty 0→-6.5), then at t=500-600ms — right at the shot's own end
  boundary — diverges catastrophically (scale jumps to 2.03, rotation to 3.03°, ty to
  -307.4), still reported `solved: true`. The fitter's forced last-key inherits this
  divergence directly, producing the ~1256px y-error measured for that shot.
- `synthetic-6.mp4` shot 5 (1287ms span): diverges immediately, at the very first sample
  after the reference frame (t=100ms) — scale collapses toward 0 (0.0006, then 0.0003, then
  literally 0 for several samples), rotation flips wildly between roughly ±180°, and never
  recovers for the rest of the shot. Still `solved: true` throughout.

Traced both into `align_pyramidal`/`align_level` (`align.rs:200-292`): the IC-LK solver
returns `None` only for three narrow reasons — too few valid template pixels, too few
in-bounds warped points, or a singular Hessian in `solve4`. Once the per-level loop runs
(converged early via `mag < CONVERGE_EPS`, or simply exhausted `MAX_ITERS`), it returns
`Some(p)` unconditionally — **there is no plausibility check on `p` itself.** A degenerate
scale (near 0, or arbitrarily large) or a residual that never actually shrank still comes
back `solved: true`. This is a different, more specific mechanism than the earlier
"cascading failure from distance" story: it's not that solutions gradually get noisier with
distance from the reference frame (though that's also real, per the raw-samples decomposition
further up) — it's that a single frame can converge to numerical nonsense and be accepted at
face value, and because each frame's search is initialized from the previous frame's
estimate, a degenerate solution can then poison every subsequent frame in the same shot (as
seen in the `synthetic-6` shot 5 trace, which never recovers after t=100ms).

This also explains why LAST-key error was uniformly large across every shot-length bucket
(0-1500ms through 3500-5000ms, ~220-260px in each) rather than growing with span the way the
raw solve-rate table does: the LAST key is, by construction, always evaluated right at the
shot's end boundary — exactly where boundary/transition-adjacent frames seem likeliest to
trigger a degenerate solve — so every shot's last key is equally exposed regardless of how
long the shot is.

**Concrete, well-scoped next step (not started, flagging per the same "don't start large
work unasked" pattern as before, but now a small fix rather than a vague redesign)**: add a
plausibility gate to `align_pyramidal`'s accepted solution — reject (return `None`, so the
sample falls back to `solved: false`, carried-forward) when the final scale is outside a sane
range (e.g. roughly 0.3-3.0 for background motion within one shot) or when the final Huber
residual is still large relative to `thresh`. This is now a targeted, testable fix, not a
speculative "improve robustness" item — it directly targets the exact mechanism just traced.

## Update — the 3-layer aligner fix, implemented and re-scored: this is the go/no-go checkpoint

Per the mentor's go-ahead, implemented all three layers, in the specified order, then
re-scored all 20 references end to end. This is the checkpoint the roadmap's approach
lives or dies on.

**Layer 1 — keep transition frames out of alignment.** `shots::clean_core(start_ms, end_ms,
cuts)` (new, `shots.rs`): trims each shot's edge by its own boundary's transition width (a
soft cut's measured `span_ms`, or a flat `HARD_CUT_MARGIN_MS = 100` for a hard one), only
where an edge actually sits at a detected cut — an edge at the video's own start/end is left
alone. Falls back to the full untrimmed span if both margins together would invert it (a
shot too short to have a safe interior). Wired into `analyze_reference`'s per-shot loop: the
reference frame and every walked sample now come from the trimmed interior; `ShotAnalysis
.motion`'s `t_ms` stays relative to the shot's own original `start_ms` as before, so nothing
downstream needed to change conventions. The fitter's own existing edge-extrapolation
(`fit_channels`'s doc: "the fitter always keys exactly [at the span edges], not just the
nearest sample") already handles the "let the fitter extrapolate to the true edges" half of
this for free — no fitter change needed.

**Layer 2 — the plausibility gate.** `align::AlignFit` (new, `align.rs`) replaces the bare
`SimParams` `align_pyramidal`/`align_level` used to return, carrying `residual` (mean
absolute grayscale error at the FINAL settled transform, recomputed once after the iteration
loop — the loop's own in-progress `errs` reflect the previous iterate, not the one actually
returned) and `inlier_frac` (fraction of points within the final Huber threshold). `align
::plausible(fit, max_rotation_deg)` rejects a fit outside `scale ∈ [0.3, 3.0]`, `|rotation| >
max_rotation_deg` (a parameter — 45° for background alignment; an element layer, once Phase
3 fits those, may legitimately spin further), `inlier_frac < 0.5`, or `residual > 30.0`.

**Layer 3 — retry, race, then gate.** `align_shot`'s walk now runs both a prev-seeded and an
identity-seeded attempt every frame, keeps whichever has the lower residual (not just
whichever succeeds first, the old `or_else` behaviour), and only THEN applies the
plausibility gate to that winner — a fit that wins the race against an equally bad
alternative still gets rejected, rather than accepted by default. Only on rejection does the
sample fall back to `solved: false`/carried-forward, deploying the previously-held
identity-retry idea inside this stricter frame.

9 new tests (4 for `clean_core`'s trimming/fallback behaviour, 5 for `plausible` including
the exact scale-collapse and rotation-flip shapes measured live below) — 162 Rust tests
green. Rebuilt and redeployed (build 56) before re-measuring.

**Verified directly against the two worst live traces from the diagnosis above, not just in
unit tests**: `synthetic-7.mp4` shot 1 (previously diverging to scale 2.03/ty -307.4 at
t=500-600ms) now tracks smoothly through the whole 640ms span, scale settling around 0.987,
no divergence. `synthetic-6.mp4` shot 5 (previously a degenerate scale-collapse-to-~0,
rotation-flipping-between-±180° trace, still `solved: true` throughout) now correctly reports
`solved: false` for every sample after the reference frame — the gate is rejecting exactly
what it was built to reject.

**Raw-sample decomposition, split by clean-core vs. transition-window (2614 samples, all 20
references, gate active, UNTRIMMED span so both groups exist in the same run)**: overall
solve rate 44.5%, mean position error on solved samples 16.1px — both a large accuracy
improvement over the pre-gate run (previously up to 435px in some distance buckets) at
roughly the SAME solve rate as before (the gate doesn't make more samples solve; it stops
false solves from being trusted). The clean-core/transition-window split itself is a genuine,
slightly surprising result: 43.9% solve / 16.9px error inside the clean core vs. 48.9% solve
/ 10.4px error inside the transition margin — essentially no aggregate difference, and if
anything the transition-window samples look marginally better. **Layer 1 (trimming) is not
carrying the aggregate improvement — layer 2/3 (the gate) is.** This doesn't mean trimming is
worthless (it's still the right fix for the specific case where the REFERENCE FRAME ITSELF is
contaminated — see `synthetic-6` shot 5's live retest above, which needed BOTH the gate to
stop trusting the bad solve AND, separately, a clean reference frame to have any chance of
recovering a real one instead of just failing safe) — but the aggregate numbers below are
mostly the gate's doing, not trimming's. Distance-from-reference-frame degradation is real
and effectively unchanged by any of the three layers (54% solve at 0-500ms down to 12% at
3500-4000ms, same shape as before) — a separate, still-open limitation of previous-frame-
propagation tracking over long shots.

**Corrected Phase 2 numbers, all three layers active (468 channel-scores; 3 shots in one
reference errored — seed 13's shots 4/5/7 sit among unusually dense, closely-spaced late
cuts, and their clean cores end up narrower than the 100ms sampling grid, so `align_reference`
can't decode a second timestamp; caught by the script's own per-shot `try/catch`, not a crash,
and `analyze_reference`'s production caller already degrades the same case to
`is_still: false, motion: []` rather than erroring — not fixed further, a ~2.5%-of-shots edge
case on one unusually cut-dense reference):**

| Phase 2 target | Before (units-fix only) | After (3-layer fix) | Verdict |
|---|---|---|---|
| Scale ≤ 1% | 47.3% | **5.48%** | Still fails, but 8.6x closer |
| Position ≤ 2px @1080p | 245.4px (last key) | **40.1px** (last key), 16.9px (all matched) | Still fails, but 6.1x closer |
| Rotation ≤ 0.3° | 12.08° | **0.296°** | **PASSES** |
| Key times ±2 frames | 96% within 2 frames | **97%** (404/416), mean 3.7ms | PASSES |
| Easing correct ≥ 80% | 4.6% | **6.9%** | Still fails, barely moved |
| Truth keys found at all | 80.7% | 79.4% | Roughly unchanged |

A large, real improvement on three of six measures (rotation now clears its target outright;
scale and position both closed most of the gap), no regression on the two that were already
close, and no movement on easing accuracy or the miss rate — those two look like a genuinely
separate problem from aligner noise (most likely the fitter's own segment-shape selection
against real, still-imperfect data, not the input quality this round of work targeted).

## Update — Gate A's own fallback: OpenCV aligner, side by side with the Rust one

Per the mentor's recommendation (Gate A's own documented no-go rule: "switch to a Python/
OpenCV tracker behind the same tool interface" — cheap now that `sam\.venv` already exists
for the SAM service) and the user's go-ahead, implemented an OpenCV aligner in
`sam/align_opencv.py`, behind the exact same interface as `align_reference` (path/start/end/
ref/sample_every_ms in, shot-relative `AlignSample[]` out), and ran it side by side against
the Rust aligner on all 20 references through the SAME `fit_background` fitter — only the
aligner differs.

**Pipeline**: feature detection + `BFMatcher`/knnMatch (Lowe ratio test) +
`estimateAffinePartial2D(RANSAC)` for an initial similarity estimate, refined by
`findTransformECC`, frame-to-frame with re-anchoring once the scale ratio to the current
anchor passes ~12.5% (the composition folds each old anchor's own transform back through, so
a re-anchor never changes what's reported relative to the original reference). A plausibility
gate mirroring `align::plausible`'s thresholds (scale 0.3-3.0, rotation ≤45°, inlier fraction
≥0.5) rejects a numerically-produced but implausible fit the same way the Rust side does.

**One deviation from the spec, found live and switched for a concrete reason**: started with
ORB (as specified) but found it collapsing badly on this dataset's zoom-heavy Ken Burns
content — a real traced case: 904 ORB keypoints on each of a reference/target frame pair,
only 4 survived Lowe's ratio test (ORB's multi-scale-pyramid-of-FAST-corners approach isn't
scale-robust enough for this much zoom). AKAZE (the mentor's other suggestion) isn't
available in this OpenCV 5.0.0 build (only ORB and SIFT are). Switched to SIFT, which found
31 good matches on the identical pair — a real, non-marginal improvement, not a coin flip.

**A second real bug, found and fixed before any numbers were trustworthy**: OpenCV's affines
are pixel-grid-origin (top-left); the Rust aligner's `SimParams` pivots around the image
CENTRE (`align.rs`'s own doc). Reporting `tx`/`ty` straight from OpenCV silently mixed
conventions — any non-trivial scale/rotation pivoted at the wrong point injects a spurious
translation of order half the frame size. Caught by a suspicious first-pass result (scale/
rotation both far MORE accurate than Rust, position ~115px WORSE) that didn't hang together;
traced to the pivot mismatch, fixed with an explicit `to_center_pivot` change of basis before
decomposing the final transform. Re-scoring after the fix brought position back in line with
the rest of the picture (see numbers below).

**Metric corrections, exactly as specified**: position now scored as a % of the comp's short
side, restricted to matched keys whose TRUTH time falls strictly inside the shot's own clean
core (excluding the first/last key, which are the fitter's own span-edge extrapolation, not a
measurement of anything the aligner produced). Easing now scored by curve-shape deviation —
both the truth and fitted segment's easing evaluated at 11 points across `u ∈ [0,1]`, the max
`|truth(u) - fitted(u)|` (already a fraction of the segment's own value range, since both
curves are 0..1-normalized progress) compared against a 2% bar — not by class-label match,
so two visually-identical curves under different representations (e.g. a named `easeInOut`
vs. an equivalent bezier) now score as correct instead of automatically wrong.

**Side-by-side results (468 channel-scores each; same 3-shot seed-13 error as before, both
aligners, not fixed further)**:

| Metric | Rust | OpenCV (SIFT) | |
|---|---|---|---|
| Scale error | 4.99% | **1.78%** | OpenCV 2.8x better, at the mentor's ≤1-2% checkpoint bar |
| Rotation error | 0.288° | **0.055°** | OpenCV 5.2x better |
| Position, interior/in-core keys (the corrected metric) | **2.66px** / 0.25% | 4.04px / 0.37% | Rust slightly better; only 14-16 matches each, a thin sample |
| Position, span-edge keys (extrapolated, informational only) | 40.5px / 3.75% | **10.9px** / 1.01% | OpenCV 3.7x better |
| Easing, curve deviation ≤2% | 15.2% of segments | **20.0%** of segments | Both far below any real bar; OpenCV somewhat ahead |
| Missed keys | **20.6%** | 24.1% | Rust better |
| Raw solve rate, untrimmed span (2614/2622 samples) | **44.5%** | 26.0% | Rust solves nearly 2x as often |

**The real finding isn't "which aligner wins" — it's a precision/reliability tradeoff.**
OpenCV is substantially MORE ACCURATE whenever it produces an answer (scale, rotation, and
the edge-key position measure all favour it clearly), but it produces an answer LESS OFTEN
(26.0% vs. 44.5% raw solve rate, both falling with distance from the reference in the same
shape as before — 38%→13% for OpenCV, 56%→17% for Rust). That lower solve rate is also
exactly why OpenCV's missed-key rate is worse (24.1% vs 20.6%) despite its per-key accuracy
being better. Traced one concrete cluster of OpenCV failures (a shot where SIFT still found
0 plausible frames across its entire span even after the ORB→SIFT switch): RANSAC frequently
found a low-inlier-ratio (0.15-0.4), wildly implausible consensus (scale near 0, rotation
flipping across ±180°) rather than simply failing to find any consensus at all — the same
"numerically produced but semantically degenerate" failure mode the Rust aligner's own
plausibility gate was built to catch, just on the feature-matching side instead of the
dense-optical-flow side. Whether this is a further-tunable RANSAC/match-count parameter issue
or a deeper content-distinctiveness limit of these specific synthetic photos wasn't run down
further, per the cap.

**Against the mentor's own checkpoint** ("scale around ≤1-2% and position ≤about 5px means
the foundation is sound"): OpenCV's scale (1.78%) lands right at that bar; position, on the
corrected in-core metric, is comfortably under 5px for BOTH aligners (2.66px/4.04px) — though
on a sample of only 14-16 matched keys per aligner, thin enough that this specific number
shouldn't be over-read. The solve-rate gap is the real open question the checkpoint's own
numeric bar doesn't directly capture, and per the mentor's own framing ("if OpenCV can't get
near that... that's a real warning") is the thing most worth the user's judgment call now,
not something this pass resolves on its own.

## Update — mentor verdict: accuracy checkpoint met; gate tightened; re-anchoring confirmed

The mentor's read: the accuracy checkpoint is met with OpenCV (scale 1.78%, rotation 0.055°,
in-core position 4.04px/0.37%), and traced the solve-rate gap to CONTENT, not either aligner:
all 20 synthetic references are built from the CCT folder's ~15 files, which are really ~8
distinct pictures (PNG/JPG twins — the same duplicates §11.1 found) — flat AI illustrations
and infographics, the worst case for both dense and feature-based alignment, which is why two
unrelated aligners show the same decay shape. The roadmap now specifies 30-50 distinct,
textured HSI photos; the mentor is asking the user for them.

Did the three pieces of this that don't depend on new photos:

**Tightened the OpenCV gate** (`sam/align_opencv.py`): added a minimum inlier COUNT (≥15,
not just ratio — with only ~10-15 good matches to start, a 50%+ ratio could still pass on as
few as 5-8 raw points) alongside a loosened ratio floor (0.3, down from my own earlier 0.5,
per the mentor's numbers) and a genuine residual check via `findTransformECC`'s own
correlation coefficient (`rho >= 0.7`) — previously discarded. A failed ECC refinement is now
treated as a real failure (falls through to `solved: false`), not silently kept as the
unrefined RANSAC guess — "degenerate RANSAC consensus must fail cleanly." Re-scored: accuracy
essentially unchanged (scale 1.79%, rotation now 0.0205° — improved — position 4.04px/0.37%
unchanged), missed-key rate up slightly (260 vs 244 of 1012) as the stricter gate trades a
little more coverage for cleaner results, exactly as intended.

**Confirmed re-anchoring is actually firing**, with a direct trace, not just re-reading the
code: `synthetic-2.mp4` shot 2 (24% total scale change) shows `RE-ANCHOR (frame_scale=0.861)`
at t=4196, i.e. drift crossed the 12.5% threshold and the anchor switched, exactly as
designed. The report's still-decaying solve-rate-vs-distance curve isn't a re-anchoring bug —
re-anchoring resets which frame is being MATCHED against, but can't fix an underlying content-
distinctiveness ceiling if the images themselves are hard to match at any distance, which the
mentor's CCT-duplicates finding is the more likely explanation for.

**The Phase 1.3 duplicate guard** (`import_media`/`media_sheet` flagging near-duplicates so
neither an agent nor `make_synthetic_reference` picks two twins as different photos) doesn't
exist in the codebase yet — the roadmap's own status line lists 1.3 as "isn't reported yet."
Building it now, before the new photos exist to regenerate against, would be working blind on
a feature whose only current consumer (the regeneration step) is itself blocked on those
photos arriving — left for when they do.

**Not started, checked with the user first**: the hybrid per-frame race (OpenCV vs. Rust LK,
keep whichever is plausible with the lower residual). Real architecture, not a tuning pass —
Rust's `AlignSample` doesn't currently expose the `residual`/`inlier_frac` `AlignFit` computes
internally (align.rs), so the public struct, its TS binding, and `align_reference`'s output
shape would all need to grow those fields, plus a new per-frame merge step above both
aligners. Flagged rather than started unasked, per this session's own pattern for anything
touching public API surface.

## Not done

- The hybrid per-frame race between both aligners — scoped above, checking with the user
  before starting given the API-surface change.
- Easing accuracy and the missed-key rate are still far off any real target under both
  aligners and both metrics (old and corrected) — parked per the mentor's own steer: a fitter
  can't find real segment shape from sparse, hard-to-match samples, so this waits for the
  solve-rate/content issue to be addressed first.
- The Phase 1.3 duplicate guard (`import_media`/`media_sheet` near-duplicate flagging) — not
  built; blocked on nothing technical, just sequenced after the new photos actually arrive.
- Regenerating the 20 synthetic references from real HSI photos and re-scoring (accuracy +
  solve rate by distance) — blocked on the user providing `SE-test-assets\photos\`.
- The seed-13 narrow-clean-core edge case (3 of 480 possible shot-channels, both aligners) —
  documented, not fixed; would need either a minimum-core-width floor or falling
  `sample_every_ms` down to fit whatever core remains.
