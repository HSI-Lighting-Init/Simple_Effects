# Status — Phase 3's decomposition core, first full run

Written for the mentor. The successor to Gate S's spike (`sam/gate_s_hybrid.py`) — its own module
doc names four things it deliberately left out for the go/no-go question alone: multi-key-frame
detection, per-shot concept phrasings instead of one fixed global list, bidirectional propagation,
and cross-key-frame dedup by mask IoU instead of only within-one-frame box IoU. This pass builds
all four and runs them on the real 15-shot Envato reel. Text boxes (Claude + regions.rs) are still
out of scope, per the same reasoning the spike gave.

## What was built

- **`sam/keyframes.py`** — per shot: always start/middle/end, plus up to 3 extra frame-diff local
  maxima at least `MIN_GAP_FRAMES` apart and above a `PEAK_PROMINENCE_RATIO`-times-median
  threshold (shots.rs's own adaptive-cut idea, applied within one shot instead of across shot
  boundaries). Verified against real shots before trusting it: shot_05 (the "stack of torn cards"
  shot) picked 6 key frames including several genuine content changes; shot_11 (the roadmap's own
  "busy" example, 19 detections → 14 tracks in the spike) picked 6 frames clustered late in the
  shot, matching where it visibly gets busiest.
- **Per-shot concept phrasings** — a `phase3-phrasings` workflow spawning one Claude agent per
  shot, each reading that shot's own key-frame images and proposing SAM3 phrasings. Took two
  passes: the first prompt asked for "distinct visual elements" broadly and returned things like
  "decorative x mark" and "dot grid pattern" — SAM3 correctly found MANY genuine instances of
  these (this reel's own background chrome), none of which are cards or text lines the roadmap's
  quality bar cares about, and tracking all of them cost real time (shot_11 alone: 163 raw
  detections, 120 tracked, 13 minutes). Rewrote the prompt to name only cards and logos and
  explicitly exclude decorative/texture motifs; the second pass correctly returned an EMPTY list
  for 5 shots (pure background/texture, nothing to track) and 1-2 tight, specific phrasings for
  the other 10. Same shot_11 example after the rewrite: 26 raw detections, 14 tracked, 90 seconds
  — an 8.6x speedup, from fixing the prompt, not from touching any dedup threshold.
- **`sam/phase3_core.py`** — the real pipeline: SIFT-quality-equivalent flow is SAM3 image-mode
  detection at every key frame (not just frame 0), within-frame box-IoU dedup, bidirectional
  `propagate_in_video` (`reverse=True`/`False` from each candidate's own seed frame — confirmed
  this SAM2.1 API supports it directly, no workaround needed) for every surviving candidate, then
  cross-key-frame dedup by MASK IoU at frames where two tracks' spans overlap (a raw box compare
  across different times isn't meaningful — the element may have moved between key frames).

## Bugs found and fixed before any result was trustworthy

- **bfloat16 → numpy**: `to_np()` needs `.float()` before `.numpy()` on a bfloat16 tensor (numpy
  has no bfloat16 dtype) — the spike's own `to_np` handled this; my first draft didn't, dropped
  when simplifying.
- **Decord's array bridge**: `VideoReader[i]` returns a torch.Tensor once SAM3/SAM2 have switched
  decord's global bridge (found live: any shot processed BEFORE the run's first real SAM2
  `init_state` call — i.e. a shot with zero candidates, like shot_00 — still gets decord's own
  native NDArray, whose accessor is `.asnumpy()`, not `.numpy()`; the untouched case silently
  produced a garbage `(1,1)` object-array instead of raising, and `Image.fromarray` on it failed
  with "Cannot handle this data type"). Fixed by making `to_np()` check `.asnumpy()` too.
- **Overlay legibility**: the first working overlay render used a 40%/60% alpha blend, matching
  the spike's own style. A saved frame LOOKED unchanged to my own eyes; I didn't trust that and
  diffed it against the source frame pixel-by-pixel — 21.7% of pixels had genuinely changed (mean
  diff ~15/255). The blend was real, just imperceptible against this reel's own vivid,
  already-saturated color-block card design. Switched to bright outline contours
  (`cv2.findContours`/`drawContours`) plus a small numbered label swatch, which reads clearly
  regardless of the background underneath — confirmed by eye before committing to the full run.

## Full 15-shot run

461.5s total (roadmap's own estimate: "about 4-6 min per reel once the extra key frames and
backward passes are in" — landed just outside that, likely from the two extra decode passes per
shot this version does that the spike's forward-only single-pass didn't need), 5.57 GB peak VRAM
(essentially unchanged from the spike's own 5.8 GB).

| | |
|---|---|
| Shots with tracked elements | 9 of 15 |
| Shots correctly empty (background/texture, no cards or logos) | 6 of 15 |
| Total surviving tracked elements | 36 |
| Total raw detections before any dedup | 134 |

A gallery of every shot's own key frames, each surviving track outlined and numbered, is
published for the user to judge — the roadmap's own stopping point ("stop at the quality
milestone... with overlay sheets for the user to judge") needs their eyes on this, not a
self-reported pass/fail from this side. Not yet counted against ground truth (how many cards/text
lines are ACTUALLY visible per shot) — that count is exactly what the gallery is for.

## Update — the mentor's review caught a real miss, plus two other fixes, re-run and republished

The mentor reviewed the gallery before asking the user to count: shots 5, 7, 8, 9, 11 looked
right (card-by-card outlines, torn edges included). The real issue: **shot_10 was wrongly
reported "correctly empty."** All 5 of its key frames show a fan of 4-7 torn photo cards, zero
detections. Its only phrasing was "basketball photo card" — and Gate S's own earlier finding
(unreported until now) was that SAM 3 fails specifically on the word "card" ("photo card" found
nothing; "photo" alone worked). One phrasing per element type was never enough robustness against
a single bad wording.

**Fix 1 — phrasing robustness.** Rewrote the phrasing workflow: every element type now gets 2-3
varied phrasings, always including one plain noun ("photo"/"picture"/"logo"), never the word
"card" (enforced in the prompt AND filtered again in code as a safety net). Added a zero-detection
guard: if the phrasing pass says elements ARE present but the first detection pass finds nothing,
retry with a generic fallback ("photo"/"picture"/"logo") before accepting empty; if still zero,
flag the shot explicitly rather than silently reporting it as correctly empty. Re-ran shot_10:
39 raw detections, 5 tracked objects (was 0). No shot came back flagged in the full re-run — every
shot with expected elements found something, either on the first pass or the retry.

**Fix 2 — the fade-to-black false positive** (self-flagged in the first version of this doc, the
mentor approved fixing it as cheap): `keyframes.py` now also tracks per-frame mean luma and
excludes near-black frames from change-energy peak selection (the mandatory start/middle/end
frames are exempt — they're structural, not peaks). shot_14 went from 6 key frames (4 solid
black) to 3; shot_12 dropped one black extra peak too. No other shot was affected.

**Fix 3 — text boxes (Claude + regions.rs), now built.** `analyze_reference` already runs
regions.rs's `detect_text_regions` per shot internally — called it directly on each already-
extracted single-shot clip (which the command sees as one shot with zero internal cuts) rather
than building a new Rust command. Two real bugs found before any box was trustworthy:
- `analyze_reference`'s own reported `width`/`height` come from its internal 4096px-wide analysis
  decode (`extract_frames(path, &[0], 4096)` in `mod.rs`), not the clip's real 960x540 resolution
  — converting the fractional region coordinates to pixels using that reported size put every box
  off the actual canvas, invisible. Fixed by keeping the boxes fractional end-to-end and
  converting at draw time against the real frame being drawn on.
- A relative `shot_path` (fine for this script's own local decord/ffmpeg calls) silently resolved
  to nothing when sent to the MCP bridge, a separate process with its own working directory —
  "could not determine the video's duration." Fixed by making the path absolute where it's first
  constructed.

Text regions are drawn as static white rectangles (not SAM2-tracked — title/caption text in this
kind of reel is a fixed overlay while visible, and regions.rs already reports its own time span,
so tracking would cost real GPU time for no real gain) labeled T0, T1… only on key frames inside
each region's own detected span. They're genuinely coarse — regions.rs's own candidate
granularity (grid-cell-sized bands), not tight boxes around actual letters — noted plainly in the
gallery so the user doesn't mistake them for precise OCR boxes. **One known gap, reported rather
than hidden**: the mentor specifically flagged that the ENVATO wordmark in shots 12-13 should go
down this text/logo path since SAM3's own box there only covers the "E". Ran text-region detection
on both shots: shot_12 found zero regions, shot_13 found 5 (none obviously the wordmark). The
text/logo path doesn't automatically fix the wordmark's box — that specific issue is still open.

**Full re-run, all three fixes**: 602.2s (up from 461.5s — the added `analyze_reference` call per
shot, plus one extra full detect+track pass on any shot that needed the retry guard), 5.57 GB peak
VRAM (unchanged). Same 9-of-15 shots with tracked card/logo elements, now including shot_10 (36 →
41 tracked elements with shot_10's 5 added); 21 text regions found across 8 shots. Gallery
republished with the corrected data, the new text-region boxes, and explicit FLAGGED/retried
labeling so the user can see exactly which shots needed a second attempt.

## Update — text done as designed: Claude reads it directly, regions.rs demoted to a cross-check

The mentor reviewed the republished gallery before the user's count: cards were ready (shot_10's
fan outlined per card, stacks in 04/05/08 separating cleanly). Text was not: regions.rs's own
rectangles are coarse and often misplaced — shot_00's box floated above "SPORT" rather than on it,
shot_04's box covered cards rather than text, and the ENVATO wordmark in 12-13 was only partly
boxed. That's the heuristic's own ceiling, not a bug to tune away.

**Text, rebuilt as originally specified** ("text boxes from Claude + regions.rs" — Claude primary,
regions.rs support, which the first implementation had backwards): a new workflow spawns one agent
per key frame (60 total, one per image, so its coordinates map back 1:1 — no aggregating across a
shot's own frames) asking Claude to read every text line directly: a tight box, the exact content,
and a role (headline/label/logo wordmark). 103 raw text lines came back across all 60 frames.

**Tracking, not a new problem — reused the existing infrastructure.** Kinetic titles (the mentor's
own example: "SPORT" revealing/growing across a shot) meant per-frame OCR content genuinely varies
for the same real element ("SPORT" / "SPO" / "SPOR_" / "ePORT" for one title depending on how much
of it is visible at that instant) — exact-content matching across frames would have missed these.
Instead of building a separate matcher, every (frame, box) pair is treated as its own candidate,
same as SAM3's card candidates: within-frame box-IoU dedup, bidirectional SAM2.1 tracking from
every survivor, cross-key-frame mask-IoU dedup. A static caption's multiple seed frames converge to
near-identical masks and get merged by the same dedup that already collapses duplicate card
detections; a genuinely kinetic title's seed tracks simply don't end up overlapping as much, and
survive as distinct or partially-distinct tracks — no static-vs-kinetic classifier needed.
regions.rs's own `text_regions` are kept in the result JSON only as a secondary cross-check/
time-span hint, no longer drawn as the primary text overlay.

Verified directly before trusting the pipeline: shot_00's "SPORT" (previously the mentor's own
example of a misplaced box) now tracks at 92% stability with a mask contour that precisely hugs
the actual glyph outlines, not a floating rectangle near them.

**One gap, reported rather than forced.** The mentor specifically wanted the ENVATO wordmark in
shots 12-13 to go down this path since SAM3's own box there only covers the "E" — this was already
tried with regions.rs (STATUS's earlier update) and failed to find it. Re-checked with the new
Claude-read approach: still not resolved cleanly — the wordmark isn't reliably distinguished from
the surrounding card/logo content in these two shots. Not forced; left as a known, visible gap in
the republished gallery rather than claimed fixed.

**Full re-run, text tracking added**: 1218.2s total (up from 602.2s — 615s of that is text
tracking alone: 103 raw lines, many surviving within-frame dedup, each costing a full bidirectional
SAM2.1 pass), 5.58 GB peak VRAM (essentially unchanged). 46 card/logo objects (unchanged from the
previous pass) plus 45 tracked text objects across the 15 shots. Gallery republished with two
separate filmstrips per shot — cards/logos (colour-outlined, as before) and text (white/cyan-
outlined, labeled with role + content) — so the user does two clearly separated counts, per the
mentor's own framing, rather than one shared image trying to carry both.

Two follow-ups the mentor flagged explicitly as **later, not now** (not started, and shouldn't be
without asking first, since the runtime one specifically trades off against the tracking quality
this pass just built):
1. The masks in shots 05 and 10 are speckled with holes. Before they become mattes (Phase E3),
   post-process: morphological close, fill holes, keep the largest connected component per track.
2. 1218s for a 28s reel is well over the ~10 min/30s budget the mentor named (602s alone already
   ran slightly over) — acceptable for this validation pass per the mentor's own "fine for now,"
   but real if this pipeline runs routinely. The mentor's own suggested angle: fewer SAM passes on
   text-only shots (e.g. skip full bidirectional tracking for text lines that are provably static
   across their observed key frames, rather than tracking every one as if it might be kinetic).

## Update — logo-as-box, and grouping text into elements before any SAM call

The mentor's read on the republished gallery: cards were ready for the user's count (shot_10's fan
outlined per card, stacks in 04/05/08 separating cleanly); good reuse on the card-dedup-for-text
approach. Three follow-ups, none blocking the count already in hand:

**1. Production path** — explicitly deferred by the mentor to the later app-integration step (their
own "item 4"): the phrasings/text-reading currently run as this session's own dev workflows need to
eventually run inside the app's real extraction flow (the in-app model provider or MCP client,
structured JSON, Phase 0.3 cost logging). Not started — correctly out of scope for this pass.

**2. ENVATO is a logo, not a segmentation target.** In a template it becomes a `replace_logo` slot
needing a box/span/motion, not a pixel mask — "don't spend more on segmenting it." Every text
element with role `"logo wordmark"` now skips SAM entirely: it's reported as a single box (Claude's
own reading, kept as-is) rather than tracked. Re-checked shot_12's ENVATO: content now reads
correctly as the full "ENVATO" (Claude read the whole word directly, unlike either the old SAM3 path
— "only covers the E" — or the regions.rs path, which found nothing there at all), with a box that
covers nearly the entire wordmark at the frame it's most visible, and costs 0 seconds of SAM time
(previously part of a 10.7s card-tracking pass). Not perfectly pixel-tight, but that was never the
ask — a box, span and (if it moves) motion is what a `replace_logo` slot needs.

**3. Group text seeds into elements BEFORE any SAM call, one pass per element, skip SAM for static
text.** 615s of the previous run's 1218s total was text tracking alone — 103 raw Claude reads, each
getting its own full bidirectional SAM2.1 pass. Rebuilt: candidates are now grouped into elements
first (`group_text_candidates`), using role, box-CENTRE proximity across frames (a reveal/grow/zoom
animation keeps a roughly stable centre even as its box size changes a lot), AND content similarity
via `difflib` (not exact match — the same real "SPORT" reads as "SPO"/"SPOR_"/"ePORT"/"RT" depending
on how much is visible at a given instant, so OCR noise has to be tolerated, just not so much that
two genuinely different words merge). A group whose own box barely moves (every pairwise IoU across
its members clears 0.7) skips SAM too — a stable box needs no tracking to know it's stable.

**A real bug found in the first version of this grouping, caught by checking the actual overlay
image rather than trusting the numbers**: spatial-proximity-only grouping (no content check yet)
merged three separate, closely-stacked caption lines in shot_06 — "DYNAMIC" / "SPORT" / "OPENER" —
into one group, and the count silently dropped from 7 real elements to 4, keeping only whichever
had the longest content string as the group's own label. The two others weren't just mis-tracked,
they vanished from the count entirely. Fixed by requiring BOTH spatial proximity AND a difflib
content-similarity ratio ≥ 0.5 to merge two reads — re-verified visually: all three labels ("T2
label: DYNAMIC", "T3 label: SPORT", "T4 label: OPENER") now outlined separately in the same frame.

**Full re-run**: 729.9s total (was 1218.2s — a 40% cut), text tracking alone dropped from 615s to
135s (4.6x), 5.58 GB peak VRAM (unchanged). Same 45 total text objects as before the optimization —
23 now box-kind (no SAM spent), 22 mask-kind (genuinely tracked) — confirming the speedup came from
skipping unnecessary SAM calls, not from finding fewer real elements. Gallery republished with the
corrected data; card overlays are byte-identical to the previous version (untouched code path), only
the 60 text overlay images needed re-uploading.

## Update — Phase 3 quality milestone: met on the user's review

The user reviewed the republished gallery directly: "gallery looks good, it has tracked the shots
well." The mentor's call: that verdict is sufficient — the user owns this gate, so no manual
percentage count was requested. Recorded as **Phase 3 quality milestone met on the user's review**.
The numeric bar (≥80% tracked, ≤10% duplicate) moves to automated scoring once the synthetic
references are regenerated from real photos: element count (≥95%) and per-element tracking scored
against the synthetic truth directly, floating elements included — no further user labour needed
for that measurement.

**Next, scoped by the mentor, approved by the user, sequenced by the user**: "app integration"
(roadmap's item 4) is four pieces ending at a new **Gate C** — rebuild the Envato reel from its
tracked elements and show the user original vs. rebuild side by side, the first remake where
elements are actually separated (not just a background pass). The four pieces: (1) production path
for the Claude steps (phrasings/text/roles) through the app's own runtime model, with cost logging;
(2) the SAM service started by the app itself, plus `segment_concepts`/`refine_element` tools;
(3) per-element fitting — each tracked mask through the OpenCV aligner, constrained to that
element's own region, then the 2.5 fitter, to real keyframes; (4) `rebuild_from_analysis` building
one layer per element (cards as image layers with sprite placeholders, text as text layers, the
logo as a box slot). The user's own sequencing: build (3) and (4) first, using the masks/text
already produced by the current pipeline run, straight to the Gate C video — then (1) and (2), the
production-path plumbing, once there's a visible result proving the payoff.

## Not done

- **The quality-milestone count itself** (≥80% tracked, ≤10% duplicate) — needs the user's read of
  the gallery, now covering both cards and text; not computed here.
- **Mask post-processing** (morphological close, fill holes, largest component) — mentor-flagged,
  explicitly deferred to before Phase E3 (mattes), not this pass.
- **Production-path integration** (item 4: phrasings/text-reading inside the app's real extraction
  flow, not this session's dev workflows) — mentor-flagged as the later app-integration step.
- **Runtime**: 729.9s for a 28s reel is closer to the mentor's ~10-minute target than the 1218s it
  replaced, but still not quite there — card tracking (unoptimized this pass) is now the larger
  remaining share.
- Per-element FITTING (roadmap's 3.4) — once elements are tracked, giving each its own motion
  keyframes (reusing 2.5's fitter) is the next piece after the quality milestone is judged.

## Update — Gate C piece 3: per-element mask-shape motion fitting (`sam/fit_elements.py`)

Built and validated on shot_08's 5 card tracks (`sam/test_fit_elements.py`). The mentor's catch
before writing any of this: these cards contain FOOTAGE (a basketball clip plays inside the torn
frame), so aligning RGB content measures the footage's own internal motion, not the card layer's
transform. Fixed by fitting the MASK SHAPE instead — per-frame moments (centroid, sqrt(area),
principal axis) give an initial-guess similarity transform, refined via ECC on the (blurred) binary
masks themselves, then RGB content is warped back through the inverse of the recovered transform and
classified still-vs-footage by how stable the warped crop is frame to frame.

**Two occlusion bugs found and fixed via live traces, not guessing, same discipline as the rest of
this session:**

1. A card sliding behind another in a stack dropped its visible area ~48000→18000 and flipped its
   apparent principal-axis angle by ~75° — not real rotation, a shape distortion from partial
   occlusion. Fixed by adding `spread_ratio` (sqrt of the mask's covariance-matrix eigenvalue ratio —
   near-constant under genuine uniform scaling, since that preserves shape) to `mask_moments()`, and
   gating `moments_to_transform()` on it (`SPREAD_RATIO_CHANGE_THRESHOLD=0.3`): frames whose spread
   has drifted too far from the reference's own are excluded as likely-occluded, not fit as zero-motion.

2. Retested and 4 of 5 tracks were clean, but track 1 still showed rot range `[-86.78, 0.35]`.
   Dumped raw per-frame moments: at frame 10→11 the area dropped 35% in one frame while spread_ratio
   barely moved (0.807→0.817, comfortably inside the gate) — this card's shape is close to square
   (spread_ratio ~0.8), so its principal-axis angle is poorly conditioned (near-circular/near-square
   shapes don't have a well-defined "long axis"; a modest boundary change from partial occlusion can
   swing the eigenvector direction tens of degrees without moving the eigenvalue ratio much). The
   spread_ratio gate is blind to this failure mode by construction. Fixed with a second, independent
   gate: `MAX_ANGLE_JUMP_DEG=25` caps how far an accepted rotation delta may jump from the **last
   accepted frame's** delta (not the reference). Because `prev_angle_delta` only updates on accepted
   frames, once frame 11 is rejected, frames 12-14 keep comparing against the same stale good value
   and keep failing too — the whole sustained-occlusion tail drops out together, not just the single
   transition frame. Retest: track 1's rotation range is now `[-0.49, 0.35]`; tracks 0/2/3/4 unchanged
   (no regression from the new gate).

**Content classification re-checked visually, not assumed**: saved the inverse-warped per-frame crops
for one track and inspected them directly — the card's framing is well stabilized (consistent edges/
corners across frames, confirming the warp-back math itself is correct), but the content inside is a
basketball player's legs/sneaker visibly moving frame to frame. All 5 tracks classify as `"footage"`,
and that's correct, not a bug: these Envato cards genuinely contain short video clips, not static
photos, confirming the mentor's original catch rather than contradicting it.

`fit_elements.py` is now validated and ready to wire into `phase3_core.py`'s main loop (computing
per-element fitting inline while masks are still in memory, per the standing decision to avoid
persisting raw masks to disk or re-running tracking). Next: piece 4, the one-layer-per-element
`rebuild_from_analysis` extension, then Gate C's side-by-side video.

## Update — Gate C piece 4: per-element rebuild, side-by-side video delivered

**A second real bug found via the same "predict a known point, check the error" discipline as the
occlusion-gate fixes above**: `classify_and_extract_sprite`'s own warp-back reconstruction added a
centre-pivot adjustment (copied from `align_opencv.py`'s DIFFERENT convention, which needs one — its
samples go through a separate `to_center_pivot()` step this module never runs). Checked by predicting
a track's own known per-frame centroids both ways: the raw matrix translation matched to ~1-5px, the
centre-pivot reinterpretation was off by up to 18px on a barely-rotating track (worse the more a track
rotates). Fixed by using the raw translation directly; re-verified no regression on all 5 test tracks.
This same raw-pivot formula is the one `rebuildFromAnalysis.ts`'s new `applyElementFittedMotion` composes
onto each element's own reference centroid — getting this convention right mattered twice over.

**Wired into the pipeline**: `phase3_core.py` now computes, per element (card and mask-kind text), its
fitted motion via `fit_background` (the real MCP tool, not a mock) and exports `refBbox`/`refCentroid`
(the exact point the fitted keyframes pivot around) alongside it. `rebuildFromAnalysis.ts` gained a new
`ElementLayer` type and a `buildShotElements` path: when a shot carries `elements[]` it builds one layer
per element instead of the usual single cover-fit layer, each placed/animated via the same verified
composition formula. `sam/build_gate_c.py` assembles Phase 3's raw per-shot output into the shape that
path consumes (shot boundaries from cumulative `ffprobe` durations — confirmed summing to ~28.1s,
matching the reel) and calls `rebuild_from_analysis` for real.

**One process mistake, caught before it cost more than a re-run**: edited `phase3_core.py` to add the
`refCentroid` export while a 20-minute full-reel run was already executing — a running Python process
doesn't pick up source edits mid-flight, so that run completed with the old code and silently lacked
the field the rebuild needed (a `KeyError`, not a crash during the run itself). Re-ran clean (no code
edits while it's running, this time) rather than patch around it by approximating the centroid from
`refBbox`'s own centre — that would have reintroduced the exact systematic error the pivot fix above
had just removed.

**A second, visually-caught bug**: the first real `rebuild_from_analysis` call succeeded and exported a
video, but `audit_export` flagged 108 of its 112 frames as suspect. Rather than trust or dismiss that
number, extracted real frames and looked: several showed a large solid black oval over blurred content.
Traced it to the "still" card sprites themselves (`classify_and_extract_sprite`'s temporal-median
output) — pulled all 7 sprites this run produced into one grid and every single one was broken (dark,
blurry, geometric artifacts, not a clean photo). Systemic, not one bad card. Rather than spend another
20-minute pipeline run chasing the sprite bug itself, routed "still" cards through the SAME path as
"footage" cards (the original shot clip, already known-correct) — the broken piece was only the sprite
*image*, not the element's own placement/timing/motion data, which is unaffected. Re-ran just the
rebuild (no SAM/GPU work, seconds not minutes): `audit_export` now reports 0/0 (it only checks
image-kind layers, and there are none left) — consistent with the suspects having been exactly the
broken sprites, not a wider problem. Re-extracted frames and visually confirmed: recognizable basketball
photo cards, correct torn-paper styling, correct text ("DYNAMIC OPENER", "SPORT", role labels),
reasonable stacking and timing, no more black ovals.

**Known, documented gaps** (surfaced, not hidden — this is Gate C's whole job):
- **Footage cards show the whole source frame**, not cropped to just that card's own region — no
  per-layer video crop/matte exists in this engine yet. Position/size/timing are correct; content is
  not. The natural next engine feature this points to (alpha matte / per-layer crop for video layers).
- **"Still" sprite extraction is broken** (`classify_and_extract_sprite`'s temporal median) — worked
  around for this Gate C pass by treating every card as footage-sourced, not fixed at its root. Needs
  its own diagnosis (likely the warp-back stabilization itself, not the median step) before the
  still/sprite path can be trusted anywhere else.
- **SSIM scoring's own methodology is shakier than intended, not fully trusted**: `gate_c_score.py`
  samples 3 timestamps per element against a STATIC reference bounding box (documented in its own
  module doc) and uses OpenCV's `CAP_PROP_POS_MSEC` seeking (known-imprecise on many codecs). Mean
  score came back 0.235 — visually spot-checking one low-scoring element's actual frame pair showed a
  genuinely reasonable reconstruction (recognizable cards, correct style) compared against a tiny
  (30×16px) edge-of-frame crop dominated by noise, not a real quality signal. The numbers are real and
  saved, but reported as directional at best, not as a trustworthy gaps-by-error ranking yet — a
  frame-accurate seek (decode-and-count rather than ms-seek) and each sample's own interpolated (not
  static) box would be needed before trusting this ranking for engine-priority decisions.

**Deliverables**: `sam/gate_c_rebuild.mp4` (the reconstruction), `sam/gate_c_side_by_side.mp4` (original
reel | rebuild), `sam/phase3_full_out7/gate_c_analysis.json` (the assembled TemplateAnalysis), `sam/
sprites_grid.png` (the 7 broken sprites, for whoever fixes that path next).

Also found and fixed during this work, unrelated to Gate C itself but surfaced by it: `open_project_
file` (added for Gate C's own "let the user inspect the saved project" need) is missing a `loadProject
Media` step the app's real "Open Project" UI flow always runs, and live-preview rendering of a heavy
project (91 layers / 10 simultaneous video sources) is unreliable regardless (one render attempt
crashed the app outright) - the EXPORT path renders correctly through a separate, more careful
pipeline. Not fixed - flagged here since it'll bite the next thing that opens a heavy project live.

## Update — Gate C's own "footage card" gap, upgraded: roadmap item 4, pieces 1 & 2

With Gate C's video confirmed working, moved to the user's own next-sequenced items: "move the Claude
steps into the app (1) and make the SAM service part of the app (2)."

**Piece 1 — the Claude steps (phrasings/text/roles) through the app's own runtime, done.**

First attempt got the architecture backwards: built `extractFromImages` (a new Anthropic BYOK vision-
call primitive in `providers.ts`) assuming the APP itself should independently call the Anthropic API
with its own configured key, mirroring how `ScenarioPanel`'s own agent works. The user corrected this
directly: *"there is no anthropic key just use the mcp bridge"* — the right shape is the SAME one
every other DEV ONLY tool already uses (`analyze_reference` measures, but text content is explicitly
left to the caller; `match_transition` scores candidates the caller already rendered): the MCP CLIENT
(whichever AI agent is driving the app, e.g. this very session via the Read tool) supplies the vision
work, the app's own job is just to PERSIST the submission into the exact shape `sam/phase3_core.py`
already consumes. Removed the wrong `extractFromImages`/BYOK code entirely rather than leave unused,
architecturally-contradicted dead code behind.

Built instead: two new Tauri commands (`read_text_file`/`write_text_file`, alongside the already-added
`append_text_file`) for a read-merge-write pattern; `src/agent/extraction.ts`'s `submitPhrasings`/
`submitTextLines`, which merge one shot's (or one key frame's) submission into a `phrasings.json`/
`text_lines.json`-shaped file at a caller-given path, replacing any prior entry for that exact shot/
frame (a resubmit replaces, doesn't duplicate) while leaving every other shot/frame's own entries
untouched, plus a durable JSONL audit trail (`extraction_submissions.jsonl` in the app's local data
dir) of every submission. Two new MCP tools, `generate_phrasings`/`read_text_lines`, expose this -
their own descriptions are explicit that the TOOL does not read images or call any model, only persists
what the caller already determined by looking at the frame itself.

**Tested for real, not just typechecked**: read shot_08's own key frame 0 directly (same vision access
used throughout this whole session), submitted real phrasings + text lines through the live MCP bridge,
confirmed the output files are byte-for-byte what `phase3_core.py`'s own `phrasings.get(shot_name, [])`/
`text_lines_by_shot.get(shot_name, [])` consumption code expects (ran that exact consumption snippet
against the submitted files). Also verified the merge semantics directly: resubmitting frame 0 with
different content replaced its 3 lines with 1, cleanly, while a separate frame 7 submission accumulated
alongside frame 0 rather than clobbering it.

**Piece 2 — the SAM service started by the app itself, done.**

New `sam/sam_service.py`: a persistent localhost HTTP service wrapping SAM3 + SAM2 + fit_elements.py's
own mask-shape fit, loading both models ONCE (the ~7s cost every dev-session `phase3_core.py` run
already pays per invocation). Deliberately thin — imports `phase3_core.py`'s own `detect_candidates`/
`track_bidirectional` directly rather than a parallel copy that could drift from the already-validated
pipeline. Two endpoints: `/segment_concepts` (SAM3 detection at one frame across given phrasings) and
`/refine_element` (SAM2 bidirectional tracking from a seed box/frame + the mask-shape fit, returning
`refBbox`/`refCentroid` plus RAW per-frame `samples` — NOT yet keyed down; the caller runs its own
`fit_background` on them, same division of labour `build_gate_c.py` already uses, so the Python service
never calls back into the app itself).

New `src-tauri/src/sam_service.rs`: process lifecycle for that script, own module with its own
`OnceLock` global state (mirrors `mcp_bridge.rs`'s own shape — this has nothing to do with `AppState`'s
documented project/history/shaped lock ordering). Per the Explore agent's own research first: no
precedent anywhere in this codebase for spawning/managing a long-lived external process (ffmpeg is
always one-shot locate-spawn-wait, every call, never a persistent service) - genuinely new
infrastructure, not a wiring job like piece 1 turned out to be. Three Tauri commands
(`start_sam_service`/`sam_service_status`/`stop_sam_service`), two new MCP tools calling the service
directly over `fetch()` from the frontend (`segment_concepts`/`refine_element` — CSP is open, same
precedent `providers.ts`'s own direct Anthropic calls already set).

**Three real bugs found live, each one only visible by actually running the full chain, not by
reading the code:**

1. **Thread-local autocast.** First version used `ThreadingHTTPServer`; the very first real request
   threw `mat1 and mat2 must have the same dtype, but got BFloat16 and Float`. `torch.autocast`'s
   context is thread-local — the module-level `__enter__()` ran on the main thread, and
   `ThreadingHTTPServer` handed every request to a fresh worker thread that never saw it, so SAM3's
   own bf16 weights hit a plain float32 activation. Fixed by switching to a single-threaded
   `HTTPServer` — every model call was already going to be sequential anyway (SAM2's video predictor
   keeps state across `init_state`/`propagate_in_video` and isn't written for concurrent use), so this
   cost nothing and removed a now-pointless `MODEL_LOCK` along with it.
2. **No log visibility.** The app is `windows_subsystem = "windows"` — a spawned child's default-
   inherited stdio goes nowhere visible. An early version left the process looking "alive but stuck"
   for 60+ seconds with zero way to tell slow-loading apart from silently hung. Fixed by redirecting
   the child's stdout+stderr to `sam_service.log` next to the script (the same filename the dev-
   session's own manual test runs already used).
3. **Missing CORS.** `start_sam_service`/model loading worked, `/health` answered fine to `curl` — but
   `segment_concepts` failed with a generic `Failed to fetch` from the webview, every time, with no
   server-side error logged at all. A JSON POST is a non-"simple" request: the browser sends a CORS
   preflight `OPTIONS` first, and `sam_service.py`'s plain `BaseHTTPRequestHandler` had no handler for
   it and sent no `Access-Control-Allow-*` headers — the real request never even reached the service.
   `curl` doesn't do CORS preflight at all, which is exactly why direct `curl` testing looked fine the
   whole time this was broken. Fixed by adding `do_OPTIONS` plus `Access-Control-Allow-Origin` on every
   response. (`providers.ts`'s own Anthropic calls never hit this because api.anthropic.com correctly
   implements CORS itself — this was the first LOCAL service this app's frontend ever called directly.)

**Tested for real, full lifecycle, through the live MCP bridge** (not just typechecked): `sam_service_
status` → false, `start_sam_service` → ready in 9.3s, `sam_service_status` → true, `segment_concepts`
on shot_08's own key frame → 7 candidates, `refine_element` on the first candidate → `refBbox=[592,
274, 798, 539]` with 15 samples — byte-identical to both the standalone `sam_service.py` test AND the
original `phase3_core.py` pipeline's own output for this exact element, confirming the reused logic is
unchanged — then `stop_sam_service` → stopped, `sam_service_status` → false, process confirmed gone
from the OS process list.

**Roadmap items 1 and 2 are both done.** Pieces 3 and 4 (per-element fitting, the rebuild) were already
done earlier via Gate C. The full "template decomposition" pipeline the roadmap laid out — phrasings,
text reading, SAM segmentation/tracking, per-element fitting, rebuild — had a real, tested path through
the app's own runtime end to end, not just dev-session scripts, but still only reachable via the MCP
bridge (no normal end user drives that).

## Update — Phase 7: "drop a video, get a template" (the UI entry point)

User asked to continue to this directly after items 1/2. Confirmed scope first (AskUserQuestion) since
it raised the exact kind of question that went wrong before: with no external agent attached during
normal end-user use, something still has to do the vision analysis - meaning the app's OWN BYOK
Anthropic key after all (ScenarioPanel's own), the opposite of item 1's own "there is no anthropic key,
just use the mcp bridge" correction. Both are correct, for different callers - `extraction.ts`'s tools
assume an external agent (e.g. this very session) already has vision access; `templateExtractor.ts`
assumes nobody does. Re-added `extractFromImages` (deleted after the first correction) with a doc
explaining exactly why both now coexist, so the next person doesn't "fix" it back out again.

**REPLACEMENT, not reconstruction — a real design correction caught before it shipped wrong, not
after.** First draft of the assembly logic mirrored Gate C's own `build_gate_c.py` too closely:
routing each card element through its sprite PNG or the original source clip, same as Gate C's own
"prove the pipeline rebuilds the ORIGINAL faithfully" job. But Phase 7's whole point is the opposite -
applying the reference's measured structure to the USER's OWN new media. Caught by re-reading what
Gate C's own code was actually FOR before reusing its shape here. Checked whether `stillCard` vs
`footageCard` are even behaviourally different in `buildShotElements` first (they're not — both just
index into the same media pool and apply fitted motion identically; the label is cosmetic) — so the fix
was a straightforward "cycle through `newMedia` like `rebuildFromAnalysis`'s own existing default path
already does," not a new mechanism.

**Three new pieces, each extending or reusing something already proven rather than building parallel
infrastructure:**
- `sam_service.py` gained three endpoints (`/detect_keyframes`, `/process_shot`, `/process_text_lines`),
  each a thin wrapper around `phase3_core.py`'s own already-validated functions
  (`detect_key_frames`/`run_shot`'s own detect-track-dedup/`track_text_lines`'s own grouping), MINUS
  their internal `fit_background` calls. Found live, mid-build, before it shipped broken: `run_shot`/
  `track_text_lines` normally call this app's `fit_background` tool over the MCP bridge
  (127.0.0.1:8787) - an opt-in dev feature a real end user won't have enabled. Reusing them as-is would
  have silently broken for anyone who isn't running this session's own dev setup. Fixed by having the
  service return RAW unfitted samples and moving the `fit_background` call into the TS orchestration
  layer, calling the real Tauri command directly via `invoke()` - no MCP bridge involved anywhere in
  the new flow.
- New `extract_shot_clip` Tauri command (ffmpeg, frame-accurate re-encode, not a stream copy - a
  stream copy can only cut at a keyframe, and a shot boundary landing mid-GOP would silently start the
  extracted clip early/late). No shot-splitting capability existed anywhere in the app before this -
  checked first, confirmed by searching the whole command surface.
- `src/lib/templateExtractor.ts`: the orchestration itself, and `src/components/TemplateExtractorDialog.tsx`,
  wired into the Templates menu as "🤖 AI: Extract template from video…", following the SAME
  `onCreate*`-returns-a-`Project` convention every other template dialog in `App.tsx` already uses.

**Tested as far as possible without a real Anthropic key** (none available in this environment - a BYOK
feature genuinely needs the end user's own key, and asking for one isn't appropriate). Added a temporary
MCP test tool, ran the real orchestration function with a placeholder key, and inspected the actual
intermediate files it produced rather than trusting the error message alone: `extract_shot_clip` wrote a
real, playable frame-accurate `shot_0.mp4`; `/detect_keyframes` found `[0, 7, 14]` - the exact same key
frames this shot has produced consistently all session; the vision call reached Anthropic's real API and
got back a well-formed `401 authentication_error` (not a 400 malformed-request error, meaning the
request shape itself - headers, body, model name - was accepted). Confirms the whole chain is wired
correctly up to the vision-call boundary. The remaining untested surface (parsing a real phrasings/
text-lines response, `/process_shot` and `/process_text_lines` through the NEW orchestration glue,
`buildCardElements`/`buildTextElements`, the final `rebuildFromAnalysis` call) needs a real key - each
of those pieces was independently validated earlier (`/process_shot` etc. tested standalone against
shot_08; `fitBackground`/`rebuildFromAnalysis`'s own elements path proven throughout Gate C), so the
risk is concentrated in the new glue code specifically, not the underlying pieces. Removed the test
tool once done; the real entry point is the dialog's own "Start extraction" button.

**Still effectively dev-only in practice**, despite no longer needing an external MCP agent: `sam_
service.py` needs a local Python venv with SAM3/SAM2's model weights already downloaded, which nothing
in this app bundles or installs for a real end user yet. The dialog has explicit python/script path
fields because of this gap, not by design - genuinely shipping this needs the service bundled with the
app and those fields gone. Noted as the natural next scoping question, not resolved here.
