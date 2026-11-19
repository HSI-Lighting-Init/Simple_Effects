// Ultra Key (Premiere Pro 2023) — CPU-side precompute for the GLSL key pass and
// its matte-cleanup chain, plus Premiere's preset tables. The maths is a
// line-by-line port of docs/ultra-key-reference.mjs (the oracle); the fragment
// shaders are src/shaders/ultraKey*.frag.
//
// Sliders are stored in Premiere's UI units (0..100, or the CC ranges); the
// uniforms are converted here. Presets are UI data only: picking one writes the
// 13 keying sliders and stores `setting` (0 Default · 1 Relaxed · 2 Aggressive ·
// 3 Custom).
import fragSrc from "../shaders/ultraKey.frag?raw";
import chokeXFrag from "../shaders/ultraKeyChokeX.frag?raw";
import chokeYFrag from "../shaders/ultraKeyChokeY.frag?raw";
import softenXFrag from "../shaders/ultraKeySoftenX.frag?raw";
import softenYFrag from "../shaders/ultraKeySoftenY.frag?raw";
import finalFrag from "../shaders/ultraKeyFinal.frag?raw";
import type { Rgba } from "../bindings/Rgba";
import { registerGpuProgram, runPasses, type GpuPass } from "./gpuFx";
import type { Texture } from "./surface3d";

/** The 13 sliders a Setting preset writes, in Premiere's preset-table order. */
export const ULTRA_KEY_TRACKS = [
  "transparency",
  "highlight",
  "shadow",
  "tolerance",
  "pedestal",
  "choke",
  "soften",
  "contrast",
  "midPoint",
  "desaturate",
  "range",
  "spill",
  "luma",
] as const;
export type UltraKeyTrack = (typeof ULTRA_KEY_TRACKS)[number];

export const ULTRA_KEY_PRESETS = {
  default: [45, 10, 50, 50, 10, 0, 0, 0, 50, 25, 50, 50, 50],
  relaxed: [50, 15, 50, 0, 0, 0, 0, 0, 50, 10, 50, 50, 50],
  aggressive: [40, 10, 55, 90, 50, 10, 10, 10, 50, 50, 50, 50, 50],
} as const;

/** The registered default of each preset-track (the Default preset). */
export const ULTRA_KEY_DEFAULTS: readonly number[] = ULTRA_KEY_PRESETS.default;

/** Preset values for a Setting (0/1/2), or null for Custom (3). */
export function ultraKeyPresetValues(setting: number): readonly number[] | null {
  if (setting === 0) return ULTRA_KEY_PRESETS.default;
  if (setting === 1) return ULTRA_KEY_PRESETS.relaxed;
  if (setting === 2) return ULTRA_KEY_PRESETS.aggressive;
  return null;
}

/** True when editing `param` to `value` should flip Setting to Custom. */
export function ultraKeyValueMakesCustom(param: string, value: number): boolean {
  const i = ULTRA_KEY_TRACKS.indexOf(param as UltraKeyTrack);
  if (i < 0) return false;
  return value !== ULTRA_KEY_DEFAULTS[i];
}

/** The 13 preset-order slider values of a resolved Ultra Key effect. */
export function ultraKeyTrackValues(e: UltraKeyResolved): number[] {
  return [
    e.transparency,
    e.highlight,
    e.shadow,
    e.tolerance,
    e.pedestal,
    e.choke,
    e.soften,
    e.contrast,
    e.midPoint,
    e.desaturate,
    e.range,
    e.spill,
    e.luma,
  ];
}

// ---- colour correction (4x4 row-vector matrices, from the reference) --------
const W = [0.212671, 0.71516, 0.072169];
const mul = (A: number[], B: number[]) => {
  const C = new Array<number>(16);
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += B[i * 4 + k] * A[k * 4 + j];
      C[i * 4 + j] = s;
    }
  return C;
};
const I4 = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function hueMatrix(M: number[], deg: number): number[] {
  const c = 0.70710677, s = 0.70710677, cy = 0.8164966, sy = 0.57735026;
  let T = I4();
  T = mul([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1], T);
  T = mul([cy, 0, sy, 0, 0, 1, 0, 0, -sy, 0, cy, 0, 0, 0, 0, 1], T);
  const lz = W[0] * T[2] + W[1] * T[6] + W[2] * T[10] + T[14];
  const zsx = (W[0] * T[0] + W[1] * T[4] + W[2] * T[8] + T[12]) / lz;
  const zsy = (W[0] * T[1] + W[1] * T[5] + W[2] * T[9] + T[13]) / lz;
  T = mul([1, 0, zsx, 0, 0, 1, zsy, 0, 0, 0, 1, 0, 0, 0, 0, 1], T);
  const a = (deg * Math.PI) / 180, sa = Math.sin(a), ca = Math.cos(a);
  T = mul([ca, sa, 0, 0, -sa, ca, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], T);
  T = mul([1, 0, -zsx, 0, 0, 1, -zsy, 0, 0, 0, 1, 0, 0, 0, 0, 1], T);
  T = mul([cy, 0, -sy, 0, 0, 1, 0, 0, sy, 0, cy, 0, 0, 0, 0, 1], T);
  T = mul([1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1], T);
  return mul(T, M);
}

/** Premiere's Saturation → Hue → Luminance matrix, in linear RGB. */
export function ultraKeyColorMatrix({
  saturation = 1,
  hue = 0,
  luminance = 1,
}: {
  saturation?: number;
  hue?: number;
  luminance?: number;
}): number[] {
  let M = I4();
  if (saturation !== 1) {
    const t = 1 - saturation, r = t * W[0], g = t * W[1], b = t * W[2];
    M = mul(
      [r + saturation, r, r, 0, g, g + saturation, g, 0, b, b, b + saturation, 0, 0, 0, 0, 1],
      M
    );
  }
  if (hue !== 0) M = hueMatrix(M, hue);
  const gR = Math.pow(luminance, 2.2);
  return mul([gR, 0, 0, 0, 0, gR, 0, 0, 0, 0, gR, 0, 0, 0, 0, 1], M);
}

// ---- uniform precompute ------------------------------------------------------
export interface UltraKeyResolved {
  transparency: number;
  highlight: number;
  shadow: number;
  tolerance: number;
  pedestal: number;
  choke: number;
  soften: number;
  contrast: number;
  midPoint: number;
  desaturate: number;
  range: number;
  spill: number;
  luma: number;
  saturation: number;
  hue: number;
  luminance: number;
  keyColor: Rgba;
  output: number;
  setting: number;
}

export interface UltraKeyUniforms {
  ku: number;
  kv: number;
  kZ: number;
  invK: number;
  gT: number;
  gR: number;
  gD: number;
  tol: number;
  spill2: number;
  luma2: number;
  hi2: number;
  sh2: number;
  ped: number;
  /** Row-vector CC rows: outR = dot(rgb, ccR) + ccO.x, etc. 12 numbers. */
  cc: number[];
}

const FLT_MIN = 1e-30;
export const ULTRA_KEY_GAIN_MAX = 1e30;

/** Slider 0..1 → Premiere's gain curve (0.5 neutral; 0 → ~∞, 1 → 0). */
export function ultraKeyGain(v: number): number {
  const g = v < 0.5 ? (v === 0 ? Infinity : 1 / (v + v)) : 2 * (1 - v);
  return Math.min(g, ULTRA_KEY_GAIN_MAX);
}

const srgbToLinear = (x: number) =>
  x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);

export function ultraKeyUniforms(e: UltraKeyResolved): UltraKeyUniforms {
  // Color Channel output forces Transparency to 0 (the reference does this
  // before its gain precompute), so the key pass's alpha is fully opaque.
  const transparency = e.output === 2 ? 0 : e.transparency / 100;
  const p = {
    transparency,
    highlight: e.highlight / 100,
    shadow: e.shadow / 100,
    tolerance: e.tolerance / 100,
    pedestal: e.pedestal / 100,
    desaturate: e.desaturate / 100,
    range: e.range / 100,
    spill: e.spill / 100,
    luma: e.luma / 100,
    saturation: e.saturation / 100,
    hue: e.hue,
    luminance: e.luminance / 100,
  };
  const kr = srgbToLinear(e.keyColor.r / 255);
  const kg = srgbToLinear(e.keyColor.g / 255);
  const kb = srgbToLinear(e.keyColor.b / 255);
  const KX = 0.471405 * kr - 0.235702 * kg - 0.235702 * kb;
  const KY = 0.408248 * kg - 0.408248 * kb;
  const KZ = 0.212671 * kr + 0.71516 * kg + 0.072169 * kb;
  const kz = Math.max(KZ, FLT_MIN);
  const ku = KX / kz;
  const kv = KY / kz;
  const invK = 1 / Math.sqrt(Math.max(ku * ku + kv * kv, FLT_MIN));
  const M = ultraKeyColorMatrix(p);
  return {
    ku,
    kv,
    kZ: KZ,
    invK,
    gT: ultraKeyGain(p.transparency),
    gR: ultraKeyGain(p.range),
    gD: ultraKeyGain(p.desaturate),
    tol: p.tolerance,
    spill2: 2 * p.spill,
    luma2: 2 * p.luma,
    hi2: 2 * p.highlight,
    sh2: 2 * p.shadow,
    ped: p.pedestal,
    // The reference's CC is column-major: outR = r*CC0 + g*CC4 + b*CC8 + CC12.
    cc: [M[0], M[4], M[8], M[1], M[5], M[9], M[2], M[6], M[10], M[12], M[13], M[14]],
  };
}

registerGpuProgram("ultraKey", fragSrc);
registerGpuProgram("ultraKeyChokeX", chokeXFrag);
registerGpuProgram("ultraKeyChokeY", chokeYFrag);
registerGpuProgram("ultraKeySoftenX", softenXFrag);
registerGpuProgram("ultraKeySoftenY", softenYFrag);
registerGpuProgram("ultraKeyFinal", finalFrag);

/**
 * The reference's fractional filter radius: floor(rf) plus the integer weight
 * used by `fracFilter`. For r == 0 the weight is on filter(1); otherwise it is
 * on filter(r). Keeping this in integer form makes the GLSL lerp exact.
 */
function radiusParts(rf: number): { r: number; w: number } {
  const r = Math.floor(rf);
  const fr = rf - r;
  return { r, w: r === 0 ? Math.trunc(fr * 256) : Math.trunc((1 - fr) * 256) };
}

/**
 * Ultra Key as a pass chain: key pass → Choke x/y (when Choke + Soften > 0) →
 * Soften x/y (when Soften > 0) → final. `offset` is the index of the key pass in
 * the whole GPU run (the final pass's two inputs are absolute indices);
 * `radiusScale` is texW / sourceNativeW, so preview caps choke in project pixels
 * like export does.
 */
export function ultraKeyPasses(e: UltraKeyResolved, offset = 0, radiusScale = 1): GpuPass[] {
  const u = ultraKeyUniforms(e);
  const passes: GpuPass[] = [
    {
      name: "ultraKey",
      frag: fragSrc,
      uniforms: {
        u_ku: { type: "1f", value: u.ku },
        u_kv: { type: "1f", value: u.kv },
        u_kZ: { type: "1f", value: u.kZ },
        u_invK: { type: "1f", value: u.invK },
        u_gT: { type: "1f", value: u.gT },
        u_gR: { type: "1f", value: u.gR },
        u_gD: { type: "1f", value: u.gD },
        u_tol: { type: "1f", value: u.tol },
        u_spill2: { type: "1f", value: u.spill2 },
        u_luma2: { type: "1f", value: u.luma2 },
        u_hi2: { type: "1f", value: u.hi2 },
        u_sh2: { type: "1f", value: u.sh2 },
        u_ped: { type: "1f", value: u.ped },
        u_ccR: { type: "3f", value: [u.cc[0], u.cc[1], u.cc[2]] },
        u_ccG: { type: "3f", value: [u.cc[3], u.cc[4], u.cc[5]] },
        u_ccB: { type: "3f", value: [u.cc[6], u.cc[7], u.cc[8]] },
        u_ccO: { type: "3f", value: [u.cc[9], u.cc[10], u.cc[11]] },
      },
    },
  ];

  const scale = Number.isFinite(radiusScale) && radiusScale > 0 ? radiusScale : 1;
  const choke = Math.min(1, Math.max(0, e.choke / 100));
  const soften = Math.min(1, Math.max(0, e.soften / 100));
  const rc = 4 * (choke + soften) * scale;
  const rs = 4 * soften * scale;
  let matte: number | null = null;

  if (rc > 0) {
    const { r, w } = radiusParts(rc);
    passes.push({
      name: "ultraKeyChokeX",
      frag: chokeXFrag,
      uniforms: { u_r: { type: "1i", value: r } },
    });
    passes.push({
      name: "ultraKeyChokeY",
      frag: chokeYFrag,
      uniforms: { u_r: { type: "1i", value: r }, u_w: { type: "1i", value: w } },
    });
    matte = offset + passes.length - 1;
  }

  if (rs > 0) {
    const { r, w } = radiusParts(rs);
    passes.push({
      name: "ultraKeySoftenX",
      frag: softenXFrag,
      uniforms: { u_r: { type: "1i", value: r } },
    });
    passes.push({
      name: "ultraKeySoftenY",
      frag: softenYFrag,
      uniforms: { u_r: { type: "1i", value: r }, u_w: { type: "1i", value: w } },
    });
    matte = offset + passes.length - 1;
  }

  passes.push({
    name: "ultraKeyFinal",
    frag: finalFrag,
    source: offset,
    ...(matte != null ? { source2: matte } : {}),
    uniforms: {
      u_cleanup: { type: "1i", value: matte != null ? 1 : 0 },
      u_output: { type: "1i", value: e.output },
      u_contrast: { type: "1f", value: e.contrast / 100 },
      u_midPoint: { type: "1f", value: e.midPoint / 100 },
    },
  });
  return passes;
}

// ---- dev-only shader check (WP11 item 3) -------------------------------------
// Renders a fixed frame through the real shader and returns the raw 8-bit
// RGBA in and out. docs/ultra-key-shader-check.mjs computes the oracle with
// docs/ultra-key-reference.mjs and compares all four channels. readPixels is
// used (not a 2D canvas) because a 2D canvas premultiplies and destroys RGB
// where alpha ≈ 0.
export interface UltraKeyCheckFrame {
  w: number;
  h: number;
  input: number[];
  params: {
    transparency: number;
    highlight: number;
    shadow: number;
    tolerance: number;
    pedestal: number;
    choke: number;
    soften: number;
    contrast: number;
    midPoint: number;
    desaturate: number;
    range: number;
    spill: number;
    luma: number;
    saturation: number;
    hue: number;
    luminance: number;
  };
  key: [number, number, number];
  output: number;
  downsample: number;
  pixels: number[];
  error?: string;
}

export interface UltraKeyCheckOptions {
  variant?: UltraKeyCheckVariant;
  /** 0 Default · 1 Relaxed · 2 Aggressive. */
  preset?: number;
  /** Premiere UI units (0..100). */
  choke?: number;
  soften?: number;
  contrast?: number;
  midPoint?: number;
  saturation?: number;
  hue?: number;
  luminance?: number;
  /** 0 Composite · 1 Alpha Channel · 2 Color Channel. */
  output?: number;
  /** texW / sourceNativeW (the reference's `downsample` argument). */
  downsample?: number;
}

export type UltraKeyCheckVariant = "fixture" | "stress" | "contrast";

/**
 * A deterministic sRGB frame. `fixture` (32×32) is green screen + skin, greys
 * and a soft edge; `stress` (64×64) is seeded pseudo-random RGB with a band of
 * near-key greens (key ±30 per channel) and an alpha ramp from 0 to 255;
 * `contrast` (2×1) is one fully keyed pixel and one opaque skin pixel.
 */
export function ultraKeyCheckInput(
  w = 32,
  h = 32,
  variant: UltraKeyCheckVariant = "fixture"
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  if (variant === "contrast") {
    out.set([40, 200, 60, 255, 225, 170, 140, 255]);
    return out;
  }
  if (variant === "stress") {
    const KEY = [40, 200, 60]; // #28c83c
    let seed = 0x5eed1234 >>> 0;
    const rnd = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const bandStart = Math.floor(h / 4);
    const bandEnd = Math.floor(h / 2);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const nearKey = y >= bandStart && y < bandEnd;
        for (let c = 0; c < 3; c++) {
          const v = nearKey
            ? KEY[c] + Math.round(rnd() * 60 - 30)
            : Math.floor(rnd() * 256);
          out[i + c] = Math.max(0, Math.min(255, v));
        }
        out[i + 3] = Math.round(((y * w + x) / (w * h - 1)) * 255);
      }
    }
    return out;
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let r = 40, g = 200, b = 60, a = 255;
      if (x >= 4 && x < 14 && y >= 4 && y < 14) {
        r = 225; g = 170; b = 140; // skin
      } else if (x >= 18 && x < 26 && y >= 4 && y < 12) {
        r = 128; g = 128; b = 128; // neutral grey
      } else if (x >= 4 && x < 12 && y >= 18 && y < 26) {
        r = 255; g = 255; b = 255; // white
      } else if (x >= 16 && x < 24 && y >= 18 && y < 26) {
        r = 0; g = 0; b = 0; // black
      } else if (x >= 24 && y >= 18) {
        r = 225; g = 170; b = 140; a = 128; // straight-alpha edge case
      } else if (x >= 14 && x < 18) {
        // 50% green/skin blend in linear light (the reference's self-check mix)
        const t = 0.5;
        const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
        const mixc = (sv: number, gv: number) => Math.round(Math.pow(t * lin(sv) + (1 - t) * lin(gv), 1 / 2.4) * 255);
        r = mixc(225, 40);
        g = mixc(170, 200);
        b = mixc(140, 60);
      }
      out[i] = r;
      out[i + 1] = g;
      out[i + 2] = b;
      out[i + 3] = a;
    }
  }
  return out;
}

/** Render a check frame through the real pass chain; returns bottom-up readPixels bytes. */
export function renderUltraKeyCheckFrame(
  options?: UltraKeyCheckOptions
): UltraKeyCheckFrame & { cc: number[] } {
  const opts = options ?? {};
  const variant = opts.variant ?? "fixture";
  const w = variant === "stress" ? 64 : variant === "contrast" ? 2 : 32;
  const h = variant === "contrast" ? 1 : w;
  const input = ultraKeyCheckInput(w, h, variant);

  const presetIndex = Math.min(2, Math.max(0, Math.floor(opts.preset ?? 0)));
  const preset =
    presetIndex === 0
      ? ULTRA_KEY_PRESETS.default
      : presetIndex === 1
        ? ULTRA_KEY_PRESETS.relaxed
        : ULTRA_KEY_PRESETS.aggressive;
  const values: number[] = [...preset];
  const override = (i: number, v: number | undefined) => {
    if (v !== undefined) values[i] = v;
  };
  override(5, opts.choke);
  override(6, opts.soften);
  override(7, opts.contrast);
  override(8, opts.midPoint);

  const sat = opts.saturation ?? 100;
  const hue = opts.hue ?? 0;
  const lum = opts.luminance ?? 100;
  const output = Math.min(2, Math.max(0, Math.floor(opts.output ?? 0)));
  const downsample = Number.isFinite(opts.downsample) ? Math.max(0, opts.downsample!) : 1;

  const params = {
    transparency: values[0] / 100,
    highlight: values[1] / 100,
    shadow: values[2] / 100,
    tolerance: values[3] / 100,
    pedestal: values[4] / 100,
    choke: values[5] / 100,
    soften: values[6] / 100,
    contrast: values[7] / 100,
    midPoint: values[8] / 100,
    desaturate: values[9] / 100,
    range: values[10] / 100,
    spill: values[11] / 100,
    luma: values[12] / 100,
    saturation: sat / 100,
    hue,
    luminance: lum / 100,
  };
  const resolved: UltraKeyResolved = {
    transparency: values[0],
    highlight: values[1],
    shadow: values[2],
    tolerance: values[3],
    pedestal: values[4],
    choke: values[5],
    soften: values[6],
    contrast: values[7],
    midPoint: values[8],
    desaturate: values[9],
    range: values[10],
    spill: values[11],
    luma: values[12],
    saturation: sat,
    hue,
    luminance: lum,
    keyColor: { r: 40, g: 200, b: 60, a: 255 },
    output,
    setting: presetIndex,
  };
  const ccPacked = ultraKeyUniforms(resolved).cc;
  const base = { w, h, input: Array.from(input), params, key: [40, 200, 60] as [number, number, number], output, downsample, cc: ccPacked };
  const img = new ImageData(input, w, h);
  const res = runPasses(img as unknown as Texture, w, h, ultraKeyPasses(resolved, 0, downsample));
  if (!res.ok) {
    return { ...base, pixels: [], error: res.error };
  }
  const gl = res.canvas.getContext("webgl2");
  if (!gl) {
    return { ...base, pixels: [], error: "no WebGL2 context" };
  }
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return { ...base, pixels: Array.from(px) };
}

if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as { __sefxUltraKey?: unknown }).__sefxUltraKey = {
    check: renderUltraKeyCheckFrame,
  };
}
