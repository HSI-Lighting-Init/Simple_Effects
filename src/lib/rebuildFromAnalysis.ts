// Phase 2 (roadmap docs/TEMPLATE_EXTRACTOR_ROADMAP.md): `rebuild_from_analysis`
// replays a measured TemplateAnalysis (cuts + per-shot motion/grade/fades +
// matched transitions + text beats, however they were produced — cut
// detection, the aligner, OCR, all upstream of this module) with new media,
// through the app's own editing API. Same "drive the engine from a plain
// function given a narrow io interface" pattern as synthetic.ts and
// stylePacks.ts's applyStylePack — read those first if this looks unfamiliar.
import type { Project } from "../bindings/Project";
import type { Layer } from "../bindings/Layer";
import type { Rgba } from "../bindings/Rgba";
import type { Track } from "../bindings/Track";
import type { TextStyle } from "../bindings/TextStyle";
import type { FittedMotion } from "../bindings/FittedMotion";
import {
  newProject,
  setCompSize,
  setCompFps,
  setCompDuration,
  setLayerRange,
  editKeyframes,
  setLayerTransition,
  addEffect,
  keyEffect,
  addTextLayer,
  setTextStyle,
  setTornEdgeStatic,
  fitBackground,
} from "./api";

/** One measured shot from a reference video's analysis. */
export interface ShotAnalysis {
  index: number;
  startMs: number; // in the REFERENCE video's timeline
  endMs: number;
  /** Was this shot classified as a still photo under camera motion (true) vs
   *  continuous footage / motion graphics with no single recoverable
   *  transform (false)? When false, motion is omitted or ignored. */
  isStill: boolean;
  /** Sparse relative-motion samples across the shot, RELATIVE TO THE SHOT'S
   *  OWN START (t=0 at shot start), scale 1.0 = same framing as the shot's
   *  first frame. Optional — only present when isStill. `solved` (default
   *  true when omitted — a hand-built/synthetic sample is real by
   *  construction) mirrors `AlignSample.solved`: false means the aligner
   *  lost track and carried the previous value forward, not a genuine
   *  reading — `fitBackground` (the Rust side) excludes those before
   *  fitting. */
  motion?: { tMs: number; scale: number; rotationDeg: number; tx: number; ty: number; solved?: boolean }[];
  look: {
    brightness: number; contrast: number; saturate: number; // 1.0 = unchanged
    vignetteStrength: number; // 0..1
    fadeInMs: number; fadeOutMs: number; // 0 = none
  };
  /** When the shot shows more than one image/video at once — a photo grid or
   *  stacked/independently-moving cards (src-tauri's `analyze::layout`) —
   *  regions.length > 1 and this shot gets one media layer per region
   *  instead of the usual single full-frame layer. Absent or a single region
   *  means "no layout detected", the plain single-photo path. */
  layout?: ShotLayout;
  /** Gate C's per-element decomposition (see ElementLayer's own doc) -
   *  present and non-empty means this shot is built element-by-element
   *  instead of the single cover-fit/regions path above. */
  elements?: ElementLayer[];
}

export interface RegionMotionSample { tMs: number; scale: number; rotationDeg: number; tx: number; ty: number }

/** One simultaneously-visible element within a shot, as a fractional box
 *  (0..1) of the reference frame. `motion` (>=2 samples, relative to the
 *  shot's own start like `ShotAnalysis.motion`) means this region itself
 *  moves independently — a stacked/animated card; absent/short means it
 *  holds still — a grid cell. */
export interface ElementRegion {
  xFrac: number; yFrac: number; wFrac: number; hFrac: number;
  motion?: RegionMotionSample[];
}

export interface ShotLayout {
  kind: "single" | "grid" | "multiMotion";
  regions: ElementRegion[];
}

/** Gate C (roadmap item 4, piece 4): one Phase 3 decomposition element
 *  (`sam/phase3_core.py`'s own `objects[]`/`textObjects[]`) as its own
 *  layer, instead of the single cover-fit layer the `layout`/`regions` path
 *  above builds. A shot carrying `elements` takes this path entirely (see
 *  `rebuildFromAnalysis`'s own dispatch) - layout/regions and elements are
 *  different detectors (Rust `analyze::layout` vs this Python SAM pipeline)
 *  and never both apply to the same shot.
 *  - "stillCard": `mediaIndex` is the element's own sprite PNG.
 *  - "footageCard": `mediaIndex` is the ORIGINAL shot clip (no per-layer
 *    crop/matte exists in this engine yet - this shows the clip's WHOLE
 *    frame scaled into the card's own small box, visibly wrong content
 *    though correctly positioned/timed; an intentional, honest gap for
 *    Gate C's own error metric to surface, not a bug to route around here.
 *    See `fit_elements.py`'s own module doc for why content can't just be
 *    aligned directly - the cards play real footage, not a static photo.
 *  - "text": `content` instead of `mediaIndex` - a plain `addTextLayer`.
 *  `fittedMotion` is ALREADY fitted (phase3_core.py ran `fit_background`
 *  itself, unlike `ShotAnalysis.motion`'s raw samples) - absent means
 *  static (box-kind text, or a card `fit_element_mask_motion` couldn't fit
 *  at all): placed once at `refBbox`'s own pose, never keyed. `refCentroid`
 *  is the EXACT point `fittedMotion`'s keyframes pivot around - see
 *  `composeElementPose`'s own doc for the verified composition formula. */
export interface ElementLayer {
  kind: "stillCard" | "footageCard" | "text";
  mediaIndex?: number;
  content?: string;
  startMs: number; // shot-relative (0 = shot start), matching ShotAnalysis.motion's own convention
  endMs: number;
  refBbox?: [number, number, number, number]; // x0,y0,x1,y1, comp-pixel coords at the reference pose
  refCentroid?: [number, number];
  fittedMotion?: FittedMotion;
}

export interface TransitionAnalysis {
  /** Matches a shot boundary time in the reference's timeline (i.e. some
   *  shot's startMs, except shot 0's). */
  atMs: number;
  /** REGISTRY engine id to use for this boundary's "in" transition, already
   *  chosen by the caller (this module doesn't pick it) — undefined/null
   *  means "no transition was matched confidently, use a plain cut". */
  engine?: string | null;
  durMs: number;
}

export interface TextBeat {
  startMs: number;
  endMs: number;
  /** Actual copy to render — filled in by whoever read the source video
   *  (this module doesn't do OCR), possibly translated/rewritten for the
   *  new brand. */
  content: string;
  sizePx?: number; // default a sensible value, e.g. 90
}

/** A two-layer "outline builds into a fill" title, e.g. a wordmark that
 *  starts as hollow stroked letters and solidifies — optionally as two
 *  staggered instances (a bigger background "echo" + a smaller foreground
 *  "primary", the reference's own SPORT/SPORT treatment). Built from the
 *  engine's existing `TextStyle.fills`/`strokes` plus a layer-opacity
 *  crossfade — no new engine feature, just two text layers per instance. */
export interface KineticTitle {
  startMs: number;
  endMs: number;
  primaryContent: string;
  echoContent?: string; // defaults to primaryContent (the reference repeats the same word)
  primarySizePx?: number; // default 90
  echoSizePx?: number; // default primarySizePx * 1.4
  primaryColor?: string; // hex, default "#FFFFFF"
  echoColor?: string; // hex, default "#8CFF3A"
  fillDelayMs?: number; // ms after startMs the primary solidifies, default 300
  echoFillDelayMs?: number; // ms after startMs the echo solidifies, default 600 (after primary)
  crossfadeMs?: number; // outline->fill opacity crossfade duration, default 200
}

/** A fanned deck of torn-paper photo copies — the reference's stroboscopic
 *  "trail" treatment: the same clip repeated `copies` times, each offset a
 *  little further along a diagonal and each given a jagged torn edge
 *  (`Effect::TornEdge`, via `setTornEdgeStatic`). Unlike `layout`'s
 *  Grid/MultiMotion (auto-detected, different content per region), this is
 *  ONE piece of new media reused across every copy — a distinct visual
 *  recipe, not a layout-detection output, so it's its own array here (same
 *  reasoning as `kineticTitles`: whoever reads the reference — a human or
 *  Claude — decides a shot gets this treatment). */
export interface CardStack {
  startMs: number;
  endMs: number;
  copies?: number; // default 5
  offsetPx?: { x: number; y: number }; // per-copy step toward the frontmost copy, default {x:-18, y:-10}
  tornSide?: 0 | 1 | 2 | 3; // 0=right,1=left,2=top,3=bottom, default 0
  paperWidth?: number; // default 10
  paperColor?: string; // hex, default "#F5F2EB"
}

export interface TemplateAnalysis {
  durationMs: number;
  width: number;
  height: number;
  fps: number;
  shots: ShotAnalysis[]; // sorted by startMs, covering the whole duration with no gaps (caller's responsibility)
  transitions: TransitionAnalysis[];
  textBeats: TextBeat[];
  kineticTitles?: KineticTitle[];
  cardStacks?: CardStack[];
}

/** The slice of AgentCtx this module needs — kept narrow, same reasoning as
 *  SyntheticIO in synthetic.ts (avoids a circular import with agent/tools.ts;
 *  an AgentCtx satisfies this structurally). `addMedia` self-commits — call
 *  `project()` right after it to read the fresh layer back. Every other
 *  mutation returns its own fresh Project; thread it through by hand and
 *  `commit()` once at the end, before exporting. */
export interface RebuildIO {
  project(): Project;
  commit(p: Project): Promise<void>;
  importMedia(paths: string[]): Promise<void>;
  addMedia(index: number): Promise<number>;
  exportVideo(outPath: string, opts?: { format?: "mp4" | "webm"; fps?: number }): Promise<string>;
}

export interface RebuildResult {
  videoPath: string;
  project: Project;
}

/** Nearest transition entry to a shot boundary, within `toleranceMs`. */
function nearestTransition(transitions: TransitionAnalysis[], atMs: number, toleranceMs = 50): TransitionAnalysis | undefined {
  let best: TransitionAnalysis | undefined;
  let bestDiff = Infinity;
  for (const t of transitions) {
    const diff = Math.abs(t.atMs - atMs);
    if (diff <= toleranceMs && diff < bestDiff) {
      best = t;
      bestDiff = diff;
    }
  }
  return best;
}

function hexToRgba(hex: string, opacityPct = 100): Rgba {
  const m = hex.replace("#", "");
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  return { r, g, b, a: Math.round((opacityPct / 100) * 255) };
}

const constTrack = (v: number): Track => ({ keys: [], default: v });

/** A layer's own source content size (crop-aware for images) — the same
 *  native-size lookup `fitScale` in stylePacks.ts uses, duplicated here to
 *  avoid a cross-module import for one small helper. */
function nativeSize(layer: Layer): { w: number; h: number } | null {
  const k = layer.kind;
  if (k.kind === "image") return k.crop ? { w: k.crop.width, h: k.crop.height } : { w: k.width, h: k.height };
  if (k.kind === "video") return { w: k.width, h: k.height };
  return null;
}

/** Place a layer to contain-fit a fractional box of the comp (a grid cell or
 *  a stacked-card region) instead of the whole frame: centre at the box's
 *  centre (`x`/`y` are the layer's own centre in comp px, per Transform's
 *  doc), scaled to contain-fit the box from the layer's native size. When
 *  the region carries its own measured motion, keys start/end scale by that
 *  motion's ratio on top of the box-fit baseline (mirrors `animateMotion`,
 *  just anchored to the region's box instead of the full comp). */
async function placeRegion(layerId: number, shot: ShotAnalysis, region: ElementRegion, compW: number, compH: number, p: Project): Promise<Project> {
  const layer = p.layers.find((l) => l.id === layerId);
  const native = layer ? nativeSize(layer) : null;
  const boxW = region.wFrac * compW;
  const boxH = region.hFrac * compH;
  const cx = (region.xFrac + region.wFrac / 2) * compW;
  const cy = (region.yFrac + region.hFrac / 2) * compH;
  const baseline = native && native.w > 0 && native.h > 0 ? Math.min(boxW / native.w, boxH / native.h) : Math.min(boxW, boxH) / 100;

  const motion = region.motion;
  const ratio = motion && motion.length >= 2 && motion[0].scale !== 0 ? motion[motion.length - 1].scale / motion[0].scale : 1;

  await editKeyframes(layerId, shot.startMs, { x: cx, y: cy, scaleX: baseline, scaleY: baseline, easing: "linear" }, true);
  return editKeyframes(layerId, shot.endMs, { x: cx, y: cy, scaleX: baseline * ratio, scaleY: baseline * ratio, easing: "linear" }, false);
}

/** `align_shot`'s decode resolution (mod.rs, lib.rs's `align_reference` — both
 *  hardcode this too, no shared constant to import across the Rust/TS
 *  boundary; update together if it ever changes). Needed to undo the ffmpeg
 *  downscale: `align_shot`'s tx/ty are in this decode's pixel grid, not the
 *  comp's. */
const MOTION_ANALYSIS_SHORT_SIDE = 256;

/** Ken Burns from the shot's measured motion, via the 2.5 fitter
 *  (`fit_background`) rather than a crude first/last-sample straight line —
 *  a multi-segment curve per channel with real recovered easing (including
 *  overshoot). The anchor/centre composition (`STATUS-gateA-aligner.md`'s
 *  "not done", now done): `align_shot`'s scale/rotation/tx/ty are RELATIVE to
 *  the shot's reference frame in analysis-pixel units, not this engine's
 *  absolute comp-space transform — composed onto the layer's own current
 *  (cover-fit) x/y/scale/rotation as the reference anchor, translation
 *  rescaled by `k = compW / MOTION_ANALYSIS_SHORT_SIDE` to undo the ffmpeg
 *  downscale (valid because the analysis decode preserves the source
 *  video's aspect ratio, same as the comp's — a uniform k works for both
 *  axes; see `align_shot`'s own doc for the derivation).
 *
 *  ponytail: scale's own fitted easing is applied to the WHOLE compound key
 *  (x/y/scale/rotation together) rather than each channel's independently -
 *  fitted shape — `editKeyframes` only takes one easing per call, so honoring
 *  all four would mean up to 4 calls per key-time instead of 1. Scale is
 *  usually the perceptually dominant parameter in a Ken Burns move; upgrade
 *  to per-channel calls if rotation/pan easing fidelity turns out to matter.
 *
 *  Returns undefined when there's nothing to key (not still, or too few
 *  samples), so the caller leaves the layer at its flat cover-fit pose. */
async function animateMotion(layerId: number, shot: ShotAnalysis, compW: number, p: Project): Promise<Project | undefined> {
  if (!shot.isStill || !shot.motion || shot.motion.length < 2) return undefined;
  const layer = p.layers.find((l) => l.id === layerId);
  const refScale = layer?.transform.scaleX.default ?? 1.0;
  const refRotation = layer?.transform.rotation.default ?? 0;
  const refX = layer?.transform.x.default ?? compW / 2;
  const refY = layer?.transform.y.default ?? 0;
  const k = compW / MOTION_ANALYSIS_SHORT_SIDE;

  const samples = shot.motion.map((m) => ({ ...m, solved: m.solved ?? true }));
  const spanMs = shot.endMs - shot.startMs;
  const fitted = await fitBackground(samples, 0, spanMs);
  if (fitted.scale.length < 2) return undefined;
  for (const [i, scaleKey] of fitted.scale.entries()) {
    const rot = fitted.rotationDeg[i]?.value ?? 0;
    const tx = fitted.tx[i]?.value ?? 0;
    const ty = fitted.ty[i]?.value ?? 0;
    p = await editKeyframes(
      layerId,
      shot.startMs + scaleKey.timeMs,
      {
        scaleX: refScale * scaleKey.value,
        scaleY: refScale * scaleKey.value,
        rotation: refRotation + rot,
        x: refX + k * tx,
        y: refY + k * ty,
        easing: scaleKey.easing,
      },
      i === 0
    );
  }
  return p;
}

/** Key an ALREADY-FITTED FittedMotion (Gate C's `ElementLayer.fittedMotion` -
 *  `fit_background` already ran in Python, unlike `animateMotion`'s raw
 *  samples) onto a layer, composing each keyframe's (scale,rotationDeg,tx,ty)
 *  onto `refCentroid` - NOT a simple additive offset like `animateMotion`'s
 *  own `refX + k*tx` (valid there only because `align_shot`'s samples are
 *  already a tracked point's own translation). `fit_elements.py`'s tx/ty are
 *  a raw similarity-matrix translation column instead: apply
 *  [[a,-b,tx],[b,a,ty]] to the reference frame's own centroid to get its
 *  position at this keyframe. Verified empirically (not assumed) against a
 *  track's own known per-frame centroids before trusting it here - see
 *  fit_elements.py's `fit_element_mask_motion` doc for the numbers. No `k`
 *  rescaling either: fit_elements.py fits on the shot's native-resolution
 *  frames directly, not align_shot's downscaled 256px analysis grid, so
 *  comp pixels and fitted pixels are already the same units (Gate C's comp
 *  size matches the source reel's own native resolution). */
async function applyElementFittedMotion(layerId: number, fitted: FittedMotion, refCentroid: [number, number], baselineScaleX: number, baselineScaleY: number, shotStartMs: number, p: Project): Promise<Project> {
  const [rcx, rcy] = refCentroid;
  for (const [i, scaleKey] of fitted.scale.entries()) {
    const rot = fitted.rotationDeg[i]?.value ?? 0;
    const tx = fitted.tx[i]?.value ?? 0;
    const ty = fitted.ty[i]?.value ?? 0;
    const theta = (rot * Math.PI) / 180;
    const a = scaleKey.value * Math.cos(theta);
    const b = scaleKey.value * Math.sin(theta);
    const cx = a * rcx - b * rcy + tx;
    const cy = b * rcx + a * rcy + ty;
    p = await editKeyframes(
      layerId,
      shotStartMs + scaleKey.timeMs,
      { x: cx, y: cy, scaleX: baselineScaleX * scaleKey.value, scaleY: baselineScaleY * scaleKey.value, rotation: rot, easing: scaleKey.easing },
      i === 0
    );
  }
  return p;
}

/** Gate C: build one layer per Phase 3 element instead of the shot's usual
 *  single cover-fit layer - see `ElementLayer`'s own doc for the three
 *  kinds and the footageCard gap. Each element gets its own
 *  [shot.startMs+el.startMs, shot.startMs+el.endMs] range (its own observed
 *  presence span, not necessarily the whole shot), placed at `refBbox`'s
 *  own pose and, when `fittedMotion` is present, animated via
 *  `applyElementFittedMotion`; static (no fittedMotion) elements are placed
 *  once and left flat. Returns the fresh project; caller threads it through
 *  like every other builder here. */
async function buildShotElements(shot: ShotAnalysis, io: RebuildIO, p: Project): Promise<Project> {
  for (const el of shot.elements ?? []) {
    const elStartMs = shot.startMs + el.startMs;
    const elEndMs = shot.startMs + el.endMs;

    if (el.kind === "text") {
      const sizePx = el.refBbox ? Math.max(12, el.refBbox[3] - el.refBbox[1]) : 90;
      p = await addTextLayer(el.content ?? "", sizePx);
      const layerId = p.layers[p.layers.length - 1].id;
      p = await setLayerRange(layerId, elStartMs, elEndMs);
      if (el.refCentroid) {
        const [cx, cy] = el.refCentroid;
        p = await editKeyframes(layerId, elStartMs, { x: cx, y: cy, scaleX: 1, scaleY: 1, easing: "linear" }, true);
      }
      if (el.fittedMotion && el.refCentroid) {
        p = await applyElementFittedMotion(layerId, el.fittedMotion, el.refCentroid, 1, 1, shot.startMs, p);
      }
      continue;
    }

    if (el.mediaIndex === undefined || !el.refBbox) continue; // no usable placement data - a flagged gap, not silently faked
    const layerId = await io.addMedia(el.mediaIndex); // self-commits
    if (layerId < 0) throw new Error(`addMedia failed for a Gate C element (mediaIndex ${el.mediaIndex})`);
    p = io.project();
    p = await setLayerRange(layerId, elStartMs, elEndMs);

    const layer = p.layers.find((l) => l.id === layerId);
    const native = layer ? nativeSize(layer) : null;
    const [bx0, by0, bx1, by1] = el.refBbox;
    const bboxW = bx1 - bx0;
    const bboxH = by1 - by0;
    // Stretch-fit, not contain-fit (placeRegion's own choice): a sprite is
    // stored as a fixed 128x128 crop regardless of the card's own aspect
    // ratio, so matching width AND height independently is what actually
    // reproduces it at its original aspect - a uniform contain-fit would
    // letterbox it. A footageCard's full source frame has no "correct"
    // aspect to preserve here either way (see ElementLayer's own doc on
    // that gap), so the same stretch-fit is used for both kinds.
    const baselineScaleX = native && native.w > 0 ? bboxW / native.w : 1;
    const baselineScaleY = native && native.h > 0 ? bboxH / native.h : 1;
    const cx = el.refCentroid ? el.refCentroid[0] : (bx0 + bx1) / 2;
    const cy = el.refCentroid ? el.refCentroid[1] : (by0 + by1) / 2;
    p = await editKeyframes(layerId, elStartMs, { x: cx, y: cy, scaleX: baselineScaleX, scaleY: baselineScaleY, rotation: 0, easing: "linear" }, true);

    if (el.fittedMotion && el.refCentroid) {
      p = await applyElementFittedMotion(layerId, el.fittedMotion, el.refCentroid, baselineScaleX, baselineScaleY, shot.startMs, p);
    }
  }
  return p;
}

/** Fade in/out via opacity keyframes, from the shot's measured fade durations. */
async function applyFades(layerId: number, shot: ShotAnalysis, p: Project): Promise<Project> {
  const { fadeInMs, fadeOutMs } = shot.look;
  if (fadeInMs > 0) {
    await editKeyframes(layerId, shot.startMs, { opacity: 0, easing: "linear" }, false);
    p = await editKeyframes(layerId, shot.startMs + fadeInMs, { opacity: 1, easing: "linear" }, false);
  }
  if (fadeOutMs > 0) {
    await editKeyframes(layerId, shot.endMs - fadeOutMs, { opacity: 1, easing: "linear" }, false);
    p = await editKeyframes(layerId, shot.endMs, { opacity: 0, easing: "linear" }, false);
  }
  return p;
}

/** Grade: brightness/contrast/saturate always, vignette only when measured
 *  strength is meaningfully above 0 — via the same add_effect path the agent
 *  tool and stylePacks.ts use. */
async function gradeShot(layerId: number, shot: ShotAnalysis, p: Project): Promise<Project> {
  const applyOne = async (kind: string, param: "amount" | "intensity", value: number) => {
    p = await addEffect(layerId, kind);
    const layer = p.layers.find((l) => l.id === layerId);
    const idx = layer ? layer.effects.length - 1 : 0;
    p = await keyEffect(layerId, idx, param, 0, value, false);
  };
  await applyOne("brightness", "amount", shot.look.brightness);
  await applyOne("contrast", "amount", shot.look.contrast);
  await applyOne("saturate", "amount", shot.look.saturate);
  if (shot.look.vignetteStrength > 0.15) await applyOne("vignette", "intensity", shot.look.vignetteStrength);
  return p;
}

/** One outline-then-fill instance: an outline-only text layer that's visible
 *  first, crossfading (layer opacity) into a filled+stroked text layer at
 *  `fillAtMs` — two stacked `TextStyle`s + a Transform.opacity keyframe pair
 *  each, since `TextStyle` itself isn't keyframeable. Returns the fresh
 *  project; caller threads it through like every other builder here. */
async function addKineticInstance(content: string, sizePx: number, hex: string, span: { startMs: number; endMs: number }, fillAtMs: number, crossfadeMs: number, p: Project): Promise<Project> {
  const color = hexToRgba(hex);
  const strokeWidth = Math.max(2, sizePx * 0.03);
  const baseStyle: TextStyle = {
    fills: [],
    strokes: [{ color, opacity: 100, width: strokeWidth, position: "center" }],
    fillOverStroke: false,
    tracking: constTrack(0),
    leading: 0,
    baselineShift: constTrack(0),
    fontFamily: null,
    fallbackStack: [],
    fontStyle: null,
    variableAxes: {},
  };
  const filledStyle: TextStyle = { ...baseStyle, fills: [{ color, opacity: 100 }] };

  p = await addTextLayer(content, sizePx);
  const outlineId = p.layers[p.layers.length - 1].id;
  p = await setLayerRange(outlineId, span.startMs, span.endMs);
  p = await setTextStyle(outlineId, baseStyle);
  await editKeyframes(outlineId, span.startMs + fillAtMs, { opacity: 1, easing: "linear" }, false);
  p = await editKeyframes(outlineId, span.startMs + fillAtMs + crossfadeMs, { opacity: 0, easing: "linear" }, false);

  p = await addTextLayer(content, sizePx);
  const filledId = p.layers[p.layers.length - 1].id;
  p = await setLayerRange(filledId, span.startMs, span.endMs);
  p = await setTextStyle(filledId, filledStyle);
  await editKeyframes(filledId, span.startMs, { opacity: 0, easing: "linear" }, true);
  await editKeyframes(filledId, span.startMs + fillAtMs, { opacity: 0, easing: "linear" }, false);
  p = await editKeyframes(filledId, span.startMs + fillAtMs + crossfadeMs, { opacity: 1, easing: "linear" }, false);
  return p;
}

/** The reference's SPORT/SPORT title build: a bigger background "echo" and a
 *  smaller foreground "primary" instance of (usually) the same word, each
 *  independently building from outline to fill, staggered so the primary
 *  solidifies first. Echo is added first so it sits behind the primary in
 *  the (bottom-first) layer stack. */
async function buildKineticTitle(t: KineticTitle, p: Project): Promise<Project> {
  const primarySize = t.primarySizePx ?? 90;
  const echoSize = t.echoSizePx ?? Math.round(primarySize * 1.4);
  const span = { startMs: t.startMs, endMs: t.endMs };
  p = await addKineticInstance(t.echoContent ?? t.primaryContent, echoSize, t.echoColor ?? "#8CFF3A", span, t.echoFillDelayMs ?? 600, t.crossfadeMs ?? 200, p);
  p = await addKineticInstance(t.primaryContent, primarySize, t.primaryColor ?? "#FFFFFF", span, t.fillDelayMs ?? 300, t.crossfadeMs ?? 200, p);
  return p;
}

/** Build one fanned, torn-edge card stack: `copies` layers of the SAME media
 *  item, each box-fit to the full comp and stepped `offsetPx` further along
 *  a diagonal, every copy torn on `tornSide`. Added furthest-back copy
 *  first (bottom of the — bottom-first — layer stack) so the frontmost copy
 *  ends up on top, matching the reference's read. Each copy's tear uses a
 *  different seed so the jagged edges don't look mechanically identical
 *  stacked on each other. */
async function buildCardStack(cs: CardStack, mediaIndex: number, compW: number, compH: number, io: RebuildIO, p: Project): Promise<Project> {
  const copies = cs.copies ?? 5;
  const offsetX = cs.offsetPx?.x ?? -18;
  const offsetY = cs.offsetPx?.y ?? -10;
  const side = cs.tornSide ?? 0;
  const paperWidth = cs.paperWidth ?? 10;
  const paperColor = hexToRgba(cs.paperColor ?? "#F5F2EB");

  for (let i = copies - 1; i >= 0; i--) {
    const layerId = await io.addMedia(mediaIndex); // self-commits
    if (layerId < 0) throw new Error(`addMedia failed for card stack copy ${i}`);
    p = io.project();
    p = await setLayerRange(layerId, cs.startMs, cs.endMs);

    const layer = p.layers.find((l) => l.id === layerId);
    const native = layer ? nativeSize(layer) : null;
    const baseline = native && native.w > 0 && native.h > 0 ? Math.min(compW / native.w, compH / native.h) : 1;
    const cx = compW / 2 + offsetX * i;
    const cy = compH / 2 + offsetY * i;
    await editKeyframes(layerId, cs.startMs, { x: cx, y: cy, scaleX: baseline, scaleY: baseline, easing: "linear" }, true);
    p = await editKeyframes(layerId, cs.endMs, { x: cx, y: cy, scaleX: baseline, scaleY: baseline, easing: "linear" }, false);

    p = await addEffect(layerId, "tornedge");
    const idx = p.layers.find((l) => l.id === layerId)!.effects.length - 1;
    p = await setTornEdgeStatic(layerId, idx, side, 0.12, 1000 + i, 16, paperWidth, paperColor);
  }
  return p;
}

/** Replay a measured template analysis with new media: one image per shot,
 *  in order (cycles through `newMedia` when it's shorter than
 *  `analysis.shots`). Builds a fresh project at the analysis's comp
 *  size/fps/duration, places each media item into its shot's exact
 *  [startMs,endMs] slot with a Ken Burns motion derived from that shot's
 *  measured motion (when isStill), the shot's measured grade/vignette/fades,
 *  the matched transition at each boundary, and the given text beats — then
 *  commits and exports. The caller owns checkpointing/restoring the live
 *  project around this call (same convention as makeSyntheticReference in
 *  synthetic.ts). */
export async function rebuildFromAnalysis(
  analysis: TemplateAnalysis,
  newMedia: string[],
  io: RebuildIO,
  outPath: string
): Promise<RebuildResult> {
  if (newMedia.length === 0) throw new Error("rebuildFromAnalysis: newMedia is empty");

  await newProject();
  await setCompSize(analysis.width, analysis.height);
  await setCompFps(analysis.fps);
  await setCompDuration(analysis.durationMs);
  await io.importMedia(newMedia);

  let p = io.project();
  let mediaCursor = 0;
  const nextMediaIndex = () => mediaCursor++ % newMedia.length; // a running cursor, not i % newMedia.length — a 4-cell grid shot must not reuse one image 4x while others sit unused

  for (const [i, shot] of analysis.shots.entries()) {
    if (shot.elements && shot.elements.length > 0) {
      // Gate C's own path - a different detector from layout/regions below
      // (Rust analyze::layout vs this Python SAM pipeline), never combined
      // with it on the same shot. No cover-fit base layer, no nextMediaIndex
      // cycling - each element names its own newMedia index directly.
      p = await buildShotElements(shot, io, p);
      continue;
    }

    const regions = shot.layout && shot.layout.regions.length > 1 ? shot.layout.regions : null;

    if (regions) {
      let firstLayerId: number | null = null;
      for (const region of regions) {
        const layerId = await io.addMedia(nextMediaIndex()); // self-commits
        if (layerId < 0) throw new Error(`addMedia failed for shot ${shot.index} (a ${shot.layout!.kind} region)`);
        p = io.project();
        p = await setLayerRange(layerId, shot.startMs, shot.endMs);
        p = await placeRegion(layerId, shot, region, analysis.width, analysis.height, p);
        p = await applyFades(layerId, shot, p);
        p = await gradeShot(layerId, shot, p);
        firstLayerId ??= layerId;
      }
      if (i > 0 && firstLayerId !== null) {
        const trans = nearestTransition(analysis.transitions, shot.startMs);
        if (trans && trans.engine) p = await setLayerTransition(firstLayerId, "in", "dissolve", trans.durMs, 0, trans.engine);
      }
      continue;
    }

    const layerId = await io.addMedia(nextMediaIndex()); // self-commits
    if (layerId < 0) throw new Error(`addMedia failed for shot ${shot.index}`);
    p = io.project(); // fresh — addMedia already committed it

    p = await setLayerRange(layerId, shot.startMs, shot.endMs);

    const motioned = await animateMotion(layerId, shot, analysis.width, p);
    if (motioned) p = motioned;

    p = await applyFades(layerId, shot, p);
    p = await gradeShot(layerId, shot, p);

    if (i > 0) {
      const trans = nearestTransition(analysis.transitions, shot.startMs);
      if (trans && trans.engine) p = await setLayerTransition(layerId, "in", "dissolve", trans.durMs, 0, trans.engine);
    }
  }

  for (const beat of analysis.textBeats) {
    p = await addTextLayer(beat.content, beat.sizePx ?? 90);
    const textLayerId = p.layers[p.layers.length - 1].id;
    p = await setLayerRange(textLayerId, beat.startMs, beat.endMs);
  }

  for (const kt of analysis.kineticTitles ?? []) {
    p = await buildKineticTitle(kt, p);
  }

  for (const cs of analysis.cardStacks ?? []) {
    p = await buildCardStack(cs, nextMediaIndex(), analysis.width, analysis.height, io, p);
  }

  await io.commit(p); // sync ref/React state + resolveImages + redraw before capture
  const videoPath = await io.exportVideo(outPath, { format: "mp4", fps: analysis.fps });

  return { videoPath, project: p };
}
