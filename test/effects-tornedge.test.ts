import { describe, it, expect } from "vitest";
import { applyEffects, applyTornEdge, tornEffects } from "../src/lib/effects";
import { makeCanvas } from "./setup";
import type { ResolvedEffect } from "../src/bindings/ResolvedEffect";
import type { Texture } from "../src/lib/surface3d";

// Same headless canvas mock the transition tests use: no real rasterisation,
// but every draw call (moveTo/lineTo/fill/stroke/etc) executes for real, so
// this catches exceptions, bad params and logic errors in the jagged-polygon
// path building — the same bar Wipe's tests hold to.

type TornEdgeRE = Extract<ResolvedEffect, { kind: "tornedge" }>;

function tornEdge(overrides: Partial<TornEdgeRE> = {}): TornEdgeRE {
  return {
    kind: "tornedge",
    side: 0,
    depth: 0.12,
    seed: 1,
    toothCount: 16,
    paperWidth: 10,
    paperColor: { r: 245, g: 242, b: 235, a: 255 },
    ...overrides,
  };
}

describe("tornEffects", () => {
  it("filters to only the tornedge-kind effects, in order", () => {
    const effects: ResolvedEffect[] = [
      { kind: "grayscale", amount: 1 },
      tornEdge({ seed: 1 }),
      { kind: "blur", radius: 2 },
      tornEdge({ seed: 2 }),
    ];
    const picked = tornEffects(effects);
    expect(picked.map((e) => e.seed)).toEqual([1, 2]);
  });
});

describe("applyTornEdge", () => {
  it("runs without throwing for every side, with and without a paper strip", () => {
    const oc = makeCanvas(200, 100).getContext("2d") as unknown as CanvasRenderingContext2D;
    for (const side of [0, 1, 2, 3]) {
      expect(() => applyTornEdge(oc, 200, 100, tornEdge({ side }))).not.toThrow();
    }
    expect(() => applyTornEdge(oc, 200, 100, tornEdge({ paperWidth: 0 }))).not.toThrow();
  });

  it("no-ops on a zero-sized layer instead of throwing", () => {
    const oc = makeCanvas(0, 0).getContext("2d") as unknown as CanvasRenderingContext2D;
    expect(() => applyTornEdge(oc, 0, 0, tornEdge())).not.toThrow();
  });

  it("wires into applyEffects the same way wipe does", () => {
    const canvas = makeCanvas(200, 100);
    const off = canvas as unknown as HTMLCanvasElement;
    const src = makeCanvas(200, 100) as unknown as Texture;
    expect(() => applyEffects(off, src, 200, 100, [tornEdge()])).not.toThrow();
  });
});
