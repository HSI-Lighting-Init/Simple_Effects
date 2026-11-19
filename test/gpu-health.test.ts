import { describe, it, expect } from "vitest";
import type { Project } from "../src/bindings/Project";
import type { Layer } from "../src/bindings/Layer";
import type { FrameCell } from "../src/bindings/FrameCell";
import type { Effect } from "../src/bindings/Effect";
import { projectUsesGpu } from "../src/lib/effects";

const ultraKey = { kind: "ultrakey" } as Effect;
const blur = { kind: "blur" } as Effect;

function layer(kind: Layer["kind"], effects: Effect[] = []): Layer {
  return {
    id: 1,
    name: "L",
    startMs: 0,
    endMs: 1000,
    kind,
    transform: {} as Layer["transform"],
    hidden: false,
    attach: null,
    effects,
  };
}

function image(effects: Effect[] = []): Layer {
  return layer({ kind: "image" } as Layer["kind"], effects);
}

function project(layers: Layer[]): Project {
  return {
    width: 480,
    height: 360,
    fps: 30,
    durationMs: 1000,
    layers,
    media: [],
    durationSetByUser: false,
  };
}

describe("projectUsesGpu", () => {
  it("counts a project whose only effect is ultrakey", () => {
    expect(projectUsesGpu(project([image([ultraKey])]))).toBe(true);
  });

  it("counts ultrakey on a layer inside a group", () => {
    const group = layer({ kind: "group", children: [image([ultraKey])] } as Layer["kind"]);
    expect(projectUsesGpu(project([group]))).toBe(true);
  });

  it("counts ultrakey in a frame-grid cell", () => {
    const cell = { effects: [ultraKey] } as FrameCell;
    const grid = layer({ kind: "framegrid", cells: [cell], linked: [] } as Layer["kind"]);
    expect(projectUsesGpu(project([grid]))).toBe(true);
  });

  it("ignores projects with no GPU effects", () => {
    expect(projectUsesGpu(project([image([blur])]))).toBe(false);
    expect(projectUsesGpu(project([image()]))).toBe(false);
  });
});
