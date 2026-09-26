# Status — Phase 0.2 step 1 (the checker), template-extractor roadmap

Written for the mentor, per §0's loop ("at each gate, or when blocked, the coding agent
writes a short status note"). Checker is built, deployed, and gives a real signal — but
calibration is "distinguishes bad from good," not "pinpoints the exact bad frame," and I've
gone well past the roadmap's ~1 day budget for this step getting there. Reporting before
starting the leads (step 2).

## What's built

- `src-tauri/src/analyze/mod.rs` (new module): `extract_frames` (fast-seek single-frame
  grabs) and `audit_export` (the checker). `audit_export` Tauri command, `auditExport` in
  `api.ts`, and an `audit_export` agent tool (`src/agent/tools.ts`, in `READONLY`).
- Matching signal: not plain dHash (see "what changed" below) — a combined
  luminance-gradient hash (16×16, from the roadmap) **plus mean RGB**, at 4 center-crop
  zoom levels per source image (to absorb Ken Burns without knowing the exact transform).
  `MATCH_THRESHOLD = 130.0`, `SWAP_MARGIN = 3.0` (both `// ponytail`-marked, calibrated on
  one known-bad export, revisit if it starts missing real cases or flagging clean ones).
- `verbose: true` returns every scanned frame's numbers, not just flagged ones — needed
  for calibration, useful for future recalibration too.
- Build #38 deployed; 253 frontend + 100 Rust tests green (3 new Rust tests for the
  fingerprint function). **Not committed** — 0.1 already landed the prior session's work;
  this is new, uncommitted on top of it.

## What changed from the roadmap's spec, and why

The roadmap specified a plain 16×16 dHash. Built that first, tested it against the known-
bad export (the v3 checkpoint / `CCT Instagram Block v3.mp4`, confirmed bad at ~16.49s and
~18.43s by direct `ffmpeg -ss` frame extraction and eyeballing, back in the handoff's own
investigation) — it flagged **68 of 78 frames (87%)**, useless as a signal: dHash compares
only relative luminance between adjacent pixels, and two of this project's real images (a
warm-toned photo vs. a cool-toned graphic) turned out to have similar-enough luminance
structure that dHash alone gave only ~2 bits of separation between "correct" and "actually
a different image" — nowhere near a usable margin. Added mean RGB (same 17×16 downsample)
alongside the dHash; distance combines both. That's what got it down to a real signal (see
below), not just a smaller number.

## Calibration result

| Export | Frames | Suspects | Rate |
|---|---|---|---|
| `CCT Instagram Block v3.mp4` — **known bad** (confirmed by hand) | 78 | 8 | 10.3% |
| `CCT Instagram Block v4.mp4` — visually confirmed clean (12 samples, full duration) | 73 | 4 | 5.5% |

The known-bad export flags at roughly double the rate of the known-clean one, and v4's 4
suspects are all explainable as legitimate edge noise (a fade-in-from-black opening frame,
transition-boundary crossfades) rather than real corruption — so at the **whole-export**
level, the checker does what the roadmap's "done when" asks: it flags the known-bad export
differently from a clean one. That's the bar I'm calling met for this step.

**What it does *not* do**: reliably localize the *exact* bad frame. Neither of my two
hand-verified bad timestamps (16490ms, 18430ms) landed exactly on a flagged 250ms grid
sample. `verbose` mode showed why — at 16000ms, the wrong source (`1b45bae5...jpg`) and the
right one (`add1.png`) scored within ~0.1 of each other (statistical noise at this
resolution, not a real gap); at 18500–19250ms, a long-inactive carousel image (`2nd.png` —
the "Secret CCT" content I originally found bleeding in at 18.43s) was a *persistent*
near-tie with the correct source across 4+ consecutive samples — individually too small to
cross `SWAP_MARGIN`, but the pattern itself (a completely unrelated, long-inactive layer
repeatedly tying with the current one) is real corroborating evidence a per-frame margin
check doesn't capture. A persistence-aware rule (flag a *run* of near-ties, not just a
single frame past a threshold) would likely catch this specifically — deferred, not built,
in the interest of stopping the calibration loop at a defensible point rather than
continuing indefinitely.

**Known blind spot, expected and acceptable for this phase**: frames during the carousel
segment (a `Shape3D` cylinder with image decals — 3D-projected, perspective-warped content)
score noisily against my flat 2D center-crop fingerprints, since a rotating decal's on-
screen pixels aren't a simple crop of its source. 6 of v3's 8 suspects fall in that window.
The roadmap itself scopes perspective/3D as Phase 8 territory — not fixing this now, just
naming it so it isn't mistaken for a fresh finding later.

The checker is usable as-is: it correctly separates the two exports I have hard evidence
about, in the direction and rough magnitude you'd expect. "Exact frame localization" is a
nice-to-have the `verbose` mode + sheet can make up for (a human/Claude looking at the
flagged *region*, not just the flagged millisecond) — it did not block step 2 below.

## Step 2 — the four leads: all four applied, bug unchanged

Per §0.2's escalation ladder, all four leads were instrumented/fixed and tested — first
individually (decode barrier, the strongest hypothesis given "only large real photos
trigger it, never solid colours" — see the handoff), then all four together, since the
individual test showed zero change and the roadmap's own step 3 says to move to a combined
fix rather than test leads one at a time indefinitely:

1. **`useImage`/`useImageMap` (Preview.tsx)**: now await `img.decode()` before exposing
   the bitmap to Konva, instead of the `load` event (which doesn't guarantee decode
   completion — the actual spec gap). Fallback to `load` if `decode()` rejects.
2. **`preloadImages()`**: decodes every image in the current `images` map once, up front,
   before either capture loop's (`renderFrames` in App.tsx, and the real `onExport`
   deterministic capture) per-frame loop starts — so a layer becoming visible for the
   first time mid-run isn't racing its own first decode against the exact frame that
   captures it.
3. **`imagesRef`**: both capture loops now read the images map through a ref (App.tsx),
   matching the file's own existing pattern for everything else it reads from a callback
   (`projectRef`, `timeRef`, ...), closing the "closed over a stale `images` object" gap.
4. **`scratch()` (transitions/xform.ts)**: now always clears itself on return, not just on
   an actual resize — removes the "every caller must remember to clear" contract instead
   of auditing every call site across every transition engine for a miss.
5. **WebGL context-loss handling**: `gpuFx.ts`, `shinyClouds.ts`, `transitions/gl.ts` each
   now listen for `webglcontextlost` and invalidate their cached context/program, so a
   lost context (which makes every subsequent `gl.*` call a silent no-op per spec — the
   canvas just keeps showing its last successful frame) forces a rebuild on the next call
   instead of quietly drawing into a dead context forever.

**Result: no change.** Re-exported the known-bad v3 project three times — the original
export, one with just fix #1–3 (decode barrier), and one with all five — and checked the
two hand-verified bad frames (16.49s, 18.43s) directly by eye each time. All three exports
show **byte-for-byte the same wrong content at the same frames**: 16.49s always shows the
"After" layer's warm-room photo instead of `add1.png`; 18.43s always shows the carousel's
"Secret CCT" slide instead of the CTA card. `audit_export`'s suspect list was also
essentially unchanged (8 suspects, same carousel/crossfade-boundary noise each time, per
the calibration limitation above).

**This is itself the important finding, not a null result.** Every framing so far —
mine, the handoff, this roadmap — assumed the bug was a *race*: something intermittent,
timing-dependent, sensitive to decode latency or load. Reproducing the *exact same*
corrupted content at the *exact same* frames across three independent export runs, with
four different defensive changes in place, says otherwise: **given this project, the wrong
frame is produced deterministically, every time.** That rules out more than the four leads
individually — it rules out *timing* as the category of explanation. Whatever's wrong is a
function of the project's data/state, not of when things happen to finish. That's a much
more tractable thing to chase (reliable repro, no luck required — bisect the *project*, not
the clock) but it's a different investigation than the one this roadmap scoped.

## One more test, following directly from "it's deterministic": the content survives deleting its own source layer

If the wrong frame is a deterministic function of project state, the next question is
*which* state. Cheapest possible test: delete the layer whose content is leaking in, and
see if the leak goes with it.

At 16.49s, the wrong content is the "After" layer's own image (`1b45bae5...jpg` — the
before/after block's warm-room photo, layer id 7, active only `[0, 4200]`) appearing where
`add1.png` (layer id 2, active `[14200, 17600]`) should be. So: restored the v3 checkpoint
again, deleted layers 6/7/8 (Before, After, Divider — the entire before/after block, layer
7 included) via `delete_layer`, leaving everything else — including `add1.png` at the same
`[14200, 17600]` — untouched, and exported fresh.

**16.49s still shows the exact same warm-room photo.** The layer that owns that image no
longer exists anywhere in the project. There is no `Layer` left for the renderer to have
mis-evaluated, mis-tracked, or read a stale decode of — the source of truth for "this image
should be on screen" is gone, and the wrong image is on screen anyway.

That rules out a rendering-pipeline race as the mechanism *at all*, not just the four
leads' specific version of it — there's no live layer left to race. What's left standing:
some cache keyed on something that survives a layer's deletion and isn't tied to the
current project state — a decoded-image cache never evicting an old entry combined with a
lookup bug that reads the wrong key, or a cached/reused artifact in the export pipeline
itself (`onExport`'s WebM encode, or the ffmpeg mux/transcode step) that isn't being
invalidated between runs. Worth checking early: `export_video`'s Rust side writes its
intermediate WebM to `std::env::temp_dir().join(format!("simple_effects_export_{}.webm",
std::process::id()))` — a filename that's **identical across every export call within the
same running app process** (same PID). I ran many exports in this one session; I did not
verify whether that temp file, or anything else with a process-lifetime-fixed path/key, is
actually the channel. Flagging it as the most concrete unexplored lead rather than a
confirmed one.

## The fifth lead (PID-keyed temp WebM path): dead on inspection

The user asked me to check this one before handing back. `export_video`
(`src-tauri/src/lib.rs:5225-5226`) writes the recorded bytes with
`std::fs::write(&tmp, &bytes)` — which always creates-or-truncates and writes every byte
before returning — and that call completes, synchronously, on the same thread, before the
ffmpeg command that reads `&tmp` is even spawned (`lib.rs:5244-5275`). There's no code path
where ffmpeg could see leftover bytes from a previous export: the file is fully replaced
before it's read every time. The shared PID-based filename only matters for avoiding
collisions between separate running app instances, not for staleness within one. No live
re-export needed — this is provable from the source directly. Lead closed.

## v3.2 — the mentor's cross-check: it was never a renderer bug

The mentor re-checked the two "swap" frames against the actual source files by SSIM
(not remembered slide content) and found both are correct renders of a **duplicate image**:
`G:/CONTENT/CCT/images` holds every picture twice, a numbered PNG plus a UUID-named JPG
twin. Verified independently by eye (both pairs really are the same picture) and then by
running the folder's full 8-pair map through ffmpeg's `ssim` filter (letterboxed to a
common size): every numbered PNG has a UUID JPG twin at SSIM ≥ 0.84 (most ≥ 0.98) —
`1st`↔`8a4b77b3`, `2nd`↔`47acfd78`, `3rd`↔`84bfaeb5`, `4th`↔`ab32dce5`, `5th`↔`aec36e5c`,
`6th`↔`b1945cb1`, `add1`↔`1b45bae5`, `add2`↔`c4a69991`.

**Step 1 (re-check every historical "bad" export the same way).** Added an `#[ignore]`d
test, `analyze::tests::recheck_historical_exports` (`src-tauri/src/analyze/mod.rs`), that
loads a `.sefx` straight into `Project` (it's plain `serde_json`, no live app needed) and
runs the existing `audit_export` against the matching `.mp4`. Ran it against
`CCT Instagram Block.mp4`/`.sefx` (the un-versioned build — the one the handoff's "at
least one already-shipped export...has this defect" warning was almost certainly about)
and `CCT Instagram Block v2.mp4`/`.sefx`:

| Export | Suspects | Explanation |
|---|---|---|
| v1 (delivered) | t=0 (logo.png vs 1st.png), t=5.25s (add1 vs 1b45bae5), t=20s (add2 vs c4a69991) | all three below |
| v2 | t=0 (same), t=5.5s (add1 vs 1b45bae5), t=11.75s (c4a69991 vs 84bfaeb5/3rd), t=29s (add2 vs c4a69991), t=30.25s (4th vs c4a69991/47acfd78) | all five below |

Every one of the 8 suspects across both exports resolves to one of three explained
categories, checked by pulling the actual frame:
1. **Known duplicate pairs** (4 of 8): `add1`↔`1b45bae5`, `add2`↔`c4a69991` — exactly the
   twins above. Not a swap; both files are the same picture.
2. **Fade-in-from-black opening frame** (2 of 8, one per export, both at t=0): pulled the
   actual frame — pure black, `0-2KB` PNGs. Any photo scores "far" from black; the
   "best match" being `logo.png` rather than `1st.png` is noise between two equally-wrong
   comparisons, not a real preference. This is the same blind spot the original
   calibration already named ("a fade-in-from-black opening frame") in v4's 4 clean-export
   suspects.
3. **Mid-wipe-transition split frames** (2 of 8, both in v2): pulled t=11.75s and
   t=30.25s — both are genuinely two slides simultaneously visible side-by-side (a wipe
   caught mid-transition), not a single image. `audit_export` only fingerprints against
   single static sources, so a spatially-split frame can't score well against either half
   alone, and an unrelated third image can win "best match" by chance. New blind spot,
   same root cause as the already-known crossfade near-tie issue — just for wipes instead
   of dissolves.

**No genuine swap in either export.** Step 1 is done, and it came back clean, exactly as
the mentor predicted. The delivered CCT video is very likely fine; it just uses two
duplicate-source slots.

Updated `docs/MENTOR_HANDOFF.md` §11.1 (and its Desktop copy) to close the bug and explain
what it actually was, per the mentor's step 4 ("if step 1 finds no real swap: close §11.1,
correct the handoff"). Steps 2 (recalibrate `audit_export` by fault injection, make it
duplicate-aware) and 3 (commit the five defensive fixes as general hardening, not as "the
fix") are still open — flagging back to the user before starting those, since step 3 in
particular is a commit and the standing rule here is commit only on explicit request.

## Recommendation (superseded by v3.2 above — kept for the record)

Per the roadmap's own criterion: "Hand back if it still fails — all four hypotheses are
then falsified... the user brings the mentor in." That's where this is, now with a fifth
(the temp-file lead) also closed. I did not invent a sixth hypothesis to test — the roadmap
scoped four, specifically to avoid open-ended digging, and going beyond what's been checked
in on would be exactly the overrun §0.2 was written to prevent.

**For whoever picks this up next**: the known-bad checkpoint is still on disk
(`checkpoints/CCT_Instagram_Block_v3.sefx`, restorable via the `history` tool), it
reproduces on demand, and it's deterministic — not intermittent. Reproduction recipe: open
that checkpoint, `export_video`, then look at ~16.49s and ~18.43s. Given determinism, the
next move is probably bisecting the *project* (delete layers/effects one at a time, keep
the ones that must stay for the bug to persist) rather than more instrumentation on the
render loop's timing.
