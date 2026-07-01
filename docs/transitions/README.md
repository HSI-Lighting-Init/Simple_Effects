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
