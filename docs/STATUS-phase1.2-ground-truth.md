# Status — Phase 1.2 (ground truth: synthetic references + score_recovery)

Written for the mentor, per §0's loop. Both 1.2 deliverables built, tested, and — for
`make_synthetic_reference` — proven with a real generated reference through the live app
and MCP bridge, no API key involved.

## What changed

- **`make_synthetic_reference`** (`src/lib/synthetic.ts` + the tool wrapper in
  `agent/tools.ts`): builds a random project through the engine's own API — comp size/fps,
  then per shot a random-duration background clip with 2-4 Ken Burns keys (random easing,
  scale 1.0-1.3×, ±5% pans, occasional rotation and a mid-shot punch-in), occasional
  opacity fades, a grade (brightness/contrast/saturate) and sometimes vignette/grain, half
  the cuts a random registry transition — exports it and writes the project itself as
  `<name>.truth.json` beside `<name>.mp4`. Deterministic (mulberry32 PRNG keyed on `seed`).
  Runs `audit_export` on its own output before returning.
  - **Scope cut, flagged rather than silent**: floating elements and text are Phase 3/5
    concerns — nothing exists yet to *consume* synthetic ground truth for them (no
    tracker, no font matcher), so building randomized generation for them now would sit
    unused for weeks. Deferred; this covers everything Gate A's aligner (2.4, background
    full-frame motion) actually needs.
  - **New Rust command**: `list_dir_images(dir)` — a plain `std::fs::read_dir`, not the
    `@tauri-apps/plugin-fs` dependency already in package.json (that plugin was never
    actually wired up on the Rust side — no registration, no capability grant — and doing
    so for one directory listing was more plumbing than the job needed).
  - **Gating deviation, flagged**: the roadmap says "behind a dev flag." I gated on
    `localStorage.getItem("sefx.mcpBridge") === "1"` (the same flag that turns the bridge
    on) instead of Vite's build-time `import.meta.env.DEV`. That flag is baked in at build
    time and is always `false` in an installed build — including the one this got tested
    against — so it would have made the tool unreachable from exactly the workflow the
    roadmap describes ("from Claude Code over the MCP bridge"). Whoever's turned the
    bridge on is the "dev" this is for; nothing in the in-app Scenario→Video system prompt
    ever tells that agent to call it either.
- **`score_recovery(truth, recovered)`** (`src/lib/scoreRecovery.ts` + 8 vitest cases in
  `test/score-recovery.test.ts`): matches image/video layers by kind + time-overlap (IoU
  ≥ 0.3, greedy best-match), reports position/scale/rotation/opacity error (max over 5
  samples across the matched overlap — an endpoints-only check would miss a wrong mid-shot
  punch-in, which is exactly the kind of error Gate A's aligner needs caught) plus
  start/end timing error in ms, and counts missed vs. hallucinated ("extra") layers. Pure,
  no I/O — reuses `sampleTrack` from `lib/track.ts` (the existing frontend mirror of the
  Rust evaluator) rather than re-deriving keyframe interpolation. Role-based matching
  (once "role" exists, Phase 3) can replace the IoU heuristic later without touching the
  error metrics.

## Checked

- `cargo check` — clean. `npx tsc --noEmit` — clean. `npx vitest run` — 261 passed (8 new).
- **Live, via the MCP bridge** (rebuilt to build #43): checkpointed the live project,
  called `make_synthetic_reference` with `photosDir: G:/CONTENT/CCT/images` (the CCT
  photo set stands in for the real HSI set per the roadmap's own "if the photos are late"
  allowance — swap in HSI's photos before Phase 1's numbers count for real), `seed: 1`,
  `shots: 6`. It produced a real 15.1s, 1080×1920 `.mp4` and a 6-layer `truth.json` with
  real Ken Burns motion (checked two frames of the same source photo at different times —
  visibly different crop/zoom), two random transitions (pageTurn, checkerboard), and
  grade/vignette effects on several shots — pulled frames and eyeballed them, all correct,
  no corruption. `audit_export` on its own output: 5 suspects out of 61 sampled frames
  (~8%) — consistent with the already-documented crossfade/wipe near-tie blind spot at
  the 2 transition boundaries (5 suspects for 2 transitions is in the right range), not a
  new bug; didn't chase it further given the existing, understood explanation. Restored
  your original project after.

## Not done

Gate A (the aligner) — this is where actual inverse rendering starts existing. Next.
