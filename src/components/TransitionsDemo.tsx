// A self-contained preview harness for the Stage-1 transition engine. Pick a
// transition, tweak its parameters, scrub or play the progress, and watch it
// render between two sample clips (deliberately different aspect ratios so the
// `fit` modes are visible). Opened from Window → Transitions Demo.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  REGISTRY,
  getTransitionMeta,
  createTransition,
  type Clip,
  type ParamSpec,
} from "../lib/transitions";

const OUT_W = 480;
const OUT_H = 270;

/** A labelled gradient sample clip. */
function makeClip(label: string, c0: string, c1: string, w: number, h: number): Clip {
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext("2d")!;
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, c0);
  g.addColorStop(1, c1);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(255,255,255,0.22)";
  ctx.lineWidth = 2;
  for (let i = 1; i < 6; i++) {
    ctx.beginPath();
    ctx.moveTo((i / 6) * w, 0);
    ctx.lineTo((i / 6) * w, h);
    ctx.moveTo(0, (i / 6) * h);
    ctx.lineTo(w, (i / 6) * h);
    ctx.stroke();
  }
  ctx.fillStyle = "#fff";
  ctx.font = `bold ${Math.round(h * 0.42)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, w / 2, h / 2);
  return { source: cv, width: w, height: h };
}

function rgbToHex(c: { r: number; g: number; b: number }): string {
  const h = (n: number) => Math.max(0, Math.min(255, n | 0)).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m
    ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) }
    : { r: 0, g: 0, b: 0 };
}

function defaultsFor(params: ParamSpec[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of params) out[p.name] = p.default;
  return out;
}

export default function TransitionsDemo({ onClose }: { onClose: () => void }) {
  const [id, setId] = useState(REGISTRY[0].id);
  const meta = getTransitionMeta(id)!;
  const [params, setParams] = useState<Record<string, unknown>>(() => defaultsFor(meta.params));
  const [progress, setProgress] = useState(0.5);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);

  // Two sample clips with different aspect ratios (16:9 and portrait).
  const clips = useMemo(
    () => ({
      from: makeClip("A", "#1f6feb", "#0b3a8f", 640, 360),
      to: makeClip("B", "#f0883e", "#a83208", 360, 480),
    }),
    []
  );

  // Reset params to defaults whenever the transition changes.
  useEffect(() => {
    setParams(defaultsFor(getTransitionMeta(id)!.params));
  }, [id]);

  // Build the transition only when id/params change (not per progress), so the
  // base can cache its fitted frames across a scrub/play.
  const built = useMemo(() => {
    try {
      const tr = createTransition(id, clips.from, clips.to, { ...params, outWidth: OUT_W, outHeight: OUT_H });
      return { tr, err: null as string | null };
    } catch (e) {
      return { tr: null, err: String(e instanceof Error ? e.message : e) };
    }
  }, [id, params, clips]);

  useEffect(() => setError(built.err), [built]);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !built.tr) return;
    try {
      built.tr.render(cv, progress);
      setError(null);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }, [built, progress]);

  // Play loop (~1.6s, ping-pong so you see it both ways).
  useEffect(() => {
    if (!playing) {
      cancelAnimationFrame(rafRef.current);
      return;
    }
    let start = 0;
    const tick = (now: number) => {
      if (!start) start = now;
      const t = ((now - start) / 1600) % 2;
      setProgress(t <= 1 ? t : 2 - t);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing]);

  const setParam = (name: string, value: unknown) => setParams((p) => ({ ...p, [name]: value }));

  const grouped = REGISTRY.reduce<Record<string, typeof REGISTRY>>((acc, m) => {
    (acc[m.category] ??= []).push(m);
    return acc;
  }, {});

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal tr-demo" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">Transitions Demo</div>
        <div className="modal-body">
          <label className="insp-field">
            Transition
            <select value={id} onChange={(e) => setId(e.target.value)}>
              {Object.entries(grouped).map(([cat, items]) => (
                <optgroup key={cat} label={cat}>
                  {items.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>

          <p className="muted" style={{ margin: "2px 0 6px" }}>{meta.description}</p>

          <canvas
            ref={canvasRef}
            width={OUT_W}
            height={OUT_H}
            className="tr-demo-canvas"
            style={{ width: OUT_W, height: OUT_H }}
          />
          {error && <p style={{ color: "#ff6b6b", fontSize: 12 }}>⚠ {error}</p>}

          <label className="insp-field">
            Progress — {progress.toFixed(2)}
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={progress}
              onChange={(e) => {
                setPlaying(false);
                setProgress(Number(e.target.value));
              }}
            />
          </label>
          <button className="insp-btn" onClick={() => setPlaying((v) => !v)}>
            {playing ? "❚❚ Pause" : "▶ Play"}
          </button>

          <div className="insp-sep">Parameters</div>
          {meta.params.map((spec) => {
            const val = params[spec.name];
            if (spec.type === "enum") {
              return (
                <label key={spec.name} className="insp-field" title={spec.description}>
                  {spec.label}
                  <select value={String(val)} onChange={(e) => setParam(spec.name, e.target.value)}>
                    {spec.options!.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                </label>
              );
            }
            if (spec.type === "number") {
              return (
                <label key={spec.name} className="insp-field" title={spec.description}>
                  {spec.label} — {Number(val).toFixed(2)}
                  <input
                    type="range"
                    min={spec.min ?? 0}
                    max={spec.max ?? 1}
                    step={spec.step ?? 0.01}
                    value={Number(val)}
                    onChange={(e) => setParam(spec.name, Number(e.target.value))}
                  />
                </label>
              );
            }
            if (spec.type === "bool") {
              return (
                <label key={spec.name} className="surf-face" title={spec.description}>
                  <input
                    type="checkbox"
                    checked={!!val}
                    onChange={(e) => setParam(spec.name, e.target.checked)}
                  />
                  {spec.label}
                </label>
              );
            }
            // color
            const c = (val as { r: number; g: number; b: number }) ?? { r: 0, g: 0, b: 0 };
            return (
              <label key={spec.name} className="insp-field" title={spec.description}>
                {spec.label}
                <input
                  type="color"
                  value={rgbToHex(c)}
                  onChange={(e) => setParam(spec.name, hexToRgb(e.target.value))}
                />
              </label>
            );
          })}
        </div>
        <div className="modal-actions">
          <button className="insp-btn active" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
