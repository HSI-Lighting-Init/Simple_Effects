import { describe, it, expect } from "vitest";
import { sampleTrack } from "../src/lib/track";
import type { Track } from "../src/bindings/Track";

// E1: bezier easing with overshoot. Mirrors the Rust-side tests in eval.rs —
// same control points, same expectations, since the two must stay in sync.
describe("sampleTrack bezier easing", () => {
  const overshoot = { bezier: { x1: 0.34, y1: 1.56, x2: 0.64, y2: 1.0 } } as const;

  it("starts and ends exactly at the keyframed values", () => {
    const t: Track = { default: 0, keys: [{ timeMs: 0, value: 0, easing: overshoot }, { timeMs: 1000, value: 100, easing: "linear" }] };
    expect(sampleTrack(t, 0)).toBe(0);
    expect(sampleTrack(t, 1000)).toBe(100);
  });

  it("overshoots past the target keyframe before settling, not clamped to it", () => {
    const t: Track = { default: 0, keys: [{ timeMs: 0, value: 0, easing: overshoot }, { timeMs: 1000, value: 100, easing: "linear" }] };
    let peak = 0;
    for (let ms = 0; ms <= 1000; ms += 25) peak = Math.max(peak, sampleTrack(t, ms));
    expect(peak).toBeGreaterThan(100);
  });

  it("degenerates to a straight line for cubic-bezier(0,0,1,1)", () => {
    const identity = { bezier: { x1: 0, y1: 0, x2: 1, y2: 1 } } as const;
    const t: Track = { default: 0, keys: [{ timeMs: 0, value: 0, easing: identity }, { timeMs: 1000, value: 100, easing: "linear" }] };
    expect(sampleTrack(t, 500)).toBeCloseTo(50, 1);
  });
});
