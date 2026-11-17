import { describe, it, expect } from "vitest";
import type { Layer } from "../src/bindings/Layer";
import { clipsEndMs, mediaDropTarget } from "../src/lib/videoSequence";

const L = (kind: string, startMs: number, endMs: number, attach: unknown = null) =>
  ({ id: 0, startMs, endMs, kind: { kind }, attach }) as unknown as Layer;
const seq = [L("video", 0, 5000), L("video", 5000, 10000), L("text", 10000, 30000)];

describe("clipsEndMs", () => {
  it("is the latest video end, ignoring other kinds", () => expect(clipsEndMs(seq)).toBe(10000));
  it("is null when there is no video", () => expect(clipsEndMs([L("text", 0, 3000)])).toBeNull());
});

const withImage = [...seq, L("image", 10000, 13000)];

describe("mediaDropTarget", () => {
  it("snaps a video to the nearest clip edge and ripples", () => {
    expect(mediaDropTarget(seq, 6000, true)).toEqual({ ms: 5000, ripple: true });
    expect(mediaDropTarget(seq, 9000, true)).toEqual({ ms: 10000, ripple: true });
  });
  it("snaps past the last video back to its end", () =>
    expect(mediaDropTarget(seq, 25000, true)).toEqual({ ms: 10000, ripple: true }));
  it("breaks a tie toward the earlier edge", () =>
    expect(mediaDropTarget(seq, 7500, true)).toEqual({ ms: 5000, ripple: true }));
  it("drops a video at the pointer when no video is on the timeline", () =>
    expect(mediaDropTarget([L("text", 0, 3000)], 1234, true)).toEqual({ ms: 1234, ripple: false }));
  it("never snaps or ripples audio or text", () =>
    expect(mediaDropTarget(seq, 6000, false)).toEqual({ ms: 6000, ripple: false }));
  it("counts images as clips", () => expect(clipsEndMs(withImage)).toBe(13000));
  it("ignores images pinned to a 3D shape", () =>
    expect(clipsEndMs([...seq, L("image", 0, 20000, { shapeId: 1 })])).toBe(10000));
  it("snaps an image to the nearest clip edge, image edges included", () =>
    expect(mediaDropTarget(withImage, 12500, true)).toEqual({ ms: 13000, ripple: true }));
  it("snaps to the playhead when it is nearer than any clip edge, without rippling", () =>
    expect(mediaDropTarget(seq, 2800, true, 3000)).toEqual({ ms: 3000, ripple: false }));
  it("prefers the clip edge when it is nearer than the playhead", () =>
    expect(mediaDropTarget(seq, 9000, true, 3000)).toEqual({ ms: 10000, ripple: true }));
  it("prefers the clip edge (and ripples) when the playhead sits on it", () =>
    expect(mediaDropTarget(seq, 5200, true, 5000)).toEqual({ ms: 5000, ripple: true }));
  it("snaps to the playhead when no clip is on the timeline", () =>
    expect(mediaDropTarget([L("text", 0, 3000)], 1234, true, 4000)).toEqual({ ms: 4000, ripple: false }));
  it("never snaps audio to the playhead", () =>
    expect(mediaDropTarget(seq, 2800, false, 3000)).toEqual({ ms: 2800, ripple: false }));
});
