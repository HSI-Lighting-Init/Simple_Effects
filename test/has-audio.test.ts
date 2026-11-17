import { describe, it, expect, vi } from "vitest";

const answers = new Map<string, boolean | null | "throw">();
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => `http://asset.localhost/${encodeURIComponent(p)}` }));
vi.mock("../src/lib/api", () => ({
  mediaHasAudio: async (p: string) => {
    const a = answers.get(p);
    if (a === "throw") throw new Error("ipc down");
    return a ?? null;
  },
}));
const { hasAudio, waveformError } = await import("../src/lib/waveform");

describe("hasAudio", () => {
  it("trusts the file's track list when the backend can read it", async () => {
    answers.set("a.mp4", true);
    answers.set("b.mp4", false);
    expect(await hasAudio("a.mp4")).toBe(true);
    expect(await hasAudio("b.mp4")).toBe(false);
    expect(waveformError("a.mp4")).toBeNull(); // nothing was decoded
  });

  it("falls back to decoding when the backend doesn't know, and keeps why that failed", async () => {
    answers.set("c.mkv", null);
    answers.set("d.webm", "throw");
    // vitest runs in node: no Web Audio, so the decode fallback fails
    expect(await hasAudio("c.mkv")).toBe(false);
    expect(await hasAudio("d.webm")).toBe(false);
    expect(waveformError("c.mkv")).toMatch(/Web Audio/);
  });
});
