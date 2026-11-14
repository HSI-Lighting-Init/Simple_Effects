import { describe, it, expect } from "vitest";
import type { Layer } from "../src/bindings/Layer";
import {
  DEFAULT_EXPORT_SETTINGS,
  type ExportSettings,
  bitrateForSize,
  exportPlan,
  codecsFor,
  normalizeExportSettings,
  qualityRf,
  sizeForBitrate,
  subtitleCues,
} from "../src/lib/exportSettings";

// Only the fields subtitleCues reads; the rest of Layer doesn't matter here.
const text = (id: number, startMs: number, endMs: number, content: string, hidden = false) =>
  ({ id, name: content, startMs, endMs, hidden, kind: { kind: "text", content } }) as unknown as Layer;
const group = (name: string, startMs: number, endMs: number, children: Layer[], hidden = false) =>
  ({ id: 100, name, startMs, endMs, hidden, kind: { kind: "group", children } }) as unknown as Layer;

describe("export settings", () => {
  it("offers only the codecs each container's players read", () => {
    expect(codecsFor("mp4")).toEqual(["h264", "h265", "av1"]);
    expect(codecsFor("mkv")).toEqual(["h264", "h265", "av1"]);
    expect(codecsFor("webm")).toEqual(["vp9", "av1"]);
  });

  it("target size ↔ bitrate round-trips and leaves room for the audio", () => {
    const bps = bitrateForSize(25, 30_000, 192);
    expect(bps).toBe(Math.round((25 * 8 * 1024 * 1024) / 30 - 192_000));
    expect(sizeForBitrate(bps, 30_000, 192)).toBeCloseTo(25, 4); // whole-bit rounding only
    expect(bitrateForSize(25, 30_000, 0)).toBeGreaterThan(bps); // no audio: all of it is video
    expect(bitrateForSize(0.01, 600_000, 192)).toBe(100_000); // never below the encoder floor
  });

  it("level labels mirror the Rust quality table (x264 = HandBrake's RF scale)", () => {
    expect([1, 2, 3, 4, 5].map((l) => qualityRf("h264", l))).toEqual([16, 18, 20, 23, 26]);
    expect(qualityRf("h265", 2)).toBe(22);
    expect(qualityRf("av1", 3)).toBe(35);
  });

  it("repairs saved settings: unknown values fall back, a codec the container can't hold is swapped", () => {
    expect(normalizeExportSettings(null)).toEqual(DEFAULT_EXPORT_SETTINGS);
    const s = normalizeExportSettings({ container: "webm", codec: "h264", level: 9, encoderSpeed: "ludicrous" });
    expect(s.container).toBe("webm");
    expect(s.codec).toBe("vp9");
    expect(s.level).toBe(5);
    expect(s.encoderSpeed).toBe("balanced");
  });

  it("frame plan mirrors Rust can_copy, and never drops subtitles it can't mux", () => {
    const s = (o: Partial<ExportSettings>) => ({ ...DEFAULT_EXPORT_SETTINGS, ...o });
    const bitrate = s({ rateMode: "bitrate" });
    // Same truth table as lib.rs `the_upload_is_copied_only_when_it_already_is_the_requested_stream`.
    expect(exportPlan(bitrate, true, true).copied).toBe(true); // GPU H.264 at the target
    expect(exportPlan(bitrate, false, true).copied).toBe(false); // VP9 intermediate → H.264
    expect(exportPlan(s({}), true, true).copied).toBe(false); // quality: CRF re-encode
    const webm = s({ container: "webm", codec: "vp9" });
    expect(exportPlan(webm, false, false).copied).toBe(true);
    expect(exportPlan(webm, false, true).copied).toBe(false);
    // Separate track: out of the pixels only when ffmpeg can actually mux the track.
    expect(exportPlan(s({ subtitleMode: "track" }), false, true).burnSubtitles).toBe(false);
    expect(exportPlan({ ...webm, subtitleMode: "track" }, false, false).burnSubtitles).toBe(true);
    expect(exportPlan(s({ subtitleMode: "both" }), false, true).burnSubtitles).toBe(true);
  });

  it("fast mode: the GPU encodes at a fixed QP — the level's for a final H.264, near-lossless to re-encode", () => {
    const s = (o: Partial<ExportSettings>) => ({ ...DEFAULT_EXPORT_SETTINGS, ...o });
    // Constant-quality H.264 is encoded once, on the GPU (no high-bitrate intermediate).
    expect(exportPlan(s({ level: 2 }), true, true).gpuQp).toBe(23);
    expect(exportPlan(s({ level: 5 }), true, true).gpuQp).toBe(30);
    expect(exportPlan(s({ container: "mkv", level: 1 }), true, true).gpuQp).toBe(22);
    // ffmpeg re-encodes these: a near-lossless intermediate sized by the content, not a fixed bitrate.
    expect(exportPlan(s({ codec: "h265" }), true, true).gpuQp).toBe(18);
    expect(exportPlan(s({ codec: "av1", rateMode: "bitrate" }), true, true).gpuQp).toBe(18);
    // H.264 at a target bitrate is encoded at that bitrate and kept.
    expect(exportPlan(s({ rateMode: "bitrate" }), true, true).gpuQp).toBe(null);
    // No GPU H.264 path: nothing to set.
    expect(exportPlan(s({}), false, true).gpuQp).toBe(null);
  });

  it("subtitle cues: the Subtitles group's lines, clipped to the group and range, in export time", () => {
    const layers = [
      group("Subtitles", 1000, 9000, [
        text(1, 500, 2000, "starts before the group"),
        text(2, 3000, 4000, "inside"),
        text(3, 4000, 5000, "hidden line", true),
        text(4, 8000, 12000, "ends after the range"),
        text(5, 20000, 21000, "outside the range"),
      ]),
      group("Titles", 0, 9000, [text(6, 0, 9000, "not a subtitle")]),
      group("Subtitles", 0, 9000, [text(7, 0, 9000, "hidden group")], true),
    ];
    // Export range 1500..8500 → time 0 = comp 1500.
    expect(subtitleCues(layers, 1500, 8500)).toEqual([
      { startMs: 0, endMs: 500, text: "starts before the group" },
      { startMs: 1500, endMs: 2500, text: "inside" },
      { startMs: 6500, endMs: 7000, text: "ends after the range" },
    ]);
  });
});
