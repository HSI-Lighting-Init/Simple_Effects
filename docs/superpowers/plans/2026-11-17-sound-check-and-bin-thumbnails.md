# Reliable Sound Check, Fast Media-Bin Thumbnails — Implementation Plan

> **For the implementing agent:** work task by task, in order. Steps use checkbox
> (`- [ ]`) syntax — tick them as you go. Do not skip the "run it and see it fail"
> steps. If a step's expected output doesn't match, stop and report; don't improvise
> a different design.

**Goal:** Videos never lose their sound because the browser can't decode it: the
backend reads the file's track list instead. Media-bin thumbnails and size/length
reads stop copying whole files into memory.

**Architecture:** A small Rust module walks an MP4/MOV file's box headers (seeking
past media data) to find a sound track; `hasAudio` asks it first and only falls back
to today's browser decode when the container is unknown. `media.ts` reads
size/length/thumbnail straight from the file URL (the asset protocol serves byte
ranges), with today's blob path as the thumbnail fallback. A sound whose waveform
can't be decoded draws a plain strip and says why in the clip's tooltip.

**Tech Stack:** Tauri 2.11 (Rust std only), React + TypeScript, vitest.

**Spec:** `docs/superpowers/specs/2026-11-17-sound-check-and-bin-thumbnails-design.md` — read it first.

## Global Constraints

- **Do not commit, push, create or switch branches.** Leave every change uncommitted; it will be reviewed as a diff.
- **Targeted edits only.** Never reformat whole files (no prettier / `cargo fmt` on `src/App.tsx` or `src-tauri/src/lib.rs`). Match the surrounding style; keep comments short and about *why*.
- Don't touch untracked files (`installers/`, `*.csv`) or anything not named in a task.
- No new npm packages, no new Rust crates (std `Read`/`Seek` only). No ffmpeg/ffprobe.
- **Don't change playback**: `getMediaUrl`, the video pool, `VideoNode`, `AudioLayers` stay as they are (they still need the blob; that's a separate plan).
- Run every command from the repo root (no `cd … &&`). If PowerShell blocks `npx.ps1`, use `npx.cmd` with the same arguments.
- Baseline (verified 2026-11-17, build #88): `npx tsc --noEmit` clean · `npx vitest run` 316 passed · `cargo test --manifest-path src-tauri/Cargo.toml --lib` 260 passed, 7 ignored. Everything must still be green at the end. If an unrelated test fails, report it — don't fix it.

## Review Focus

No unit test covers these; each is a manual check (the reviewer runs the ones you can't):

1. **Installed (release) app:** Media-bin thumbnails still appear. The release page's origin differs from dev, so drawing from the file URL could be refused — the blob fallback must kick in, never a blank item. → Task 3
2. **The low-spec PC:** `Anara by chef kk.mp4` gets *Show audio track* and plays its sound in preview and export. (Tested by the user after install.) → Task 5
3. **A video with no sound track** still gets no sound layer (no Show item). → Task 1 test + Task 3 check
4. **An MKV/WebM with sound** still gets its sound through the fallback. → Task 2 test + Task 3 check
5. **A thumbnail load that stalls without an error event** falls back after the timeout instead of leaving the bin item blank forever. → Task 3

---

### Task 1: Read the track list (Rust)

**Files:**
- Create: `src-tauri/src/mp4_tracks.rs`
- Modify: `src-tauri/src/lib.rs` — `mod mp4_tracks;` (with the other `mod`s), new command `media_has_audio`, registered in `invoke_handler` next to `add_video_layer`
- Modify: `src/lib/api.ts` — add `mediaHasAudio`

**Interfaces:**
- Produces (Rust): `pub(crate) fn has_sound_track<R: std::io::Read + std::io::Seek>(r: &mut R) -> Option<bool>` — `Some(true)` a sound track exists, `Some(false)` the track list was read and has none, `None` unknown.
- Produces (command): `fn media_has_audio(path: String) -> Option<bool>` — opens the file (`BufReader`), returns `has_sound_track`; any IO error → `None`. Doc comment: *whether a video has a sound track, read from its MP4/MOV track list without decoding; None = unknown (other container / unreadable)*.
- Produces (TS): `mediaHasAudio(path: string): Promise<boolean | null>` → `invoke("media_has_audio", { path })`.

**Parsing rules (the algorithm the tests pin):**
- A box is a 32-bit big-endian size + 4-byte type. Size `1` = a 64-bit size follows (16-byte header); size `0` = the box runs to the end of its parent (the file, at top level). A size smaller than its header, or a box running past its parent's end → `None`.
- Every type must be 4 bytes in `0x20..=0x7E`, otherwise → `None` (Matroska/WebM, AVI, random bytes).
- Walk top-level boxes to the end of the file. Descend only `moov` → each `trak` → `mdia` → `hdlr`. In `hdlr`, the handler type is body bytes `8..12` (ISO: version/flags, pre_defined, **handler_type**; QuickTime: version/flags, component type `mhlr`, **subtype** — same offset). `soun` → `Some(true)`.
- `moov` read with no `soun` → `Some(false)`. End of file without `moov` → `None`.
- `seek` past every other box body; never read media data. Give up with `None` after 100 000 boxes, so a corrupt file can't spin forever.

- [x] **Step 1: Write the failing tests** at the bottom of the new `src-tauri/src/mp4_tracks.rs` (create it with a short `//!` header and these tests first; add `mod mp4_tracks;` to `lib.rs`):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    /// One box: 32-bit size + type + body.
    fn bx(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut v = ((body.len() + 8) as u32).to_be_bytes().to_vec();
        v.extend_from_slice(kind);
        v.extend_from_slice(body);
        v
    }
    /// A track whose media handler is `handler` (ISO layout).
    fn trak(handler: &[u8; 4]) -> Vec<u8> {
        let mut h = vec![0u8; 8];
        h.extend_from_slice(handler);
        h.extend_from_slice(&[0u8; 13]);
        bx(b"trak", &bx(b"mdia", &[bx(b"mdhd", &[0u8; 24]), bx(b"hdlr", &h)].concat()))
    }
    fn ftyp() -> Vec<u8> { bx(b"ftyp", b"isom\0\0\x02\0isomiso2avc1mp41") }
    fn check(bytes: Vec<u8>) -> Option<bool> { has_sound_track(&mut Cursor::new(bytes)) }

    #[test]
    fn finds_a_sound_track() {
        let moov = bx(b"moov", &[bx(b"mvhd", &[0u8; 100]), trak(b"vide"), trak(b"soun")].concat());
        assert_eq!(check([ftyp(), moov, bx(b"mdat", &[7u8; 500])].concat()), Some(true));
    }

    #[test]
    fn a_video_without_sound_is_false() {
        assert_eq!(check([ftyp(), bx(b"moov", &trak(b"vide")), bx(b"mdat", &[7u8; 500])].concat()), Some(false));
    }

    #[test]
    fn reads_moov_after_a_large_size_mdat() {
        // size 1 = the real size follows as 64 bits (cameras write mdat this way)
        let mut mdat = 1u32.to_be_bytes().to_vec();
        mdat.extend_from_slice(b"mdat");
        mdat.extend_from_slice(&(16u64 + 1000).to_be_bytes());
        mdat.extend_from_slice(&[7u8; 1000]);
        assert_eq!(check([ftyp(), mdat, bx(b"moov", &[trak(b"vide"), trak(b"soun")].concat())].concat()), Some(true));
    }

    #[test]
    fn a_last_box_with_size_zero_runs_to_the_end() {
        let mut mdat = 0u32.to_be_bytes().to_vec();
        mdat.extend_from_slice(b"mdat");
        mdat.extend_from_slice(&[7u8; 300]);
        assert_eq!(check([ftyp(), bx(b"moov", &trak(b"soun")), mdat].concat()), Some(true));
    }

    #[test]
    fn finds_a_quicktime_sound_handler() {
        let mut h = vec![0u8; 4];
        h.extend_from_slice(b"mhlr");
        h.extend_from_slice(b"soun");
        h.extend_from_slice(&[0u8; 13]);
        let trak = bx(b"trak", &bx(b"mdia", &bx(b"hdlr", &h)));
        assert_eq!(check([bx(b"wide", &[]), bx(b"mdat", &[1u8; 64]), bx(b"moov", &trak)].concat()), Some(true));
    }

    #[test]
    fn a_file_without_moov_is_unknown() {
        assert_eq!(check([ftyp(), bx(b"mdat", &[7u8; 500])].concat()), None);
    }

    #[test]
    fn not_an_mp4_is_unknown() {
        // Matroska / WebM start with the EBML magic number
        assert_eq!(check(vec![0x1A, 0x45, 0xDF, 0xA3, 0x9F, 0x42, 0x86, 0x81, 0x01, 0x42, 0xF7, 0x81]), None);
    }

    #[test]
    fn a_broken_size_is_unknown_not_a_hang() {
        let mut b = ftyp();
        b.extend_from_slice(&4u32.to_be_bytes()); // smaller than its own header
        b.extend_from_slice(b"moov");
        assert_eq!(check(b), None);
    }
}
```

- [x] **Step 2: Run them and see them fail to compile**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib mp4_tracks`
Expected: `cannot find function has_sound_track`.

- [x] **Step 3: Implement** `has_sound_track` per the rules above, the `media_has_audio` command (+ registration), and the TS wrapper.

- [x] **Step 4: Run** `cargo test --manifest-path src-tauri/Cargo.toml --lib` → all pass (260 + 8); `npx tsc --noEmit` → clean.

---

### Task 2: `hasAudio` asks the track list first; waveform failures keep their reason

**Files:**
- Modify: `src/lib/waveform.ts` — `loadAudioPeaks`, `hasAudio`; add `waveformError`
- Create: `test/has-audio.test.ts`

**Interfaces:**
- Consumes: Task 1's `mediaHasAudio`.
- Produces: `hasAudio(src: string): Promise<boolean>` (same signature, so `App.tsx` doesn't change) — `mediaHasAudio(src)` first (a rejection counts as unknown); only when it's `null` decode as today.
- Produces: `waveformError(src: string): string | null` — why the last decode of `src` failed: `"Web Audio isn't available"` when no `AudioContext` could be made, `"no audio data decoded"` for an empty result, otherwise `String(error)` of the thrown error (e.g. `EncodingError: Unable to decode audio data`). `null` when nothing failed.

- [x] **Step 1: Write the failing test** `test/has-audio.test.ts`:

```ts
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
```

- [x] **Step 2: Run it and see it fail** — `npx vitest run test/has-audio.test.ts` → `waveformError` is not exported / `a.mp4` case returns false.

- [x] **Step 3: Implement** the two functions in `waveform.ts` (a module-level `Map<string, string>` of reasons, set in each failing branch of `loadAudioPeaks`). Update `hasAudio`'s doc comment.

- [x] **Step 4: Run** `npx vitest run` → all pass (316 + 2); `npx tsc --noEmit` → clean.

---

### Task 3: Size, length and thumbnails straight from the file

**Files:**
- Modify: `src/lib/media.ts` — `getVideoMeta`, `getAudioMeta`, `getVideoPoster` (~lines 59-122), header comment

**Interfaces:**
- Signatures unchanged: `getVideoMeta(path)`, `getAudioMeta(path)`, `getVideoPoster(path): Promise<string>`.
- New private helper: `posterFrom(url: string, crossOrigin: boolean): Promise<string>` — today's poster logic (load, seek to `min(0.1, duration/2)`, draw 160 px wide, JPEG 0.7) for a given URL.

- [x] **Step 1: Implement.**
  - `getVideoMeta` / `getAudioMeta`: set the throwaway element's `src` to `convertFileSrc(path)` instead of `await getMediaUrl(path)` (no `crossOrigin` — nothing is drawn).
  - `getVideoPoster`: `posterFrom(convertFileSrc(path), true)` (sets `crossOrigin = "anonymous"`); if it rejects for any reason — load error, a `SecurityError` from `toDataURL`, or **no frame within 8 s** — fall back to `posterFrom(await getMediaUrl(path), false)`.
  - Every throwaway element releases its media once it settles (`removeAttribute("src")` then `load()`).
  - Header comment: playback and export still use blob URLs (canvas-safe); probes read the file directly, which only fetches the byte ranges they need.

- [x] **Step 2: Check** `npx tsc --noEmit` → clean · `npx vitest run` → all pass (`test/media-url.test.ts` covers `getMediaUrl`, which is unchanged).

- [ ] **Step 3: Manual check in the app** (`npm run tauri dev`):
  - Import a large video (≥ 500 MB): its bin thumbnail appears within about a second.
  - Add it, a video with **no** sound track (Review Focus 3) and an MKV or WebM **with** sound (Review Focus 4) to the timeline: only the first and third get *Show audio track*.
  - Report each as pass / fail / not run in the status file (Task 5). Don't tick what you couldn't run.

---

### Task 4: A sound with no drawable waveform still shows, and says why

**Files:**
- Modify: `src/App.tsx` — the waveform-loading effect (~line 1111)
- Modify: `src/components/Timeline.tsx` — the audio-block waveform (~1305), the tucked strip (~1318), the block `title` (~1274)
- Modify: `src/App.css` — after `.tl-wave-tucked`

**Interfaces:**
- Consumes: Task 2's `waveformError`.
- `waveforms[src] === ""` now means "this sound exists but its waveform couldn't be drawn".

- [x] **Step 1: Implement.**
  - The effect stores `png ?? ""` for every audio source it loads (today a `null` stores nothing).
  - Where an audio block or a tucked strip finds `""`, render the same element with an extra `tl-wave-none` class and no background image.
  - `.tl-wave-none` is a flat translucent lane with a centre line: clearly sound, clearly not a waveform.
  - Append to that block's `title` (an audio block, or a video block whose tucked sound has `""`): `\nSound — waveform unavailable on this PC: ${waveformError(src) ?? "unknown reason"}`. Keep the strip's `pointer-events: none`; the tooltip lives on the block.

- [x] **Step 2: Check** `npx tsc --noEmit` → clean · `npx vitest run` → all pass.

- [ ] **Step 3: Manual check:** a working video's waveform is unchanged. If you can force a decode failure (e.g. an audio file renamed to `.mp3` that isn't audio), its block shows the plain lane and the tooltip gives the reason. Report the result.

---

### Task 5: Final verification and report

- [x] **Step 1:** `npx tsc --noEmit`, `npx vitest run`, `cargo test --manifest-path src-tauri/Cargo.toml --lib` → clean; 318 passed; 268 passed, 7 ignored.
- [x] **Step 2:** `git status` lists only files named in this plan (plus the pre-existing untracked items).
- [x] **Step 3:** Write `docs/STATUS-sound-check-and-bin-thumbnails.md` in the layout of `docs/STATUS-video-sound-one-row.md`:
  - per task: the changes, the red and green test output, and each manual check marked pass / fail / not run;
  - any deviation, and why.

  Review Focus 1 (release build) and 2 (the low-spec PC) are for the reviewer and the user: list them as **not run**.
