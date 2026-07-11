// Right-hand inspector. For text layers it edits content (Arabic/RTL aware),
// font, colour, size (height), and the per-letter animation preset + timing.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import SearchSelect, { type SelGroup } from "./SearchSelect";
import type { Layer } from "../bindings/Layer";
import type { LetterAnimation } from "../bindings/LetterAnimation";
import type { LetterPreset } from "../bindings/LetterPreset";
import type { Font } from "../bindings/Font";
import type { Rgba } from "../bindings/Rgba";
import type { TextStyle } from "../bindings/TextStyle";
import type { TextFill } from "../bindings/TextFill";
import type { TextStroke } from "../bindings/TextStroke";
import type { StrokePosition } from "../bindings/StrokePosition";
import type { TextAnimator } from "../bindings/TextAnimator";
import type { AnimSelector } from "../bindings/AnimSelector";
import type { AnimProps } from "../bindings/AnimProps";
import type { Track } from "../bindings/Track";
import type { FontFace } from "../bindings/FontFace";
import { fontStyles } from "../lib/api";
import { sampleTrack, constTrack, upsertKey, isKeyed, sampleColor, isColorKeyed, upsertColorKey } from "../lib/track";
import type { ColorKey } from "../bindings/ColorKey";
import type { Shape2DStyle } from "../bindings/Shape2DStyle";
import type { VectorShape } from "../bindings/VectorShape";
import type { SelectorKind } from "../bindings/SelectorKind";
import type { RangeShape } from "../bindings/RangeShape";
import type { TextLayerStyles } from "../bindings/TextLayerStyles";
import type { DropShadow } from "../bindings/DropShadow";
import type { TextGlow } from "../bindings/TextGlow";
import type { BevelEmboss } from "../bindings/BevelEmboss";
import type { BevelStyle } from "../bindings/BevelStyle";
import type { GradientOverlay } from "../bindings/GradientOverlay";
import type { BlendMode } from "../bindings/BlendMode";
import type { SurfaceShape } from "../bindings/SurfaceShape";
import type { Decal } from "../bindings/Decal";
import type { ResolvedEffect } from "../bindings/ResolvedEffect";
import type { ResolvedLinkedEffect } from "../bindings/ResolvedLinkedEffect";
import type { Transition } from "../bindings/Transition";
import type { TransformEdit } from "../bindings/TransformEdit";
import { REGISTRY, getTransitionMeta, type ParamSpec } from "../lib/transitions";

type TransitionSlot = "in" | "out";
type TransitionKindOpt = "none" | "dissolve" | "slide" | "wipe";
type SetLayerTransition = (
  layerId: number,
  slot: TransitionSlot,
  kind: TransitionKindOpt,
  durMs: number,
  direction: number,
  engine?: string | null,
  paramsJson?: string | null
) => void;

// The full transition-engine library grouped by category, for the picker.
// Legacy dissolve/slide/wipe map onto engine ids so everything is one list.
const LEGACY_TO_ENGINE: Record<string, string> = { dissolve: "fade", slide: "slide", wipe: "horizontalWipe" };
const TRANSITION_GROUPS: { category: string; items: { id: string; label: string }[] }[] = (() => {
  const groups: { category: string; items: { id: string; label: string }[] }[] = [];
  for (const m of REGISTRY) {
    let g = groups.find((x) => x.category === m.category);
    if (!g) groups.push((g = { category: m.category, items: [] }));
    g.items.push({ id: m.id, label: m.label });
  }
  return groups;
})();

// Transition picker groups for the searchable dropdown (a leading "None").
const TRANSITION_SEL_GROUPS: SelGroup[] = [
  { category: "General", items: [{ id: "none", label: "None" }] },
  ...TRANSITION_GROUPS.map((g) => ({ category: g.category, items: g.items })),
];

const PRESETS: { value: LetterPreset | "none"; label: string }[] = [
  { value: "none", label: "None (static)" },
  { value: "fadeIn", label: "Fade in" },
  { value: "scalePop", label: "Scale pop" },
  { value: "riseUp", label: "Rise up" },
  { value: "scatterIn", label: "Explode / gather (scatter)" },
  { value: "typewriter", label: "Typewriter" },
];

function rgbToHex(c: Rgba): string {
  const h = (n: number) => Math.max(0, Math.min(255, n | 0)).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}
function hexToRgb(hex: string): Rgba {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return { r: 255, g: 255, b: 255, a: 255 };
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16), a: 255 };
}

const DEFAULT_TEXT_STYLE: TextStyle = {
  fills: [],
  strokes: [],
  fillOverStroke: false,
  tracking: 0,
  leading: 0,
  baselineShift: 0,
  fontFamily: null,
  fallbackStack: [],
  fontStyle: null,
  variableAxes: {},
};

// After Effects-style typography + stacked fills/strokes for a text layer.
function TextStyleSection({
  layerId,
  style,
  color,
  onSet,
}: {
  layerId: number;
  style: TextStyle | null;
  color: Rgba;
  onSet: (layerId: number, style: TextStyle | null) => void;
}) {
  const s = style ?? DEFAULT_TEXT_STYLE;
  const patch = (p: Partial<TextStyle>) => onSet(layerId, { ...s, ...p });
  const setFill = (i: number, f: Partial<TextFill>) => patch({ fills: s.fills.map((x, j) => (j === i ? { ...x, ...f } : x)) });
  const setStroke = (i: number, st: Partial<TextStroke>) => patch({ strokes: s.strokes.map((x, j) => (j === i ? { ...x, ...st } : x)) });
  return (
    <div className="insp-body">
      <div className="insp-sep">Fill &amp; Stroke</div>
      <div className="ts-head">
        <span>Fills</span>
        <button className="insp-btn" onClick={() => patch({ fills: [...s.fills, { color: { ...color, a: 255 }, opacity: 100 }] })}>＋ Fill</button>
      </div>
      {s.fills.map((f, i) => (
        <div key={i} className="ts-row">
          <input type="color" value={rgbaToHex(f.color)} onChange={(e) => setFill(i, { color: { ...hexToRgba(e.target.value), a: 255 } })} />
          <input type="number" min={0} max={100} value={f.opacity} title="Opacity %" onChange={(e) => setFill(i, { opacity: Number(e.target.value) })} />
          <button className="insp-btn" title="Remove" onClick={() => patch({ fills: s.fills.filter((_, j) => j !== i) })}>✕</button>
        </div>
      ))}
      <div className="ts-head">
        <span>Strokes</span>
        <button className="insp-btn" onClick={() => patch({ strokes: [...s.strokes, { color: { r: 0, g: 0, b: 0, a: 255 }, opacity: 100, width: 2, position: "outside" }] })}>＋ Stroke</button>
      </div>
      {s.strokes.map((st, i) => (
        <div key={i} className="ts-row">
          <input type="color" value={rgbaToHex(st.color)} onChange={(e) => setStroke(i, { color: { ...hexToRgba(e.target.value), a: 255 } })} />
          <input type="number" min={0} max={100} value={st.opacity} title="Opacity %" onChange={(e) => setStroke(i, { opacity: Number(e.target.value) })} />
          <input type="number" min={0} step={0.5} value={st.width} title="Width px" onChange={(e) => setStroke(i, { width: Number(e.target.value) })} />
          <select value={st.position} title="Position" onChange={(e) => setStroke(i, { position: e.target.value as StrokePosition })}>
            <option value="outside">Outside</option>
            <option value="center">Center</option>
            <option value="inside">Inside</option>
          </select>
          <button className="insp-btn" title="Remove" onClick={() => patch({ strokes: s.strokes.filter((_, j) => j !== i) })}>✕</button>
        </div>
      ))}
      <label className="insp-field ts-check">
        <input type="checkbox" checked={s.fillOverStroke} onChange={(e) => patch({ fillOverStroke: e.target.checked })} />
        Fill over stroke
      </label>

      <div className="insp-sep">Typography</div>
      {effSlider("Tracking (px)", s.tracking, -50, 100, 0.5, (v) => patch({ tracking: v }))}
      {effSlider("Baseline (px)", s.baselineShift, -100, 100, 0.5, (v) => patch({ baselineShift: v }))}
      {style && (
        <button className="insp-btn" onClick={() => onSet(layerId, null)}>
          Reset to plain
        </button>
      )}
      <p className="insp-hint">
        Stack multiple fills/strokes; strokes honour Inside/Center/Outside. Leading, font
        family &amp; variable axes are accepted &amp; saved for a later build.
      </p>
    </div>
  );
}

const DEFAULT_SELECTOR: AnimSelector = {
  kind: "range",
  start: constTrack(0),
  end: constTrack(100),
  offset: constTrack(0),
  smoothness: constTrack(100),
  easeHigh: constTrack(0),
  easeLow: constTrack(0),
  shape: "square",
  wigglesPerSec: constTrack(2),
  amount: constTrack(100),
  correlation: constTrack(50),
  temporalPhase: constTrack(0),
  spatialPhase: constTrack(0),
  seed: 1,
};
const DEFAULT_PROPS: AnimProps = {
  position: [constTrack(0), constTrack(0)],
  scale: constTrack(100),
  rotation: constTrack(0),
  skew: constTrack(0),
  skewAxis: constTrack(0),
  opacity: constTrack(100),
  tracking: constTrack(0),
  blur: constTrack(0),
  fill: null,
  charOffset: 0,
  rotationX: constTrack(0),
  rotationY: constTrack(0),
  positionZ: constTrack(0),
};

// A keyframed "sweep" offset track: the range selection slides across the whole
// run over `durMs` starting at the playhead — so a Range animator reveals its
// characters in sequence (offset 0 = all selected/hidden → the sweep clears
// every letter, so they end fully revealed). Overshoots 100 so the outward
// feather fully releases the last letter.
function sweepOffset(tMs: number, durMs = 800): Track {
  const a = Math.max(0, Math.round(tMs));
  return {
    default: 0,
    keys: [
      { timeMs: a, value: 0, easing: "easeInOut" },
      { timeMs: a + durMs, value: 130, easing: "linear" },
    ],
  };
}

// Build a ready-to-play animator. The range presets pair a keyframed offset
// sweep with a property so the letters actually animate in over time; "wiggle"
// is the self-driving jitter. All of it stays fully editable/keyframeable.
function makeAnimPreset(kind: "fade" | "rise" | "scale" | "wiggle", tMs: number): TextAnimator {
  if (kind === "wiggle") {
    return {
      selector: { ...DEFAULT_SELECTOR, kind: "wiggly" },
      props: { ...DEFAULT_PROPS, position: [constTrack(0), constTrack(14)], rotation: constTrack(8) },
    };
  }
  const selector: AnimSelector = {
    ...DEFAULT_SELECTOR,
    kind: "range",
    shape: "square",
    smoothness: constTrack(30),
    offset: sweepOffset(tMs),
  };
  const props: AnimProps = { ...DEFAULT_PROPS, opacity: constTrack(0) };
  if (kind === "rise") props.position = [constTrack(0), constTrack(60)];
  if (kind === "scale") props.scale = constTrack(0);
  return { selector, props };
}

// Slider bounds for a number field: use the provided min/max (defaulting to a
// 0..100 range) and always widen to include the current value, so the thumb is
// reachable and a value outside the nominal range is never clamped by the track.
function sliderBounds(value: number, min?: number, max?: number): [number, number] {
  return [Math.min(min ?? 0, value), Math.max(max ?? 100, value)];
}

// Compact labelled number field: a slider plus a number box (drag or type).
function NumField({ label, value, step = 1, min, max, onChange }: { label: string; value: number; step?: number; min?: number; max?: number; onChange: (v: number) => void }) {
  const [lo, hi] = sliderBounds(value, min, max);
  return (
    <label className="an-num">
      <span className="an-num-label">
        <span className="an-num-name">{label}</span>
        <input className="an-num-box" type="number" value={value} step={step} min={min} max={max} onChange={(e) => e.target.value !== "" && onChange(Number(e.target.value))} />
      </span>
      <input type="range" min={lo} max={hi} step={step} value={Math.max(lo, Math.min(hi, value))} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

// A keyframeable number field backed by a `Track`. The ◆ stopwatch toggles
// keyframing: off = editing sets one constant value; on = editing writes a
// keyframe at the playhead (`tMs`), so the value animates over time. The shown
// value is the track sampled at the playhead.
function KeyNumField({
  label,
  track,
  tMs,
  step = 1,
  min,
  max,
  onChange,
}: {
  label: string;
  track: Track;
  tMs: number;
  step?: number;
  min?: number;
  max?: number;
  onChange: (t: Track) => void;
}) {
  const keyed = isKeyed(track);
  const val = sampleTrack(track, tMs);
  const disp = Math.round(val * 1000) / 1000;
  const setVal = (v: number) => onChange(keyed ? upsertKey(track, tMs, v) : constTrack(v));
  const toggle = () => onChange(keyed ? constTrack(val) : upsertKey(constTrack(val), tMs, val));
  const [lo, hi] = sliderBounds(val, min, max);
  return (
    <label className="an-num">
      <span className="an-num-label">
        <span className="an-num-name">
          {label}
          <button
            type="button"
            className={"kf-dot" + (keyed ? " on" : "")}
            title={keyed ? `Keyframed (${track.keys.length}) — click to freeze at this value` : "Keyframe at the playhead"}
            onClick={(e) => {
              e.preventDefault();
              toggle();
            }}
          >
            ◆
          </button>
        </span>
        <input className="an-num-box" type="number" value={disp} step={step} min={min} max={max} onChange={(e) => setVal(Number(e.target.value))} />
      </span>
      <input type="range" min={lo} max={hi} step={step} value={Math.max(lo, Math.min(hi, val))} onChange={(e) => setVal(Number(e.target.value))} />
    </label>
  );
}

// A keyframeable colour field: a swatch plus a ◆ stopwatch. Editing the swatch
// sets the base colour, or upserts a key at the playhead when keyed; the dot
// toggles keyframing on/off. The colour shown is the value sampled at `tMs`.
// Mirrors KeyNumField, for colours.
function ColorKeyField({
  label,
  color,
  keys,
  tMs,
  onChange,
}: {
  label: string;
  color: Rgba;
  keys: ColorKey[];
  tMs: number;
  onChange: (color: Rgba, keys: ColorKey[]) => void;
}) {
  const keyed = isColorKeyed(keys);
  const cur = sampleColor(keys, color, tMs);
  const setColor = (rgb: { r: number; g: number; b: number }) => {
    const c: Rgba = { ...rgb, a: 255 };
    if (keyed) onChange(color, upsertColorKey(keys, tMs, c));
    else onChange(c, keys);
  };
  const toggle = () => {
    if (keyed) onChange(cur, []); // freeze at the current colour
    else onChange(color, upsertColorKey([], tMs, cur));
  };
  return (
    <label className="an-num">
      <span className="an-num-label">
        {label}
        <button
          type="button"
          className={"kf-dot" + (keyed ? " on" : "")}
          title={keyed ? `Keyframed (${keys.length}) — click to freeze at this colour` : "Keyframe the colour at the playhead"}
          onClick={(e) => {
            e.preventDefault();
            toggle();
          }}
        >
          ◆
        </button>
      </span>
      <input type="color" value={rgbaToHex(cur)} onChange={(e) => setColor(hexToRgba(e.target.value))} />
    </label>
  );
}

// Inspector for a 2D vector shape (rectangle / circle / polygon). Every colour is
// keyframeable (fill / border / glow / shadow) and the numeric knobs sit on
// keyframe tracks. Edits the whole Shape2DStyle and sends it back wholesale.
function Shape2DSection({
  layerId,
  style,
  timeMs,
  onSet,
}: {
  layerId: number;
  style: Shape2DStyle;
  timeMs: number;
  onSet: (layerId: number, style: Shape2DStyle) => void;
}) {
  const set = (patch: Partial<Shape2DStyle>) => onSet(layerId, { ...style, ...patch });
  const SHAPES: VectorShape[] = ["rectangle", "circle", "polygon", "arrow", "line"];
  const isArrow = style.shape === "arrow";
  const isLine = style.shape === "line";
  // Arrows and lines are stroke-only: no fill/border split, and width/height read
  // as length/thickness.
  const isStroke = isArrow || isLine;
  return (
    <>
      <Section title="Shape">
        <label className="insp-field">
          Type
          <div className="seg">
            {SHAPES.map((s) => (
              <button
                key={s}
                className={"seg-btn" + (style.shape === s ? " active" : "")}
                onClick={() => set({ shape: s })}
              >
                {s[0].toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
        </label>
        {style.shape === "polygon" && (
          <KeyNumField label="Sides" track={style.sides} tMs={timeMs} min={3} max={30} onChange={(t) => set({ sides: t })} />
        )}
        <KeyNumField label={isStroke ? "Length" : "Width"} track={style.width} tMs={timeMs} min={4} max={4000} onChange={(t) => set({ width: t })} />
        <KeyNumField label={isStroke ? "Thickness" : "Height"} track={style.height} tMs={timeMs} min={isLine ? 1 : 4} max={4000} onChange={(t) => set({ height: t })} />
        {style.shape === "rectangle" && (
          <KeyNumField label="Corner radius" track={style.cornerRadius} tMs={timeMs} min={0} max={500} onChange={(t) => set({ cornerRadius: t })} />
        )}
        {isStroke && (
          <KeyNumField label="Bend" track={style.bend} tMs={timeMs} min={-1000} max={1000} onChange={(t) => set({ bend: t })} />
        )}
        {!isStroke && (
          <label className="insp-field">
            Fill style
            <div className="seg">
              <button className={"seg-btn" + (style.filled ? " active" : "")} onClick={() => set({ filled: true })}>
                Filled
              </button>
              <button
                className={"seg-btn" + (!style.filled ? " active" : "")}
                onClick={() =>
                  set({
                    filled: false,
                    // Give a hollow shape a visible outline if it has none yet.
                    borderWidth: isKeyed(style.borderWidth) || sampleTrack(style.borderWidth, timeMs) > 0
                      ? style.borderWidth
                      : constTrack(6),
                  })
                }
              >
                Hollow
              </button>
            </div>
          </label>
        )}
        {(style.filled || isStroke) && (
          <ColorKeyField label={isStroke ? "Colour" : "Fill"} color={style.fill} keys={style.fillKeys} tMs={timeMs} onChange={(c, k) => set({ fill: c, fillKeys: k })} />
        )}
      </Section>

      {!isStroke && (
        <Section title="Border">
          <KeyNumField label="Width" track={style.borderWidth} tMs={timeMs} min={0} max={200} onChange={(t) => set({ borderWidth: t })} />
          <ColorKeyField label="Colour" color={style.borderColor} keys={style.borderColorKeys} tMs={timeMs} onChange={(c, k) => set({ borderColor: c, borderColorKeys: k })} />
        </Section>
      )}

      <Section title="Glow">
        <ColorKeyField label="Colour" color={style.glowColor} keys={style.glowColorKeys} tMs={timeMs} onChange={(c, k) => set({ glowColor: c, glowColorKeys: k })} />
        <KeyNumField label="Size" track={style.glowSize} tMs={timeMs} min={0} max={400} onChange={(t) => set({ glowSize: t })} />
        <KeyNumField label="Intensity" track={style.glowIntensity} tMs={timeMs} min={0} max={8} step={0.1} onChange={(t) => set({ glowIntensity: t })} />
        <KeyNumField label="Opacity" track={style.glowOpacity} tMs={timeMs} min={0} max={1} step={0.05} onChange={(t) => set({ glowOpacity: t })} />
      </Section>

      <Section title="Shadow">
        <ColorKeyField label="Colour" color={style.shadowColor} keys={style.shadowColorKeys} tMs={timeMs} onChange={(c, k) => set({ shadowColor: c, shadowColorKeys: k })} />
        <KeyNumField label="Blur" track={style.shadowBlur} tMs={timeMs} min={0} max={200} onChange={(t) => set({ shadowBlur: t })} />
        <KeyNumField label="Offset X" track={style.shadowOffsetX} tMs={timeMs} min={-300} max={300} onChange={(t) => set({ shadowOffsetX: t })} />
        <KeyNumField label="Offset Y" track={style.shadowOffsetY} tMs={timeMs} min={-300} max={300} onChange={(t) => set({ shadowOffsetY: t })} />
        <KeyNumField label="Opacity" track={style.shadowOpacity} tMs={timeMs} min={0} max={1} step={0.05} onChange={(t) => set({ shadowOpacity: t })} />
      </Section>
    </>
  );
}

// After Effects-style per-character animators: a stack of selector + properties.
function TextAnimatorsSection({
  layerId,
  animators,
  timeMs,
  onSet,
}: {
  layerId: number;
  animators: TextAnimator[];
  timeMs: number;
  onSet: (layerId: number, animators: TextAnimator[]) => void;
}) {
  const setAnim = (i: number, a: TextAnimator) => onSet(layerId, animators.map((x, j) => (j === i ? a : x)));
  const setSel = (i: number, s: Partial<AnimSelector>) => setAnim(i, { ...animators[i], selector: { ...animators[i].selector, ...s } });
  const setProps = (i: number, p: Partial<AnimProps>) => setAnim(i, { ...animators[i], props: { ...animators[i].props, ...p } });
  return (
    <div className="insp-body">
      <div className="ts-head">
        <span>Animators</span>
        <button className="insp-btn" onClick={() => onSet(layerId, [...animators, { selector: DEFAULT_SELECTOR, props: DEFAULT_PROPS }])}>＋ Animator</button>
      </div>
      <div className="an-presets">
        <span className="muted">Animate in:</span>
        <button className="insp-btn tiny" title="Letters fade in one by one from the playhead" onClick={() => onSet(layerId, [...animators, makeAnimPreset("fade", timeMs)])}>Fade</button>
        <button className="insp-btn tiny" title="Letters rise + fade in, in sequence" onClick={() => onSet(layerId, [...animators, makeAnimPreset("rise", timeMs)])}>Rise</button>
        <button className="insp-btn tiny" title="Letters scale + fade in, in sequence" onClick={() => onSet(layerId, [...animators, makeAnimPreset("scale", timeMs)])}>Scale</button>
        <button className="insp-btn tiny" title="Continuous wiggle" onClick={() => onSet(layerId, [...animators, makeAnimPreset("wiggle", timeMs)])}>Wiggle</button>
      </div>
      {animators.map((an, i) => {
        const sel = an.selector;
        const p = an.props;
        return (
          <div key={i} className="an-box">
            <div className="an-head">
              <span>#{i + 1}</span>
              <button className="insp-btn" title="Remove" onClick={() => onSet(layerId, animators.filter((_, j) => j !== i))}>✕</button>
            </div>
            <label className="insp-field">
              Selector
              <select value={sel.kind} onChange={(e) => setSel(i, { kind: e.target.value as SelectorKind })}>
                <option value="range">Range</option>
                <option value="wiggly">Wiggly</option>
                <option value="expression">Expression (full)</option>
              </select>
            </label>
            {sel.kind === "range" && (
              <>
                <div className="an-grid">
                  <KeyNumField label="Start %" track={sel.start} tMs={timeMs} min={0} max={100} onChange={(t) => setSel(i, { start: t })} />
                  <KeyNumField label="End %" track={sel.end} tMs={timeMs} min={0} max={100} onChange={(t) => setSel(i, { end: t })} />
                  <KeyNumField label="Offset %" track={sel.offset} tMs={timeMs} min={-100} max={100} onChange={(t) => setSel(i, { offset: t })} />
                  <KeyNumField label="Smooth %" track={sel.smoothness} tMs={timeMs} min={0} max={100} onChange={(t) => setSel(i, { smoothness: t })} />
                  <KeyNumField label="Ease Hi" track={sel.easeHigh} tMs={timeMs} min={-100} max={100} onChange={(t) => setSel(i, { easeHigh: t })} />
                  <KeyNumField label="Ease Lo" track={sel.easeLow} tMs={timeMs} min={-100} max={100} onChange={(t) => setSel(i, { easeLow: t })} />
                </div>
                <label className="insp-field">
                  Shape
                  <select value={sel.shape} onChange={(e) => setSel(i, { shape: e.target.value as RangeShape })}>
                    <option value="square">Square</option>
                    <option value="rampUp">Ramp Up</option>
                    <option value="rampDown">Ramp Down</option>
                    <option value="triangle">Triangle</option>
                    <option value="round">Round</option>
                    <option value="smooth">Smooth</option>
                  </select>
                </label>
              </>
            )}
            {sel.kind === "wiggly" && (
              <div className="an-grid">
                <KeyNumField label="Wiggles/s" track={sel.wigglesPerSec} tMs={timeMs} step={0.5} min={0} max={20} onChange={(t) => setSel(i, { wigglesPerSec: t })} />
                <KeyNumField label="Amount %" track={sel.amount} tMs={timeMs} min={0} max={100} onChange={(t) => setSel(i, { amount: t })} />
                <KeyNumField label="Correl %" track={sel.correlation} tMs={timeMs} min={0} max={100} onChange={(t) => setSel(i, { correlation: t })} />
                <NumField label="Seed" value={sel.seed} min={1} onChange={(v) => setSel(i, { seed: Math.max(1, Math.round(v)) })} />
              </div>
            )}
            <div className="an-sep">Animate</div>
            <div className="an-grid">
              <KeyNumField label="Pos X" track={p.position[0]} tMs={timeMs} min={-500} max={500} onChange={(t) => setProps(i, { position: [t, p.position[1]] })} />
              <KeyNumField label="Pos Y" track={p.position[1]} tMs={timeMs} min={-500} max={500} onChange={(t) => setProps(i, { position: [p.position[0], t] })} />
              <KeyNumField label="Scale %" track={p.scale} tMs={timeMs} min={0} max={400} onChange={(t) => setProps(i, { scale: t })} />
              <KeyNumField label="Rotate°" track={p.rotation} tMs={timeMs} min={-360} max={360} onChange={(t) => setProps(i, { rotation: t })} />
              <KeyNumField label="Opacity %" track={p.opacity} tMs={timeMs} min={0} max={100} onChange={(t) => setProps(i, { opacity: t })} />
              <KeyNumField label="Tracking" track={p.tracking} tMs={timeMs} step={0.5} min={-100} max={100} onChange={(t) => setProps(i, { tracking: t })} />
              <KeyNumField label="Skew°" track={p.skew} tMs={timeMs} min={-90} max={90} onChange={(t) => setProps(i, { skew: t })} />
              <KeyNumField label="Skew Axis°" track={p.skewAxis} tMs={timeMs} min={-180} max={180} onChange={(t) => setProps(i, { skewAxis: t })} />
              <KeyNumField label="Blur px" track={p.blur} tMs={timeMs} step={0.5} min={0} max={100} onChange={(t) => setProps(i, { blur: t })} />
              <KeyNumField label="Rot X° (3D)" track={p.rotationX} tMs={timeMs} min={-360} max={360} onChange={(t) => setProps(i, { rotationX: t })} />
              <KeyNumField label="Rot Y° (3D)" track={p.rotationY} tMs={timeMs} min={-360} max={360} onChange={(t) => setProps(i, { rotationY: t })} />
              <KeyNumField label="Pos Z (3D)" track={p.positionZ} tMs={timeMs} min={-1000} max={1000} onChange={(t) => setProps(i, { positionZ: t })} />
            </div>
            <label className="ts-check">
              <input
                type="checkbox"
                checked={!!p.fill}
                onChange={(e) => setProps(i, { fill: e.target.checked ? { r: 255, g: 80, b: 80, a: 255 } : null })}
              />
              Colour
              {p.fill && (
                <input type="color" value={rgbaToHex(p.fill)} onChange={(e) => setProps(i, { fill: { ...hexToRgba(e.target.value), a: 255 } })} />
              )}
            </label>
          </div>
        );
      })}
      {animators.length > 0 && (
        <p className="insp-hint">
          Every field is keyframeable — click its ◆ to key at the playhead. Wiggly moves on its own; to animate a Range (Ramp&nbsp;Up etc.), keyframe the selector <b>Offset</b> (e.g. −100 → 100) so the selection sweeps across the letters over time.
        </p>
      )}
    </div>
  );
}

const DEF_SHADOW: DropShadow = { color: { r: 0, g: 0, b: 0, a: 255 }, opacity: 75, angle: 120, distance: 6, size: 6 };
const DEF_OGLOW: TextGlow = { color: { r: 255, g: 240, b: 150, a: 255 }, opacity: 75, size: 10, range: 50, mode: "screen" };
const DEF_IGLOW: TextGlow = { color: { r: 255, g: 255, b: 255, a: 255 }, opacity: 60, size: 6, range: 50, mode: "screen" };
const DEF_BEVEL: BevelEmboss = { style: "innerBevel", depth: 100, size: 5, soften: 2, angle: 120 };
const DEF_GRADIENT: GradientOverlay = {
  opacity: 100,
  angle: 90,
  blend: "normal",
  stops: [
    { position: 0, color: { r: 255, g: 60, b: 120, a: 255 } },
    { position: 100, color: { r: 80, g: 60, b: 255, a: 255 } },
  ],
};
const DEF_STYLES: TextLayerStyles = { dropShadow: null, outerGlow: null, innerGlow: null, bevel: null, gradient: null };

const BLENDS: BlendMode[] = ["normal", "screen", "multiply", "overlay"];

// Whole-layer text styles (drop shadow / glow / bevel / gradient) + per-char 3D.
function TextLayerStylesSection({
  layerId,
  styles,
  perChar3d,
  perCharRx,
  perCharRy,
  perCharSpread,
  onSet,
  onSet3d,
}: {
  layerId: number;
  styles: TextLayerStyles | null;
  perChar3d: boolean;
  perCharRx: number;
  perCharRy: number;
  perCharSpread: number;
  onSet: (layerId: number, styles: TextLayerStyles | null) => void;
  onSet3d: (layerId: number, enabled: boolean, rx: number, ry: number, spread: number) => void;
}) {
  const s = styles ?? DEF_STYLES;
  const patch = (p: Partial<TextLayerStyles>) => onSet(layerId, { ...s, ...p });
  const anyOn = !!(s.dropShadow || s.outerGlow || s.innerGlow || s.bevel || s.gradient);
  const hex = rgbaToHex;
  const rgb = (h: string) => ({ ...hexToRgba(h), a: 255 });
  return (
    <div className="insp-body">
      <label className="ts-check">
        <input type="checkbox" checked={perChar3d} onChange={(e) => onSet3d(layerId, e.target.checked, perCharRx, perCharRy, perCharSpread)} />
        Per-character 3D
      </label>
      {perChar3d && (
        <>
          <div className="an-grid">
            <NumField label="Rot X°" value={perCharRx} min={-360} max={360} onChange={(v) => onSet3d(layerId, true, v, perCharRy, perCharSpread)} />
            <NumField label="Rot Y°" value={perCharRy} min={-360} max={360} onChange={(v) => onSet3d(layerId, true, perCharRx, v, perCharSpread)} />
            <NumField label="Spread°/char" value={perCharSpread} min={-90} max={90} onChange={(v) => onSet3d(layerId, true, perCharRx, perCharRy, v)} />
          </div>
          <p className="insp-hint">Base 3D tilts every glyph about its own centre; Spread fans the rotation across characters. Animate it further with an animator's Rot X/Y + Pos Z.</p>
        </>
      )}

      {/* Drop shadow */}
      <label className="ts-check">
        <input type="checkbox" checked={!!s.dropShadow} onChange={(e) => patch({ dropShadow: e.target.checked ? DEF_SHADOW : null })} />
        Drop shadow
        {s.dropShadow && <input type="color" value={hex(s.dropShadow.color)} onChange={(e) => patch({ dropShadow: { ...s.dropShadow!, color: rgb(e.target.value) } })} />}
      </label>
      {s.dropShadow && (
        <div className="an-grid">
          <NumField label="Opacity %" value={s.dropShadow.opacity} min={0} max={100} onChange={(v) => patch({ dropShadow: { ...s.dropShadow!, opacity: v } })} />
          <NumField label="Angle°" value={s.dropShadow.angle} min={0} max={360} onChange={(v) => patch({ dropShadow: { ...s.dropShadow!, angle: v } })} />
          <NumField label="Distance" value={s.dropShadow.distance} min={0} max={200} onChange={(v) => patch({ dropShadow: { ...s.dropShadow!, distance: v } })} />
          <NumField label="Size" value={s.dropShadow.size} min={0} max={200} onChange={(v) => patch({ dropShadow: { ...s.dropShadow!, size: v } })} />
        </div>
      )}

      {/* Outer glow */}
      <label className="ts-check">
        <input type="checkbox" checked={!!s.outerGlow} onChange={(e) => patch({ outerGlow: e.target.checked ? DEF_OGLOW : null })} />
        Outer glow
        {s.outerGlow && <input type="color" value={hex(s.outerGlow.color)} onChange={(e) => patch({ outerGlow: { ...s.outerGlow!, color: rgb(e.target.value) } })} />}
      </label>
      {s.outerGlow && (
        <div className="an-grid">
          <NumField label="Opacity %" value={s.outerGlow.opacity} min={0} max={100} onChange={(v) => patch({ outerGlow: { ...s.outerGlow!, opacity: v } })} />
          <NumField label="Size" value={s.outerGlow.size} min={0} max={200} onChange={(v) => patch({ outerGlow: { ...s.outerGlow!, size: v } })} />
          <NumField label="Range %" value={s.outerGlow.range} min={0} max={100} onChange={(v) => patch({ outerGlow: { ...s.outerGlow!, range: v } })} />
        </div>
      )}

      {/* Inner glow */}
      <label className="ts-check">
        <input type="checkbox" checked={!!s.innerGlow} onChange={(e) => patch({ innerGlow: e.target.checked ? DEF_IGLOW : null })} />
        Inner glow
        {s.innerGlow && <input type="color" value={hex(s.innerGlow.color)} onChange={(e) => patch({ innerGlow: { ...s.innerGlow!, color: rgb(e.target.value) } })} />}
      </label>
      {s.innerGlow && (
        <div className="an-grid">
          <NumField label="Opacity %" value={s.innerGlow.opacity} min={0} max={100} onChange={(v) => patch({ innerGlow: { ...s.innerGlow!, opacity: v } })} />
          <NumField label="Size" value={s.innerGlow.size} min={0} max={200} onChange={(v) => patch({ innerGlow: { ...s.innerGlow!, size: v } })} />
        </div>
      )}

      {/* Bevel / emboss */}
      <label className="ts-check">
        <input type="checkbox" checked={!!s.bevel} onChange={(e) => patch({ bevel: e.target.checked ? DEF_BEVEL : null })} />
        Bevel / emboss
      </label>
      {s.bevel && (
        <>
          <label className="insp-field">
            Style
            <select value={s.bevel.style} onChange={(e) => patch({ bevel: { ...s.bevel!, style: e.target.value as BevelStyle } })}>
              <option value="innerBevel">Inner bevel</option>
              <option value="outerBevel">Outer bevel</option>
              <option value="emboss">Emboss</option>
              <option value="pillowEmboss">Pillow emboss</option>
            </select>
          </label>
          <div className="an-grid">
            <NumField label="Depth %" value={s.bevel.depth} min={0} max={300} onChange={(v) => patch({ bevel: { ...s.bevel!, depth: v } })} />
            <NumField label="Size" value={s.bevel.size} min={0} max={100} onChange={(v) => patch({ bevel: { ...s.bevel!, size: v } })} />
            <NumField label="Soften" value={s.bevel.soften} min={0} max={100} onChange={(v) => patch({ bevel: { ...s.bevel!, soften: v } })} />
            <NumField label="Angle°" value={s.bevel.angle} min={0} max={360} onChange={(v) => patch({ bevel: { ...s.bevel!, angle: v } })} />
          </div>
        </>
      )}

      {/* Gradient overlay */}
      <label className="ts-check">
        <input type="checkbox" checked={!!s.gradient} onChange={(e) => patch({ gradient: e.target.checked ? DEF_GRADIENT : null })} />
        Gradient overlay
      </label>
      {s.gradient && (
        <>
          <div className="an-grid">
            <NumField label="Opacity %" value={s.gradient.opacity} min={0} max={100} onChange={(v) => patch({ gradient: { ...s.gradient!, opacity: v } })} />
            <NumField label="Angle°" value={s.gradient.angle} min={0} max={360} onChange={(v) => patch({ gradient: { ...s.gradient!, angle: v } })} />
          </div>
          <label className="insp-field">
            Blend
            <select value={s.gradient.blend} onChange={(e) => patch({ gradient: { ...s.gradient!, blend: e.target.value as BlendMode } })}>
              {BLENDS.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          </label>
          {s.gradient.stops.map((st, i) => (
            <div key={i} className="ts-row">
              <input type="color" value={hex(st.color)} onChange={(e) => patch({ gradient: { ...s.gradient!, stops: s.gradient!.stops.map((x, j) => (j === i ? { ...x, color: rgb(e.target.value) } : x)) } })} />
              <input type="number" min={0} max={100} value={st.position} title="Position %" onChange={(e) => patch({ gradient: { ...s.gradient!, stops: s.gradient!.stops.map((x, j) => (j === i ? { ...x, position: Number(e.target.value) } : x)) } })} />
              {s.gradient!.stops.length > 2 && (
                <button className="insp-btn" title="Remove" onClick={() => patch({ gradient: { ...s.gradient!, stops: s.gradient!.stops.filter((_, j) => j !== i) } })}>✕</button>
              )}
            </div>
          ))}
          <button className="insp-btn" onClick={() => patch({ gradient: { ...s.gradient!, stops: [...s.gradient!.stops, { position: 50, color: { r: 255, g: 255, b: 255, a: 255 } }] } })}>＋ Stop</button>
        </>
      )}

      {anyOn && (
        <button className="insp-btn" onClick={() => onSet(layerId, null)}>Clear layer styles</button>
      )}
      <p className="insp-hint">Layer styles &amp; per-char 3D are canvas-2D approximations (bevel = offset highlight/shadow; 3D = 2.5D foreshorten).</p>
    </div>
  );
}

function TextInspector({
  layerId,
  timeMs,
  content: content0,
  size: size0,
  color,
  font,
  weight,
  italic,
  fonts,
  onRefreshFonts,
  onFontStyle,
  anim,
  style,
  animators,
  layerStyles,
  perChar3d,
  perCharRx,
  perCharRy,
  perCharSpread,
  decomposed,
  onContent,
  onColor,
  onClearColorKeys,
  colorKeyCount,
  onFont,
  onAnim,
  onSetTextStyle,
  onSetTextAnimators,
  onSetTextLayerStyles,
  onSetTextPerChar3d,
  onToggleDecompose,
  onClearParts,
  onDecomposeKey,
  selectedPart,
  letterColorNow,
  onLetterColor,
  onClearLetterColor,
}: {
  layerId: number;
  timeMs: number;
  content: string;
  size: number;
  color: Rgba;
  font: Font;
  weight: number;
  italic: boolean;
  fonts: string[];
  onRefreshFonts: () => void;
  onFontStyle: (layerId: number, weight: number, italic: boolean) => void;
  anim: LetterAnimation | null;
  style: TextStyle | null;
  animators: TextAnimator[];
  layerStyles: TextLayerStyles | null;
  perChar3d: boolean;
  perCharRx: number;
  perCharRy: number;
  perCharSpread: number;
  decomposed: boolean;
  onContent: (layerId: number, content: string, size: number) => void;
  onColor: (layerId: number, color: Rgba) => void;
  onClearColorKeys: (layerId: number, color: Rgba) => void;
  colorKeyCount: number;
  onFont: (layerId: number, font: Font) => void;
  onAnim: (layerId: number, anim: LetterAnimation | null) => void;
  onSetTextStyle: (layerId: number, style: TextStyle | null) => void;
  onSetTextAnimators: (layerId: number, animators: TextAnimator[]) => void;
  onSetTextLayerStyles: (layerId: number, styles: TextLayerStyles | null) => void;
  onSetTextPerChar3d: (layerId: number, enabled: boolean, rx: number, ry: number, spread: number) => void;
  onToggleDecompose: (layerId: number) => void;
  onClearParts: (layerId: number) => void;
  onDecomposeKey: (layerId: number, value: number) => void;
  selectedPart: number | null;
  letterColorNow: Rgba | null;
  onLetterColor: (layerId: number, index: number, color: Rgba) => void;
  onClearLetterColor: (layerId: number, index: number) => void;
}) {
  const [content, setContent] = useState(content0);
  const [size, setSize] = useState(size0);
  useEffect(() => {
    setContent(content0);
    setSize(size0);
  }, [layerId, content0, size0]);

  // The faces (styles) the current family actually offers — Regular, Bold,
  // Medium, Thin, Bold Italic… — for the Style dropdown. Refetched per font.
  const [faces, setFaces] = useState<FontFace[]>([]);
  useEffect(() => {
    let alive = true;
    fontStyles(font).then((f) => alive && setFaces(f));
    return () => {
      alive = false;
    };
  }, [font]);
  // The dropdown's current value; if the stored weight/italic isn't among the
  // faces (e.g. a family that lost a face), show it as an extra option.
  const styleKey = `${weight}:${italic}`;
  const faceList: FontFace[] = faces.some((f) => `${f.weight}:${f.italic}` === styleKey)
    ? faces
    : [...faces, { name: `${weight}${italic ? " Italic" : ""}`, weight, italic }];

  // Grow the text box to fit its content so long text isn't hidden behind a
  // 2-row scroll — height tracks the wrapped line count (min 2 rows, max ~12).
  const textRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const ta = textRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 260)}px`;
  }, [content]);

  const preset: LetterPreset | "none" = anim?.preset ?? "none";

  const commitContent = () => {
    if (content !== content0 || size !== size0) onContent(layerId, content, size);
  };

  const pickPreset = (p: LetterPreset | "none") => {
    if (p === "none") return onAnim(layerId, null);
    onAnim(layerId, {
      preset: p,
      startMs: anim?.startMs ?? 200,
      durationMs: anim?.durationMs ?? 700,
      staggerMs: anim?.staggerMs ?? 70,
      areaPx: anim?.areaPx ?? 500,
    });
  };

  const setTiming = (patch: Partial<LetterAnimation>) => {
    if (anim) onAnim(layerId, { ...anim, ...patch });
  };

  return (
    <div className="insp-body">
      <label className="insp-field">
        Text
        <textarea
          ref={textRef}
          className="insp-text"
          dir="auto"
          rows={2}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onBlur={commitContent}
        />
      </label>

      <label className="insp-field">
        Font
        <div className="font-row">
          <select
            value={font}
            onMouseDown={onRefreshFonts}
            onChange={(e) => onFont(layerId, e.target.value as Font)}
          >
            {(fonts.includes(font) ? fonts : [font, ...fonts]).map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
          <button className="insp-btn" title="Re-scan installed fonts" onClick={onRefreshFonts}>
            ↻
          </button>
        </div>
      </label>

      <label className="insp-field">
        Style
        <select
          value={styleKey}
          onChange={(e) => {
            const [w, it] = e.target.value.split(":");
            onFontStyle(layerId, Number(w), it === "true");
          }}
        >
          {faceList.map((f) => (
            <option key={`${f.weight}:${f.italic}`} value={`${f.weight}:${f.italic}`}>
              {f.name}
            </option>
          ))}
        </select>
      </label>

      {effSlider("Size (height)", size, 8, 400, 1, (v) => {
        setSize(v);
        onContent(layerId, content, v);
      })}
      <div className="row2">
        <label className="insp-field">
          <span className="field-label-row">
            Colour
            {colorKeyCount > 0 && (
              <button
                type="button"
                className="key-clear"
                title={`${colorKeyCount} colour keyframe${colorKeyCount === 1 ? "" : "s"} — click to clear`}
                onClick={() => onClearColorKeys(layerId, color)}
              >
                ◆{colorKeyCount}
              </button>
            )}
          </span>
          <input
            type="color"
            className="insp-color"
            value={rgbToHex(color)}
            onChange={(e) => onColor(layerId, hexToRgb(e.target.value))}
          />
        </label>
      </div>

      <TextStyleSection layerId={layerId} style={style} color={color} onSet={onSetTextStyle} />

      <div className="insp-sep">Text animators</div>
      <TextAnimatorsSection layerId={layerId} animators={animators} timeMs={timeMs} onSet={onSetTextAnimators} />

      <div className="insp-sep">Layer styles &amp; 3D</div>
      <TextLayerStylesSection
        layerId={layerId}
        styles={layerStyles}
        perChar3d={perChar3d}
        perCharRx={perCharRx}
        perCharRy={perCharRy}
        perCharSpread={perCharSpread}
        onSet={onSetTextLayerStyles}
        onSet3d={onSetTextPerChar3d}
      />

      <div className="insp-sep">Per-letter effect</div>
      <label className="insp-field">
        Preset
        <select value={preset} onChange={(e) => pickPreset(e.target.value as LetterPreset | "none")}>
          {PRESETS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>

      {anim && (
        <>
          {anim.preset === "scatterIn" &&
            effSlider("Explode area (px)", anim.areaPx, 0, 4000, 20, (v) => setTiming({ areaPx: v }))}
          {effSlider("Start (ms)", anim.startMs, 0, 5000, 10, (v) => setTiming({ startMs: Math.round(v) }))}
          {effSlider("Letter duration (ms)", anim.durationMs, 1, 3000, 10, (v) => setTiming({ durationMs: Math.round(v) }))}
          {effSlider("Stagger per letter (ms)", anim.staggerMs, 0, 1000, 5, (v) => setTiming({ staggerMs: Math.round(v) }))}
          <p className="insp-hint">Scrub or press Play to see the letters animate.</p>
        </>
      )}

      <div className="insp-sep">Decompose (per-letter)</div>
      <button
        className={"insp-btn" + (decomposed ? " active" : "")}
        onClick={() => onToggleDecompose(layerId)}
      >
        {decomposed ? "● Decomposing — done" : "Decompose letters"}
      </button>
      {decomposed && (
        <>
          <p className="insp-hint">
            Click a letter, then drag to move and use the handles to rotate/scale. Esc exits.
          </p>
          <p className="insp-hint">
            Animate it: move the playhead and key <b>Composed</b> where the letters should be
            together, <b>Decomposed</b> where they're apart — it transitions between.
          </p>
          <div className="row2">
            <button className="insp-btn" onClick={() => onDecomposeKey(layerId, 0)}>
              ◆ Composed
            </button>
            <button className="insp-btn" onClick={() => onDecomposeKey(layerId, 1)}>
              ◆ Decomposed
            </button>
          </div>
          {selectedPart != null ? (
            <label className="insp-field">
              <span className="field-label-row">
                Letter #{selectedPart + 1} colour
                <button
                  type="button"
                  className="key-clear"
                  title="Revert this letter to the layer colour"
                  onClick={() => onClearLetterColor(layerId, selectedPart)}
                >
                  reset
                </button>
              </span>
              <input
                type="color"
                className="insp-color"
                value={rgbToHex(letterColorNow ?? color)}
                onChange={(e) => onLetterColor(layerId, selectedPart, hexToRgb(e.target.value))}
              />
            </label>
          ) : (
            <p className="insp-hint">Select a letter to colour it individually.</p>
          )}
          <button className="insp-btn" onClick={() => onClearParts(layerId)}>
            Reset letters
          </button>
        </>
      )}
    </div>
  );
}

const FACE_LABELS = ["Front", "Back", "Left", "Right", "Top", "Bottom"];

export interface ShapeParams {
  width: Track;
  height: Track;
  depth: Track;
  perspective: Track;
  focalLength: Track;
  coverage: Track;
  radius: Track;
}

interface ShapeRef {
  id: number;
  name: string;
  shape: SurfaceShape;
}

// Controls for a Shape3D object: keyframeable 3D rotation (the spin), camera,
// and dimensions. Rotations key the playhead (set_shape_rotation_key); the rest
// is a single set_shape_params call.
function ShapeInspector({
  layerId,
  shape,
  params,
  angles,
  timeMs,
  onShapeParams,
  onShapeRotKey,
}: {
  layerId: number;
  shape: SurfaceShape;
  params: ShapeParams;
  angles: { x: number; y: number; z: number } | null;
  timeMs: number;
  onShapeParams: (layerId: number, p: ShapeParams) => void;
  onShapeRotKey: (
    layerId: number,
    axis: "x" | "y" | "z",
    value: number,
    seedStart: boolean
  ) => void;
}) {
  const set = (p: Partial<ShapeParams>) => onShapeParams(layerId, { ...params, ...p });
  const a = angles ?? { x: 0, y: 0, z: 0 };
  const rotRow = (label: string, axis: "x" | "y" | "z", value: number) => (
    <div className="insp-field">
      <div className="surf-rot-head">
        <span>{label}</span>
        <span className="muted">{Math.round(value)}°</span>
        <button
          className="insp-btn tiny"
          title="Spin in from 0° (keyframe from the layer start to here)"
          onClick={() => onShapeRotKey(layerId, axis, value || 90, true)}
        >
          ◆ spin
        </button>
      </div>
      <input
        type="range"
        min={-180}
        max={180}
        step={1}
        value={value}
        onChange={(e) => onShapeRotKey(layerId, axis, Number(e.target.value), false)}
      />
    </div>
  );

  return (
    <div className="insp-body">
      <div className="insp-sep">{shape === "box" ? "Box" : "Cylinder"} — 3D object</div>
      <p className="insp-hint">
        Move / scale / rotate it on the canvas like any layer. Add images, then
        pin each to this shape from the image's inspector.
      </p>

      <div className="insp-sep">Rotation (keyframe to spin)</div>
      {rotRow("X — tilt", "x", a.x)}
      {rotRow("Y — turn", "y", a.y)}
      {rotRow("Z — roll", "z", a.z)}
      <p className="insp-hint">
        Drag a rotation, move the playhead, drag again → it spins between. Or
        press <b>◆ spin</b> to animate from 0° at the layer start to here.
      </p>

      <div className="insp-sep">Camera</div>
      <KeyNumField label="Perspective" track={params.perspective} tMs={timeMs} min={0} max={1} step={0.01} onChange={(t) => set({ perspective: t })} />
      <KeyNumField label="Focal length" track={params.focalLength} tMs={timeMs} min={100} max={5000} step={50} onChange={(t) => set({ focalLength: t })} />

      <div className="insp-sep">Size (keyframeable)</div>
      <KeyNumField label="Width" track={params.width} tMs={timeMs} min={1} max={4000} onChange={(t) => set({ width: t })} />
      <KeyNumField label="Height" track={params.height} tMs={timeMs} min={1} max={4000} onChange={(t) => set({ height: t })} />
      {shape === "box" ? (
        <KeyNumField label="Depth" track={params.depth} tMs={timeMs} min={0} max={4000} onChange={(t) => set({ depth: t })} />
      ) : (
        <>
          <KeyNumField label="Radius" track={params.radius} tMs={timeMs} min={1} max={4000} onChange={(t) => set({ radius: t })} />
          <KeyNumField label="Coverage°" track={params.coverage} tMs={timeMs} min={10} max={360} step={5} onChange={(t) => set({ coverage: t })} />
        </>
      )}
    </div>
  );
}

// Controls for a layer (image OR text) pinned to a 3D shape: choose the shape +
// face, and place it on the surface. Placement is keyframeable — the sliders key
// the value at the playhead, so moving the playhead and re-placing animates the
// decal across the surface (in-betweens filled automatically). The live values
// come from `placement` (sampled at the playhead by the evaluator).
function DecalControls({
  layerId,
  attach,
  placement,
  visible,
  shapes,
  onAttachToShape,
  onKeyDecal,
  onSetDecalFace,
  onRevealFace,
  onDecalKeyAll,
}: {
  layerId: number;
  attach: Decal | null;
  placement: { u: number; v: number; scale: number; rotation: number } | null;
  visible: boolean;
  shapes: ShapeRef[];
  onAttachToShape: (layerId: number, shapeId: number | null, face: number) => void;
  onKeyDecal: (
    layerId: number,
    prop: "u" | "v" | "scale" | "rotation",
    value: number,
    seedStart: boolean
  ) => void;
  onSetDecalFace: (layerId: number, face: number) => void;
  onRevealFace: (shapeId: number, face: number) => void;
  onDecalKeyAll: (layerId: number) => void;
}) {
  const parent = attach ? shapes.find((s) => s.id === attach.shapeId) ?? null : null;
  const isBox = parent?.shape === "box";
  const p = placement ?? { u: 0.5, v: 0.5, scale: 0.5, rotation: 0 };

  return (
    <div className="insp-body">
      <div className="insp-sep">On 3D surface</div>
      {shapes.length === 0 && (
        <p className="insp-hint">
          Add a Box or Cylinder, then pin this here — or right-click the shape →
          Insert — to map it onto the surface.
        </p>
      )}
      {shapes.length > 0 && (
        <label className="insp-field">
          Pin to shape
          <select
            value={attach ? String(attach.shapeId) : "none"}
            onChange={(e) => {
              const v = e.target.value;
              onAttachToShape(layerId, v === "none" ? null : Number(v), attach?.face ?? 0);
            }}
          >
            <option value="none">Flat (not pinned)</option>
            {shapes.map((s) => (
              <option key={s.id} value={String(s.id)}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {attach && (
        <>
          {isBox && (
            <label className="insp-field">
              Face
              <select
                value={String(attach.face)}
                onChange={(e) => onSetDecalFace(layerId, Number(e.target.value))}
              >
                {FACE_LABELS.map((lbl, i) => (
                  <option key={lbl} value={String(i)}>
                    {lbl}
                  </option>
                ))}
              </select>
            </label>
          )}
          {isBox && (
            <button
              className="insp-btn"
              onClick={() => onRevealFace(attach.shapeId, attach.face)}
            >
              ⟳ Turn box to this face
            </button>
          )}
          {isBox && !visible && (
            <p className="insp-hint">
              This face ({FACE_LABELS[attach.face] ?? attach.face}) is turned away
              from the camera, so it isn't drawn. Click “Turn box to this face”, or
              rotate the box, to bring it into view.
            </p>
          )}
          <p className="insp-hint">
            On the canvas: drag the round handle to move it, the square to size
            it. Move the playhead and re-place to animate — in-betweens are built
            for you.
          </p>
          <label className="insp-field">
            {isBox ? "Size" : "Height (wrap)"} {p.scale.toFixed(2)}
            <input
              type="range"
              min={0.05}
              max={4}
              step={0.01}
              value={p.scale}
              onChange={(e) => onKeyDecal(layerId, "scale", Number(e.target.value), false)}
            />
          </label>
          {isBox && (
            <label className="insp-field">
              Rotation {Math.round(p.rotation)}°
              <input
                type="range"
                min={-180}
                max={180}
                step={1}
                value={p.rotation}
                onChange={(e) => onKeyDecal(layerId, "rotation", Number(e.target.value), false)}
              />
            </label>
          )}
          <div className="row2">
            <label className="insp-field">
              Across (u) {p.u.toFixed(2)}
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={p.u}
                onChange={(e) => onKeyDecal(layerId, "u", Number(e.target.value), false)}
              />
            </label>
            <label className="insp-field">
              Down (v) {p.v.toFixed(2)}
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={p.v}
                onChange={(e) => onKeyDecal(layerId, "v", Number(e.target.value), false)}
              />
            </label>
          </div>
          <button className="insp-btn" onClick={() => onDecalKeyAll(layerId)}>
            ◆ Key placement here
          </button>
        </>
      )}
    </div>
  );
}

const EFFECT_TYPES: { kind: string; label: string }[] = [
  { kind: "grayscale", label: "Black & white" },
  { kind: "brightness", label: "Brightness" },
  { kind: "contrast", label: "Contrast" },
  { kind: "saturate", label: "Saturation" },
  { kind: "blur", label: "Blur" },
  { kind: "hue", label: "Hue shift" },
  { kind: "invert", label: "Invert" },
  { kind: "wipe", label: "Wipe / fade" },
  { kind: "shinyclouds", label: "Shiny clouds (GPU)" },
  { kind: "caustics", label: "Caustics (GPU)" },
  { kind: "lensflare", label: "Lens flare (GPU)" },
  { kind: "sparkle", label: "Sparkle (GPU)" },
  { kind: "heathaze", label: "Heat haze (GPU)" },
  { kind: "filmgrain", label: "Film grain (GPU)" },
  { kind: "vignette", label: "Vignette (GPU)" },
  { kind: "shimmer", label: "Shimmer (GPU)" },
  { kind: "aurora", label: "Aurora (GPU)" },
  { kind: "fog", label: "Fog / smoke (GPU)" },
  { kind: "flap", label: "Flap / 3D flip (GPU)" },
];

// Per-GPU-effect UI schema: how the seven generic slots + colours + position map
// to named, labelled sliders for each `effect` index (keyed to gpuOverlay.frag).
type GpuKey = "intensity" | "scale" | "speed" | "detail" | "softness" | "extra" | "opacity";
type GpuSlider = { key: GpuKey; label: string; min: number; max: number; step: number };
type GpuSchema = { name: string; sliders: GpuSlider[]; colors: 0 | 1 | 2; pos: boolean };
const GPU_FX: Record<number, GpuSchema> = {
  1: { name: "Caustics", colors: 1, pos: false, sliders: [
    { key: "intensity", label: "Intensity", min: 0, max: 2, step: 0.01 },
    { key: "scale", label: "Scale", min: 0.5, max: 5, step: 0.01 },
    { key: "speed", label: "Speed", min: 0, max: 2, step: 0.01 },
    { key: "detail", label: "Sharpness", min: 1, max: 10, step: 0.1 },
    { key: "opacity", label: "Opacity", min: 0, max: 1, step: 0.01 },
  ] },
  2: { name: "Lens flare", colors: 1, pos: true, sliders: [
    { key: "intensity", label: "Intensity", min: 0, max: 2, step: 0.01 },
    { key: "extra", label: "Size", min: 0.1, max: 1, step: 0.01 },
    { key: "speed", label: "Drift speed", min: 0, max: 2, step: 0.01 },
    { key: "softness", label: "Streak", min: 0, max: 1, step: 0.01 },
    { key: "opacity", label: "Opacity", min: 0, max: 1, step: 0.01 },
  ] },
  3: { name: "Sparkle", colors: 1, pos: false, sliders: [
    { key: "intensity", label: "Intensity", min: 0, max: 2, step: 0.01 },
    { key: "detail", label: "Density", min: 5, max: 120, step: 1 },
    { key: "extra", label: "Size", min: 0.02, max: 0.4, step: 0.005 },
    { key: "speed", label: "Twinkle speed", min: 0, max: 5, step: 0.01 },
    { key: "opacity", label: "Opacity", min: 0, max: 1, step: 0.01 },
  ] },
  4: { name: "Heat haze", colors: 0, pos: false, sliders: [
    { key: "extra", label: "Strength", min: 0, max: 0.1, step: 0.001 },
    { key: "scale", label: "Scale", min: 1, max: 20, step: 0.1 },
    { key: "speed", label: "Speed", min: 0, max: 3, step: 0.01 },
    { key: "detail", label: "Detail", min: 1, max: 5, step: 1 },
    { key: "opacity", label: "Opacity", min: 0, max: 1, step: 0.01 },
  ] },
  5: { name: "Film grain", colors: 1, pos: false, sliders: [
    { key: "intensity", label: "Intensity", min: 0, max: 0.5, step: 0.005 },
    { key: "extra", label: "Grain size", min: 1, max: 10, step: 0.1 },
    { key: "speed", label: "Speed", min: 0, max: 1, step: 0.01 },
    { key: "softness", label: "Monochrome", min: 0, max: 1, step: 0.01 },
    { key: "opacity", label: "Opacity", min: 0, max: 1, step: 0.01 },
  ] },
  6: { name: "Vignette", colors: 1, pos: false, sliders: [
    { key: "intensity", label: "Intensity", min: 0, max: 1, step: 0.01 },
    { key: "softness", label: "Radius", min: 0.5, max: 1.5, step: 0.01 },
    { key: "extra", label: "Edge softness", min: 0.05, max: 1, step: 0.01 },
    { key: "detail", label: "Pulse", min: 0, max: 0.3, step: 0.005 },
    { key: "speed", label: "Pulse speed", min: 0, max: 2, step: 0.01 },
  ] },
  7: { name: "Shimmer", colors: 2, pos: false, sliders: [
    { key: "intensity", label: "Intensity", min: 0, max: 2, step: 0.01 },
    { key: "speed", label: "Speed", min: 0, max: 2, step: 0.01 },
    { key: "detail", label: "Frequency", min: 1, max: 10, step: 0.1 },
    { key: "opacity", label: "Opacity", min: 0, max: 1, step: 0.01 },
  ] },
  8: { name: "Aurora", colors: 2, pos: false, sliders: [
    { key: "intensity", label: "Intensity", min: 0, max: 2, step: 0.01 },
    { key: "scale", label: "Scale", min: 0.5, max: 5, step: 0.01 },
    { key: "speed", label: "Speed", min: 0, max: 2, step: 0.01 },
    { key: "extra", label: "Width", min: 0.05, max: 1, step: 0.01 },
    { key: "detail", label: "Complexity", min: 1, max: 5, step: 1 },
    { key: "opacity", label: "Opacity", min: 0, max: 1, step: 0.01 },
  ] },
  9: { name: "Fog / smoke", colors: 1, pos: false, sliders: [
    { key: "intensity", label: "Intensity", min: 0, max: 2, step: 0.01 },
    { key: "scale", label: "Scale", min: 0.5, max: 5, step: 0.01 },
    { key: "speed", label: "Speed", min: 0, max: 2, step: 0.01 },
    { key: "softness", label: "Density", min: 0, max: 1, step: 0.01 },
    { key: "detail", label: "Complexity", min: 2, max: 6, step: 1 },
    { key: "opacity", label: "Opacity", min: 0, max: 1, step: 0.01 },
  ] },
  10: { name: "Flap / 3D flip", colors: 0, pos: false, sliders: [
    { key: "detail", label: "Angle°", min: -360, max: 360, step: 1 },
    { key: "extra", label: "Perspective", min: 0, max: 1, step: 0.01 },
    { key: "opacity", label: "Opacity", min: 0, max: 1, step: 0.01 },
  ] },
};

type EffectParam =
  | "amount"
  | "radius"
  | "degrees"
  | "position"
  | "softness"
  | "intensity"
  | "scale"
  | "speed"
  | "complexity"
  | "contrast"
  | "brightness"
  | "opacity"
  | "detail"
  | "extra";
type KeyEffect = (
  layerId: number,
  index: number,
  param: EffectParam,
  value: number,
  seedStart: boolean
) => void;
type SetWipeStatic = (layerId: number, index: number, angle: number, invert: boolean) => void;
type SetShineStatic = (layerId: number, index: number, tint: Rgba, blend: number) => void;
type SetGpuFxStatic = (
  layerId: number,
  index: number,
  effect: number,
  tint: Rgba,
  tint2: Rgba,
  posX: number,
  posY: number,
  blend: number
) => void;

// A collapsible inspector section: shows only its title until expanded. Used to
// keep the panel tidy — collapse the sections you're not working on.
function Section({
  title,
  children,
  defaultOpen = false,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={"insp-body insp-section" + (open ? " open" : "")}>
      <button className="insp-sep insp-sep-toggle" onClick={() => setOpen((o) => !o)}>
        <span className="effect-caret">{open ? "▾" : "▸"}</span>
        {title}
      </button>
      {open && children}
    </div>
  );
}

// Round to the slider's step so typed/dragged values land exactly on increments
// (e.g. step 0.05 → 0.35, never 0.3500001).
function snapToStep(v: number, min: number, step: number): number {
  if (!(step > 0)) return v;
  const snapped = min + Math.round((v - min) / step) * step;
  // Kill float dust from the multiply/add.
  const decimals = (String(step).split(".")[1] ?? "").length;
  return Number(snapped.toFixed(decimals));
}

function effSlider(
  label: string,
  value: number,
  min: number,
  max: number,
  step: number,
  onChange: (v: number) => void
) {
  const set = (v: number) => onChange(snapToStep(Math.max(min, Math.min(max, v)), min, step));
  return (
    <label className="insp-field insp-slider">
      <span className="insp-slider-head">
        <span>{label}</span>
        <input
          className="insp-num"
          type="number"
          min={min}
          max={max}
          step={step}
          value={snapToStep(value, min, step)}
          onChange={(e) => e.target.value !== "" && set(Number(e.target.value))}
        />
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => set(Number(e.target.value))}
      />
    </label>
  );
}

// Layer position / transform: numeric X/Y (pixels, snapped to whole pixels) plus
// scale / rotation / opacity sliders. Every change keyframes at the playhead (the
// same path as dragging on the canvas), so it animates.
// Set a layer's timeline position numerically: its start time and duration (in
// seconds). With several layers selected, the edit applies to all of them (they
// align to the same start / take the same duration).
function TimingSection({
  startMs,
  endMs,
  selectedCount,
  onSetTiming,
}: {
  startMs: number;
  endMs: number;
  selectedCount: number;
  onSetTiming: (startMs: number | null, durMs: number | null) => void;
}) {
  const startS = startMs / 1000;
  const durS = Math.max(0, endMs - startMs) / 1000;
  return (
    <Section title="Timing (timeline)">
      <div className="row2">
        <label className="insp-field">
          Start (s)
          <input
            type="number"
            min={0}
            step={0.1}
            value={Math.round(startS * 1000) / 1000}
            onChange={(e) => onSetTiming(Math.max(0, Math.round(Number(e.target.value) * 1000)), null)}
          />
        </label>
        <label className="insp-field">
          Duration (s)
          <input
            type="number"
            min={0.05}
            step={0.1}
            value={Math.round(durS * 1000) / 1000}
            onChange={(e) => onSetTiming(null, Math.max(50, Math.round(Number(e.target.value) * 1000)))}
          />
        </label>
      </div>
      {selectedCount > 1 && (
        <span className="muted">Applies to all {selectedCount} selected layers.</span>
      )}
    </Section>
  );
}

function TransformSection({
  layerId,
  tr,
  compW,
  compH,
  onCommit,
}: {
  layerId: number;
  tr: { x: number; y: number; scaleX: number; scaleY: number; rotation: number; opacity: number };
  compW: number;
  compH: number;
  onCommit: (layerId: number, edit: TransformEdit) => void;
}) {
  return (
    <Section title="Transform / Position">
      {effSlider("Position X", tr.x, -compW, compW * 2, 1, (v) => onCommit(layerId, { x: Math.round(v) }))}
      {effSlider("Position Y", tr.y, -compH, compH * 2, 1, (v) => onCommit(layerId, { y: Math.round(v) }))}
      {effSlider("Scale X", tr.scaleX, 0.05, 5, 0.05, (v) => onCommit(layerId, { scaleX: v }))}
      {effSlider("Scale Y", tr.scaleY, 0.05, 5, 0.05, (v) => onCommit(layerId, { scaleY: v }))}
      {effSlider("Rotation°", tr.rotation, -360, 360, 1, (v) => onCommit(layerId, { rotation: v }))}
      {effSlider("Opacity", tr.opacity, 0, 1, 0.01, (v) => onCommit(layerId, { opacity: v }))}
      <p className="insp-hint">Nudge the numbers or drag on the canvas — both keyframe here.</p>
    </Section>
  );
}

// One row of the effect stack — the controls vary by effect kind. Live values
// come from the sampled effect; the sliders key at the playhead so effects
// animate (e.g. a wipe's Position swept 0→1).
function EffectRow({
  layerId,
  index,
  eff,
  open,
  onToggle,
  onRemove,
  onKey,
  onSetWipeStatic,
  onSetShineStatic,
  onSetGpuFxStatic,
}: {
  layerId: number;
  index: number;
  eff: ResolvedEffect;
  open: boolean;
  onToggle: (index: number) => void;
  onRemove: (layerId: number, index: number) => void;
  onKey: KeyEffect;
  onSetWipeStatic: SetWipeStatic;
  onSetShineStatic?: SetShineStatic;
  onSetGpuFxStatic?: SetGpuFxStatic;
}) {
  // The 9 GPU-overlay effects all share the resolved kind "gpuoverlay", so the
  // name comes from the per-effect schema; everything else looks up EFFECT_TYPES.
  const label =
    eff.kind === "gpuoverlay"
      ? GPU_FX[eff.effect]?.name ?? "GPU overlay"
      : EFFECT_TYPES.find((t) => t.kind === eff.kind)?.label ?? eff.kind;
  const key = (param: EffectParam, value: number) => onKey(layerId, index, param, value, false);
  let body: ReactNode = null;
  switch (eff.kind) {
    case "grayscale":
    case "invert":
      body = effSlider("Amount", eff.amount, 0, 1, 0.01, (v) => key("amount", v));
      break;
    case "brightness":
      body = effSlider("Brightness", eff.amount, 0, 3, 0.01, (v) => key("amount", v));
      break;
    case "contrast":
      body = effSlider("Contrast", eff.amount, 0, 3, 0.01, (v) => key("amount", v));
      break;
    case "saturate":
      body = effSlider("Saturation", eff.amount, 0, 3, 0.01, (v) => key("amount", v));
      break;
    case "blur":
      body = effSlider("Radius (px)", eff.radius, 0, 50, 0.5, (v) => key("radius", v));
      break;
    case "hue":
      body = effSlider("Degrees", eff.degrees, 0, 360, 1, (v) => key("degrees", v));
      break;
    case "wipe":
      body = (
        <>
          {effSlider("Position", eff.position, 0, 1, 0.01, (v) => key("position", v))}
          {effSlider("Softness", eff.softness, 0, 1, 0.01, (v) => key("softness", v))}
          {effSlider("Angle", eff.angle, 0, 360, 1, (v) =>
            onSetWipeStatic(layerId, index, v, eff.invert)
          )}
          <label className="surf-face">
            <input
              type="checkbox"
              checked={eff.invert}
              onChange={(e) => onSetWipeStatic(layerId, index, eff.angle, e.target.checked)}
            />
            Invert (flip side)
          </label>
          <p className="insp-hint">
            Keyframe <b>Position</b> (move the playhead, drag) to sweep the fade across.
          </p>
        </>
      );
      break;
    case "shinyclouds":
      body = (
        <>
          {effSlider("Intensity", eff.intensity, 0, 2, 0.01, (v) => key("intensity", v))}
          {effSlider("Scale", eff.scale, 0.5, 5, 0.01, (v) => key("scale", v))}
          {effSlider("Speed", eff.speed, 0, 3, 0.01, (v) => key("speed", v))}
          {effSlider("Complexity", eff.complexity, 1, 8, 1, (v) => key("complexity", v))}
          {effSlider("Contrast", eff.contrast, 1, 4, 0.01, (v) => key("contrast", v))}
          {effSlider("Brightness", eff.brightness, -0.5, 0.5, 0.01, (v) => key("brightness", v))}
          {effSlider("Opacity", eff.opacity, 0, 1, 0.01, (v) => key("opacity", v))}
          {onSetShineStatic && (
            <>
              <label className="insp-field">
                Blend
                <select
                  value={eff.blend}
                  onChange={(e) =>
                    onSetShineStatic(layerId, index, eff.tint, Number(e.target.value))
                  }
                >
                  <option value={0}>Add</option>
                  <option value={1}>Screen</option>
                  <option value={2}>Overlay</option>
                  <option value={3}>Soft light</option>
                </select>
              </label>
              <label className="insp-field">
                Tint
                <input
                  type="color"
                  value={rgbaToHex(eff.tint)}
                  onChange={(e) => {
                    const c = hexToRgba(e.target.value);
                    onSetShineStatic(layerId, index, { r: c.r, g: c.g, b: c.b, a: 255 }, eff.blend);
                  }}
                />
              </label>
            </>
          )}
          <p className="insp-hint">
            A GPU (WebGL) light-leak overlay. The clouds drift with the playhead — keyframe{" "}
            <b>Intensity</b> / <b>Speed</b> to animate. Runs on the timeline clock, so it's
            export-accurate (static while paused).
          </p>
        </>
      );
      break;
    case "gpuoverlay": {
      const schema = GPU_FX[eff.effect];
      const setStatic = (patch: { tint?: Rgba; tint2?: Rgba; posX?: number; posY?: number; blend?: number }) =>
        onSetGpuFxStatic?.(
          layerId,
          index,
          eff.effect,
          patch.tint ?? eff.tint,
          patch.tint2 ?? eff.tint2,
          patch.posX ?? eff.posX,
          patch.posY ?? eff.posY,
          patch.blend ?? eff.blend
        );
      body = schema ? (
        <>
          {schema.sliders.map((sl) =>
            effSlider(sl.label, eff[sl.key], sl.min, sl.max, sl.step, (v) => key(sl.key, v))
          )}
          {onSetGpuFxStatic && schema.colors >= 1 && (
            <label className="insp-field">
              {schema.colors === 2 ? "Colour A" : "Colour"}
              <input
                type="color"
                value={rgbaToHex(eff.tint)}
                onChange={(e) => {
                  const c = hexToRgba(e.target.value);
                  setStatic({ tint: { r: c.r, g: c.g, b: c.b, a: 255 } });
                }}
              />
            </label>
          )}
          {onSetGpuFxStatic && schema.colors === 2 && (
            <label className="insp-field">
              Colour B
              <input
                type="color"
                value={rgbaToHex(eff.tint2)}
                onChange={(e) => {
                  const c = hexToRgba(e.target.value);
                  setStatic({ tint2: { r: c.r, g: c.g, b: c.b, a: 255 } });
                }}
              />
            </label>
          )}
          {onSetGpuFxStatic && schema.pos && (
            <>
              {effSlider("Position X", eff.posX, 0, 1, 0.01, (v) => setStatic({ posX: v }))}
              {effSlider("Position Y", eff.posY, 0, 1, 0.01, (v) => setStatic({ posY: v }))}
            </>
          )}
          {onSetGpuFxStatic && eff.effect === 10 && (
            <>
              <label className="insp-field">
                Axis (hinge)
                <select value={eff.blend} onChange={(e) => setStatic({ blend: Number(e.target.value) })}>
                  <option value={0}>Horizontal — flap up/down</option>
                  <option value={1}>Vertical — flap left/right</option>
                </select>
              </label>
              {effSlider("Axis position", eff.posX, 0, 1, 0.01, (v) => setStatic({ posX: v }))}
              <p className="insp-hint">
                Drag the dashed line in the preview to move the hinge. Keyframe <b>Angle°</b>{" "}
                from 0 to 360 for a complete flip about the axis (edge-on at 90°/270°, back
                face around 180°).
              </p>
            </>
          )}
          {onSetGpuFxStatic && eff.effect !== 4 && eff.effect !== 6 && eff.effect !== 10 && (
            <label className="insp-field">
              Blend
              <select value={eff.blend} onChange={(e) => setStatic({ blend: Number(e.target.value) })}>
                <option value={0}>Add</option>
                <option value={1}>Screen</option>
                <option value={2}>Overlay</option>
                <option value={3}>Soft light</option>
              </select>
            </label>
          )}
          {eff.effect !== 10 && (
            <p className="insp-hint">
              GPU (WebGL) {schema.name.toLowerCase()} overlay. Runs on the timeline clock —
              keyframe the sliders to animate; static while paused (export-accurate).
            </p>
          )}
        </>
      ) : null;
      break;
    }
  }
  return (
    <div className={"effect-row" + (open ? " open" : "")}>
      <div className="effect-head">
        <button
          className="effect-toggle"
          title={open ? "Collapse" : "Expand"}
          onClick={() => onToggle(index)}
        >
          <span className="effect-caret">{open ? "▾" : "▸"}</span>
          <span className="effect-name">{label}</span>
        </button>
        <button
          className="insp-btn tiny"
          title="Remove effect"
          onClick={() => onRemove(layerId, index)}
        >
          ✕
        </button>
      </div>
      {open && body}
    </div>
  );
}

// The effect stack for a layer: add from the dropdown, then each effect's
// keyframeable controls. Reused by the isolated Effect Editor overlay.
export function EffectsSection({
  layerId,
  effects,
  onAddEffect,
  onRemoveEffect,
  onKeyEffect,
  onSetWipeStatic,
  onSetShineStatic,
  onSetGpuFxStatic,
}: {
  layerId: number;
  effects: ResolvedEffect[];
  onAddEffect: (layerId: number, kind: string) => void;
  onRemoveEffect: (layerId: number, index: number) => void;
  onKeyEffect: KeyEffect;
  onSetWipeStatic: SetWipeStatic;
  onSetShineStatic?: SetShineStatic;
  onSetGpuFxStatic?: SetGpuFxStatic;
}) {
  // Accordion: only one effect's details show at a time, so the stack stays tidy
  // and you focus on the effect you're editing. Adding one opens it automatically.
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const prevLen = useRef(effects.length);
  useEffect(() => {
    if (effects.length > prevLen.current) setOpenIdx(effects.length - 1);
    else if (openIdx != null && openIdx >= effects.length) setOpenIdx(null);
    prevLen.current = effects.length;
  }, [effects.length, openIdx]);
  const toggle = (i: number) => setOpenIdx((cur) => (cur === i ? null : i));
  return (
    <Section title="Effects">
      <label className="insp-field">
        Add effect
        <SearchSelect
          value=""
          buttonLabel="＋ Add effect…"
          favKey="effects"
          groups={[{ category: "Effects", items: EFFECT_TYPES.map((t) => ({ id: t.kind, label: t.label })) }]}
          onChange={(kind) => onAddEffect(layerId, kind)}
        />
      </label>
      {effects.length === 0 && (
        <p className="insp-hint">
          Add black &amp; white, blur, a left→right wipe, brightness… they stack in order.
        </p>
      )}
      {effects.map((eff, i) => (
        <EffectRow
          key={i}
          layerId={layerId}
          index={i}
          eff={eff}
          open={openIdx === i}
          onToggle={toggle}
          onRemove={onRemoveEffect}
          onKey={onKeyEffect}
          onSetWipeStatic={onSetWipeStatic}
          onSetShineStatic={onSetShineStatic}
          onSetGpuFxStatic={onSetGpuFxStatic}
        />
      ))}
    </Section>
  );
}

function rgbaToHex(v: unknown): string {
  const c = (v ?? {}) as { r?: number; g?: number; b?: number };
  const h = (n?: number) => Math.max(0, Math.min(255, Math.round(n ?? 0))).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}
function hexToRgba(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return { r: 0, g: 0, b: 0 };
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

// Per-transition variable controls (the math knobs), generated from the engine's
// parameter schema. `direction`/`easing`/`fit`/`preferGpu` are handled elsewhere
// (or fixed), so they're excluded here. Values are stored as a JSON object.
function TransitionVars({
  id,
  paramsJson,
  onChange,
}: {
  id: string;
  paramsJson?: string | null;
  onChange: (json: string) => void;
}) {
  const meta = getTransitionMeta(id);
  if (!meta) return null;
  const specs = meta.params.filter(
    (p: ParamSpec) => !["easing", "fit", "preferGpu", "direction"].includes(p.name)
  );
  if (specs.length === 0) return null;
  let cur: Record<string, unknown> = {};
  try {
    cur = paramsJson ? (JSON.parse(paramsJson) as Record<string, unknown>) : {};
  } catch {
    cur = {};
  }
  const set = (name: string, val: unknown) => onChange(JSON.stringify({ ...cur, [name]: val }));
  return (
    <div className="tr-vars">
      {specs.map((s) => {
        const v = cur[s.name] ?? s.default;
        return (
          <label key={s.name} className="tr-var" title={s.description}>
            <span className="tr-var-name">{s.label}</span>
            {s.type === "number" && (
              <>
                <input
                  type="range"
                  min={s.min ?? 0}
                  max={s.max ?? 1}
                  step={s.step ?? 0.01}
                  value={Number(v)}
                  onChange={(e) => set(s.name, Number(e.target.value))}
                />
                <em className="tr-var-val">{Number(v)}</em>
              </>
            )}
            {s.type === "bool" && (
              <input type="checkbox" checked={!!v} onChange={(e) => set(s.name, e.target.checked)} />
            )}
            {s.type === "enum" && (
              <select value={String(v)} onChange={(e) => set(s.name, e.target.value)}>
                {(s.options ?? []).map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            )}
            {s.type === "color" && (
              <input
                type="color"
                value={rgbaToHex(v)}
                onChange={(e) => set(s.name, hexToRgba(e.target.value))}
              />
            )}
          </label>
        );
      })}
      <button className="tr-var-reset" onClick={() => onChange("{}")} title="Reset to defaults">
        Reset variables
      </button>
    </div>
  );
}

// In/out transition controls for the selected layer: pick a transition from the
// library for the In/Out slot, then tune its duration, direction and variables.
function TransitionsSection({
  layer,
  onSet,
  title = "Transitions",
  hint,
}: {
  layer: Layer;
  onSet: SetLayerTransition;
  title?: string;
  hint?: string;
}) {
  const slots: { slot: TransitionSlot; tr: Layer["transitionIn"] }[] = [
    { slot: "in", tr: layer.transitionIn },
    { slot: "out", tr: layer.transitionOut },
  ];
  // Each In/Out slot is a collapsible disclosure — collapsed shows just the slot
  // + its current transition name; expand to edit. Defaults open when a
  // transition is already set, until you toggle it.
  const [openSlots, setOpenSlots] = useState<Record<string, boolean>>({});
  return (
    <Section title={title}>
      {slots.map(({ slot, tr }) => {
        const durMs = tr?.durMs ?? 800;
        const direction = tr?.direction ?? 0;
        const paramsJson = tr?.params ?? null;
        // The picker value is the engine id; legacy kinds map onto one.
        const value = !tr
          ? "none"
          : tr.engine ?? LEGACY_TO_ENGINE[tr.kind] ?? "none";
        const open = openSlots[slot] ?? tr != null;
        const curLabel =
          value === "none" ? "None" : getTransitionMeta(value)?.label ?? value;
        const onPick = (id: string) => {
          // Picking a (different) transition resets its variables to defaults.
          if (id === "none") onSet(layer.id, slot, "none", durMs, direction, null, null);
          else onSet(layer.id, slot, "dissolve", durMs, direction, id, id === value ? paramsJson : null);
        };
        return (
          <div key={slot} className={"insp-disc" + (open ? " open" : "")}>
            <button
              className="insp-disc-head"
              onClick={() => setOpenSlots((s) => ({ ...s, [slot]: !open }))}
            >
              <span className="effect-caret">{open ? "▾" : "▸"}</span>
              <span className="insp-disc-title" style={{ textTransform: "capitalize" }}>
                {slot}
              </span>
              <span className="insp-disc-badge">{curLabel}</span>
            </button>
            {open && (
            <div className="insp-field">
            <SearchSelect
              value={value}
              favKey="transitions"
              placeholder="None"
              groups={TRANSITION_SEL_GROUPS}
              onChange={onPick}
            />
            {value !== "none" && (
              <>
                {effSlider("Duration (ms)", durMs, 0, 10000, 50, (v) =>
                  onSet(layer.id, slot, "dissolve", Math.round(v), direction, value, paramsJson)
                )}
                <label className="insp-field">
                  Direction
                  <select
                    value={direction}
                    title="Direction (used by directional transitions)"
                    onChange={(e) =>
                      onSet(layer.id, slot, "dissolve", durMs, Number(e.target.value), value, paramsJson)
                    }
                  >
                    <option value={0}>From left</option>
                    <option value={1}>From right</option>
                    <option value={2}>From top</option>
                    <option value={3}>From bottom</option>
                  </select>
                </label>
                <TransitionVars
                  id={value}
                  paramsJson={paramsJson}
                  onChange={(json) => onSet(layer.id, slot, "dissolve", durMs, direction, value, json)}
                />
              </>
            )}
            </div>
            )}
          </div>
        );
      })}
      <p className="insp-hint">
        {hint ??
          "In plays over the layer's start, Out over its end. Pick any effect from the transition library — it reveals the layers beneath. Overlap a layer beneath to cross-blend."}
      </p>
    </Section>
  );
}

interface Props {
  layer: Layer | null;
  timeMs: number;
  compWidth: number;
  compHeight: number;
  /** How many layers are selected (for the timing "applies to N" note). */
  selectedCount: number;
  /** Set the selection's start and/or duration (ms; null = leave unchanged). */
  onSetTiming: (startMs: number | null, durMs: number | null) => void;
  fonts: string[];
  onRefreshFonts: () => void;
  decomposed: boolean;
  shapes: ShapeRef[];
  shapeAngles: { x: number; y: number; z: number } | null;
  decalPlacement: { u: number; v: number; scale: number; rotation: number } | null;
  decalVisible: boolean;
  resolvedEffects: ResolvedEffect[];
  onAddEffect: (layerId: number, kind: string) => void;
  onRemoveEffect: (layerId: number, index: number) => void;
  onKeyEffect: KeyEffect;
  onSetWipeStatic: SetWipeStatic;
  onSetShineStatic: SetShineStatic;
  onSetGpuFxStatic: SetGpuFxStatic;
  onShapeParams: (layerId: number, p: ShapeParams) => void;
  onShapeRotKey: (
    layerId: number,
    axis: "x" | "y" | "z",
    value: number,
    seedStart: boolean
  ) => void;
  onSetShape2d: (layerId: number, style: Shape2DStyle) => void;
  onAttachToShape: (layerId: number, shapeId: number | null, face: number) => void;
  onKeyDecal: (
    layerId: number,
    prop: "u" | "v" | "scale" | "rotation",
    value: number,
    seedStart: boolean
  ) => void;
  onSetDecalFace: (layerId: number, face: number) => void;
  onRevealFace: (shapeId: number, face: number) => void;
  onDecalKeyAll: (layerId: number) => void;
  textColorNow: Rgba | null;
  onContent: (layerId: number, content: string, size: number) => void;
  onColor: (layerId: number, color: Rgba) => void;
  onClearColorKeys: (layerId: number, color: Rgba) => void;
  onFont: (layerId: number, font: Font) => void;
  onFontStyle: (layerId: number, weight: number, italic: boolean) => void;
  onAnim: (layerId: number, anim: LetterAnimation | null) => void;
  onSetTextStyle: (layerId: number, style: TextStyle | null) => void;
  onSetTextAnimators: (layerId: number, animators: TextAnimator[]) => void;
  onSetTextLayerStyles: (layerId: number, styles: TextLayerStyles | null) => void;
  onSetTextPerChar3d: (layerId: number, enabled: boolean, rx: number, ry: number, spread: number) => void;
  onToggleDecompose: (layerId: number) => void;
  onClearParts: (layerId: number) => void;
  onDecomposeKey: (layerId: number, value: number) => void;
  selectedPart: number | null;
  letterColorNow: Rgba | null;
  onLetterColor: (layerId: number, index: number, color: Rgba) => void;
  onClearLetterColor: (layerId: number, index: number) => void;
  onSetLayerTransition: SetLayerTransition;
  /** The selected layer's transform sampled at the playhead (for the Position/
   *  Transform readouts), or null when nothing is selected. */
  transformNow: { x: number; y: number; scaleX: number; scaleY: number; rotation: number; opacity: number } | null;
  /** Keyframe a transform edit at the playhead (numeric position/scale fields). */
  onCommitTransform: (layerId: number, edit: TransformEdit) => void;
  /** Selected grid cell (row-major index) for a FrameGrid layer, or null. */
  selectedCell: number | null;
  /** The selected cell's zoom at the playhead (for the slider readout). */
  cellZoomNow: number | null;
  /** The selected cell's image pan at the playhead (for the slider readouts). */
  cellPanNow: { x: number; y: number } | null;
  /** Whether the selected cell is a merged block (spans > 1). */
  cellMerged: boolean;
  /** The selected cell's resolved effect stack (at the playhead). */
  cellEffects: ResolvedEffect[];
  onSetCellImage: (layerId: number, cell: number) => void;
  onClearCellImage: (layerId: number, cell: number) => void;
  onSetCellZoom: (layerId: number, cell: number, zoom: number) => void;
  onSetCellPan: (layerId: number, cell: number, x: number, y: number) => void;
  cellTransitionIn: Transition | null;
  cellTransitionOut: Transition | null;
  onSetCellTransition: (
    layerId: number,
    cell: number,
    slot: "in" | "out",
    durMs: number,
    direction: number,
    engine: string | null,
    params: string | null
  ) => void;
  allCellsTransitionIn: Transition | null;
  allCellsTransitionOut: Transition | null;
  onSetAllCellsTransition: (
    layerId: number,
    slot: "in" | "out",
    durMs: number,
    direction: number,
    engine: string | null,
    params: string | null
  ) => void;
  onSetGridConstrain: (layerId: number, mode: "freeform" | "rails") => void;
  lineWidth: number;
  lineColor: Rgba;
  hasBackground: boolean;
  onSetGridBackground: (layerId: number) => void;
  onClearGridBackground: (layerId: number) => void;
  onSetGridLineWidth: (layerId: number, width: number) => void;
  onSetGridLineColor: (layerId: number, color: Rgba) => void;
  onClearGridLineColor: (layerId: number, color: Rgba) => void;
  onMergeCell: (layerId: number, cell: number, dir: "right" | "down") => void;
  onSplitCell: (layerId: number, cell: number) => void;
  onAddCellEffect: (layerId: number, cell: number, kind: string) => void;
  onRemoveCellEffect: (layerId: number, cell: number, index: number) => void;
  onKeyCellEffect: (
    layerId: number,
    cell: number,
    index: number,
    param: EffectParam,
    value: number,
    seedStart: boolean
  ) => void;
  onSetCellWipeStatic: (layerId: number, cell: number, index: number, angle: number, invert: boolean) => void;
  onSetCellShineStatic: (layerId: number, cell: number, index: number, tint: Rgba, blend: number) => void;
  onSetCellGpuFxStatic: (layerId: number, cell: number, index: number, effect: number, tint: Rgba, tint2: Rgba, posX: number, posY: number, blend: number) => void;
  gridLinked: ResolvedLinkedEffect[];
  onLinkEffect: (layerId: number, kind: string, cells: number[]) => void;
  onAddLinkedEffect: (layerId: number, groupId: number, kind: string) => void;
  onRemoveLinkedEffectItem: (layerId: number, groupId: number, index: number) => void;
  onKeyLinkedEffect: (
    layerId: number,
    groupId: number,
    index: number,
    param: EffectParam,
    value: number,
    seedStart: boolean
  ) => void;
  onSetLinkedWipeStatic: (layerId: number, groupId: number, index: number, angle: number, invert: boolean) => void;
  onRemoveLinkedGroup: (layerId: number, groupId: number) => void;
  onSetLinkedMember: (layerId: number, groupId: number, cell: number, member: boolean) => void;
  onUnlinkCell: (layerId: number, groupId: number, cell: number) => void;
}

/** Multi-frame grid controls: grid size + set/clear the selected cell's image. */
function FrameGridSection({
  layer,
  onSetLayerTransition,
  layerId,
  rows,
  cols,
  hasImage,
  selectedCell,
  cellZoomNow,
  cellPanNow,
  cellMerged,
  cellEffects,
  constrain,
  onSetCellImage,
  onClearCellImage,
  onSetCellZoom,
  onSetCellPan,
  cellTransitionIn,
  cellTransitionOut,
  onSetCellTransition,
  allCellsTransitionIn,
  allCellsTransitionOut,
  onSetAllCellsTransition,
  onSetGridConstrain,
  lineWidth,
  lineColor,
  onSetGridLineWidth,
  onSetGridLineColor,
  onClearGridLineColor,
  hasBackground,
  onSetGridBackground,
  onClearGridBackground,
  onMergeCell,
  onSplitCell,
  onAddCellEffect,
  onRemoveCellEffect,
  onKeyCellEffect,
  onSetCellWipeStatic,
  onSetCellShineStatic,
  onSetCellGpuFxStatic,
  gridLinked,
  onLinkEffect,
  onAddLinkedEffect,
  onRemoveLinkedEffectItem,
  onKeyLinkedEffect,
  onSetLinkedWipeStatic,
  onRemoveLinkedGroup,
  onSetLinkedMember,
  onUnlinkCell,
}: {
  layer: Layer;
  onSetLayerTransition: SetLayerTransition;
  layerId: number;
  rows: number;
  cols: number;
  hasImage: boolean;
  selectedCell: number | null;
  cellZoomNow: number | null;
  cellPanNow: { x: number; y: number } | null;
  cellMerged: boolean;
  cellEffects: ResolvedEffect[];
  constrain: "freeform" | "rails";
  onSetCellImage: (layerId: number, cell: number) => void;
  onClearCellImage: (layerId: number, cell: number) => void;
  onSetCellZoom: (layerId: number, cell: number, zoom: number) => void;
  onSetCellPan: (layerId: number, cell: number, x: number, y: number) => void;
  cellTransitionIn: Transition | null;
  cellTransitionOut: Transition | null;
  onSetCellTransition: (
    layerId: number,
    cell: number,
    slot: "in" | "out",
    durMs: number,
    direction: number,
    engine: string | null,
    params: string | null
  ) => void;
  allCellsTransitionIn: Transition | null;
  allCellsTransitionOut: Transition | null;
  onSetAllCellsTransition: (
    layerId: number,
    slot: "in" | "out",
    durMs: number,
    direction: number,
    engine: string | null,
    params: string | null
  ) => void;
  onSetGridConstrain: (layerId: number, mode: "freeform" | "rails") => void;
  lineWidth: number;
  lineColor: Rgba;
  hasBackground: boolean;
  onSetGridBackground: (layerId: number) => void;
  onClearGridBackground: (layerId: number) => void;
  onSetGridLineWidth: (layerId: number, width: number) => void;
  onSetGridLineColor: (layerId: number, color: Rgba) => void;
  onClearGridLineColor: (layerId: number, color: Rgba) => void;
  onMergeCell: (layerId: number, cell: number, dir: "right" | "down") => void;
  onSplitCell: (layerId: number, cell: number) => void;
  onAddCellEffect: (layerId: number, cell: number, kind: string) => void;
  onRemoveCellEffect: (layerId: number, cell: number, index: number) => void;
  onKeyCellEffect: (
    layerId: number,
    cell: number,
    index: number,
    param: EffectParam,
    value: number,
    seedStart: boolean
  ) => void;
  onSetCellWipeStatic: (layerId: number, cell: number, index: number, angle: number, invert: boolean) => void;
  onSetCellShineStatic: (layerId: number, cell: number, index: number, tint: Rgba, blend: number) => void;
  onSetCellGpuFxStatic: (layerId: number, cell: number, index: number, effect: number, tint: Rgba, tint2: Rgba, posX: number, posY: number, blend: number) => void;
  gridLinked: ResolvedLinkedEffect[];
  onLinkEffect: (layerId: number, kind: string, cells: number[]) => void;
  onAddLinkedEffect: (layerId: number, groupId: number, kind: string) => void;
  onRemoveLinkedEffectItem: (layerId: number, groupId: number, index: number) => void;
  onKeyLinkedEffect: (
    layerId: number,
    groupId: number,
    index: number,
    param: EffectParam,
    value: number,
    seedStart: boolean
  ) => void;
  onSetLinkedWipeStatic: (layerId: number, groupId: number, index: number, angle: number, invert: boolean) => void;
  onRemoveLinkedGroup: (layerId: number, groupId: number) => void;
  onSetLinkedMember: (layerId: number, groupId: number, cell: number, member: boolean) => void;
  onUnlinkCell: (layerId: number, groupId: number, cell: number) => void;
}) {
  const cellLabel =
    selectedCell != null ? `row ${Math.floor(selectedCell / cols) + 1}, col ${(selectedCell % cols) + 1}` : null;
  const zoom = cellZoomNow ?? 1;
  const pan = cellPanNow ?? { x: 0, y: 0 };
  return (
    <Section title="Multi-frame grid">
      <p className="insp-hint">
        {cols}×{rows} grid. Click a cell to set its image; drag the blue vertex handles to warp.
        Shift-click handles to select several and drag them together.
      </p>
      <div style={{ display: "flex", gap: 6, alignItems: "center", margin: "4px 0 8px" }}>
        <span className="insp-hint" style={{ margin: 0 }}>Vertex drag:</span>
        <button
          className={constrain === "freeform" ? "insp-btn active" : "insp-btn"}
          onClick={() => onSetGridConstrain(layerId, "freeform")}
        >
          Free-form
        </button>
        <button
          className={constrain === "rails" ? "insp-btn active" : "insp-btn"}
          onClick={() => onSetGridConstrain(layerId, "rails")}
        >
          Rails
        </button>
      </div>
      <div className="insp-field">
        <label>Grid lines</label>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="color"
            value={rgbaToHex(lineColor)}
            title="Line colour (keyframed at the playhead)"
            onChange={(e) => onSetGridLineColor(layerId, { ...hexToRgba(e.target.value), a: 255 })}
          />
          <input
            type="range"
            min={0}
            max={20}
            step={0.5}
            value={lineWidth}
            title="Line thickness (0 = hidden)"
            onChange={(e) => onSetGridLineWidth(layerId, Number(e.target.value))}
            style={{ flex: 1 }}
          />
          <span className="insp-hint" style={{ margin: 0, minWidth: 34, textAlign: "right" }}>
            {lineWidth.toFixed(1)}px
          </span>
          <button
            className="insp-btn"
            title="Clear line-colour keyframes"
            onClick={() => onClearGridLineColor(layerId, lineColor)}
          >
            Clear keys
          </button>
        </div>
      </div>
      <div className="insp-field">
        <label>Background image</label>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button className="insp-btn" onClick={() => onSetGridBackground(layerId)}>
            {hasBackground ? "Replace…" : "Set image…"}
          </button>
          {hasBackground && (
            <button className="insp-btn" onClick={() => onClearGridBackground(layerId)}>
              Clear
            </button>
          )}
        </div>
        <p className="insp-hint">
          {hasBackground
            ? "Each cell shows its aligned slice of this one image — give any cell its own effect to treat that window individually."
            : "Set one image spanning the whole grid; each cell (window) reveals its slice and can take its own effect."}
        </p>
      </div>
      {/* Transition the WHOLE grid as one image (rasterised & transitioned
          together), vs. "all cells" below which transitions each image. */}
      <TransitionsSection
        layer={layer}
        onSet={onSetLayerTransition}
        title="Whole-grid transition"
        hint="Transitions the entire grid as a single image (all cells together). In plays over the grid's start, Out over its end — reveals whatever is beneath."
      />
      <AllCellsTransitionsSection
        layerId={layerId}
        tin={allCellsTransitionIn}
        tout={allCellsTransitionOut}
        onSet={onSetAllCellsTransition}
      />
      {selectedCell == null ? (
        <p className="insp-hint">Click a cell to edit just that image. Transitions above apply to every cell.</p>
      ) : (
        <>
          <div style={{ margin: "4px 0" }}>
            Cell #{selectedCell + 1} ({cellLabel})
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button className="insp-btn" onClick={() => onSetCellImage(layerId, selectedCell)}>
              {hasImage ? "Replace image…" : "Set image…"}
            </button>
            {hasImage && (
              <button className="insp-btn" onClick={() => onClearCellImage(layerId, selectedCell)}>
                Clear
              </button>
            )}
          </div>
          {hasImage && (
            <>
              {effSlider("Zoom", zoom, 0.2, 4, 0.05, (v) => onSetCellZoom(layerId, selectedCell, v))}
              {effSlider("Position X", pan.x, -1, 1, 0.01, (v) =>
                onSetCellPan(layerId, selectedCell, v, pan.y)
              )}
              {effSlider("Position Y", pan.y, -1, 1, 0.01, (v) =>
                onSetCellPan(layerId, selectedCell, pan.x, v)
              )}
            </>
          )}
          <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
            <button className="insp-btn" onClick={() => onMergeCell(layerId, selectedCell, "right")}>
              Merge →
            </button>
            <button className="insp-btn" onClick={() => onMergeCell(layerId, selectedCell, "down")}>
              Merge ↓
            </button>
            {cellMerged && (
              <button className="insp-btn" onClick={() => onSplitCell(layerId, selectedCell)}>
                Split
              </button>
            )}
          </div>
          {(hasImage || hasBackground) && (
            <EffectsSection
              layerId={layerId}
              effects={cellEffects}
              onAddEffect={(lid, kind) => onAddCellEffect(lid, selectedCell, kind)}
              onRemoveEffect={(lid, idx) => onRemoveCellEffect(lid, selectedCell, idx)}
              onKeyEffect={(lid, idx, param, value, seed) => onKeyCellEffect(lid, selectedCell, idx, param, value, seed)}
              onSetWipeStatic={(lid, idx, angle, invert) => onSetCellWipeStatic(lid, selectedCell, idx, angle, invert)}
              onSetShineStatic={(lid, idx, tint, blend) => onSetCellShineStatic(lid, selectedCell, idx, tint, blend)}
              onSetGpuFxStatic={(lid, idx, effect, tint, tint2, posX, posY, blend) =>
                onSetCellGpuFxStatic(lid, selectedCell, idx, effect, tint, tint2, posX, posY, blend)
              }
            />
          )}
          {(hasImage || hasBackground) && (
            <CellTransitionsSection
              layerId={layerId}
              cell={selectedCell}
              tin={cellTransitionIn}
              tout={cellTransitionOut}
              onSet={onSetCellTransition}
            />
          )}
        </>
      )}
      <LinkedEffectsSection
        layerId={layerId}
        rows={rows}
        cols={cols}
        selectedCell={selectedCell}
        gridLinked={gridLinked}
        onLinkEffect={onLinkEffect}
        onAddLinkedEffect={onAddLinkedEffect}
        onRemoveLinkedEffectItem={onRemoveLinkedEffectItem}
        onKeyLinkedEffect={onKeyLinkedEffect}
        onSetLinkedWipeStatic={onSetLinkedWipeStatic}
        onRemoveLinkedGroup={onRemoveLinkedGroup}
        onSetLinkedMember={onSetLinkedMember}
        onUnlinkCell={onUnlinkCell}
      />
    </Section>
  );
}

/** Per-cell in/out transitions — same engine library as layer transitions, played
 *  over the grid layer's start/end so the cell's image assembles in / breaks out. */
function CellTransitionsSection({
  layerId,
  cell,
  tin,
  tout,
  onSet,
}: {
  layerId: number;
  cell: number;
  tin: Transition | null;
  tout: Transition | null;
  onSet: (
    layerId: number,
    cell: number,
    slot: "in" | "out",
    durMs: number,
    direction: number,
    engine: string | null,
    params: string | null
  ) => void;
}) {
  const slots: { slot: "in" | "out"; tr: Transition | null }[] = [
    { slot: "in", tr: tin },
    { slot: "out", tr: tout },
  ];
  const [openSlots, setOpenSlots] = useState<Record<string, boolean>>({});
  return (
    <Section title="Cell transition">
      {slots.map(({ slot, tr }) => {
        const durMs = tr?.durMs ?? 800;
        const direction = tr?.direction ?? 0;
        const paramsJson = tr?.params ?? null;
        const value = tr?.engine ?? LEGACY_TO_ENGINE[tr?.kind ?? ""] ?? "none";
        const open = openSlots[slot] ?? tr != null;
        const curLabel = value === "none" ? "None" : getTransitionMeta(value)?.label ?? value;
        return (
          <div key={slot} className={"insp-disc" + (open ? " open" : "")}>
            <button className="insp-disc-head" onClick={() => setOpenSlots((s) => ({ ...s, [slot]: !open }))}>
              <span className="effect-caret">{open ? "▾" : "▸"}</span>
              <span className="insp-disc-title" style={{ textTransform: "capitalize" }}>{slot}</span>
              <span className="insp-disc-badge">{curLabel}</span>
            </button>
            {open && (
            <div className="insp-field">
            <SearchSelect
              value={value}
              favKey="transitions"
              placeholder="None"
              groups={TRANSITION_SEL_GROUPS}
              onChange={(id) => {
                if (id === "none") onSet(layerId, cell, slot, durMs, direction, null, null);
                else onSet(layerId, cell, slot, durMs, direction, id, id === value ? paramsJson : null);
              }}
            />
            {value !== "none" && (
              <>
                {effSlider("Duration (ms)", durMs, 0, 10000, 50, (v) =>
                  onSet(layerId, cell, slot, Math.round(v), direction, value, paramsJson)
                )}
                <label className="insp-field">
                  Direction
                  <select
                    value={direction}
                    title="Direction"
                    onChange={(e) => onSet(layerId, cell, slot, durMs, Number(e.target.value), value, paramsJson)}
                  >
                    <option value={0}>From left</option>
                    <option value={1}>From right</option>
                    <option value={2}>From top</option>
                    <option value={3}>From bottom</option>
                  </select>
                </label>
                <TransitionVars
                  id={value}
                  paramsJson={paramsJson}
                  onChange={(json) => onSet(layerId, cell, slot, durMs, direction, value, json)}
                />
              </>
            )}
            </div>
            )}
          </div>
        );
      })}
    </Section>
  );
}

/** Apply one transition to EVERY cell of the grid at once (the "add a transition
 *  to all the grid's images" control). Same engine library as per-cell / layer
 *  transitions; writes to all cells in a single undo step. */
function AllCellsTransitionsSection({
  layerId,
  tin,
  tout,
  onSet,
}: {
  layerId: number;
  tin: Transition | null;
  tout: Transition | null;
  onSet: (
    layerId: number,
    slot: "in" | "out",
    durMs: number,
    direction: number,
    engine: string | null,
    params: string | null
  ) => void;
}) {
  const slots: { slot: "in" | "out"; tr: Transition | null }[] = [
    { slot: "in", tr: tin },
    { slot: "out", tr: tout },
  ];
  const [openSlots, setOpenSlots] = useState<Record<string, boolean>>({});
  return (
    <Section title="Transitions — all cells">
      <p className="insp-hint" style={{ margin: 0 }}>
        Applies the chosen transition to every image in the grid.
      </p>
      {slots.map(({ slot, tr }) => {
        const durMs = tr?.durMs ?? 800;
        const direction = tr?.direction ?? 0;
        const paramsJson = tr?.params ?? null;
        const value = tr?.engine ?? LEGACY_TO_ENGINE[tr?.kind ?? ""] ?? "none";
        const open = openSlots[slot] ?? tr != null;
        const curLabel = value === "none" ? "None" : getTransitionMeta(value)?.label ?? value;
        return (
          <div key={slot} className={"insp-disc" + (open ? " open" : "")}>
            <button className="insp-disc-head" onClick={() => setOpenSlots((s) => ({ ...s, [slot]: !open }))}>
              <span className="effect-caret">{open ? "▾" : "▸"}</span>
              <span className="insp-disc-title" style={{ textTransform: "capitalize" }}>{slot}</span>
              <span className="insp-disc-badge">{curLabel}</span>
            </button>
            {open && (
            <div className="insp-field">
            <SearchSelect
              value={value}
              favKey="transitions"
              placeholder="None"
              groups={TRANSITION_SEL_GROUPS}
              onChange={(id) => {
                if (id === "none") onSet(layerId, slot, durMs, direction, null, null);
                else onSet(layerId, slot, durMs, direction, id, id === value ? paramsJson : null);
              }}
            />
            {value !== "none" && (
              <>
                {effSlider("Duration (ms)", durMs, 0, 10000, 50, (v) =>
                  onSet(layerId, slot, Math.round(v), direction, value, paramsJson)
                )}
                <label className="insp-field">
                  Direction
                  <select
                    value={direction}
                    title="Direction"
                    onChange={(e) => onSet(layerId, slot, durMs, Number(e.target.value), value, paramsJson)}
                  >
                    <option value={0}>From left</option>
                    <option value={1}>From right</option>
                    <option value={2}>From top</option>
                    <option value={3}>From bottom</option>
                  </select>
                </label>
                <TransitionVars
                  id={value}
                  paramsJson={paramsJson}
                  onChange={(json) => onSet(layerId, slot, durMs, direction, value, json)}
                />
              </>
            )}
            </div>
            )}
          </div>
        );
      })}
    </Section>
  );
}

/** Shared/linked effect groups: apply one keyframeable effect stack across many
 *  cells at once, toggle which cells it covers, and unlink a cell to diverge. */
function LinkedEffectsSection({
  layerId,
  rows,
  cols,
  selectedCell,
  gridLinked,
  onLinkEffect,
  onAddLinkedEffect,
  onRemoveLinkedEffectItem,
  onKeyLinkedEffect,
  onSetLinkedWipeStatic,
  onRemoveLinkedGroup,
  onSetLinkedMember,
  onUnlinkCell,
}: {
  layerId: number;
  rows: number;
  cols: number;
  selectedCell: number | null;
  gridLinked: ResolvedLinkedEffect[];
  onLinkEffect: (layerId: number, kind: string, cells: number[]) => void;
  onAddLinkedEffect: (layerId: number, groupId: number, kind: string) => void;
  onRemoveLinkedEffectItem: (layerId: number, groupId: number, index: number) => void;
  onKeyLinkedEffect: (
    layerId: number,
    groupId: number,
    index: number,
    param: EffectParam,
    value: number,
    seedStart: boolean
  ) => void;
  onSetLinkedWipeStatic: (layerId: number, groupId: number, index: number, angle: number, invert: boolean) => void;
  onRemoveLinkedGroup: (layerId: number, groupId: number) => void;
  onSetLinkedMember: (layerId: number, groupId: number, cell: number, member: boolean) => void;
  onUnlinkCell: (layerId: number, groupId: number, cell: number) => void;
}) {
  const allCells = Array.from({ length: rows * cols }, (_, i) => i);
  // Accordion open index, per linked group id.
  const [openLinked, setOpenLinked] = useState<Record<number, number | null>>({});
  return (
    <Section title="Linked effects (shared)" defaultOpen={false}>
      <label className="insp-field">
        Link a new effect across all cells
        <select
          value=""
          onChange={(e) => {
            if (e.target.value) onLinkEffect(layerId, e.target.value, allCells);
          }}
        >
          <option value="">＋ Link…</option>
          {EFFECT_TYPES.map((t) => (
            <option key={t.kind} value={t.kind}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
      {gridLinked.length === 0 && (
        <p className="insp-hint">
          A linked effect is one shared, keyframeable stack applied to many cells at once. Toggle
          which cells it covers below; “Unlink” a cell to give it an independent copy.
        </p>
      )}
      {gridLinked.map((g) => (
        <div key={g.id} style={{ border: "1px solid var(--line, #2a2a38)", borderRadius: 6, padding: 8, marginTop: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
            <strong>Group {g.id} · {g.members.length} cell{g.members.length === 1 ? "" : "s"}</strong>
            <button className="insp-btn" title="Delete group" onClick={() => onRemoveLinkedGroup(layerId, g.id)}>
              ✕
            </button>
          </div>
          <label className="insp-field">
            Add to this group
            <select
              value=""
              onChange={(e) => {
                if (e.target.value) onAddLinkedEffect(layerId, g.id, e.target.value);
              }}
            >
              <option value="">＋ Add…</option>
              {EFFECT_TYPES.map((t) => (
                <option key={t.kind} value={t.kind}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          {g.effects.map((eff, i) => (
            <EffectRow
              key={i}
              layerId={layerId}
              index={i}
              eff={eff}
              open={openLinked[g.id] === i}
              onToggle={(idx) =>
                setOpenLinked((s) => ({ ...s, [g.id]: s[g.id] === idx ? null : idx }))
              }
              onRemove={(lid, idx) => onRemoveLinkedEffectItem(lid, g.id, idx)}
              onKey={(lid, idx, param, value, seed) => onKeyLinkedEffect(lid, g.id, idx, param, value, seed)}
              onSetWipeStatic={(lid, idx, angle, invert) => onSetLinkedWipeStatic(lid, g.id, idx, angle, invert)}
            />
          ))}
          <div className="insp-hint" style={{ margin: "6px 0 4px" }}>Applies to (click to toggle):</div>
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 2, maxWidth: cols * 28 }}>
            {allCells.map((ci) => {
              const on = g.members.includes(ci);
              return (
                <button
                  key={ci}
                  onClick={() => onSetLinkedMember(layerId, g.id, ci, !on)}
                  title={`cell ${ci + 1}`}
                  style={{
                    height: 22,
                    borderRadius: 3,
                    cursor: "pointer",
                    background: on ? "var(--accent, #6c8cff)" : "var(--panel-2, #1d1d28)",
                    border: "1px solid var(--line, #2a2a38)",
                    color: on ? "#fff" : "var(--muted, #888)",
                    fontSize: 10,
                  }}
                >
                  {ci + 1}
                </button>
              );
            })}
          </div>
          {selectedCell != null && g.members.includes(selectedCell) && (
            <button className="insp-btn" style={{ marginTop: 6 }} onClick={() => onUnlinkCell(layerId, g.id, selectedCell)}>
              Unlink cell #{selectedCell + 1} (keep as local copy)
            </button>
          )}
        </div>
      ))}
    </Section>
  );
}

export default function Inspector({
  layer,
  timeMs,
  compWidth,
  compHeight,
  selectedCount,
  onSetTiming,
  fonts,
  onRefreshFonts,
  decomposed,
  shapes,
  shapeAngles,
  decalPlacement,
  decalVisible,
  resolvedEffects,
  onAddEffect,
  onRemoveEffect,
  onKeyEffect,
  onSetWipeStatic,
  onSetShineStatic,
  onSetGpuFxStatic,
  onShapeParams,
  onShapeRotKey,
  onSetShape2d,
  onAttachToShape,
  onKeyDecal,
  onSetDecalFace,
  onRevealFace,
  onDecalKeyAll,
  textColorNow,
  onContent,
  onColor,
  onClearColorKeys,
  onFont,
  onFontStyle,
  onAnim,
  onSetTextStyle,
  onSetTextAnimators,
  onSetTextLayerStyles,
  onSetTextPerChar3d,
  onToggleDecompose,
  onClearParts,
  onDecomposeKey,
  selectedPart,
  letterColorNow,
  onLetterColor,
  onClearLetterColor,
  onSetLayerTransition,
  selectedCell,
  cellZoomNow,
  cellPanNow,
  cellMerged,
  cellEffects,
  onSetCellImage,
  onClearCellImage,
  onSetCellZoom,
  onSetCellPan,
  cellTransitionIn,
  cellTransitionOut,
  onSetCellTransition,
  allCellsTransitionIn,
  allCellsTransitionOut,
  onSetAllCellsTransition,
  onSetGridConstrain,
  lineWidth,
  lineColor,
  onSetGridLineWidth,
  onSetGridLineColor,
  onClearGridLineColor,
  hasBackground,
  onSetGridBackground,
  onClearGridBackground,
  onMergeCell,
  onSplitCell,
  onAddCellEffect,
  onRemoveCellEffect,
  onKeyCellEffect,
  onSetCellWipeStatic,
  onSetCellShineStatic,
  onSetCellGpuFxStatic,
  gridLinked,
  onLinkEffect,
  onAddLinkedEffect,
  onRemoveLinkedEffectItem,
  onKeyLinkedEffect,
  onSetLinkedWipeStatic,
  onRemoveLinkedGroup,
  onSetLinkedMember,
  onUnlinkCell,
  transformNow,
  onCommitTransform,
}: Props) {
  const decalControls = layer && (layer.kind.kind === "image" || layer.kind.kind === "text") && (
    <DecalControls
      layerId={layer.id}
      attach={layer.attach}
      placement={decalPlacement}
      visible={decalVisible}
      shapes={shapes}
      onAttachToShape={onAttachToShape}
      onKeyDecal={onKeyDecal}
      onSetDecalFace={onSetDecalFace}
      onRevealFace={onRevealFace}
      onDecalKeyAll={onDecalKeyAll}
    />
  );
  return (
    <aside className="inspector">
      <div className="panel-title">{layer ? layer.name : "Inspector"}</div>
      {!layer && <span className="muted">Select a layer to edit it.</span>}
      {layer && (
        <TimingSection
          startMs={layer.startMs}
          endMs={layer.endMs}
          selectedCount={selectedCount}
          onSetTiming={onSetTiming}
        />
      )}
      {layer && transformNow && (
        <TransformSection layerId={layer.id} tr={transformNow} compW={compWidth} compH={compHeight} onCommit={onCommitTransform} />
      )}
      {layer && layer.kind.kind === "text" && (
        <TextInspector
          layerId={layer.id}
          timeMs={timeMs}
          content={layer.kind.content}
          size={layer.kind.size}
          color={textColorNow ?? layer.kind.color}
          colorKeyCount={layer.kind.colorKeys?.length ?? 0}
          font={layer.kind.font}
          weight={layer.kind.weight}
          italic={layer.kind.italic}
          fonts={fonts}
          onRefreshFonts={onRefreshFonts}
          onFontStyle={onFontStyle}
          anim={layer.kind.anim}
          style={layer.kind.style}
          animators={layer.kind.animators}
          layerStyles={layer.kind.layerStyles}
          perChar3d={layer.kind.perChar3d}
          perCharRx={layer.kind.perCharRx}
          perCharRy={layer.kind.perCharRy}
          perCharSpread={layer.kind.perCharSpread}
          decomposed={decomposed}
          onContent={onContent}
          onColor={onColor}
          onClearColorKeys={onClearColorKeys}
          onFont={onFont}
          onAnim={onAnim}
          onSetTextStyle={onSetTextStyle}
          onSetTextAnimators={onSetTextAnimators}
          onSetTextLayerStyles={onSetTextLayerStyles}
          onSetTextPerChar3d={onSetTextPerChar3d}
          onToggleDecompose={onToggleDecompose}
          onClearParts={onClearParts}
          onDecomposeKey={onDecomposeKey}
          selectedPart={selectedPart}
          letterColorNow={letterColorNow}
          onLetterColor={onLetterColor}
          onClearLetterColor={onClearLetterColor}
        />
      )}
      {layer && layer.kind.kind === "shape3d" && (
        <ShapeInspector
          layerId={layer.id}
          shape={layer.kind.shape}
          params={{
            width: layer.kind.width,
            height: layer.kind.height,
            depth: layer.kind.depth,
            perspective: layer.kind.perspective,
            focalLength: layer.kind.focal_length,
            coverage: layer.kind.coverage,
            radius: layer.kind.radius,
          }}
          angles={shapeAngles}
          timeMs={timeMs}
          onShapeParams={onShapeParams}
          onShapeRotKey={onShapeRotKey}
        />
      )}
      {layer && layer.kind.kind === "shape2d" && (
        <Shape2DSection layerId={layer.id} style={layer.kind.style} timeMs={timeMs} onSet={onSetShape2d} />
      )}
      {decalControls}
      {layer && layer.kind.kind === "image" && (
        <EffectsSection
          layerId={layer.id}
          effects={resolvedEffects}
          onAddEffect={onAddEffect}
          onRemoveEffect={onRemoveEffect}
          onKeyEffect={onKeyEffect}
          onSetWipeStatic={onSetWipeStatic}
          onSetShineStatic={onSetShineStatic}
          onSetGpuFxStatic={onSetGpuFxStatic}
        />
      )}
      {layer && layer.kind.kind === "adjustment" && (
        <>
          <Section title="Adjustment layer">
            <p className="insp-hint">
              Applies its effects to every layer <b>below</b> this one in the stack,
              over its time span. Reorder it in the timeline to change what it affects.
              Add any effect — colour/blur effects re-grade the layers below; shiny
              clouds and pattern effects overlay on top. Layer opacity sets the strength.
            </p>
          </Section>
          <EffectsSection
            layerId={layer.id}
            effects={resolvedEffects}
            onAddEffect={onAddEffect}
            onRemoveEffect={onRemoveEffect}
            onKeyEffect={onKeyEffect}
            onSetWipeStatic={onSetWipeStatic}
            onSetShineStatic={onSetShineStatic}
            onSetGpuFxStatic={onSetGpuFxStatic}
          />
        </>
      )}
      {layer && layer.kind.kind === "colorpatch" && (
        <span className="muted">
          {layer.kind.kind} layer — drag on the canvas to move/scale, ◆ Key to set a keyframe.
        </span>
      )}
      {layer && layer.kind.kind === "framegrid" && (
        <FrameGridSection
          layer={layer}
          onSetLayerTransition={onSetLayerTransition}
          layerId={layer.id}
          rows={layer.kind.rows}
          cols={layer.kind.cols}
          hasImage={selectedCell != null ? !!layer.kind.cells[selectedCell]?.src : false}
          hasBackground={hasBackground}
          selectedCell={selectedCell}
          cellZoomNow={cellZoomNow}
          cellPanNow={cellPanNow}
          cellMerged={cellMerged}
          cellEffects={cellEffects}
          constrain={layer.kind.constrain}
          lineWidth={lineWidth}
          lineColor={lineColor}
          cellTransitionIn={cellTransitionIn}
          cellTransitionOut={cellTransitionOut}
          allCellsTransitionIn={allCellsTransitionIn}
          allCellsTransitionOut={allCellsTransitionOut}
          onSetCellImage={onSetCellImage}
          onClearCellImage={onClearCellImage}
          onSetCellZoom={onSetCellZoom}
          onSetCellPan={onSetCellPan}
          onSetCellTransition={onSetCellTransition}
          onSetAllCellsTransition={onSetAllCellsTransition}
          onSetGridConstrain={onSetGridConstrain}
          onSetGridLineWidth={onSetGridLineWidth}
          onSetGridLineColor={onSetGridLineColor}
          onClearGridLineColor={onClearGridLineColor}
          onSetGridBackground={onSetGridBackground}
          onClearGridBackground={onClearGridBackground}
          onMergeCell={onMergeCell}
          onSplitCell={onSplitCell}
          onAddCellEffect={onAddCellEffect}
          onRemoveCellEffect={onRemoveCellEffect}
          onKeyCellEffect={onKeyCellEffect}
          onSetCellWipeStatic={onSetCellWipeStatic}
          onSetCellShineStatic={onSetCellShineStatic}
          onSetCellGpuFxStatic={onSetCellGpuFxStatic}
          gridLinked={gridLinked}
          onLinkEffect={onLinkEffect}
          onAddLinkedEffect={onAddLinkedEffect}
          onRemoveLinkedEffectItem={onRemoveLinkedEffectItem}
          onKeyLinkedEffect={onKeyLinkedEffect}
          onSetLinkedWipeStatic={onSetLinkedWipeStatic}
          onRemoveLinkedGroup={onRemoveLinkedGroup}
          onSetLinkedMember={onSetLinkedMember}
          onUnlinkCell={onUnlinkCell}
        />
      )}
      {/* Grids get their whole-grid transition inside the grid section instead. */}
      {layer && layer.kind.kind !== "framegrid" && (
        <TransitionsSection layer={layer} onSet={onSetLayerTransition} />
      )}
    </aside>
  );
}
