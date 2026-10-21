# Roadmap — inverse rendering + semantic template synthesis

**Goal.** Drop an existing video into the app — a footage-and-overlay reel or an Envato-style
motion-graphics opener — and recover the editable *design intent* behind it (layers, motion, timing, effects,
style and placeholders) in this engine's own parameters, so the same edit replays on a new set of media and
matches the original within a measured tolerance (§11). Element boundaries are the supervision signal: Claude
names what's on screen, SAM 3.1 finds and tracks every instance, and the user's own boundaries are optional
corrections. Deterministic code does the measuring; the AI/MCP layer turns measurements into a reusable
template.

Based on `docs/MENTOR_HANDOFF.md`, the earlier mentor's 12-sprint plan, the coding agent's review of v2,
and the code (2026-09-26, branch `feature/timeline-trim-comp-duration`). §12 maps the earlier plan's sprints
onto this one.

**v4 (2026-09-28) — Envato-style motion graphics, with no manual marking:**
- Primary targets are now footage-and-overlay reels (like the HSI WhatsApp reel) and Envato-style
  motion-graphics openers. Photo slideshows stay supported.
- **Automatic decomposition with SAM 3.1** (Phase 3, rewritten): Claude writes a concept list, SAM 3.1
  segments and tracks every instance on the GPU, the renderer checks the result, and the user only reviews
  flagged shots. **Gate S** tests SAM 3.1 before anything is built on it.
- **Phase E, engine vocabulary for motion graphics** (new): custom and overshoot easing, motion blur, layer
  mattes, shadows and borders, effects and blend modes on every layer, 3D tilt, kinetic type, camera moves —
  each shipped with its own estimator and synthetic ground truth. These leave Phase 8.
- Cut detection becomes adaptive (2.2), checked against PySceneDetect during development.
- "Identical" gets a measurable definition, and the schedule is about 3 months from here (§11).

**v4.1 (2026-09-28) — Gate S runs on SAM 2.1 first.** Meta's approval for the SAM 3.1 weights is slow and
uncertain (public reports range from weeks to months, some rejected). SAM 2.1 (Apache 2.0) needs no approval.
SAM 3.1 drops in behind the same tools if access is granted.

**v4.2 (2026-09-28) — access granted the same day.** Meta approved the "SAM3" gating group, so Gate S runs on
SAM 3.1 as v4 planned, ahead of the remaining fitter items. SAM 2.1 is back to being the fallback only.

**v4.3 (2026-09-28) — Gate S: SAM 3.1's video tracker is a no-go on this workstation.** It failed twice, the
second time with CPU offload and one session per shot. Peak memory was 21–28 GB on a 12 GB card, so it spilled
into system memory and took 20–30 minutes per concept per shot. "No available kernel" errors hit two
concepts, and no objects were detected on any completed run, so the pipeline never produced a usable result.
Per the user's standing rule, Phase 3 now tracks with **SAM 2.1**. Detection on key frames comes from SAM 3 in
single-image mode if a quick test shows it works on this GPU; otherwise from SAM 2.1's automatic masks plus the
`layout.rs` / `regions.rs` boxes, filtered by Claude. Every run starts with a single-frame smoke test.

**v4.4 (2026-09-28) — the hybrid is Phase 3's design.** Both halves are confirmed on the RTX 5070:
- **SAM 3 in single-image mode:** all concepts ran with no kernel errors, and it found real detections.
- **SAM 2.1 video tracking:** a 57-frame shot in 3.3 s at 0.9 GB peak, versus 20–30 min per concept for SAM 3.1's tracker on the same clip.

So detection runs on key frames with SAM 3 image mode, and tracking runs with SAM 2.1. Two findings shape the
build:
- **SAM 3 finds no text.** Text boxes come from Claude reading the key frame, cross-checked against
  `regions.rs`.
- **SAM 3 is sensitive to wording.** "photo card" found nothing where "photo" and "torn paper photo" did, so
  Claude writes 2–3 phrasings per element type from the actual frame, and the boxes are merged with IoU-based
  non-max suppression.

Key frames per shot are the start, middle and end plus change-energy peaks. Each track is seeded where its
element is most visible, propagated forwards and backwards, and deduplicated by mask IoU.

**Gate S result (2026-09-28): Go on the architecture.** A simplified run of the hybrid (frame-0 detection,
forward-only, greedy dedup) did the whole 28 s Envato reel in **133 s at 5.8 GB peak**. By eye, shot_05's stack
of torn cards segmented correctly. The ≥ 80 % quality bar isn't established yet: text isn't built, the busy
shot_11 over-segments (19 detections → 14 tracks, several duplicate slivers), and frame-0 detection misses
later entrances. **It becomes Phase 3's first milestone:** after the fuller design, across all 15 shots, at least
80 % of the visible cards and text lines are tracked and at most 10 % of tracks are duplicates, judged from
overlay sheets. Expect about 4–6 min per reel once the extra key frames and backward passes are in.

**v4.5 (2026-09-30) — the motion fitter is measured, and the aligner core is changing.**
- **Scoring against the 20 synthetic references exposed three problems:** a fitter normalisation bug, an
  absolute-vs-shot-relative time mix-up in the scoring harness, and an aligner that reported degenerate
  solves as "solved".
- **All three are fixed:** a single time convention (shot-relative, with a test), a plausibility gate on every
  solve, retry-then-carry-forward on rejection, and transition frames trimmed from each shot.
- **Results:** a new OpenCV core (SIFT + RANSAC → ECC, in the SAM Python environment) now meets the accuracy
  checkpoint — scale 1.78 %, rotation 0.055°, in-core position 4.0 px (0.37 %). The Rust LK is less accurate
  (scale 5.0 %) but solves more frames (44 % vs 26 %).
- **Next:** a per-frame hybrid race (OpenCV vs LK, keeping the plausible lower-residual result), with
  re-anchoring.
- **Solve rate can't be judged yet:** every synthetic reference was built from the CCT folder, about 8 flat
  illustrations (twins included), which is the worst case for alignment. The references are regenerated from
  30–50 distinct, textured HSI photos (`SE-test-assets\photos\`), and the generator now dedupes its inputs.
  Easing is parked until the solve rate is fixed.

**v4.6 (2026-10-01) — Phase 3 quality milestone met on the user's review.** On the Envato reel, the full core
tracks 46 card/logo elements and 45 text elements in about 12 min at 5.6 GB:
- multi-key-frame detection, with 2–3 Claude phrasings per type (never "card") and a zero-detection guard;
- bidirectional SAM 2.1 tracking and mask-IoU dedup;
- text read by Claude and grouped before tracking; logo wordmarks as boxes.

The user judged the gallery "tracked the shots well". The numeric bar (element count ≥ 95 %) moves to
automated scoring against synthetic truth once the references are rebuilt from real photos. **Next is app
integration, ending at Gate C:**
- the Claude steps through the runtime model, with cost logged;
- the SAM service started by the app, with its tools;
- per-element fitting;
- one layer per element in the rebuild;
- then a side-by-side video of the original and the rebuild.

**v3 — changes after the coding agent's review:**
- Handoff §11.1 gets a definition of "confirmed fixed", and its checker (`extract_frames`, `audit_export`) moves from
  Phase 1 into Phase 0.2, so it exists before the fix is attempted.
- **Gate A:** a ~3-day tracker spike right after the ground-truth generator decides between the Rust
  Lucas–Kanade tracker and the OpenCV fallback before Phase 2 is built on it.
- Sign-off is staged (§11): Phase 0 now, Phase 1 + Gate A next, go/no-go at **Gate B** after Phase 2.
- Per-run API cost is estimated (§10) and logged per run (Phase 0.3).
- The in-app agent only sees its current mode's tools (§5).

**v3.1** — answers to the coding agent's questions: a timebox and escalation ladder for 0.2, who does what,
and the test-asset list (§0).

**v3.2** — Phase 0.2 finding (2026-09-26): the two "content swap" frames in the v3 export are correct renders
of duplicate images; see the status block at the top of Phase 0.2. Phase 1 gains a duplicate guard.

v2 restored inverse rendering as the core after v1 had narrowed the goal to "extract the concept".

---

## 0. Roles and inputs

- **The coding agent implements everything**, Phase 0 onward, in the PR order of §11. One writer: `lib.rs`,
  `App.tsx` and `tools.ts` are touched by almost every phase, and two sessions editing them would collide.
- **The mentor is advisory:** owns this roadmap (keeps the repo and Desktop copies identical), answers
  questions, and reviews plans and diffs the user brings. It doesn't write feature code or commit.
- **The user** approves stages and gates (§11), supplies the test assets, and is the only one who says
  "commit".
- **The loop:** at each gate, or when blocked, the coding agent writes a short status note in `docs/` —
  what's done, the numbers, what's blocked. The user brings it to the mentor, and the roadmap is updated.
  Where the code contradicts this roadmap, the code wins; say so in the note.
- In this document **"Claude"** means the runtime model inside the app or an MCP client (proposing
  boundaries, reading text), not the coding agent.

**Test assets** — one folder outside the repo (size, licensing), e.g. `C:\Users\hsili\Desktop\SE-test-assets\`:

| Folder | Contents | Needed at |
|---|---|---|
| `photos\` | 30–50 distinct HSI photos — no duplicate copies (products, installations, interiors), JPEG, ≥ 1080 px on the short side, with visible detail (alignment needs texture), plus 2–3 transparent PNG logos | Phase 1.2 |
| `reels\` | 3 real reels, 10–30 s, vertical, downloaded as-is (platform compression is the point): (1) a photo slideshow with Ken Burns and captions; (2) a fast-cut promo with transitions and block captions; (3) an element moving over a background — a product cut-out, a logo or a picture-in-picture | Gate A |
| `brand\` | logo PNG, brand fonts (installed), colours | Phase 6 |
| `envato\` | 3–5 Envato-style motion-graphics previews (openers, promos), downloaded as-is | Gate S, Phase 3, Phase E |

If the photos are late, build the generator on any ~20 detailed photos and swap the HSI set in before
recording Phase 1's numbers. Gate A can't run without the real reels.

**Hardware:** SAM 3.1 extraction runs on the NVIDIA workstation (RTX 5070, 12 GB). Templates are portable,
so applying one works on any machine.

---

## 1. The loop

```
drop video.mp4
 1 ingest       Rust/ffmpeg  cuts · still vs footage · full-frame motion · fades · look · vignette · grain
 2 decompose    Claude names what's on screen ("photo card", "headline", "logo"…); SAM 3.1 segments and
                tracks every instance; roles assigned (keep_motion · replace_text · replace_logo ·
                keep_style · ignore); the user only reviews shots that step 6 flags
 3 track & fit  Rust         each element's mask track → transform per frame → keyframes + easing,
                             matte, shadow, blur; background re-fitted with elements masked out
 4 synthesize   TS           transitions, fonts, text animation: render candidates with the app's own engines
 5 build        Rust         rebuild_from_analysis → a Simple Effects project: one layer per element,
                             placeholders, keyframes, effects, transitions; roles → slots
 6 verify       TS           reconstruction_error: our render vs the reference, per frame and per element
                             → Claude fixes the worst (adds a missed boundary, re-fits, takes the runner-up)
 7 save         .sefx + manifest (slots, text roles, patterns, look targets, fidelity, gaps)
APPLY  open_template → fill slots with new media (cover) → match_look → rewrite text → export → audit
```

## 2. Why the template is a Simple Effects project

Inverse rendering needs a forward model: find parameters θ with render(θ) ≈ the video. The only renderer
whose output matters is the app's own — `evaluate()` in eval.rs, Preview.tsx, the transition engines, the
effect pipeline — so θ must be the app's own parameters: a `Project` (model.rs) with layers, spans, keyframe
tracks (`Keyframe { time_ms, value, easing }`), effects, transitions, text styles and `LetterAnimation`s.
That gives three things a separate schema can't:
- every recovered value is checked by re-rendering it, with a numeric error (the earlier plan's "render
  early, render often");
- the easing fitter uses the formulas the renderer evaluates (`ease()` in eval.rs: linear, u², 1−(1−u)²,
  smoothstep, hold), and the transition fitter renders through the same compositing path the app uses;
- the template opens on the timeline, so a human can correct it directly.

A parallel Python scene graph would need a second renderer and a translation step, and would drift.

## 3. Supervision: element boundaries

**v4:** boundaries now come automatically — Claude's concept list plus SAM 3.1's masks (Phase 3). A user's
boundary is an optional correction and works the same way.

An **annotation** marks one element on one frame:

```ts
interface Annotation {
  id: string;
  elementId: string;   // several boundaries on different frames = one element's key poses
  frameMs: number;
  shape: { kind: "box" | "polygon"; points: [number, number][] };   // reference-frame pixels
  role: "keep_motion" | "replace_text" | "replace_logo" | "keep_style" | "ignore";
  label?: string;      // "product photo", "headline", "brand bar"
  by: "user" | "ai" | "sam";   // automatic ones are accepted by fidelity (3.7); flagged ones show dashed
}
```

| Role (earlier plan's vocabulary) | Becomes in the template | Typical elements |
|---|---|---|
| `keep_motion` | media slot — recovered motion kept, content replaced | photos, video panes, product cut-outs |
| `replace_text` | text slot — style, position, animation kept; copy replaced | headlines, captions, prices, CTAs |
| `replace_logo` | logo slot, expects a transparent PNG | the brand kit fills it at apply |
| `keep_style` | graphic recreated with engine primitives (`Shape2D`, plates, overlays) | bars, blocks, frames; unrecreatable art → gap |
| `ignore` | masked out of fitting and error | watermarks, platform UI |
| (unmarked) | the shot's background — a media slot | fitted with every marked element masked out |

How the boundaries supervise:
- **Tracking anchors.** SAM 3.1 gives each element a mask on every frame, and the aligner solves the
  element's transform inside it. A boundary on a given frame (SAM's or the user's) pins the track there, which
  resets drift; where tracking confidence drops (heavy appearance change), the motion falls back to
  interpolating between known poses.
- **Key-time priors.** Frames the user chose to annotate are preferred keyframe times in the fit.
- **Layers.** Boundaries separate elements from the background and from each other, including where they
  overlap.
- **Placeholders.** An element's placeholder is the temporal median of its aligned region (drops grain and
  passing overlays); the background's is the median with elements inpainted.
- **Error masks.** `ignore` regions and not-yet-recreated elements are excluded from reconstruction error.

Claude writes the concept list, SAM 3.1 returns the instances, and Claude assigns roles and fixes misses with
`refine_element`. The annotation view is a review screen for flagged shots. Over MCP the user can still just
say "the centre photo is the product, keep the blue bar, ignore the watermark".

## 4. What gets recovered, and how

| Element | Recovered as | Method | Limit |
|---|---|---|---|
| Cuts, spans | layer spans | ffmpeg scene scores | ±1 frame |
| Still-shot / background motion | x, y, scale, rotation keys + easing | similarity alignment to the widest frame; piecewise fit with the engine's easings | custom curves and overshoot need E1 |
| Element motion (cards, panes, logos, text blocks) | same, per element layer | SAM 3.1 mask tracks + the aligner inside each mask | rigid and 3D-tilted (E6); non-rigid shapes get a matte per frame, motion approximated |
| Element visibility | span + opacity keys | region change energy + blend factor | — |
| Footage motion | punch-ins (single-frame scale steps) | alignment | smooth zoom/pan inside footage is ambiguous (camera vs digital) → flagged |
| Transitions | engine, direction, duration | synthesis over the registry through the app's compositing path | exact for references made here; nearest engine otherwise; seeded engines match timing, not pixels |
| Fades, dips | opacity keys | least-squares blend factor per frame | — |
| Grade | a target look per slot (Lab statistics), matched per new clip at apply | stats + synthesis through the engine's own filters | a grade can't be separated from the source's colours without the source; tints outside CSS filters → gap (no colour-matrix/LUT effect yet) |
| Vignette, grain | `vignette`, `filmgrain` params | radial profile; residual between aligned frames; calibrated on synthetic renders | — |
| Text | copy, role, font, size, colour, plate, position keys, letter preset + timing | Claude reads; measured; fonts by synthesis | font exact only if installed |
| Overlays (sparkle, flare, light wash) | GPU effects | Claude names them; opacity from residual | approximate |
| Card edges, shape reveals | layer mattes (E3) | the element's SAM mask, aligned to its track | — |
| Motion blur | shutter angle (E2) | streak length vs measured velocity | — |
| Shadows and borders | layer styles (E4) | darkening just outside the mask; the edge band | — |
| Kinetic type (glitch, outline, draw-on, per-letter motion) | E5, E7 | per-glyph tracking; Claude names effects | plugin-level text effects → nearest |
| Camera shake and push | `Group` transform (E8) | motion shared by every element | — |
| Particles, plugin effects (Trapcode, Saber-style) | — | — | nearest built-in effect + gap |
| Music | beat grid only | — | never reused |

## 5. MCP and where code runs

**One MCP server: the existing bridge.** All tools go into `TOOLS` in `src/agent/tools.ts`, so Claude
Desktop/Code and the in-app agent share them and the manifest can't drift. Measurement and tracking live in
Rust (`src-tauri/src/analyze/`): they ship in the installer and need no Python. Synthesis lives in the
WebView, the only renderer. The one Python component is the **SAM 3.1 service** (Phase 3): the app starts
it on demand on the GPU workstation and calls it over localhost, so both front doors reach it through the
app's own tools; it can also run as a FastMCP server for debugging from Claude Code. A Python/OpenCV tracker
stays a fallback only if the Rust aligner misses its targets.

Keep each tool call under ~60 s (MCP clients enforce their own timeouts): split work per shot, per element
and per boundary.

| Family | Tools | Runs in |
|---|---|---|
| Measure | `analyze_reference`, `get_analysis`, `video_frames` | Rust + ffmpeg |
| Decompose | `segment_concepts`, `refine_element` | Python (SAM 3.1), called by the app |
| Supervise | `annotate`, `list_annotations`, `delete_annotation` | TS (JSON beside the analysis) |
| Track & fit | `track_element`, `fit_background` | Rust |
| Synthesize | `fit_transition`, `fit_text`, `match_font`, `match_look` | TS |
| Build | `rebuild_from_analysis` | Rust (same pattern as the `create_*` template commands) |
| Verify | `reconstruction_error`, `compare_to_reference`, `audit_export` | TS + ffmpeg |
| Edit | the existing 25, plus `set_keyframe {easing}`, `add_effect`, `style_text`, `set_text`, `replace_media {fit}`, `rename_layer`, `list_fonts`, `media_sheet` | TS |
| Templates | `save_template`, `list_templates`, `open_template` | TS |
| Dev only | `make_synthetic_reference` (behind a dev flag) | TS |

**Tools per mode.** This plan adds about 26 tools (≈ 50 in total). Every definition is sent on every turn,
and tool choice gets less reliable as similar tools pile up, so the in-app agent gets only its mode's set:
`toolsFor("build" | "extract" | "apply")`, roughly 20–25 each, passed to `provider.chat` in
`orchestrator.ts` instead of `TOOLS`. External MCP clients still see the whole registry — one registry,
filtered views.

Analysis artifacts live in `appLocalDataDir/refs/<hash(path, size, mtime)>/`: `analysis.json`,
`annotations.json`, `masks/`, tracks, sprites and placeholders. Files, no database.

## 6. Ground truth: references whose answer is known

The app renders its own edits, so it can manufacture references with exact answers.
`make_synthetic_reference { photosDir, seed, shots, elements }` builds a random project through the engine
API — spans 0.6–4 s; 2–4 transform keys per shot with random easing, scale 1.0–1.3, pans ±5 %, occasional
rotation and punch-ins; 0–3 floating elements per shot (smaller photos/logos moving over the background);
half hard cuts, half random registry transitions; fades; a random grade; sometimes vignette/grain; 0–3 texts
with random installed fonts, presets and plates — exports it and writes `truth.json` (the project) beside the
MP4. It also writes **synthetic annotations** from the truth: element boxes at a few key times, jittered, some
deliberately missing — supervision the way a hurried user gives it. Use real photos (HSI's own); alignment
needs texture. **v4:** the generator also emits Phase E features with random parameters — overlapping cards
with stagger, mattes, motion blur, custom easing, shadows, 3D tilt — so every new estimator is scored against
exact truth.

`score_recovery(truth, recovered)` — a pure TS function under vitest — matches layers by role, time and
overlap and reports per-parameter errors. Every phase's "done when" is stated against it, and it lets the
coding agent iterate on its own: from Claude Code over the MCP bridge, generate → analyze → annotate → build
→ score.

---

## Phase 0 — Groundwork

**0.1 Commit first.** About 24 changed or untracked files (MCP bridge, style packs, shader fix) aren't
committed. The standing rule is to commit only when the human says so; ask for it before Phase 1 so each
phase lands as its own reviewable diff.

**0.2 Fix handoff §11.1 (content swap in exports) — gates every measured result.**

> **Status 2026-09-26 — almost certainly not a renderer bug.** The two hand-verified "bad" frames in
> `CCT Instagram Block v3.mp4` are correct renders of **duplicate images**. The CCT image folder
> (`G:/CONTENT/CCT/images`) holds every picture twice — a numbered PNG plus a UUID-named JPG twin, 8 pairs,
> SSIM 0.73–0.9995 — and the v3 project uses both twins of two pictures:
> - 16.49 s: layer `add1.png` is on screen, as the project specifies. It's the same living-room scene as the
>   before/after block's "After" image `1b45bae5….jpg` (SSIM 0.73), and the frame matches `add1.png` best.
> - 18.43 s: layer `47acfd78….jpg` is on screen, as specified. It's the same image as the carousel's
>   `2nd.png` (SSIM 0.9986).
>
> That accounts for everything in `docs/STATUS-phase0.2-checker.md`: deterministic, unchanged by all five
> fixes, survives deleting layers 6–8 (they were never the source), and the checker's near-ties (same
> picture). It likely explains the whole §11.1 history too: only the real CCT photos "trigger" it; solid-colour
> test slides never do.
>
> **Remaining 0.2 work** (replaces the ladder below):
> 1. Re-check every other historical "bad" timestamp (v1/v2 exports, the delivered one) the same way: find the
>    layer the project says is visible at that time, and compare the frame to *that layer's* source file and
>    its twins. Only a frame that matches neither is a real swap.
> 2. Recalibrate `audit_export` by **fault injection**: splice frames from elsewhere into a clean export at
>    known timestamps (ffmpeg) and require the audit to flag exactly those. Make it duplicate-aware too —
>    collapse near-identical sources into one identity before matching. v3 is not a known-bad export, so the
>    10.3 % vs 5.5 % calibration measured the carousel window and the twins, not corruption.
> 3. Commit the five defensive changes as hardening (each is correct on its own), not as "the §11.1 fix".
>    Criterion 4 below (a regression test pinning the cause) doesn't apply if there is no cause.
> 4. If step 1 finds no real swap: close §11.1, correct the handoff, and lift the gate on measured results.
>
> The original plan below is kept for the record.

A renderer that sometimes draws the wrong slide corrupts both the synthetic ground truth and the reconstruction objective, and remakes
are exactly its trigger (many large photos, many clips). Follow the handoff's instrumentation plan, and log
these **unconfirmed leads** at a known-bad timestamp:
- `scratch(name, w, h)` in `src/lib/transitions/xform.ts` is a module-global canvas pool keyed by **name
  only**; an engine that reads a scratch canvas it didn't fully repaint this frame shows whatever was last
  drawn under that name — an earlier slide. Audit callers for clear-before-draw.
- No decode barrier before capture: `renderFrames` (App.tsx ~1000) waits two rAFs; `useImage`
  (Preview.tsx:203) sets its image on `onload`, and multi-MB JPEGs may still be decoding. Try
  `await img.decode()` for every image visible at t before capturing.
- Stale context: the bridge keeps the ctx from its first `startMcpBridge` call (`listening` guard in
  bridge.ts) and the Scenario panel builds one per run; their `commit → resolveImages` closes over an old
  `images` map and re-reads every image on every commit, one at a time. Read `images` through a ref.
- WebGL context loss: `renderGpuFx` (gpuFx.ts) and `glBlend` (transitions/gl.ts) reuse module-global
  canvases/textures, export uploads full-resolution textures (`maxTex = Infinity`), and nothing in `src/`
  handles `webglcontextlost`. Log it during a failing export.

*Instrument first* — build the checker before attempting the fix (moved here from Phase 1):
- `extract_frames(path, timesMs, shortSide)` (Rust/ffmpeg, `-ss` before `-i`).
- `audit_export { path }`: a frame every 250 ms, a 16×16 dHash each, compared with every image layer's
  source; flag frames whose best match isn't a layer visible at that time; return timestamps + a sheet of
  suspects (`// ponytail: dHash oracle, calibrate the threshold on the known-bad export`). It must flag the
  known-bad checkpoint before it can be trusted to pass a fixed one.

*Confirmed fixed* means all four:
1. the known-bad checkpoint is kept as a reproducible failing case;
2. the root cause is shown by evidence — logged at the bad frame, or by bisection (step 3 below) — not
   inferred;
3. that export passes `audit_export` five runs in a row (the bug is intermittent — one clean run proves
   nothing), plus the handoff's full-duration visual check;
4. a regression test pins the cause (e.g. the scratch pool's clear-before-draw invariant, or the decode
   barrier).

*Timebox and escalation* — no open-ended digging:
1. **Checker (~1 day):** build `extract_frames` + `audit_export` and prove the audit flags the known-bad
   export. If it can't, fix the checker before anything else.
2. **Leads (≤ 2 days):** instrument the four leads. One is confirmed when its log shows the mechanism at a
   bad frame: a scratch canvas holding another layer's pixels, `img.complete === false`, a
   `webglcontextlost` event, or a stale `images` entry.
3. **Fix by construction (≤ 1 day)** if no lead is confirmed. Apply all four defensive changes together:
   `scratch()` clears the canvas itself and, during export, is keyed per layer (`${layerId}:${name}`); the
   decode barrier before every capture; `images` read through a ref; `webglcontextlost` handled (re-init and
   re-render the frame, or fail the export loudly — never emit stale pixels), with export textures capped at
   2× the comp's long side (full detail up to 2× zoom) instead of `maxTex = Infinity`. Each is a correctness
   improvement on its own, so all four stay. If the known-bad case then passes the audit 5×, **bisect**:
   revert one change at a time (one export + one audit each) until the bug returns. That names the cause and
   gives criterion 2 its evidence.
4. **Hand back** if it still fails — all four hypotheses are then falsified. Stop and write a status note in
   `docs/` with the audit output, the per-frame log of which image source each Konva node drew at the bad
   frames (the handoff's own instrumentation), and the shortest export window that still reproduces the bug;
   the user brings the mentor in. Ceiling: about 4 working days once the checker exists.

While 0.2 is open, 0.3 and Phase 1 code can proceed, but nothing is signed off on numbers until 0.2 is
confirmed fixed. 0.2 isn't in the schedule estimate. Do it regardless of this feature — the bug affects every
export the app makes, including videos already delivered.

**0.3 Agent plumbing for current models.**
- `providers.ts` `MODELS`: default `claude-opus-5`, plus `claude-sonnet-5` and `claude-haiku-4-5`
  (replacing `claude-opus-4-1` / `claude-sonnet-4-5`). Keep Opus as the default for extraction (vision plus
  long tool loops).
- Opus 5 and Sonnet 5 think by default, so replies carry `thinking` blocks. `AnthropicProvider` rebuilds
  assistant turns from text + tool_use only, and dropping thinking blocks risks ordering/signature 400s.
  Store the raw response `content` and send it back unchanged.
- `max_tokens` 4096 → 16000; top-level `cache_control: { type: "ephemeral" }` (every earlier image is resent
  each turn); retry 429/529 with backoff (or move to `@anthropic-ai/sdk` in browser mode, which retries).
- `ToolResult`: allow `text` and `image` together (`toMcp` in bridge.ts, the Anthropic `tool_result` content
  array, DeepSeek's text note).
- `orchestrator.ts`: every new read-only tool into `READONLY`; `maxCalls` per mode (extraction ~150).
- `mcp_bridge.rs`: raise `recv_timeout(120 s)` — a real `export_video` takes longer.
- Cost logging: add up each response's `usage` (input, cache write, cache read, output tokens) per run and
  show the tokens and an estimated dollar total in the Scenario panel's log. Decisions about cheaper models or
  lower effort come from these numbers, not from the estimates in §10.

*Done when:* an in-app run on `claude-opus-5` completes without 400s, with `cache_read_input_tokens > 0` from
turn 2 and its cost shown in the panel; `npm test` + `cargo test` green.

## Phase 1 — Engine prerequisites, ground truth, apply skeleton (~4–5 days)

**1.1 Engine changes.**
- Keyframe easing can't be chosen today: `edit_keyframes` → `upsert_key` (lib.rs ~930) always writes
  `EaseInOut`, and no API or UI changes it. Add an optional `easing`; expose it on `set_keyframe`; make
  eval.rs `ease()` `pub(crate)` for the fitter.
- `replace_layer_media`: add `fit` (cover = `max` instead of `min` in the rescale — today only image→image
  with an existing crop stays cover-filled, and video always letterboxes into a mismatched slot). After a
  replace, check every keyframe of the slot for revealed edges and scale up by the minimum that hides them.
- Generalize `apply_color` into `add_effect { layerId, kind, params }` over every `Effect::default_of` kind,
  validated — otherwise GPU effects are reachable only through a style pack.

**1.2** `make_synthetic_reference` + `score_recovery` (§6). Every generated reference is vetted with
`audit_export` (Phase 0.2) before it counts.

**1.3 Template = project.**
- Split `applyTextRecipe` / `fitText` out of `applyStylePack` (stylePacks.ts ~468–552); no behaviour change,
  `test/style-packs.test.ts` unchanged; plates named after their title (`Style · block · 12`) so they can be
  found again.
- `style_text` (TextRecipe + optional `animOut`, `x`/`y`), `set_text` (keeps style, re-fits its plates),
  `rename_layer`, `list_fonts { query? }`, `media_sheet` (shared `tileFrames` lifted from
  `renderContactSheet`, App.tsx ~1045).
- Duplicate guard: `import_media` and `media_sheet` flag near-duplicate images (reuse the audit's
  fingerprint), so neither an agent nor the synthetic generator picks two twins as "different" photos — the
  lesson of 0.2.
- `save_template` / `list_templates` / `open_template`: reuse the checkpoint path (`checkpointPath` /
  `saveCheckpoint` / `restoreProjectFrom`, App.tsx ~1077–1112) with a `templates/` folder; manifest (§9) via
  `saveTextFile`; listing via `@tauri-apps/plugin-fs` (already a dependency — check its scope).
  `restoreProjectFrom` doesn't bind the open document, so a later Save can't overwrite the template.
- Export guard: `export_video` refuses while a slot still shows its placeholder or any media lives under
  `refs/`; `validate_timeline` reports the same, plus texts still equal to the reference copy.
- Apply prompt, also served to external clients as an MCP prompt: add `prompts` to the manifest built in
  `mcpManifest.ts` and `ListPrompts` / `GetPrompt` handlers in `mcp/simple-effects-mcp.mjs` (no Rust change —
  the bridge serves whatever manifest string it's handed).

**Walking skeleton:** the first template is a synthetic reference's own truth project — no extraction needed.
Apply it to a different photo set.

*Done when:* 20 audit-clean synthetic references; a truth template applied to new photos keeps every key,
reveals no edges and passes `audit_export`; both suites green.

### Gate A — tracker spike (~3 days, right after 1.2; can overlap 1.3)

The biggest schedule risk is the hand-rolled tracker meeting real, re-encoded reels: compression, motion
blur, text covering the photos. Test it before anything is built on it. Implement only the 2.4 aligner (and
the 2.5 fitter if time allows) and run it on the 20 synthetic references plus the 3 real reels.
- **Go:** 2.4's synthetic targets are met, and on the real reels at least 90 % of still shots align without
  diverging (checked on side-by-side sheets of each frame vs the warped reference frame).
- **No-go:** switch now to the fallback, a Python/OpenCV (ECC) tracker behind the same tool interface,
  instead of discovering the problem in week 4.

## Phase 2 — Measurement core, Rust (~6–8 days)

`src-tauri/src/analyze/` (new module; `lib.rs` is already 5.8k lines). Reuse `find_ffmpeg` /
`quiet_command` as `pub(crate)` and the same "needs ffmpeg" error as MP4 export.

- **2.1 Decode.** ffmpeg `-f rawvideo` pipes, streamed — never the whole video in memory. 96 px gray for scene
  scores, 256 px for motion, 720 px only for placeholders. Refuse inputs over 180 s.
- **2.2 Shots.** `segment_cuts` (pure): hard cut = local max ≥ `HARD`; soft = ≥ 3 frames ≥ `SOFT` summing ≥
  `SOFT_SUM`, ≤ 1.5 s; cuts < 200 ms apart merge. Constants are calibration knobs tuned on ground truth.
  **v4:** replace the fixed `hard` threshold with adaptive detection — a frame's change measured against the
  rolling average of its neighbours (PySceneDetect's AdaptiveDetector idea) — plus a brightness-threshold pass
  for fades and dips to black, which catches the dark-to-black cut the fixed threshold missed. Check it against
  PySceneDetect's own output on the sample reels during development only; PySceneDetect isn't shipped.
- **2.3 Still vs footage.** Align consecutive frames with a similarity transform: low residual → a still under
  a keyframed transform; high → footage.
- **2.4 Full-frame motion.** Reference = the widest frame (smallest scale, so every other frame is a zoom-in).
  Per frame, a similarity transform from it by pyramidal inverse-compositional Lucas–Kanade on grayscale,
  initialized from the previous frame, Huber-weighted; skip transition windows. That transform *is* the
  layer's transform track, up to anchor/centre bookkeeping. This is Gate A's aligner, hardened.
  `// ponytail: hand-rolled LK (~250 lines); Python/OpenCV fallback if Gate A says no-go`.
  **v4.5:** the LK alone missed on reliability. The core becomes a per-frame hybrid: OpenCV (SIFT + RANSAC →
  ECC) raced against LK, both behind the plausibility gate, with frame-to-frame composition and re-anchoring
  once the scale ratio to the anchor passes about 10–15 %.
- **2.5 Keyframe fit** (shared by background and elements). Shared key times across channels (how editors
  key); DP over ≤ 4 segments from curvature-peak candidates plus annotated frames as preferred times; cost =
  SSE + λ·keys, λ tuned on ground truth. Per segment and channel, choose the easing from `ease()` by least
  squares (values are linear once easing and times are fixed). Single-frame scale steps → `Hold` keys
  (punch-ins). Extrapolate to the span edges.
- **2.6 Fades.** Per frame, least-squares blend of the aligned reference frame toward black/white → opacity
  curve → same fitter.
- **2.7 Look.** Per-shot Lab mean/std; vignette = radial luminance profile averaged over aligned still frames;
  grain = residual std between consecutive aligned frames above the codec floor; both mapped to engine
  params by calibration tables rendered synthetically.
- **2.8 Placeholders.** Still → temporal median of the aligned 720 px frames, vignette divided out. Footage →
  the reference's own segment re-encoded at 720 px, so reconstruction error stays meaningful.
- **2.9 Tools.** `analyze_reference { path }` → analysisId + summary + overview sheet (a tile per shot: kind,
  span, motion glyph); `get_analysis`; `video_frames`.
- **Tests.** cargo tests per estimator: known warp → recovered within tolerance; known easing → recovered;
  synthetic score arrays → cuts.

*Done when* (20 synthetic references, no annotations): cuts ±1 frame ≥ 98 %; still/footage ≥ 95 %;
background scale ≤ 1 %, position ≤ 2 px at 1080 p, rotation ≤ 0.3°, key times ±2 frames, easing correct
≥ 80 %; fades ±2 frames; a 30 s reel analyzed in < 30 s.

**v4.5 corrected targets.** The originals asked for more than the analysis can measure: one analysis pixel at
256 px is about 4 px at 1080p, and equivalent easings with different labels look identical.
- **Position:** ≤ 0.5 % of the comp's short side (about 5 px at 1080p), measured at keys inside each shot's
  clean core. Span-edge keys are extrapolations, reported separately.
- **Easing:** the fitted curve within 2 % of the channel's range of the truth curve over the segment, for
  ≥ 80 % of segments.
- **Solve rate:** reported by distance from the anchor.
- Scale, rotation and key-time targets are unchanged.
- Scored on references built from distinct, textured photos.

**Gate B:** go/no-go on Phases 3–7, decided on these numbers plus the 3 real reels (§11). **v4:** Gate B
still applies to photo slideshows; for the motion-graphics path, Gates S and C take its place.

## Phase 3 — Automatic decomposition with SAM 3.1 (~2–3 weeks)

No manual marking. (v4.4: detection runs with SAM 3 image mode on key frames, text boxes come from Claude +
`regions.rs`, and tracking runs with SAM 2.1; see the header's v4.4 note. Read "SAM 3.1" in this phase as "the
SAM service".) Claude names what's on screen, SAM 3.1 finds and tracks every
instance on the GPU, and
the renderer checks the result.

### Gate S — segmentation spike (~2–3 days, first)

**Outcome (v4.3):** SAM 3.1's video tracker failed Gate S twice on the RTX 5070 (memory, speed, kernel errors,
and zero detections). The gate reruns on **SAM 2.1** tracking, with the same criteria. Before any long run it
needs a single-frame smoke test (objects found, no kernel errors, overlay saved), then one short shot with
offload on, and only then all shots. Detection comes from SAM 3 single-image mode on key frames if a 10-minute
test works, else from SAM 2.1's automatic mask generator plus the `layout.rs` / `regions.rs` boxes, filtered by
Claude. If SAM 2.1 raises "No available kernel", allow torch's math and mem-efficient attention backends, or
run that module in bf16. The v4.2 plan below is kept for the record.

**v4.2:** runs on **SAM 3.1** (access granted on 2026-09-28). The environment already exists (`sam/`, with
PyTorch on CUDA 12.8 working on the RTX 5070). Run it on the Envato reel with a concept list ("photo card",
"headline text", "logo", "icon", "line", "shape"). If `facebook/sam3.1` still refuses the download, use
`facebook/sam3` from the same approved group.
- **Go:** at least 80 % of the cards and text lines are segmented with a stable ID through their visible
  span; a 30 s reel processes in about 2 minutes or less; it fits in the RTX 5070's 12 GB.
- **No-go:** **SAM 2.1** (Apache 2.0) behind the same tools. It takes no text prompts, so its automatic mask
  generator on key frames, plus boxes from `layout.rs` / `regions.rs` and Claude, feed the video predictor
  after Claude keeps and labels the real elements. If that also fails, re-plan with the user before Phase 3.

- **3.1 SAM service.** `sam/` (Python, `uv`), started on demand by the app — Rust spawns it and talks JSON
  over localhost, the same shape as the MCP bridge — so both front doors reach it through the app's own
  tools. Optionally also a FastMCP server for debugging from Claude Code. Mask tracks go under
  `refs/<hash>/masks/`.
- **3.2 Tools.** `segment_concepts { analysisId, shot?, concepts[] }` → instances (id, concept, score,
  per-frame box, mask-track path) plus an overlay sheet (masks coloured over frames) for Claude to review.
  `refine_element { analysisId, elementId, points | boxes | exemplar }` for corrections.
- **3.3 Concept list.** Claude looks at the overview sheet and writes the concepts per shot (cards, texts,
  logos, icons, lines, background). `regions.rs` / `layout.rs` candidates become exemplar prompts for anything
  the concept pass missed. Without an API key, a default list runs ("photo", "text", "logo", "shape").
- **3.4 Per-element fit.** For each mask track: the aligner (`align.rs`) solved inside the mask → a transform
  per frame (similarity; perspective once E6 exists) → the 2.5 fitter → keyframes with easing (E1).
  Visibility window and opacity from mask area and contrast. The background is re-fitted with every element
  and `ignore` region masked out.
- **3.5 Sprites and mattes.** Each element's appearance = the aligned temporal median inside its mask, saved
  as an RGBA sprite; its matte comes from the mask (E3). Footage inside a card stays a footage slot.
- **3.6 Residual loop.** `reconstruction_error` (4.4) also returns a residual map. Claude inspects the
  unexplained regions and adds concepts or exemplars; at most 3 rounds.
- **3.7 Auto-accept.** Shots whose per-element fidelity passes the threshold are accepted; the rest are listed
  as "needs a look".
- **3.8 Review channel.** The v3 annotation store, tools (`annotate`, `list_annotations`,
  `delete_annotation`) and view stay: SAM instances are written as annotations (`by: "sam"`), the view opens
  on flagged shots, and a user's box or polygon there becomes a `refine_element` prompt.

*Done when:* on synthetic motion-graphics references (overlapping, independently moving elements with Phase E
features), element count ≥ 95 %, per-element key times ±2 frames, and transforms within Phase 2's tolerances.
On the Envato set, per-element fidelity rises round over round, and what's left in the residual is limited to
effects the engine doesn't have yet.

**Gate C:** after Phase 3 and E1, measure the Envato set. If per-element fidelity isn't climbing, stop and
re-plan before E2–E8 (§11).

## Phase E — Engine vocabulary for motion graphics (~6–8 weeks, alongside Phase 3 from E1)

Without these, even perfect decomposition gives the right elements moving at the right times, drawn in a
style that doesn't look like the template. Every feature ships in three parts, or it isn't done:
1. **Render:** a model field with a serde default (old projects keep loading), eval.rs, Preview.tsx, export.
2. **Inverse:** an estimator in `analyze/` that recovers its parameters from video.
3. **Ground truth:** `make_synthetic_reference` emits it with random parameters, so the estimator is scored
   against exact truth.

Order is by visual impact on the Envato set; re-rank after each feature using reconstruction error.

| # | Feature | Render | Inverse | Size |
|---|---|---|---|---|
| E1 | Custom-curve and overshoot easing | `Easing::Bezier { x1, y1, x2, y2 }` (y may leave 0–1 for overshoot) in `ease()` and the `track.ts` mirror, reusing the transitions library's bezier math on the TS side; easing presets in the keyframe UI | the 2.5 fitter fits the four control values per segment | 3–4 days |
| E2 | Motion blur | export renders N sub-frames across a shutter angle (default 180°, 8 samples) and averages them — covers every layer with no per-effect work; the preview skips it | streak length vs measured velocity → shutter angle | 4–5 days |
| E3 | Layer mattes | a matte on any layer, in the layer's own coordinates so it moves with it: an alpha image or a vector path, with feather. Masked media slots fill new media under the matte | the element's SAM mask, aligned to its track, traced to a path when clean | ~1 week |
| E4 | Shadows and borders on every layer kind | drop shadow and stroke on image, video and shape layers, reusing text's `DropShadow` | darkening just outside the mask → offset, blur, opacity; the edge band → border | 3–4 days |
| E5 | Effects and blend modes on every layer kind | the effect stack on text and shape layers (image and video have it already), rendered offscreen first; a layer `blendMode` (screen, multiply, overlay…) | Claude names effects; blend mode chosen by fitting candidates against the residual | ~1 week |
| E6 | 3D tilt and perspective on flat layers | rotationX / rotationY / z plus a comp camera field of view, drawn as a perspective quad (reuse the decal triangle mapping) | homography from the element's mask corners → rotations and z per frame → keyframes | 1–1.5 weeks |
| E7 | Kinetic type | glitch text (a GPU effect, needs E5), stroke draw-on (trim path) for lines and outlines, outline-only text; per-letter motion fitted into the existing per-glyph keyframe tracks (`LetterOverride`) | per-glyph regions from the known text + font layout, tracked like elements | 1.5–2 weeks |
| E8 | Camera moves | reuse `Group`: all layers inside a group whose transform is keyframed (shake, push, whip) | motion shared by every element → the group's transform | 2–3 days |

*Done when* (per feature): its parameters are recovered within tolerance on synthetic references, and
reconstruction fidelity on the Envato set improves where the feature appears.

## Phase 4 — Synthesis, build, verify (~5–7 days)

- **4.1 Refactor.** Pull the pixel path of `drawTransitionFrame` (Preview.tsx ~332) into a pure
  `composeTransitionFrame(below, layer, factor, engine, direction, params, w, h)` used by the preview *and*
  the fitter. The app draws a layer transition as one real clip and one empty clip composited over whatever
  is below, with edge crossfades, driven by smoothstep-eased time (`resolve_transition_windows`, eval.rs).
  A fitter that called the engines directly as A→B would fit something the app never draws.
- **4.2 `fit_transition { analysisId, boundary }`.** Fix the window from the change-energy curve (±1 frame);
  search the registry's engines × directions at 128 px (A = last clean outgoing frame, B = first clean
  incoming); score = mean SSIM; return the top 3 with margins + a sheet (observed | best). ≤ 10 s per
  boundary; Claude's top-k families prune when available; hard cut and crossfade are always candidates.
- **4.3 `rebuild_from_analysis { analysisId, transitions }`** (Rust, one undo step, like the `create_*`
  commands): comp size/fps/duration; per shot the background slot and one layer per element, in z-order
  (Claude's call; default background < media < graphics < text); placeholders (stills cover-cropped so later
  replaces cover-fill); fitted keys with easing; opacity keys; vignette/grain; transitions from the fits
  (low-margin ones flagged in the layer name); `ignore` regions dropped; names `Slot 03 · <label>`.
  **v4:** also each element's matte (E3), shadow and border (E4), motion-blur setting (E2) and 3D rotation
  keys (E6).
- **4.4 `reconstruction_error { times? }`.** Render at 256 px (`renderFrames`) vs reference frames; SSIM per
  frame, per shot and per element region; masks `ignore` regions and not-yet-recreated elements; returns a
  table + a worst-moments sheet. `compare_to_reference` gives visual pairs.

*Done when* (synthetic): transition top-1 ≥ 80 %, top-3 ≥ 95 %, direction ≥ 95 %, duration ±2 frames;
rebuilt shots SSIM ≥ 0.90 at 256 px.

## Phase 5 — Text and graphics (~4–5 days)

For each `replace_text` element — Claude proposes and reads them from single frames (not tiles, so its pixel
coordinates map back 1:1; Opus 5 reads up to 2576 px):
- **`fit_text { analysisId, elementId }`:** entrance start and settle (region change energy), position/scale
  track (from 3.4), fill colour (dominant cluster), plate (uniform rectangle behind the text: colour, padding,
  radius), stroke/shadow hints.
- **Letter preset:** Claude classifies from a dense entrance sheet (5 presets); timing from `fit_text`
  (typewriter stagger = reveal time ÷ letters).
- **`match_font { analysisId, elementId, text }`:** render the copy in candidate installed fonts at the
  measured height, rank by binarized-mask IoU; Claude's style read (serif/sans/script/condensed, weight)
  prunes the list.
- **Assemble:** `add_text` → `style_text` (position, font, colours, plate, preset + timing) → `rename_layer`.

`keep_style` graphics: rectangles and bars → `Shape2D` driven by the element's track; anything else → gap.

*Done when* (synthetic): preset ≥ 80 %; start/settle ±2 frames; position ±1 % of frame; the true font in
the top 3 ≥ 80 %.

## Phase 6 — Semantic synthesis and apply (~3–4 days)

- **6.1 `TEMPLATE_EXTRACT_PROMPT`** (in-app, and MCP prompt `extract_template`): analyze → concept list →
  `segment_concepts` → assign roles → track/fit → `fit_transition` per soft boundary → rebuild →
  texts/graphics → `reconstruction_error` → fix the worst (add a concept or exemplar, re-fit, take the
  runner-up transition; ≤ 3 rounds) → flag shots still below threshold for review (don't wait) → write the
  design intent: slot content descriptions, text roles and constraints,
  **patterns** (repeated structure as rules: "each photo pushes in 1.0→1.12 easeOut", "captions enter 200 ms
  after their photo", "cuts every 500 ms"), gaps → `save_template`.
- **6.2 `match_look { layerId }`:** optimize brightness/contrast/saturate/hue on a 128 px copy of the new clip
  through the engine's own `buildFilter` until its Lab stats approach the slot's target (coordinate search,
  ~50 evaluations); write the effects. Runs for every filled slot.
- **6.3 Apply prompt:** `open_template` → `media_sheet` → assign media to slots → `replace_media` (cover) →
  `match_look` → `set_text` (copy from the brief, within each role's constraints) → brand kit into
  `replace_logo` slots → music → `validate_timeline` → `contact_sheet` → `export_video` → `audit_export`.
  Different media count → extend or shorten using `patterns`; never leave a placeholder.

*Done when:* 3 real references × HSI media — per-element fidelity reported, remakes audit-clean, applied
looks within ΔE ≤ 5 of target, human verdict "same edit, our content".

## Phase 7 — Drop-a-video UX (~2–3 days)

Drop a video on the app (or Templates → "Template from video…"): the automatic pass (Phase 2, SAM 3.1 with the
default concept list, transitions, rebuild) runs with no API key and opens a first template with per-shot
fidelity badges. "Finish with Claude" runs 6.1 (concept list, roles, text, fix rounds); "Review" opens the
annotation view on the shots it flagged. Dropping a folder of media onto an
open template runs apply. The Scenario panel gets the same two actions. The Claude passes need Anthropic
(DeepSeek can't see frames).

## Phase 8 — Only when measured

| Upgrade | Trigger |
|---|---|
| Colour-matrix / LUT effect | look match misses targets on tinted references |
| Time remapping and speed ramps on footage | gaps cite them |
| Particle systems, plugin-style effects (Trapcode, Saber) | a reference depends on them and the nearest built-in effect scores too low |
| Digital zoom/pan inside footage | gaps cite it |
| Beat sync, retime, aspect re-flow | users need different music, length or aspect |
| Python/OpenCV fallback tracker | the Rust aligner misses Phase 2–3 targets |
| App as MCP client | a needed analyzer exists only as an external MCP server |

v4 moved custom easing, perspective and mattes into Phase E, and segmentation into Phase 3. Layouts
(picture-in-picture, grids, split screens, blur-fill backgrounds) now come out of decomposition as separate
elements.

---

## 9. Manifest (v2)

```ts
interface TemplateManifest {
  version: 2;
  name: string;
  concept: string;           // one paragraph: the design intent in words
  analysisId: string;
  source: { file: string; durationMs: number; width: number; height: number; fps: number };
  slots: {
    layerId: number; elementId: string;
    role: "background" | "keep_motion" | "replace_logo";
    kind: "still" | "footage"; label: string; content: string; placeholder: string; matte?: string;
    lookTarget: { mean: [number, number, number]; std: [number, number, number] };   // Lab
    fidelity: number;         // reconstruction SSIM of this element
  }[];
  texts: { layerId: number; elementId: string; role: string; referenceCopy: string; maxWords: number; notes?: string }[];
  graphics: { layerId: number; elementId: string; label: string }[];
  patterns: string[];         // repeated structure as rules, used when the media count differs
  gaps: string[];
  createdAt: string;
}
```

Timing and keyframes live only in the `.sefx`.

## 10. Risks, cost and guardrails

- **Handoff §11.1** corrupts ground truth and the objective until confirmed fixed (0.2); audit every synthetic
  reference.
- **Downloaded reels are re-encoded** (often 720 p, heavy compression) → tolerances; analysis runs at 256 px.
- **Tracker robustness** → Gate A (stills) and Gate S (SAM 3.1 on motion graphics).
- **Engine vocabulary** (easing shapes, tints, layouts, kinetic type) → nearest fit + gap; `gaps` is the
  engine backlog.
- **Compute:** a 30 s reel → analysis < 30 s, ≤ 10 s per transition boundary, < 10 s per element track; every
  call < 60 s.
- **Tool count:** ≈ 50 tools → per-mode sets for the in-app agent (§5).
- **GPU and licence:** segmentation needs the NVIDIA workstation (RTX 5070, 12 GB), so extraction happens there;
  templates are portable and apply anywhere. SAM 3.1's weights are gated by Meta (access granted for this
  account on 2026-09-28) and come under Meta's own licence — read it before shipping beyond this workstation.
  Other machines would each need their own approval. SAM 2.1 (Apache 2.0) is the fallback.
- **"Identical" has limits:** plugin-level effects (particles, Trapcode/Saber-style) and fonts or textures you
  don't have → nearest match + gap.
- **Envato assets:** recreate motion, layout and timing; use your own fonts, textures and footage. The export
  guard already blocks reference pixels.
- **Privacy:** frames go to the model provider (BYO key); the bridge stays localhost-only.
- **Copying:** templates carry parameters, not assets. The export guard blocks reference pixels, reference
  audio is never imported, and copy is always rewritten.

**Cost per run.** Rough estimates on `claude-opus-5` ($5 / $25 per million input / output tokens; cache reads
≈ 0.1× and cache writes ≈ 1.25× the input price), to be replaced by Phase 0.3's logged numbers:

| Run | With prompt caching | Without |
|---|---|---|
| Template from a reference — once per reference (~80 turns, context growing to ~100k tokens) | ~$3–8 | ~5× more |
| Remake from a template (~30–40 turns) | ~$1–2 | ~5× more |
| Automatic pass (analysis, transitions, rebuild) and the synthetic dev loop through Phase 4 | $0 — no model calls | — |

SAM 3.1 runs locally, so it has no API cost. Claude's concept, role and fix rounds add roughly $1–3 per
template.

Levers, in order: prompt caching (0.3); per-mode tool sets (§5); fewer and smaller images (tiled sheets
everywhere except where Claude must return coordinates); lower effort on apply runs. Moving apply runs to
`claude-sonnet-5` ($2 / $10) is the user's call, made on the logged numbers.

## 11. Sign-off, PR sequence and schedule

Sign off in stages; each stage leaves something usable if the work stops there.

Status going into v4, from the notes in `docs/`: 0.2, 0.3, 1.1 and 1.2 are done (§11.1 closed in
`d9166a3`). 1.3 (templates and apply) isn't reported yet. Gate A still waits for a photo-slideshow reel.
Parts of Phases 2 and 4 were built ahead of the gates.

| Stage | Approve | What you have if you stop here |
|---|---|---|
| 2.2 adaptive cuts, Gate S, E1 + the 2.5 fitter | now | reliable cuts; a measured verdict on SAM 3.1 for motion graphics; custom and overshoot easing |
| Phase 3 → **Gate C** | after Gate S | Envato-style references decomposed automatically into tracked elements with fitted keys, plus per-element fidelity numbers |
| E2–E4 | after Gate C | motion blur, mattes, shadows and borders — the biggest visual gap for the genre |
| E5–E8, then Phases 4–7 | after E2–E4 are measured | effects and blend modes everywhere, 3D tilt, kinetic type, camera moves; text; apply; the drop-a-video UX |

**Target ("identical"):** on each Envato-style reference, rebuilt with its own element sprites as
placeholders — per-element SSIM ≥ 0.90 at 256 px, ≥ 0.85 averaged over the video, and in a side-by-side at
playback speed you can't reliably tell which is the original. With HSI media swapped in: same template, your
content. Plugin-level effects are the known exception (§10).

PRs: 1. commit the current work (the human's say-so) · 2. 2.2 adaptive cuts · 3. Gate S spike · 4. E1 + the
2.5 fitter · 5. Phase 3 · 6. Gate C report · 7. E2 · 8. E3 · 9. E4 · 10. rebuild/verify updates (Phase 4) ·
11. E5–E8 · 12. Phases 5–7. Each PR: `npm test` + `cargo test` green; commit only on the human's say-so.

**Schedule:** about **3 months of coding-agent time** from here to the target — an order of magnitude, not a
commitment. Gates S and C exist so an overrun shows up in days, not weeks.

## 12. The earlier 12-sprint plan, mapped

| Sprint | Here | Difference and why |
|---|---|---|
| 0 Schema + renderer | §2: the app's `Project` + renderer | the template must be the renderer's own parameters to be verifiable |
| 1 Ingest | Phase 2.1–2.2 | ffmpeg in Rust, streamed; adaptive detection checked against PySceneDetect during development |
| 2 Annotations | §3, Phase 3.8 | same roles; boundaries come from Claude + SAM 3.1 automatically and the user only reviews flagged shots; JSON instead of FastAPI/SQLite |
| 3 Decomposition | Phase 3 | SAM 3.1 concept segmentation + video tracking (the successor to the SAM 2 the earlier plan proposed); aligned-median sprites; PROVIDE/Omnimatte not needed |
| 4 Motion + easing fit | Phase 2.4–2.5, 3.4, E1 | Lucas–Kanade inside SAM masks instead of RAFT/CoTracker; easing fitted against the engine's own curves, including custom and overshoot (E1) |
| 5 Style | Phase 2.7, 6.2 | Lab look targets + vignette/grain; a LUT needs an engine effect (Phase 8) |
| 6 Scene graph + naming | Phases 5–6 | Claude reads frames directly; fonts by synthesis instead of a classifier |
| 7 Synthesizer | Phase 4.3 | `rebuild_from_analysis` in Rust, one undo step |
| 8 MCP server | §5 | the existing bridge; the one Python piece is the SAM 3.1 service (FastMCP for debugging) |
| 9 AI reasoning | Phase 6.1 | validated by re-rendering + reconstruction error (the earlier SSIM/LPIPS idea) |
| 10 Feedback | annotations + editing the template on the timeline | no corrections table |
| 11 Export (Lottie/AEP/SVG) | cut | the deliverable is the video; the template is a `.sefx` |
| 12 Eval + hardening | §6 | synthetic references with exact truth + 3 real reels; Celery/Redis/auth not needed on the desktop |
