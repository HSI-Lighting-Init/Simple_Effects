// Right-hand inspector. For text layers it edits content (Arabic/RTL aware),
// font, colour, size (height), and the per-letter animation preset + timing.
import { useEffect, useState, type ReactNode } from "react";
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
      <div className="row2">
        <label className="insp-field">
          Tracking (px)
          <input type="number" step={0.5} value={s.tracking} onChange={(e) => patch({ tracking: Number(e.target.value) })} />
        </label>
        <label className="insp-field">
          Baseline (px)
          <input type="number" step={0.5} value={s.baselineShift} onChange={(e) => patch({ baselineShift: Number(e.target.value) })} />
        </label>
      </div>
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
  start: 0,
  end: 100,
  offset: 0,
  smoothness: 100,
  easeHigh: 0,
  easeLow: 0,
  shape: "square",
  wigglesPerSec: 2,
  amount: 100,
  correlation: 50,
  temporalPhase: 0,
  spatialPhase: 0,
  seed: 1,
};
const DEFAULT_PROPS: AnimProps = {
  position: [0, 0],
  scale: 100,
  rotation: 0,
  skew: 0,
  skewAxis: 0,
  opacity: 100,
  tracking: 0,
  blur: 0,
  fill: null,
  charOffset: 0,
  rotationX: 0,
  rotationY: 0,
  positionZ: 0,
};

// Compact labelled number input.
function NumField({ label, value, step = 1, min, max, onChange }: { label: string; value: number; step?: number; min?: number; max?: number; onChange: (v: number) => void }) {
  return (
    <label className="an-num">
      <span>{label}</span>
      <input type="number" value={value} step={step} min={min} max={max} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

// After Effects-style per-character animators: a stack of selector + properties.
function TextAnimatorsSection({
  layerId,
  animators,
  onSet,
}: {
  layerId: number;
  animators: TextAnimator[];
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
                  <NumField label="Start %" value={sel.start} onChange={(v) => setSel(i, { start: v })} />
                  <NumField label="End %" value={sel.end} onChange={(v) => setSel(i, { end: v })} />
                  <NumField label="Offset %" value={sel.offset} onChange={(v) => setSel(i, { offset: v })} />
                  <NumField label="Smooth %" value={sel.smoothness} min={0} max={100} onChange={(v) => setSel(i, { smoothness: v })} />
                  <NumField label="Ease Hi" value={sel.easeHigh} min={-100} max={100} onChange={(v) => setSel(i, { easeHigh: v })} />
                  <NumField label="Ease Lo" value={sel.easeLow} min={-100} max={100} onChange={(v) => setSel(i, { easeLow: v })} />
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
                <NumField label="Wiggles/s" value={sel.wigglesPerSec} step={0.5} min={0} onChange={(v) => setSel(i, { wigglesPerSec: v })} />
                <NumField label="Amount %" value={sel.amount} min={0} max={100} onChange={(v) => setSel(i, { amount: v })} />
                <NumField label="Correl %" value={sel.correlation} min={0} max={100} onChange={(v) => setSel(i, { correlation: v })} />
                <NumField label="Seed" value={sel.seed} min={1} onChange={(v) => setSel(i, { seed: Math.max(1, Math.round(v)) })} />
              </div>
            )}
            <div className="an-sep">Animate</div>
            <div className="an-grid">
              <NumField label="Pos X" value={p.position[0]} onChange={(v) => setProps(i, { position: [v, p.position[1]] })} />
              <NumField label="Pos Y" value={p.position[1]} onChange={(v) => setProps(i, { position: [p.position[0], v] })} />
              <NumField label="Scale %" value={p.scale} onChange={(v) => setProps(i, { scale: v })} />
              <NumField label="Rotate°" value={p.rotation} onChange={(v) => setProps(i, { rotation: v })} />
              <NumField label="Opacity %" value={p.opacity} min={0} max={100} onChange={(v) => setProps(i, { opacity: v })} />
              <NumField label="Tracking" value={p.tracking} step={0.5} onChange={(v) => setProps(i, { tracking: v })} />
              <NumField label="Skew°" value={p.skew} onChange={(v) => setProps(i, { skew: v })} />
              <NumField label="Skew Axis°" value={p.skewAxis} onChange={(v) => setProps(i, { skewAxis: v })} />
              <NumField label="Blur px" value={p.blur} step={0.5} min={0} onChange={(v) => setProps(i, { blur: v })} />
              <NumField label="Rot X° (3D)" value={p.rotationX} onChange={(v) => setProps(i, { rotationX: v })} />
              <NumField label="Rot Y° (3D)" value={p.rotationY} onChange={(v) => setProps(i, { rotationY: v })} />
              <NumField label="Pos Z (3D)" value={p.positionZ} onChange={(v) => setProps(i, { positionZ: v })} />
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
          Each animator's selector picks characters; its values are the offset at full selection. Scrub/Play to see it move (Wiggly animates on its own; Range animates when you keyframe nothing — drive it via Offset over time in a later build).
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
            <NumField label="Rot X°" value={perCharRx} onChange={(v) => onSet3d(layerId, true, v, perCharRy, perCharSpread)} />
            <NumField label="Rot Y°" value={perCharRy} onChange={(v) => onSet3d(layerId, true, perCharRx, v, perCharSpread)} />
            <NumField label="Spread°/char" value={perCharSpread} onChange={(v) => onSet3d(layerId, true, perCharRx, perCharRy, v)} />
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
          <NumField label="Angle°" value={s.dropShadow.angle} onChange={(v) => patch({ dropShadow: { ...s.dropShadow!, angle: v } })} />
          <NumField label="Distance" value={s.dropShadow.distance} onChange={(v) => patch({ dropShadow: { ...s.dropShadow!, distance: v } })} />
          <NumField label="Size" value={s.dropShadow.size} min={0} onChange={(v) => patch({ dropShadow: { ...s.dropShadow!, size: v } })} />
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
          <NumField label="Size" value={s.outerGlow.size} min={0} onChange={(v) => patch({ outerGlow: { ...s.outerGlow!, size: v } })} />
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
          <NumField label="Size" value={s.innerGlow.size} min={0} onChange={(v) => patch({ innerGlow: { ...s.innerGlow!, size: v } })} />
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
            <NumField label="Depth %" value={s.bevel.depth} onChange={(v) => patch({ bevel: { ...s.bevel!, depth: v } })} />
            <NumField label="Size" value={s.bevel.size} min={0} onChange={(v) => patch({ bevel: { ...s.bevel!, size: v } })} />
            <NumField label="Soften" value={s.bevel.soften} min={0} onChange={(v) => patch({ bevel: { ...s.bevel!, soften: v } })} />
            <NumField label="Angle°" value={s.bevel.angle} onChange={(v) => patch({ bevel: { ...s.bevel!, angle: v } })} />
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
            <NumField label="Angle°" value={s.gradient.angle} onChange={(v) => patch({ gradient: { ...s.gradient!, angle: v } })} />
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
  content: content0,
  size: size0,
  color,
  font,
  fonts,
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
  onFont,
  onAnim,
  onSetTextStyle,
  onSetTextAnimators,
  onSetTextLayerStyles,
  onSetTextPerChar3d,
  onToggleDecompose,
  onClearParts,
  onDecomposeKey,
}: {
  layerId: number;
  content: string;
  size: number;
  color: Rgba;
  font: Font;
  fonts: string[];
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
  onFont: (layerId: number, font: Font) => void;
  onAnim: (layerId: number, anim: LetterAnimation | null) => void;
  onSetTextStyle: (layerId: number, style: TextStyle | null) => void;
  onSetTextAnimators: (layerId: number, animators: TextAnimator[]) => void;
  onSetTextLayerStyles: (layerId: number, styles: TextLayerStyles | null) => void;
  onSetTextPerChar3d: (layerId: number, enabled: boolean, rx: number, ry: number, spread: number) => void;
  onToggleDecompose: (layerId: number) => void;
  onClearParts: (layerId: number) => void;
  onDecomposeKey: (layerId: number, value: number) => void;
}) {
  const [content, setContent] = useState(content0);
  const [size, setSize] = useState(size0);
  useEffect(() => {
    setContent(content0);
    setSize(size0);
  }, [layerId, content0, size0]);

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
        <select value={font} onChange={(e) => onFont(layerId, e.target.value as Font)}>
          {(fonts.includes(font) ? fonts : [font, ...fonts]).map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </label>

      <div className="row2">
        <label className="insp-field">
          Size (height)
          <input
            type="number"
            min={8}
            max={400}
            value={size}
            onChange={(e) => setSize(Number(e.target.value))}
            onBlur={commitContent}
          />
        </label>
        <label className="insp-field">
          Colour
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
      <TextAnimatorsSection layerId={layerId} animators={animators} onSet={onSetTextAnimators} />

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
          {anim.preset === "scatterIn" && (
            <label className="insp-field">
              Explode area (px radius)
              <input
                type="number"
                min={0}
                max={4000}
                step={20}
                value={Math.round(anim.areaPx)}
                onChange={(e) => setTiming({ areaPx: Number(e.target.value) })}
              />
            </label>
          )}
          <label className="insp-field">
            Start (ms)
            <input
              type="number"
              min={0}
              value={anim.startMs}
              onChange={(e) => setTiming({ startMs: Number(e.target.value) })}
            />
          </label>
          <label className="insp-field">
            Letter duration (ms)
            <input
              type="number"
              min={1}
              value={anim.durationMs}
              onChange={(e) => setTiming({ durationMs: Number(e.target.value) })}
            />
          </label>
          <label className="insp-field">
            Stagger per letter (ms)
            <input
              type="number"
              min={0}
              value={anim.staggerMs}
              onChange={(e) => setTiming({ staggerMs: Number(e.target.value) })}
            />
          </label>
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
  width: number;
  height: number;
  depth: number;
  perspective: number;
  focalLength: number;
  coverage: number;
  radius: number;
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
  onShapeParams,
  onShapeRotKey,
}: {
  layerId: number;
  shape: SurfaceShape;
  params: ShapeParams;
  angles: { x: number; y: number; z: number } | null;
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
      <label className="insp-field">
        Perspective {params.perspective.toFixed(2)}
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={params.perspective}
          onChange={(e) => set({ perspective: Number(e.target.value) })}
        />
      </label>
      <label className="insp-field">
        Focal length
        <input
          type="number"
          min={100}
          max={5000}
          step={50}
          value={Math.round(params.focalLength)}
          onChange={(e) => set({ focalLength: Number(e.target.value) })}
        />
      </label>

      <div className="insp-sep">Size</div>
      <div className="row2">
        <label className="insp-field">
          Width
          <input
            type="number"
            min={1}
            value={Math.round(params.width)}
            onChange={(e) => set({ width: Number(e.target.value) })}
          />
        </label>
        <label className="insp-field">
          Height
          <input
            type="number"
            min={1}
            value={Math.round(params.height)}
            onChange={(e) => set({ height: Number(e.target.value) })}
          />
        </label>
      </div>
      {shape === "box" ? (
        <label className="insp-field">
          Depth
          <input
            type="number"
            min={0}
            value={Math.round(params.depth)}
            onChange={(e) => set({ depth: Number(e.target.value) })}
          />
        </label>
      ) : (
        <>
          <label className="insp-field">
            Radius
            <input
              type="number"
              min={1}
              value={Math.round(params.radius)}
              onChange={(e) => set({ radius: Number(e.target.value) })}
            />
          </label>
          <label className="insp-field">
            Coverage {Math.round(params.coverage)}°
            <input
              type="range"
              min={10}
              max={360}
              step={5}
              value={params.coverage}
              onChange={(e) => set({ coverage: Number(e.target.value) })}
            />
          </label>
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
];

type EffectParam = "amount" | "radius" | "degrees" | "position" | "softness";
type KeyEffect = (
  layerId: number,
  index: number,
  param: EffectParam,
  value: number,
  seedStart: boolean
) => void;
type SetWipeStatic = (layerId: number, index: number, angle: number, invert: boolean) => void;

function effSlider(
  label: string,
  value: number,
  min: number,
  max: number,
  step: number,
  onChange: (v: number) => void
) {
  return (
    <label className="insp-field">
      {label} {value.toFixed(2)}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

// One row of the effect stack — the controls vary by effect kind. Live values
// come from the sampled effect; the sliders key at the playhead so effects
// animate (e.g. a wipe's Position swept 0→1).
function EffectRow({
  layerId,
  index,
  eff,
  onRemove,
  onKey,
  onSetWipeStatic,
}: {
  layerId: number;
  index: number;
  eff: ResolvedEffect;
  onRemove: (layerId: number, index: number) => void;
  onKey: KeyEffect;
  onSetWipeStatic: SetWipeStatic;
}) {
  const label = EFFECT_TYPES.find((t) => t.kind === eff.kind)?.label ?? eff.kind;
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
  }
  return (
    <div className="effect-row">
      <div className="effect-head">
        <span>{label}</span>
        <button
          className="insp-btn tiny"
          title="Remove effect"
          onClick={() => onRemove(layerId, index)}
        >
          ✕
        </button>
      </div>
      {body}
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
}: {
  layerId: number;
  effects: ResolvedEffect[];
  onAddEffect: (layerId: number, kind: string) => void;
  onRemoveEffect: (layerId: number, index: number) => void;
  onKeyEffect: KeyEffect;
  onSetWipeStatic: SetWipeStatic;
}) {
  return (
    <div className="insp-body">
      <div className="insp-sep">Effects</div>
      <label className="insp-field">
        Add effect
        <select
          value=""
          onChange={(e) => {
            if (e.target.value) onAddEffect(layerId, e.target.value);
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
          onRemove={onRemoveEffect}
          onKey={onKeyEffect}
          onSetWipeStatic={onSetWipeStatic}
        />
      ))}
    </div>
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
}: {
  layer: Layer;
  onSet: SetLayerTransition;
}) {
  const slots: { slot: TransitionSlot; tr: Layer["transitionIn"] }[] = [
    { slot: "in", tr: layer.transitionIn },
    { slot: "out", tr: layer.transitionOut },
  ];
  return (
    <div className="insp-body">
      <div className="insp-sep">Transitions</div>
      {slots.map(({ slot, tr }) => {
        const durMs = tr?.durMs ?? 800;
        const direction = tr?.direction ?? 0;
        const paramsJson = tr?.params ?? null;
        // The picker value is the engine id; legacy kinds map onto one.
        const value = !tr
          ? "none"
          : tr.engine ?? LEGACY_TO_ENGINE[tr.kind] ?? "none";
        const onPick = (id: string) => {
          // Picking a (different) transition resets its variables to defaults.
          if (id === "none") onSet(layer.id, slot, "none", durMs, direction, null, null);
          else onSet(layer.id, slot, "dissolve", durMs, direction, id, id === value ? paramsJson : null);
        };
        return (
          <div key={slot} className="insp-field">
            <span style={{ textTransform: "capitalize" }}>{slot}</span>
            <select value={value} onChange={(e) => onPick(e.target.value)}>
              <option value="none">None</option>
              {TRANSITION_GROUPS.map((g) => (
                <optgroup key={g.category} label={g.category}>
                  {g.items.map((it) => (
                    <option key={it.id} value={it.id}>
                      {it.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            {value !== "none" && (
              <>
                <div className="row2">
                  <input
                    type="number"
                    min={0}
                    max={10000}
                    step={50}
                    value={durMs}
                    title="Duration (ms)"
                    onChange={(e) =>
                      onSet(layer.id, slot, "dissolve", Number(e.target.value), direction, value, paramsJson)
                    }
                  />
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
                </div>
                <TransitionVars
                  id={value}
                  paramsJson={paramsJson}
                  onChange={(json) => onSet(layer.id, slot, "dissolve", durMs, direction, value, json)}
                />
              </>
            )}
          </div>
        );
      })}
      <p className="insp-hint">
        In plays over the layer's start, Out over its end. Pick any effect from the
        transition library — it reveals the layers beneath. Overlap a layer beneath to
        cross-blend.
      </p>
    </div>
  );
}

interface Props {
  layer: Layer | null;
  fonts: string[];
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
  onShapeParams: (layerId: number, p: ShapeParams) => void;
  onShapeRotKey: (
    layerId: number,
    axis: "x" | "y" | "z",
    value: number,
    seedStart: boolean
  ) => void;
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
  onContent: (layerId: number, content: string, size: number) => void;
  onColor: (layerId: number, color: Rgba) => void;
  onFont: (layerId: number, font: Font) => void;
  onAnim: (layerId: number, anim: LetterAnimation | null) => void;
  onSetTextStyle: (layerId: number, style: TextStyle | null) => void;
  onSetTextAnimators: (layerId: number, animators: TextAnimator[]) => void;
  onSetTextLayerStyles: (layerId: number, styles: TextLayerStyles | null) => void;
  onSetTextPerChar3d: (layerId: number, enabled: boolean, rx: number, ry: number, spread: number) => void;
  onToggleDecompose: (layerId: number) => void;
  onClearParts: (layerId: number) => void;
  onDecomposeKey: (layerId: number, value: number) => void;
  onSetLayerTransition: SetLayerTransition;
}

export default function Inspector({
  layer,
  fonts,
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
  onShapeParams,
  onShapeRotKey,
  onAttachToShape,
  onKeyDecal,
  onSetDecalFace,
  onRevealFace,
  onDecalKeyAll,
  onContent,
  onColor,
  onFont,
  onAnim,
  onSetTextStyle,
  onSetTextAnimators,
  onSetTextLayerStyles,
  onSetTextPerChar3d,
  onToggleDecompose,
  onClearParts,
  onDecomposeKey,
  onSetLayerTransition,
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
      {layer && layer.kind.kind === "text" && (
        <TextInspector
          layerId={layer.id}
          content={layer.kind.content}
          size={layer.kind.size}
          color={layer.kind.color}
          font={layer.kind.font}
          fonts={fonts}
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
          onFont={onFont}
          onAnim={onAnim}
          onSetTextStyle={onSetTextStyle}
          onSetTextAnimators={onSetTextAnimators}
          onSetTextLayerStyles={onSetTextLayerStyles}
          onSetTextPerChar3d={onSetTextPerChar3d}
          onToggleDecompose={onToggleDecompose}
          onClearParts={onClearParts}
          onDecomposeKey={onDecomposeKey}
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
          onShapeParams={onShapeParams}
          onShapeRotKey={onShapeRotKey}
        />
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
        />
      )}
      {layer && layer.kind.kind === "colorpatch" && (
        <span className="muted">
          {layer.kind.kind} layer — drag on the canvas to move/scale, ◆ Key to set a keyframe.
        </span>
      )}
      {layer && <TransitionsSection layer={layer} onSet={onSetLayerTransition} />}
    </aside>
  );
}
