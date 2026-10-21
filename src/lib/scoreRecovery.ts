// Phase 1.2 (roadmap docs/TEMPLATE_EXTRACTOR_ROADMAP.md §6): score_recovery(truth,
// recovered) matches layers by kind, time and overlap, and reports per-parameter
// errors. Every later phase's "done when" numbers (Phase 2's position/scale/rotation
// tolerances etc.) are stated against this function. Pure, no I/O — testable under
// vitest with hand-built fixtures, independent of whatever the real recovery pipeline
// (Phase 2+) eventually looks like.
import type { Project } from "../bindings/Project";
import type { Layer } from "../bindings/Layer";
import type { Keyframe } from "../bindings/Keyframe";
import type { Easing } from "../bindings/Easing";
import { sampleTrack } from "./track";

/** How many times across the matched overlap to sample each track — errors are
 *  the max over these samples, not just the endpoints (a bad mid-shot punch-in
 *  key would otherwise hide behind two correct endpoints). */
const SAMPLES = 5;
/** Minimum IoU of [startMs,endMs] to count as the same shot at all. */
const MIN_IOU = 0.3;

export interface LayerMatch {
  truthLayerId: number;
  truthName: string;
  /** null = no recovered layer matched this truth layer (missed). */
  recoveredLayerId: number | null;
  overlapMs: number;
  startMsError: number;
  endMsError: number;
  /** Max over SAMPLES points across the overlap. */
  positionErrorPx: number;
  scaleErrorPct: number;
  rotationErrorDeg: number;
  opacityError: number;
}

export interface ScoreReport {
  truthLayers: number;
  matched: number;
  /** Truth layers with no acceptable match. */
  missed: number;
  /** Recovered layers matched to nothing in truth — hallucinated content. */
  extra: number;
  layers: LayerMatch[];
  meanPositionErrorPx: number | null;
  meanScaleErrorPct: number | null;
  meanRotationErrorDeg: number | null;
  meanOpacityError: number | null;
  meanStartMsError: number | null;
  meanEndMsError: number | null;
}

function coarseKind(l: Layer): string {
  return l.kind.kind;
}

function overlapOf(a: Layer, b: Layer): number {
  return Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));
}

/** Greedy best-IoU matching, same coarse kind only, one-to-one. Good enough
 *  while there's no real ambiguity (sequential, mostly non-overlapping
 *  background shots) — role-based matching (once "role" exists, Phase 3) can
 *  replace this without changing the error metrics below. */
function matchLayers(truth: Layer[], recovered: Layer[]): Map<number, Layer | null> {
  const candidates: { t: Layer; r: Layer; iou: number }[] = [];
  for (const t of truth) {
    for (const r of recovered) {
      if (coarseKind(t) !== coarseKind(r)) continue;
      const inter = overlapOf(t, r);
      if (inter <= 0) continue;
      const union = Math.max(t.endMs, r.endMs) - Math.min(t.startMs, r.startMs);
      candidates.push({ t, r, iou: inter / Math.max(1, union) });
    }
  }
  candidates.sort((a, b) => b.iou - a.iou);
  const usedR = new Set<number>();
  const usedT = new Set<number>();
  const result = new Map<number, Layer | null>();
  for (const c of candidates) {
    if (usedT.has(c.t.id) || usedR.has(c.r.id) || c.iou < MIN_IOU) continue;
    result.set(c.t.id, c.r);
    usedT.add(c.t.id);
    usedR.add(c.r.id);
  }
  for (const t of truth) if (!result.has(t.id)) result.set(t.id, null);
  return result;
}

export function scoreRecovery(truth: Project, recovered: Project): ScoreReport {
  const truthLayers = truth.layers.filter((l) => l.kind.kind === "image" || l.kind.kind === "video");
  const recoveredLayers = recovered.layers.filter((l) => l.kind.kind === "image" || l.kind.kind === "video");
  const matches = matchLayers(truthLayers, recoveredLayers);

  const layers: LayerMatch[] = truthLayers.map((t) => {
    const r = matches.get(t.id) ?? null;
    if (!r) {
      return {
        truthLayerId: t.id,
        truthName: t.name,
        recoveredLayerId: null,
        overlapMs: 0,
        startMsError: NaN,
        endMsError: NaN,
        positionErrorPx: NaN,
        scaleErrorPct: NaN,
        rotationErrorDeg: NaN,
        opacityError: NaN,
      };
    }
    const lo = Math.max(t.startMs, r.startMs);
    const hi = Math.min(t.endMs, r.endMs);
    let posErr = 0;
    let scaleErr = 0;
    let rotErr = 0;
    let opErr = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const tMs = lo + ((hi - lo) * i) / Math.max(1, SAMPLES - 1);
      const tx = sampleTrack(t.transform.x, tMs);
      const ty = sampleTrack(t.transform.y, tMs);
      const rx = sampleTrack(r.transform.x, tMs);
      const ry = sampleTrack(r.transform.y, tMs);
      posErr = Math.max(posErr, Math.hypot(tx - rx, ty - ry));
      const tsx = sampleTrack(t.transform.scaleX, tMs);
      const rsx = sampleTrack(r.transform.scaleX, tMs);
      scaleErr = Math.max(scaleErr, Math.abs((rsx - tsx) / (tsx || 1)) * 100);
      const trot = sampleTrack(t.transform.rotation, tMs);
      const rrot = sampleTrack(r.transform.rotation, tMs);
      rotErr = Math.max(rotErr, Math.abs(trot - rrot));
      const top = sampleTrack(t.transform.opacity, tMs);
      const rop = sampleTrack(r.transform.opacity, tMs);
      opErr = Math.max(opErr, Math.abs(top - rop));
    }
    return {
      truthLayerId: t.id,
      truthName: t.name,
      recoveredLayerId: r.id,
      overlapMs: hi - lo,
      startMsError: r.startMs - t.startMs,
      endMsError: r.endMs - t.endMs,
      positionErrorPx: posErr,
      scaleErrorPct: scaleErr,
      rotationErrorDeg: rotErr,
      opacityError: opErr,
    };
  });

  const matched = layers.filter((l) => l.recoveredLayerId != null);
  const mean = (f: (l: LayerMatch) => number): number | null =>
    matched.length ? matched.reduce((s, l) => s + f(l), 0) / matched.length : null;

  return {
    truthLayers: truthLayers.length,
    matched: matched.length,
    missed: layers.length - matched.length,
    extra: recoveredLayers.length - matched.length,
    layers,
    meanPositionErrorPx: mean((l) => l.positionErrorPx),
    meanScaleErrorPct: mean((l) => l.scaleErrorPct),
    meanRotationErrorDeg: mean((l) => l.rotationErrorDeg),
    meanOpacityError: mean((l) => l.opacityError),
    meanStartMsError: mean((l) => Math.abs(l.startMsError)),
    meanEndMsError: mean((l) => Math.abs(l.endMsError)),
  };
}

/** 2.5's own "done when" scoring: how well does a FITTED keyframe track (e.g.
 *  from `fit_background`, already composed into this channel's absolute
 *  units by the caller — px for x/y, a scale factor for scaleX/scaleY,
 *  degrees for rotation) reproduce the TRUTH track's own keyframes? Matches
 *  each truth key to its nearest fitted key by time (keyframes are points,
 *  not intervals — no IoU here) within `matchToleranceMs`; a truth key with
 *  nothing fitted inside that window counts as missed. Phase 2's actual
 *  done-when numbers (scale ≤1%, position ≤2px@1080p, rotation ≤0.3°, key
 *  times ±2 frames, easing correct ≥80%) are read off this, not eyeballed. */
export interface KeyframeMatch {
  truthTimeMs: number;
  truthValue: number;
  truthEasing: Easing;
  /** The truth track's own last key never starts a segment, so its easing
   *  is unused/don't-care in this engine's model — excluded from
   *  `easingAccuracy` (still scored on time/value). */
  isLastKey: boolean;
  matchedTimeMs: number | null;
  timeErrorMs: number | null;
  valueError: number | null;
  easingCorrect: boolean | null;
}

export interface KeyframeFitReport {
  matches: KeyframeMatch[];
  missed: number;
  meanTimeErrorMs: number | null;
  meanValueError: number | null;
  /** Fraction of non-last, matched keys whose fitted easing KIND (linear/
   *  easeIn/easeOut/easeInOut/hold/bezier) matches truth's — bezier control
   *  points aren't compared, only the shape family, matching how the
   *  roadmap states this criterion ("easing correct"). */
  easingAccuracy: number | null;
}

function easingKind(e: Easing): string {
  return typeof e === "string" ? e : "bezier";
}

export function scoreKeyframeFit(truthKeys: Keyframe[], fittedKeys: Keyframe[], matchToleranceMs: number): KeyframeFitReport {
  const lastTruthMs = truthKeys.length ? Math.max(...truthKeys.map((k) => k.timeMs)) : null;

  const matches: KeyframeMatch[] = truthKeys.map((t) => {
    let best: Keyframe | null = null;
    let bestDist = Infinity;
    for (const f of fittedKeys) {
      const d = Math.abs(f.timeMs - t.timeMs);
      if (d < bestDist) {
        bestDist = d;
        best = f;
      }
    }
    const isLastKey = t.timeMs === lastTruthMs;
    if (!best || bestDist > matchToleranceMs) {
      return { truthTimeMs: t.timeMs, truthValue: t.value, truthEasing: t.easing, isLastKey, matchedTimeMs: null, timeErrorMs: null, valueError: null, easingCorrect: null };
    }
    return {
      truthTimeMs: t.timeMs,
      truthValue: t.value,
      truthEasing: t.easing,
      isLastKey,
      matchedTimeMs: best.timeMs,
      timeErrorMs: best.timeMs - t.timeMs,
      valueError: best.value - t.value,
      easingCorrect: isLastKey ? null : easingKind(best.easing) === easingKind(t.easing),
    };
  });

  const found = matches.filter((m) => m.matchedTimeMs != null);
  const mean = (f: (m: KeyframeMatch) => number): number | null =>
    found.length ? found.reduce((s, m) => s + f(m), 0) / found.length : null;
  const easingRated = found.filter((m) => m.easingCorrect != null);

  return {
    matches,
    missed: matches.length - found.length,
    meanTimeErrorMs: mean((m) => Math.abs(m.timeErrorMs!)),
    meanValueError: mean((m) => Math.abs(m.valueError!)),
    easingAccuracy: easingRated.length ? easingRated.filter((m) => m.easingCorrect).length / easingRated.length : null,
  };
}
