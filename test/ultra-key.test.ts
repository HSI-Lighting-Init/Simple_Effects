import { describe, it, expect } from "vitest";
import { PRESETS, colorMatrix as refColorMatrix } from "../docs/ultra-key-reference.mjs";
import {
  ULTRA_KEY_PRESETS,
  ULTRA_KEY_TRACKS,
  ultraKeyPresetValues,
  ultraKeyValueMakesCustom,
  ultraKeyColorMatrix,
  ultraKeyUniforms,
  ultraKeyPasses,
  ultraKeyTrackValues,
  type UltraKeyResolved,
} from "../src/lib/ultraKey";

const resolved = (over: Partial<UltraKeyResolved> = {}): UltraKeyResolved => ({
  transparency: 45,
  highlight: 10,
  shadow: 50,
  tolerance: 50,
  pedestal: 10,
  choke: 0,
  soften: 0,
  contrast: 0,
  midPoint: 50,
  desaturate: 25,
  range: 50,
  spill: 50,
  luma: 50,
  saturation: 100,
  hue: 0,
  luminance: 100,
  keyColor: { r: 40, g: 200, b: 60, a: 255 },
  output: 0,
  setting: 0,
  ...over,
});

const near = (a: number, b: number, eps = 1e-5) => expect(Math.abs(a - b)).toBeLessThanOrEqual(eps);

describe("WP11 item 2: preset tables match the oracle", () => {
  it("ports every Premiere preset value verbatim", () => {
    expect(ULTRA_KEY_PRESETS.default).toEqual(PRESETS.default);
    expect(ULTRA_KEY_PRESETS.relaxed).toEqual(PRESETS.relaxed);
    expect(ULTRA_KEY_PRESETS.aggressive).toEqual(PRESETS.aggressive);
    expect(ULTRA_KEY_PRESETS.default).toHaveLength(13);
  });

  it("maps a Setting value to its values, and Custom has none", () => {
    expect(ultraKeyPresetValues(0)).toEqual(PRESETS.default);
    expect(ultraKeyPresetValues(1)).toEqual(PRESETS.relaxed);
    expect(ultraKeyPresetValues(2)).toEqual(PRESETS.aggressive);
    expect(ultraKeyPresetValues(3)).toBeNull();
  });

  it("flags a slider edit as Custom only when it differs from the registered default", () => {
    ULTRA_KEY_TRACKS.forEach((param, i) => {
      expect(ultraKeyValueMakesCustom(param, PRESETS.default[i])).toBe(false);
      expect(ultraKeyValueMakesCustom(param, PRESETS.default[i] + 1)).toBe(true);
    });
    expect(ultraKeyValueMakesCustom("saturation", 150)).toBe(false);
    expect(ultraKeyValueMakesCustom("keyColor", 0)).toBe(false);
  });

  it("returns the 13 preset-order values of a resolved effect", () => {
    expect(ultraKeyTrackValues(resolved())).toEqual(PRESETS.default);
    expect(ultraKeyTrackValues(resolved({ transparency: 60, range: 10 }))).toEqual([
      60, 10, 50, 50, 10, 0, 0, 0, 50, 25, 10, 50, 50,
    ]);
  });
});

describe("WP11 item 2: colour correction matches the oracle", () => {
  const cases = [
    { saturation: 1, hue: 0, luminance: 1 },
    { saturation: 1.5, hue: 30, luminance: 1.2 },
    { saturation: 0.4, hue: -75, luminance: 0.7 },
    { saturation: 2, hue: 180, luminance: 1 },
  ];
  for (const p of cases) {
    it(`colorMatrix(${JSON.stringify(p)})`, () => {
      const got = ultraKeyColorMatrix(p);
      const want = refColorMatrix(p);
      expect(got).toHaveLength(16);
      for (let i = 0; i < 16; i++) near(got[i], want[i], 1e-5);
    });
  }
});

describe("WP11 item 2: uniform precompute", () => {
  it("matches the reference gain/key-space formulas for the Default preset", () => {
    const u = ultraKeyUniforms(resolved());

    // gain: 45 -> 1/(2*0.45); 50 -> 1; 25 -> 1/(2*0.25)
    near(u.gT, 1 / 0.9);
    near(u.gR, 1);
    near(u.gD, 2);
    near(u.tol, 0.5);
    near(u.spill2, 1);
    near(u.luma2, 1);
    near(u.hi2, 0.2);
    near(u.sh2, 1);
    near(u.ped, 0.1);

    // key space: exact sRGB EOTF, then the Haeberli/luminance matrices.
    const lin = (v: number) => {
      const x = v / 255;
      return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    };
    const [r, g, b] = [lin(40), lin(200), lin(60)];
    const KX = 0.471405 * r - 0.235702 * g - 0.235702 * b;
    const KY = 0.408248 * g - 0.408248 * b;
    const KZ = 0.212671 * r + 0.71516 * g + 0.072169 * b;
    const kz = Math.max(KZ, 1e-30);
    const ku = KX / kz;
    const kv = KY / kz;
    near(u.ku, ku);
    near(u.kv, kv);
    near(u.kZ, KZ);
    near(u.invK, 1 / Math.sqrt(Math.max(ku * ku + kv * kv, 1e-30)));
  });

  it("uses the identity colour matrix at Premiere's defaults", () => {
    expect(ultraKeyUniforms(resolved()).cc).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
  });

  it("packs the colour-correction matrix column-major (the oracle's CC indexing)", () => {
    const u = ultraKeyUniforms(resolved({ saturation: 150, hue: 30, luminance: 120 }));
    const m = ultraKeyColorMatrix({ saturation: 1.5, hue: 30, luminance: 1.2 });
    expect(u.cc).toEqual([m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10], m[12], m[13], m[14]]);
  });

  it("clamps the transparency gain at 1e30 (never Infinity)", () => {
    const u = ultraKeyUniforms(resolved({ transparency: 0 }));
    expect(Number.isFinite(u.gT)).toBe(true);
    expect(u.gT).toBeLessThanOrEqual(1e30);
  });

  it("carries 2*Highlight / 2*Shadow / 2*Spill / 2*Luma", () => {
    const u = ultraKeyUniforms(resolved({ highlight: 15, shadow: 55, spill: 0.3 * 100, luma: 0.4 * 100 }));
    near(u.hi2, 0.3);
    near(u.sh2, 1.1);
    near(u.spill2, 0.6);
    near(u.luma2, 0.8);
  });

  it("forces Transparency to 0 for Color Channel output", () => {
    expect(ultraKeyUniforms(resolved({ transparency: 45, output: 2 })).gT).toBe(1e30);
    near(ultraKeyUniforms(resolved({ transparency: 45, output: 1 })).gT, 1 / 0.9);
  });
});

describe("WP4 phase 2: key → cleanup → final pass chain", () => {
  const names = (e: UltraKeyResolved, offset = 0, scale = 1) =>
    ultraKeyPasses(e, offset, scale).map((p) => p.name);

  it("key + final when Choke and Soften are zero", () => {
    const ps = ultraKeyPasses(resolved());
    expect(ps.map((p) => p.name)).toEqual(["ultraKey", "ultraKeyFinal"]);
    expect(ps[1].source).toBe(0);
    expect(ps[1].source2).toBeUndefined();
    expect(ps[1].uniforms?.u_cleanup).toEqual({ type: "1i", value: 0 });
  });

  it("runs Choke and Soften x/y and points the final at the last matte", () => {
    const ps = ultraKeyPasses(resolved({ choke: 30, soften: 40, contrast: 30 }));
    expect(ps.map((p) => p.name)).toEqual([
      "ultraKey",
      "ultraKeyChokeX",
      "ultraKeyChokeY",
      "ultraKeySoftenX",
      "ultraKeySoftenY",
      "ultraKeyFinal",
    ]);
    expect(ps[5].source).toBe(0);
    expect(ps[5].source2).toBe(4);
    expect(ps[5].uniforms?.u_cleanup).toEqual({ type: "1i", value: 1 });
    expect(ps[5].uniforms?.u_contrast).toEqual({ type: "1f", value: 0.3 });
    // Choke radius 4·(0.3+0.4) = 2.8 -> r=2, weight trunc(0.2·256)=51.
    expect(ps[1].uniforms?.u_r).toEqual({ type: "1i", value: 2 });
    expect(ps[2].uniforms?.u_w).toEqual({ type: "1i", value: 51 });
    // Soften radius 4·0.4 = 1.6 -> r=1, weight trunc(0.4·256)=102.
    expect(ps[3].uniforms?.u_r).toEqual({ type: "1i", value: 1 });
    expect(ps[4].uniforms?.u_w).toEqual({ type: "1i", value: 102 });
    expect(ps[5].uniforms?.u_output).toEqual({ type: "1i", value: 0 });
  });

  it("scales the radii by the preview downsample", () => {
    const full = ultraKeyPasses(resolved({ choke: 30, soften: 40, contrast: 30 }), 0, 1);
    const half = ultraKeyPasses(resolved({ choke: 30, soften: 40, contrast: 30 }), 0, 0.5);
    // 4·0.7 = 2.8 → 1.4 at 0.5 (r=1, trunc(0.6·256)=153); 4·0.4 = 1.6 → 0.8
    // (r=0, trunc(0.8·256)=204).
    expect(full[1].uniforms?.u_r).toEqual({ type: "1i", value: 2 });
    expect(half[1].uniforms?.u_r).toEqual({ type: "1i", value: 1 });
    expect(half[2].uniforms?.u_w).toEqual({ type: "1i", value: 153 });
    expect(half[3].uniforms?.u_r).toEqual({ type: "1i", value: 0 });
    expect(half[4].uniforms?.u_w).toEqual({ type: "1i", value: 204 });
    expect(names(resolved({ choke: 30, soften: 40 }), 0, 0.5)).toEqual(names(resolved({ choke: 30, soften: 40 })));
  });

  it("offsets the final pass's two sources when Ultra Key is not first in a run", () => {
    const ps = ultraKeyPasses(resolved({ choke: 30 }), 3);
    expect(ps.map((p) => p.name)).toEqual([
      "ultraKey",
      "ultraKeyChokeX",
      "ultraKeyChokeY",
      "ultraKeyFinal",
    ]);
    expect(ps[3].source).toBe(3);
    expect(ps[3].source2).toBe(5);
  });
});
