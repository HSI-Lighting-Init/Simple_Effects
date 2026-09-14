// Distinct hues per keyframeable parameter family, shared by the timeline
// (keyframe-diamond colour) and the Inspector (the dot next to a parameter's
// name), so a colour means the same thing in both places. Tuned to read on the
// dark timeline and against the inspector background.
export const PARAM_COLORS: Record<string, string> = {
  x: "#ff6b6b",
  y: "#ff9f43",
  scaleX: "#feca57",
  scaleY: "#d6cf4b",
  scale: "#feca57",
  rotation: "#1dd1a1",
  opacity: "#54a0ff",
  tracking: "#a55eea",
  baseline: "#fd79a8",
  decompose: "#00d2d3",
  color: "#e8e8ef",
  effect: "#7d8cff",
  shape: "#48dbfb",
  attach: "#ffb86b",
  anim: "#e17055",
};

/** Colour for a parameter family key (falls back to a neutral blue). */
export const paramColor = (key: string): string => PARAM_COLORS[key] ?? "#c9d4ff";

/**
 * Best-effort colour for an Inspector field from its label, so the dot next to a
 * name matches the timeline diamond for the same family. Keeps the two views in
 * sync without threading an explicit key through every call site.
 */
export function labelColor(label: string): string {
  const l = label.toLowerCase();
  if (l.includes("track")) return PARAM_COLORS.tracking;
  if (l.includes("baseline")) return PARAM_COLORS.baseline;
  if (l.includes("opacity")) return PARAM_COLORS.opacity;
  if (l.includes("rotat")) return PARAM_COLORS.rotation;
  if (l.includes("scale")) return PARAM_COLORS.scale;
  if (l.includes("decompose")) return PARAM_COLORS.decompose;
  if (l === "x" || l.includes("pos x") || l.includes("offset x")) return PARAM_COLORS.x;
  if (l === "y" || l.includes("pos y") || l.includes("offset y")) return PARAM_COLORS.y;
  if (
    /(width|height|side|corner|bend|border|glow|shadow|blur|size|intensity|radius|depth|persp|focal|coverage|amount|softness|detail|speed|complexity|contrast|bright|wiggle|correl|smooth|ease|start|end)/.test(
      l
    )
  )
    return PARAM_COLORS.shape;
  return PARAM_COLORS.effect;
}
