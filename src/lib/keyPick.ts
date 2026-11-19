// WP5: the pure part of the Key Color eyedropper. Konva supplies the
// pointer → node-local transform (including parent groups, anchor, rotation,
// scale and the monitor's fit/zoom/pan); this file maps those local coordinates
// into the ORIGINAL source frame's pixel space. The mapping uses the source's
// native size, not the (possibly preview-capped) texture size, so a capped
// preview picks the same pixel an export would.
import type { Rgba } from "../bindings/Rgba";

export interface KeyPickCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LocalPickSource {
  /** The source rectangle the node draws (the crop, or the full native frame). */
  crop?: KeyPickCrop | null;
  /** Native dimensions of the source we sample. */
  nativeWidth: number;
  nativeHeight: number;
  /** Size of the content the Konva node draws (node.width()/height()). */
  drawWidth: number;
  drawHeight: number;
}

export interface SourcePixel {
  x: number;
  y: number;
}

/**
 * Map a Konva node-local point to the source pixel it draws.
 *
 * The node's local space is its drawn content (0..drawWidth, 0..drawHeight).
 * The source rectangle is the crop when cropped, otherwise the full native
 * frame; the crop origin is added after scaling into that rectangle. Returns
 * null outside the drawn content or for degenerate sizes.
 */
export function localToSourcePixel(
  localX: number,
  localY: number,
  s: LocalPickSource
): SourcePixel | null {
  if (!(s.drawWidth > 0) || !(s.drawHeight > 0)) return null;
  if (!(s.nativeWidth > 0) || !(s.nativeHeight > 0)) return null;
  const srcW = s.crop?.width ?? s.nativeWidth;
  const srcH = s.crop?.height ?? s.nativeHeight;
  if (!(srcW > 0) || !(srcH > 0)) return null;
  if (localX < 0 || localY < 0 || localX >= s.drawWidth || localY >= s.drawHeight) return null;

  const x = (s.crop?.x ?? 0) + localX * (srcW / s.drawWidth);
  const y = (s.crop?.y ?? 0) + localY * (srcH / s.drawHeight);
  const clamp = (v: number, hi: number) => Math.min(hi, Math.max(0, Math.floor(v)));
  return { x: clamp(x, s.nativeWidth - 1), y: clamp(y, s.nativeHeight - 1) };
}

const srgbToLinear = (v: number) =>
  v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);

const linearToSrgb = (v: number) =>
  v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;

/**
 * Premiere's Ctrl/Cmd-click average: mean the 8-bit samples in linear light,
 * then re-encode to sRGB. Alpha is not part of the key colour, so it is 255.
 * (A uniform colour round-trips exactly; 13 black + 12 white becomes 184.)
 */
export function averageRgbaLinear(samples: readonly Rgba[]): Rgba {
  if (samples.length === 0) return { r: 0, g: 0, b: 0, a: 255 };

  let r = 0;
  let g = 0;
  let b = 0;
  for (const s of samples) {
    r += srgbToLinear(s.r / 255);
    g += srgbToLinear(s.g / 255);
    b += srgbToLinear(s.b / 255);
  }
  const n = samples.length;
  const to8 = (v: number) =>
    Math.max(0, Math.min(255, Math.round(linearToSrgb(v / n) * 255)));
  return { r: to8(r), g: to8(g), b: to8(b), a: 255 };
}
