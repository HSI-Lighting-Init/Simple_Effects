import { describe, it, expect } from "vitest";
import type { Layer } from "../src/bindings/Layer";
import { isTucked, linkedSounds, soundOwner, tuckedSounds } from "../src/lib/linkedSound";

const V = (id: number) => ({ id, startMs: 0, endMs: 5000, kind: { kind: "video", src: "a.mp4" } }) as unknown as Layer;
const S = (id: number, video: number, tucked: boolean) =>
  ({ id, startMs: 0, endMs: 5000, kind: { kind: "audio", src: "a.mp4", linkedVideo: video, tucked } }) as unknown as Layer;
const layers = [V(1), S(2, 1, true), V(3), S(4, 3, false), S(5, 99, true)];

describe("linked sounds", () => {
  it("a sound is tucked only when its video is in the list", () => {
    expect([isTucked(layers[1], layers), isTucked(layers[3], layers), isTucked(layers[4], layers)]).toEqual([true, false, false]);
  });
  it("finds a video's tucked and linked sounds", () => {
    expect(tuckedSounds(layers, 1).map((l) => l.id)).toEqual([2]);
    expect(tuckedSounds(layers, 3)).toEqual([]);
    expect(linkedSounds(layers, 3).map((l) => l.id)).toEqual([4]);
  });
  it("names a sound's video, or null when it's gone or not a sound", () => {
    expect([soundOwner(layers, 4), soundOwner(layers, 5), soundOwner(layers, 1)]).toEqual([3, null, null]);
  });
});
