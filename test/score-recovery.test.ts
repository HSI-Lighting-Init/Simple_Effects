import { describe, it, expect } from "vitest";
import { scoreRecovery, scoreKeyframeFit } from "../src/lib/scoreRecovery";

/* eslint-disable @typescript-eslint/no-explicit-any */
const track = (v: number, keys: { timeMs: number; value: number; easing?: string }[] = []) => ({
  default: v,
  keys: keys.map((k) => ({ easing: "easeInOut", ...k })),
});

function layer(id: number, startMs: number, endMs: number, opts: Partial<{ x: any; y: any; scaleX: any; scaleY: any; rotation: any; opacity: any; kind: string }> = {}): any {
  return {
    id,
    name: `Layer ${id}`,
    startMs,
    endMs,
    hidden: false,
    attach: null,
    effects: [],
    transitionIn: null,
    transitionOut: null,
    kind: { kind: opts.kind ?? "image", src: `photo${id}.jpg`, width: 1920, height: 1080, crop: null },
    transform: {
      x: opts.x ?? track(540),
      y: opts.y ?? track(960),
      scaleX: opts.scaleX ?? track(1.5),
      scaleY: opts.scaleY ?? track(1.5),
      rotation: opts.rotation ?? track(0),
      opacity: opts.opacity ?? track(1),
      anchorX: 0.5,
      anchorY: 0.5,
    },
  };
}

function project(layers: any[]): any {
  return { width: 1080, height: 1920, fps: 30, durationMs: 8000, media: [], layers };
}

describe("scoreRecovery", () => {
  it("scores an exact copy as a perfect match", () => {
    const truth = project([layer(1, 0, 2000), layer(2, 2000, 4000)]);
    const recovered = JSON.parse(JSON.stringify(truth));
    const r = scoreRecovery(truth, recovered);
    expect(r.matched).toBe(2);
    expect(r.missed).toBe(0);
    expect(r.extra).toBe(0);
    expect(r.meanPositionErrorPx).toBe(0);
    expect(r.meanScaleErrorPct).toBe(0);
    expect(r.meanRotationErrorDeg).toBe(0);
  });

  it("reports a position error at the magnitude actually introduced", () => {
    const truth = project([layer(1, 0, 2000, { x: track(540) })]);
    const recovered = project([layer(1, 0, 2000, { x: track(550) })]); // +10px, constant
    const r = scoreRecovery(truth, recovered);
    expect(r.matched).toBe(1);
    expect(r.layers[0].positionErrorPx).toBeCloseTo(10, 5);
  });

  it("reports a scale error as a percentage of the truth value", () => {
    const truth = project([layer(1, 0, 2000, { scaleX: track(2.0), scaleY: track(2.0) })]);
    const recovered = project([layer(1, 0, 2000, { scaleX: track(2.2), scaleY: track(2.2) })]); // +10%
    const r = scoreRecovery(truth, recovered);
    expect(r.layers[0].scaleErrorPct).toBeCloseTo(10, 5);
  });

  it("samples across the whole span, not just the endpoints (catches a mid-shot punch-in miss)", () => {
    // Truth punches in to 3.0 at the midpoint and back to 1.5 at both ends;
    // "recovered" misses the punch-in entirely (flat 1.5) — endpoints alone
    // would score this as a perfect match.
    const truth = project([
      layer(1, 0, 2000, { scaleX: track(1.5, [{ timeMs: 0, value: 1.5 }, { timeMs: 1000, value: 3.0 }, { timeMs: 2000, value: 1.5 }]) }),
    ]);
    const recovered = project([layer(1, 0, 2000, { scaleX: track(1.5) })]);
    const r = scoreRecovery(truth, recovered);
    expect(r.layers[0].scaleErrorPct).toBeGreaterThan(20); // catches the miss mid-span
  });

  it("counts a truth layer with no time-overlapping match as missed", () => {
    const truth = project([layer(1, 0, 2000), layer(2, 2000, 4000)]);
    const recovered = project([layer(1, 0, 2000)]); // shot 2 never recovered
    const r = scoreRecovery(truth, recovered);
    expect(r.matched).toBe(1);
    expect(r.missed).toBe(1);
    expect(r.extra).toBe(0);
  });

  it("counts a recovered layer with no truth counterpart as extra (hallucinated)", () => {
    const truth = project([layer(1, 0, 2000)]);
    const recovered = project([layer(1, 0, 2000), layer(2, 2000, 4000)]); // a shot that was never really there
    const r = scoreRecovery(truth, recovered);
    expect(r.matched).toBe(1);
    expect(r.missed).toBe(0);
    expect(r.extra).toBe(1);
  });

  it("reports start/end timing error in ms", () => {
    const truth = project([layer(1, 1000, 3000)]);
    const recovered = project([layer(1, 1050, 3050)]); // cut detected 50ms late both ends
    const r = scoreRecovery(truth, recovered);
    expect(r.matched).toBe(1);
    expect(r.layers[0].startMsError).toBe(50);
    expect(r.layers[0].endMsError).toBe(50);
  });

  it("never matches across different layer kinds", () => {
    const truth = project([layer(1, 0, 2000, { kind: "image" })]);
    const recovered = project([layer(1, 0, 2000, { kind: "video" })]);
    const r = scoreRecovery(truth, recovered);
    expect(r.matched).toBe(0);
    expect(r.missed).toBe(1);
    expect(r.extra).toBe(1);
  });
});

describe("scoreKeyframeFit", () => {
  const k = (timeMs: number, value: number, easing: any = "easeInOut") => ({ timeMs, value, easing });

  it("scores an exact match as zero error, full easing accuracy", () => {
    const truth = [k(0, 1.0, "linear"), k(1000, 1.3, "easeOut"), k(2000, 1.1, "linear")];
    const fitted = [k(0, 1.0, "linear"), k(1000, 1.3, "easeOut"), k(2000, 1.1, "hold")]; // last key's easing is don't-care
    const r = scoreKeyframeFit(truth, fitted, 100);
    expect(r.missed).toBe(0);
    expect(r.meanTimeErrorMs).toBe(0);
    expect(r.meanValueError).toBe(0);
    expect(r.easingAccuracy).toBe(1); // last key excluded, both middle keys correct
  });

  it("matches a key a couple frames off within tolerance, reports the real error", () => {
    const truth = [k(0, 1.0), k(1000, 1.3)];
    const fitted = [k(0, 1.0), k(1033, 1.32)]; // 1 frame off at 30fps, small value drift
    const r = scoreKeyframeFit(truth, fitted, 100);
    expect(r.missed).toBe(0);
    expect(r.meanTimeErrorMs).toBeCloseTo(33 / 2, 5); // averaged with the exact t=0 match
    const secondMatch = r.matches[1];
    expect(secondMatch.timeErrorMs).toBe(33);
    expect(secondMatch.valueError).toBeCloseTo(0.02, 5);
  });

  it("counts a truth key with nothing nearby as missed, not force-matched", () => {
    const truth = [k(0, 1.0), k(1000, 1.3)];
    const fitted = [k(0, 1.0)]; // fitter collapsed to a straight line, no key near 1000
    const r = scoreKeyframeFit(truth, fitted, 100);
    expect(r.missed).toBe(1);
    expect(r.matches[1].matchedTimeMs).toBeNull();
    expect(r.matches[1].easingCorrect).toBeNull();
  });

  it("scores a bezier-vs-bezier match as easing-correct regardless of exact control points", () => {
    const truth = [k(0, 1.0, { bezier: { x1: 0.34, y1: 1.56, x2: 0.64, y2: 1.0 } }), k(1000, 1.3, "linear")];
    const fitted = [k(0, 1.0, { bezier: { x1: 0.3, y1: 1.5, x2: 0.6, y2: 0.95 } }), k(1000, 1.3, "linear")];
    const r = scoreKeyframeFit(truth, fitted, 100);
    expect(r.matches[0].easingCorrect).toBe(true); // same KIND (bezier), params not compared
  });

  it("scores a wrong easing kind as incorrect", () => {
    // Only t=0 is easing-rated (t=1000 is the last key, excluded); it's the
    // only mismatch, so accuracy is 0/1, not diluted by the excluded key.
    const truth = [k(0, 1.0, "easeOut"), k(1000, 1.3, "linear")];
    const fitted = [k(0, 1.0, "linear"), k(1000, 1.3, "linear")];
    const r = scoreKeyframeFit(truth, fitted, 100);
    expect(r.matches[0].easingCorrect).toBe(false);
    expect(r.easingAccuracy).toBe(0);
  });
});
