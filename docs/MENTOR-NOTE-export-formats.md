# Mentor note: export formats, smaller files, subtitles (from a read of HandBrake)

Date: 2026-11-13. Goal (from the user): export to more formats, MKV included; burn in subtitles; get much
smaller files, the way HandBrake does.

> **Build #84 (same day): Fast-mode speed fixes.**
> - Constant-quality H.264 is now encoded once on the GPU (WebCodecs quantizer mode, QP per level
>   `GPU_H264_QP` in `exportSettings.ts`), with no ffmpeg re-encode. Rust is told via `uploadFinal`.
> - Re-encoded codecs get a QP 18 intermediate instead of a fixed 25 Mbps one.
> - The editor is hidden and the spinner stopped while frames render. On-screen animation was capping exports
>   at the display's 60 Hz (~56 fps → ~100 fps); see `renderingFrames` in App.tsx.
>
> **Status (2026-11-13): implemented, all phases, uncommitted; installed as build #82.** See
> `ExportSettings` / `video_encode_args` / `export_video_from` in `src-tauri/src/lib.rs`,
> `src/lib/exportSettings.ts` and `src/components/ExportDialog.tsx`. The level tables were calibrated by VMAF
> per codec (comment on `quality_value`). Deviations from this note:
> - Command args are hand-mirrored in TS, not generated with ts-rs.
> - The speed key stays separate.
> - Merge exports at 24 Mbps in bitrate mode.
> - VP9 is offered in WebM only.
>
> Deferred review minors:
> - The passlog prefix match (`starts_with`) can catch another PID's files; match on `"{prefix}-"`.
> - The sidecar .srt is written before encoding, so it's left behind on cancel.
> - `ffmpeg_status` is a sync command; make it `async`.
> - The GPU H.264 → VP9 fallback keeps the target bitrate, so it encodes twice at the target.
> - `bitrateForSize` has no 400 Mbps cap, so a huge MB value overflows u32 in Rust.
> - Exact-mode merges now run 2-pass.
> - The "2-pass" hint is wrong for WebM/VP9 copies, and the RF label is wrong for NVENC.
> - The realtime (MediaRecorder) fallback ignores track-only mode.

## TL;DR

1. **MKV is not why HandBrake's files are small.** The size comes from **rate control**: HandBrake uses constant
   quality (x264/x265 CRF, which it calls "RF"). We force strict CBR. Remuxing one bitstream into MKV changed the size
   by 0.1% (2,587,769 B as MP4 → 2,585,187 B as MKV).
2. **We don't need HandBrake's code.** libhb is a wrapper around the same libraries the Gyan ffmpeg we already install
   ships with (x264, x265, SVT-AV1, NVENC, libass, and the SRT/ASS/mov_text muxers). Every change below is ffmpeg
   arguments plus a small amount of UI. Don't link libhb: it's GPL-2 and would bring nothing we lack.
3. **Subtitles are already burned in.** The "Subtitles" group renders as text layers. That's our version of
   HandBrake's libass burn-in, and it's better for us because it keeps our fonts and our Arabic shaping. What we lack
   is a **separate (soft) subtitle track**, which is MKV's other selling point.
4. **The user must be able to control all of this in the Export dialog**: container, codec, quality or target
   size, encoder speed, subtitle handling and audio bitrate. See "Export dialog UI" below. Each phase ships the
   controls for its own feature, so no backend option lands without a way to reach it.

## Measured on this PC (ffmpeg 8.1.1 Gyan full)

Source: `SE-test-assets/synthetic/synthetic-1.mp4`. It's 1080×1920 at 30 fps, 15 s long, and 13.9 Mbps, so it's
effectively our own level-2 export. VMAF is measured against that source; ≥95 is visually transparent.

| Setting | Size | VMAF | Encode time |
|---|---|---|---|
| **Ours now:** x264 CBR 14 Mbps medium (`lib.rs` export path) | 25.10 MB | 99.2 | 2.2 s |
| **Ours now (fast):** h264_nvenc CBR 14 Mbps | 25.82 MB | 99.2 | — |
| x264 CRF 18 medium | 6.06 MB | 98.2 | — |
| x264 CRF 22 fast (HandBrake "Fast 1080p30") | 3.56 MB | 96.6 | 1.5 s |
| x264 CRF 22 medium (HandBrake "H.264 MKV 1080p30") | 3.38 MB | 97.0 | 1.7 s |
| x265 CRF 22 slow 10-bit (HandBrake "H.265 MKV 1080p30") | 2.47 MB | 98.8 | 10.6 s |
| hevc_nvenc VBR CQ 26 p5 | 3.43 MB | 98.7 | 1.1 s |
| SVT-AV1 CRF 35 preset 6 10-bit (HandBrake "AV1 MKV" family) | 1.19 MB | 98.0 | 3.4 s |

That's 4–20× smaller at near-identical quality. Caveats: this is one clip, already lossy, of motion-graphics content.
Busy footage and particles will compress less. Rerun on 2–3 real comps before you settle on the numbers.

**Verification gotcha:** when you score an **MKV** output with ffmpeg's `ssim`/`libvmaf` filters, the millisecond
timestamps misalign frames and VMAF drops to about 77 for every setting. That's an artifact: the MKV decodes to
frame-for-frame identical output (framemd5 matches the MP4). Score MP4 outputs, or use `setpts=N/(30*TB)` and
check with framemd5.

## What HandBrake does (file references are to the HandBrake repo)

- `preset/preset_builtin.json`: every General and Matroska preset is `VideoQualityType: 2` (constant quality).
  RF 22 is the 1080p default, 20 is HQ, 18 is Super HQ. HEVC and AV1 presets use 10-bit (`x265_10bit`,
  `svt_av1_10bit`). Audio is AAC or Opus at 160 kbps.
- The only presets that target a size ("Social 25 MB…") use `VideoQualityType: 1` + `VideoAvgBitrate` +
  `VideoMultiPass: true` + `VideoTurboMultiPass: true`. That's **2-pass ABR, never CBR**.
- `libhb/encx264.c:546-577`: when a quality is set, `X264_RC_CRF` with `f_rf_constant = vquality`. Otherwise it uses
  `X264_RC_ABR` with a stats file for 2 passes.
- `libhb/rendersub.c` `render_ssa_subs()` (~626): burn-in is `ass_render_frame` (libass) blended onto the frame.
  ffmpeg exposes this as the `subtitles=`/`ass=` filter. We don't need it (see TL;DR 3).
- `libhb/muxavformat.c:1065-1117`, soft subtitle tracks: in MP4, text subs become `AV_CODEC_ID_MOV_TEXT` with tag
  `tx3g`. In MKV they become `AV_CODEC_ID_SUBRIP` (SRT) or `AV_CODEC_ID_ASS`. ASS also attaches the fonts it needs.
  The chosen track gets `AV_DISPOSITION_DEFAULT`. MP4 is muxed with `movflags faststart` (`:326`).

## Why ours is big (our code)

- `src-tauri/src/lib.rs:5839-5848` and `:5896-5907`: quality **and** bitrate mode both run x264 with
  `minrate=maxrate=b:v` + `nal-hrd=cbr`, so that file size equals the dialog's estimate. The comment calls VBR's
  undershoot a bug. That undershoot is exactly the saving HandBrake gets.
- `lib.rs:5882-5895`: fast mode is NVENC `-rc cbr`.
- `lib.rs:5807-5827`: fast + MP4 skips ffmpeg's encode entirely and keeps the WebCodecs H.264 file, which is also
  CBR (`deterministicExport.ts:82`, `constant` is tried first).
- `lib.rs:5876-5878`: WebM copies the VP9 intermediate, CBR at the target (`deterministicExport.ts:236-246`).
- `ExportDialog.tsx:87-90` says quality mode is "constant quality / variable size", but `:118-121` and the backend
  make it CBR. The original intent was CRF.

## Plan, in priority order

### Phase 1: quality mode = real constant quality (the big win, small diff)

- `export_video_from`, when `rate_mode == "quality"`:
  - x264: `-crf <n> -preset medium -pix_fmt yuv420p -movflags +faststart`. Remove minrate, maxrate, bufsize and
    `nal-hrd`.
  - fast: `h264_nvenc -preset p5 -rc vbr -cq <n> -b:v 0`. The merge path already does this at `lib.rs:6740`, so
    copy it. Keep the x264 fallback.
  - Level → CRF starting point, anchored on HandBrake's scale: 1→16, 2→18 (default), 3→20, 4→23, 5→26. Use the
    same numbers for NVENC CQ, then calibrate both on the test comps.
- Frontend, quality mode only:
  - Don't take the direct-MP4 path (`App.tsx:3194` `wantH264`). The WebCodecs file becomes an intermediate and
    ffmpeg does the final CRF/CQ encode. Cost measured above: about 1–2 s per 15 s at 1080×1920.
  - Encode the intermediate generously: at least level 1's 24 Mbps (`App.tsx:3012`). It's a temp file, so its size
    doesn't matter, and its quality caps the output's.
- Dialog: in quality mode a size estimate can't be exact, and HandBrake doesn't show one. Drop it there (or label
  it "varies with content"), and show the real file size when the export finishes. Bitrate mode keeps its estimate.
- WebM in quality mode: re-encode instead of copying. Use libvpx-vp9 `-crf 30 -b:v 0 -row-mt 1`, or AV1 from
  Phase 3. Measure libvpx speed first, because it's slow.

### Phase 2: bitrate mode = 2-pass ABR (same size, better quality)

HandBrake's size-targeted presets do this. Run x264 `-b:v <t> -pass 1 -f null NUL`, then `-pass 2`, with no
minrate/maxrate/nal-hrd. The first pass can use `-preset faster` (HandBrake's "turbo"). Check that the final size
still lands within a few percent of the estimate; that was the reason CBR was chosen. Use a unique `-passlogfile`
in temp and delete it afterwards.

### Phase 3: more formats (container × codec)

| Container | Video | Audio | Soft subs |
|---|---|---|---|
| MP4 (default) | H.264 / H.265 (`-tag:v hvc1` so Apple plays it) / AV1 | AAC | `mov_text` |
| MKV | H.264 / H.265 / AV1 | AAC or Opus | `srt` (later: `ass` + font attachment) |
| WebM | VP9 / AV1 | Opus | `webvtt` |

- HEVC: `libx265 -crf <n> -preset medium -pix_fmt yuv420p10le`. Slow was 10.6 s against 3.5 s for medium on the
  test clip; it adds a little quality for a lot of time. Fast mode uses `hevc_nvenc -rc vbr -cq <n>`.
- AV1: `libsvtav1 -crf <n> -preset 6 -pix_fmt yuv420p10le`. HandBrake's anchor is RF ~35 for the "x264 RF 22"
  tier. `av1_nvenc` only exists on RTX 40-series GPUs, so fall back to SVT.
- Use 10-bit for HEVC/AV1 like HandBrake does. It reduces banding in smooth gradients, which matters for
  lighting content.
- Probe the encoders: users can have a non-Gyan ffmpeg on PATH that lacks libx265/libsvtav1. Extend
  `ffmpeg_status` to report which of `libx264 libx265 libsvtav1 h264_nvenc hevc_nvenc av1_nvenc` appear in
  `ffmpeg -encoders`, and hide unavailable codecs in the dialog.
- Tell users in the dialog: **Instagram, TikTok and iOS Photos don't take MKV**. The size win comes from the codec
  and rate control, so it works in MP4 too. MKV is for archive, VLC playback and soft subtitles. H.264 MP4 stays the
  default because it plays everywhere. HEVC needs a codec pack on some Windows PCs, and AV1 won't hardware-decode
  on older phones.

### Phase 4: subtitles as a separate track (and a sidecar .srt)

- Export option: **Burned in** (today's behaviour, and the right default for social, because platforms ignore
  embedded tracks) / **Separate track** / **Both** / **Save .srt next to the video** (for YouTube uploads).
- Source the cues from the text children of the "Subtitles" group (`subtitles.rs:158` `place_cues`, group
  name at `:204`): `start_ms`, `end_ms`, content. Add `write_srt(cues)`, the inverse of `parse_srt`, with a
  round-trip test.
- Mux the track: add `-i subs.srt`, then `-map <n>:s -c:s srt|mov_text|webvtt -disposition:s:0 default
  -metadata:s:s:0 language=<iso639-2>`. This mirrors `muxavformat.c:1065-1117`.
- For "Separate track", leave the group out of the render so the text isn't burned in as well. Reuse the
  `onlyIds`-style layer filtering in `onExport`.
- Known limit: players draw soft subs in their own font, so our styling and the Arabic font are lost. That's
  another reason burn-in stays the default. Later: ASS output with styles, plus MKV font attachments (HandBrake's
  `need_fonts`).
- Groups are only identified by the name "Subtitles". If users rename the group, the export won't find it. Add
  a marker field when that becomes a problem.

## Export dialog UI

Today's dialog (`src/components/ExportDialog.tsx`) has: Format (MP4·H.264 / WebM·VP9), Render speed, Frame rate,
Rate control (Quality level / Bitrate), the size and time estimate, and a burned-in FPS checkbox. Keep that layout
and the existing `seg-btn`/`insp-field` styling. Add rows; don't redesign.

```
Export video
──────────────────────────────────────────────────────────
Container     [ MP4 ] [ MKV ] [ WebM ]
Video codec   [ H.264 ] [ H.265 ] [ AV1 ]      only codecs valid for the container
              Plays everywhere. Largest of the three.           (hint per codec)
Render speed  [ Fast ] [ Exact (slow) ]                         (unchanged)
Frame rate    [ 30 fps ▾ ]                                      (unchanged)

Quality       [ Constant quality ] [ Target size ]
  quality:    ●────●────○────○────○   L2 · High quality (RF 18)
  size:       [ 14 Mbps ▾ ]  or  [ 25 ] MB    (two-way: editing one updates the other)

Subtitles     [ Burned in ] [ Separate track ] [ Both ]   only if the comp has a Subtitles group
              ☐ Also save .srt next to the video

▸ Advanced                                                      (native <details>, closed by default)
    Encoder speed  [ Faster ] [ Balanced ] [ Smaller file (slower) ]
    ☑ 10-bit colour (H.265 / AV1)
    Audio          [ 160 kbps ▾ ]  AAC · Opus in WebM           only if the comp has audio

1080×1920 · Size ~3.4 MB (from your last H.264 L2 export) · Render ~45 s · 454 frames
☐ Show FPS on the video                                         (unchanged)
```

### Controls → backend, and which phase ships them

| Control | Values → ffmpeg | Phase |
|---|---|---|
| Quality: Constant quality | Level 1–5 → CRF/CQ for the chosen codec (Phase 1 table); show the RF number in muted text | 1 |
| Quality: Target size | Mbps preset or custom Mbps, **or** MB box: `bitrate = MB·8·2²⁰ / duration_s − audio_bps`. 2-pass ABR | 1 (box), 2 (2-pass) |
| Size estimate | Target size: exact, as today. Constant quality: after each export, store bits per pixel-frame under the key `codec:level` (same localStorage calibration pattern as `MS_PER_FRAME_KEY`) and estimate from that. With no history, show "varies with content". Always show the real size when the export finishes. | 1 |
| Container | `mp4` / `mkv` / `webm`. Drives the save-dialog extension and filter (`App.tsx:3024-3029`) | 3 |
| Video codec | MP4: H.264, H.265, AV1. MKV: H.264, H.265, AV1. WebM: VP9, AV1. When the container changes and the codec isn't allowed, select the first allowed one. Disable codecs that ffmpeg lacks, with a tooltip that points at the existing "Install ffmpeg (winget)" button. | 3 |
| Encoder speed | Faster / Balanced (default) / Smaller file. x264 and x265: `veryfast`/`medium`/`slow`. SVT-AV1: `8`/`6`/`4`. NVENC: `p4`/`p5`/`p7` | 3 |
| 10-bit | `yuv420p10le` for H.265/AV1, on by default (HandBrake default). Hidden for H.264/VP9 | 3 |
| Audio bitrate | 128 / 160 / 192 (current) / 320 kbps. AAC in MP4/MKV, Opus in WebM | 3 |
| Subtitles | Burned in (default) / Separate track / Both, plus the sidecar `.srt` checkbox. Hide the whole row when the comp has no Subtitles group | 4 |

Codec hints (one muted line under the picker):
- H.264: "Plays everywhere. Best for Instagram, TikTok, WhatsApp."
- H.265: "About 30% smaller. Some Windows PCs need the HEVC extension."
- AV1: "Smallest. Slower to encode; older phones can't play it smoothly."
- MKV container: "For archive and VLC. Social apps won't accept MKV."

### Plumbing

- **One settings object instead of positional args.** `onExport(format, level, fps, burnFps, bitrate, rateMode)`
  (`ExportDialog.tsx:73-80`, `App.tsx:2990`) and `exportVideo(...)` (`api.ts:880`) are about to gain six more
  parameters. Replace them with one `ExportSettings { container, codec, rateMode, level, bitrate, encoderSpeed,
  tenBit, audioKbps, subtitles: { mode, sidecar }, fps, burnFps }`. On the Rust side, use a serde struct with
  `#[serde(default)]` on every new field, defaulting to MP4 / H.264 / Balanced / 192 kbps / burned in, so that
  the existing callers keep working unchanged. Those callers are the agent tool (`agent/tools.ts:559`),
  `synthetic.ts:243` and `rebuildFromAnalysis.ts:634`. Generate the TS type with ts-rs like the other shared types.
- **Remember the last settings.** Store the whole object under one localStorage key, with the same try/catch
  pattern as `getExportSpeed`/`setExportSpeed` (`deterministicExport.ts:37-50`). This replaces the separate
  speed key.
- **Encoder availability.** Make `ffmpeg_status` return `{ path, encoders: string[] }`, filtered from
  `ffmpeg -encoders` to the names in Phase 3. The only caller is `ExportDialog.tsx` (lines 103 and 147), so the
  return-type change is contained.
- **Dialog props.** Add `hasAudio` and `hasSubtitles` so the dialog can hide those rows. App already builds
  `audioTracks` and knows the layer tree.
- **Agent tool.** Add `container`, `codec` and `target_mb` to the `export_video` schema (`agent/tools.ts:539`) and
  update its description, so the in-app agent can use the same options.
- **Direct-MP4 decision.** `App.tsx:3194` `wantH264` stays true only for MP4 + H.264 + Fast + Target size. Every
  other combination renders the intermediate and lets ffmpeg do the final encode.

### UI acceptance checks

- Switching Container filters Codec, and an invalid combination can't be selected.
- With a non-Gyan ffmpeg that lacks libx265/libsvtav1, H.265 and AV1 are disabled with a tooltip, and H.264 still
  exports.
- In Target size, typing 25 MB for a 30 s comp yields a file of 25 MB or less (within about 3%).
- In Constant quality, the second export of the same comp shows an estimate within about 2× of the first export's
  real size, and the done message shows the real size.
- The Subtitles row only appears when a Subtitles group exists. "Separate track" produces a file whose subtitles
  toggle in VLC and aren't in the pixels.
- Reopening the dialog restores the last settings.

## Not doing

- Embedding libhb or shelling out to HandBrakeCLI: GPL, and it duplicates what ffmpeg already gives us.
- libass burn-in: our own text renderer already burns subtitles in, with better font control.
- Audio codec changes: 192 kbps × 15 s is about 0.35 MB, which isn't a size driver. The UI only exposes the
  bitrate.
- Named presets ("Instagram", "Archive"…): remembering the last settings covers repeat exports. Add presets if
  users keep switching between two setups.
- A raw RF/CRF number field: the 5 levels map to RF per codec. Add the field under Advanced if someone asks for
  finer control.
