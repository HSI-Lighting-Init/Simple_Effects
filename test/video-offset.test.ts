import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `http://asset.localhost/${encodeURIComponent(p)}`,
  invoke: vi.fn(),
}));
const { toMediaTime, SEEK_BIAS_SEC } = await import("../src/lib/media");

// green.mp4: the video stream starts 1/30 s after its audio, so the browser's
// media time 0 is one frame BEFORE the editor's clip time 0.
const GREEN = 512 / 15360;

describe("toMediaTime — the one place clip time becomes media time", () => {
  it("reads clip time t at media time t + offset (frame 60 at 2000 ms)", () => {
    const m = toMediaTime(2.0, GREEN, 9.832);
    expect(m.wanted).toBeCloseTo(2.0 + GREEN + SEEK_BIAS_SEC, 9);
    expect(m.target).toBeCloseTo(2.0 + GREEN + SEEK_BIAS_SEC, 9);
    expect(m.atEnd).toBe(false);
  });

  it("lands INSIDE the frame, not on its boundary", () => {
    // The browser shows the frame with pts <= currentTime and quantizes
    // currentTime: a seek to 2.033332 s showed the frame stamped 2.000 s, not
    // the one stamped 2.033333 s. A bias bigger than that rounding, smaller than a
    // frame, fixes it for any frame rate up to 240 fps.
    expect(SEEK_BIAS_SEC).toBeGreaterThanOrEqual(0.0005);
    expect(SEEK_BIAS_SEC).toBeLessThan(1 / 240);
    expect(toMediaTime(2.0, GREEN, 10).target).toBeGreaterThan(2.0 + GREEN);
    expect(toMediaTime(2.0, GREEN, 10).target).toBeLessThan(2.0 + GREEN + 1 / 240);
  });

  it("an offset-0 file keeps the same frame it always showed", () => {
    expect(toMediaTime(2.0, 0, 10).target).toBeCloseTo(2.0 + SEEK_BIAS_SEC, 9);
    expect(toMediaTime(2.0, 0, 10).target).toBeLessThan(2.0 + 1 / 240);
  });

  it("holds clip time 0 (the first frame) before the clip starts", () => {
    expect(toMediaTime(-0.5, 0, 10).target).toBeCloseTo(SEEK_BIAS_SEC, 9);
    expect(toMediaTime(-0.5, GREEN, 10).target).toBeCloseTo(GREEN + SEEK_BIAS_SEC, 9);
  });

  it("clamps just before the end of the file, after adding the offset", () => {
    const m = toMediaTime(9.9, GREEN, 9.832);
    expect(m.target).toBeCloseTo(9.832 - 0.05, 9);
    expect(m.atEnd).toBe(true);
  });

  it("an unknown length does not clamp", () => {
    const m = toMediaTime(100, GREEN, undefined);
    expect(m.target).toBeCloseTo(100 + GREEN + SEEK_BIAS_SEC, 9);
    expect(m.atEnd).toBe(false);
  });

  it("a proxy (its own offset) maps the same clip time to its own media time", () => {
    // The original needs +1/30 s; a video-only proxy that already starts at 0 needs none.
    expect(toMediaTime(2.0, GREEN, 9.8).target).toBeGreaterThan(toMediaTime(2.0, 0, 9.8).target);
  });
});
