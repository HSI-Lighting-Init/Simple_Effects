import { describe, it, expect, vi } from "vitest";

// In-memory fake of the engine calls the style applier makes, so we can assert
// what it DOES (effects, transitions, keys, layer order) without Tauri.
const fake = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const state = { p: null as any };
  const clone = () => JSON.parse(JSON.stringify(state.p));
  const L = (id: number) => state.p.layers.find((l: any) => l.id === id);
  const track = (v: number) => ({ keys: [] as any[], default: v });
  const rgba = (v: number) => ({ r: v, g: v, b: v, a: 255 });
  const nextId = () => Math.max(0, ...state.p.layers.map((l: any) => l.id)) + 1;
  const baseLayer = (id: number, name: string, kind: any, startMs = 0, endMs = 4000, scale = 1.875) => ({
    id, name, startMs, endMs, kind, hidden: false, attach: null, effects: [] as any[], transitionIn: null, transitionOut: null,
    transform: { x: track(540), y: track(960), scaleX: track(scale), scaleY: track(scale), rotation: track(0), opacity: track(1), anchorX: 0.5, anchorY: 0.5 },
  });
  const api = {
    addEffect: async (id: number, kind: string) => (L(id).effects.push({ kind }), clone()),
    removeEffect: async (id: number, i: number) => (L(id).effects.splice(i, 1), clone()),
    keyEffect: async (id: number, i: number, param: string, _t: number, value: number) => {
      const e = L(id).effects[i];
      (e.params ??= {})[param] = value;
      return clone();
    },
    editKeyframes: async (id: number, t: number, edit: Record<string, number | undefined>) => {
      const tf = L(id).transform;
      for (const [k, v] of Object.entries(edit)) {
        if (v === undefined) continue;
        tf[k].keys = tf[k].keys.filter((x: any) => x.timeMs !== t);
        tf[k].keys.push({ timeMs: t, value: v, easing: "easeInOut" });
        tf[k].keys.sort((a: any, b: any) => a.timeMs - b.timeMs);
      }
      return clone();
    },
    setLayerTransition: async (id: number, slot: string, kind: string, durMs: number, direction: number, engine: string) => {
      L(id)[slot === "in" ? "transitionIn" : "transitionOut"] = { kind, durMs, direction, engine, params: null };
      return clone();
    },
    setLayerRange: async (id: number, s: number, e: number) => (Object.assign(L(id), { startMs: s, endMs: e }), clone()),
    deleteLayer: async (id: number) => ((state.p.layers = state.p.layers.filter((l: any) => l.id !== id)), clone()),
    renameLayer: async (id: number, name: string) => ((L(id).name = name), clone()),
    reorderLayers: async (order: number[]) => ((state.p.layers = order.map((id) => L(id))), clone()),
    addAdjustmentLayer: async () => {
      const l = baseLayer(nextId(), "Adjustment", { kind: "adjustment" }, 0, state.p.durationMs);
      l.effects = [{ kind: "shinyclouds" }];
      state.p.layers.push(l);
      return clone();
    },
    addShape2dLayer: async (shape: string) => {
      state.p.layers.push(
        baseLayer(nextId(), "Rectangle", {
          kind: "shape2d",
          style: {
            shape, width: track(300), height: track(300), sides: track(6), cornerRadius: track(0), bend: track(0),
            filled: true, fill: rgba(255), fillKeys: [], borderWidth: track(4), borderColor: rgba(0), borderColorKeys: [],
            glowColor: rgba(255), glowColorKeys: [], glowSize: track(20), glowOpacity: track(0.5), glowIntensity: track(1),
            shadowColor: rgba(0), shadowColorKeys: [], shadowBlur: track(0), shadowOffsetX: track(0), shadowOffsetY: track(0), shadowOpacity: track(0),
          },
        }, 0, 4000, 1)
      );
      return clone();
    },
    setShape2d: async (id: number, style: any) => ((L(id).kind.style = style), clone()),
    getShaped: async (id: number) => {
      const k = L(id).kind;
      return { width: k.content.length * k.size * 0.55, ascender: k.size * 0.8, descender: k.size * 0.2, lineHeight: k.size * 1.2, lines: 1, glyphs: [], embolden: 0 };
    },
    setTextContent: async (id: number, content: string, size: number) => (Object.assign(L(id).kind, { content, size }), clone()),
    setTextFont: async (id: number, font: string) => ((L(id).kind.font = font), clone()),
    setTextFontStyle: async (id: number, weight: number, italic: boolean) => (Object.assign(L(id).kind, { weight, italic }), clone()),
    clearTextColorKeys: async (id: number, color: any) => (Object.assign(L(id).kind, { color, colorKeys: [] }), clone()),
    setTextStyle: async (id: number, style: any) => ((L(id).kind.style = style), clone()),
    setTextLayerStyles: async (id: number, s: any) => ((L(id).kind.layerStyles = s), clone()),
    setTextAnim: async (id: number, a: any) => ((L(id).kind.anim = a), clone()),
    setTextAnimOut: async (id: number, a: any) => ((L(id).kind.animOut = a), clone()),
  };
  return { state, api, baseLayer };
});
vi.mock("../src/lib/api", () => fake.api);

import { applyStylePack, stylePackById, STYLE_PACKS, matchStyles, bestStyle } from "../src/lib/stylePacks";
import { REGISTRY } from "../src/lib/transitions/registry";

// 3 overlapping stills (400ms crossfades) + one title, in a 9:16 comp.
function seed(title = "HSI Lighting", extra: object[] = []) {
  const img = (id: number, s: number, e: number, scale = 1.875) =>
    fake.baseLayer(id, `img${id}`, { kind: "image", src: `${id}.png`, width: 572, height: 1024, crop: null }, s, e, scale);
  const text = fake.baseLayer(4, "Title", {
    kind: "text", content: title, size: 140, font: "Vazirmatn", weight: 400, italic: false, align: "center",
    color: { r: 255, g: 255, b: 255, a: 255 }, colorKeys: [], anim: null, animOut: null, style: null, layerStyles: null, parts: [],
  }, 0, 3000, 1);
  fake.state.p = { width: 1080, height: 1920, fps: 30, durationMs: 6000, media: [], layers: [img(1, 0, 2400), img(2, 2000, 4400), img(3, 4000, 6000), text, ...extra] };
}
const io = { project: () => JSON.parse(JSON.stringify(fake.state.p)), commit: async () => {} };
const layer = (id: number) => fake.state.p.layers.find((l: { id: number }) => l.id === id);
const names = () => fake.state.p.layers.map((l: { name: string }) => l.name);

// Mirrors the engine's Effect::default_of + keyframeable param names.
const GPU = new Set(["caustics", "lensflare", "sparkle", "heathaze", "filmgrain", "vignette", "shimmer", "aurora", "fog", "flap"]);
const VALID_FX = new Set(["grayscale", "brightness", "contrast", "saturate", "blur", "hue", "invert", "wipe", "shinyclouds", ...GPU]);
const paramsOf = (k: string) =>
  k === "blur" ? ["radius"] : k === "hue" ? ["degrees"] : GPU.has(k) ? ["intensity", "scale", "speed", "detail", "softness", "extra", "opacity"]
  : k === "shinyclouds" ? ["intensity", "scale", "speed", "complexity", "contrast", "brightness", "opacity"] : ["amount"];

describe("style pack catalog", () => {
  it("every pack references only real transitions, effects and params", () => {
    const ids = new Set(REGISTRY.map((m) => m.id));
    expect(new Set(STYLE_PACKS.map((p) => p.id)).size).toBe(STYLE_PACKS.length);
    for (const p of STYLE_PACKS) {
      for (const e of p.transitions.engines) expect(ids.has(e), `${p.id}: transition ${e}`).toBe(true);
      for (const f of [...p.grade, ...(p.accent ?? []), ...(p.overlay ?? [])]) {
        expect(VALID_FX.has(f.kind), `${p.id}: effect ${f.kind}`).toBe(true);
        for (const k of Object.keys(f.params ?? {})) expect(paramsOf(f.kind), `${p.id}: ${f.kind}.${k}`).toContain(k);
      }
      expect(p.description.length).toBeGreaterThan(60);
      expect(p.keywords.length).toBeGreaterThan(5);
    }
  });

  it("matches descriptions to the right pack", () => {
    expect(bestStyle("upbeat instagram promo for our new lamp").id).toBe("instagram-block");
    expect(bestStyle("breaking news: company announcement and press update").id).toBe("news-studio");
    expect(bestStyle("travel vlog of our beach holiday").id).toBe("travellers-choice");
    expect(bestStyle("luxury gold jewelry collection").id).toBe("luxury-gold");
    expect(bestStyle("our wedding day, a love story").id).toBe("wedding-romance");
    expect(bestStyle("real estate tour of the living room interior").id).toBe("real-estate");
    expect(bestStyle("").id).toBe("minimal-clean"); // nothing matches → the safe default
    expect(matchStyles("gym workout hype trailer")[0].pack.id).toBe("sports-energy");
  });
});

describe("applyStylePack (mock engine)", () => {
  it("News Studio: grades, per-cut transitions within the overlap, Ken Burns, lower-third bar under the title", async () => {
    seed();
    const r = await applyStylePack(stylePackById("news-studio")!, io);
    for (const id of [1, 2, 3]) expect(layer(id).effects.map((e: { kind: string }) => e.kind)).toEqual(["contrast", "brightness"]);
    expect([1, 2, 3].map((id) => layer(id).transitionIn.engine)).toEqual(["fade", "push", "horizontalWipe"]);
    expect(layer(2).transitionIn.durMs).toBeLessThanOrEqual(400); // crossfade fits the 400ms overlap
    expect(layer(1).transform.scaleX.keys.map((k: { timeMs: number }) => k.timeMs)).toEqual([0, 2400]);
    const t = layer(4);
    expect([t.kind.font, t.kind.size, t.kind.anim.preset]).toEqual(["Arial", Math.round(0.055 * 1080), "typewriter"]);
    expect(t.transform.y.keys[0].value).toBeCloseTo(1920 * 0.82); // moved to the lower third
    const ti = fake.state.p.layers.findIndex((l: { id: number }) => l.id === 4);
    expect(names().slice(ti - 2, ti).sort()).toEqual(["Style · accent", "Style · block"]); // plates sit right under it
    expect(names()).not.toContain("Style · overlay"); // news has no overlay
    expect(r.transitions).toEqual(expect.arrayContaining(["fade", "push", "horizontalWipe"]));
  });

  it("switching style swaps the look; the overlay sits under the titles; re-applying is idempotent", async () => {
    seed();
    await applyStylePack(stylePackById("news-studio")!, io);
    await applyStylePack(stylePackById("tech-neon")!, io);
    expect(names().filter((n: string) => n.startsWith("Style · block") || n.startsWith("Style · accent"))).toEqual([]); // old bars gone
    const ov = names().indexOf("Style · overlay");
    const ti = fake.state.p.layers.findIndex((l: { id: number }) => l.id === 4);
    expect(ov).toBeGreaterThan(-1);
    expect(ov).toBeLessThan(ti); // overlay below the title → titles stay crisp
    // Only the compositable kind (aurora) lands on the shared adjustment layer
    // (seed shinyclouds cleared); vignette can't composite there (it needs the
    // real pixels under it), so it goes on every clip directly instead.
    expect(fake.state.p.layers[ov].effects.map((e: { kind: string }) => e.kind)).toEqual(["aurora"]);
    for (const id of [1, 2, 3]) expect(layer(id).effects.map((e: { kind: string }) => e.kind)).toEqual(["contrast", "saturate", "brightness", "vignette"]);
    const count = fake.state.p.layers.length;
    await applyStylePack(stylePackById("tech-neon")!, io);
    expect(fake.state.p.layers.length).toBe(count);
  });

  it("an overlay made only of direct (per-pixel) kinds skips the adjustment layer and grades every clip instead", async () => {
    seed();
    await applyStylePack(stylePackById("travellers-choice")!, io);
    expect(names()).not.toContain("Style · overlay"); // filmgrain + vignette can't composite on an adjustment layer
    for (const id of [1, 2, 3]) expect(layer(id).effects.map((e: { kind: string }) => e.kind)).toEqual(["saturate", "contrast", "brightness", "filmgrain", "vignette"]);
  });

  it("hero accents land on the first and last clip only", async () => {
    seed();
    await applyStylePack(stylePackById("sports-energy")!, io);
    const has = (id: number) => layer(id).effects.some((e: { kind: string }) => e.kind === "lensflare");
    expect([has(1), has(2), has(3)]).toEqual([true, false, true]);
  });

  it("long titles are shrunk to fit and picture-in-picture clips keep their size", async () => {
    const pip = fake.baseLayer(5, "pip", { kind: "image", src: "p.png", width: 572, height: 1024, crop: null }, 0, 6000, 0.5);
    seed("A really long promotional headline that would never fit", [pip]);
    await applyStylePack(stylePackById("instagram-block")!, io);
    const t = layer(4).kind;
    expect(t.content.length * t.size * 0.55).toBeLessThanOrEqual(1080 * 0.88);
    expect(layer(5).transform.scaleX.keys).toEqual([]); // PiP untouched by Ken Burns
  });
});
