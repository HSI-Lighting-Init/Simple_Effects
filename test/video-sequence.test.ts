import { describe, it, expect } from "vitest";
import type { Layer } from "../src/bindings/Layer";
import { mediaDropTarget, videoEndMs } from "../src/lib/videoSequence";

const L = (kind: string, startMs: number, endMs: number) =>
  ({ id: 0, startMs, endMs, kind: { kind } }) as unknown as Layer;
const seq = [L("video", 0, 5000), L("video", 5000, 10000), L("text", 10000, 30000)];

describe("videoEndMs", () => {
  it("is the latest video end, ignoring other kinds", () => expect(videoEndMs(seq)).toBe(10000));
  it("is null when there is no video", () => expect(videoEndMs([L("text", 0, 3000)])).toBeNull());
});

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
  it("never snaps or ripples images/audio", () =>
    expect(mediaDropTarget(seq, 6000, false)).toEqual({ ms: 6000, ripple: false }));
});
