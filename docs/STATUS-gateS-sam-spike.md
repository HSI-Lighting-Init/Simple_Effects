# Status — Gate S (SAM 3.1 spike)

Written for the mentor, per §0's loop. Blocked exactly where the user said to stop: the
checkpoint download needs their own Hugging Face access grant. Everything short of that is
done and verified on this machine.

## Confirmed: this IS the GPU workstation

`nvidia-smi` reports an NVIDIA GeForce RTX 5070, 12227 MiB — matches roadmap §0's hardware
line exactly. No ambiguity about which machine Gate S runs on.

## What's built

`sam/` (new, git-ignored — large binary venv, not committed):
- `sam/.venv`: a `uv`-managed Python 3.12.13 environment.
- PyTorch 2.10.0+cu128 + torchvision, from the `cu128` wheel index (CUDA 12.8, the build
  the SAM 3 repo's README names for RTX 50-series/Blackwell support). Confirmed live:
  `torch.cuda.is_available()` → `True`, `torch.cuda.get_device_name(0)` →
  `"NVIDIA GeForce RTX 5070"`.
- `sam/sam3/`: a clean clone of `facebookresearch/sam3` (the SAM 3.1 release lives in this
  same repo — `RELEASE_SAM3p1.md`, March 27 2026, Object Multiplex). Installed via
  `uv pip install -e .` — 22 packages, clean, no errors.

## Where it stops

Attempted the checkpoint download (`huggingface_hub.snapshot_download(repo_id="facebook/sam3.1")`)
to confirm exactly what blocks it, per the README's own warning ("request access to the
checkpoints... once accepted, authenticate via `hf auth login`"). Result: `GatedRepoError`,
401 — the repo is access-gated on Hugging Face; downloading needs a Hugging Face account
that's been granted access to `facebook/sam3.1`, then authenticated in this environment
(`hf auth login` after generating an access token, or an `HF_TOKEN` env var).

**Per the user's explicit instruction, stopping here rather than working around it.**

**Update:** received an HF token (relayed via another Claude Code session, `simple-effects-
b9`, at the user's request) and authenticated with it (`hf auth login` — succeeded, "Token
is valid"). Saved to the user's own global HF cache (`~/.cache/huggingface/token`), not
anywhere under `sam/` — no token material sits in the git-ignored folder or the repo.
Retried the download: still a `GatedRepoError`,
now 403 specifically "you are not in the authorized list" — a real, valid, logged-in HF
account, but one that Meta hasn't yet approved for `facebook/sam3.1` itself (a separate
approval step on the model's own page, not just having an account). Exactly the failure mode
the token's own relay instructions anticipated ("stop and tell the user; don't try to work
around it") — stopping here.

**What's needed**: whichever HF account that token belongs to needs to request and be
GRANTED access at https://huggingface.co/facebook/sam3.1 (Meta's own approval gate — not
configurable, not something a token alone bypasses). Once approved, the same token should
just work with no other change needed here.

Once that's done, the rest of Gate S is scripted and ready to run immediately: the concept
list ("photo card", "headline text", "logo", "icon", "line", "shape") against
`preview_540p_crf22_higher_quality.mp4` — confirmed to actually be a real Envato preview
("Dynamic Sport Opener") per STATUS-gateA-aligner.md's earlier finding, so this is the real
Gate S target, not a stand-in. The 3-5 extra `envato\` previews the roadmap's test-asset
table calls for are for Phase 3 / Gate C's broader measurement, not blocking Gate S itself.

## Unparked — Meta approved, download in progress

Access to `facebook/sam3.1` was approved (confirmed by the user's own Hugging Face "Gated
Repos Status" page, relayed via the mentor). The SAM 2.1-fallback detour that was briefly
confirmed with the user directly is cancelled — back to SAM 3.1 with concept prompts, per
roadmap v4. Retried `snapshot_download(repo_id="facebook/sam3.1")` with the stored token: no
longer a `GatedRepoError` — it's genuinely downloading (35GB+ in the HF cache and growing at
last check). Large enough that it's running as a background task rather than blocking on it.

## Environment fixes needed before the model would even load or run

None of these are in the repo (all local to `sam/`, git-ignored) — recorded here so the next
attempt doesn't rediscover them one crash at a time:
- `einops`, `psutil`, `opencv-python`, `matplotlib`, `scikit-learn`, `pycocotools` — all hard
  runtime imports the actual code path hits, despite not being in `pyproject.toml`'s declared
  dependencies or the README's core install steps (some are in its "optional" section, but
  aren't optional in practice for this code path).
- `triton` has no official Windows wheels at all for a modern Python (only manylinux); used
  the community `triton-windows` fork instead — works, but is an unofficial dependency this
  finding should flag if anyone official-izes a Windows build path later.
- `flash-attn-3` DOES have a real Windows wheel on PyTorch's own `cu128` index — installs
  clean, no issue there.
- Local patch to `sam3/model/sam3_base_predictor.py`'s `start_session` (not upstream, not
  committed to this repo): `Sam3MultiplexTrackingWithInteractivity.init_state()` doesn't
  accept `offload_state_to_cpu` (only `offload_video_to_cpu`) — the generic predictor base
  class passes it unconditionally regardless of which model class `self.model` actually is.
  Filtered `init_kwargs` down to what the model's own `init_state` signature accepts before
  calling it. A real upstream inconsistency, not something on this project's side.
- `bpe_path` autoresolution (`pkg_resources.resource_filename`) throws (`sam3.__file__` is
  `None` under this editable install on Windows) — passed the real path explicitly instead
  of relying on the default.

## Go/no-go: NO-GO, on this hardware, as released

**`use_fa3=False` was required** — FA3's kernel is Hopper-specific FP8 attention (confirmed
by reading `sam3/perflib/fa3.py`: casts to `float8_e4m3fn`, calls into
`flash_attn_interface`'s Hopper kernels); the RTX 5070 (Blackwell, sm_120) has no compiled
kernel for it at all (`CUDA error: no kernel image is available for execution on the
device`). `vitdet.py` already has a real, non-hacked fallback (`use_fa3=False` →
`F.scaled_dot_product_attention`), so the model DOES run — but:

- **All 6 concepts failed.** Not "some" — every one, including the first
  (`photo card`), which crashed with `CUDA out of memory` during
  `propagate_in_video`, same as the rest. One (`logo`) failed differently: `RuntimeError: No
  available kernel. Aborting execution.` — SDPA couldn't find ANY backend (not just the fast
  ones) for some tensor shape/dtype combination it hit, a harder failure than plain OOM.
- **Wildly over the ~2min/30s-reel budget** even where it got furthest before dying: the
  `icon`/`line`/`shape` attempts each ran 16-25 *minutes* before OOMing — the propagation
  progress bar's own per-iteration timing (`96s/it`, `77s/it`, after an even slower first
  iteration) makes clear this isn't close, not a matter of tuning a percent or two.
  `use_fa3=False`'s eager/math SDPA fallback is confirmed active via its own runtime warnings
  ("Memory efficient kernel not used... Flash attention kernel not used... Torch was not
  compiled with flash attention... cuDNN attention kernel not used") — i.e. the SLOWEST
  available attention path, not a reasonable second-best.
- **Memory does not recover between sessions.** Each session's own log shows
  `close_session`'s `empty_cache` genuinely freeing ~5GB, but `torch.cuda.max_memory_allocated()`'s
  watermark reached 27.64GB over the run's lifetime — clearly impossible as *live* usage on a
  12GB card, but real evidence of accumulation/fragmentation across sessions that
  `empty_cache` isn't fully reversing, on top of `nvidia-smi` showing 96% VRAM used and 100%
  GPU utilization even during what should have been the very first, lightest concept.

**Root cause, to the extent it's diagnosable without Meta's own hardware to compare against**:
this checkpoint and code path were built and tuned for Hopper-class datacenter GPUs (FA3,
H100 in its own benchmarks) with generous VRAM; the eager-attention fallback this hardware is
forced into isn't a slower-but-workable path, it's a fundamentally different, apparently
untested-at-this-scale one. Didn't chase further tuning (`PYTORCH_ALLOC_CONF=expandable_segments`,
smaller `max_num_objects`, fewer propagated frames) — the ~10-15x speed gap alone would still
fail the gate's timing criterion even if the memory side got patched up, so more tuning time
wouldn't change the verdict, only how far past hard-fail it gets.

**Per the roadmap's own decision rule** ("No-go: SAM 2 with box prompts from `layout.rs`/
`regions.rs` and Claude, behind the same tools") — this is exactly that case. Not switching
to it unilaterally given how recently "wait for Meta" and "go straight to SAM 2.1" both
flip-flopped once already; flagging the verdict and letting the user/mentor decide the next
move with this evidence in hand.

## Rerun (v2), per the user's explicit instructions after the v1 NO-GO

The user's own fixes, matching the mentor's independent read of the same code
(`sam3_base_predictor.py`'s `offload_video_to_cpu`/`offload_state_to_cpu`, real params that
existed all along but v1 never set): `offload_video_to_cpu=True`, `offload_state_to_cpu=True`,
one session per shot (15 shots, cut via `ffmpeg -c:v libx264` — a real re-encode, not
`-c copy`, so no keyframe-snap risk into the wrong shot) instead of one whole-reel session,
`PYTORCH_ALLOC_CONF`/`PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True`, relaxed target
~10min/30s reel, capped at half a day. Within each shot's session, all 6 concepts ran via
`add_prompt` + `reset_session` (the notebook's own documented pattern) rather than reloading
each shot's frames 6 times.

**Real finding, not cosmetic**: `expandable_segments` is not supported on this platform at
all — logged its own runtime warning the moment CUDA initialized. One of the two intended
memory fixes was a no-op here; only the CPU-offload flags were actually in effect.

**Result: ran for the full 4.5-hour budget, completed 6 of 15 shots, then stopped itself
cleanly (exit code 0, its own budget check — not a crash).** Final numbers:
- Peak VRAM watermark: 21.4GB (down from v1's 27.6GB — the offload flags helped some — but
  still far past the physical 12GB, meaning it's still spilling into slow system-memory
  paging for real work, not just briefly).
- Timing is wildly inconsistent and, overall, far past even the relaxed budget: shot 2 (17
  frames) took 82s for its first concept then ~1070s EACH for the next three; shot 5 (57
  frames, one of the larger clips) took 1200-2000 SECONDS *per concept* — over 2.6 hours for
  one shot's 6 concepts. 6 shots consumed the entire 4.5-hour cap; at this rate the full 15
  would need something like 10-12 hours, not the ~10min/reel target (even accounting for this
  being 15 SEPARATE sessions rather than the ~10 min/reel target's implied single pass).
- **"logo" and "line" failed 100% of the time — 12/12 attempts across all 6 shots**, always
  the identical `RuntimeError: No available kernel. Aborting execution.` A hard, deterministic
  break for 2 of the 6 concepts, unrelated to memory or speed tuning.
- **Zero objects detected for every concept that DID complete, in every one of the 6 shots**
  (covering 0-5033ms of the reel, over 5 seconds including one of the larger/likely
  content-bearing shots) — no positive detection anywhere to even evaluate the ≥80% quality
  criterion against.

## Verdict: NO-GO, confirmed — both memory and speed still fail under the user's own fixes

Per the user's explicit instruction going into this rerun ("If it still fails on memory or
speed, switch to SAM 2.1 without asking me again"): both did. This isn't a partial or
marginal miss — even the relaxed ~10min/30s-reel target is missed by roughly an order of
magnitude, and VRAM is still well past the card's physical 12GB. Proceeding to the SAM 2.1
fallback per that standing authorization, not re-asking.

## Update — the mentor's hybrid check changes the picture substantially

Before building the full SAM 2.1 automatic-mask-generator pipeline, tried the mentor's cheap
diagnostic first: is it really SAM 3 that's broken, or specifically its video tracker? Two
quick tests, ~15 minutes total:

**SAM 3 in single-image mode** (`build_sam3_image_model` + `Sam3Processor`, no video tracker
at all) on a real frame from the reference (a torn-paper stacked photo card, "DYNAMIC OPENER"
headline, green arrow/dot/line graphics — screenshotted in this note's history). All 6
concepts ran without a single kernel error — "logo" and "line", which failed 100% of the time
in video mode, worked fine here. Fast (0.04-0.06s/concept after the one-time model load) and
light (4.97GB peak VRAM). **So the video tracker (`Sam3MultiplexTrackingWithInteractivity`)
is what's broken on this hardware — not SAM 3's core grounding model.**

Real detections, not just "didn't crash": "line" found 6 boxes (the actual green
arrows/dots/underlines in frame) with 0.51-0.77 confidence. But the exact hardcoded phrase
**"photo card" found nothing**, despite an obvious one being dead-center in the frame —
"photo", "photograph", and "torn paper photo" all found it fine (4-7 boxes, 0.32-0.78
confidence). "headline text"/"text"/"title text" all found nothing even for phrasing
variants — text-as-a-concept looks like a genuine gap for this grounding model, not a
phrasing issue. **This directly validates the roadmap's own §3.3 design** (Claude reads the
frame and writes the concept list, not a fixed 6-word default) — the hardcoded Gate S list
was always a placeholder, and this is exactly the failure mode it predicted.

**SAM 2.1's video predictor** (`build_sam2_video_predictor`, ungated, `facebook/sam2.1-hiera-
base-plus`, no FA3/triton/pycocotools dependency at all) on `shot_05.mp4` — the same 57-frame
shot that took SAM 3.1's multiplex tracker 1200-2000 SECONDS *per concept*:
- Model load: 0.7s. `init_state` (loading the shot): 1.0s. Box prompt: 0.17s.
- **`propagate_in_video`: all 57 frames in 3.3 seconds.**
- **Peak VRAM: 0.9GB.**

That's roughly 400-600x faster and 20-30x lighter than the SAM 3.1 multiplex path on the
identical clip. Generated a mask overlay to sanity-check (not just trust the numbers) — the
mask tracked *something* real through the shot, though my hand-picked box coordinates were
imprecise (guessed by eye, not from a real detector), so this confirms the pipeline runs
end-to-end, not yet that tracking quality is good — that needs a real box from SAM 3's
detector, not a guess.

## Revised direction: the hybrid, not a from-scratch SAM 2.1 rebuild

Per the mentor's outline, now with real evidence behind it: **SAM 3 image-mode as the
concept detector on key frames (fast, reliable, real detections with good prompts) feeding
boxes into SAM 2.1's video predictor for propagation (fast, light, no crashes)** — not
SAM 2.1's own automatic mask generator, and not SAM 3's video tracker. Both halves are now
individually confirmed working on this hardware; wiring them together and re-running the
actual Gate S protocol (6 concepts × several shots, real boxes, overlay sheets, ≥80% stable
IDs) is next.

## The hybrid, wired up end to end and run for real: GO on speed/memory, promising-with-known-gaps on quality

`sam/gate_s_hybrid.py`: SAM 3 image-mode detects on each shot's frame 0 (9 concepts — the
original 6-word default plus the "photo"-family phrasings the smoke test found actually
work), boxes deduped by greedy IoU (>0.5 → keep the higher-scoring one), each surviving box
seeded into SAM 2.1's video predictor on frame 0 and propagated forward through the shot. A
bounded spike version of the mentor's fuller design (single key frame per shot, forward-only
propagation, simple dedup instead of NMS across multiple key frames) — enough to answer
Gate S's question; the fuller multi-key-frame/bidirectional/NMS design is Phase 3's build,
not this spike's.

**All 15 shots, real content, one run:**

| Metric | Result | vs. Gate S target |
|---|---|---|
| Total time (detect + track, whole 28s reel) | **133s** | well under even the *original* ~2min/30s-reel target, no need for the relaxed 10min one |
| Detection time (SAM 3, all 15 shots × 9 concepts) | 8.7s | — |
| Tracking time (SAM 2.1, all 15 shots) | 122.0s | — |
| Peak VRAM | **5.78GB** | comfortably under 12GB, ~6GB of headroom |

**Speed: PASS. Memory: PASS.** Decisively — not a marginal or relaxed-target pass.

**Quality: real and correct on the core content, with identified rough edges — not a clean
unconditional pass.** Checked via overlay sheets (3 sample frames per shot: start/middle/end,
all masks drawn), not just the stability numbers:
- **`shot_05` (the stacked torn-photo-card reveal) segmented correctly**: 5 individually
  colored masks each correctly outline one card layer at frame 0 (including each card's own
  jagged torn edge), and by the shot's last frame — where the animation has consolidated the
  stack into one hero photo — only the mask that should still be visible still is,
  everything else correctly shows nothing. This is exactly the structure the whole roadmap
  has been trying to recover, segmented right.
- **Raw "stability" (% of frames an object's mask is non-empty) is a misleading metric on
  its own** — many low scores turned out to be objects *correctly* disappearing mid-shot as
  the card-stack animation consolidates (verified in the overlay, not just inferred), not
  tracking failures. A real ≥80% check needs the visual review this note did for a sample,
  not a mechanical threshold on the stability numbers — flagging so nobody downstream
  mistakes the raw numbers for the verdict.
- **Real over-detection in busier, multi-layer shots**: `shot_11` (multiple overlapping card
  edges + mirrored background text) produced 14 deduped "objects" from 19 raw detections —
  visually, several are near-duplicate slivers of the same card edge that the simple >0.5 IoU
  dedup didn't merge. The mentor's proper design (multiple key frames, NMS across them) is
  the real fix, not attempted in this bounded spike.
- **3 of 15 shots (`shot_00`, `03`, `13` — 20%) found zero objects** — consistent with
  title/text-only or transition content this concept list isn't aimed at (no card/photo
  content to find), not an error.
- **Text stays a confirmed gap**: no concept phrasing found "headline text"-style content
  anywhere in this run either. Per the mentor's design, text boxes should come from Claude
  reading the frame directly (it already has to read the copy for the roadmap's own text
  step) cross-checked against `regions.rs`'s existing heuristic — not from SAM's grounding.
  Out of scope for what this spike was testing (the card/graphic-element path), not a defect
  in it.

## Verdict: GO, with scoped follow-up work — not a from-scratch SAM 2.1 rebuild

Reverses the SAM 3.1-only NO-GO from earlier in this note. The hybrid (SAM 3 image-mode
detection + SAM 2.1 video propagation) clears speed and memory decisively and produces
real, correct segmentation on the reel's actual content, verified by eye on real frames —
with concrete, scoped gaps (dedup needs the mentor's fuller multi-key-frame/NMS design; text
needs Claude+regions.rs, not SAM; concept phrasing needs to come from Claude reading each
frame, not a fixed list) that are Phase 3 build-out items, not open questions about whether
the approach works at all.

## Not done

- The mentor's fuller production design: multiple key frames per shot (start/middle/end +
  change-energy peaks), bidirectional propagation, proper NMS-based dedup across key frames
  instead of this spike's single-frame/forward-only/greedy-IoU version.
- Claude-driven concept-list generation (reading each shot's actual frame and writing 2-3
  phrasings per element, per the mentor's design) — this run used a fixed 9-concept list for
  a controlled, comparable test across all 15 shots.
- Text-region integration with `regions.rs` and Claude's own frame-reading — confirmed as a
  gap, not yet built.
- `segment_concepts`/`refine_element` as actual tools wired into the app (§5's tool table) —
  this is still a standalone spike script in `sam/`, not integrated.
