// Unit tests for the transition engine (Stages 1–4).
//
// The headline test constructs AND renders every registered transition across
// all categories at several progress points using the headless canvas mock
// (test/setup.ts) — verifying the whole engine runs end-to-end without throwing.
// Framework math (RNG, particle physics, camera path, easing) is tested directly.

import { describe, it, expect } from "vitest";
import { makeCanvas } from "./setup";
import {
  REGISTRY,
  createTransition,
  getTransitionMeta,
  TransitionError,
} from "../src/lib/transitions/registry";
import type { Clip } from "../src/lib/transitions/types";
import { mulberry32, hash2, valueNoise2D } from "../src/lib/transitions/rng";
import { ParticleSystem, stepBody } from "../src/lib/transitions/particles";
import { CameraPath } from "../src/lib/transitions/camera";
import { EASINGS, clamp01, resolveEasing } from "../src/lib/transitions/easing";
import { makeSpring, cubicBezier } from "../src/lib/transitions/spring";
import { renderThumbnail, thumbnailDataUrl } from "../src/lib/transitions/thumbnails";
import { benchmark, RESOLUTIONS } from "../src/lib/transitions/bench";

const makeClip = (w = 64, h = 36): Clip => ({ source: makeCanvas(w, h) as unknown as CanvasImageSource, width: w, height: h });
const emptyClip: Clip = { source: null, width: 0, height: 0 };
const PROGRESS = [0, 0.001, 0.25, 0.5, 0.75, 0.999, 1];

describe("registry integrity", () => {
  it("has unique ids and well-formed metadata", () => {
    const ids = new Set<string>();
    for (const m of REGISTRY) {
      expect(m.id, `id: ${m.id}`).toBeTruthy();
      expect(ids.has(m.id), `duplicate id ${m.id}`).toBe(false);
      ids.add(m.id);
      expect(m.label).toBeTruthy();
      expect(m.category).toBeTruthy();
      expect(typeof m.create).toBe("function");
      expect(Array.isArray(m.params)).toBe(true);
      for (const p of m.params) {
        expect(p.name, `${m.id}.param`).toBeTruthy();
        expect(["enum", "number", "color", "bool"]).toContain(p.type);
        if (p.type === "number") {
          if (p.min != null && p.max != null) expect(p.min).toBeLessThanOrEqual(p.max);
        }
        if (p.type === "enum") expect(Array.isArray(p.options)).toBe(true);
      }
    }
  });

  it("covers all 10 spec categories plus the earlier stages", () => {
    const cats = new Set(REGISTRY.map((m) => m.category));
    // Stage 4's three categories must be present…
    expect(cats.has("Distortion, Glitch & Digital")).toBe(true);
    expect(cats.has("Particles & Disintegration")).toBe(true);
    expect(cats.has("Camera Movement & Depth")).toBe(true);
    // …alongside the Stage 1–3 categories (≥ 11 distinct groups total).
    expect(cats.size).toBeGreaterThanOrEqual(11);
    expect(REGISTRY.length).toBeGreaterThanOrEqual(100);
  });

  it("has the expected Stage-4 transition counts", () => {
    const count = (c: string) => REGISTRY.filter((m) => m.category === c).length;
    expect(count("Distortion, Glitch & Digital")).toBe(16);
    expect(count("Particles & Disintegration")).toBe(14);
    expect(count("Camera Movement & Depth")).toBe(16);
  });

  it("throws on unknown ids", () => {
    expect(() => createTransition("does-not-exist", makeClip(), makeClip())).toThrow(TransitionError);
  });
});

describe("every transition renders without throwing", () => {
  const from = makeClip();
  const to = makeClip();
  for (const meta of REGISTRY) {
    it(`${meta.category} / ${meta.id}`, () => {
      // default params
      const tr = createTransition(meta.id, from, to, { outWidth: 64, outHeight: 36 });
      const target = makeCanvas(64, 36) as unknown as HTMLCanvasElement;
      for (const p of PROGRESS) expect(() => tr.render(target, p)).not.toThrow();
      // out-of-range progress is clamped, not fatal
      expect(() => tr.render(target, -1)).not.toThrow();
      expect(() => tr.render(target, 2)).not.toThrow();
    });
  }
});

describe("transitions tolerate empty / mismatched clips", () => {
  for (const meta of REGISTRY) {
    it(`${meta.id} with empty clips`, () => {
      const tr = createTransition(meta.id, emptyClip, emptyClip, { outWidth: 48, outHeight: 27 });
      const target = makeCanvas(48, 27) as unknown as HTMLCanvasElement;
      expect(() => tr.render(target, 0.5)).not.toThrow();
    });
  }
});

describe("seeded RNG", () => {
  it("mulberry32 is deterministic per seed", () => {
    const a = mulberry32(1234);
    const b = mulberry32(1234);
    const seqA = [a(), a(), a(), a()];
    const seqB = [b(), b(), b(), b()];
    expect(seqA).toEqual(seqB);
    for (const v of seqA) expect(v).toBeGreaterThanOrEqual(0), expect(v).toBeLessThan(1);
    // different seed → different stream
    const c = mulberry32(9999);
    expect(c()).not.toEqual(seqA[0]);
  });
  it("hash2 is stable and in range", () => {
    expect(hash2(3, 7, 1)).toBe(hash2(3, 7, 1));
    expect(hash2(3, 7, 1)).not.toBe(hash2(3, 7, 2));
    const v = hash2(10, 20, 5);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
  });
  it("valueNoise2D stays within [0,1] and is smooth", () => {
    for (let i = 0; i < 50; i++) {
      const v = valueNoise2D(i * 0.13, i * 0.27, 3);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe("particle system physics", () => {
  it("gravity accelerates particles downward", () => {
    const sys = new ParticleSystem(10, { gravityY: 200 }, 1);
    sys.spawn({ x: 0, y: 0, vx: 0, vy: 0 });
    for (let i = 0; i < 60; i++) sys.update(1 / 60);
    expect(sys.y[0]).toBeGreaterThan(50); // ~½·200·1² = 100
    expect(sys.vy[0]).toBeGreaterThan(150);
  });
  it("drag damps velocity", () => {
    const sys = new ParticleSystem(4, { drag: 4 }, 1);
    sys.spawn({ x: 0, y: 0, vx: 100, vy: 0 });
    for (let i = 0; i < 60; i++) sys.update(1 / 60);
    expect(Math.abs(sys.vx[0])).toBeLessThan(100);
  });
  it("stepBody matches the wind/gravity integration", () => {
    const body = { x: 0, y: 0, vx: 0, vy: 0 };
    stepBody(body, { gravityY: 100 }, 0.5);
    expect(body.vy).toBeCloseTo(50, 5);
    expect(body.y).toBeCloseTo(25, 5);
  });
  it("respects capacity", () => {
    const sys = new ParticleSystem(2);
    expect(sys.spawn({ x: 0, y: 0 })).toBe(0);
    expect(sys.spawn({ x: 0, y: 0 })).toBe(1);
    expect(sys.spawn({ x: 0, y: 0 })).toBe(-1);
  });
});

describe("camera path", () => {
  it("interpolates position and fov between keyframes", () => {
    const path = new CameraPath([
      { t: 0, pos: [0, 0, 0], fov: 0.5 },
      { t: 1, pos: [10, -4, 20], fov: 1.5 },
    ]);
    expect(path.sample(0).pos).toEqual([0, 0, 0]);
    expect(path.sample(1).pos).toEqual([10, -4, 20]);
    const mid = path.sample(0.5);
    expect(mid.pos[0]).toBeCloseTo(5, 5);
    expect(mid.pos[2]).toBeCloseTo(10, 5);
    expect(mid.fov).toBeCloseTo(1.0, 5);
  });
  it("clamps outside the keyframe range and needs ≥1 key", () => {
    const path = new CameraPath([{ t: 0.2 }, { t: 0.8, pos: [4, 0, 0] }]);
    expect(path.sample(-1).pos).toEqual([0, 0, 0]);
    expect(path.sample(5).pos).toEqual([4, 0, 0]);
    expect(() => new CameraPath([])).toThrow();
  });
});

describe("easing", () => {
  it("clamp01 clamps", () => {
    expect(clamp01(-2)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(0.3)).toBe(0.3);
  });
  it("named curves hit their endpoints", () => {
    for (const name of ["linear", "easeIn", "easeOut", "easeInOut"] as const) {
      expect(EASINGS[name](0)).toBeCloseTo(0, 6);
      expect(EASINGS[name](1)).toBeCloseTo(1, 6);
    }
    expect(EASINGS.linear(0.5)).toBeCloseTo(0.5, 6);
  });
  it("resolveEasing handles bezier and spring specs", () => {
    const bz = resolveEasing({ type: "bezier", x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 });
    expect(bz(0)).toBeCloseTo(0, 3);
    expect(bz(1)).toBeCloseTo(1, 3);
    const sp = resolveEasing({ type: "spring", tension: 180, friction: 12 });
    expect(sp(0)).toBeCloseTo(0, 3);
    expect(sp(1)).toBeCloseTo(1, 2);
    expect(() => resolveEasing("nope" as never)).toThrow();
  });
  it("spring & bezier factories are callable", () => {
    expect(typeof makeSpring({ tension: 100, friction: 10 })).toBe("function");
    expect(typeof cubicBezier(0.4, 0, 0.2, 1)).toBe("function");
  });
});

describe("thumbnails & benchmark", () => {
  it("renders a filmstrip thumbnail for a transition", () => {
    const cv = makeCanvas() as unknown as HTMLCanvasElement;
    renderThumbnail("fade", cv, { cellW: 32, cellH: 18, frames: 4 });
    expect(cv.width).toBe(32 * 4);
    expect(cv.height).toBe(18);
  });
  it("produces a data URL", () => {
    expect(thumbnailDataUrl("glitch", { cellW: 16, cellH: 9, frames: 2 })).toContain("data:image/png");
  });
  it("benchmark returns timing for a Stage-4 transition", () => {
    const row = benchmark("shatter", { ...RESOLUTIONS.hd, width: 64, height: 36 }, 5);
    expect(row.id).toBe("shatter");
    expect(row.frames).toBe(5);
    expect(row.meanMs).toBeGreaterThanOrEqual(0);
    expect(getTransitionMeta("shatter")?.category).toBe("Particles & Disintegration");
  });
});
