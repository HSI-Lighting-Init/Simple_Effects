import { describe, it, expect } from "vitest";
import type { Rgba } from "../src/bindings/Rgba";
import {
  averageRgbaLinear,
  localToSourcePixel,
  type LocalPickSource,
} from "../src/lib/keyPick";

const src = (over: Partial<LocalPickSource> = {}): LocalPickSource => ({
  crop: null,
  nativeWidth: 200,
  nativeHeight: 100,
  drawWidth: 200,
  drawHeight: 100,
  ...over,
});

const sample = (r: number, g: number, b: number): Rgba => ({ r, g, b, a: 255 });

describe("WP5: Konva local → source-pixel mapping", () => {
  it("maps local pixels when the node draws at the native size", () => {
    expect(localToSourcePixel(100.5, 50.5, src())).toEqual({ x: 100, y: 50 });
  });

  it("maps a cropped image through its crop origin", () => {
    const s = src({
      crop: { x: 300, y: 200, width: 100, height: 50 },
      nativeWidth: 800,
      nativeHeight: 600,
      drawWidth: 100,
      drawHeight: 50,
    });
    // Local (50.5, 25.5) → source (350.5, 225.5) → pixel (350, 225).
    expect(localToSourcePixel(50.5, 25.5, s)).toEqual({ x: 350, y: 225 });
  });

  it("maps a preview-capped draw size to the ORIGINAL source pixel", () => {
    // A 4000×3000 source drawn at 1000×750 (the cap); the mapping still
    // returns the original 4000×3000 pixel, not the capped texture pixel.
    const s = src({
      nativeWidth: 4000,
      nativeHeight: 3000,
      drawWidth: 1000,
      drawHeight: 750,
    });
    expect(localToSourcePixel(500, 375, s)).toEqual({ x: 2000, y: 1500 });
    expect(localToSourcePixel(999, 749, s)).toEqual({ x: 3996, y: 2996 });
  });

  it("scales when the node size differs from the native source size", () => {
    const s = src({
      nativeWidth: 800,
      nativeHeight: 600,
      drawWidth: 400,
      drawHeight: 300,
    });
    expect(localToSourcePixel(200, 150, s)).toEqual({ x: 400, y: 300 });
  });

  it("returns null outside the drawn content or for degenerate sizes", () => {
    expect(localToSourcePixel(-1, 10, src())).toBeNull();
    expect(localToSourcePixel(200, 10, src())).toBeNull();
    expect(localToSourcePixel(10, 100, src())).toBeNull();
    expect(localToSourcePixel(10, 10, src({ drawWidth: 0 }))).toBeNull();
    expect(localToSourcePixel(10, 10, src({ nativeWidth: 0 }))).toBeNull();
    expect(
      localToSourcePixel(10, 10, src({ crop: { x: 0, y: 0, width: 0, height: 10 } }))
    ).toBeNull();
  });
});

describe("WP5: Ctrl/Cmd 5×5 average in linear light", () => {
  it("averages 13 black + 12 white to 184, not the sRGB mean 122", () => {
    const samples = [
      ...Array.from({ length: 13 }, () => sample(0, 0, 0)),
      ...Array.from({ length: 12 }, () => sample(255, 255, 255)),
    ];
    // Linear mean = 12/25 = 0.48. sRGB encode = 1.055·0.48^(1/2.4) − 0.055
    // = 0.7216… → 184. The naive sRGB mean would be (12/25)·255 = 122.
    expect(averageRgbaLinear(samples)).toEqual({ r: 184, g: 184, b: 184, a: 255 });
  });

  it("averages channels independently (24 blue + 1 black → 250)", () => {
    const samples = [
      ...Array.from({ length: 24 }, () => sample(0, 0, 255)),
      sample(0, 0, 0),
    ];
    // Blue linear mean = 24/25 = 0.96 → 250.46 → 250; red/green stay 0.
    expect(averageRgbaLinear(samples)).toEqual({ r: 0, g: 0, b: 250, a: 255 });
  });

  it("round-trips a uniform colour exactly", () => {
    const same = Array.from({ length: 25 }, () => sample(12, 200, 60));
    expect(averageRgbaLinear(same)).toEqual(sample(12, 200, 60));
    expect(averageRgbaLinear(Array.from({ length: 25 }, () => sample(128, 128, 128)))).toEqual(
      sample(128, 128, 128)
    );
    expect(averageRgbaLinear([sample(0, 0, 0)])).toEqual(sample(0, 0, 0));
  });
});
