import { describe, it, expect, vi } from "vitest";
import { makeCanvas } from "./setup";
import type { ResolvedEffect } from "../src/bindings/ResolvedEffect";
import type { Texture } from "../src/lib/surface3d";
import { applyEffects, applyCrop } from "../src/lib/effects";
import { STYLE_PACKS, stylePackClipFx, stylePackOverlayFx } from "../src/lib/stylePacks";
import {
  CARD_STACK_FX,
  GRADE_SHOT_FX,
  GRADE_SHOT_OPTIONAL_FX,
} from "../src/lib/rebuildFromAnalysis";
import { SYNTHETIC_GRADE_FX, SYNTHETIC_GRADE_OPTIONAL_FX } from "../src/lib/synthetic";

// WP3: effects run in stack order. The old renderer ran them by category
// (CSS filters, then wipes, then torn edges, then GPU). This file proves two
// things:
//   1. every stack the app GENERATES is already in that old category order, so
//      switching to stack order cannot change how those projects look;
//   2. a hand-built stack (Ultra Key above a colour grade, wipe above a blur)
//      now runs top to bottom.

const CATEGORY: Record<string, "css" | "wipe" | "torn" | "gpu"> = {
  grayscale: "css",
  brightness: "css",
  contrast: "css",
  saturate: "css",
  blur: "css",
  hue: "css",
  invert: "css",
  wipe: "wipe",
  tornedge: "torn",
  shinyclouds: "gpu",
  gpuoverlay: "gpu",
  ultrakey: "gpu",
  caustics: "gpu",
  lensflare: "gpu",
  sparkle: "gpu",
  heathaze: "gpu",
  filmgrain: "gpu",
  vignette: "gpu",
  shimmer: "gpu",
  aurora: "gpu",
  fog: "gpu",
  flap: "gpu",
};
// The old applyEffects order: CSS filters first, then wipes, then torn edges,
// then all GPU effects.
const RANK: Record<string, number> = { css: 0, wipe: 1, torn: 2, gpu: 3 };

/** Ranks a generated stack; describes the first offender when out of order. */
function assertOldCategoryOrder(kinds: string[], where: string) {
  const ranks = kinds.map((k) => {
    const cat = CATEGORY[k];
    expect(cat, `${where}: unknown effect kind ${k}`).toBeTruthy();
    return RANK[cat];
  });
  for (let i = 1; i < ranks.length; i++) {
    expect(
      ranks[i] >= ranks[i - 1],
      `${where}: ${kinds[i]} (rank ${ranks[i]}) follows ${kinds[i - 1]} (rank ${
        ranks[i - 1]
      }) — generated stack is NOT in the old category order`
    ).toBe(true);
  }
}

describe("WP3: generated stacks are already in the old category order", () => {
  for (const pack of STYLE_PACKS) {
    for (const hero of [false, true]) {
      it(`${pack.id} clip stack (${hero ? "hero" : "regular"})`, () => {
        assertOldCategoryOrder(
          stylePackClipFx(pack, hero).map((f) => f.kind),
          `${pack.id} ${hero ? "hero" : "regular"} clip`
        );
      });
    }
    it(`${pack.id} adjustment-layer overlay stack`, () => {
      assertOldCategoryOrder(
        stylePackOverlayFx(pack).map((f) => f.kind),
        `${pack.id} overlay`
      );
    });
  }

  it("rebuild gradeShot: brightness, contrast, saturate, then an optional GPU look", () => {
    const stacks = [[], ["vignette"], ["filmgrain"]].map((optional) => [
      ...GRADE_SHOT_FX,
      ...optional,
    ]);
    for (const stack of stacks) assertOldCategoryOrder(stack, "gradeShot");
    for (const optional of GRADE_SHOT_OPTIONAL_FX) {
      assertOldCategoryOrder([...GRADE_SHOT_FX, optional], "gradeShot");
    }
  });

  it("synthetic gradeShot: brightness, contrast, saturate, then an optional GPU look", () => {
    for (const optional of SYNTHETIC_GRADE_OPTIONAL_FX) {
      assertOldCategoryOrder([...SYNTHETIC_GRADE_FX, optional], "synthetic gradeShot");
    }
  });

  it("card stacks: torn edge only", () => {
    assertOldCategoryOrder([...CARD_STACK_FX], "card stack");
  });
});

// ---------------------------------------------------------------------------
// Recording 2D context: logs draw/fill calls (and the active CSS filter) so the
// tests can assert the ORDER the stack ran in without rasterising anything.
// ---------------------------------------------------------------------------

function makeLogCanvas(w: number, h: number, log: string[]) {
  const store: Record<string, unknown> = {
    canvas: null as unknown,
    filter: "none",
    globalCompositeOperation: "source-over",
    globalAlpha: 1,
    fillStyle: "#000",
    strokeStyle: "#000",
    lineWidth: 1,
    lineJoin: "miter",
    imageSmoothingEnabled: true,
  };
  const methods: Record<string, (...a: unknown[]) => unknown> = {
    clearRect: () => log.push("clear"),
    drawImage: () => log.push(`draw:${String(store.filter)}`),
    fillRect: () => log.push(`fillRect:${String(store.globalCompositeOperation)}`),
    fill: () => log.push(`fill:${String(store.globalCompositeOperation)}`),
    stroke: () => log.push("stroke"),
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    closePath: () => {},
    save: () => {},
    restore: () => {},
    createLinearGradient: (x0: number, y0: number, x1: number, y1: number) => {
      const stops: { at: number; alpha: string }[] = [];
      log.push(`gradient:${x0},${y0},${x1},${y1}`);
      return {
        addColorStop: (at: number, color: string) => {
          stops.push({ at, alpha: color });
          log.push(`stop:${at}:${color}`);
        },
        stops,
      };
    },
  };
  const ctx = new Proxy(store, {
    get(target, prop: string) {
      if (prop in methods) return methods[prop];
      if (prop in target) return target[prop];
      return () => {};
    },
    set(target, prop: string, value) {
      target[prop] = value;
      return true;
    },
  });
  store.canvas = { width: w, height: h };
  const canvas = {
    width: w,
    height: h,
    getContext: (type: string) => (type === "2d" ? ctx : null),
    toDataURL: () => "",
  };
  return canvas;
}

const indexOfDraw = (log: string[], filter: string) => log.indexOf(`draw:${filter}`);

describe("WP3: a hand-built stack runs top to bottom", () => {
  it("[wipe, blur]: the blur runs after the wipe", () => {
    const log: string[] = [];
    const off = makeLogCanvas(100, 100, log) as unknown as HTMLCanvasElement;
    const src = makeCanvas(100, 100) as unknown as Texture;
    const effects: ResolvedEffect[] = [
      { kind: "wipe", angle: 0, position: 1, softness: 0.2, invert: false },
      { kind: "blur", radius: 4 },
    ];
    applyEffects(off, src, 100, 100, effects);
    const wipe = log.findIndex((e) => e.startsWith("fillRect:destination-in"));
    const blur = indexOfDraw(log, "blur(4px)");
    expect(wipe).toBeGreaterThanOrEqual(0);
    expect(blur).toBeGreaterThan(wipe);
  });

  it("[blur, wipe]: the wipe runs after the blur", () => {
    const log: string[] = [];
    const off = makeLogCanvas(100, 100, log) as unknown as HTMLCanvasElement;
    const src = makeCanvas(100, 100) as unknown as Texture;
    const effects: ResolvedEffect[] = [
      { kind: "blur", radius: 4 },
      { kind: "wipe", angle: 0, position: 1, softness: 0.2, invert: false },
    ];
    applyEffects(off, src, 100, 100, effects);
    const wipe = log.findIndex((e) => e.startsWith("fillRect:destination-in"));
    const blur = indexOfDraw(log, "blur(4px)");
    expect(blur).toBeGreaterThanOrEqual(0);
    expect(blur).toBeLessThan(wipe);
  });
});

// The GPU chain is replaced by a recorder: it proves the GPU run is invoked at
// its stack position (and with every consecutive GPU effect in one chain).
const events = vi.hoisted(() => ({ log: [] as string[] }));
vi.mock("../src/lib/gpuFx", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/lib/gpuFx")>();
  return {
    ...mod,
    runPasses: (_input: unknown, _w: number, _h: number, passes: unknown[]) => {
      events.log.push(`gpu:${passes.length}`);
      return { ok: true, canvas: { width: 4, height: 4 } as unknown as HTMLCanvasElement };
    },
  };
});

const ultraKey = (): Extract<ResolvedEffect, { kind: "ultrakey" }> => ({
  kind: "ultrakey",
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
  keyColorKeys: [],
  output: 0,
  setting: 0,
});

describe("WP3: Ultra Key first runs before a CSS colour filter that follows it", () => {
  it("[ultrakey, saturate]: the key chain runs, then the colour filter", () => {
    events.log.length = 0;
    const log = events.log;
    const off = makeLogCanvas(100, 100, log) as unknown as HTMLCanvasElement;
    const src = makeCanvas(100, 100) as unknown as Texture;
    const effects: ResolvedEffect[] = [
      ultraKey(),
      { kind: "saturate", amount: 1.4 },
    ];
    applyEffects(off, src, 100, 100, effects);
    const key = log.findIndex((e) => e.startsWith("gpu:"));
    const saturate = indexOfDraw(log, "saturate(1.4)");
    expect(key).toBeGreaterThanOrEqual(0);
    expect(log.filter((e) => e.startsWith("gpu:"))).toHaveLength(1);
    expect(saturate).toBeGreaterThan(key);
  });

  it("[saturate, ultrakey]: the colour filter runs first, then the key chain", () => {
    events.log.length = 0;
    const log = events.log;
    const off = makeLogCanvas(100, 100, log) as unknown as HTMLCanvasElement;
    const src = makeCanvas(100, 100) as unknown as Texture;
    const effects: ResolvedEffect[] = [
      { kind: "saturate", amount: 1.4 },
      ultraKey(),
    ];
    applyEffects(off, src, 100, 100, effects);
    const key = log.findIndex((e) => e.startsWith("gpu:"));
    const saturate = indexOfDraw(log, "saturate(1.4)");
    expect(saturate).toBeGreaterThanOrEqual(0);
    expect(key).toBeGreaterThan(saturate);
  });
});

// ---------------------------------------------------------------------------
// WP7: Crop. One destination-in rect pass with a feather measured in SOURCE
// pixels, scaled by the same radius factor Ultra Key uses, so a preview-capped
// texture feathers the same amount as the full-resolution export.
// ---------------------------------------------------------------------------

const crop = (over: Partial<Extract<ResolvedEffect, { kind: "crop" }>> = {}) =>
  ({
    kind: "crop",
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    feather: 0,
    ...over,
  }) as Extract<ResolvedEffect, { kind: "crop" }>;

describe("WP7: crop mask + edge feather", () => {
  it("is a no-op when nothing is cropped and there is no feather", () => {
    const log: string[] = [];
    const oc = makeLogCanvas(100, 100, log).getContext("2d") as unknown as CanvasRenderingContext2D;
    applyCrop(oc, 100, 100, crop(), 1);
    expect(log.filter((e) => e.startsWith("fill"))).toEqual([]);
  });

  it("a hard crop (no feather) still keeps the inside opaque", () => {
    const log: string[] = [];
    const oc = makeLogCanvas(100, 100, log).getContext("2d") as unknown as CanvasRenderingContext2D;
    applyCrop(oc, 100, 100, crop({ left: 10, right: 10 }), 1);
    // Hard steps at 10% and 90%: transparent outside, opaque in between.
    expect(log).toContain("stop:0.1:rgba(0,0,0,1)");
    expect(log).toContain("stop:0.9:rgba(0,0,0,1)");
    expect(log.filter((e) => e.startsWith("fillRect:destination-in"))).toHaveLength(1);
  });

  it("masks to the crop rect and feathers the cropped edges", () => {
    const log: string[] = [];
    const oc = makeLogCanvas(100, 100, log).getContext("2d") as unknown as CanvasRenderingContext2D;
    applyCrop(oc, 100, 100, crop({ left: 10, right: 10, feather: 20 }), 1);
    // Horizontal ramp: cut at 10%..90%, feather 20px = 0.10..0.30 and 0.70..0.90.
    const stops = log.filter((e) => e.startsWith("stop:"));
    expect(stops).toContain("stop:0.1:rgba(0,0,0,0)");
    expect(stops).toContain("stop:0.3:rgba(0,0,0,1)");
    expect(stops).toContain("stop:0.7:rgba(0,0,0,1)");
    expect(stops).toContain("stop:0.9:rgba(0,0,0,0)");
    expect(log.filter((e) => e.startsWith("fillRect:destination-in"))).toHaveLength(1);
  });

  it("scales the feather with the radius factor (preview cap matches export)", () => {
    const full: string[] = [];
    const capped: string[] = [];
    const c = crop({ left: 10, right: 10, feather: 20 });
    applyCrop(
      makeLogCanvas(100, 100, full).getContext("2d") as unknown as CanvasRenderingContext2D,
      100,
      100,
      c,
      1
    );
    applyCrop(
      makeLogCanvas(100, 100, capped).getContext("2d") as unknown as CanvasRenderingContext2D,
      100,
      100,
      c,
      0.5
    );
    expect(full).toContain("stop:0.3:rgba(0,0,0,1)");
    expect(capped).toContain("stop:0.2:rgba(0,0,0,1)");
    // Same 20 source px on a half-size texture = 10 texture px = 0.10 of the width.
    expect(capped).not.toContain("stop:0.3:rgba(0,0,0,1)");
  });

  it("runs at its stack position: [crop, saturate] masks before the filter", () => {
    const log: string[] = [];
    const off = makeLogCanvas(100, 100, log) as unknown as HTMLCanvasElement;
    const src = makeCanvas(100, 100) as unknown as Texture;
    const before = log.length;
    applyEffects(off, src, 100, 100, [crop({ left: 10, right: 10 }), { kind: "saturate", amount: 2 }]);
    const mask = log.findIndex((e, i) => i >= before && e.startsWith("fillRect:destination-in"));
    const saturate = indexOfDraw(log, "saturate(2)");
    expect(mask).toBeGreaterThanOrEqual(0);
    expect(saturate).toBeGreaterThan(mask);
  });
});
