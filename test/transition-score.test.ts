import { describe, it, expect } from "vitest";
import {
  frameSimilarity,
  rankTransitions,
  type FrameBuffer,
  type TransitionCandidate,
} from "../src/lib/transitionScore";

/** Build an RGBA FrameBuffer from a per-pixel luminance function (values are
 *  clamped 0..255 by Uint8ClampedArray on assignment). */
function makeFrame(width: number, height: number, valueAt: (x: number, y: number) => number): FrameBuffer {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = valueAt(x, y);
      const idx = (y * width + x) * 4;
      data[idx] = v;
      data[idx + 1] = v;
      data[idx + 2] = v;
      data[idx + 3] = 255;
    }
  }
  return { width, height, data, channels: 4 };
}

// Deterministic textured pattern (not a solid color / flat gradient) so SSIM
// has real local structure to compare.
const textured = (x: number, y: number) => 128 + 127 * Math.sin(x * 0.3) * Math.cos(y * 0.2);

// Deterministic per-pixel jitter in [-5, 5], not Math.random.
const jitter = (x: number, y: number) => ((x * 7 + y * 13) % 11) - 5;

describe("frameSimilarity", () => {
  it("scores an exact copy as ~1.0", () => {
    const a = makeFrame(64, 64, textured);
    const b = makeFrame(64, 64, textured);
    expect(frameSimilarity(a, b)).toBeCloseTo(1, 5);
  });

  it("scores solid black vs solid white well below 1, clearly separated from identical", () => {
    const black = makeFrame(32, 32, () => 0);
    const black2 = makeFrame(32, 32, () => 0);
    const white = makeFrame(32, 32, () => 255);
    expect(frameSimilarity(black, black2)).toBeCloseTo(1, 5);
    expect(frameSimilarity(black, white)).toBeLessThan(0.3);
  });

  it("scores two different checkerboard patterns well below 1", () => {
    const checkerA = makeFrame(32, 32, (x, y) => ((x + y) % 2 === 0 ? 255 : 0));
    const checkerB = makeFrame(32, 32, (x, y) => ((x + y) % 2 === 0 ? 0 : 255)); // inverted phase
    expect(frameSimilarity(checkerA, checkerB)).toBeLessThan(0.3);
  });

  it("stays high under small deterministic pixel jitter", () => {
    const a = makeFrame(64, 64, textured);
    const jittered = makeFrame(64, 64, (x, y) => textured(x, y) + jitter(x, y));
    expect(frameSimilarity(a, jittered)).toBeGreaterThan(0.9);
  });

  it("drops meaningfully for a real structural difference (inversion), well below the jitter case", () => {
    const a = makeFrame(64, 64, textured);
    const jittered = makeFrame(64, 64, (x, y) => textured(x, y) + jitter(x, y));
    const inverted = makeFrame(64, 64, (x, y) => 255 - textured(x, y));

    const jitterScore = frameSimilarity(a, jittered);
    const invertScore = frameSimilarity(a, inverted);
    expect(invertScore).toBeLessThan(0.6);
    expect(invertScore).toBeLessThan(jitterScore - 0.3);
  });
});

describe("rankTransitions", () => {
  it("ranks exact > close > far with exact scoring highest", () => {
    const progressPoints = [0.25, 0.5, 0.75];
    const shape = (p: number) => (x: number, y: number) => 128 + 127 * Math.sin((x + p * 50) * 0.3) * Math.cos(y * 0.2);

    const observed = progressPoints.map((p) => ({ progress: p, frame: makeFrame(32, 32, shape(p)) }));

    const exact: TransitionCandidate = {
      id: "exact",
      frames: progressPoints.map((p) => ({ progress: p, frame: makeFrame(32, 32, shape(p)) })),
    };
    const close: TransitionCandidate = {
      id: "close",
      frames: progressPoints.map((p) => ({
        progress: p,
        frame: makeFrame(32, 32, (x, y) => shape(p)(x, y) + jitter(x, y)),
      })),
    };
    const far: TransitionCandidate = {
      id: "far",
      frames: progressPoints.map((p) => ({
        progress: p,
        frame: makeFrame(32, 32, (x, y) => 255 - shape(p)(x, y)),
      })),
    };

    // Feed candidates in a shuffled order — ranking, not input order, should decide.
    const ranked = rankTransitions(observed, [far, close, exact]);

    expect(ranked.map((r) => r.id)).toEqual(["exact", "close", "far"]);
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
    expect(ranked[1].score).toBeGreaterThan(ranked[2].score);
  });

  it("matches candidate frames to observed frames by nearest progress, without throwing", () => {
    const observed = [0.25, 0.5, 0.75].map((p) => ({ progress: p, frame: makeFrame(16, 16, textured) }));
    const offsetCandidate: TransitionCandidate = {
      id: "offset",
      frames: [0.24, 0.51, 0.76].map((p) => ({ progress: p, frame: makeFrame(16, 16, textured) })),
    };

    expect(() => rankTransitions(observed, [offsetCandidate])).not.toThrow();

    const ranked = rankTransitions(observed, [offsetCandidate]);
    expect(ranked).toHaveLength(1);
    // Same underlying content at every progress point — only the labels are
    // off — so the nearest-progress match should still score near-perfect.
    expect(ranked[0].score).toBeGreaterThan(0.9);
  });
});
