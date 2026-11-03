import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => `http://asset.localhost/${encodeURIComponent(p)}` }));
const { getMediaUrl } = await import("../src/lib/media");

describe("getMediaUrl", () => {
  it("names the file on failure and retries instead of caching the failure", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(new Blob([new Uint8Array([1, 2, 3])])));
    vi.stubGlobal("fetch", fetchMock);
    const path = "C:\\clips\\a.mp4";
    await expect(getMediaUrl(path)).rejects.toThrow(`Couldn't load ${path}: TypeError: Failed to fetch`);
    await expect(getMediaUrl(path)).rejects.toThrow(`Couldn't load ${path}: Error: HTTP 404`);
    await expect(getMediaUrl(path)).resolves.toMatch(/^blob:/);
    await expect(getMediaUrl(path)).resolves.toMatch(/^blob:/); // cached now
    expect(fetchMock).toHaveBeenCalledTimes(3);
    vi.unstubAllGlobals();
  });
});
