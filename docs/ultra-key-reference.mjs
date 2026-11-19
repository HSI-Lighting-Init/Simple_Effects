// Reference implementation of the Ultra Key maths in Simple Effects, written to match Premiere Pro
// 2023's Ultra Key (checked against frames exported from Premiere).
// 8-bit straight-alpha RGBA in, 8-bit straight-alpha RGBA out. Not optimised: this is the spec.
const FLT_MIN = 1.1754944e-38;

// ---- colour transfer (exact sRGB curve, not 2.2) -------------------------------------------
const LIN = new Float32Array(256).map((_, i) => {
  const v = i / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
});
const toSrgb8 = (l) => {
  l = l < 0 ? 0 : l > 1 ? 1 : l;
  const e = l < 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 0.41666) - 0.055;
  return Math.trunc(255 * e + 0.5);
};

// ---- keying space (Haeberli grey-axis rotation + luminance shear) --------------------------
// X,Y = opponent chroma (0 for every grey), Z = linear Rec.709 luminance.
const fwd = (r, g, b) => [
  0.471405 * r - 0.235702 * g - 0.235702 * b,
  0.408248 * g - 0.408248 * b,
  0.212671 * r + 0.71516 * g + 0.072169 * b,
];
const inv = (x, y, z) => [
  1.670177 * x - 0.7875 * y + z,
  -0.451143 * x + 0.437245 * y + z,
  -0.451143 * x - 2.012245 * y + z,
];

// Slider value v (0..1) -> gain. 0.5 -> 1, 0 -> "infinite", 1 -> 0.
const gain = (v) => (v < 0.5 ? (v === 0 ? 1.1754943e38 : 1 / (v + v)) : 2 * (1 - v));

// ---- colour correction (4x4 row-vector matrices, applied in linear RGB after keying) -------
const W = [0.212671, 0.71516, 0.072169];
const mul = (A, B) => { // returns B·A (append A after B)
  const C = new Array(16);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    let s = 0; for (let k = 0; k < 4; k++) s += B[i * 4 + k] * A[k * 4 + j]; C[i * 4 + j] = s;
  }
  return C;
};
const I4 = () => [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
function hueMatrix(M, deg) { // Haeberli huerotatemat with Rec.709 linear weights
  const c = 0.70710677, s = 0.70710677, cy = 0.8164966, sy = 0.57735026;
  let T = I4();
  T = mul([1,0,0,0, 0,c,s,0, 0,-s,c,0, 0,0,0,1], T);
  T = mul([cy,0,sy,0, 0,1,0,0, -sy,0,cy,0, 0,0,0,1], T);
  const lz = W[0]*T[2] + W[1]*T[6] + W[2]*T[10] + T[14];
  const zsx = (W[0]*T[0] + W[1]*T[4] + W[2]*T[8] + T[12]) / lz;
  const zsy = (W[0]*T[1] + W[1]*T[5] + W[2]*T[9] + T[13]) / lz;
  T = mul([1,0,zsx,0, 0,1,zsy,0, 0,0,1,0, 0,0,0,1], T);
  const a = deg * Math.PI / 180, sa = Math.sin(a), ca = Math.cos(a);
  T = mul([ca,sa,0,0, -sa,ca,0,0, 0,0,1,0, 0,0,0,1], T);
  T = mul([1,0,-zsx,0, 0,1,-zsy,0, 0,0,1,0, 0,0,0,1], T);
  T = mul([cy,0,-sy,0, 0,1,0,0, sy,0,cy,0, 0,0,0,1], T);
  T = mul([1,0,0,0, 0,c,-s,0, 0,s,c,0, 0,0,0,1], T);
  return mul(T, M);
}
export function colorMatrix({ saturation = 1, hue = 0, luminance = 1 }) {
  let M = I4();
  if (saturation !== 1) {
    const t = 1 - saturation, r = t * W[0], g = t * W[1], b = t * W[2];
    M = mul([r + saturation, r, r, 0, g, g + saturation, g, 0, b, b, b + saturation, 0, 0, 0, 0, 1], M);
  }
  if (hue !== 0) M = hueMatrix(M, hue);
  const gR = Math.pow(luminance, 2.2);
  return mul([gR,0,0,0, 0,gR,0,0, 0,0,gR,0, 0,0,0,1], M);
}

export const PRESETS = { // order: transparency, highlight, shadow, tolerance, pedestal, choke,
  // soften, contrast, midPoint, desaturate, range, spill, luma   (all 0..100)
  default:    [45, 10, 50, 50, 10, 0, 0, 0, 50, 25, 50, 50, 50],
  relaxed:    [50, 15, 50, 0, 0, 0, 0, 0, 50, 10, 50, 50, 50],
  aggressive: [40, 10, 55, 90, 50, 10, 10, 10, 50, 50, 50, 50, 50],
};

// ---- the key ---------------------------------------------------------------------------------
// p: all sliders as 0..1 except hue (degrees); key: [r,g,b] 0..255; output: composite|alpha|color
export function ultraKey(src, w, h, key, p, output = "composite", downsample = 1) {
  const out = new Uint8ClampedArray(src.length);
  const transparency = output === "color" ? 0 : p.transparency;
  const gT = gain(transparency), gR = gain(p.range), gD = gain(p.desaturate);
  const spill2 = 2 * p.spill, luma2 = 2 * p.luma, hi2 = 2 * p.highlight, sh2 = 2 * p.shadow;
  const tol = p.tolerance, ped = p.pedestal;
  const CC = colorMatrix(p);
  if (output === "alpha") { CC[12] = CC[13] = CC[14] = 1; } // row 3 := 1 -> RGB saturates to white

  const [KX, KY, KZ] = fwd(LIN[key[0]], LIN[key[1]], LIN[key[2]]);
  const kz = Math.max(KZ, FLT_MIN), ku = KX / kz, kv = KY / kz;
  const invK = 1 / Math.sqrt(Math.max(ku * ku + kv * kv, FLT_MIN));

  const matte = new Uint8Array(w * h);
  for (let i = 0, n = w * h; i < n; i++) {
    const o = i * 4;
    const [X, Y, Z] = fwd(LIN[src[o]], LIN[src[o + 1]], LIN[src[o + 2]]);
    const zz = Math.max(Z, FLT_MIN), u = X / zz, v = Y / zz;
    const du = u - ku, dv = v - kv, dz = Z - KZ;
    const dist = Math.sqrt(Math.max(du * du + dv * dv, FLT_MIN));
    const cosT = (du * ku + dv * kv) / dist * invK; // angle between (P-K) and K in the chroma plane
    const D = dist * invK;                          // chroma distance, in units of key saturation
    const tA = cosT > 0 ? cosT * tol : 0;
    const sS = cosT > 0 ? tol : tol * (1 + cosT);
    const spillA = Math.min(Math.max((1 - sS) * D * gR, FLT_MIN), 1);
    const spillK = (1 / spillA - 1) * spill2;
    const desat = Math.min((1 - sS) * D * gD, 1);
    const aC = Math.min((1 - tA) * D * gT, 1);
    const lr = dz / KZ;
    const aL = Math.min(lr * (lr <= 0 ? -sh2 : hi2), 1);
    const scr = aC + aL - aC * aL;                   // screen(aC, aL)
    const a = Math.max(scr * (1 + ped) - ped, 0);
    // un-mix: F = P + (1/alpha - 1)(P - K)   (luma uses the pre-pedestal alpha)
    const zO = Math.max(Z + dz * (1 / Math.max(scr, FLT_MIN) - 1) * luma2, 0);
    const uO = (u + spillK * du) * desat, vO = (v + spillK * dv) * desat;
    const [r, g, b] = inv(uO * zO, vO * zO, zO);
    out[o]     = toSrgb8(r * CC[0] + g * CC[4] + b * CC[8] + CC[12]);
    out[o + 1] = toSrgb8(r * CC[1] + g * CC[5] + b * CC[9] + CC[13]);
    out[o + 2] = toSrgb8(r * CC[2] + g * CC[6] + b * CC[10] + CC[14]);
    matte[i] = Math.trunc(a * src[o + 3]);
  }

  // matte cleanup: choke (square min, r = 4*(choke+soften)*ds px) -> soften (square box,
  // r = 4*soften*ds px) -> contrast around midpoint. Fractional radius = lerp(r, r+1).
  let m = matte;
  const rc = 4 * (p.choke + p.soften) * downsample, rs = 4 * p.soften * downsample;
  if (rc > 0) m = fracFilter(m, w, h, rc, minFilter);
  if (rs > 0) m = fracFilter(m, w, h, rs, boxFilter);
  for (let i = 0, n = w * h; i < n; i++) {
    let a = m[i];
    if (p.contrast > 0) {
      const M = p.midPoint * 255;
      // clamp the whole sum (§8): clamping only the shifted term left keyed pixels at 127
      a = Math.min(255, Math.max(0, (Math.trunc((a - M) * (p.contrast * 1024 + 1024)) >> 10) + Math.trunc(M)));
    }
    if (output === "alpha") { out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = a; a = 255; } // CompositeToBlack(white, a)
    out[i * 4 + 3] = a;
  }
  return out;
}

const at = (m, w, h, x, y) => m[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
function minFilter(m, w, h, r) {
  const o = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 255; for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) v = Math.min(v, at(m, w, h, x + i, y + j));
    o[y * w + x] = v;
  }
  return o;
}
function boxFilter(m, w, h, r) {
  const o = new Uint8Array(w * h), n = (2 * r + 1) ** 2, k = Math.trunc(65536 / n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0; for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) s += at(m, w, h, x + i, y + j);
    o[y * w + x] = (s * k + (n >> 1)) >>> 16;
  }
  return o;
}
function fracFilter(m, w, h, rf, f) {
  const r = Math.trunc(rf), fr = rf - r;
  if (r === 0) { const a = f(m, w, h, 1); return m.map((v, i) => (a[i] * Math.trunc(fr * 256) + v * (256 - Math.trunc(fr * 256))) >> 8); }
  const a = f(m, w, h, r);
  if (fr === 0) return a;
  const b = f(m, w, h, r + 1), wA = Math.trunc((1 - fr) * 256);
  return a.map((v, i) => (v * wA + b[i] * (256 - wA)) >> 8);
}

// ---- self-check -------------------------------------------------------------------------------
import { pathToFileURL } from "node:url";
import assert from "node:assert";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) { // `node docs/ultra-key-reference.mjs`
  const pct = (a) => Object.fromEntries(Object.entries(a).map(([k, v]) => [k, k === "hue" ? v : v / 100]));
  const [tr, hl, sh, to, pe, ch, so, co, mp, de, ra, sp, lu] = PRESETS.default;
  const P = pct({ transparency: tr, highlight: hl, shadow: sh, tolerance: to, pedestal: pe, choke: ch,
    soften: so, contrast: co, midPoint: mp, desaturate: de, range: ra, spill: sp, luma: lu,
    saturation: 100, hue: 0, luminance: 100 });
  const GREEN = [40, 200, 60], SKIN = [225, 170, 140];
  const px = (rgb) => ultraKey(new Uint8ClampedArray([...rgb, 255]), 1, 1, GREEN, P);
  const mix = (t) => GREEN.map((g, i) => Math.round(Math.pow(t * LIN[SKIN[i]] + (1 - t) * LIN[g], 1 / 2.4) * 255)); // rough linear blend
  const g = px(GREEN), s = px(SKIN), grey = px([128, 128, 128]), m50 = px(mix(0.5));
  console.log("key colour ->", [...g], " skin ->", [...s], " grey ->", [...grey], " 50% edge ->", [...m50]);
  assert(g[3] === 0, "key colour must be fully transparent");
  assert(s[3] === 255 && Math.abs(s[0] - SKIN[0]) <= 2 && Math.abs(s[1] - SKIN[1]) <= 2, "skin must be opaque + unchanged");
  assert(grey[3] === 255, "neutral grey must be opaque");
  assert(m50[3] > 0 && m50[3] < 255, "edge must be partial");
  assert(m50[1] < mix(0.5)[1], "edge must lose green spill");
  const black = ultraKey(new Uint8ClampedArray([...SKIN, 255, ...GREEN, 255]), 2, 1, [0, 0, 0], P);
  assert(black[3] === 255 && black[7] === 255, "default (black) key colour must key nothing");
  const col = ultraKey(new Uint8ClampedArray([...GREEN, 255]), 1, 1, GREEN, P, "color");
  assert(col[3] === 255, "Color Channel output must be opaque");
  const al = ultraKey(new Uint8ClampedArray([...SKIN, 255, ...GREEN, 255]), 2, 1, GREEN, P, "alpha");
  assert(al[0] === 255 && al[3] === 255 && al[4] === 0 && al[7] === 255, "Alpha Channel = white-on-black matte");
  const con = ultraKey(new Uint8ClampedArray([...GREEN, 255, ...SKIN, 255]), 2, 1, GREEN, { ...P, contrast: 0.3 });
  assert(con[3] === 0 && con[7] === 255, "Contrast must keep keyed pixels at 0 and opaque pixels at 255");
  console.log("self-check done");
}
