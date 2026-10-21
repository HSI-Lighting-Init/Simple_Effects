import { describe, it, expect, vi } from "vitest";

// In-memory fake of the engine calls rebuildFromAnalysis makes, so we can
// assert what it DOES (layers, transforms, effects, transitions) without
// Tauri. Same shape as test/style-packs.test.ts's fake.
const fake = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const state = { p: null as any, mediaPaths: [] as string[] };
  const clone = () => JSON.parse(JSON.stringify(state.p));
  const L = (id: number) => state.p.layers.find((l: any) => l.id === id);
  const track = (v: number) => ({ keys: [] as any[], default: v });
  const nextId = () => Math.max(0, ...state.p.layers.map((l: any) => l.id)) + 1;
  const baseLayer = (id: number, name: string, kind: any, startMs = 0, endMs = 1000) => ({
    id, name, startMs, endMs, kind, hidden: false, attach: null, effects: [] as any[], transitionIn: null, transitionOut: null,
    transform: { x: track(0), y: track(0), scaleX: track(1), scaleY: track(1), rotation: track(0), opacity: track(1), anchorX: 0.5, anchorY: 0.5 },
  });
  const api = {
    newProject: async () => {
      state.p = { width: 0, height: 0, fps: 30, durationMs: 0, media: [], layers: [] };
      return clone();
    },
    setCompSize: async (width: number, height: number) => (Object.assign(state.p, { width, height }), clone()),
    setCompFps: async (fps: number) => (Object.assign(state.p, { fps }), clone()),
    setCompDuration: async (durationMs: number) => (Object.assign(state.p, { durationMs }), clone()),
    setLayerRange: async (id: number, s: number, e: number) => (Object.assign(L(id), { startMs: s, endMs: e }), clone()),
    editKeyframes: async (id: number, t: number, edit: Record<string, any>) => {
      const tf = L(id).transform;
      for (const [k, v] of Object.entries(edit)) {
        if (k === "easing" || v === undefined || !(k in tf)) continue;
        tf[k].keys = tf[k].keys.filter((x: any) => x.timeMs !== t);
        tf[k].keys.push({ timeMs: t, value: v, easing: (edit as any).easing ?? "easeInOut" });
        tf[k].keys.sort((a: any, b: any) => a.timeMs - b.timeMs);
      }
      return clone();
    },
    setLayerTransition: async (id: number, slot: string, kind: string, durMs: number, direction: number, engine: string) => {
      L(id)[slot === "in" ? "transitionIn" : "transitionOut"] = { kind, durMs, direction, engine, params: null };
      return clone();
    },
    addEffect: async (id: number, kind: string) => (L(id).effects.push({ kind }), clone()),
    keyEffect: async (id: number, index: number, param: string, _t: number, value: number) => {
      const e = L(id).effects[index];
      (e.params ??= {})[param] = value;
      return clone();
    },
    addTextLayer: async (content: string, size: number) => {
      const id = nextId();
      state.p.layers.push(baseLayer(id, `text${id}`, { kind: "text", content, size }, 0, state.p.durationMs));
      return clone();
    },
    setTextStyle: async (id: number, style: unknown) => ((L(id).kind as any).style = style, clone()),
    setTornEdgeStatic: async (id: number, index: number, side: number, depth: number, seed: number, toothCount: number, paperWidth: number, paperColor: unknown) => {
      Object.assign(L(id).effects[index], { side, depth, seed, toothCount, paperWidth, paperColor });
      return clone();
    },
    // Fake 2.5 fitter: just the first/last sample as start/end keys (linear)
    // — enough to test animateMotion's wiring, not a DP/bezier reimplementation.
    fitBackground: async (samples: { scale: number; rotationDeg: number; tx: number; ty: number }[], startMs: number, endMs: number) => {
      const first = samples[0];
      const last = samples[samples.length - 1];
      const mk = (get: (s: typeof first) => number) => [
        { timeMs: startMs, value: get(first), easing: "linear" as const },
        { timeMs: endMs, value: get(last), easing: "linear" as const },
      ];
      return { scale: mk((s) => s.scale), rotationDeg: mk((s) => s.rotationDeg), tx: mk((s) => s.tx), ty: mk((s) => s.ty) };
    },
  };
  return { state, api, baseLayer, nextId };
});
vi.mock("../src/lib/api", () => fake.api);

import { rebuildFromAnalysis } from "../src/lib/rebuildFromAnalysis";
import type { TemplateAnalysis, ShotAnalysis } from "../src/lib/rebuildFromAnalysis";

// RebuildIO fake: addMedia self-commits, pushing an image layer for
// mediaPaths[index] straight into the fake project, same convention the real
// engine's add-to-timeline flow follows (and synthetic.ts's io documents).
const io = {
  project: () => JSON.parse(JSON.stringify(fake.state.p)),
  commit: async (p: unknown) => {
    fake.state.p = p;
  },
  importMedia: async (paths: string[]) => {
    fake.state.mediaPaths = paths;
  },
  addMedia: async (index: number) => {
    const id = fake.nextId();
    const path = fake.state.mediaPaths[index];
    fake.state.p.layers.push(
      fake.baseLayer(id, `img${id}`, { kind: "image", src: path, width: 572, height: 1024, crop: null }, 0, fake.state.p.durationMs)
    );
    return id;
  },
  exportVideo: async (outPath: string) => outPath,
};

const flatLook: ShotAnalysis["look"] = { brightness: 1, contrast: 1, saturate: 1, vignetteStrength: 0, fadeInMs: 0, fadeOutMs: 0 };
const base = (shots: ShotAnalysis[], extra: Partial<TemplateAnalysis> = {}): TemplateAnalysis => ({
  durationMs: Math.max(...shots.map((s) => s.endMs)),
  width: 1080,
  height: 1920,
  fps: 30,
  shots,
  transitions: [],
  textBeats: [],
  ...extra,
});

describe("rebuildFromAnalysis (mock engine)", () => {
  it("places one image layer per shot at the right startMs/endMs with the right media path", async () => {
    const analysis = base([
      { index: 0, startMs: 0, endMs: 2000, isStill: false, look: flatLook },
      { index: 1, startMs: 2000, endMs: 4000, isStill: false, look: flatLook },
    ]);
    const r = await rebuildFromAnalysis(analysis, ["a.png", "b.png"], io, "out.mp4");
    const layers = r.project.layers.filter((l) => l.kind.kind === "image");
    expect(layers.length).toBe(2);
    expect(layers[0].startMs).toBe(0);
    expect(layers[0].endMs).toBe(2000);
    expect((layers[0].kind as any).src).toBe("a.png");
    expect(layers[1].startMs).toBe(2000);
    expect(layers[1].endMs).toBe(4000);
    expect((layers[1].kind as any).src).toBe("b.png");
  });

  it("keys scaleX/scaleY at start/end for an isStill shot, in the same ratio as the measured motion samples", async () => {
    const analysis = base([
      {
        index: 0, startMs: 0, endMs: 3000, isStill: true,
        motion: [
          { tMs: 0, scale: 1.0, rotationDeg: 0, tx: 0, ty: 0 },
          { tMs: 3000, scale: 1.25, rotationDeg: 0, tx: 0, ty: 0 },
        ],
        look: flatLook,
      },
    ]);
    const r = await rebuildFromAnalysis(analysis, ["a.png"], io, "out.mp4");
    const layer = r.project.layers.find((l) => l.kind.kind === "image")!;
    const keys = layer.transform.scaleX.keys as { timeMs: number; value: number }[];
    expect(keys.map((k) => k.timeMs)).toEqual([0, 3000]);
    expect(keys[1].value / keys[0].value).toBeCloseTo(1.25, 5); // ratio, not absolute value
  });

  it("keys every fitted keyframe (not just start/end) with its own easing, including bezier", async () => {
    const original = fake.api.fitBackground;
    fake.api.fitBackground = async () => ({
      scale: [
        { timeMs: 0, value: 1.0, easing: "linear" as const },
        { timeMs: 1200, value: 1.1, easing: { bezier: { x1: 0.34, y1: 1.56, x2: 0.64, y2: 1.0 } } },
        { timeMs: 3000, value: 1.25, easing: "linear" as const },
      ],
      rotationDeg: [], tx: [], ty: [],
    });
    try {
      const analysis = base([
        {
          index: 0, startMs: 0, endMs: 3000, isStill: true,
          motion: [
            { tMs: 0, scale: 1.0, rotationDeg: 0, tx: 0, ty: 0 },
            { tMs: 1200, scale: 1.1, rotationDeg: 0, tx: 0, ty: 0 },
            { tMs: 3000, scale: 1.25, rotationDeg: 0, tx: 0, ty: 0 },
          ],
          look: flatLook,
        },
      ]);
      const r = await rebuildFromAnalysis(analysis, ["a.png"], io, "out.mp4");
      const layer = r.project.layers.find((l) => l.kind.kind === "image")!;
      const keys = layer.transform.scaleX.keys as { timeMs: number; value: number; easing: unknown }[];
      expect(keys.map((k) => k.timeMs)).toEqual([0, 1200, 3000]);
      expect(keys[1].easing).toEqual({ bezier: { x1: 0.34, y1: 1.56, x2: 0.64, y2: 1.0 } });
    } finally {
      fake.api.fitBackground = original;
    }
  });

  it("composes rotation/pan onto the layer's own anchor, translation rescaled by compW/256", async () => {
    const original = fake.api.fitBackground;
    fake.api.fitBackground = async () => ({
      scale: [
        { timeMs: 0, value: 1.0, easing: "linear" as const },
        { timeMs: 3000, value: 1.2, easing: "linear" as const },
      ],
      rotationDeg: [
        { timeMs: 0, value: 0, easing: "linear" as const },
        { timeMs: 3000, value: 5, easing: "linear" as const },
      ],
      tx: [
        { timeMs: 0, value: 0, easing: "linear" as const },
        { timeMs: 3000, value: 10, easing: "linear" as const },
      ],
      ty: [
        { timeMs: 0, value: 0, easing: "linear" as const },
        { timeMs: 3000, value: 20, easing: "linear" as const },
      ],
    });
    try {
      const analysis = base([
        {
          index: 0, startMs: 0, endMs: 3000, isStill: true,
          motion: [
            { tMs: 0, scale: 1.0, rotationDeg: 0, tx: 0, ty: 0 },
            { tMs: 3000, scale: 1.2, rotationDeg: 5, tx: 10, ty: 20 },
          ],
          look: flatLook,
        },
      ]);
      // base()'s default comp width is 1080; MOTION_ANALYSIS_SHORT_SIDE is
      // 256 — k = 1080/256 = 4.21875. The fake layer's own anchor (x/y/
      // rotation) defaults to 0, so the composed value at t=3000 is exactly
      // k * the fitted tx/ty/rotationDeg.
      const r = await rebuildFromAnalysis(analysis, ["a.png"], io, "out.mp4");
      const layer = r.project.layers.find((l) => l.kind.kind === "image")!;
      const at3000 = (track: { timeMs: number; value: number }[]) => track.find((k) => k.timeMs === 3000)!.value;
      expect(at3000(layer.transform.x.keys as never)).toBeCloseTo((1080 / 256) * 10, 5);
      expect(at3000(layer.transform.y.keys as never)).toBeCloseTo((1080 / 256) * 20, 5);
      expect(at3000(layer.transform.rotation.keys as never)).toBeCloseTo(5, 5);
    } finally {
      fake.api.fitBackground = original;
    }
  });

  it("leaves scaleX unkeyed when the shot isn't still", async () => {
    const analysis = base([{ index: 0, startMs: 0, endMs: 2000, isStill: false, look: flatLook }]);
    const r = await rebuildFromAnalysis(analysis, ["a.png"], io, "out.mp4");
    const layer = r.project.layers.find((l) => l.kind.kind === "image")!;
    expect(layer.transform.scaleX.keys).toEqual([]);
  });

  it("keys a 0-then-1 opacity fade-in pair at the right times", async () => {
    const analysis = base([{ index: 0, startMs: 0, endMs: 2000, isStill: false, look: { ...flatLook, fadeInMs: 500 } }]);
    const r = await rebuildFromAnalysis(analysis, ["a.png"], io, "out.mp4");
    const layer = r.project.layers.find((l) => l.kind.kind === "image")!;
    const keys = layer.transform.opacity.keys as { timeMs: number; value: number }[];
    expect(keys).toEqual([
      { timeMs: 0, value: 0, easing: "linear" },
      { timeMs: 500, value: 1, easing: "linear" },
    ]);
  });

  it("sets transitionIn on a shot whose boundary matches a transition entry, and leaves it unset when nothing matches", async () => {
    const analysis = base(
      [
        { index: 0, startMs: 0, endMs: 2000, isStill: false, look: flatLook },
        { index: 1, startMs: 2000, endMs: 4000, isStill: false, look: flatLook },
        { index: 2, startMs: 4000, endMs: 6000, isStill: false, look: flatLook },
      ],
      { transitions: [{ atMs: 2000, engine: "crossDissolve", durMs: 300 }] } // no entry near 4000
    );
    const r = await rebuildFromAnalysis(analysis, ["a.png", "b.png", "c.png"], io, "out.mp4");
    const layers = r.project.layers.filter((l) => l.kind.kind === "image");
    expect(layers[1].transitionIn).toMatchObject({ kind: "dissolve", durMs: 300, engine: "crossDissolve" });
    expect(layers[2].transitionIn).toBeNull();
    expect(layers[0].transitionIn).toBeNull(); // shot 0 never gets an "in" transition
  });

  it("places a text layer at a text beat's startMs/endMs with its content", async () => {
    const analysis = base([{ index: 0, startMs: 0, endMs: 2000, isStill: false, look: flatLook }], {
      textBeats: [{ startMs: 500, endMs: 1500, content: "HSI Lighting" }],
    });
    const r = await rebuildFromAnalysis(analysis, ["a.png"], io, "out.mp4");
    const text = r.project.layers.find((l) => l.kind.kind === "text")!;
    expect(text).toBeTruthy();
    expect(text.startMs).toBe(500);
    expect(text.endMs).toBe(1500);
    expect((text.kind as any).content).toBe("HSI Lighting");
  });

  it("cycles newMedia when it's shorter than the shot count", async () => {
    const analysis = base([
      { index: 0, startMs: 0, endMs: 1000, isStill: false, look: flatLook },
      { index: 1, startMs: 1000, endMs: 2000, isStill: false, look: flatLook },
      { index: 2, startMs: 2000, endMs: 3000, isStill: false, look: flatLook },
    ]);
    const newMedia = ["a.png", "b.png"]; // shorter than shots.length (3)
    const r = await rebuildFromAnalysis(analysis, newMedia, io, "out.mp4");
    const layers = r.project.layers.filter((l) => l.kind.kind === "image");
    expect((layers[0].kind as any).src).toBe((layers[newMedia.length].kind as any).src); // shot 0 and shot 2 cycle back to a.png
  });

  it("places one media layer per region for a multi-region shot, box-fit to each region instead of the full frame", async () => {
    const analysis = base([
      {
        index: 0, startMs: 0, endMs: 2000, isStill: false, look: flatLook,
        layout: {
          kind: "grid",
          regions: [
            { xFrac: 0, yFrac: 0, wFrac: 0.5, hFrac: 0.5 },
            { xFrac: 0.5, yFrac: 0, wFrac: 0.5, hFrac: 0.5 },
          ],
        },
      },
    ]);
    const newMedia = ["a.png", "b.png"];
    const r = await rebuildFromAnalysis(analysis, newMedia, io, "out.mp4");
    const layers = r.project.layers.filter((l) => l.kind.kind === "image");
    expect(layers.length).toBe(2); // one per region, not one for the whole shot
    expect((layers[0].kind as any).src).toBe("a.png");
    expect((layers[1].kind as any).src).toBe("b.png"); // running cursor — the second region does NOT reuse a.png

    // region 0 is the left half of a 1080x1920 comp: box 540x960, centred at (270, 480)
    const l0 = layers[0];
    expect(l0.transform.x.keys[0].value).toBeCloseTo(270, 5);
    expect(l0.transform.y.keys[0].value).toBeCloseTo(480, 5);
    // contain-fit of the fake 572x1024 image into a 540x960 box: min(540/572, 960/1024) = min(0.944, 0.9375)
    expect(l0.transform.scaleX.keys[0].value).toBeCloseTo(Math.min(540 / 572, 960 / 1024), 5);

    // region 1 is the right half: centred at (810, 480)
    expect(layers[1].transform.x.keys[0].value).toBeCloseTo(810, 5);
  });

  it("cycles the media cursor across ALL regions of ALL shots, not resetting per shot", async () => {
    const analysis = base([
      {
        index: 0, startMs: 0, endMs: 1000, isStill: false, look: flatLook,
        layout: { kind: "grid", regions: [{ xFrac: 0, yFrac: 0, wFrac: 0.5, hFrac: 1 }, { xFrac: 0.5, yFrac: 0, wFrac: 0.5, hFrac: 1 }] },
      },
      { index: 1, startMs: 1000, endMs: 2000, isStill: false, look: flatLook }, // plain single-layer shot
    ]);
    const newMedia = ["a.png", "b.png", "c.png"];
    const r = await rebuildFromAnalysis(analysis, newMedia, io, "out.mp4");
    const layers = r.project.layers.filter((l) => l.kind.kind === "image");
    expect(layers.map((l) => (l.kind as any).src)).toEqual(["a.png", "b.png", "c.png"]); // shot 1 continues the cursor, doesn't restart at a.png
  });

  it("builds a two-layer outline-then-fill pair per kinetic title instance", async () => {
    const analysis = base([{ index: 0, startMs: 0, endMs: 3000, isStill: false, look: flatLook }], {
      kineticTitles: [{ startMs: 500, endMs: 2500, primaryContent: "SPORT", fillDelayMs: 300, echoFillDelayMs: 600, crossfadeMs: 200 }],
    });
    const r = await rebuildFromAnalysis(analysis, ["a.png"], io, "out.mp4");
    const textLayers = r.project.layers.filter((l) => l.kind.kind === "text" && (l.kind as any).content === "SPORT");
    expect(textLayers.length).toBe(4); // echo outline+fill, primary outline+fill

    const styles = textLayers.map((l) => (l.kind as any).style);
    const outlineStyles = styles.filter((s: any) => s.fills.length === 0);
    const filledStyles = styles.filter((s: any) => s.fills.length === 1);
    expect(outlineStyles.length).toBe(2);
    expect(filledStyles.length).toBe(2);
    for (const s of outlineStyles) expect(s.strokes.length).toBe(1); // hollow letters — stroke only, no fill

    // the primary instance's filled layer solidifies (opacity -> 1) at startMs + fillDelayMs + crossfadeMs = 500+300+200=1000
    const primaryFilled = textLayers.find((l) => {
      const s = (l.kind as any).style;
      return s.fills.length === 1 && l.transform.opacity.keys.some((k: any) => k.timeMs === 1000 && k.value === 1);
    });
    expect(primaryFilled).toBeTruthy();
  });

  it("builds a fanned torn-edge card stack from ONE media item, offsetting and tearing every copy", async () => {
    const analysis = base([{ index: 0, startMs: 0, endMs: 2000, isStill: false, look: flatLook }], {
      cardStacks: [{ startMs: 0, endMs: 2000, copies: 3, offsetPx: { x: -10, y: -5 }, tornSide: 1 }],
    });
    // 2 images: shot 0 consumes "a.png" (index 0), the card stack should then consume "b.png" (index 1) — ONE index for all 3 copies.
    const r = await rebuildFromAnalysis(analysis, ["a.png", "b.png"], io, "out.mp4");
    const imageLayers = r.project.layers.filter((l) => l.kind.kind === "image");
    expect(imageLayers.length).toBe(4); // 1 (shot) + 3 (stack copies)
    const stackLayers = imageLayers.slice(1);
    expect(stackLayers.every((l) => (l.kind as any).src === "b.png")).toBe(true); // same media for every copy

    // every copy got a tornedge effect torn on the requested side
    for (const l of stackLayers) {
      const fx = l.effects.find((e: any) => e.kind === "tornedge");
      expect(fx).toBeTruthy();
      expect(fx.side).toBe(1);
    }
    // copies step apart diagonally: back-to-front x offsets are -20, -10, 0 (i = 2,1,0 * offsetX=-10)
    const xs = stackLayers.map((l) => l.transform.x.keys[0].value).sort((a, b) => a - b);
    expect(xs).toEqual([-20 + 540, -10 + 540, 0 + 540]); // compW=1080 default in `base()` -> centre 540
  });
});
