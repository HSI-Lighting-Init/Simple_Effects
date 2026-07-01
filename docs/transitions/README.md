# Transition Effects Engine — Stage 1

A self-contained library for rendering A→B clip transitions. Source lives in
[`src/lib/transitions/`](../../src/lib/transitions). It is independent of the
app's per-layer timeline transitions — this is the richer engine the staged
system will build on.

## Concepts

- **Clip** — `{ source: CanvasImageSource | null, width, height }`. `source` may
  be an image, video, or canvas; `null` means an **empty / transparent input**.
- **Transition** — constructed with `(fromClip, toClip, params)`. Validates its
  parameters up front (throws `TransitionError` on bad input).
- **`render(target, progress)`** — paints the blended frame at `progress` (0..1,
  clamped) into `target` (an `HTMLCanvasElement`, auto-sized to the output).
  Easing is applied to `progress` before rendering.

```ts
import { createTransition } from "./lib/transitions";

const from = { source: imgA, width: imgA.width, height: imgA.height };
const to   = { source: imgB, width: imgB.width, height: imgB.height };

const tr = createTransition("fade", from, to, { easing: "easeInOut" });
tr.render(canvas, 0.5);            // midpoint frame
for (let p = 0; p <= 1; p += 1/30) tr.render(canvas, p); // 30-step preview
```

You can also construct classes directly: `new Fade(from, to, params)`,
`new Slide(from, to, { direction: "right" })`, etc.

## Architecture

| Piece | File | Role |
|---|---|---|
| `TransitionEffect` (base) | `base.ts` | Validation, clip **fitting**, edge cases, GPU/CPU dispatch, `render()`. Subclasses implement `composeCpu(ctx, a, b, p)` where `a`/`b` are the clips already fitted into full output-size frames. |
| Easing | `easing.ts` | `linear`, `easeIn`, `easeOut`, `easeInOut` + `clamp01`. |
| WebGL blend | `gl.ts` | Optional GPU path for crossfade/dissolve; **auto-falls back to CPU** on any failure. `isGpuSupported()`. |
| Category 1 | `blend.ts` | Opacity & blend transitions. |
| Category 2 | `motion.ts` | Slide / Push / Cover / Uncover. |
| Registry | `registry.ts` | `REGISTRY`, `createTransition(id, …)`, `getTransitionMeta(id)`, param schemas. |

### Common parameters (all transitions)

| Param | Values | Default | Description |
|---|---|---|---|
| `easing` | `linear` \| `easeIn` \| `easeOut` \| `easeInOut` \| `spring` \| `bounce`, **or** a `{type:"bezier",x1,y1,x2,y2}` / `{type:"spring",tension,friction,mass}` object | `linear` | Timing curve applied to progress. Spring/bounce can overshoot 1. |
| `fit` | `contain` \| `cover` \| `stretch` | `cover` | How each clip fits the output frame (contain letterboxes, cover fills + crops, stretch distorts). |
| `outWidth`, `outHeight` | px | from-clip size | Output frame size. |
| `durationMs` | ms ≥ 0 | — | Informational; rendering is driven by `progress`. |
| `preferGpu` | bool | `false` | Blend transitions only: try WebGL, fall back to CPU. |

### Edge cases handled

- **Empty input** (`source: null`) → treated as transparent (fade from/to nothing).
- **Different aspect ratios** → each clip is fitted independently via `fit`.
- **Transparent clips** → alpha is preserved through blends.
- **Out-of-range progress** → clamped to `[0, 1]`.
- **Invalid params** (unknown easing/fit/direction, bad colour) → `TransitionError`.

### GPU vs CPU

The CPU path (canvas 2D) is always correct and is the default. With
`preferGpu: true`, **Fade** and **Cross Dissolve** use a WebGL shader
(`gl.ts`) and silently fall back to CPU if WebGL is unavailable. Motion
transitions are pure `drawImage` compositing (already GPU-accelerated by the
browser), so they use the CPU path.

---

## Category 1 — Opacity & Blend

| Transition (`id`) | Description | Extra params |
|---|---|---|
| **Fade** (`fade`) | Straight opacity crossfade: A fades out as B fades in (both ~50% at mid). | — |
| **Cross Dissolve** (`crossDissolve`) | A stays fully opaque while B dissolves in on top; both visible through the middle. | — |
| **Dip to Black** (`dipToBlack`) | A fades to solid black over the first half, then black fades to B. | — |
| **Dip to White** (`dipToWhite`) | Same, dipping through white. | — |
| **Fade to Color** (`fadeToColor`) | Dip through any solid colour. | `color: {r,g,b,a?}` (default black) |
| **Flash to White** (`flashToWhite`) | A quick bright white flash peaks at the midpoint and masks the cut. | `intensity: 0..1` (default 1) |
| **Flash to Color** (`flashToColor`) | Flash through any colour with adjustable intensity. | `color`, `intensity` |

## Category 2 — Slide, Push & Cover

All take `direction: left | right | up | down` (default `left`).

| Transition (`id`) | Description | `direction` meaning |
|---|---|---|
| **Slide** (`slide`) | Incoming clip slides in over a stationary outgoing clip. | edge the incoming enters from |
| **Push** (`push`) | Incoming pushes the outgoing out of frame (both move together). | edge the incoming enters from |
| **Cover** (`cover`) | Incoming slides in over the stationary outgoing, with a soft leading-edge shadow. | edge the incoming enters from |
| **Uncover** (`uncover`) | Outgoing slides away on top to reveal the stationary incoming underneath. | direction the outgoing slides off |

---

# Stage 2 — Wipes, Zoom/Scale/Pan, Rotation/Flip

## Custom easing & spring physics

Beyond the named easings, `easing` accepts:
- **Cubic bezier** — `{ type: "bezier", x1, y1, x2, y2 }` (like CSS `cubic-bezier`).
- **Spring** — `{ type: "spring", tension?, friction?, mass? }`. Integrated from
  rest to 1 and time-normalised to settle at progress = 1; low `friction`
  overshoots and oscillates (bounce). Named presets `spring` and `bounce` are
  shorthands. Implemented in `spring.ts` (results cached per parameter set).

## Category 3 — Wipe, Reveal & Edge

All wipes take **`softness`** `0..1` (edge feather). Softness is applied as a blur
on the reveal mask, so any shape can be feathered.

| Transition (`id`) | Description | Extra params |
|---|---|---|
| **Horizontal Wipe** (`horizontalWipe`) | Vertical edge sweeps left/right. | `direction: left\|right` |
| **Vertical Wipe** (`verticalWipe`) | Horizontal edge sweeps up/down. | `direction: up\|down` |
| **Diagonal Wipe** (`diagonalWipe`) | Edge sweeps corner→opposite corner. | `corner: tl\|tr\|bl\|br` |
| **Iris Wipe** (`irisWipe`) | Circle expanding/contracting at centre. | `mode: expand\|contract` |
| **Diamond Wipe** (`diamondWipe`) | Diamond opening/closing. | `mode` |
| **Box Wipe** (`boxWipe`) | Rectangle expanding/contracting. | `mode` |
| **Clock Wipe** (`clockWipe`) | Radial clock-hand sweep from 12 o'clock. | `sweep: cw\|ccw` |
| **Radial Wipe** (`radialWipe`) | Radius wipe from a corner. | `corner` |
| **Gradient Wipe** (`gradientWipe`) | Soft wipe thresholding a luminance map. | `softness`, `gradientMap?` (CanvasImageSource, in code) |
| **Edge Feather Wipe** (`edgeFeatherWipe`) | Linear wipe, adjustable feather (default softness 0.2). | `direction`, `softness` |
| **Barn Doors** (`barnDoors`) | Two edges close/open. | `orientation: horizontal\|vertical`, `mode: close\|open` |
| **Soft Wipe** (`softWipe`) | Linear wipe with a large blur feather (default softness 0.6). | `direction`, `softness` |

## Category 4 — Zoom, Scale & Pan

Anchor for zoom/scale: **`anchorX`, `anchorY`** `0..1` (default centre).
**`zoom`** `0..3` extra scale. **`motionBlur`** `0..1` (streak strength).

| Transition (`id`) | Description | Extra params |
|---|---|---|
| **Zoom In** (`zoomIn`) | Push into A, then B settles from an over-zoom. | `zoom`, `anchorX/Y`, `motionBlur` |
| **Zoom Out** (`zoomOut`) | A shrinks to reveal B growing behind. | `zoom`, `anchorX/Y`, `motionBlur` |
| **Pan** (`pan`) | Camera pans A→B. | `direction: left\|right\|up\|down` |
| **Zoom & Pan** (`zoomAndPan`) | Directional pan + push-in zoom. | `direction`, `zoom`, `anchorX/Y` |
| **Zoom with Motion Blur** (`zoomMotionBlur`) | Fast zoom with directional streaks. | `zoom`, `motionBlur`, `anchorX/Y` |
| **Scale Up** (`scaleUp`) | B scales up from nothing over A. | `anchorX/Y` |
| **Scale Down** (`scaleDown`) | A scales to nothing revealing B. | `anchorX/Y` |
| **Scale Bounce** (`scaleBounce`) | B scales in with spring overshoot. | `tension` `20..400`, `friction` (bounce damping) `2..60`, `anchorX/Y` |

## Category 5 — Rotation & Flip

Flips take **`perspective`** `0..1` (3D foreshortening) and **`backface`** (bool:
show the next clip on the reverse, or a dimmed backface).

| Transition (`id`) | Description | Extra params |
|---|---|---|
| **Spin (2D)** (`spin2d`) | 2D rotation crossfade. | `spins` `0.25..4` |
| **Swivel** (`swivel`) | 3D flip around the vertical axis (card flip). | `perspective`, `backface` |
| **Flip Vertical** (`flipVertical`) | 3D flip around the horizontal axis. | `perspective`, `backface` |
| **Rotate & Scale** (`rotateAndScale`) | 2D rotation + scale-in of B. | `spins`, `anchorX/Y` |

> **3D note:** the flips are faked on 2D canvas (axis scaled by `cos(angle)` +
> a perspective squeeze), not a true 3D projection — good enough for card-flip
> looks without a WebGL pass.

## Performance (1080p real-time)

- Prepared/fitted frames are **cached per transition instance** (`base.ts`), so
  re-rendering at a new progress only recomposites.
- Wipes reuse a **pooled scratch canvas** (`xform.ts`) instead of allocating per
  frame; masks are composited with GPU-accelerated canvas ops + a single blur.
- The one heavy path is **Gradient Wipe** (per-pixel threshold) — fine at preview
  sizes; for 1080p export it costs a full-frame pass. A shader version is a
  Stage-3 candidate.

---

# Stage 3 — 3D, Fold/Curl & Patterns

## 3D rendering pipeline (`mesh3d.ts`)

A small software 3D pipeline on 2D canvas: transitions emit textured **quads**
(4 corners in a centred local 3D space); `renderQuads` projects them through a
**perspective camera** (`perspective` `0..1` controls strength), **depth-sorts**
back-to-front, **shades** each by its surface normal (Lambert lighting), draws
the texture with two affine-mapped triangles, and can add projected **drop
shadows**. This is the shared foundation for the 3D and fold categories.

## Category 5 (ext) — Advanced 3D Rotation

Common: `perspective` `0..1`, plus `direction` where noted.

| Transition (`id`) | Description | Extra params |
|---|---|---|
| **Cube Rotation** (`cube`) | A/B as adjacent cube faces turning 90°. | `direction` |
| **Card Flip (3D)** (`cardFlip3d`) | Back-to-back flip with thickness. | `direction`, `thickness` |
| **Tumble** (`tumble`) | A falls/spins/shrinks away (physics). | `spins` |
| **Doors (3D)** (`doors3d`) | A splits into panels that swing open. | `direction` (H: left/right, V: up/down) |
| **Curtains (3D)** (`curtains3d`) | A parts into folding strips. | `segments` |
| **Fly-Through Flip** (`flyThroughFlip`) | Camera pushes in as A flips to B. | `thickness` |

## Category 6 — Page, Fold & Curl

| Transition (`id`) | Description | Extra params |
|---|---|---|
| **Fold** (`fold`) | A folds along its centre line, revealing B. | `orientation` |
| **Accordion Fold** (`accordionFold`) | Alternating panels compress. | `segments` |
| **Unfold** (`unfold`) | B unfolds flat over A. | `orientation` |
| **Page Turn (3D)** (`pageTurn`) | A's page peels off a cylinder mesh. | `radius` |
| **Page Roll** (`pageRoll`) | Tight page turn (rolls like a scroll). | — |
| **Page Curl** (`pageCurl`) | Corner peels back with a gradient shadow. † | `corner` |
| **Peel Off** (`peelOff`) | Clip peels from a corner. † | `corner` |
| **Sticky Peel** (`stickyPeel`) | Peel with extra stretch on the shadow. † | `corner` |

> **† Approximation note:** Page Curl / Peel Off / Sticky Peel are a **stylised
> 2D** corner reveal (diagonal reveal + gradient curl shadow + fold highlight),
> not a full 3D curl mesh. Page Turn/Roll use a real cylinder mesh. A true
> curl-mesh (per-vertex cylinder warp with self-shadowing) is a future refinement.

## Category 7 — Shape, Pattern & Mosaic

Grid-based reveals: `grid` (tiles/axis), `spread` (per-tile stagger), plus
`count`/`orientation`/`seed` where relevant.

| Transition (`id`) | Description | Extra params |
|---|---|---|
| **Checkerboard** (`checkerboard`) | Tiles flip in a checker pattern. | `grid`, `spread` |
| **Blinds** (`blinds`) | Strips flip (venetian). | `orientation`, `count` |
| **Box / Expanding Squares** (`boxTiles`) | Tiles grow to reveal B. | `grid`, `spread` |
| **Diamond Pattern** (`diamondTiles`) | Diamond-ordered reveal from centre. | `grid`, `spread` |
| **Random Bars** (`randomBars`) | Bars slide in at random times. | `orientation`, `count`, `seed` |
| **Strips** (`strips`) | Parallel strips slide alternating. | `orientation`, `count` |
| **Block Dissolve** (`blockDissolve`) | Random blocks fade in. | `grid`, `spread`, `seed` |
| **Spiral Wipe** (`spiralWipe`) | Tiles reveal along an inward spiral. | `grid`, `spread` |
| **Wheel** (`wheel`) | Segments reveal around a wheel. | `grid`, `spread` |
| **Tile Flip** (`tileFlip`) | Tiles flip over like a tile wall. | `grid`, `spread`, `seed` |
| **Mosaic / Pixelate** (`mosaic`) | Both frames pixelate + crossfade. | `grid` |
| **Vortex / Swirl** (`vortex`) | Twist into a spiral + dissolve (stylised). | `twist` |

# Stage 4 — Glitch/Digital, Particles & Cinematic Camera

Stage 4 adds three new categories on top of two reusable frameworks and a
post-processing stack.

## New frameworks

- **Seeded RNG & noise** ([`rng.ts`](../../src/lib/transitions/rng.ts)):
  `mulberry32` PRNG, stable `hash2`, and smooth `valueNoise2D` — every glitch and
  particle effect is deterministic from its `seed`.
- **Particle system** ([`particles.ts`](../../src/lib/transitions/particles.ts)):
  a structure-of-arrays pool (`Float32Array`/`Uint8Array`) with a configurable
  force field — `gravity`, `wind`, `turbulence`, `drag` — integrated with
  semi-implicit Euler. `stepBody` is the shared single-body integrator.
- **Post-processing stack** ([`postfx.ts`](../../src/lib/transitions/postfx.ts)):
  `chromaticAberration` (RGB split), `glow`/bloom, `motionBlur`, `scanlines`,
  `noiseOverlay`, `vignette`, `lightLeak`.
- **Camera path** ([`camera.ts`](../../src/lib/transitions/camera.ts)):
  `CameraPath` interpolates position/rotation/fov keyframes; the 3D camera
  transitions place A/B as quads in the Stage-3 pipeline and drive this camera.

## Category 8 — Distortion, Glitch & Digital

Seeded, band-based warps (no per-pixel loops) plus the post-processing stack.

| Transition (`id`) | Description | Params |
|---|---|---|
| **Glitch** (`glitch`) | RGB split, block displacement, digital noise. | `seed`, `amount` |
| **Pixel Sorting** (`pixelSort`) | Bright bands stretch/smear (stylised). | `seed`, `amount` |
| **Bad TV** (`badTV`) | Rolling scanlines, noise, signal loss. | `seed`, `amount` |
| **Digital Block Wipe** (`digitalBlockWipe`) | Blocky compression-artifact reveal. | `seed`, `amount` |
| **Data Moshing** (`dataMosh`) | Motion-smeared block displacement (stylised). | `seed`, `amount` |
| **Wave Warp** (`waveWarp`) | Travelling sine distortion. | `amplitude`, `frequency` |
| **Ripple** (`ripple`) | Concentric water-droplet ripples. | `amplitude`, `frequency` |
| **Swirl / Twirl** (`swirl`) | Frame twists into a vortex. | `amplitude` |
| **Liquify** (`liquify`) | Fluid noise distortion that settles. | `amplitude`, `seed` |
| **Melt** (`melt`) | Columns drip downward to reveal B. | `seed` |
| **Stretch** (`stretch`) | Whip stretch along an axis. | `frequency` |
| **Motion Tile** (`motionTile`) | Clip repeats + slides as tiles. | `frequency` |
| **Retro VHS** (`retroVHS`) | Tracking lines, colour bleed, wobble. | `seed` |
| **Flicker** (`flicker`) | Rapid strobe between clips. | `seed`, `frequency` |
| **Light Leak** (`lightLeak`) | Organic warm light-leak overlay. | `hue` |
| **Prism / Chromatic** (`prism`) | Colour-fringing crossfade. | `amplitude` |

## Category 9 — Particles & Disintegration

`CellFly` divides A into a grid of textured cells and flies each on a closed-form
ballistic path (`pos = v·t + ½·a·t²`) — frame-independent and seed-deterministic.
Element looks (bubbles, dust, smoke, constellation) use the point particle system.

| Transition (`id`) | Description | Params |
|---|---|---|
| **Particle Dissolve** (`particleDissolve`) | Fine particles drift/blow away. | `density`, `seed` |
| **Shatter / Glass** (`shatter`) | Shards spin outward (stylised fracture). | `density`, `seed` |
| **Explosion** (`explosion`) | Blast outward from centre + flash. | `density`, `seed` |
| **Smoke / Fog Burst** (`smokeBurst`) | Rises + diffuses into a cloud. | `density`, `seed` |
| **Sandstorm** (`sandstorm`) | Directional wind-driven disintegration. | `direction`, `density`, `seed` |
| **Bubbles** (`bubbles`) | Rising translucent bubbles with highlights. | `density`, `seed` |
| **Leaves / Confetti** (`confetti`) | Tumbling coloured flakes under gravity. | `density`, `seed` |
| **Fire** (`fire`) | Rising flame edge burns A away. | `seed` |
| **Water / Wave Wash** (`waterWash`) | Wave sweeps with foam + refraction. | `seed` |
| **Magic Dust** (`magicDust`) | Gentle dissolve + sparkles. | `density`, `seed` |
| **Morphing Particles** (`morphingParticles`) | Scatter from A, converge into B. | `density`, `seed` |
| **Constellation** (`constellation`) | Dots connect + rearrange like stars. | `density`, `seed` |
| **Low Poly Explode** (`lowPolyExplode`) | Bursts into coarse angular shards. | `density`, `seed` |
| **Crumble** (`crumble`) | Cracks + falls from the top down. | `density`, `seed` |

## Category 10 — Camera Movement & Depth

Planar moves are 2D transforms + post-processing; the five 3D moves use the
Stage-3 pipeline and `CameraPath`.

| Transition (`id`) | Description | Params |
|---|---|---|
| **Whip Pan** (`whipPan`) | Fast horizontal pan, heavy motion blur. | `blur` |
| **Tilt Whip** (`tiltWhip`) | Fast vertical pan, heavy motion blur. | `blur` |
| **Dolly In** (`dollyIn`) | Truck forward into A onto B. | `depth`, `blur` |
| **Dolly Out** (`dollyOut`) | Pull back off A to reveal B. | `depth` |
| **Truck / Crab** (`truck`) | Lateral camera slide. | `blur` |
| **Zoom + Camera Shake** (`zoomShake`) | Rough zoom with handheld shake. | `amount`, `seed` |
| **Parallax Camera** (`parallaxCamera`) | Fg/bg move at different rates. | `depth` |
| **Ken Burns** (`kenBurns`) | Slow pan-and-zoom across stills. | — |
| **Dolly Zoom (Vertigo)** (`dollyZoom`) | Opposing zoom/dolly warp. | `depth` |
| **Rack Focus** (`rackFocus`) | Depth-of-field shift A→B. | `blur` |
| **Aerial Flyover** (`aerialFlyover`) | Drone-like diagonal sweep. | — |
| **Fly Through** (`flyThrough`) | Camera flies past A into B (3D). | — |
| **Orbital / Arc** (`orbital`) | Turntable arc between frames (3D). | — |
| **3D Room** (`room3d`) | A/B as walls; camera yaws (3D). | — |
| **360 Spin** (`spin360`) | Full turn swaps front/back (3D). | — |
| **Perspective Slide** (`perspectiveSlide`) | Tilted frames slide across (3D). | — |

## Thumbnails, benchmarks & tests

- **Thumbnails** ([`thumbnails.ts`](../../src/lib/transitions/thumbnails.ts)):
  `renderThumbnail(id, canvas)` draws a filmstrip; `thumbnailDataUrl(id)` returns
  a PNG data URL; `generateAllThumbnails()` bakes the whole gallery (synthesises
  placeholder clips when none are supplied).
- **Benchmarks** ([`bench.ts`](../../src/lib/transitions/bench.ts)):
  `benchmarkAll(RESOLUTIONS.fhd)` reports mean/p95 ms and estimated FPS per
  transition; `RESOLUTIONS` covers 720p, 1080p and 4K.
- **Tests** (`test/transitions.test.ts`, `npm test`): 230+ cases. The headline
  test constructs **and renders every registered transition** at seven progress
  points (and again with empty clips) through a headless canvas mock, plus direct
  tests of the RNG, particle physics, camera path and easing math.

## Stage-4 approximation notes

These are canvas-2D stylisations, not physically-accurate simulations:

- **Pixel sorting / data moshing** use band smears + block displacement (no true
  per-pixel sort or optical-flow).
- **Shatter** uses grid shards, not a Voronoi fracture; **fire/smoke** are
  gradient/particle stylisations; **low-poly** uses coarse rectangular shards.
- **10k+ GPU particles**: the pool is designed for the count, but canvas-2D fill
  is the ceiling at 1080p — a WebGL point-sprite renderer is the intended path for
  a true 10k/60fps budget.
- The 3D camera moves reuse the Stage-3 software rasteriser (affine triangles),
  so extreme fovs / among-plane occlusion are approximate.

## Performance (complex 3D)

- Quads are depth-sorted and drawn with clipped affine triangles — no per-pixel
  work except **Gradient Wipe** (Stage 2), **Mosaic** (block downscale), and
  **Vortex** (concentric ring redraws).
- Fitted A/B frames are cached per instance; wipe masks reuse a pooled scratch
  canvas. Page Turn uses ~34 column quads, Page Roll ~48 — the main 3D cost.
- Shadows are cheap projected silhouettes (not raytraced). For heavy 1080p
  exports, prefer fewer `segments`/`grid` and lower page-`columns`.

---

## Demo / preview

In the app: **Window → Transitions Demo…**. Pick a transition, adjust its
parameters, scrub or **Play** the progress, and watch it render between two
sample clips (16:9 and portrait, so the `fit` modes are visible). The demo is
driven entirely by `REGISTRY`, so every registered transition appears
automatically with controls generated from its param schema
([`src/components/TransitionsDemo.tsx`](../../src/components/TransitionsDemo.tsx)).

## Extending (later stages)

Add a transition by subclassing `TransitionEffect`, implementing
`composeCpu(ctx, a, b, p)` (and optionally setting `glMode`), then registering it
in `registry.ts` with a label, category, and param schema — the demo and these
docs pick it up from there.
