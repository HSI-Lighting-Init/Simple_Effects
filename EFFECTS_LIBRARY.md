# Effects Library

A reference for every effect and transition available in Simple Effects, with a
summary of the **mathematics** behind each and the **variables** (parameters)
that control it.

Two systems are documented here:

1. **Layer effects** — per-clip image filters (colour/blur/wipe), keyframeable.
2. **Transition engine** — ~107 A→B transitions (the "Transitions Demo" library)
   that can be applied to a clip as an **in / out** transition. Applied to a
   clip, `A` = the layers beneath (rendered as empty so they show through) and
   `B` = the clip, evaluated at a progress `p ∈ [0,1]` (0 = fully transitioned
   out, 1 = fully present).

Notation: `p` = eased progress 0..1; `w,h` = frame size; `bump(p) = 1 − |2p − 1|`
(a 0→1→0 triangle peaking at the midpoint); `clamp01(x)` clips to `[0,1]`.

---

## Part 1 — Math frameworks

These primitives power the transitions below.

### Easing (`easing.ts`, `spring.ts`)

| Curve | Function |
|---|---|
| `linear` | `f(t) = t` |
| `easeIn` | `f(t) = t²` |
| `easeOut` | `f(t) = 1 − (1 − t)²` |
| `easeInOut` | smoothstep: `t<0.5 ? 2t² : 1 − ½(−2t+2)²` |
| `spring` / `bounce` | numerical **damped harmonic oscillator** |
| cubic-bezier | `cubicBezier(x1,y1,x2,y2)`, solved for `x(t)` by Newton–Raphson |

**Spring** integrates `x'' = −(k/m)·(x−1) − (c/m)·x'` (stiffness `k` = tension,
damping `c` = friction, mass `m`) with a fixed small timestep, normalised so
`f(0)=0, f(1)=` settle. Overshoot > 1 produces the bounce.

### Seeded RNG & noise (`rng.ts`)

- `mulberry32(seed)` — integer-hash PRNG → uniform `[0,1)`.
- `hash2(i,j,seed)` — stable 2D integer hash → `[0,1)`.
- `valueNoise2D(x,y,seed)` — bilinear interpolation of `hash2` at lattice corners
  with smoothstep weights `u = xf²(3 − 2xf)`; smooth, in `[0,1]`.

### Particle system (`particles.ts`)

Semi-implicit (symplectic) Euler per step `dt`:

```
v ← v + a·dt      x ← x + v·dt
a = gravity + wind + turbulence + drag
turbulence:  θ = valueNoise2D(x·s, y·s, seed)·4π ;  a_turb = amplitude·(cosθ, sinθ)
drag:        v ← v·(1 − drag·dt)
```

Forces exposed: `gravity`, `wind`, `turbulence` (+ spatial scale), `drag`.

### Post-processing (`postfx.ts`)

- **Chromatic aberration / RGB split**: recombine the R, G, B channels drawn at
  offsets `(+d,0), (0,0), (−d,0)` with additive (`lighter`) blending.
- **Glow / bloom**: image + a Gaussian-blurred, brightened copy screened over it.
- **Motion blur**: accumulate `N` copies along a vector, each at alpha `1/N`.
- **Gaussian blur**: canvas `filter: blur(r)`.
- **Scanlines / noise / vignette / light-leak**: procedural overlays.

### Software 3D (`mesh3d.ts`)

- **Perspective projection**: for a point at depth `z`, `f = dist / (dist − z)`,
  screen `= center + (x,y)·f`. `dist` sets perspective strength.
- **Rotation**: sequential axis rotations `R = Rz·Ry·Rx`.
- **Lambert shading**: `shade = ambient + (1 − ambient)·max(0, |n·l|)`.
- **Texturing**: each quad split into two triangles, affine-mapped (source→dest).
- Depth-sorted back-to-front (painter's algorithm).

### Camera path (`camera.ts`)

- Keyframes of `(position, rotation, fov)`; piecewise-**linear interpolation**.
- `fov → dist`: `dist = (h/2) / tan(fov/2)`.
- **View transform**: inverse camera — translate by `−pos`, then apply `Rz(−rz)
  Ry(−ry) Rx(−rx)`.

---

## Part 2 — Layer effects (image filters)

Applied per clip (stack, top-to-bottom), each parameter keyframeable.

| Effect | id | Math | Variables |
|---|---|---|---|
| Black & White | `grayscale` | CSS `grayscale(amount)` | `amount` 0..1 |
| Brightness | `brightness` | `brightness(amount)` multiply | `amount` |
| Contrast | `contrast` | `contrast(amount)` | `amount` |
| Saturation | `saturate` | `saturate(amount)` | `amount` |
| Blur | `blur` | Gaussian `blur(radius px)` | `radius` |
| Hue Shift | `hue` | `hue-rotate(degrees)` | `degrees` |
| Invert | `invert` | `invert(amount)` | `amount` 0..1 |
| Wipe / Fade | `wipe` | directional alpha ramp: mask α from a gradient at angle `θ`, edge at `position`, width `softness` | `angle`, `position`, `softness`, `invert` |

---

## Part 3 — Transition engine

Each transition exposes **variables** (its "math knobs"). Every entry also
accepts `easing` and `fit`. Variables map 1:1 to the parameters below and are
editable per clip in the Inspector's **Transitions** section.

### Category 1 — Opacity & Blend

Base: alpha compositing of A and B.

| Effect | id | Math | Variables |
|---|---|---|---|
| Fade | `fade` | `outα = A·(1−p) + B·p` | — |
| Cross Dissolve | `crossDissolve` | A opaque, `Bα = p` | — |
| Dip to Black | `dipToBlack` | half 1: A→black `α=2p`; half 2: black→B | — |
| Dip to White | `dipToWhite` | as above through white | — |
| Fade to Color | `fadeToColor` | dip through a chosen colour | `color` |
| Flash to White | `flashToWhite` | flash `α = intensity·bump(p)` peak at mid | `intensity` |
| Flash to Color | `flashToColor` | as above, any colour | `color`, `intensity` |

### Category 2 — Slide, Push & Cover

Base: translation offset `d = (1 − p)` along the chosen edge.

| Effect | id | Math | Variables |
|---|---|---|---|
| Slide | `slide` | B enters at offset `±(1−p)·w/h` | `direction` |
| Push | `push` | A and B translate together by `(1−p)` | `direction` |
| Cover | `cover` | B slides over stationary A + edge shadow | `direction` |
| Uncover | `uncover` | A slides off to reveal stationary B | `direction` |

### Category 3 — Wipe, Reveal & Edge

Base: `maskedCompose` — reveal B where a mask is white; `softness` feathers the
edge (Gaussian blur of the mask).

| Effect | id | Math | Variables |
|---|---|---|---|
| Horizontal Wipe | `horizontalWipe` | edge x `= p·w` | `direction`, `softness` |
| Vertical Wipe | `verticalWipe` | edge y `= p·h` | `direction`, `softness` |
| Diagonal Wipe | `diagonalWipe` | edge along a corner diagonal `= p` | `corner`, `softness` |
| Iris Wipe | `irisWipe` | circle radius `= p·R` | `mode`, `softness` |
| Diamond Wipe | `diamondWipe` | L¹ (diamond) radius `= p·R` | `mode`, `softness` |
| Box Wipe | `boxWipe` | rectangle half-size `= p·(w,h)/2` | `mode`, `softness` |
| Clock Wipe | `clockWipe` | swept angle `= p·2π` | `sweep`, `softness` |
| Radial Wipe | `radialWipe` | radius from a corner `= p·R` | `corner`, `softness` |
| Gradient Wipe | `gradientWipe` | reveal where luminance(map) ≤ `p` | `softness` |
| Edge Feather / Soft | `edgeFeatherWipe`, `softWipe` | linear wipe, large feather | `direction`, `softness` |
| Barn Doors | `barnDoors` | two edges at `±p·½` | `orientation`, `mode`, `softness` |

### Category 4 — Zoom, Scale & Pan

Base: affine scale about an anchor `+` optional directional motion blur.

| Effect | id | Math | Variables |
|---|---|---|---|
| Zoom In | `zoomIn` | `scale = 1 + zoom·p` into A, B settles | `zoom`, `anchorX/Y`, `motionBlur` |
| Zoom Out | `zoomOut` | A `scale = 1 − …`, B grows behind | `zoom`, `anchorX/Y`, `motionBlur` |
| Pan | `pan` | translate A→B by `p` | `direction` |
| Zoom & Pan | `zoomAndPan` | pan + `scale = 1 + zoom·p` | `direction`, `zoom`, `anchorX/Y` |
| Zoom + Motion Blur | `zoomMotionBlur` | zoom + `N`-sample streak | `zoom`, `motionBlur`, `anchorX/Y` |
| Scale Up / Down | `scaleUp`, `scaleDown` | `scale = p` (or `1−p`) | `anchorX/Y` |
| Scale Bounce | `scaleBounce` | spring `scale(p)` (overshoot) | `tension`, `friction`, `anchorX/Y` |

### Category 5 — Rotation & Flip

| Effect | id | Math | Variables |
|---|---|---|---|
| Spin (2D) | `spin2d` | rotation `= spins·2π·(1−p)` + crossfade | `spins` |
| Swivel (H-flip) | `swivel` | 3D Y-flip `angle = p·π`, `scaleX = cos∠`, `perspective` foreshorten | `perspective`, `backface` |
| Flip Vertical | `flipVertical` | 3D X-flip `angle = p·π` | `perspective`, `backface` |
| Rotate & Scale | `rotateAndScale` | rotation + scale-in of B | `spins`, `anchorX/Y` |

### Category 5 (ext) — Advanced 3D Rotation

Quads through the 3D pipeline (projection + rotation matrices + Lambert shading).

| Effect | id | Math | Variables |
|---|---|---|---|
| Cube Rotation | `cube` | A,B on adjacent cube faces, turn `= p·½π` | `direction`, `perspective` |
| Card Flip 3D | `cardFlip3d` | back-to-back quads with `thickness`, flip `p·π` | `direction`, `thickness`, `perspective` |
| Tumble | `tumble` | A falls: rotate `spins·2π·p`, translate + shrink | `spins`, `perspective` |
| Doors 3D | `doors3d` | two panels hinge open `angle = p·½π` | `direction`, `perspective` |
| Curtains 3D | `curtains3d` | `segments` strips fold to the sides | `segments`, `perspective` |
| Fly-Through Flip | `flyThroughFlip` | camera pushes in as A flips | `thickness`, `perspective` |

### Category 6 — Page, Fold & Curl

| Effect | id | Math | Variables |
|---|---|---|---|
| Fold | `fold` | centre hinge rotates away `p·½π` | `orientation`, `perspective` |
| Accordion Fold | `accordionFold` | alternating panel folds, compress | `segments`, `perspective` |
| Unfold | `unfold` | B from edge-on (`p·½π`) to flat | `orientation`, `perspective` |
| Page Turn | `pageTurn` | cylinder column mesh, `radius` sets curl | `radius`, `perspective` |
| Page Roll | `pageRoll` | tight page turn (small radius) | `perspective` |
| Page Curl / Peel / Sticky | `pageCurl`, `peelOff`, `stickyPeel` | corner peel + gradient shadow (stylised 2D) | `corner` |

### Category 7 — Shape, Pattern & Mosaic

Base: grid of tiles revealed in a per-tile order with a `spread` (stagger); tile
`t_ij` shows when `order(i,j) + spread·rand ≤ p`.

| Effect | id | Math | Variables |
|---|---|---|---|
| Checkerboard | `checkerboard` | parity ordering | `grid`, `spread` |
| Blinds | `blinds` | strip height `= p` | `orientation`, `count` |
| Box / Squares | `boxTiles` | tiles grow `= p` | `grid`, `spread` |
| Diamond Pattern | `diamondTiles` | L¹ distance ordering | `grid`, `spread` |
| Random Bars | `randomBars` | seeded per-bar start times | `orientation`, `count`, `seed` |
| Strips | `strips` | alternating slide direction | `orientation`, `count` |
| Block Dissolve | `blockDissolve` | seeded per-block fade | `grid`, `spread`, `seed` |
| Spiral Wipe | `spiralWipe` | spiral rank ordering | `grid`, `spread` |
| Wheel | `wheel` | angle ordering `= atan2` | `grid`, `spread` |
| Tile Flip | `tileFlip` | per-tile flip `p·π` | `grid`, `spread`, `seed` |
| Mosaic / Pixelate | `mosaic` | block size `∝ 1/grid`, crossfade | `grid` |
| Vortex / Swirl | `vortex` | ring rotation `∝ (1 − r)·twist` | `twist` |

### Category 8 — Distortion, Glitch & Digital

Seeded, band-based warps + post-processing. `g = bump(p)·amount`.

| Effect | id | Math | Variables |
|---|---|---|---|
| Glitch | `glitch` | band shift `dx = (hash−½)·g·0.18·w`; chromatic `= g·16`; noise `= g·0.3` | `seed`, `amount` |
| Pixel Sorting | `pixelSort` | per-column vertical smear length `∝ hash·g` | `seed`, `amount` |
| Bad TV | `badTV` | row roll `= noise·g·0.15·w` + scanlines + noise | `seed`, `amount` |
| Digital Block Wipe | `digitalBlockWipe` | block shows when `hash(i,j) ≤ p`, occasional macroblock offset | `seed`, `amount` |
| Data Moshing | `dataMosh` | block displace `d = g·22` at angle `noise·2π` | `seed`, `amount` |
| Wave Warp | `waveWarp` | row shift `= sin((y·freq + p)·2π)·amp·bump(p)` | `amplitude`, `frequency` |
| Ripple | `ripple` | concentric ring scale `s = 1 + sin(r·freq·2π − p·4π)·amp/r` | `amplitude`, `frequency` |
| Swirl / Twirl | `swirl` | ring rotation `∠ = (1 − r)·amplitude·bump(p)` | `amplitude` |
| Liquify | `liquify` | row shift `= (noise − ½)·amp·2` | `amplitude`, `seed` |
| Melt | `melt` | column drop `= (0.4 + 0.6·hash)·p·1.3·h` | `seed` |
| Stretch | `stretch` | axis scale `= 1 + bump(p)·6` | `frequency` (axis) |
| Motion Tile | `motionTile` | repeat `tiles`, offset `∝ p·w`, row parity direction | `frequency` (tiles) |
| Retro VHS | `retroVHS` | row wobble + colour bleed (`screen` at `+6·g`) + tracking band `y = (2p mod 1)·h` | `seed` |
| Flicker | `flicker` | strobe: show B when `hash(⌊p·steps⌋) < p` + white flashes | `seed`, `frequency` |
| Light Leak | `lightLeak` | screened warm radial gradient, position `∝ p`, hue = `hue` | `hue` |
| Prism / Chromatic | `prism` | chromatic split `offset = amplitude·bump(p)` | `amplitude` |

### Category 9 — Particles & Disintegration

**CellFly** base — closed-form ballistics per grid cell (frame-independent):

```
t  = clamp01((p − delay)/(1 − delay))          delay from seed/stagger
Δ  = (v·t + ½·a·t²)·(w,h)          v from spread mode, a = (wind, gravity)
rot = jitter·spin·t              α = clamp01(1 − t·fade)      scale = 1 − 0.6t (opt)
```

Spread modes: `radial` (v ∝ cell offset from centre), `directional` (v ∝ wind
dir), `random` (v at seeded angle), `down` (gravity-led).

| Effect | id | Math | Variables |
|---|---|---|---|
| Particle Dissolve | `particleDissolve` | random spread, drift + gravity, quick fade | `density`, `seed` |
| Shatter / Glass | `shatter` | radial spread, spin, low fade (shards) | `density`, `seed` |
| Explosion | `explosion` | strong radial `v`, central flash gradient | `density`, `seed` |
| Smoke / Fog | `smokeBurst` | A rises + `blur(24p)` + fade; particles buoyant (`gravityY<0`) | `density`, `seed` |
| Sandstorm | `sandstorm` | directional wind, streaky, high fade | `direction`, `density`, `seed` |
| Bubbles | `bubbles` | rising circles `y − p·h·k`, wobble `sin`, rim + highlight | `density`, `seed` |
| Leaves / Confetti | `confetti` | down spread + gravity, high spin (tumble) | `density`, `seed` |
| Fire | `fire` | burn line `y = (1−p)·h` + wobble; flame gradient band | `seed` |
| Water / Wave Wash | `waterWash` | crest `x = 1.25·p·w`, refraction row shift `sin`, foam line | `seed` |
| Magic Dust | `magicDust` | gentle dissolve + screened sparkles near the front | `density`, `seed` |
| Morphing Particles | `morphingParticles` | scatter `radius ∝ sin(πp)`, cells A→B at mid | `density`, `seed` |
| Constellation | `constellation` | points lerp A→B, connect when distance `< 0.16·w` | `density`, `seed` |
| Low Poly Explode | `lowPolyExplode` | coarse radial shards | `density`, `seed` |
| Crumble | `crumble` | top-down stagger, high gravity | `density`, `seed` |

### Category 10 — Camera Movement & Depth

2D moves = affine transform + post-processing; 3D moves = quads through the
camera/projection pipeline.

| Effect | id | Math | Variables |
|---|---|---|---|
| Whip Pan | `whipPan` | translate `±2p·w` + motion blur `40 + 120·bump(p)·blur` | `blur` |
| Tilt Whip | `tiltWhip` | vertical whip + blur | `blur` |
| Dolly In | `dollyIn` | A `scale = 1 + depth·p`, B settles | `depth`, `blur` |
| Dolly Out | `dollyOut` | A `scale = 1 − depth·p`, B behind | `depth` |
| Truck / Crab | `truck` | lateral slide `±p·w` + slight blur | `blur` |
| Zoom + Shake | `zoomShake` | `scale = 1 + 0.5p`, seeded shake `amp = 26·bump(p)·amount` | `amount`, `seed` |
| Parallax Camera | `parallaxCamera` | bg slow (`0.5·w`), fg fast (`1.2·w`) + fade | `depth` |
| Ken Burns | `kenBurns` | slow `scale 1.05→1.25` + pan, crossfade | — |
| Dolly Zoom | `dollyZoom` | opposing `scaleX` vs `scaleY` warp | `depth` |
| Rack Focus | `rackFocus` | A `blur = p·max` out, B `blur = (1−p)·max` in | `blur` |
| Aerial Flyover | `aerialFlyover` | diagonal sweep + vignette | — |
| Fly Through | `flyThrough` | B `z: −1400→0`, A `z: 0→dist·0.82` (3D) | — |
| Orbital / Arc | `orbital` | turntable `rot.y` + lateral arc (3D) | — |
| 3D Room | `room3d` | A front wall, B right wall; camera yaw `−½π·p` (3D) | — |
| 360 Spin | `spin360` | `rot.y = p·2π` swaps front/back (3D) | — |
| Perspective Slide | `perspectiveSlide` | tilted quads (`rot.y = −0.4`) slide across (3D) | — |

---

## Controlling the variables

Every transition's variables above are editable **per clip**:

- **Inspector → Transitions**: pick a transition for **In** / **Out**, then adjust
  its variables (sliders / dropdowns / toggles generated from the parameter
  schema), plus **duration** and **direction**.
- **Timeline right-click → Add effect / Transition in / out**: quick shortlist.

The values are stored on the clip (persisted in the `.sefx` project) and passed
into the math engine at render time, so they affect both the live preview and the
deterministic export identically.

Approximation notes (stylised, canvas-2D — not physical simulations): pixel-sort
& data-mosh use band smears; shatter uses grid shards (not Voronoi); fire/smoke
are gradient/particle looks; the 3D camera moves use the software rasteriser so
extreme fovs are approximate. See `docs/transitions/README.md` for details.
