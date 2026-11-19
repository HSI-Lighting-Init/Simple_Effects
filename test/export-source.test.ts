import { describe, expect, it } from "vitest";
import type { Layer } from "../src/bindings/Layer";
import type { LayerKind } from "../src/bindings/LayerKind";
import type { Effect } from "../src/bindings/Effect";
import { keyedVideoSources } from "../src/lib/exportSource";

const effect = (kind: string) => ({ kind }) as unknown as Effect;

function layer(id: number, kind: LayerKind, effects: Effect[] = []): Layer {
  return {
    id,
    name: `layer-${id}`,
    startMs: 0,
    endMs: 1000,
    kind,
    transform: null as never,
    hidden: false,
    attach: null,
    effects,
    transitionIn: null,
    transitionOut: null,
  } as Layer;
}

const video = (src: string) =>
  ({ kind: "video", src, width: 1920, height: 1080, durationMs: 1000, inMs: 0, speed: 1, reverse: false }) as LayerKind;

describe("WP8: Ultra Key clips seek the original, not the seek proxy", () => {
  it("includes a top-level video layer that carries ultrakey", () => {
    const got = keyedVideoSources([layer(1, video("green.mp4"), [effect("ultrakey")])]);
    expect([...got]).toEqual(["green.mp4"]);
  });

  it("excludes a video with no ultrakey", () => {
    const got = keyedVideoSources([layer(1, video("bg.mp4"), [effect("brightness")])]);
    expect(got.size).toBe(0);
  });

  it("looks inside groups", () => {
    const group = {
      kind: "group",
      children: [layer(2, video("nested-green.mp4"), [effect("ultrakey")])],
    } as LayerKind;
    const got = keyedVideoSources([layer(1, group)]);
    expect([...got]).toEqual(["nested-green.mp4"]);
  });

  it("one keyed layer keeps a shared source path on the original", () => {
    const got = keyedVideoSources([
      layer(1, video("shared.mp4"), [effect("brightness")]),
      layer(2, video("shared.mp4"), [effect("ultrakey")]),
    ]);
    expect([...got]).toEqual(["shared.mp4"]);
  });

  it("does not treat a frame-grid cell effect as a video source", () => {
    const grid = {
      kind: "framegrid",
      rows: 1,
      cols: 1,
      cells: [{ src: "cell.png", effects: [effect("ultrakey")] }],
      linked: [],
    } as unknown as LayerKind;
    expect(keyedVideoSources([layer(1, grid)]).size).toBe(0);
  });
});
