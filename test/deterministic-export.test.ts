import { describe, it, expect } from "vitest";
import { Muxer, ArrayBufferTarget } from "webm-muxer";
import { createUploadTarget } from "../src/lib/deterministicExport";

// Feed the same fake VP9 chunks to a muxer; ~20 MB total so several upload
// slices and the finalize-time header patches all run.
function feed(muxer: Muxer<never>, frames = 20, frameBytes = 1_000_000) {
  const data = new Uint8Array(frameBytes).map((_, i) => i & 255);
  for (let i = 0; i < frames; i++) muxer.addVideoChunkRaw(data, i % 10 === 0 ? "key" : "delta", i * 33333);
  muxer.finalize();
}
const video = { codec: "V_VP9", width: 1920, height: 1080, frameRate: 30 };

describe("createUploadTarget (streamed WebM export)", () => {
  it("reassembles to the same WebM the in-memory target produces", async () => {
    const mem = new Muxer({ target: new ArrayBufferTarget(), video });
    feed(mem as never);
    const expected = new Uint8Array(mem.target.buffer);

    const file = new Uint8Array(expected.length + 1024); // the Rust side's offset-addressed file
    const writes: number[] = [];
    let busy = false;
    const up = createUploadTarget(async (data, position) => {
      expect(busy, "uploads must be strictly sequential").toBe(false);
      busy = true;
      await new Promise((r) => setTimeout(r, 1));
      file.set(data, position);
      writes.push(position);
      busy = false;
    });
    const streamed = new Muxer({ target: up.target, video });
    feed(streamed as never);
    await up.settle(true);

    expect(up.size).toBe(expected.length);
    expect(writes.length).toBeGreaterThan(1);
    // Buffer.equals, not toEqual: deep-diffing 20 MB typed arrays OOMs the worker.
    expect(Buffer.from(file.buffer, 0, up.size).equals(Buffer.from(expected))).toBe(true);
  });

  it("surfaces an upload failure instead of dropping data", async () => {
    const up = createUploadTarget(async () => {
      throw new Error("disk full");
    });
    feed(new Muxer({ target: up.target, video }) as never);
    await expect(up.settle(true)).rejects.toThrow("disk full");
  });
});
