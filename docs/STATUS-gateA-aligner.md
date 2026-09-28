# Status — Gate A (the aligner spike)

Written for the mentor, per §0's loop. The core question Gate A exists to answer —
does a hand-rolled tracker actually work — has a real, validated answer for synthetic
ground truth and a real exported video. It does not yet have one for real, downloaded
reels: the only real-world asset on hand isn't the content type 2.4 targets. Recommending
**hold at "promising, not yet Go"** until a real photo-slideshow reel is supplied — see
"What's blocking Go" below.

## What was built

`src-tauri/src/analyze/align.rs`: pyramidal inverse-compositional Lucas–Kanade similarity-
transform alignment (Baker & Matthews 2004), Huber-weighted (IRLS) against a robust
per-iteration MAD-based threshold, initialized from the previous frame rather than
identity. ~400 lines including tests — a bit over the roadmap's "~250 lines" estimate,
mostly the six correctness tests. `align_shot` (`analyze/mod.rs`) is the per-shot harness:
decode frames at 256px (2.1's analysis resolution) via ffmpeg, align every sampled frame
against a reference frame, walking outward from the reference so each frame seeds from its
solved neighbour. Exposed as `align_reference` (Tauri command → `align::align_pyramidal`)
and a dev-only agent tool, same `sefx.mcpBridge` gate as `make_synthetic_reference`.

**A real bug, caught by the tests before it ever touched a video**: the first version
had a coordinate double-offset in the template-gradient step — `gradient_centered` added
the image-centre offset to coordinates that were *already* pixel-grid coordinates from the
caller, silently discarding ~75% of the image (anything past roughly the centre quadrant)
and, worse, still returning a plausible-looking (wrong) answer instead of failing loudly.
Six hand-built synthetic-warp tests — known scale/rotation/translation applied to a
textured test pattern, check the recovered transform against the known truth to Phase 2's
own tolerances — caught it immediately: every test but the trivial identity case failed.
Traced it by adding temporary iteration tracing and comparing `pts.len()` against the
expected pixel count (a suspicious `126²` instead of `254²` gave it away). Fixed and all
six pass now, including the two hardest: a 35% punch-in that a single pyramid level can't
converge on, and a corner covered in fake "moving text" that the Huber weighting has to
resist. This is exactly why the roadmap scoped a spike with unit tests before touching real
footage — this bug would have been much harder to diagnose against compressed video with
no ground truth to compare against.

## Checked

- `cargo check` / `cargo test --lib` — 107 passed (6 new aligner tests), 1 ignored.
- `npx tsc --noEmit` / `npx vitest run` — clean, 261 passed.
- **Live, via the MCP bridge** (rebuilt to build #44): ran `align_reference` on shot 1
  (0–2732ms, a plain Ken Burns zoom, no transition) of the `synthetic-1.mp4` reference
  from the 1.2 status note — a **real, H.264-compressed, exported video**, not the clean
  in-memory test images the unit tests use. Every one of the 11 sampled frames converged
  (`solved: true`). Recovered scale ratio at the second-to-last sample: **1.1116**, against
  the known truth (`truth.json`'s scaleX keys, 1.937 → 2.158) of **1.1140** — a 0.2%
  difference, comfortably inside Phase 2's ≤1% target. Rotation stayed within ±0.005° of
  the true 0°. Position grew smoothly and monotonically, consistent with the known pan (did
  not verify its exact px value — converting analysis-pixel translation to comp-space needs
  the resolution-ratio + anchor composition step documented in `align_shot`'s own doc
  comment, not yet wired into a script; the scale/rotation match alone is strong enough
  signal not to block on that for this note).

## What's blocking Go

Gate A's criterion is specifically about **real, downloaded reels**: "at least 90% of
still shots align … checked on side-by-side sheets of each frame vs the warped reference
frame." The one real-world asset supplied,
`SE-test-assets/reels/preview_540p_crf22_higher_quality.mp4`, turns out to be an Envato
MOGRT template showcase ("Dynamic Sport Opener") — stacked video-clip mockups, motion-
graphics titles, an "ENVATO" outro. Pulled frames across its full 28s: no still-photo
segment anywhere in it. That's roadmap reel-type 2 ("a fast-cut promo with transitions and
block captions"), not type 1 ("a photo slideshow with Ken Burns and captions") — the one
2.4's aligner is actually built to handle. Testing the still-image aligner against a video
with no still images in it would prove nothing either way.

**What's needed to actually call Go/No-go**: at least one real, downloaded photo-slideshow
reel (§0's test-asset table — type 1, specifically). Everything built here is ready to
point at it the moment it exists.

## Not done

- The full anchor/centre bookkeeping to convert analysis-pixel relative transforms into
  this engine's absolute comp-space `transform.x/y/scale/rotation` (documented in
  `align_shot`'s doc comment, not yet code) — needed for a `rebuild_from_analysis`-style
  step, not for judging whether the aligner itself converges.
- Auto-selecting the "widest frame" as reference (2.4's own spec) — `align_reference`
  takes an explicit `refMs` for now; picking it automatically (e.g. by edge density) is a
  small follow-up, not a risk item.
- 2.2 (cut/shot detection) and 2.5 (keyframe fitting) — out of Gate A's explicit scope
  ("implement only the 2.4 aligner, and 2.5 if time allows"); didn't get to 2.5 this pass.
- Scoring this through `score_recovery` end-to-end (building a "recovered" mini-Project
  from `AlignSample[]` and diffing against `truth.json` via the actual scoring function,
  rather than eyeballing the scale ratio by hand as done above).
